'use strict';
// TrixFTP main renderer controller: tabs, dual panes, queue, dialogs, events.
(function () {
  const T = window.trix;
  const ui = window.ui;
  const { FilePane } = window;

  let settings = {};
  const tabs = []; // {id, sid, connected, title, proto, host, user, cwd, items[], sel, history, filter}
  let activeTabId = null;
  let panes = {};
  let queueRows = new Map(); // id -> {job, el}
  let speedRing = new Map(); // id -> [{t, bytes}]
  let compareMode = false;

  const el = (id) => document.getElementById(id);

  // ================= boot =================
  async function boot() {
    try { await bootInner(); }
    catch (err) {
      console.error('boot failed:', err);
      try { appendLog('error', 'Startup error: ' + (err.stack || err.message || err)); } catch (e) { }
    }
  }

  async function bootInner() {
    const store = await T.getAll();
    settings = store.settings || {};
    window.__isWin = store.isWin;
    window.__sep = store.sep;
    window.__plat = store.platform;

    panes.local = new FilePane(el('paneLocal'), 'local', paneHooks());
    panes.remote = new FilePane(el('paneRemote'), 'remote', paneHooks());

    const dirs = await T.userDirs();
    window.__dirs = dirs;
    panes.local.setPath(dirs.home);
    navigate('local', dirs.home);

    const drives = await T.fsDrives();
    const drv = el('localDrives');
    if (!window.__isWin) {
      // On Linux/macOS hide the Windows drive selector
      drv.style.display = 'none';
      if (!drives.length) {
        const o = document.createElement('option');
        o.value = '/'; o.textContent = '/';
        drv.appendChild(o);
      }
    }
    drv.innerHTML = '';
    for (const d of drives) {
      const o = document.createElement('option');
      o.value = d + (window.__isWin ? '\\' : ''); o.textContent = d;
      drv.appendChild(o);
    }
    drv.addEventListener('change', () => navigate('local', drv.value));

    createTab(); // initial remote tab (disconnected)
    wireToolbar();
    wireDock();
    bindGlobalKeys();
    bindDndBookkeeping();
    bindQueueSettings();
    wireUpdater();

    T.onLog(({ level, msg }) => logLine(level, msg));
    T.onSessionClosed(({ sid }) => {
      const t = tabs.find(x => x.sid === sid);
      if (t) { t.connected = false; t.sid = null; renderTabs(); updateRemoteHeader(); logLine('warn', 'Session ended (' + t.title + ')'); }
    });
    T.onQueueEvent(onQueueEvent);
    T.onSettings((s) => { settings = s; el('setMaxParallel').value = String(s.maxParallel); el('setSpeedLimit').value = String(s.speedLimit); });

    // apply saved queue settings to UI
    el('setMaxParallel').value = String(settings.maxParallel ?? 2);
    el('setSpeedLimit').value = String(settings.speedLimit ?? 0);

    logLine('sys', 'TrixFTP ' + ((await T.info()).version) + ' ready — Quick Connect above or Site Manager (F8).');
    splitterInit();
  }

  function paneHooks() {
    return {
      navigate,
      runAction,
      onSelection: () => setStatus(),
      onSort: () => { },
      dragOver: onDragOver,
      dropOn: onDropOn
    };
  }

  // ================= navigation =================
  async function navigate(side, path, opts = {}) {
    const pane = side === 'local' ? panes.local : panes.remote;
    if (!path) return;
    let p = String(path).trim();
    if (side === 'local') {
      if (window.__isWin) {
        p = p.replace(/\//g, '\\').trim();
        if (/^[a-zA-Z]:$/.test(p)) p += '\\';
        p = p.replace(/[\\]+$/, '\\');           // collapse trailing backslashes
        if (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1);
      } else {
        p = p.trim();
        if (!p.startsWith('/')) p = '/' + p;
        p = p.replace(/\/{2,}/g, '/');
      }
    } else {
      if (activeTab() && !activeTab().connected) { ui.toast('Not connected', 'err'); return; }
      p = ('/' + p).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    }
    try {
      if (side === 'local') {
        const r = await T.fsList(p === '' ? (window.__dirs ? window.__dirs.home : p) : p);
        if (!r.ok) throw new Error(r.error);
        pane.setPath(p === '' ? 'Home' : p);
        pane.setItems(r.items || []);
        const drvSel = el('localDrives');
        if (drvSel && /^[a-zA-Z]:/.test(p)) {
          const want = p.slice(0, 2) + ':';
          if ([...drvSel.options].some(o => o.value === want + '\\')) drvSel.value = want + '\\';
        }
        setStatus();
      } else {
        const t = activeTab();
        if (!t || !t.sid) return;
        const items = await T.call(t.sid, 'list', [p === '/' ? '/' : p]);
        pane.setPath(p);
        pane.setItems(items);
        t.cwd = p; t.items = items; t.sel = [...pane.selected];
        const pwd = await T.call(t.sid, 'pwd', []);
        t.serverCwd = pwd;
        updateRemoteHeader();
        setStatus();
      }
    } catch (e) {
      log('error', 'List "' + p + '": ' + (e.message || e));
      if (side === 'local') { ui.toast('Cannot open: ' + p, 'err'); }
    }
  }

  function updateRemoteHeader() {
    const t = activeTab();
    if (!t || !t.connected) {
      el('remoteTitle').textContent = 'Remote — not connected';
      el('remotePath').value = '';
      return;
    }
    el('remoteTitle').textContent = `Remote — ${t.title}`;
  }

  // ================= tabs =================
  function createTab() {
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    tabs.push({ id, sid: null, connected: false, title: 'Remote ' + (tabs.length + 1), proto: '', host: '', user: '', cwd: '/', items: [], sel: [] });
    activeTabId = id;
    renderTabs();
    updateRemoteHeader();
    return tabs[tabs.length - 1];
  }
  function closeTab(id) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const t = tabs[i];
    if (t.sid) T.disconnect(t.sid);
    tabs.splice(i, 1);
    if (activeTabId === id) {
      activeTabId = tabs.length ? tabs[Math.max(0, i - 1)].id : null;
      if (!tabs.length) createTab();
    }
    renderTabs();
    activateTab(activeTabId);
  }
  function activeTab() { return tabs.find(t => t.id === activeTabId) || null; }
  function activateTab(id) {
    const t = tabs.find(x => x.id === id);
    if (!t) return;
    activeTabId = id;
    // restore tab's listing into remote pane
    const pane = panes.remote;
    if (t.connected && t.items) {
      pane.setPath(t.cwd || '/');
      pane.setItems(t.items);
      pane.selected = new Set(t.sel || []);
      pane.render();
    } else {
      pane.setPath('');
      pane.setItems([]);
      showRemoteEmpty();
    }
    renderTabs();
    updateRemoteHeader();
  }
  function showRemoteEmpty() {
    const list = el('remoteList');
    list.classList.add('empty');
    if (!list.querySelector('.empty-msg')) {
      const m = document.createElement('div');
      m.className = 'empty-msg';
      m.innerHTML = '<div class="empty-title">No connection</div><div>Use Quick Connect or Site Manager (F8)</div>';
      list.appendChild(m);
    }
  }
  function renderTabs() {
    const ul = el('tabList');
    [...ul.querySelectorAll('li:not(.plus)')].forEach(li => li.remove());
    for (const t of tabs) {
      const li = document.createElement('li');
      li.className = t.connected ? (activeTabId === t.id ? 'active' : '') : (activeTabId === t.id ? 'active disconnected' : 'disconnected');
      const dot = document.createElement('span'); dot.className = 'dot'; li.appendChild(dot);
      const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = t.title; li.appendChild(tt);
      const pr = document.createElement('span'); pr.className = 'protocol'; pr.textContent = t.proto.toUpperCase() || '·'; li.appendChild(pr);
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      li.appendChild(x);
      li.title = t.connected ? `Connected to ${t.host} as ${t.user} — ${t.cwd}` : 'Disconnected';
      // mousedown activates the tab, but never when clicking the close "x"
      li.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('x') || e.button === 1) { e.stopPropagation(); return; }
        activateTab(t.id);
      });
      // middle click closes
      li.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(t.id); }
      });
      // close "x" reacts on mousedown (survives re-render) and click
      const kill = (e) => { e.preventDefault(); e.stopPropagation(); closeTab(t.id); };
      x.addEventListener('mousedown', kill);
      x.addEventListener('click', kill);
      el('tabList').insertBefore(li, el('tabPlus'));
    }
  }

  // ================= connections =================
  async function connectNow(cfg, tabId) {
    const t = tabId ? tabs.find(x => x.id === tabId) : activeTab();
    if (!t) return;
    try {
      // engine expects cfg.password; accept legacy cfg.pwd too
      const creds = { ...cfg, password: cfg.password || cfg.pwd || '', user: cfg.user || 'anonymous' };
      log('info', `Connecting to ${creds.host} as ${creds.user} (${creds.proto})...`);
      const res = await T.connect(creds);
      t.sid = res.sid; t.connected = true;
      t.proto = creds.proto; t.host = creds.host; t.user = creds.user;
      t.title = t.siteName || cfg.host;
      activateTab(t.id);
      await navigate('remote', res.cwd || '/');
      ui.toast('Connected: ' + cfg.host, 'ok');
    } catch (e) {
      log('error', 'Connect failed: ' + (e.message || e));
      ui.toast('Connect failed: ' + (e.message || e), 'err', 6000);
    }
  }
  async function quickConnect() {
    const cfg = {
      proto: el('qcProto').value,
      host: el('qcHost').value.trim(),
      user: el('qcUser').value.trim(),
      password: el('qcPass').value,
      port: parseInt(el('qcPort').value, 10) || undefined,
      dir: undefined
    };
    if (!cfg.host) { ui.toast('Enter host', 'err'); return; }
    const t = createTab();
    t.siteName = cfg.host;
    await connectNow(cfg, t.id);
  }
  async function disconnectActive() {
    const t = activeTab();
    if (t && t.sid) {
      await T.disconnect(t.sid);
      t.connected = false; t.sid = null;
      renderTabs(); updateRemoteHeader(); showRemoteEmpty();
    }
  }

  // ================= actions =================
  async function runAction(side, act, payload) {
    const t = activeTab();
    try {
      if (side === 'local') {
        if (act === 'open') {
          const p = panes.local.pathJoin(payload.name);
          await T.openPath(p);
        } else if (act === 'mkdir') {
          ui.promptBox('New folder name', 'New folder', async (name) => {
            if (!name) return;
            await T.fsMkdir(panes.local.pathJoin(name));
            navigate('local', panes.local.path);
          });
        } else if (act === 'touch') {
          ui.promptBox('New file name', 'newfile.txt', async (name) => {
            if (!name) return;
            await T.fsTouch(panes.local.pathJoin(name));
            navigate('local', panes.local.path);
          });
        } else if (act === 'rename') {
          const from = panes.local.pathJoin(payload.name);
          ui.promptBox('Rename to', payload.name, async (to) => {
            if (!to || to === payload.name) return;
            await T.fsRename(from, panes.local.pathJoin(to));
            navigate('local', panes.local.path);
          });
        } else if (act === 'delete') {
          const names = payload.names || [payload.name];
          if (!await confirmDelete(names)) return;
          for (const n of names) {
            const it = panes.local.items.find(i => i.name === n);
            await T.fsRemove(panes.local.pathJoin(n), !!(it && it.isDir));
          }
          navigate('local', panes.local.path);
        } else if (act === 'upload') {
          if (!t || !t.connected) { ui.toast('Not connected', 'err'); return; }
          const sel = selectedPaths(panes.local);
          await queueTransfer(t.sid, 'up', sel, panes.remote.path);
        } else if (act === 'view') {
          const p = panes.local.pathJoin(payload.name);
          await T.openPath(p);
        } else if (act === 'reveal') {
          await T.revealPath(panes.local.pathJoin(payload.name));
        } else if (act === 'properties') {
          showProperties(side, payload.name);
        }
      } else {
        // remote side
        if (act === 'download') {
          if (!t || !t.connected) { ui.toast('Not connected', 'err'); return; }
          const sel = selectedPaths(panes.remote);
          await queueTransfer(t.sid, 'dn', sel, panes.local.path);
        } else if (act === 'mkdir') {
          ui.promptBox('New remote folder', 'New folder', async (name) => {
            if (!name) return;
            await T.call(t.sid, 'mkdir', [panes.remote.pathJoin(name)]);
            navigate('remote', panes.remote.path);
          });
        } else if (act === 'touch') {
          ui.promptBox('New remote file', 'newfile.txt', async (name) => {
            if (!name) return;
            await T.call(t.sid, 'touch', [panes.remote.pathJoin(name)]);
            navigate('remote', panes.remote.path);
          });
        } else if (act === 'rename') {
          ui.promptBox('Rename to', payload.name, async (to) => {
            if (!to || to === payload.name) return;
            await T.call(t.sid, 'rename', [panes.remote.pathJoin(payload.name), panes.remote.pathJoin(to)]);
            navigate('remote', panes.remote.path);
          });
        } else if (act === 'delete') {
          const names = payload.names || [payload.name];
          if (!await confirmDelete(names)) return;
          for (const n of names) {
            const it = panes.remote.items.find(i => i.name === n);
            await T.call(t.sid, 'remove', [panes.remote.pathJoin(n), !!(it && it.isDir)]);
          }
          navigate('remote', panes.remote.path);
        } else if (act === 'open') {
          // view remote file: download to temp, open with OS viewer
          const it = panes.remote.items.find(i => i.name === payload.name);
          if (it && it.isDir) return;
          await viewRemote(payload.name, it);
        } else if (act === 'chmod') {
          if (!t || t.proto !== 'sftp') { ui.toast('Changing permissions is available on SFTP', 'err'); return; }
          ui.promptBox('New permissions (octal, e.g. 644)', '644', async (m) => {
            await T.call(t.sid, 'chmod', [panes.remote.pathJoin(payload.name), m]);
            navigate('remote', panes.remote.path);
          });
        } else if (act === 'command') {
          // nothing extra
        } else if (act === 'properties') {
          showProperties(side, payload.name);
        }
      }
    } catch (e) {
      log('error', act + ' → ' + side + ': ' + (e.message || e));
      ui.toast(e.message || String(e), 'err');
    } finally { }
  }

  async function confirmDelete(names) {
    const answer = await ui.msgBox('Delete', 'Are you looking at deleting selected item(s)?\n\n' + names.slice(0, 10).join('\n') + (names.length > 10 ? `\n… (${names.length} total)` : ''), ['Delete', 'Cancel']);
    return answer === 'Delete';
  }

  function selectedPaths(pane) {
    const sel = pane.getSelection();
    return sel.map(i => ({ path: pane.pathJoin(i.name), size: i.size, mtime: i.mtime, isDir: i.isDir, name: i.name }));
  }

  async function queueTransfer(sid, dir, entries, targetDir) {
    if (!entries.length) { ui.toast('Nothing selected'); return; }
    const specs = [];
    for (const e of entries) {
      const dst = dir === 'up'
        ? joinRemote(targetDir, e.name)
        : joinLocalDir(targetDir, e.name);
      specs.push({ sid, dir, src: e.path, dst, isDir: e.isDir, size: e.size, mtime: e.mtime });
    }
    await T.queueAdd(specs);
    ui.toast(`${specs.length} transfer${specs.length > 1 ? 's' : ''} queued`, 'ok');
    switchDock('queue');
  }

  function joinRemote(base, name) {
    const b = String(base || '/').replace(/\\/g, '/');
    return b.replace(/\/+$/, '') + '/' + String(name).replace(/^\/+/, '');
  }

  // Join a LOCAL directory with a child name using the OS separator.
  function joinLocalDir(base, name) {
    const sep = window.__isWin ? '\\' : '/';
    const b = String(base || '').replace(/[\\/]+$/, '');
    if (!b) return sep + name;
    return b + sep + name;
  }

  async function viewRemote(name, item) {
    const t = activeTab();
    const dirs = await T.userDirs();
    const destClean = joinLocalDir(dirs.downloads, 'trixview_' + Date.now().toString(36) + '_' + name);
    log('info', 'View: downloading ' + name + ' …');
    await T.queueAdd([{ sid: t.sid, dir: 'dn', src: panes.remote.pathJoin(name), dst: destClean, isDir: false, size: item ? item.size : 0, mtime: item ? item.mtime : 0 }]);
    const watch = setInterval(async () => {
      const st = await T.fsStat(destClean).catch(() => null);
      if (st && st.exists && st.size === (item && item.size || 0)) {
        clearInterval(watch);
        await T.openPath(destClean);
      }
    }, 600);
    // safety stop
    setTimeout(() => clearInterval(watch), 120000);
  }

  async function showProperties(side, name) {
    const p = side === 'local' ? panes.local : panes.remote;
    const it = p.items.find(i => i.name === name);
    let stats = '';
    try {
      if (side === 'local') {
        const st = await T.fsStat(p.pathJoin(name));
        stats = st ? `Size: ${st.size}\nDir: ${st.isDir}\nModified: ${new Date(st.mtime * 1000).toLocaleString()}` : 'no stat';
      } else {
        const st = await T.call(activeTab().sid, 'stat', [p.pathJoin(name)]);
        stats = st ? `Size: ${st.size}\nDir: ${st.isDir}\nModified: ${st.mtime ? new Date(st.mtime * 1000).toLocaleString() : 'unknown'}` : 'no stat';
      }
    } catch (e) { stats = e.message; }
    const body = document.createElement('div');
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = `Name: ${name}\nType: ${ui.kndFor(it)}\n${stats}`;
    ui.openModal({ title: 'Properties', body });
  }

  // ================= queue =================
  let hadRealTransfer = false; // any job actually ran since the last allDone

  // ================= app auto-update =================
  let upd = { seen: false };        // last update payload we acted on
  let updCache = null;              // last successful update:check result

  function uxb() {
    const box = el('updateBox');
    return {
      title: el('uxTitle'), ver: el('uxVer'), text: el('uxText'),
      bar: el('uxBar'), fill: el('uxFill'), actions: el('uxActions'), box
    };
  }
  function showUpd(title, version, htmlText, actions, progress) {
    if (progress === undefined || progress === null) progress = false;
    const b = uxb();
    b.title.textContent = title;
    b.ver.textContent = version || '';
    b.text.innerHTML = htmlText || '';
    b.bar.hidden = !progress;
    if (progress) b.fill.style.width = Math.max(3, Math.min(100, progress)) + '%';
    b.actions.innerHTML = '';
    (actions || []).forEach(([label, act, primary]) => {
      const btn = document.createElement('button');
      if (primary) btn.className = 'primary';
      btn.textContent = label;
      btn.setAttribute('data-ux', act);
      b.actions.appendChild(btn);
    });
    b.box.hidden = false;
  }
  function hideUpd() { el('updateBox').hidden = true; }

  function buildUpdText(info) {
    let s = 'Installed version: <b>' + (info.current || '?') + '</b>';
    s += '<br>New: <b>' + (info.version || '?') + '</b> - ' + (info.release || 'official build');
    const platName = { win32: 'Windows installer (NSIS)', darwin: 'macOS disk image (.dmg)', linux: 'Linux AppImage' }[window.__plat] || 'installer';
    return s + '<br><span style="opacity:.75">' + platName + ' will be downloaded.</span>';
  }
  async function onUpdResult(info) {
    if (!info) return;
    updCache = info;
    upd.seen = true;
    if (info.error) {
      showUpd('Update check failed', '', (info.error || ''), [['Retry', 'check'], ['Close', 'close']]);
      return;
    }
    if (!info.available) {
      if (info.manual) ui.toast('You are up to date (v' + info.current + ')', 'ok');
      return;
    }
    showUpd('TrixFTP update available', 'v' + info.version, buildUpdText(info),
      [['Download & install', 'dl', true], ['Later', 'later']]);
  }

  function wireUpdater() {
    T.onUpdateEvent((ev) => {
      if (ev.type === 'available') {
        if (updCache && updCache.available) onUpdResult(updCache); // user has not acted yet -> show again
        else T.updateCheck(); // pull details for the found version
      } else if (ev.type === 'progress') {
        showUpd('Downloading update', 'v' + ((updCache && updCache.version) || ''), '', [], ev.pct);
      } else if (ev.type === 'ready') {
        const isWin = window.__plat === 'win32';
        const fname = ((ev.file || updCache && updCache.asset || '').split(/[\\/]/).pop());
        const txt = isWin
          ? 'Download finished. Click <b>Restart &amp; install</b> - the app quits and the setup runs silently.'
          : 'Download finished: <b>' + fname + '</b>. Click <b>Run installer</b> to apply it.';
        showUpd('Update ready', 'v' + ((updCache && updCache.version) || ''), txt,
          isWin ? [['Restart & install', 'install', true], ['Show file', 'reveal'], ['Close', 'close']]
            : [['Run installer', 'install', true], ['Show file', 'reveal'], ['Close', 'close']]);
      } else if (ev.type === 'installing') {
        showUpd('Updating TrixFTP', '', 'The update is starting - the app will close now.', []);
      } else if (ev.type === 'error') {
        showUpd('Update failed', '', (ev.error || 'Unknown error'), [['Retry check', 'check'], ['GitHub releases', 'page'], ['Close', 'close']]);
      }
    });

    el('btnUpdates').addEventListener('click', async () => {
      showUpd('Checking for updates', '', '', []);
      const r = await T.updateCheck().catch(e => ({ available: false, error: String(e) }));
      r.manual = true;
      onUpdResult(r);
    });
    el('uxClose').addEventListener('click', hideUpd);
    el('uxActions').addEventListener('click', async (e) => {
      const act = e.target.getAttribute && e.target.getAttribute('data-ux');
      if (!act) return;
      try {
        if (act === 'dl') { showUpd('Downloading update', 'v' + ((updCache && updCache.version) || ''), '', [], 3); await T.updateDownload(); }
        else if (act === 'later' || act === 'close') hideUpd();
        else if (act === 'reveal') await T.updateReveal();
        else if (act === 'install') { const r = await T.updateInstall(); if (r && !r.ok) ui.toast(r.error || 'Could not start the installer', 'err'); }
        else if (act === 'check') { showUpd('Checking for updates', '', '', []); const r = await T.updateCheck().catch(x => ({ available: false, error: String(x) })); r.manual = true; onUpdResult(r); }
        else if (act === 'page') await T.updateOpenPage();
      } catch (err) { ui.toast('Update action failed: ' + err, 'err'); }
    });
  }

  function onQueueEvent(ev) {
    if (ev.type === 'job' || ev.type === 'progress') {
      if (ev.job.state === 'active' || ev.job.state === 'done' || ev.job.state === 'skipped') hadRealTransfer = true;
      upsertQueueRow(ev.job, ev.type === 'progress');
      speedTick(ev.job);
      updateQueueSummary();
    } else if (ev.type === 'ask') {
      showConflictDialog(ev);
    } else if (ev.type === 'clear') {
      el('queueList').innerHTML = '';
      queueRows.clear(); speedRing.clear();
      updateQueueSummary();
    } else if (ev.type === 'allDone') {
      updateQueueSummary(true);
      // finished a real batch -> auto-refresh both panes so the destination
      // files appear immediately (no need to leave/re-enter the folder)
      if (hadRealTransfer) {
        setTimeout(() => { try { refreshBoth(); } catch (e) { } }, 350);
        hadRealTransfer = false;
      }
    }
  }

  function speedTick(job) {
    if (job.state !== 'active') { speedRing.delete(job.id); return; }
    if (!speedRing.has(job.id)) speedRing.set(job.id, []);
    const r = speedRing.get(job.id);
    r.push({ t: Date.now(), bytes: job.bytes || 0 });
    while (r.length > 60) r.shift();
    // emit derived speed on the row
    const rec = queueRows.get(job.id);
    if (rec) renderQRow(job, speedOf(r), etaOf(job, speedOf(r)));
  }
  function speedOf(ring) {
    if (ring.length < 2) return 0;
    const a = ring[0], b = ring[ring.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return 0;
    return Math.max(0, (b.bytes - a.bytes) / dt);
  }
  function etaOf(job, sp) {
    if (!job.size || !sp) return null;
    return Math.max(0, (job.size - job.bytes) / sp);
  }

  function upsertQueueRow(job, isProgress) {
    let rec = queueRows.get(job.id);
    if (rec && !isProgress && (job.state === 'error' || job.state === 'done' || job.state === 'canceled' || job.state === 'skipped')) {
      renderQRow(job, 0, null);
      return;
    }
    if (!rec) {
      const row = document.createElement('div');
      row.className = 'qrow';
      const n = document.createElement('div'); n.className = 'q-name'; row.appendChild(n);
      const s = document.createElement('div'); s.className = 'q-state'; row.appendChild(s);
      const p = document.createElement('div'); p.className = 'q-prog';
      const bar = document.createElement('div'); bar.className = 'bar'; p.appendChild(bar);
      const txt = document.createElement('div'); txt.className = 'txt'; p.appendChild(txt);
      row.appendChild(p);
      const sp = document.createElement('div'); sp.className = 'q-speed'; row.appendChild(sp);
      const et = document.createElement('div'); et.className = 'q-eta'; row.appendChild(et);
      el('queueList').appendChild(row);
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        ui.menu([
          { label: job.state === 'paused' ? 'Resume' : 'Pause', click: () => job.state === 'paused' ? T.queueResume(job.id) : T.queuePause(job.id) },
          { label: 'Cancel', click: () => T.queueCancel(job.id) },
          { label: 'Retry', click: () => T.queueRetry(job.id) },
          { sep: true },
          { label: 'Clear finished', click: () => T.queueClearTerminal() }
        ], e.clientX, e.clientY);
      });
      rec = { job, el: row, parts: { n, s, p, bar, txt, sp, et } };
      queueRows.set(job.id, rec);
    }
    rec.job = job;
    renderQRow(job, null, null, rec);
  }

  function renderQRow(job, forcedSpeed, forcedEta, recOverride) {
    const rec = recOverride || queueRows.get(job.id);
    if (!rec) return;
    rec.el.className = 'qrow state-' + job.state;
    rec.parts.n.textContent = (job.dir === 'up' ? '↑ ' : '↓ ') + job.name + (job.size ? '' : '');
    rec.parts.n.title = job.src + ' → ' + job.dst;
    const stMap = {
      queued: 'queued', paused: 'paused', active: 'transferring',
      done: '✓ done', skipped: '— skipped (exists)', canceled: '✕ canceled',
      canceling: 'canceling…', error: '✖ ' + (job.error || 'error'), parent: 'folder'
    };
    rec.parts.s.textContent = stMap[job.state] || job.state;
    const pct = job.size ? Math.min(100, Math.round((job.bytes / job.size) * 100)) : (job.state === 'done' ? 100 : 0);
    rec.parts.bar.style.width = pct + '%';
    rec.parts.txt.textContent = job.size
      ? `${ui.fmtSize(job.bytes)} / ${ui.fmtSize(job.size)} (${pct}%)`
      : (job.state === 'done' ? 'done' : job.childTotal ? `${job.childDone}/${job.childTotal}` : ui.fmtSize(job.bytes));
    if (forcedSpeed != null) rec.parts.sp.textContent = forcedSpeed ? ui.fmtSize(forcedSpeed) + '/s' : '';
    if (forcedEta != null) rec.parts.et.textContent = forcedEta == null ? '' : ui.fmtTime(forcedEta);
    else if (job.state !== 'active') { if (rec.parts.sp.textContent) rec.parts.sp.textContent = ''; }
    // aggregate parents keep a single row
  }

  function updateQueueSummary(allDone) {
    let queueCount = 0, active = 0, speed = 0;
    for (const [id, rec] of queueRows) {
      const j = rec.job;
      if (j.state === 'active') { active++; speed += speedOf(speedRing.get(id) || []); }
      else if (j.state === 'queued' || j.state === 'paused') queueCount++;
    }
    el('queueSummary').textContent = ` ${active} active, ${queueCount} queued — ${ui.fmtSize(speed)}/s`;
    el('stRight').textContent = isBusy() ? `Queue: ${active} active, ${queueCount} waiting — ${ui.fmtSize(speed)}/s` : 'Queue: idle';
    const badge = el('queueBadge');
    const total = queueRows.size;
    badge.textContent = String(total);
    badge.style.display = total ? 'inline-block' : 'none';
    if (allDone === true) { ui.toast('All transfers finished', 'ok'); }
  }
  const isBusy = () => [...queueRows.values()].some(r => r.job.state === 'active' || r.job.state === 'queued');

  // conflict dialog
  function showConflictDialog(ev) {
    const body = document.createElement('div');
    const info = document.createElement('div');
    info.style.cssText = 'white-space:pre-wrap;margin-bottom:12px;';
    info.textContent =
      `The file already exists on the destination.\n\n` +
      `File:  ${ev.fileName}\n` +
      `Existing:  ${ev.curSize != null ? ui.fmtSize(ev.curSize) : '?'} ::  ${ev.newSize != null ? ui.fmtSize(ev.newSize) : '?'} (new)\n` +
      `Existing modified:  ${ev.curMtime ? new Date(ev.curMtime * 1000).toLocaleString() : '?'}\n` +
      `New modified:  ${ev.newMtime ? new Date(ev.newMtime * 1000).toLocaleString() : '?'}`;
    body.appendChild(info);
    const chk = document.createElement('label');
    chk.className = 'm-check';
    const cbx = document.createElement('input'); cbx.type = 'checkbox';
    chk.appendChild(cbx); chk.appendChild(document.createTextNode('Apply to all remaining files in this session'));
    body.appendChild(chk);
    const answer = (action, newDst) => {
      T.answer({ token: ev.token, action, applyAll: cbx.checked, newDst });
      if (action === 'rename') closeModal();
    };
    const renamePrompt = () => {
      const base = ev.fileName.replace(/(\.[^.]*)?$/, (ext) => '-1' + (ext || ''));
      ui.promptBox('Rename destination to', base, (newDst) => newDst && answer('rename', newDst));
    };
    ui.openModal({
      title: 'File already exists',
      body,
      buttons: [
        { label: 'Overwrite', primary: true, click: () => answer('overwrite') },
        { label: 'Resume', click: () => answer('resume') },
        { label: 'Rename…', click: renamePrompt },
        { label: 'Skip', click: () => answer('skip') },
        { label: 'Cancel', click: () => answer('cancel') }
      ],
      width: 520
    });
  }

  // ================= toolbar / dock / menus =================
  function wireToolbar() {
    el('btnConnect').addEventListener('click', quickConnect);
    el('btnDisconnect').addEventListener('click', disconnectActive);
    el('btnSites').addEventListener('click', siteManager);
    el('btnSettings').addEventListener('click', settingsDialog);
    // "+" new tab (mousedown so it survives tab-row re-renders)
    const plusEl = el('tabPlus');
    plusEl.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); createTab(); });
    el('qcProto').addEventListener('change', () => {
      const p = el('qcProto').value;
      el('qcPort').placeholder = p === 'sftp' ? '22' : p === 'ftpes' ? '21/990' : '21';
    });
    document.querySelectorAll('[data-pathgo]').forEach(b => {
      b.addEventListener('click', () => {
        const dd = window.__dirs;
        navigate('local', b.dataset.pathgo === 'home' ? dd.home : b.dataset.pathgo === 'downloads' ? dd.downloads : b.dataset.pathgo === 'desktop' ? dd.desktop : dd.documents);
      });
    });
    // pane tools (buttons differ per side; guard each)
    for (const side of ['local', 'remote']) {
      const paneRoot = el(side === 'local' ? 'paneLocal' : 'paneRemote');
      for (const btn of paneRoot.querySelectorAll('.pane-tools button')) {
        const act = btn.dataset.act;
        btn.addEventListener('click', () => {
          try {
            if (act === 'refresh') navigate(side, panes[side].path);
            else if (act === 'mkdir') runAction(side, 'mkdir', {});
            else if (act === 'delete') {
              const sel = panes[side].getSelection();
              if (sel.length) runAction(side, 'delete', { names: sel.map(i => i.name) });
            }
            else if (act === 'upload') runAction('local', 'upload', {});
            else if (act === 'download') runAction('remote', 'download', {});
            else if (act === 'filter') panes[side].filterInput.focus();
            else if (act === 'hidden') { panes[side].showHidden = !panes[side].showHidden; panes[side].render(); }
          } catch (e) { console.error('pane action', act, e); }
        });
      }
    }
  }

  function wireDock() {
    el('dockLogTab').addEventListener('click', () => switchDock('log'));
    el('dockQueueTab').addEventListener('click', () => switchDock('queue'));
    el('dockToggle').addEventListener('click', () => {
      el('dock').classList.toggle('collapsed');
    });
    el('qPauseAll').addEventListener('click', () => T.queuePauseAll());
    el('qResumeAll').addEventListener('click', () => T.queueResumeAll());
    el('qRetryFailed').addEventListener('click', () => {
      let n = 0;
      for (const [, rec] of queueRows) {
        if (rec.job.state === 'error' || rec.job.state === 'canceled') { T.queueRetry(rec.job.id); n++; }
      }
      ui.toast(n ? `Requeued ${n} failed transfer(s)` : 'No failed transfers', n ? 'ok' : undefined);
    });
    el('qClearDone').addEventListener('click', () => T.queueClearTerminal());
    el('qClearAll').addEventListener('click', async () => {
      const ok = await T.queueClear(true);
      if (!ok) ui.toast('Cannot clear: transfer in progress', 'err');
    });
    const sendCmd = async () => {
      const t = activeTab();
      const txt = el('cmdInput').value.trim();
      if (!txt) return;
      el('cmdInput').value = '';
      if (!t || !t.sid) { ui.toast('Not connected', 'err'); return; }
      try {
        const res = await T.call(t.sid, 'command', [txt]);
        log('info', '→ ' + txt + ' ⇒ ' + res);
      } catch (e) { log('error', 'command: ' + (e.message || e)); }
    };
    el('cmdSend').addEventListener('click', sendCmd);
    el('cmdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCmd(); });
  }

  function switchDock(which) {
    el('dockLogTab').classList.toggle('on', which === 'log');
    el('dockQueueTab').classList.toggle('on', which === 'queue');
    el('logView').classList.toggle('on', which === 'log');
    el('queueView').classList.toggle('on', which === 'queue');
    el('dock').classList.remove('collapsed');
  }

  function bindQueueSettings() {
    el('setMaxParallel').addEventListener('change', () => T.setSettings({ maxParallel: parseInt(el('setMaxParallel').value, 10) || 1 }));
    el('setSpeedLimit').addEventListener('change', () => T.setSettings({ speedLimit: parseInt(el('setSpeedLimit').value, 10) || 0 }));
  }

  // context menus
  function showPaneMenu(side, x, y) {
    const t = activeTab();
    const pane = panes[side];
    const onRow = pane.selected.size > 0;
    const oneSec = pane.selected.size === 1;
    const items = [];
    if (oneSec && pane.rowOf([...pane.selected][0])) {
      const nm = [...pane.selected][0];
      const it = pane.items.find(i => i.name === nm);
      if (it && it.isDir) items.push({ label: 'Enter folder', click: () => navigate(side, pane.pathJoin(nm)) });
    }
    if (side === 'remote') {
      items.push({ label: 'Download', key: 'Enter', click: () => runAction(side, 'download', {}), disabled: !onRow || !t || !t.connected });
      items.push({
        label: 'View file', click: () => {
          const nm = [...pane.selected][0];
          runAction(side, 'open', { name: nm });
        }
      });
      if (t && t.proto === 'sftp') items.push({ label: 'Change permissions (chmod)…', click: () => runAction(side, 'chmod', { name: [...pane.selected][0] }) });
    } else {
      items.push({ label: 'Open', key: 'Enter', click: () => { const nm = [...pane.selected][0]; runAction(side, 'open', { name: nm }); } });
      items.push({ label: 'Show in Explorer', click: () => { const nm = [...pane.selected][0]; runAction(side, 'reveal', { name: nm }); } });
      items.push({ label: 'Upload', click: () => runAction(side, 'upload', {}) });
    }
    items.push({ label: 'Copy name', click: async () => { await navigator.clipboard.writeText([...pane.selected][0] || ''); ui.toast('Copied'); } });
    items.push({
      label: 'Copy path', click: async () => {
        const nm = [...pane.selected][0];
        if (nm) await navigator.clipboard.writeText(pane.pathJoin(nm));
        else await navigator.clipboard.writeText(pane.path);
        ui.toast('Copied');
      }
    });
    items.push({ sep: true });
    items.push({ label: 'New folder…', click: () => runAction(side, 'mkdir', {}) });
    items.push({ label: 'New file…', click: () => runAction(side, 'touch', {}) });
    if (onRow) {
      items.push({ sep: true });
      items.push({ label: oneSec ? 'Rename… (F2)' : 'Delete… (Del)', visible: oneSec, click: () => runAction(side, 'rename', { name: [...pane.selected][0] }) });
      items.push({ label: `Delete (${pane.selected.size})… (Del)`, click: () => runAction(side, 'delete', { names: [...pane.selected] }) });
      items.push({ label: 'Properties', click: () => runAction(side, 'properties', { name: [...pane.selected][0] }) });
    }
    items.push({ sep: true });
    items.push({ label: 'Refresh (F5)', click: () => navigate(side, pane.path) });
    items.push({ label: 'Select all (Ctrl+A)', click: () => pane.selectAll() });
    items.push({ label: 'Invert selection', click: () => pane.invertSelection() });
    items.push({ label: 'Clear selection', click: () => { pane.selected.clear(); pane.render(); } });
    if (side === 'local' && panes.remote.items.length) { items.push({ sep: true }); items.push({ label: 'Compare directories with remote', click: () => compareDirs() }); }
    ui.menu(items.filter(Boolean), x, y);
  }

  // compare dirs: mark rows (exists only on one side; same name different size)
  async function compareDirs() {
    compareMode = !compareMode;
    if (!compareMode) {
      panes.local.markMap = panes.remote.markMap = null;
      panes.local.render(); panes.remote.render();
      return;
    }
    const mark = new Map();
    const L = new Map(panes.local.items.map(i => [i.name, i]));
    const R = new Map(panes.remote.items.map(i => [i.name, i]));
    for (const [nm, li] of L) {
      const ri = R.get(nm);
      if (!ri) mark.set(nm, 'left');
      else if (li.isDir !== ri.isDir || (!li.isDir && li.size !== ri.size)) mark.set(nm, 'diff');
    }
    for (const [nm] of R) if (!L.has(nm)) mark.set(nm, 'right');
    panes.local.markMap = panes.remote.markMap = mark;
    panes.local.compareMode = panes.remote.compareMode = true;
    panes.local.render(); panes.remote.render();
    log('info', `Compare: ${mark.size} differing entries highlighted.`);
  }

  // ================= site manager =================
  async function siteManager(siteIdToEdit) {
    // guard against Event objects leaking in as "id"
    if (typeof siteIdToEdit !== 'string') siteIdToEdit = null;
    const store = await T.getAll();
    const body = document.createElement('div');
    body.className = 'sites-layout';
    const listEl = document.createElement('div'); listEl.className = 'sites-list';
    const form = document.createElement('div'); form.className = 'sites-form';
    body.appendChild(listEl); body.appendChild(form);

    let selection = siteIdToEdit || null;
    const rows = store.sites.slice().sort((a, b) => b.lastUsed - a.lastUsed);

    function formFor(site, editable) {
      form.innerHTML = '';
      const g = document.createElement('div'); g.className = 'm-grid';
      const mk = (label, input, id) => {
        const l = document.createElement('label'); l.textContent = label;
        if (id) input.id = id;
        g.appendChild(l); g.appendChild(input); return input;
      };
      const val = (v) => { const i = document.createElement('input'); i.value = v || ''; return i; };
      mk('Name:', val(site.name), 'siteName');
      const proto = document.createElement('select'); proto.id = 'siteProto';
      [['ftp', 'FTP'], ['ftpes', 'FTPS (explicit TLS)'], ['sftp', 'SFTP']].forEach(([v, t]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = t; proto.appendChild(o);
      });
      mk('Protocol:', proto);
      mk('Host:', val(site.host), 'siteHost');
      mk('Port:', val(site.port || ''), 'sitePort');
      mk('User:', val(site.user), 'siteUser');
      mk('Password:', (() => { const p = val(''); p.type = 'password'; p.placeholder = site.pwd ? '********' : ''; p.id = 'sitePwd'; return p; })());
      chkPwd = (() => { const d = document.createElement('label'); d.className = 'm-check'; const c = document.createElement('input'); c.type = 'checkbox'; c.checked = true; d.appendChild(c); d.appendChild(document.createTextNode('Save password')); g.appendChild(document.createElement('label')); g.appendChild(d); return c; })();
      const keyIn = val(site.keyPath); keyIn.id = 'siteKey';
      mk('SFTP key file:', keyIn);
      mk('Remote dir:', val(site.dir), 'siteDir');
      mk('Verify TLS:', (() => {
        const s = document.createElement('select'); s.id = 'siteVerify';
        [['0', 'Off (accept any cert)'], ['1', 'Strict (reject self-signed)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; s.appendChild(o); });
        s.value = site.verifyTls ? '1' : '0';
        return s;
      })());
      form.appendChild(g);
      proto.addEventListener('change', () => { const k = form.querySelector('#siteKeyRow'); });
    }

    function renderList() {
      listEl.innerHTML = '';
      for (const s of rows) {
        const it = document.createElement('div');
        it.className = 'site-item' + (selection === s.id ? ' sel' : '');
        const n = document.createElement('span'); n.textContent = s.name;
        const ht = document.createElement('span'); ht.style.color = 'var(--dim)'; ht.textContent = s.host;
        it.appendChild(n); it.appendChild(ht);
        it.addEventListener('click', () => { selection = s.id; renderList(); formFor(s); });
        listEl.appendChild(it);
      }
      if (!rows.length) { listEl.appendChild(document.createTextNode('No sites yet — add one.')); }
    }

    const saved = {
      get: () => ({
        id: (typeof selection === 'string' ? selection : undefined),
        name: form.querySelector('#siteName').value.trim(),
        proto: form.querySelector('#siteProto').value,
        host: form.querySelector('#siteHost').value.trim(),
        port: parseInt(form.querySelector('#sitePort').value, 10) || undefined,
        user: form.querySelector('#siteUser').value.trim(),
        pwd: form.querySelector('#sitePwd').value,
        savepwd: true,
        keyPath: form.querySelector('#siteKey').value.trim() || undefined,
        dir: form.querySelector('#siteDir').value.trim() || undefined,
        verifyTls: form.querySelector('#siteVerify').value === '1'
      })
    };

    const collectForm = () => saved.get();

    let chkPwd;
    ui.openModal({
      title: 'Site Manager',
      body,
      width: 720,
      buttons: [
        {
          label: 'New', click: () => { selection = null; formFor({ proto: 'ftp', verifyTls: 0 }, true); renderList(); }
        },
        {
          label: 'Delete', click: async () => {
            if (!selection) return;
            const fresh = await T.deleteSite(selection);
            rows.length = 0; rows.push(...fresh);
            selection = null; formFor({ proto: 'ftp' }); renderList();
          }
        },
        {
          label: 'Save', primary: true, click: async () => {
            const d = saved.get();
            if (!d.host) { ui.toast('Host required', 'err'); return; }
            await T.saveSite(d);
            const fresh = await T.getAll();
            rows.length = 0; rows.push(...fresh.sites);
            renderList();
            ui.toast('Site saved', 'ok');
          }
        },
        {
          label: 'Connect', click: async () => {
            const d = collectForm();
            if (!d.host) { ui.toast('Host required', 'err'); return; }
            // Always prefer the stored, decoded password for saved sites,
            // unless the user actually typed a new one in the form.
            if (typeof selection === 'string') {
              const stored = await T.siteForConnect(selection);
              if (stored) {
                if (!d.pwd) d.pwd = stored.pwd || '';
                if (!d.name) d.name = stored.name;
                if (!d.keyPath && stored.keyPath) d.keyPath = stored.keyPath;
                // make sure form-only defaults don't override stored connoptions
                if (!d.port) d.port = stored.port;
              }
            }
            const t = createTab();
            if (d.name) { t.title = d.name; t.siteName = d.name; }
            renderTabs();
            ui.closeModal();
            await connectNow(d, t.id);
          }
        },
        { label: 'Close', click: () => ui.closeModal() }
      ]
    });
    formFor({ proto: 'ftp' }, true);
    renderList();
  }

  // ================= settings dialog =================
  async function settingsDialog() {
    const s = T.setSettings ? settings : settings;
    const body = document.createElement('div');
    body.className = 'settings-cards';

    const card = (title) => {
      const c = document.createElement('div');
      c.className = 'set-card';
      const h = document.createElement('div');
      h.className = 'set-head';
      h.textContent = title;
      c.appendChild(h);
      const rows = document.createElement('div');
      rows.className = 'set-rows';
      c.appendChild(rows);
      body.appendChild(c);
      return rows;
    };

    const row = (parent, label, node, hint) => {
      const r = document.createElement('div');
      r.className = 'set-row';
      const rl = document.createElement('label');
      rl.className = 'set-label';
      rl.textContent = label;
      const rc = document.createElement('div');
      rc.className = 'set-ctl';
      rc.appendChild(node);
      if (hint) { const hp = document.createElement('div'); hp.className = 'set-hint'; hp.textContent = hint; rc.appendChild(hp); }
      r.appendChild(rl); r.appendChild(rc);
      parent.appendChild(r);
      return node;
    };

    const chk = (id, def) => {
      const c = document.createElement('input');
      c.type = 'checkbox'; c.defaultChecked = !!def; c.dataset.id = id;
      return c;
    };
    const sel = (id, def, opts) => {
      const w = document.createElement('select'); w.dataset.id = id; w.style.width = '100%';
      for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; w.appendChild(o); }
      w.value = String(def);
      return w;
    };

    // --- Transfers ---
    const tr = card('Transfers');
    const resume = row(tr, 'Resume interrupted transfers', chk('resume', s.resume), 'Continue partial files via REST/size offset');
    const preserve = row(tr, 'Preserve modification times', chk('preserveTimes', s.preserveTimes), 'Apply source MTIME to transferred files');
    const overwrite = row(tr, 'If target already exists', sel('askOverwriteSel', s.askOverwrite || 'ask', [['ask', 'Ask every time'], ['overwrite', 'Overwrite'], ['skip', 'Skip'], ['resume', 'Attempt resume']]));

    // --- Connection ---
    const co = card('Connection & security');
    const keepAliveEl = row(co, 'Keep-alive ping while idle', chk('keepAlive', s.keepAlive), 'Sends periodic NOOP so proxies don\'t drop the session');
    const strict = row(co, 'FTPS certificate verification', chk('verifyTls', s.verifyTls), 'Strict: reject invalid / self-signed certificates');

    ui.openModal({
      title: 'Settings',
      width: 560,
      body,
      buttons: [
        {
          label: 'Save', primary: true, click: async () => {
            const patch = {
              verifyTls: strict.checked,
              resume: resume.checked,
              preserveTimes: preserve.checked,
              keepAlive: keepAliveEl.checked,
              askOverwrite: overwrite.value || 'ask'
            };
            await T.setSettings(patch);
            ui.closeModal(); ui.toast('Settings saved', 'ok');
          }
        },
        { label: 'Cancel', click: () => ui.closeModal() }
      ]
    });
  }

  // ================= log =================
  function appendLog(level, msg) {
    const v = el('logView');
    const d = new Date();
    const ts = d.toTimeString().slice(0, 8);
    const line = document.createElement('span');
    line.className = 'l-' + (level || 'info');
    line.textContent = `[${ts}] ${msg}\n`;
    v.appendChild(line);
    while (v.childNodes.length > 800) v.removeChild(v.firstChild);
    v.scrollTop = v.scrollHeight;
  }
  const log = (level, msg) => { try { appendLog(level, msg); } catch (e) { } };
  const logLine = log;

  function setStatus() {
    const lp = panes.local ? panes.local.path : '';
    const sel = panes.local ? panes.local.selected.size : 0;
    el('stLeft').textContent = `Local: ${lp || '—'}${sel ? ` — ${sel} selected` : ''}`;
  }

  // ================= global keys =================
  function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      if (ui.modalOpen()) return;
      if (e.key === 'F8') { e.preventDefault(); siteManager(); }
      else if (e.key === 'F5') { e.preventDefault(); refreshBoth(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); siteManager(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); createTab(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (tabs.length > 1) closeTab(activeTabId); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); el('dock').classList.toggle('collapsed'); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'b') { e.preventDefault(); switchDock('queue'); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); switchDock('log'); }
      else if (e.key === 'Tab') { }
    });
  }
  function refreshBoth() { navigate('local', panes.local.path); if (activeTab() && activeTab().connected) navigate('remote', panes.remote.path); }

  // ================= drag & drop =================
  function onDragOver(e, side) {
    if (side === 'remote' && !(activeTab() && activeTab().connected)) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const row = e.target.closest('.row');
    e.currentTarget.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
    if (row) row.classList.add('drop-target');
  }

  async function onDropOn(e, side, rowEl) {
    e.preventDefault();
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer.getData('application/trix-transfer') || 'null'); } catch (er) { payload = null; }
    // OS files dropped
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      const paths = window.trix.dropPaths([...e.dataTransfer.files]); // sync resolution!
      if (!paths.length) return;
      if (side === 'local') {
        const targetDir = rowEl && rowEl.dataset.isDir ? rowTarget(side, rowEl) : panes.local.path;
        const r = await window.trix.fsCopy(paths, targetDir);
        if (r && !r.ok) ui.toast(r.error, 'err');
        navigate('local', targetDir);
      } else if (side === 'remote') {
        const t = activeTab();
        if (!t || !t.connected) { ui.toast('Not connected', 'err'); return; }
        const srcDir = panes.local.path;
        const dstDir = rowEl && rowEl.dataset.isDir ? remotePathOfRow(side, rowEl) : panes.remote.path;
        const specs = [];
        for (const p of paths) {
          const name = p.split(/[\\/]/).pop();
          const st = await T.fsStat(p);
          specs.push({ sid: t.sid, dir: 'up', src: p, dst: joinRemote(dstDir, name), isDir: !!(st && st.isDir), size: (st && st.size) || 0, mtime: (st && Math.floor(st.mtime)) || 0 });
        }
        await T.queueAdd(specs);
        switchDock('queue');
      }
      return;
    }
    if (!payload) return;
    // cross-pane
    const srcSide = payload.side;
    if (srcSide === side) return;
    const t = activeTab();
    if (side === 'remote') {
      if (!t || !t.connected) { ui.toast('Not connected', 'err'); return; }
      const dstDir = rowEl && rowEl.dataset.isDir ? remotePathOfRow(side, rowEl) : panes.remote.path;
      const specs = [];
      for (const p of payload.paths) {
        const name = p.split(/[\\/]/).pop();
        const st = await T.fsStat(p);
        specs.push({ sid: t.sid, dir: 'up', src: p, dst: joinRemote(dstDir, name), isDir: !!(st && st.isDir), size: (st && st.size) || 0, mtime: (st && Math.floor(st.mtime)) || 0 });
      }
      await T.queueAdd(specs);
    } else {
      const t = activeTab();
      if (!t || !t.connected) { ui.toast('Not connected', 'err'); return; }
      const dstDir = rowEl && rowEl.dataset.isDir ? rowTarget(side, rowEl) : panes.local.path;
      const specs = [];
      for (const p of payload.paths) {
        const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        const si = panes.remote.items.find(x => x.name === name);
        if (!si) continue;
        specs.push({ sid: t.sid, dir: 'dn', src: p, dst: joinLocalDir(dstDir, name), isDir: !!si.isDir, size: si.size, mtime: si.mtime });
      }
      await T.queueAdd(specs);
    }
    switchDock('queue');
    // refresh destination a moment later
    setTimeout(() => navigate(side, side === 'remote' ? panes.remote.path : panes.local.path), 800);
  }
  function rowTarget(side, rowEl) {
    const nm = rowEl.dataset.name;
    return side === 'local' ? panes.local.pathJoin(nm) : panes.remote.pathJoin(nm);
  }
  function remotePathOfRow(side, rowEl) {
    return rowTarget(side, rowEl);
  }

  function bindDndBookkeeping() {
    const hint = el('dragHint');
    window.addEventListener('dragenter', () => { hint.style.display = 'flex'; });
    window.addEventListener('dragleave', () => { hint.style.display = 'none'; });
    window.addEventListener('drop', () => { hint.style.display = 'none'; });
  }

  // ================= splitter =================
  function splitterInit() {
    const div = el('divider');
    const left = el('paneLocal');
    const right = el('paneRemote');
    let dragging = false;
    div.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const total = window.innerWidth;
      const px = Math.min(total - 260, Math.max(260, e.clientX - left.getBoundingClientRect().left));
      left.style.flexBasis = px + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
  }

  // ================= start =================
  window.onPaneFootChanged = () => { };
  window.app = { showPaneMenu, navigate, runAction, compareDirs };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
