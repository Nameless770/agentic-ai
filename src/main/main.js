'use strict';

// Claude Buddy - main process.
// Owns the floating buddy window, the chat window, the tray icon, the global
// shortcut, screen capture, and the conversation with a local Ollama model.

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  globalShortcut,
  nativeTheme,
  shell,
  clipboard,
  session,
  nativeImage,
} = require('electron');
const path = require('path');
const os = require('os');
const sprite = require('../shared/sprite');
const settings = require('./settings');
const { captureDisplay } = require('./capture');
const {
  RECOMMENDED,
  SUGGESTED,
  Ollama,
  OllamaChat,
  normalizeUrl,
  isLocalUrl,
  normalizeModelName,
  sameModel,
  trimShow,
  describeModel,
  contextFor,
  remoteDownloadSize,
  findOllama,
  launchOllama,
  describeError,
  describePullError,
} = require('./ollama');
const { InputHelper } = require('./input');
const documents = require('./documents');
const tools = require('./tools');

const PRELOAD = path.join(__dirname, '..', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

// Tried in order until one isn't already taken by another app.
// (Ctrl+Alt+Space is also the Claude desktop app's Quick Entry shortcut.)
const HOTKEY_CANDIDATES = ['Ctrl+Alt+Space', 'Alt+Shift+Space', 'Ctrl+Alt+B', 'Ctrl+Shift+Alt+Space'];

const MASCOT = { width: 100, height: 100 };
const CHAT_DEFAULT = { width: 420, height: 640 };
const CHAT_MIN = { width: 340, height: 440 };

// Windows 10 2004 (build 19041) added WDA_EXCLUDEFROMCAPTURE, which keeps our
// windows out of screenshots. On older systems we hide them for a moment.
const CAN_EXCLUDE_FROM_CAPTURE =
  process.platform === 'win32' && Number(os.release().split('.')[2] || 0) >= 19041;

let mascotWin = null;
let chatWin = null;
let tray = null;
let chat = null;
let ollama = null;
let quitting = false;
let sending = false;
let hotkeyOk = false;
let mascotState = 'idle';
let unread = false;
let errorTimer = null;
let drag = null;
const shots = new Map(); // turnId -> full-size JPEG, for the image viewer

// What we know about Ollama.
let ollamaInfo = { state: 'unknown', version: '' }; // state: unknown | ok | down
let models = []; // installed models, from the last successful check
const showCache = new Map(); // model digest -> trimmed /api/show
let refreshing = null; // promise while checking Ollama
let starting = null; // promise while starting Ollama
let pull = null; // { name, status, completed, total, auto, ac } while downloading a model
let pullTimer = null;
let lastPullError = null; // { name, message } of the last download that failed
// With no model installed at all, the recommended one is downloaded on its
// own when the chat opens: once per run, and never again after the user
// cancels it.
let autoDownloadDone = false;
let lastWarm = { name: '', at: 0 };
let installedCache = { at: 0, value: false };

// Actions on the PC.
let input = null; // mouse/keyboard helper, started on first use
let lastShot = null; // { display, width, height, jpeg, image } of the newest screenshot (clicks aim at it)
let task = null; // { turnId, approveAll, began, cursor } while the model is acting
let actionSeq = 0;
const approvals = new Map(); // action id -> decide(decision)
const createdFiles = new Set(); // documents Buddy made; only these can be opened from the chat

// ---------------------------------------------------------------- startup

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showChat());
  app.whenReady().then(start);
}

function start() {
  app.setAppUserModelId('com.claudebuddy.desktop');
  Menu.setApplicationMenu(null);
  settings.load();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  ollama = new Ollama(() => settings.get('ollamaUrl'));
  chat = new OllamaChat({
    ollama,
    getModel: activeModel,
    getSettings: () => ({ think: !!settings.get('think') }),
    onEvent: onChatEvent,
    host: { tools: toolsFor, runTool, screenshot: screenshotAfterAction, taskEnded: endTask },
  });

  createMascot();
  createChat();
  setupHotkey();
  createTray();
  watchCursor();
  refreshOllama();

  screen.on('display-removed', keepMascotOnScreen);
  screen.on('display-metrics-changed', keepMascotOnScreen);
  nativeTheme.on('updated', () => {
    if (chatWin && !chatWin.isDestroyed()) chatWin.setBackgroundColor(themeBg());
  });
}

app.on('window-all-closed', () => {
  // Keep running in the tray.
});

app.on('before-quit', () => {
  quitting = true;
  if (chat) chat.stop();
  if (pull) pull.ac.abort(); // Ollama resumes the download next time
  if (input) input.dispose();
  globalShortcut.unregisterAll();
  settings.writeNow();
});

// ---------------------------------------------------------------- helpers

function sendTo(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function fromWin(e, win) {
  return !!win && !win.isDestroyed() && e.sender === win.webContents;
}

function themeBg() {
  return nativeTheme.shouldUseDarkColors ? '#262624' : '#FAF9F5';
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
      shell.openExternal(u.toString());
    }
  } catch {
    // ignore malformed links
  }
}

function harden(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    e.preventDefault();
    openExternalSafe(url);
  });
}

function clampToWorkArea(b) {
  const wa = screen.getDisplayMatching(b).workArea;
  return {
    x: Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width)),
    y: Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tray / window icon drawn in memory from the pixel art, with a sharp
// version for every display scale (no icon file needed at runtime).
function buddyIcon(baseSize) {
  const img = nativeImage.createEmpty();
  for (const scaleFactor of [1, 1.25, 1.5, 2, 2.5, 3]) {
    const size = Math.round(baseSize * scaleFactor);
    const rgba = sprite.iconPixels(size);
    const bgra = Buffer.alloc(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      bgra[i] = rgba[i + 2];
      bgra[i + 1] = rgba[i + 1];
      bgra[i + 2] = rgba[i];
      bgra[i + 3] = rgba[i + 3];
    }
    img.addRepresentation({ scaleFactor, width: size, height: size, buffer: bgra });
  }
  return img;
}

// ---------------------------------------------------------------- mascot

function defaultMascotPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - MASCOT.width - 24, y: wa.y + wa.height - MASCOT.height - 24 };
}

function createMascot() {
  const saved = settings.get('mascotPos');
  const pos = saved ? clampToWorkArea({ ...saved, ...MASCOT }) : defaultMascotPos();

  mascotWin = new BrowserWindow({
    ...MASCOT,
    ...pos,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    title: 'Claude Buddy',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mascotWin.setAlwaysOnTop(true, 'screen-saver');
  mascotWin.setContentProtection(true);
  mascotWin.setIgnoreMouseEvents(true, { forward: true });
  harden(mascotWin.webContents);
  mascotWin.loadFile(path.join(RENDERER, 'mascot.html'));
  mascotWin.once('ready-to-show', () => {
    if (settings.get('showMascot')) mascotWin.showInactive();
    updateMascot();
  });
}

function applyMascotVisibility() {
  if (!mascotWin || mascotWin.isDestroyed()) return;
  if (settings.get('showMascot')) mascotWin.showInactive();
  else mascotWin.hide();
}

function keepMascotOnScreen() {
  if (!mascotWin || mascotWin.isDestroyed()) return;
  const pos = clampToWorkArea(mascotWin.getBounds());
  mascotWin.setPosition(pos.x, pos.y);
}

function setMascotState(state) {
  if (state === mascotState) return;
  mascotState = state;
  updateMascot();
}

function updateMascot() {
  sendTo(mascotWin, 'mascot:state', { state: mascotState, unread });
}

function flashMascotError() {
  setMascotState('error');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    if (mascotState === 'error') setMascotState('idle');
  }, 4000);
}

// The eyes follow the mouse pointer.
function watchCursor() {
  let last = null;
  setInterval(() => {
    if (!mascotWin || mascotWin.isDestroyed() || !mascotWin.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    if (last && last.x === p.x && last.y === p.y) return;
    last = p;
    const b = mascotWin.getBounds();
    sendTo(mascotWin, 'mascot:cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 50);
}

// Dragging is done here (not with -webkit-app-region) so a plain click can
// still be told apart from a drag.
ipcMain.on('mascot:pointer-down', (e) => {
  if (!fromWin(e, mascotWin) || drag) return;
  const startPt = screen.getCursorScreenPoint();
  const [wx, wy] = mascotWin.getPosition();
  drag = { start: startPt, off: { x: startPt.x - wx, y: startPt.y - wy }, moved: false };
  drag.timer = setInterval(() => {
    if (!drag || mascotWin.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) {
      drag.moved = true;
      sendTo(mascotWin, 'mascot:drag', true);
    }
    if (drag.moved) mascotWin.setPosition(p.x - drag.off.x, p.y - drag.off.y);
  }, 16);
});

ipcMain.on('mascot:pointer-up', (e) => {
  if (!fromWin(e, mascotWin) || !drag) return;
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  if (moved) {
    sendTo(mascotWin, 'mascot:drag', false);
    const pos = clampToWorkArea(mascotWin.getBounds());
    mascotWin.setPosition(pos.x, pos.y);
    settings.set({ mascotPos: pos });
    if (chatWin.isVisible()) placeChat();
  } else {
    toggleChat();
  }
});

// Clicks pass through the transparent corners of the mascot window.
ipcMain.on('mascot:hit', (e, inside) => {
  if (!fromWin(e, mascotWin) || drag) return;
  mascotWin.setIgnoreMouseEvents(!inside, { forward: true });
});

ipcMain.on('mascot:menu', (e) => {
  if (!fromWin(e, mascotWin)) return;
  buildMenu().popup({ window: mascotWin });
});

// ---------------------------------------------------------------- chat window

function createChat() {
  const size = settings.get('chatSize') || CHAT_DEFAULT;
  chatWin = new BrowserWindow({
    width: Math.max(size.width, CHAT_MIN.width),
    height: Math.max(size.height, CHAT_MIN.height),
    minWidth: CHAT_MIN.width,
    minHeight: CHAT_MIN.height,
    show: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: themeBg(),
    title: 'Claude Buddy',
    icon: buddyIcon(32),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  chatWin.setAlwaysOnTop(true, 'floating');
  chatWin.setContentProtection(true);
  harden(chatWin.webContents);
  chatWin.loadFile(path.join(RENDERER, 'chat.html'));

  chatWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideChat();
    }
  });

  // Both windows are "always on top"; Windows puts the most recently
  // activated one above the other, so lift the buddy back over the chat.
  chatWin.on('focus', keepMascotOnTop);

  let resizeTimer = null;
  chatWin.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (chatWin.isDestroyed()) return;
      const [width, height] = chatWin.getSize();
      settings.set({ chatSize: { width, height } });
    }, 400);
  });
}

// Open the chat next to the mascot, on whichever side has room.
function placeChat() {
  const m = mascotWin && !mascotWin.isDestroyed() && mascotWin.isVisible() ? mascotWin.getBounds() : null;
  const display = m ? screen.getDisplayMatching(m) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  let [w, h] = chatWin.getSize();
  w = Math.min(w, wa.width - 16);
  h = Math.min(h, wa.height - 16);

  let x;
  let y;
  if (m) {
    const gap = 6;
    const onRight = m.x + m.width / 2 > wa.x + wa.width / 2;
    const onBottom = m.y + m.height / 2 > wa.y + wa.height / 2;
    x = onRight ? m.x - gap - w : m.x + m.width + gap;
    y = onBottom ? m.y + m.height - h : m.y;
  } else {
    x = wa.x + wa.width - w - 24;
    y = wa.y + wa.height - h - 24;
  }
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - w - 8);
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - h - 8);
  chatWin.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
}

function showChat(opts = {}) {
  if (!chatWin || chatWin.isDestroyed()) return;
  if (!chatWin.isVisible()) placeChat();
  chatWin.show();
  chatWin.focus();
  keepMascotOnTop();
  sendTo(chatWin, 'chat:shown', { openSettings: !!opts.openSettings });
  if (unread) {
    unread = false;
    updateMascot();
  }
  // Fresh model list, and get the model into memory while the user types.
  refreshOllama().then(() => {
    maybeAutoDownload();
    warmUp();
  });
}

function keepMascotOnTop() {
  if (mascotWin && !mascotWin.isDestroyed() && mascotWin.isVisible()) mascotWin.moveTop();
}

function hideChat() {
  if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) chatWin.hide();
}

function toggleChat() {
  if (chatWin.isVisible()) hideChat();
  else showChat();
}

function onHotkey() {
  if (chatWin.isVisible() && chatWin.isFocused()) hideChat();
  else showChat();
}

function newChat() {
  chat.reset();
  shots.clear();
  unread = false;
  mascotState = 'idle';
  updateMascot();
  sendTo(chatWin, 'chat:event', { type: 'reset' });
}

// Streaming updates from the model -> chat window + mascot mood.
function onChatEvent(e) {
  sendTo(chatWin, 'chat:event', e);
  switch (e.type) {
    case 'status':
    case 'thinking-start':
    case 'thinking':
      setMascotState('thinking');
      break;
    case 'text-start':
    case 'text':
    case 'action':
      setMascotState('talking');
      break;
    case 'done':
      if (!chatWin.isVisible()) unread = true;
      mascotState = 'idle';
      updateMascot();
      break;
    case 'stopped':
      setMascotState('idle');
      break;
    case 'error':
      flashMascotError();
      break;
  }
}

/** Screenshot of the display the chat is on. Also remembered as the one clicks aim at. */
async function captureForChat() {
  const ref = chatWin.isVisible() ? chatWin.getBounds() : mascotWin.getBounds();
  const display = screen.getDisplayMatching(ref);
  const detail = settings.get('imageDetail');
  let shot;
  if (CAN_EXCLUDE_FROM_CAPTURE) {
    shot = await captureDisplay(display, detail);
  } else {
    const visible = [chatWin, mascotWin].filter((w) => w && !w.isDestroyed() && w.isVisible());
    visible.forEach((w) => w.setOpacity(0));
    await sleep(180);
    try {
      shot = await captureDisplay(display, detail);
    } finally {
      visible.forEach((w) => w.setOpacity(1));
    }
  }
  lastShot = { display, width: shot.width, height: shot.height, jpeg: shot.jpeg, image: null };
  return shot;
}

// ---------------------------------------------------------------- actions on the PC

function controlMode() {
  const mode = settings.get('control');
  return mode === 'off' || mode === 'auto' ? mode : 'ask';
}

/** The tools to offer the model for one request. */
function toolsFor(model, { screen: hasScreen }) {
  if (!model || !model.tools) return [];
  const list = [];
  if (settings.get('documents') !== false) list.push(...tools.DOCUMENT_TOOLS);
  // Acting on the screen needs a model that sees it, and a screenshot to aim at.
  if (model.vision && hasScreen && controlMode() !== 'off' && process.platform === 'win32') list.push(...tools.CONTROL_TOOLS);
  return list;
}

function helper() {
  if (!input) input = new InputHelper();
  return input;
}

function abortError() {
  return Object.assign(new Error('Stopped'), { name: 'AbortError' });
}

function sleepOrAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A point on the newest screenshot (0-1000 grid) -> physical screen pixels. */
function toScreen(nx, ny) {
  if (!lastShot) throw new Error('There is no screenshot to aim at.');
  const b = lastShot.display.bounds;
  const dip = {
    x: Math.round(b.x + Math.min(b.width - 1, (nx / 1000) * b.width)),
    y: Math.round(b.y + Math.min(b.height - 1, (ny / 1000) * b.height)),
  };
  return process.platform === 'win32' ? screen.dipToScreenPoint(dip) : dip;
}

/** A close-up of the newest screenshot around a point, with where the marker goes (for approval cards). */
function previewAt(nx, ny) {
  if (!lastShot) return null;
  try {
    if (!lastShot.image) lastShot.image = nativeImage.createFromBuffer(lastShot.jpeg);
    const { width: W, height: H } = lastShot.image.getSize();
    const px = (nx / 1000) * W;
    const py = (ny / 1000) * H;
    const cw = Math.min(W, Math.round(W * 0.3));
    const ch = Math.min(H, Math.round(cw * 0.5));
    const cx = Math.round(Math.min(Math.max(px - cw / 2, 0), W - cw));
    const cy = Math.round(Math.min(Math.max(py - ch / 2, 0), H - ch));
    const crop = lastShot.image.crop({ x: cx, y: cy, width: cw, height: ch }).resize({ width: 400, quality: 'good' });
    return { src: `data:image/jpeg;base64,${crop.toJPEG(82).toString('base64')}`, mx: ((px - cx) / cw) * 100, my: ((py - cy) / ch) * 100 };
  } catch (err) {
    console.warn('[actions] preview failed:', err.message);
    return null;
  }
}

/** Our windows let clicks through while the model clicks under them. */
async function withClickThrough(fn) {
  const wins = [chatWin, mascotWin].filter((w) => w && !w.isDestroyed() && w.isVisible());
  wins.forEach((w) => w.setIgnoreMouseEvents(true));
  await sleep(40);
  try {
    return await fn();
  } finally {
    if (chatWin && !chatWin.isDestroyed()) chatWin.setIgnoreMouseEvents(false);
    if (mascotWin && !mascotWin.isDestroyed()) mascotWin.setIgnoreMouseEvents(true, { forward: true });
  }
}

/**
 * First action of a task: the chat stops taking focus (so typing goes to the
 * user's app, and Allow clicks don't steal it), and if it has focus right
 * now, it hands focus back to the window underneath.
 */
async function beginTask() {
  if (!task || task.began) return;
  task.began = true;
  if (!chatWin || chatWin.isDestroyed() || !chatWin.isVisible()) return;
  chatWin.setFocusable(false);
  if (chatWin.isFocused()) {
    chatWin.hide();
    await sleep(200);
    chatWin.showInactive();
    keepMascotOnTop();
  }
}

function endTask(turnId) {
  for (const decide of approvals.values()) decide('deny');
  approvals.clear();
  if (task && task.turnId === turnId) {
    if (task.began && chatWin && !chatWin.isDestroyed()) chatWin.setFocusable(true);
    task = null;
  }
}

function emitAction(turnId, action) {
  onChatEvent({ turnId, type: 'action', ...action });
}

function updateAction(turnId, id, state, extra = {}) {
  sendTo(chatWin, 'chat:event', { turnId, type: 'action-update', id, state, ...extra });
}

function askApproval(id, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      approvals.delete(id);
      reject(abortError());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    approvals.set(id, (decision) => {
      signal.removeEventListener('abort', onAbort);
      approvals.delete(id);
      resolve(decision);
    });
  });
}

/** Carry out one tool call from the model. Resolves to { content (for the model), screen (take a new screenshot) }. */
async function runTool(call, { turnId, signal }) {
  const parsed = tools.parseCall(call);
  if (!parsed.ok) {
    console.warn('[actions] unusable tool call:', JSON.stringify(call && call.function), '->', parsed.error);
    return { content: `Error: ${parsed.error}`, invalid: true };
  }
  const a = parsed.action;
  if (!task || task.turnId !== turnId) task = { turnId, approveAll: false, began: false, cursor: null, lastSig: '', lastUnchanged: false, repeats: 0 };
  const onPc = a.kind !== 'document';
  const id = ++actionSeq;

  // The same action again after it changed nothing on the screen: warn, then stop.
  let repeatNote = '';
  if (onPc) {
    const sig = signature(a);
    task.repeats = sig === task.lastSig && task.lastUnchanged ? task.repeats + 1 : 0;
    task.lastSig = sig;
    if (task.repeats >= 2) {
      emitAction(turnId, { id, kind: a.kind, label: a.label, state: 'stopped', message: 'I kept repeating the same action without any change on the screen, so I stopped.' });
      chat.stop();
      throw abortError();
    }
    if (task.repeats === 1) repeatNote = ' You did exactly this last time and the screen did not change. If this does not work either, stop and tell the user what is wrong.';
  }
  const ask = onPc && a.kind !== 'wait' && controlMode() === 'ask' && !task.approveAll;
  const preview = a.x != null && a.y != null ? previewAt(a.x, a.y) : null;
  emitAction(turnId, { id, kind: a.kind, label: a.label, preview, state: ask ? 'ask' : 'running' });

  if (ask) {
    const decision = await askApproval(id, signal);
    if (decision === 'deny') {
      updateAction(turnId, id, 'denied');
      return { content: 'The user did not allow this action. Do not try it again; ask the user what they want instead.' };
    }
    if (decision === 'all') task.approveAll = true;
    task.cursor = null; // the user just used the mouse to answer; that's not a takeover
    updateAction(turnId, id, 'running');
  }
  if (signal.aborted) throw abortError();

  try {
    if (onPc && a.kind !== 'wait') {
      await beginTask();
      // Acting on its own: if the user grabbed the mouse since the last action, stop.
      if (task.cursor && (controlMode() === 'auto' || task.approveAll)) {
        const now = screen.getCursorScreenPoint();
        if (Math.hypot(now.x - task.cursor.x, now.y - task.cursor.y) > 30) {
          console.log('[actions] mouse moved from', JSON.stringify(task.cursor), 'to', JSON.stringify(now), '- stopping');
          updateAction(turnId, id, 'stopped', { message: 'You moved the mouse, so I stopped.' });
          chat.stop();
          throw abortError();
        }
      }
    }
    const result = await perform(a, signal);
    if (onPc) task.cursor = screen.getCursorScreenPoint();
    updateAction(turnId, id, 'done', result.ui || {});
    return { content: result.forModel + repeatNote, screen: onPc };
  } catch (err) {
    if (signal.aborted || err.name === 'AbortError') throw err;
    console.error('[actions] failed:', err);
    updateAction(turnId, id, 'failed', { message: err.message });
    return { content: `That did not work: ${err.message}`, screen: onPc };
  }
}

async function perform(a, signal) {
  switch (a.kind) {
    case 'document': {
      const doc = await documents.createDocument({ title: a.title, format: a.format, content: a.content });
      createdFiles.add(doc.path);
      return { forModel: `Saved "${doc.name}" in ${doc.folder}.`, ui: { file: { path: doc.path, name: doc.name, kind: doc.kind } } };
    }
    case 'click': {
      const p = toScreen(a.x, a.y);
      await withClickThrough(() => helper().click(p.x, p.y, { button: a.button, count: a.double ? 2 : 1 }));
      return { forModel: 'Done.' };
    }
    case 'scroll': {
      const p = toScreen(a.x, a.y);
      await withClickThrough(() => helper().scroll(p.x, p.y, a.direction === 'up' ? a.amount : -a.amount));
      return { forModel: 'Done.' };
    }
    case 'type':
      if (a.x != null && a.y != null) {
        // Click into the box first so the text lands there.
        const p = toScreen(a.x, a.y);
        await withClickThrough(() => helper().click(p.x, p.y));
        await sleepOrAbort(150, signal);
      }
      if (a.clear) {
        await helper().keys('ctrl+a');
        await sleepOrAbort(60, signal);
      }
      await helper().type(a.text);
      return { forModel: a.clear ? 'Replaced the text.' : 'Typed.' };
    case 'keys':
      await helper().keys(a.keys);
      return { forModel: `Pressed ${a.keys}.` };
    case 'open_app':
      await helper().keys('win');
      await sleepOrAbort(800, signal);
      await helper().type(a.name);
      await sleepOrAbort(1200, signal);
      await helper().keys('enter');
      await sleepOrAbort(2500, signal);
      return { forModel: `Searched the Start menu for "${a.name}" and pressed Enter.` };
    case 'open_url':
      await shell.openExternal(a.url);
      await sleepOrAbort(2500, signal);
      return { forModel: `Opened ${a.url} in the browser.` };
    case 'wait':
      await sleepOrAbort(a.seconds * 1000, signal);
      return { forModel: `Waited ${a.seconds} seconds.` };
    default:
      throw new Error(`Unknown action ${a.kind}.`);
  }
}

/** A short fingerprint of an action, to notice when the model repeats itself. */
function signature(a) {
  const r = (v) => Math.round(v / 15);
  switch (a.kind) {
    case 'click':
      return `click:${r(a.x)},${r(a.y)}:${a.button}:${a.double}`;
    case 'scroll':
      return `scroll:${r(a.x)},${r(a.y)}:${a.direction}`;
    case 'type':
      return `type:${a.text}:${a.x != null ? `${r(a.x)},${r(a.y)}` : ''}:${a.clear}`;
    case 'keys':
      return `keys:${a.keys.toLowerCase().replace(/\s+/g, '')}`;
    default:
      return `${a.kind}:${a.name || a.url || a.seconds || ''}`;
  }
}

/** Do two screenshots look the same (ignoring tiny things like a blinking caret)? */
function sameScreen(jpegA, jpegB) {
  if (!jpegA || !jpegB) return false;
  try {
    const small = (jpeg) => nativeImage.createFromBuffer(jpeg).resize({ width: 480, quality: 'good' });
    const a = small(jpegA);
    const b = small(jpegB);
    const sa = a.getSize();
    const sb = b.getSize();
    if (sa.width !== sb.width || sa.height !== sb.height) return false;
    const pa = a.toBitmap();
    const pb = b.toBitmap();
    let changed = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (Math.abs(pa[i] - pb[i]) > 30 || Math.abs(pa[i + 1] - pb[i + 1]) > 30 || Math.abs(pa[i + 2] - pb[i + 2]) > 30) {
        if (++changed >= 12) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** After an action: let the screen settle, then take a new screenshot for the model. */
async function screenshotAfterAction(turnId, signal) {
  await sleepOrAbort(900, signal);
  const before = lastShot && lastShot.jpeg;
  try {
    const shot = await captureForChat();
    shots.set(turnId, shot.jpeg); // the thumbnail opens the latest view
    shot.unchanged = sameScreen(before, shot.jpeg);
    if (task && task.turnId === turnId) task.lastUnchanged = shot.unchanged;
    return shot;
  } catch (err) {
    console.error('[capture] after action failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------- ollama

/** The model to chat with: the one picked in Settings, else the best installed one. */
function activeModel() {
  const chosen = settings.get('model');
  const picked = chosen && models.find((m) => sameModel(m.name, chosen));
  return picked || models.find((m) => m.vision && !m.cloud) || models.find((m) => m.vision) || models[0] || null;
}

function ollamaInstalled() {
  if (Date.now() - installedCache.at > 5000) {
    const found = findOllama();
    installedCache = { at: Date.now(), value: !!(found.app || found.cli) };
  }
  return installedCache.value;
}

function cantReachOllama() {
  const url = ollama.url;
  if (!isLocalUrl(url)) {
    return { message: `Can't reach Ollama at ${url}. Check the address in Settings.`, needsSettings: true };
  }
  if (!ollamaInstalled()) {
    return { message: 'Ollama isn\'t installed. Buddy needs it to run AI models on your PC: get it free from ollama.com.', needsInstall: true };
  }
  return { message: "Couldn't start Ollama. Open it from the Start menu, then try again.", needsOllama: true };
}

async function loadModels() {
  const tags = await ollama.tags();
  const list = [];
  for (const tag of tags) {
    let info = tag.digest ? showCache.get(tag.digest) : null;
    if (!info) {
      try {
        info = trimShow(await ollama.show(tag.name));
        if (tag.digest) showCache.set(tag.digest, info);
      } catch (err) {
        console.warn('[ollama] could not read details of', tag.name, err.message);
      }
    }
    list.push(describeModel(tag, info));
  }
  list.sort((a, b) => Number(b.vision) - Number(a.vision) || a.name.localeCompare(b.name));
  models = list;
  if (models.length) autoDownloadDone = true; // a model is installed: use it, nothing to fetch
}

/** Check whether Ollama is running and reload the list of models. */
function refreshOllama() {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        ollamaInfo = { state: 'ok', version: await ollama.version() };
      } catch {
        ollamaInfo = { state: 'down', version: '' };
      }
      if (ollamaInfo.state === 'ok') {
        try {
          await loadModels();
        } catch (err) {
          console.warn('[ollama] could not list models:', err.message);
        }
      }
    })().finally(() => {
      refreshing = null;
      notifySettings();
    });
  }
  return refreshing;
}

/** Start Ollama if it's installed here and not running. Resolves to true once it answers. */
function startOllama() {
  if (!starting) {
    starting = (async () => {
      await refreshOllama();
      if (ollamaInfo.state === 'ok') return true;
      if (!isLocalUrl(ollama.url) || !launchOllama()) return false;
      notifySettings(); // "Starting Ollama…"
      for (let i = 0; i < 60 && !quitting; i++) {
        await sleep(500);
        try {
          await ollama.version();
          break;
        } catch {
          // not up yet
        }
      }
      await refreshOllama();
      return ollamaInfo.state === 'ok';
    })().finally(() => {
      starting = null;
      notifySettings();
    });
  }
  return starting;
}

/** Load the model into memory ahead of time, so the first reply comes sooner. */
function warmUp() {
  const m = activeModel();
  if (ollamaInfo.state !== 'ok' || !m || m.cloud || chat.busy) return;
  if (lastWarm.name === m.name && Date.now() - lastWarm.at < 60000) return;
  lastWarm = { name: m.name, at: Date.now() };
  ollama.load(m.name, { num_ctx: contextFor(m) }).catch((err) => console.warn('[ollama] preload failed:', err.message));
}

function pullState() {
  return pull
    ? { name: pull.name, status: pull.status, completed: pull.completed, total: pull.total, auto: pull.auto, stalled: !!pull.stalled }
    : null;
}

/** Download a model and switch to it. Resolves to { ok, model } | { ok: false, cancelled } | { ok: false, error }. */
async function startPull(name, { auto = false } = {}) {
  if (pull) return { ok: false, error: `Already downloading ${pull.name}. Wait for it to finish or cancel it first.` };
  const current = { name, status: 'starting', completed: 0, total: 0, expected: 0, auto, ac: new AbortController() };
  pull = current;
  lastPullError = null;
  sendPullProgress(true);
  notifySettings();

  // Ollama reports one file at a time; the manifest gives the whole size.
  remoteDownloadSize(name).then((bytes) => {
    if (!bytes || pull !== current) return;
    current.expected = bytes;
    current.total = Math.max(current.total, bytes);
    sendPullProgress(false);
  });
  // No bytes for a while (Ollama retries stalled parts on its own): say so.
  let lastChange = Date.now();
  let lastRaw = -1;
  const stallTimer = setInterval(() => {
    const stalled = current.total > 0 && Date.now() - lastChange > 20000;
    if (stalled !== !!current.stalled) {
      current.stalled = stalled;
      sendPullProgress(true);
    }
  }, 5000);

  try {
    if (ollamaInfo.state !== 'ok' && !(await startOllama())) throw Object.assign(new Error('down'), { code: 'DOWN' });
    await ollama.pull(
      name,
      (p) => {
        current.status = p.status;
        current.total = Math.max(current.expected, p.total);
        if (p.completed !== lastRaw) {
          lastRaw = p.completed;
          lastChange = Date.now();
          current.stalled = false;
        }
        // Never move the bar backwards when Ollama restarts a stalled part.
        current.completed = Math.min(current.total, Math.max(current.completed, p.completed));
        sendPullProgress(false);
      },
      current.ac.signal,
    );
    clearInterval(stallTimer);
    pull = null;
    sendPullProgress(true);
    await refreshOllama();
    const installed = models.find((m) => sameModel(m.name, name));
    if (installed) {
      settings.set({ model: installed.name });
      notifySettings();
      warmUp();
    }
    return { ok: true, model: installed ? installed.name : name };
  } catch (err) {
    clearInterval(stallTimer);
    const cancelled = current.ac.signal.aborted;
    pull = null;
    if (cancelled) {
      if (auto && current.cancelledByUser) settings.set({ autoDownload: false });
    } else {
      console.error('[ollama] download failed:', err);
      lastPullError = { name, message: describePullError(err, name) };
    }
    sendPullProgress(true);
    notifySettings();
    return cancelled ? { ok: false, cancelled: true } : { ok: false, error: lastPullError.message };
  }
}

/** No model installed at all: fetch the recommended one (the chat shows the progress and a Cancel button). */
function maybeAutoDownload() {
  if (autoDownloadDone || pull || quitting || settings.get('autoDownload') === false) return;
  if (ollamaInfo.state !== 'ok' || models.length) return;
  if (!chatWin || chatWin.isDestroyed() || !chatWin.isVisible()) return;
  autoDownloadDone = true;
  startPull(RECOMMENDED, { auto: true });
}

function sendPullProgress(now) {
  if (now) {
    clearTimeout(pullTimer);
    pullTimer = null;
    sendTo(chatWin, 'models:progress', pullState());
  } else if (!pullTimer) {
    pullTimer = setTimeout(() => {
      pullTimer = null;
      sendTo(chatWin, 'models:progress', pullState());
    }, 200);
  }
}

// ---------------------------------------------------------------- chat IPC

function publicState() {
  const m = activeModel();
  const url = ollama.url;
  return {
    settings: {
      model: m ? m.name : null,
      think: !!settings.get('think'),
      imageDetail: settings.get('imageDetail'),
      includeScreen: settings.get('includeScreen'),
      hotkey: settings.get('hotkey'),
      showMascot: settings.get('showMascot'),
      startWithWindows: getLoginItem(),
      ollamaUrl: url,
      control: controlMode(),
      documents: settings.get('documents') !== false,
    },
    docsFolder: documents.folder(),
    ollama: {
      state: ollamaInfo.state,
      version: ollamaInfo.version,
      url,
      local: isLocalUrl(url),
      installed: ollamaInstalled(),
      starting: !!starting,
    },
    models: models.map(({ name, size, params, vision, tools: canUseTools, canThink, cloud }) => ({
      name,
      size,
      params,
      vision,
      tools: canUseTools,
      canThink,
      cloud,
    })),
    model: m ? { name: m.name, vision: m.vision, tools: m.tools, canThink: m.canThink, cloud: m.cloud } : null,
    suggested: SUGGESTED,
    recommended: RECOMMENDED,
    pull: pullState(),
    pullError: lastPullError,
    hotkeyActive: hotkeyOk,
    version: app.getVersion(),
  };
}

function notifySettings() {
  sendTo(chatWin, 'settings:changed', publicState());
}

ipcMain.handle('chat:init', (e) => (fromWin(e, chatWin) ? publicState() : null));

ipcMain.handle('chat:send', async (e, args) => {
  if (!fromWin(e, chatWin)) return { ok: false };
  const turnId = Number(args && args.turnId);
  const text = String((args && args.text) || '').slice(0, 20000).trim();
  if (!text) return { ok: false, error: { message: 'Type a message first.' } };
  if (sending || chat.busy) {
    return { ok: false, error: { message: 'Buddy is still answering the previous message.' } };
  }

  sending = true;
  try {
    if (ollamaInfo.state !== 'ok') await refreshOllama();
    if (ollamaInfo.state !== 'ok') {
      if (isLocalUrl(ollama.url) && ollamaInstalled()) {
        sendTo(chatWin, 'chat:event', { turnId, type: 'status', text: 'Starting Ollama…' });
        await startOllama();
      }
      if (ollamaInfo.state !== 'ok') return { ok: false, error: cantReachOllama() };
    }

    const model = activeModel();
    if (!model && pull) {
      return { ok: false, error: { message: `${pull.name} is still downloading. Ask again as soon as it's done.` } };
    }
    if (!model) {
      return { ok: false, error: { message: 'Download a model first: open Settings and pick one under "Add a model".', needsSettings: true } };
    }

    let shot = null;
    if (args.includeScreen && model.vision) {
      try {
        shot = await captureForChat();
        shots.set(turnId, shot.jpeg);
        sendTo(chatWin, 'chat:event', {
          turnId,
          type: 'shot',
          thumb: `data:image/jpeg;base64,${shot.thumb.toString('base64')}`,
          width: shot.width,
          height: shot.height,
        });
      } catch (err) {
        console.error('[capture] failed:', err);
        sendTo(chatWin, 'chat:event', { turnId, type: 'shot-failed', message: err.message });
      }
    } else if (args.includeScreen) {
      sendTo(chatWin, 'chat:event', { turnId, type: 'no-shot' });
    }
    chat.send({ turnId, text, shot }); // replies stream back through onChatEvent
    return { ok: true };
  } finally {
    sending = false;
  }
});

ipcMain.handle('chat:retry', async (e, turnId) => {
  if (!fromWin(e, chatWin)) return { ok: false };
  if (sending || chat.busy) return { ok: false, error: { message: 'Buddy is still answering the previous message.' } };
  if (ollamaInfo.state !== 'ok' && !(await startOllama())) return { ok: false, error: cantReachOllama() };
  chat.retry(Number(turnId)).catch((err) => {
    sendTo(chatWin, 'chat:event', { turnId: Number(turnId), type: 'error', message: err.message });
  });
  return { ok: true };
});

ipcMain.on('chat:stop', (e) => {
  if (fromWin(e, chatWin)) chat.stop();
});

ipcMain.handle('chat:new', (e) => {
  if (fromWin(e, chatWin)) newChat();
  return true;
});

ipcMain.handle('chat:get-shot', (e, turnId) => {
  if (!fromWin(e, chatWin)) return null;
  const jpeg = shots.get(Number(turnId));
  return jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
});

ipcMain.on('chat:hide', (e) => {
  if (fromWin(e, chatWin)) hideChat();
});

ipcMain.on('chat:copy', (e, text) => {
  if (fromWin(e, chatWin)) clipboard.writeText(String(text));
});

ipcMain.on('chat:open-external', (e, url) => {
  if (fromWin(e, chatWin)) openExternalSafe(String(url));
});

ipcMain.on('chat:approve', (e, id, decision) => {
  if (!fromWin(e, chatWin)) return;
  const decide = approvals.get(Number(id));
  if (decide && ['allow', 'all', 'deny'].includes(decision)) decide(decision);
});

// Only documents Buddy created in this session can be opened from the chat.
ipcMain.handle('chat:open-file', async (e, file, how) => {
  if (!fromWin(e, chatWin) || !createdFiles.has(String(file))) return false;
  if (how === 'folder') shell.showItemInFolder(String(file));
  else {
    const error = await shell.openPath(String(file));
    if (error) return error;
  }
  return true;
});

ipcMain.on('docs:open-folder', (e) => {
  if (!fromWin(e, chatWin)) return;
  const dir = documents.folder();
  require('fs').mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

// ---------------------------------------------------------------- Ollama + models IPC

ipcMain.handle('ollama:refresh', async (e) => {
  if (!fromWin(e, chatWin)) return null;
  await refreshOllama();
  maybeAutoDownload();
  return publicState();
});

ipcMain.handle('ollama:start', async (e) => {
  if (!fromWin(e, chatWin)) return null;
  await startOllama();
  maybeAutoDownload();
  warmUp();
  return publicState();
});

ipcMain.handle('models:pull', async (e, input) => {
  if (!fromWin(e, chatWin)) return null;
  const name = normalizeModelName(input);
  if (!name) return { ok: false, error: 'Type a model name, for example qwen3.5:4b.' };
  const result = await startPull(name);
  return { ...result, state: publicState() };
});

ipcMain.on('models:cancel-pull', (e) => {
  if (fromWin(e, chatWin) && pull) {
    pull.cancelledByUser = true;
    pull.ac.abort();
  }
});

ipcMain.handle('models:delete', async (e, name) => {
  if (!fromWin(e, chatWin)) return null;
  const model = models.find((m) => m.name === name);
  if (!model) return { ok: false, error: `${name} isn't installed.`, state: publicState() };
  if (chat.busy && activeModel() === model) {
    return { ok: false, error: 'Wait for the current reply to finish first.', state: publicState() };
  }
  try {
    await ollama.remove(model.name);
  } catch (err) {
    console.error('[ollama] delete failed:', err);
    return { ok: false, error: `Couldn't delete ${model.name}: ${err.message}`, state: publicState() };
  }
  if (sameModel(settings.get('model'), model.name)) settings.set({ model: null });
  await refreshOllama();
  return { ok: true, state: publicState() };
});

// ---------------------------------------------------------------- settings

ipcMain.handle('settings:save', async (e, patch) => {
  if (!fromWin(e, chatWin)) return null;
  patch = patch || {};
  const result = { ok: true, errors: {} };

  if (typeof patch.model === 'string' && models.some((m) => m.name === patch.model)) {
    settings.set({ model: patch.model });
    warmUp();
  }
  if (typeof patch.think === 'boolean') settings.set({ think: patch.think });
  if (['off', 'ask', 'auto'].includes(patch.control)) settings.set({ control: patch.control });
  if (typeof patch.documents === 'boolean') settings.set({ documents: patch.documents });
  if (patch.imageDetail === 'high' || patch.imageDetail === 'low') settings.set({ imageDetail: patch.imageDetail });
  if (typeof patch.includeScreen === 'boolean') settings.set({ includeScreen: patch.includeScreen });
  if (typeof patch.showMascot === 'boolean') {
    settings.set({ showMascot: patch.showMascot });
    applyMascotVisibility();
  }
  if (typeof patch.startWithWindows === 'boolean' && patch.startWithWindows !== getLoginItem()) {
    setLoginItem(patch.startWithWindows);
  }
  if (typeof patch.hotkey === 'string' && patch.hotkey !== settings.get('hotkey')) {
    if (registerHotkey(patch.hotkey)) {
      settings.set({ hotkey: patch.hotkey, hotkeyAuto: false });
    } else {
      registerHotkey(settings.get('hotkey'));
      result.ok = false;
      result.errors.hotkey = `Couldn't use ${patch.hotkey} - another app may already be using it.`;
    }
  }
  if (typeof patch.ollamaUrl === 'string') {
    const url = normalizeUrl(patch.ollamaUrl);
    if (!url) {
      result.ok = false;
      result.errors.ollamaUrl = 'Enter an address like http://127.0.0.1:11434';
    } else if (url !== ollama.url) {
      settings.set({ ollamaUrl: url });
      models = [];
      showCache.clear();
      await refreshOllama();
    }
  }

  refreshTrayMenu();
  return { ...result, state: publicState() };
});

// Start with Windows. When running from source, Windows must launch
// electron.exe with this folder as its argument (quoted: the path has spaces).
function loginItemOptions() {
  return app.isPackaged ? {} : { path: process.execPath, args: [`"${app.getAppPath()}"`] };
}

function getLoginItem() {
  try {
    return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  } catch {
    return false;
  }
}

function setLoginItem(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, ...loginItemOptions() });
}

function setupHotkey() {
  const saved = settings.get('hotkey');
  if (saved === '') return; // turned off in Settings
  if (saved && registerHotkey(saved)) return;
  if (saved && !settings.get('hotkeyAuto')) return; // the user's own pick; Settings flags it as inactive
  for (const candidate of HOTKEY_CANDIDATES) {
    if (registerHotkey(candidate)) {
      settings.set({ hotkey: candidate, hotkeyAuto: true });
      return;
    }
  }
}

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  hotkeyOk = false;
  if (!accelerator) return true;
  try {
    hotkeyOk = globalShortcut.register(accelerator, onHotkey);
  } catch {
    hotkeyOk = false;
  }
  return hotkeyOk;
}

// ---------------------------------------------------------------- tray

function createTray() {
  tray = new Tray(buddyIcon(16));
  tray.setToolTip('Claude Buddy');
  tray.on('click', () => toggleChat());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

function buildMenu() {
  const hotkey = settings.get('hotkey');
  return Menu.buildFromTemplate([
    {
      label: 'Ask Buddy',
      click: () => showChat(),
      ...(hotkey && hotkeyOk ? { accelerator: hotkey, registerAccelerator: false } : {}),
    },
    {
      label: 'New chat',
      click: () => {
        newChat();
        showChat();
      },
    },
    { type: 'separator' },
    {
      label: 'Show floating buddy',
      type: 'checkbox',
      checked: !!settings.get('showMascot'),
      click: (item) => {
        settings.set({ showMascot: item.checked });
        applyMascotVisibility();
        refreshTrayMenu();
        notifySettings();
      },
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: getLoginItem(),
      click: (item) => {
        setLoginItem(item.checked);
        refreshTrayMenu();
        notifySettings();
      },
    },
    { label: 'Settings…', click: () => showChat({ openSettings: true }) },
    { type: 'separator' },
    { label: 'Quit Claude Buddy', click: () => app.quit() },
  ]);
}
