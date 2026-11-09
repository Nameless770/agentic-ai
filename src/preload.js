'use strict';

// The only bridge between the web pages and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'mascot:state',
  'mascot:cursor',
  'mascot:drag',
  'chat:event',
  'chat:shown',
  'settings:changed',
  'models:progress',
]);

contextBridge.exposeInMainWorld('buddy', {
  // floating mascot
  pointerDown: () => ipcRenderer.send('mascot:pointer-down'),
  pointerUp: () => ipcRenderer.send('mascot:pointer-up'),
  openMenu: () => ipcRenderer.send('mascot:menu'),
  setHit: (inside) => ipcRenderer.send('mascot:hit', !!inside),

  // chat window
  init: () => ipcRenderer.invoke('chat:init'),
  send: (args) => ipcRenderer.invoke('chat:send', args),
  stop: () => ipcRenderer.send('chat:stop'),
  retry: (turnId) => ipcRenderer.invoke('chat:retry', turnId),
  newChat: () => ipcRenderer.invoke('chat:new'),
  getShot: (turnId) => ipcRenderer.invoke('chat:get-shot', turnId),
  hide: () => ipcRenderer.send('chat:hide'),
  copy: (text) => ipcRenderer.send('chat:copy', String(text)),
  openExternal: (url) => ipcRenderer.send('chat:open-external', String(url)),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  // actions and documents
  approve: (id, decision) => ipcRenderer.send('chat:approve', Number(id), String(decision)),
  openFile: (file, how) => ipcRenderer.invoke('chat:open-file', String(file), how === 'folder' ? 'folder' : 'open'),
  openDocsFolder: () => ipcRenderer.send('docs:open-folder'),

  // Ollama and models
  refreshOllama: () => ipcRenderer.invoke('ollama:refresh'),
  startOllama: () => ipcRenderer.invoke('ollama:start'),
  pullModel: (name) => ipcRenderer.invoke('models:pull', String(name)),
  cancelPull: () => ipcRenderer.send('models:cancel-pull'),
  deleteModel: (name) => ipcRenderer.invoke('models:delete', String(name)),

  on: (channel, fn) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    const listener = (_e, data) => fn(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
