'use strict';
// TrixFTP - Electron main process: window, sessions, IPC glue.
const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./lib/store');
const { Queue } = require('./lib/queue');
const { FtpEngine } = require('./lib/ftp');
const { SftpEngine } = require('./lib/sftp');
const updater = require('./lib/updater');
const local = require('./lib/local');

const isDev = process.argv.includes('--dev');
let win = null;
const sessions = new Map(); // sid -> engine
const pendingAsks = new Map(); // ask token -> reply callback
const transientSessions = new Set(); // auto-opened transfer sessions
const transientTimers = new Map();   // engineId -> idle-close timer
const spawning = new Map();          // "host|user|proto" -> Promise<engine> (connect dedupe)

async function spawnSession(cfg) {
  const hooks = makeHooks();
  const engine = cfg.proto === 'sftp' ? new SftpEngine(cfg, hooks) : new FtpEngine(cfg, hooks);
  hooks.onClose = () => {
    sessions.delete(engine.id);
    transientSessions.delete(engine.id);
    broadcast('session:closed', { sid: engine.id });
    queue.sessionDown(engine.id);
  };
  await engine.init();
  sessions.set(engine.id, engine);
  return engine;
}

// live session for the same host+user+proto (tab session or previous transient)
function findLiveMetaSession(meta) {
  if (!meta || !meta.host) return null;
  for (const s of sessions.values()) {
    if (!s.isConn() || !s.cfg) continue;
    if (s.cfg.host === meta.host &&
        ((s.cfg.user || 'anonymous') === (meta.user || 'anonymous')) &&
        ((s.cfg.proto || 'ftp') === (meta.proto || 'ftp'))) return s;
  }
  return null;
}

// schedule closing of an auto-opened transfer session when it sits idle
function scheduleTransientClose(engineId, delayMs = 90000) {
  if (!transientSessions.has(engineId)) return;
  clearTimeout(transientTimers.get(engineId));
  transientTimers.set(engineId, setTimeout(function recheck() {
    if (!transientSessions.has(engineId)) return;
    if (queue.isBusy()) { scheduleTransientClose(engineId); return; }   // still transferring
    const s = sessions.get(engineId);
    if (s) { try { s.close(); } catch (e) { } sessions.delete(engineId); }
    transientSessions.delete(engineId);
    transientTimers.delete(engineId);
  }, delayMs));
}

const queue = new Queue({
  getSession: (sid) => sessions.get(sid) || null,
  // resolve a usable session for a job: reuse a live one for the same host
  // or AUTO-RECONNECT using the stored connection parameters
  ensureSession: async (j) => {
    let s = findLiveMetaSession(j.meta);
    if (!s) {
      const ref = sessions.get(j.sid);
      if (ref && ref.isConn()) s = ref;
    }
    if (s) return s;
    if (!(j.meta && j.meta.cfg)) return null;
    // share a single in-flight connect between parallel jobs for the same host
    const key = j.meta.host + '|' + (j.meta.user || 'anonymous') + '|' + (j.meta.proto || 'ftp');
    if (!spawning.has(key)) {
      spawning.set(key, spawnSession(j.meta.cfg).finally(() => spawning.delete(key)));
    }
    const engine = await spawning.get(key);
    if (!transientSessions.has(engine.id)) {
      transientSessions.add(engine.id);
      scheduleTransientClose(engine.id);
    }
    return engine;
  },
  touch: (engineId) => { if (transientSessions.has(engineId)) scheduleTransientClose(engineId); },
  settings: () => store.getSettings(),
  log: (level, msg) => broadcast('app:log', { level, msg }),
  emit: (ev) => {
    // rewrite 'ask' events: attach a token, keep the reply callback on the main side
    if (ev && ev.type === 'ask') {
      const token = 'a' + Math.random().toString(36).slice(2);
      const { reply, ...safe } = ev;
      pendingAsks.set(token, reply);
      broadcast('queue:event', { ...safe, token });
    } else {
      broadcast('queue:event', ev);
    }
  },
  listLocal: local.listDir,
  statLocal: local.statPath,
  ensureLocalDir: local.ensureDir,
  utimesLocal: async (p, s) => fs.promises.utimes(p, s, s)
});

const store = new Store(path.join(app.getPath('userData'), 'trixftp.json'));

function broadcast(chan, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(chan, payload);
}

// ---------- memory watchdog: log counters when the heap grows ----------
setInterval(() => {
  const m = process.memoryUsage();
  const heapMB = Math.round(m.heapUsed / 1048576);
  if (heapMB < 800) return;
  console.log(`[memwatch] heap=${heapMB}MB rss=${Math.round(m.rss / 1048576)}MB` +
    ` jobs=${queue.jobs.length} active=${queue.activeCount()}` +
    ` sessions=${sessions.size} asks=${pendingAsks.size}` +
    ` transient=${transientSessions.size} spawning=${spawning.size}`);
  const busy = queue.jobs.filter(j => j.state === 'active' || j.state === 'queued').slice(0, 10)
    .map(j => `${j.id}:${j.state}:${j.name}:${j.bytes}/${j.size}:${j.sid}`);
  if (busy.length) console.log('[memwatch] busy: ' + busy.join(' | '));
}, 20000);

process.on('uncaughtException', (err) => {
  console.error('[main uncaught]', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[main unhandled]', err && (err.stack || err.message || err));
});

// ---------- single instance & boot ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => createWindow()).then(scheduleUpdateChecks);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 960, minHeight: 640,
    title: 'TrixFTP',
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    icon: fs.existsSync(path.join(__dirname, 'build', 'icon.png'))
      ? path.join(__dirname, 'build', 'icon.png')
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  if (process.argv.some(a => a === '--devtools')) win.webContents.openDevTools({ mode: 'detach' });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('console-message', (e, level, message) => {
    const msg = message ?? (e && e.message);
    if (msg && /error|failed|exception|cannot/i.test(String(msg))) {
      console.log(`[renderer] ${msg}`);
    }
  });
  win.webContents.on('preload-error', (e, p, err) => {
    console.error('[preload error]', p, err);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    console.error('[renderer gone]', details.reason);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file:')) return { action: 'deny' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  if (isDev) console.log('TrixFTP window created');
}

// safeStorage for stored passwords
store.encrypt = (s) => safeStorage.encryptString(s);
store.decrypt = (b) => safeStorage.decryptString(b);
store.load();

// ---------- IPC: store ----------
ipcMain.handle('store:getAll', () => ({
  sites: store.sitesForUi(),
  settings: store.getSettings(),
  safeKeysAvailable: safeStorage.isEncryptionAvailable(),
  platform: process.platform,
  sep: path.sep,
  isWin: process.platform === 'win32'
}));
ipcMain.handle('store:siteForConnect', (e, id) => store.siteForConnect(id));
ipcMain.handle('store:saveSite', (e, site) => {
  const rec = { ...site };
  // empty password + existing stored one = keep; explicit '********' masked input = keep
  if (rec.pwd === '********') delete rec.pwd;
  rec.pwd = store.encodePwd(rec.pwd || '');
  store.upsertSite(rec);
  return store.sitesForUi();
});
ipcMain.handle('store:deleteSite', (e, id) => { store.deleteSite(id); return store.sitesForUi(); });
ipcMain.handle('store:setSettings', (e, patch) => {
  const s = store.setSettings(patch);
  broadcast('app:settings', s);
  return s;
});

// ---------- IPC: local FS ----------
ipcMain.handle('fs:list', async (e, dir) => {
  try { return { ok: true, items: await local.listDir(dir) }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('fs:stat', async (e, p) => local.statPath(p));
ipcMain.handle('fs:mkdir', async (e, p) => { await local.ensureDir(p); return { ok: true }; });
ipcMain.handle('fs:touch', async (e, p) => { await local.writeEmpty(p); return { ok: true }; });
ipcMain.handle('fs:remove', async (e, { path: p, isDir }) => {
  if (isDir) await local.rmrf(p); else await fs.promises.rm(p, { force: true });
  return { ok: true };
});
ipcMain.handle('fs:rename', async (e, { from, to }) => { await local.rename(from, to); return { ok: true }; });
ipcMain.handle('fs:copy', async (e, { srcs, dstDir }) => {
  for (const src of srcs) {
    const base = path.basename(src);
    const dst = path.join(dstDir, base);
    try {
      await fs.promises.cp(src, dst, { recursive: true, force: false, errorOnExist: true });
    } catch (err) {
      return { ok: false, error: `Cannot copy ${base}: ${err.message}` };
    }
  }
  return { ok: true };
});
ipcMain.handle('fs:drives', async () => process.platform === 'win32' ? local.listDrives() : []);
ipcMain.handle('fs:home', () => app.getPath('home'));
ipcMain.handle('fs:downloads', () => app.getPath('downloads'));
ipcMain.handle('fs:desktop', () => app.getPath('desktop'));
ipcMain.handle('fs:documents', () => app.getPath('documents'));

// ---------- IPC: shell ----------
ipcMain.handle('shell:open', async (e, p) => {
  const res = await shell.openPath(p);
  if (res) throw new Error(res);
  return { ok: true };
});
ipcMain.handle('shell:reveal', (e, p) => { shell.showItemInFolder(p); return { ok: true }; });

// ---------- IPC: sessions ----------
function makeHooks(cfgText) {
  return {
    log: (level, msg) => broadcast('app:log', { level, msg }),
    settings: () => store.getSettings(),
    onClose: () => { /* handled per session below */ }
  };
}

ipcMain.handle('session:connect', async (e, cfg) => {
  const hooks = makeHooks();
  let engine;
  if (cfg.proto === 'sftp') engine = new SftpEngine(cfg, hooks);
  else engine = new FtpEngine(cfg, hooks);
  hooks.onClose = () => {
    sessions.delete(engine.id);
    broadcast('session:closed', { sid: engine.id });
    queue.sessionDown(engine.id);
  };
  await engine.init();
  sessions.set(engine.id, engine);
  return { ok: true, sid: engine.id, type: engine.type, cwd: await engine.getwd() };
});

ipcMain.handle('session:close', async (e, sid) => {
  const s = sessions.get(sid);
  if (s) { await s.close(); sessions.delete(sid); }
  return { ok: true };
});

ipcMain.handle('session:call', async (e, { sid, cmd, args = [] }) => {
  const s = sessions.get(sid);
  if (!s) throw new Error('session not found');
  const map = {
    list: () => s.list(args[0]),
    stat: () => s.stat(args[0]),
    mkdir: () => s.mkdirp(args[0]),
    remove: () => s.remove(args[0], args[1]),
    rename: () => s.rename(args[0], args[1]),
    chmod: () => s.chmod(args[0], args[1]),
    touch: () => createEmptyRemote(s, args[0]),
    times: () => s.setTimes(args[0], args[1]),
    command: () => s.execLine(args[0]),
    pwd: () => s.getwd()
  };
  const fn = map[cmd];
  if (!fn) throw new Error('unknown call: ' + cmd);
  return await fn();
});

async function createEmptyRemote(s, p) {
  if (s.type === 'sftp') {
    await s.cb(fn => s.sftp.writeFile(p, '', fn));
  } else {
    // create an empty remote file via STOR of empty content
    const { Readable } = require('stream');
    await s.client.uploadFrom(Readable.from([]), p);
  }
}

// ---------- IPC: queue ----------
ipcMain.handle('queue:add', (e, specs) => {
  // attach reconnect info (host/user/full cfg) captured from the live session
  for (const s of specs || []) {
    const eng = sessions.get(s.sid);
    if (eng && eng.cfg) {
      s.meta = {
        host: eng.cfg.host, user: eng.cfg.user || 'anonymous', proto: eng.cfg.proto || 'ftp',
        cfg: { ...eng.cfg }
      };
    }
  }
  return queue.add(specs);
});
ipcMain.handle('queue:pause', (e, id) => queue.pause(id));
ipcMain.handle('queue:resume', (e, id) => queue.resumeJob(id));
ipcMain.handle('queue:pauseAll', () => queue.pauseAll());
ipcMain.handle('queue:resumeAll', () => queue.resumeAll());
ipcMain.handle('queue:cancel', (e, id) => queue.cancel(id));
ipcMain.handle('queue:retry', (e, id) => queue.retry(id));
ipcMain.handle('queue:clear', (e, force) => queue.clear(!!force));
ipcMain.handle('queue:clearTerminal', () => queue.clearTerminal());

// conflict answers from renderer
ipcMain.handle('queue:answer', (e, { token, action, applyAll, newDst }) => {
  const cb = pendingAsks.get(token);
  if (cb) { pendingAsks.delete(token); cb({ action, applyAll, newDst }); }
  return { ok: true };
});

// ---------- IPC: misc ----------
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

// ---------- IPC: app auto-update ----------
// Check: GitHub Releases -> newer tag?  Download: right installer asset.
// Install: run it (Windows silently) and exit; macOS: mount the dmg.
let updateState = { ver: null, file: null, busy: false };

function updateSend(ev) { broadcast('update:event', ev); }

async function updaterCheck(manual) {
  try {
    const rel = await updater.fetchLatest();
    const current = app.getVersion();
    const asset = updater.isNewer(rel.tag_name, current)
      ? updater.pickAsset(rel, process.platform, process.arch) : null;
    const res = {
      available: !!asset,
      current,
      version: asset ? rel.tag_name.replace(/^v/, '') : null,
      release: rel.name || rel.tag_name,
      url: rel.html_url,
      asset: asset ? asset.name : null
    };
    if (asset) updateState.ver = res.version;
    if (manual || (asset && win)) updateSend({ type: res.available ? 'available' : 'none' });
    return res;
  } catch (err) {
    if (manual) updateSend({ type: 'error', error: String(err.message || err) });
    return { available: false, error: String(err.message || err) };
  }
}

ipcMain.handle('update:check', () => updaterCheck(true));

ipcMain.handle('update:download', async () => {
  if (updateState.busy) return { ok: false, error: 'busy' };
  try {
    updateState.busy = true;
    const rel = await updater.fetchLatest();
    const asset = updater.isNewer(rel.tag_name, app.getVersion())
      ? updater.pickAsset(rel, process.platform, process.arch) : null;
    if (!asset) throw new Error('No matching installer in the latest release');
    const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'trixftp-update-'));
    const dest = path.join(dir, asset.name.replace(/[^\w.()-]+/g, '_'));
    await updater.downloadFile(asset.browser_download_url, dest, (pct) => {
      if (pct >= 0) updateSend({ type: 'progress', pct: pct });
    });
    updateState.file = dest;
    updateState.busy = false;
    updateSend({ type: 'ready', file: dest });
    return { ok: true, file: dest };
  } catch (err) {
    updateState.busy = false;
    updateSend({ type: 'error', error: String(err.message || err) });
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('update:install', async () => {
  const f = updateState.file;
  if (!f || !fs.existsSync(f)) return { ok: false, error: 'Nothing downloaded yet' };
  try {
    if (process.platform === 'win32') {
      // NSIS one-click installer; /S = silent in-place upgrade
      const child = require('child_process').spawn(f, ['/S'], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => app.exit(0), 600);
      updateSend({ type: 'installing' });
      return { ok: true, mode: 'silent' };
    }
    if (process.platform === 'linux') {
      fs.chmodSync(f, 0o755);
      const child = require('child_process').spawn(f, [], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => app.exit(0), 600);
      updateSend({ type: 'installing' });
      return { ok: true, mode: 'replace' };
    }
    // macOS: mount the dmg and let the user drag the app
    shell.openPath(f);
    updateSend({ type: 'installing' });
    return { ok: true, mode: 'dmg' };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('update:reveal', async () => {
  if (updateState.file && fs.existsSync(updateState.file)) {
    shell.showItemInFolder(updateState.file);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('update:openPage', () => { shell.openExternal('https://github.com/' + updater.REPO + '/releases/latest'); return { ok: true }; });

// silent checks: shortly after start, then every 6 h
let updateTimerStarted = false;
function scheduleUpdateChecks() {
  if (updateTimerStarted) return;
  updateTimerStarted = true;
  setTimeout(updaterCheck, 12000);
  setInterval(() => { if (win && !win.isDestroyed()) updaterCheck(); }, 6 * 60 * 60 * 1000);
}

ipcMain.handle('dialog:message', (e, opts) => dialog.showMessageBox(win, opts));

app.on('window-all-closed', () => {
  try { queue.clear(true); } catch (e) { }
  for (const s of sessions.values()) { try { s.close(); } catch (e) { } }
  app.quit();
});
