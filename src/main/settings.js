'use strict';

// Persistent settings, stored as JSON in the app's user-data folder.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  model: null, // Ollama model name, e.g. "qwen3.5:4b" (null: pick an installed one automatically)
  think: false, // let models that can "think" reason before answering (slower)
  autoDownload: true, // no model installed? fetch the recommended one when the chat opens (off after a cancel)
  control: 'ask', // control the mouse and keyboard: off | ask (approve each action) | auto
  documents: true, // let the model save documents in Documents\Claude Buddy
  imageDetail: 'high', // high | low
  includeScreen: true,
  ollamaUrl: 'http://127.0.0.1:11434',
  hotkey: null, // null = pick a free one automatically, '' = off
  hotkeyAuto: true, // false once the user records their own shortcut
  showMascot: true,
  mascotPos: null, // { x, y }
  chatSize: null, // { width, height }
};

let data = { ...DEFAULTS };
let file = null;
let saveTimer = null;

function load() {
  file = path.join(app.getPath('userData'), 'settings.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  // The first version of the app used Claude models through Anthropic's API.
  if (typeof data.model !== 'string' || /^claude-/.test(data.model)) data.model = null;
  if (typeof data.ollamaUrl !== 'string' || !data.ollamaUrl) data.ollamaUrl = DEFAULTS.ollamaUrl;
  return data;
}

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[settings] could not save:', err);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 250);
}

function get(key) {
  return data[key];
}

function set(patch) {
  Object.assign(data, patch);
  scheduleSave();
}

module.exports = { DEFAULTS, load, get, set, writeNow };
