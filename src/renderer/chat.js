'use strict';

// The chat window: sends questions, renders the model's streamed replies, and
// hosts the settings page (Ollama status, installed models, downloads).

(() => {
  const api = window.buddy;
  const S = window.BuddySprite;
  const $ = (id) => document.getElementById(id);

  const scroller = $('scroller');
  const welcome = $('welcome');
  const setupCard = $('setup');
  const messagesEl = $('messages');
  const input = $('input');
  const sendBtn = $('sendBtn');
  const screenBtn = $('screenBtn');
  const modelBtn = $('modelBtn');
  const modelMenu = $('modelMenu');
  const sheet = $('settings');
  const lightbox = $('lightbox');
  const lightboxImg = $('lightboxImg');

  const OLLAMA_DOWNLOAD = 'https://ollama.com/download';

  const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>'),
    copy: svg('<rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    chevron: svg('<path d="m9 18 6-6-6-6"/>'),
    plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    eye: svg('<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: svg(
      '<path d="M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>',
    ),
  };
  const KEYBOARD = svg(
    '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
  );
  const ACTION_ICONS = {
    click: svg('<path d="m9 9 5 12 1.8-5.2L21 14Z"/><path d="M7.2 2.2 8 5.1"/><path d="m5.1 8-2.9-.8"/><path d="M14 4.1 12 6"/><path d="m6 12-1.9 2"/>'),
    type: KEYBOARD,
    keys: KEYBOARD,
    scroll: svg('<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>'),
    open_app: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>'),
    open_url: svg('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
    wait: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
    document: svg(
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    ),
  };
  const CONTROL_HELP = {
    off: 'Buddy only looks and answers.',
    ask: 'Buddy can click, type and open apps for you, and shows you each action to allow first. It needs Screen on to act.',
    auto: 'Buddy acts without asking. Move the mouse or press ■ to stop it at any time. It needs Screen on to act.',
  };

  let app = null; // state from the main process
  let includeScreen = true;
  let busy = false;
  let turnSeq = Date.now() % 1e9;
  let spinIdx = 0;
  const turns = new Map();
  let confirmDelete = null; // model waiting for "Delete?" confirmation
  let tipDismissed = false; // "Not now" on the can't-see-your-screen tip
  let pullMsg = null; // { kind, text } after a download ends

  // ---------------------------------------------------------- helpers

  function h(tag, cls, html) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  function scrollToBottom() {
    scroller.scrollTop = scroller.scrollHeight;
  }

  function setStatus(el, kind, text) {
    el.className = `status ${kind || ''}`;
    el.textContent = text || '';
  }

  function formatBytes(n) {
    if (!n) return '';
    return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
  }

  // "qwen3.5:latest" -> "qwen3.5"
  function shortName(name) {
    return String(name || '').replace(/:latest$/, '');
  }

  // Ollama treats "qwen3.5" and "qwen3.5:latest" as the same model.
  function modelKey(name) {
    let n = String(name || '').toLowerCase();
    if (n.lastIndexOf(':') <= n.lastIndexOf('/')) n += ':latest';
    return n;
  }

  function isInstalled(name) {
    return app.models.some((m) => modelKey(m.name) === modelKey(name));
  }

  // Can the model in use read screenshots? (Unknown counts as yes until we know.)
  function modelSees() {
    return !app || !app.model || app.model.vision;
  }

  function recommended() {
    return app.suggested.find((x) => x.name === app.recommended) || { name: app.recommended, size: '' };
  }

  // ---------------------------------------------------------- markdown

  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      code({ text, lang }) {
        const label = (lang || '').trim().split(/\s+/)[0] || 'code';
        return (
          `<div class="codeblock"><div class="codebar"><span>${esc(label)}</span>` +
          `<button type="button" class="copy-code">${ICONS.copy}<span>Copy</span></button></div>` +
          `<pre><code>${esc(text)}</code></pre></div>`
        );
      },
      // Show raw HTML from the model as text instead of rendering it.
      html({ text }) {
        return esc(text);
      },
    },
  });

  function renderMd(text) {
    return DOMPurify.sanitize(marked.parse(text));
  }

  // Spinner glyphs on every active spinner.
  setInterval(() => {
    const spinners = document.querySelectorAll('.spinner');
    if (!spinners.length) return;
    spinIdx = (spinIdx + 1) % S.SPINNER.length;
    for (const el of spinners) el.textContent = S.SPINNER[spinIdx];
  }, 120);

  // ---------------------------------------------------------- turns

  function createTurn(turnId, text, withShot) {
    const t = { id: turnId, text: '', thinking: '', thinkStart: 0, thinkEnd: 0, renderPending: false, actions: new Map() };

    t.userEl = h('div', 'turn user');
    if (withShot) {
      t.shotEl = h('button', 'shot loading');
      t.shotEl.type = 'button';
      t.shotEl.title = 'The screenshot sent with this message';
      t.shotEl.dataset.turn = String(turnId);
      t.userEl.append(t.shotEl);
    }
    const bubble = h('div', 'bubble');
    bubble.dir = 'auto';
    bubble.textContent = text;
    t.userEl.append(bubble);

    t.el = h('div', 'turn assistant streaming');
    t.el.dataset.turn = String(turnId);
    t.statusEl = h('div', 'status-line', `<span class="spinner">${S.SPINNER[spinIdx]}</span><span></span>`);
    t.statusText = t.statusEl.lastChild;
    t.statusText.textContent = withShot ? 'Looking at your screen…' : 'Thinking…';

    t.thinkEl = h(
      'div',
      'thinking hidden',
      `<button type="button" class="think-toggle"><span class="think-icon spinner">${S.SPINNER[spinIdx]}</span>` +
        `<span class="think-label">Thinking…</span>${ICONS.chevron}</button><div class="think-body hidden"></div>`,
    );
    t.thinkIcon = t.thinkEl.querySelector('.think-icon');
    t.thinkLabel = t.thinkEl.querySelector('.think-label');
    t.thinkBody = t.thinkEl.querySelector('.think-body');

    t.actionsEl = h('div', 'actions-list hidden');
    t.mdEl = h('div', 'md');
    t.mdEl.dir = 'auto';
    t.noticeEl = h('div', 'notice hidden');
    t.metaEl = h('div', 'meta hidden');
    t.el.append(t.statusEl, t.thinkEl, t.actionsEl, t.mdEl, t.noticeEl, t.metaEl);

    messagesEl.append(t.userEl, t.el);
    turns.set(turnId, t);
    welcome.classList.add('hidden');
    scrollToBottom();
    return t;
  }

  function settle(t) {
    endThinking(t);
    t.statusEl.classList.add('hidden');
    t.el.classList.remove('streaming');
  }

  function startThinking(t) {
    t.statusEl.classList.add('hidden');
    t.thinkEl.classList.remove('hidden');
    if (!t.thinkStart) t.thinkStart = performance.now();
  }

  function endThinking(t) {
    if (t.thinkStart && !t.thinkEnd) {
      t.thinkEnd = performance.now();
      const secs = Math.max(1, Math.round((t.thinkEnd - t.thinkStart) / 1000));
      t.thinkLabel.textContent = `Thought for ${secs}s`;
      t.thinkIcon.classList.remove('spinner');
      t.thinkIcon.textContent = '✻';
    }
    if (!t.thinking.trim()) t.thinkEl.classList.add('hidden');
  }

  function scheduleRender(t) {
    if (t.renderPending) return;
    t.renderPending = true;
    requestAnimationFrame(() => {
      t.renderPending = false;
      const stick = nearBottom();
      t.mdEl.innerHTML = renderMd(t.text);
      if (stick) scrollToBottom();
    });
  }

  function showNotice(t, kind, message, actionsHtml) {
    t.noticeEl.className = `notice ${kind}`;
    t.noticeEl.innerHTML = `<p></p>${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}`;
    t.noticeEl.firstChild.textContent = message;
  }

  // ---------------------------------------------------------- actions

  function addAction(t, e) {
    t.actionsEl.classList.remove('hidden');
    // The status line ("Checking the screen…") moves under the actions.
    t.el.insertBefore(t.statusEl, t.mdEl);
    t.statusEl.classList.add('hidden');
    const row = h(
      'div',
      'action',
      `<div class="action-head"><span class="action-icon">${ACTION_ICONS[e.kind] || ACTION_ICONS.click}</span>` +
        '<span class="action-label"></span><span class="action-state"></span></div>',
    );
    row.dataset.id = String(e.id);
    row.querySelector('.action-label').textContent = e.label;
    if (e.preview) {
      const pv = h('div', 'action-preview');
      const img = new Image();
      img.alt = 'Where Buddy will act';
      img.src = e.preview.src;
      const mark = h('span', 'marker');
      mark.style.left = `${e.preview.mx}%`;
      mark.style.top = `${e.preview.my}%`;
      pv.append(img, mark);
      row.append(pv);
    }
    t.actionsEl.append(row);
    t.actions.set(e.id, row);
    setActionState(row, e.state, e);
  }

  function setActionState(row, state, e = {}) {
    row.dataset.state = state;
    const st = row.querySelector('.action-state');
    st.className = 'action-state';
    if (state === 'running') {
      st.classList.add('spinner');
      st.textContent = S.SPINNER[spinIdx];
    } else if (state === 'done') {
      st.innerHTML = ICONS.check;
    } else {
      st.textContent = { ask: 'Waiting for you', denied: 'Skipped', failed: 'Failed', stopped: 'Stopped' }[state] || '';
    }
    const ask = row.querySelector('.action-ask');
    if (ask) ask.remove();
    if (state === 'ask') {
      row.append(
        h(
          'div',
          'action-ask',
          '<button type="button" class="btn small primary" data-approve="allow">Allow</button>' +
            '<button type="button" class="btn small" data-approve="all">Allow all</button>' +
            '<button type="button" class="btn small" data-approve="deny">Don’t</button>',
        ),
      );
    }
    if (e.message) {
      const msg = row.querySelector('.action-msg') || row.appendChild(h('div', 'action-msg'));
      msg.textContent = e.message;
    }
    if (state === 'done' && e.file && !row.querySelector('.action-file')) {
      const f = h(
        'div',
        'action-file',
        '<span class="file-name"></span><button type="button" class="btn small primary" data-file-open>Open</button>' +
          '<button type="button" class="btn small" data-file-folder>Show in folder</button>',
      );
      f.querySelector('.file-name').textContent = e.file.name;
      f.dataset.path = e.file.path;
      row.append(f);
    }
  }

  /** The request ended: nothing is waiting or running any more. */
  function closeActions(t) {
    for (const row of t.actions.values()) {
      if (row.dataset.state === 'ask' || row.dataset.state === 'running') setActionState(row, 'stopped');
    }
  }

  function setMeta(t, label, withCopy) {
    t.metaEl.innerHTML =
      (withCopy ? `<button type="button" class="icon-btn small copy-msg" title="Copy reply">${ICONS.copy}</button>` : '') +
      `<span></span>`;
    t.metaEl.lastChild.textContent = label;
    t.metaEl.classList.remove('hidden');
  }

  function onEvent(e) {
    if (e.type === 'reset') {
      resetView();
      return;
    }
    const t = turns.get(e.turnId);
    if (!t) return;
    const stick = nearBottom();

    switch (e.type) {
      case 'shot': {
        if (!t.shotEl) break;
        t.shotEl.classList.remove('loading');
        const img = new Image();
        img.alt = 'Your screen';
        img.src = e.thumb;
        t.shotEl.replaceChildren(img);
        break;
      }
      case 'shot-failed':
        if (t.shotEl) {
          t.shotEl.className = 'shot failed';
          t.shotEl.textContent = 'No screenshot';
          t.shotEl.title = e.message || 'The screen could not be captured';
        }
        break;
      case 'no-shot': // the model can't read images, so none was taken
        if (t.shotEl) t.shotEl.remove();
        t.shotEl = null;
        if (!t.text && !t.thinkStart) t.statusText.textContent = 'Thinking…';
        break;
      case 'status':
        if (t.actions.size) {
          t.statusText.textContent = e.text;
          t.statusEl.classList.remove('hidden');
        } else if (!t.text && !t.thinkStart) {
          t.statusText.textContent = e.text;
        }
        break;
      case 'action':
        addAction(t, e);
        break;
      case 'action-update': {
        const row = t.actions.get(e.id);
        if (row) setActionState(row, e.state, e);
        break;
      }
      case 'thinking-start':
        startThinking(t);
        break;
      case 'thinking':
        startThinking(t);
        t.thinking += e.text;
        t.thinkBody.textContent = t.thinking;
        if (!t.thinkBody.classList.contains('hidden')) t.thinkBody.scrollTop = t.thinkBody.scrollHeight;
        break;
      case 'text-start':
        t.statusEl.classList.add('hidden');
        endThinking(t);
        break;
      case 'text':
        t.text += e.text;
        scheduleRender(t);
        break;
      case 'done': {
        settle(t);
        closeActions(t);
        t.mdEl.innerHTML = renderMd(t.text);
        if (e.empty && !t.text.trim()) showNotice(t, 'info', "The model didn't write a reply. Try asking again.");
        if (e.truncated) showNotice(t, 'info', 'The reply was cut off because it got too long.');
        if (e.limit) showNotice(t, 'info', `I stopped after ${e.actions} actions. Ask me to continue if there's more to do.`);
        const acts = e.actions ? ` · ${e.actions} action${e.actions === 1 ? '' : 's'}` : '';
        setMeta(t, `${shortName(e.modelName || e.model)}${acts} · ${(e.ms / 1000).toFixed(1)}s`, !!t.text.trim());
        setBusy(false);
        break;
      }
      case 'stopped':
        settle(t);
        closeActions(t);
        if (t.text) t.mdEl.innerHTML = renderMd(t.text);
        setMeta(t, 'Stopped', !!t.text.trim());
        setBusy(false);
        break;
      case 'error': {
        settle(t);
        closeActions(t);
        if (t.text) t.mdEl.innerHTML = renderMd(t.text);
        if (t.shotEl && t.shotEl.classList.contains('loading')) t.shotEl.remove();
        let actions = '';
        if (e.retryable) actions += '<button type="button" class="btn small retry">Retry</button>';
        if (e.needsInstall) actions += '<button type="button" class="btn small get-ollama">Get Ollama</button>';
        if (e.needsOllama) actions += '<button type="button" class="btn small start-ollama">Start Ollama</button>';
        if (e.needsSettings) actions += '<button type="button" class="btn small open-settings">Open settings</button>';
        showNotice(t, 'error', e.message || 'Something went wrong.', actions);
        setBusy(false);
        break;
      }
    }
    if (stick) scrollToBottom();
  }

  async function send(preset) {
    const text = (preset != null ? preset : input.value).trim();
    if (!text || busy || !app) return;
    if (app.ollama.state === 'ok' && !app.models.length && !app.pull) {
      openSettings('add');
      return;
    }
    const wantsScreen = includeScreen && modelSees();
    const turnId = ++turnSeq;
    const t = createTurn(turnId, text, wantsScreen);
    if (preset == null) {
      input.value = '';
      autosize();
    }
    setBusy(true);
    const r = await api.send({ turnId, text, includeScreen: wantsScreen });
    if (!r || !r.ok) {
      onEvent({ turnId: t.id, type: 'error', ...((r && r.error) || { message: 'Something went wrong.' }) });
      // Put the question back so it can be sent again in one click.
      if (preset == null && !input.value.trim()) {
        input.value = text;
        autosize();
        updateSendEnabled();
      }
    }
  }

  async function retryTurn(t) {
    if (busy) return;
    t.noticeEl.className = 'notice hidden';
    t.noticeEl.replaceChildren();
    t.metaEl.classList.add('hidden');
    t.text = '';
    t.thinking = '';
    t.thinkStart = 0;
    t.thinkEnd = 0;
    t.mdEl.innerHTML = '';
    t.thinkBody.textContent = '';
    t.thinkLabel.textContent = 'Thinking…';
    t.thinkIcon.classList.add('spinner');
    t.thinkEl.classList.add('hidden');
    t.actions.clear();
    t.actionsEl.replaceChildren();
    t.actionsEl.classList.add('hidden');
    t.el.insertBefore(t.statusEl, t.el.firstChild);
    t.el.classList.add('streaming');
    t.statusEl.classList.remove('hidden');
    t.statusText.textContent = 'Trying again…';
    setBusy(true);
    const r = await api.retry(t.id);
    if (!r || !r.ok) onEvent({ turnId: t.id, type: 'error', ...((r && r.error) || { message: 'Could not retry.' }) });
  }

  function resetView() {
    turns.clear();
    messagesEl.replaceChildren();
    welcome.classList.remove('hidden');
    setBusy(false);
    closeLightbox();
    input.focus();
  }

  function setBusy(on) {
    busy = on;
    sendBtn.classList.toggle('stop', on);
    sendBtn.innerHTML = on ? ICONS.stop : ICONS.send;
    sendBtn.title = on ? 'Stop' : 'Send (Enter)';
    sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
    updateSendEnabled();
  }

  function updateSendEnabled() {
    sendBtn.disabled = !busy && !input.value.trim();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function flashCopied(btn) {
    const old = btn.innerHTML;
    btn.innerHTML = btn.classList.contains('copy-code') ? `${ICONS.check}<span>Copied</span>` : ICONS.check;
    setTimeout(() => {
      btn.innerHTML = old;
    }, 1200);
  }

  // ---------------------------------------------------------- lightbox

  async function openLightbox(turnId) {
    const url = await api.getShot(turnId);
    if (!url) return;
    lightboxImg.src = url;
    lightbox.classList.remove('hidden');
  }

  function closeLightbox() {
    lightbox.classList.add('hidden');
    lightboxImg.removeAttribute('src');
  }

  lightbox.addEventListener('click', closeLightbox);

  // ---------------------------------------------------------- composer

  function renderScreenToggle() {
    const sees = modelSees();
    const on = includeScreen && sees;
    screenBtn.classList.toggle('on', on);
    screenBtn.classList.toggle('blind', !sees);
    screenBtn.setAttribute('aria-pressed', String(on));
    if (!sees) {
      screenBtn.innerHTML = `${ICONS.eyeOff}<span>Can't see screen</span>`;
      screenBtn.title = `${shortName(app.model.name)} can't read images. Click to pick a model that can.`;
    } else {
      screenBtn.innerHTML = `${on ? ICONS.eye : ICONS.eyeOff}<span>${on ? 'Screen on' : 'Screen off'}</span>`;
      screenBtn.title = on
        ? 'Buddy gets a screenshot with each message. Click to turn off.'
        : "Buddy won't see your screen. Click to turn on.";
    }
    input.placeholder = on ? 'Ask about anything on your screen…' : 'Ask anything…';
  }

  screenBtn.addEventListener('click', () => {
    if (!modelSees()) {
      openSettings('models');
      return;
    }
    includeScreen = !includeScreen;
    renderScreenToggle();
    api.saveSettings({ includeScreen });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => {
    autosize();
    updateSendEnabled();
  });

  sendBtn.addEventListener('click', () => {
    if (busy) api.stop();
    else send();
  });

  for (const btn of document.querySelectorAll('.suggestion')) {
    btn.addEventListener('click', () => send(btn.dataset.q));
  }

  messagesEl.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (link) {
      e.preventDefault();
      api.openExternal(link.href);
      return;
    }
    const copyCode = e.target.closest('.copy-code');
    if (copyCode) {
      api.copy(copyCode.closest('.codeblock').querySelector('code').textContent);
      flashCopied(copyCode);
      return;
    }
    const copyMsg = e.target.closest('.copy-msg');
    if (copyMsg) {
      const t = turns.get(Number(copyMsg.closest('.turn').dataset.turn));
      if (t) api.copy(t.text);
      flashCopied(copyMsg);
      return;
    }
    const shot = e.target.closest('.shot');
    if (shot && !shot.classList.contains('loading') && !shot.classList.contains('failed')) {
      openLightbox(Number(shot.dataset.turn));
      return;
    }
    const approve = e.target.closest('[data-approve]');
    if (approve) {
      const row = approve.closest('.action');
      api.approve(Number(row.dataset.id), approve.dataset.approve);
      const ask = row.querySelector('.action-ask');
      if (ask) ask.remove();
      row.querySelector('.action-state').textContent = '…';
      return;
    }
    const fileBtn = e.target.closest('[data-file-open], [data-file-folder]');
    if (fileBtn) {
      const box = fileBtn.closest('.action-file');
      api.openFile(box.dataset.path, fileBtn.hasAttribute('data-file-folder') ? 'folder' : 'open').then((r) => {
        if (r === true) return;
        const row = box.closest('.action');
        const msg = row.querySelector('.action-msg') || row.appendChild(h('div', 'action-msg'));
        msg.textContent = typeof r === 'string' && r ? `Couldn't open it: ${r}` : "Couldn't open the file.";
      });
      return;
    }
    const retry = e.target.closest('.retry');
    if (retry) {
      const t = turns.get(Number(retry.closest('.turn').dataset.turn));
      if (t) retryTurn(t);
      return;
    }
    if (e.target.closest('.start-ollama')) {
      startOllama(e.target.closest('.start-ollama'));
      return;
    }
    if (e.target.closest('.get-ollama')) {
      api.openExternal(OLLAMA_DOWNLOAD);
      return;
    }
    if (e.target.closest('.open-settings')) {
      openSettings(app && app.ollama.state === 'ok' ? 'models' : undefined);
      return;
    }
    const toggle = e.target.closest('.think-toggle');
    if (toggle) {
      toggle.classList.toggle('open');
      toggle.nextElementSibling.classList.toggle('hidden');
    }
  });

  // ---------------------------------------------------------- Ollama + models

  async function startOllama(btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Starting…';
    }
    applyState(await api.startOllama());
    if (btn && btn.isConnected) {
      if (app.ollama.state === 'ok') btn.textContent = 'Ollama is running ✓ Send again';
      else {
        btn.disabled = false;
        btn.textContent = 'Start Ollama';
      }
    }
  }

  function pullLabel(p) {
    const st = String(p.status || '').toLowerCase();
    if (st.includes('verifying')) return 'Checking the download…';
    if (st.includes('writing') || st.includes('removing') || st === 'success') return 'Finishing…';
    if (!p.total) return 'Starting…';
    if (p.stalled) return `Waiting for the network… ${formatBytes(p.completed) || '0 MB'} of ${formatBytes(p.total)}`;
    const pct = Math.floor((p.completed / p.total) * 100);
    return `${pct}% · ${formatBytes(p.completed) || '0 MB'} of ${formatBytes(p.total)}`;
  }

  function pullPercent(p) {
    return p && p.total ? Math.floor((p.completed / p.total) * 100) : 0;
  }

  async function pullModel(name) {
    if (!name || (app && app.pull)) return;
    pullMsg = null;
    renderPullStatus();
    const r = await api.pullModel(name);
    if (r && r.ok) {
      pullMsg = { kind: 'ok', text: `Downloaded ${r.model} ✓ Buddy is using it now.` };
      $('pullName').value = '';
    } else if (r && r.cancelled) {
      pullMsg = { kind: '', text: 'Download cancelled. If you start it again, it picks up where it stopped.' };
    } else {
      pullMsg = { kind: 'err', text: (r && r.error) || 'The download failed.' };
    }
    if (r && r.state) applyState(r.state);
    renderPullStatus();
  }

  async function deleteModel(name) {
    confirmDelete = null;
    setStatus($('modelStatus'), '', `Deleting ${name}…`);
    const r = await api.deleteModel(name);
    if (r && r.state) applyState(r.state);
    if (r && r.ok) setStatus($('modelStatus'), 'ok', `Deleted ${name}.`);
    else setStatus($('modelStatus'), 'err', (r && r.error) || "Couldn't delete the model.");
    renderModelList();
  }

  // The card on the welcome screen that walks through setup. It is only
  // rebuilt when its content changes (progress updates are applied in place,
  // so its buttons stay clickable during a download).
  let setupHtml = '';
  function renderSetup() {
    const o = app.ollama;
    const rec = recommended();
    let html = '';
    if (app.pull) {
      const p = app.pull;
      html =
        (p.auto
          ? `<p><strong>Getting a model for you.</strong> No AI model is installed yet, so I'm downloading ${esc(p.name)}, ` +
            'which can see your screen. You can keep using your PC.</p>'
          : `<p><strong>Downloading ${esc(p.name)}…</strong> You can keep using your PC.</p>`) +
        `<div class="bar"><span></span></div>` +
        `<div class="pull-row"><span class="pull-label"></span>` +
        `<button type="button" class="link danger" data-act="cancel-pull">Cancel</button></div>`;
    } else if (o.state === 'unknown') {
      html = '';
    } else if (o.state !== 'ok') {
      if (o.starting) {
        html = '<p><span class="spinner">✻</span> Starting Ollama… this can take a few seconds.</p>';
      } else if (!o.local) {
        html =
          `<p><strong>Can't reach Ollama</strong> at ${esc(o.url)}.</p>` +
          `<div class="actions"><button type="button" class="btn primary" data-act="check">Try again</button>` +
          `<button type="button" class="btn" data-act="settings">Settings</button></div>`;
      } else if (o.installed) {
        html =
          `<p><strong>Ollama isn't running.</strong> Buddy uses it to run AI models right on your PC.</p>` +
          `<div class="actions"><button type="button" class="btn primary" data-act="start">Start Ollama</button></div>`;
      } else {
        html =
          `<p><strong>One step first: install Ollama.</strong> It's free and runs AI models right on your PC.</p>` +
          `<div class="actions"><button type="button" class="btn primary" data-act="get">Get Ollama</button>` +
          `<button type="button" class="btn" data-act="check">I've installed it</button></div>`;
      }
    } else if (!app.models.length && app.pullError) {
      html =
        `<p><strong>The download didn't finish.</strong> ${esc(app.pullError.message)}</p>` +
        `<div class="actions"><button type="button" class="btn primary" data-act="pull-again">Try again</button>` +
        `<button type="button" class="btn" data-act="add">Choose another</button></div>`;
    } else if (!app.models.length) {
      html =
        `<p><strong>Add a model to get started.</strong> ${esc(rec.name)} can see your screen and runs well on most laptops` +
        `${rec.size ? ` (${esc(rec.size)} download)` : ''}.</p>` +
        `<div class="actions"><button type="button" class="btn primary" data-act="pull-rec">Download ${esc(rec.name)}</button>` +
        `<button type="button" class="btn" data-act="add">Choose another</button></div>`;
    } else if (app.model && !app.model.vision && !app.models.some((m) => m.vision) && !tipDismissed) {
      html =
        `<p><strong>${esc(shortName(app.model.name))} can't see your screen.</strong> Download ${esc(rec.name)}` +
        `${rec.size ? ` (${esc(rec.size)})` : ''} so I can read it too.</p>` +
        `<div class="actions"><button type="button" class="btn primary" data-act="pull-rec">Download ${esc(rec.name)}</button>` +
        `<button type="button" class="btn" data-act="dismiss">Not now</button></div>`;
    }
    if (html !== setupHtml) {
      setupHtml = html;
      setupCard.innerHTML = html;
      setupCard.classList.toggle('hidden', !html);
    }
    if (app.pull) {
      setupCard.querySelector('.bar span').style.width = `${pullPercent(app.pull)}%`;
      setupCard.querySelector('.pull-label').textContent = pullLabel(app.pull);
    }
  }

  setupCard.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'start':
        startOllama(btn);
        break;
      case 'check':
        api.refreshOllama().then(applyState);
        break;
      case 'get':
        api.openExternal(OLLAMA_DOWNLOAD);
        break;
      case 'pull-rec':
        pullModel(app.recommended);
        break;
      case 'pull-again':
        pullModel(app.pullError ? app.pullError.name : app.recommended);
        break;
      case 'add':
        openSettings('add');
        break;
      case 'settings':
        openSettings();
        break;
      case 'dismiss':
        tipDismissed = true;
        renderSetup();
        break;
      case 'cancel-pull':
        api.cancelPull();
        break;
    }
  });

  // ---------------------------------------------------------- title bar

  $('closeBtn').addEventListener('click', () => api.hide());
  $('newBtn').addEventListener('click', () => api.newChat());
  $('settingsBtn').addEventListener('click', () => (sheet.classList.contains('hidden') ? openSettings() : closeSettings()));

  function renderModelChip() {
    $('modelName').textContent = app.model ? shortName(app.model.name) : 'No model';
    modelBtn.title = app.model ? `Model: ${app.model.name}. Click to change.` : 'Pick a model';
  }

  function modelBlurb(m) {
    return [m.vision ? 'Sees your screen' : 'Text only', m.cloud ? 'Cloud' : '', formatBytes(m.size)].filter(Boolean).join(' · ');
  }

  function renderModelMenu() {
    const items = app.models.map((m) => {
      const on = !!app.model && m.name === app.model.name;
      return (
        `<button type="button" role="menuitemradio" aria-checked="${on}" class="menu-item" data-model="${esc(m.name)}">` +
        `<span class="mi-text"><span class="mi-name">${esc(shortName(m.name))}</span><span class="mi-blurb">${esc(modelBlurb(m))}</span></span>` +
        `${on ? ICONS.check : ''}</button>`
      );
    });
    items.push(
      `<button type="button" role="menuitem" class="menu-item add" data-add="1">${ICONS.plus}` +
        `<span class="mi-text"><span class="mi-name">Add a model…</span></span></button>`,
    );
    modelMenu.innerHTML = items.join('');
  }

  function openModelMenu() {
    renderModelMenu();
    modelMenu.classList.remove('hidden');
  }

  function closeModelMenu() {
    modelMenu.classList.add('hidden');
  }

  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modelMenu.classList.contains('hidden')) openModelMenu();
    else closeModelMenu();
  });

  modelMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-model]');
    if (item) {
      closeModelMenu();
      saveSettings({ model: item.dataset.model });
    } else if (e.target.closest('[data-add]')) {
      openSettings('add');
    }
  });

  document.addEventListener('click', (e) => {
    if (!modelMenu.contains(e.target) && !modelBtn.contains(e.target)) closeModelMenu();
  });

  // ---------------------------------------------------------- settings

  let toastTimer = null;
  function toast() {
    const el = $('savedToast');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1200);
  }

  async function saveSettings(patch, quiet) {
    const r = await api.saveSettings(patch);
    if (r && r.state) applyState(r.state);
    if (r && r.ok && !quiet && !sheet.classList.contains('hidden')) toast();
    return r;
  }

  function setSegmented(el, value) {
    for (const b of el.querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === value);
  }

  function renderOllamaRow() {
    const o = app.ollama;
    let dot = 'ok';
    let text = '';
    let action = '';
    if (o.state === 'ok') text = `Running${o.version ? ` · version ${o.version}` : ''}`;
    else if (o.starting) [dot, text] = ['warn', 'Starting…'];
    else if (o.state === 'unknown') [dot, text] = ['warn', 'Checking…'];
    else if (!o.local) [dot, text, action] = ['bad', `Can't reach ${o.url}`, 'check'];
    else if (o.installed) [dot, text, action] = ['warn', 'Not running', 'start'];
    else [dot, text, action] = ['bad', 'Not installed', 'get'];
    $('ollamaDot').className = `dot ${dot}`;
    $('ollamaText').textContent = text;
    const btn = $('ollamaAction');
    btn.classList.toggle('hidden', !action);
    btn.dataset.act = action;
    btn.disabled = false;
    btn.textContent = { start: 'Start Ollama', get: 'Get Ollama', check: 'Try again' }[action] || '';
  }

  function renderModelList() {
    $('modelEmpty').classList.toggle('hidden', app.models.length > 0 || app.ollama.state !== 'ok');
    $('modelList').innerHTML = app.models
      .map((m) => {
        if (confirmDelete === m.name) {
          return (
            `<div class="option model-opt confirm"><span class="opt-text"><span class="opt-name">Delete ${esc(m.name)}?</span>` +
            `<span class="opt-blurb">Frees ${esc(formatBytes(m.size) || 'its space')}. You can download it again later.</span></span>` +
            `<button type="button" class="btn small danger" data-del-yes="${esc(m.name)}">Delete</button>` +
            `<button type="button" class="btn small" data-del-no="1">Keep</button></div>`
          );
        }
        const selected = !!app.model && m.name === app.model.name;
        const badges = [m.vision ? `<span class="badge see">${ICONS.eye}Sees screen</span>` : '<span class="badge">Text only</span>'];
        if (m.canThink) badges.push('<span class="badge">Thinks</span>');
        if (m.cloud) badges.push('<span class="badge cloud">Cloud</span>');
        const meta = [m.params, formatBytes(m.size)].filter(Boolean).join(' · ');
        return (
          `<div class="option model-opt${selected ? ' selected' : ''}">` +
          `<button type="button" class="model-pick" data-pick="${esc(m.name)}" aria-pressed="${selected}"><span class="radio"></span>` +
          `<span class="opt-text"><span class="opt-name">${esc(m.name)}</span>` +
          `<span class="opt-blurb">${badges.join('')}<span class="opt-meta">${esc(meta)}</span></span></span></button>` +
          `<button type="button" class="icon-btn small model-del" data-del="${esc(m.name)}" title="Delete from this PC" aria-label="Delete ${esc(m.name)}">${ICONS.trash}</button></div>`
        );
      })
      .join('');
  }

  function renderSuggested() {
    const rows = app.suggested.filter((x) => !isInstalled(x.name));
    $('suggestedWrap').classList.toggle('hidden', !rows.length);
    $('suggested').innerHTML = rows
      .map(
        (x) =>
          `<div class="suggest-row"><span class="opt-text"><span class="opt-name">${esc(x.name)}` +
          `${x.name === app.recommended ? ' <span class="badge see">Recommended</span>' : ''}</span>` +
          `<span class="opt-blurb">${esc(x.blurb)} · ${esc(x.size)}</span></span>` +
          `<button type="button" class="btn small" data-get="${esc(x.name)}">Download</button></div>`,
      )
      .join('');
  }

  function renderPullBox() {
    const p = app.pull;
    $('pullBox').classList.toggle('hidden', !p);
    $('pullBtn').disabled = !!p;
    for (const b of $('suggested').querySelectorAll('button[data-get]')) b.disabled = !!p;
    if (!p) return;
    $('pullBar').style.width = `${pullPercent(p)}%`;
    $('pullText').textContent = `${p.name}: ${pullLabel(p)}`;
  }

  function renderPullStatus() {
    // A download the app started by itself has no pullMsg; show its error too.
    const msg = pullMsg || (app && app.pullError && !app.pull ? { kind: 'err', text: app.pullError.message } : null);
    setStatus($('pullStatus'), msg ? msg.kind : '', msg ? msg.text : '');
  }

  function renderPrivacy() {
    const o = app.ollama;
    let text = "Your screen is captured only when you send a message, and Buddy's own windows are hidden from it. ";
    if (app.model && app.model.cloud) {
      text += `${shortName(app.model.name)} is a cloud model, so your messages and screenshots go to ollama.com.`;
    } else if (!o.local) {
      text += `Your messages and screenshots go to the Ollama server at ${o.url}.`;
    } else {
      text += "Everything stays on this PC: screenshots go only to Ollama and aren't saved.";
    }
    $('privacy').textContent = text;
  }

  function renderSettings() {
    const s = app.settings;
    renderOllamaRow();
    if (document.activeElement !== $('ollamaUrl')) $('ollamaUrl').value = s.ollamaUrl;
    renderModelList();
    renderSuggested();
    renderPullBox();
    renderPullStatus();
    $('thinkField').classList.toggle('hidden', !(app.model && app.model.canThink));
    setSegmented($('thinkSeg'), s.think ? 'on' : 'off');
    setSegmented($('controlSeg'), s.control);
    $('controlHelp').textContent = `${CONTROL_HELP[s.control] || ''} It can't use apps that run as administrator.`;
    $('documents').checked = !!s.documents;
    $('openDocs').textContent = String(app.docsFolder || '').split(/[\\/]/).slice(-2).join('\\') || 'Documents\\Claude Buddy';
    let toolsNote = '';
    const m = app.model;
    if (m && !m.tools) {
      toolsNote = `${shortName(m.name)} can't use tools, so it can't make documents or work the PC. ${recommended().name} can.`;
    } else if (m && !m.vision && s.control !== 'off') {
      toolsNote = `${shortName(m.name)} can't see the screen, so it can make documents but not click or type.`;
    }
    setStatus($('toolsNote'), 'err', toolsNote);
    setSegmented($('detailSeg'), s.imageDetail);
    $('hotkey').value = s.hotkey || '';
    $('hotkey').placeholder = 'Click here, then press keys';
    setStatus(
      $('hotkeyStatus'),
      'err',
      s.hotkey && !app.hotkeyActive ? "This shortcut isn't active - another app may be using it. Pick another." : '',
    );
    $('showMascot').checked = !!s.showMascot;
    $('startWithWindows').checked = !!s.startWithWindows;
    renderPrivacy();
  }

  function openSettings(section) {
    closeModelMenu();
    confirmDelete = null;
    renderSettings();
    setStatus($('modelStatus'), '', '');
    setStatus($('ollamaUrlStatus'), '', '');
    sheet.classList.remove('hidden');
    const body = sheet.querySelector('.sheet-body');
    if (section === 'add') {
      setTimeout(() => {
        $('addField').scrollIntoView({ block: 'start' });
        $('pullName').focus();
      }, 30);
    } else if (section === 'models') {
      setTimeout(() => $('modelField').scrollIntoView({ block: 'start' }), 30);
    } else {
      body.scrollTop = 0;
    }
    api.refreshOllama().then(applyState); // fresh status and model list
  }

  function closeSettings() {
    sheet.classList.add('hidden');
    input.focus();
  }

  $('settingsBack').addEventListener('click', closeSettings);

  $('ollamaAction').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.act === 'start') {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      startOllama();
    } else if (btn.dataset.act === 'get') {
      api.openExternal(OLLAMA_DOWNLOAD);
    } else if (btn.dataset.act === 'check') {
      api.refreshOllama().then(applyState);
    }
  });

  async function saveOllamaUrl() {
    setStatus($('ollamaUrlStatus'), '', 'Connecting…');
    const r = await saveSettings({ ollamaUrl: $('ollamaUrl').value }, true);
    if (r && r.errors && r.errors.ollamaUrl) setStatus($('ollamaUrlStatus'), 'err', r.errors.ollamaUrl);
    else if (app.ollama.state === 'ok') setStatus($('ollamaUrlStatus'), 'ok', `Connected to Ollama ${app.ollama.version} ✓`);
    else setStatus($('ollamaUrlStatus'), 'err', `Saved, but Ollama isn't answering at ${app.ollama.url}.`);
  }

  $('ollamaUrlSave').addEventListener('click', saveOllamaUrl);
  $('ollamaUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveOllamaUrl();
  });

  $('modelList').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    const del = e.target.closest('[data-del]');
    const yes = e.target.closest('[data-del-yes]');
    if (yes) {
      deleteModel(yes.dataset.delYes);
    } else if (e.target.closest('[data-del-no]')) {
      confirmDelete = null;
      renderModelList();
    } else if (del) {
      confirmDelete = del.dataset.del;
      setStatus($('modelStatus'), '', '');
      renderModelList();
    } else if (pick) {
      confirmDelete = null;
      saveSettings({ model: pick.dataset.pick });
    }
  });

  $('pullBtn').addEventListener('click', () => {
    const name = $('pullName').value.trim();
    if (!name) {
      pullMsg = { kind: 'err', text: `Type a model name first, for example ${app.recommended}.` };
      renderPullStatus();
      $('pullName').focus();
      return;
    }
    pullModel(name);
  });
  $('pullName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('pullBtn').click();
  });
  $('pullCancel').addEventListener('click', () => api.cancelPull());
  $('suggested').addEventListener('click', (e) => {
    const b = e.target.closest('[data-get]');
    if (b) pullModel(b.dataset.get);
  });
  $('addField').addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (link) {
      e.preventDefault();
      api.openExternal(link.href);
    }
  });

  $('thinkSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) saveSettings({ think: b.dataset.v === 'on' });
  });
  $('controlSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) saveSettings({ control: b.dataset.v });
  });
  $('documents').addEventListener('change', (e) => saveSettings({ documents: e.target.checked }));
  $('openDocs').addEventListener('click', () => api.openDocsFolder());
  $('detailSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) saveSettings({ imageDetail: b.dataset.v });
  });
  $('showMascot').addEventListener('change', (e) => saveSettings({ showMascot: e.target.checked }));
  $('startWithWindows').addEventListener('change', (e) => saveSettings({ startWithWindows: e.target.checked }));

  // Shortcut recorder: turns a key press into an Electron accelerator.
  const hotkeyEl = $('hotkey');
  const KEY_NAMES = {
    Space: 'Space',
    Enter: 'Enter',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
  };

  function acceleratorKey(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
    return KEY_NAMES[code] || null;
  }

  hotkeyEl.addEventListener('focus', () => {
    hotkeyEl.classList.add('recording');
    hotkeyEl.placeholder = 'Press a key combination…';
  });
  hotkeyEl.addEventListener('blur', () => {
    hotkeyEl.classList.remove('recording');
    hotkeyEl.placeholder = 'Click here, then press keys';
  });
  hotkeyEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      hotkeyEl.blur();
      return;
    }
    let accel = '';
    if (e.key === 'Backspace' || e.key === 'Delete') {
      accel = '';
    } else {
      const key = acceleratorKey(e.code);
      if (!key) return; // only modifiers so far
      const mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      if (!mods.length && !/^F\d+$/.test(key)) {
        setStatus($('hotkeyStatus'), 'err', 'Add Ctrl, Alt or Shift to the key.');
        return;
      }
      accel = [...mods, key].join('+');
    }
    hotkeyEl.value = accel;
    const r = await saveSettings({ hotkey: accel }, true);
    if (r && r.errors && r.errors.hotkey) {
      setStatus($('hotkeyStatus'), 'err', r.errors.hotkey);
      hotkeyEl.value = app.settings.hotkey || '';
    } else {
      setStatus($('hotkeyStatus'), 'ok', accel ? `Saved. Press ${accel} anywhere to open the chat.` : 'Shortcut turned off.');
    }
    hotkeyEl.blur();
  });

  // ---------------------------------------------------------- keyboard

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!lightbox.classList.contains('hidden')) closeLightbox();
      else if (!modelMenu.classList.contains('hidden')) closeModelMenu();
      else if (confirmDelete) {
        confirmDelete = null;
        renderModelList();
      } else if (!sheet.classList.contains('hidden')) closeSettings();
      else api.hide();
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      api.newChat();
    }
  });

  // ---------------------------------------------------------- the character

  function drawLogo() {
    const c = $('logo');
    const dpr = window.devicePixelRatio || 1;
    const P = Math.max(1, Math.round(1.5 * dpr));
    c.width = S.W * P;
    c.height = S.H * P;
    c.style.width = `${c.width / dpr}px`;
    c.style.height = `${c.height / dpr}px`;
    S.draw(c.getContext('2d'), 0, 0, P, {});
  }

  const hero = $('hero');
  const hctx = hero.getContext('2d');
  const mouse = { x: -9999, y: -9999 };
  const heroLook = { x: 0, y: 0 };
  let heroBlinkAt = performance.now() + 1800;
  let heroBlinkStart = -1;
  document.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  function drawHero(t) {
    requestAnimationFrame(drawHero);
    if (welcome.classList.contains('hidden') || document.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = 132;
    const cssH = 92;
    if (hero.width !== Math.round(cssW * dpr)) {
      hero.width = Math.round(cssW * dpr);
      hero.height = Math.round(cssH * dpr);
      hero.style.width = `${cssW}px`;
      hero.style.height = `${cssH}px`;
    }
    const P = Math.max(1, Math.round(7 * dpr));
    const w = S.W * P;
    const hh = S.H * P;
    const ox = Math.round((hero.width - w) / 2);
    const wave = Math.sin((t / 1000) * Math.PI * 2 * 0.45);
    const top = Math.round((hero.height - hh) / 2 - 6 * dpr);
    const oy = top + Math.round(wave * 3 * dpr);

    hctx.clearRect(0, 0, hero.width, hero.height);
    hctx.fillStyle = `rgba(0, 0, 0, ${0.12 - (wave + 1) * 0.02})`;
    hctx.beginPath();
    hctx.ellipse(hero.width / 2, top + hh + 9 * dpr, w * (0.38 - (wave + 1) * 0.02), 3.5 * dpr, 0, 0, Math.PI * 2);
    hctx.fill();

    const r = hero.getBoundingClientRect();
    const dx = mouse.x - (r.left + r.width / 2);
    const dy = mouse.y - (r.top + (oy + 3 * P) / dpr);
    const dist = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, dist / 160);
    heroLook.x += ((dx / dist) * k - heroLook.x) * 0.25;
    heroLook.y += ((dy / dist) * k - heroLook.y) * 0.25;

    if (t > heroBlinkAt) {
      heroBlinkStart = t;
      heroBlinkAt = t + 2400 + Math.random() * 3600;
    }
    const bt = t - heroBlinkStart;
    const blink = heroBlinkStart >= 0 && bt < 160 ? Math.sin((bt / 160) * Math.PI) : 0;

    S.draw(hctx, ox, oy, P, { lookX: heroLook.x, lookY: heroLook.y, blink });
  }

  // ---------------------------------------------------------- startup

  function applyState(s) {
    if (!s) return;
    app = s;
    includeScreen = !!s.settings.includeScreen;
    renderScreenToggle();
    renderModelChip();
    renderSetup();
    const canAct = !!(s.model && s.model.tools && s.model.vision && s.settings.control !== 'off');
    $('welcomeSub').textContent = !modelSees()
      ? "Ask me anything. This model can't see your screen."
      : canAct
        ? 'I can see your screen, write documents, and click or type for you.'
        : 'I take a look at your screen each time you send a message.';
    renderHotkeyHint();
    if (!sheet.classList.contains('hidden')) renderSettings();
    if (!modelMenu.classList.contains('hidden')) renderModelMenu();
  }

  function renderHotkeyHint() {
    const el = $('hotkeyHint');
    const keys = app.hotkeyActive && app.settings.hotkey ? app.settings.hotkey.split('+') : [];
    el.classList.toggle('hidden', !keys.length);
    if (!keys.length) return;
    el.replaceChildren('Tip: press ');
    keys.forEach((k, i) => {
      if (i) el.append('+');
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      el.append(kbd);
    });
    el.append(' from any app to open me.');
  }

  api.on('chat:event', onEvent);
  api.on('settings:changed', applyState);
  api.on('models:progress', (p) => {
    if (!app) return;
    app.pull = p;
    renderSetup();
    if (!sheet.classList.contains('hidden')) renderPullBox();
  });
  api.on('chat:shown', (d) => {
    if (d && d.openSettings) openSettings();
    else if (sheet.classList.contains('hidden')) input.focus();
  });

  window.addEventListener('resize', drawLogo);

  (async () => {
    drawLogo();
    applyState(await api.init());
    setBusy(false);
    autosize();
    requestAnimationFrame(drawHero);
    input.focus();
  })();
})();
