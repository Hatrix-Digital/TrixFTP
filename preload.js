'use strict';
// Preload: secure bridge between renderer and main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Map();

function on(chan, cb) {
  const key = chan + ':' + Math.random().toString(36).slice(2);
  const handler = (e, payload) => cb(payload);
  listeners.set(key, { chan, handler });
  ipcRenderer.on(chan, handler);
  return () => { ipcRenderer.off(chan, handler); listeners.delete(key); };
}

contextBridge.exposeInMainWorld('trix', {
  // store
  getAll: () => ipcRenderer.invoke('store:getAll'),
  siteForConnect: (id) => ipcRenderer.invoke('store:siteForConnect', id),
  saveSite: (site) => ipcRenderer.invoke('store:saveSite', site),
  deleteSite: (id) => ipcRenderer.invoke('store:deleteSite', id),
  setSettings: (patch) => ipcRenderer.invoke('store:setSettings', patch),

  // local fs
  fsList: (dir) => ipcRenderer.invoke('fs:list', dir),
  fsStat: (p) => ipcRenderer.invoke('fs:stat', p),
  fsMkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
  fsTouch: (p) => ipcRenderer.invoke('fs:touch', p),
  fsRemove: (path, isDir) => ipcRenderer.invoke('fs:remove', { path, isDir }),
  fsRename: (from, to) => ipcRenderer.invoke('fs:rename', { from, to }),
  fsCopy: (srcs, dstDir) => ipcRenderer.invoke('fs:copy', { srcs, dstDir }),
  fsDrives: () => ipcRenderer.invoke('fs:drives'),
  userDirs: () => Promise.all([
    ipcRenderer.invoke('fs:home'),
    ipcRenderer.invoke('fs:downloads'),
    ipcRenderer.invoke('fs:desktop'),
    ipcRenderer.invoke('fs:documents')
  ]).then(([home, downloads, desktop, documents]) => ({ home, downloads, desktop, documents })),

  // shell
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  revealPath: (p) => ipcRenderer.invoke('shell:reveal', p),

  // sessions
  connect: (cfg) => ipcRenderer.invoke('session:connect', cfg),
  disconnect: (sid) => ipcRenderer.invoke('session:close', sid),
  call: (sid, cmd, args) => ipcRenderer.invoke('session:call', { sid, cmd, args }),

  // queue
  queueAdd: (specs) => ipcRenderer.invoke('queue:add', specs),
  queuePause: (id) => ipcRenderer.invoke('queue:pause', id),
  queueResume: (id) => ipcRenderer.invoke('queue:resume', id),
  queuePauseAll: () => ipcRenderer.invoke('queue:pauseAll'),
  queueResumeAll: () => ipcRenderer.invoke('queue:resumeAll'),
  queueCancel: (id) => ipcRenderer.invoke('queue:cancel', id),
  queueRetry: (id) => ipcRenderer.invoke('queue:retry', id),
  queueClear: (force) => ipcRenderer.invoke('queue:clear', force),
  queueClearTerminal: () => ipcRenderer.invoke('queue:clearTerminal'),
  answer: (payload) => ipcRenderer.invoke('queue:answer', payload),

  // events
  onLog: (cb) => on('app:log', cb),
  onSettings: (cb) => on('app:settings', cb),
  onQueueEvent: (cb) => on('queue:event', cb),
  onSessionClosed: (cb) => on('session:closed', cb),
  info: () => ipcRenderer.invoke('app:info'),

  // drag&drop: resolve real OS paths of dropped File objects (renderer -> preload -> main)
  dropPaths: (files) => {
    const out = [];
    for (const f of files) {
      try { out.push(webUtils.getPathForFile(f)); } catch (e) { }
    }
    return out;
  }
});
