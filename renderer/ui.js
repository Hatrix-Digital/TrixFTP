'use strict';
// UI helpers: dialogs, context menu, formatting, toasts.
(function () {
  const fmtSize = (n) => {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  };

  const fmtTime = (sec) => {
    if (sec == null || !isFinite(sec) || sec < 0) return '--:--';
    sec = Math.round(sec);
    if (sec < 60) return sec + ' s';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + ':' + String(s).padStart(2, '0');
    const h = Math.floor(m / 60);
    return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };

  const fmtDate = (epochSec) => {
    if (!epochSec) return '';
    const d = new Date(epochSec * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };

  const iconFor = (isDir, isLink, name) => {
    if (isLink) return '\u2197'; // ↗
    if (isDir) return '\uD83D\uDCC1'; // 📁
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return '\uD83D\uDDC3'; // 🗃
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return '\uD83D\uDDBC'; // 🖼
    if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return '\uD83C\uDFA7';
    if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return '\uD83C\uDFA5';
    if (['pdf'].includes(ext)) return '\uD83D\uDCD5';
    if (['js', 'ts', 'json', 'html', 'css', 'py', 'php', 'sh', 'bat', 'ps1', 'c', 'cpp', 'java', 'go', 'rs'].includes(ext)) return '\uD83D\uDCDD';
    if (['exe', 'msi', 'apk', 'deb', 'rpm'].includes(ext)) return '\u2699'; // ⚙
    if (['txt', 'md', 'log', 'nfo', 'ini', 'cfg', 'yaml', 'yml'].includes(ext)) return '\uD83D\uDCC4';
    return '\uD83D\uDCC4';
  };

  const kndFor = (it) => {
    if (it.isLink) return 'Link' + (it.target ? ' \u2192 ' + it.target : '');
    if (it.isDir) return 'Folder';
    const ext = (it.name.split('.').pop() || '').toLowerCase();
    if (it.name.includes('.') && !it.name.startsWith('.')) return ext.toUpperCase() + ' file';
    return 'File';
  };

  // ---------- toasts ----------
  const toasts = () => document.getElementById('toasts');
  function toast(msg, kind, ms) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    toasts().appendChild(t);
    setTimeout(() => t.remove(), ms || 3500);
  }

  // ---------- context menu ----------
  function menu(items, x, y) {
    const m = document.getElementById('ctxMenu');
    m.innerHTML = '';
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
      const row = document.createElement('div');
      row.className = 'mi';
      const label = document.createElement('span');
      label.textContent = it.label;
      row.appendChild(label);
      if (it.key) { const k = document.createElement('span'); k.className = 'k'; k.textContent = it.key; row.appendChild(k); }
      row.addEventListener('click', () => { hideMenu(); it.click && it.click(); });
      m.appendChild(row);
    }
    m.style.display = 'block';
    const r = m.getBoundingClientRect();
    let px = x, py = y;
    if (px + r.width > window.innerWidth - 8) px = window.innerWidth - r.width - 8;
    if (py + r.height > window.innerHeight - 8) py = window.innerHeight - r.height - 8;
    m.style.left = px + 'px'; m.style.top = py + 'px';
    setTimeout(() => {
      window.addEventListener('mousedown', hideMenuOnOutside, { once: true });
      window.addEventListener('blur', hideMenu, { once: true });
    });
  }
  function hideMenuOnOutside(e) {
    const m = document.getElementById('ctxMenu');
    if (!m.contains(e.target)) hideMenu();
    else window.addEventListener('mousedown', hideMenuOnOutside, { once: true });
  }
  function hideMenu() { document.getElementById('ctxMenu').style.display = 'none'; }

  // ---------- modal framework ----------
  // openModal({title, body: Node, buttons:[{label, primary, click}], width})
  function openModal(opts) {
    const root = document.getElementById('modalRoot');
    root.innerHTML = '';
    root.classList.add('on');
    const box = document.createElement('div');
    box.className = 'modal';
    if (opts.width) box.style.width = opts.width + 'px';
    const h = document.createElement('h2'); h.textContent = opts.title || ''; box.appendChild(h);
    const body = document.createElement('div'); body.className = 'm-body';
    if (opts.body) body.appendChild(opts.body);
    box.appendChild(body);
    const foot = document.createElement('div'); foot.className = 'm-foot';
    const btns = opts.buttons || [{ label: 'Close', click: closeModal }];
    for (const b of btns) {
      const el = document.createElement('button');
      if (b.primary) el.className = 'primary';
      el.textContent = b.label;
      el.addEventListener('click', () => b.click ? b.click() : closeModal());
      foot.appendChild(el);
    }
    box.appendChild(foot);
    root.appendChild(box);
    root.tabIndex = -1;
    setTimeout(() => { const f = box.querySelector('input,select,textarea'); f && f.focus(); });
    box._body = body;
    return box;
  }
  function closeModal() {
    const root = document.getElementById('modalRoot');
    root.classList.remove('on');
    root.innerHTML = '';
  }
  const modalOpen = () => document.getElementById('modalRoot').classList.contains('on');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideMenu(); if (modalOpen()) closeModal(); e.stopPropagation(); e.preventDefault(); }
  }, true);

  // airborne message box / prompt convenience
  function msgBox(title, text, buttons) {
    const body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;max-width:560px;';
    body.textContent = text;
    const btns = (buttons || ['OK']).map((label) => ({
      label,
      click: () => { closeModal(); resolveVal(label); }
    }));
    let resolveVal;
    const p = new Promise((resolve) => { resolveVal = resolve; });
    openModal({ title, body, buttons: btns });
    return p;
  }

  function promptBox(title, defVal, cb) {
    const body = document.createElement('div');
    const inp = document.createElement('input');
    inp.value = defVal || '';
    inp.style.width = '100%';
    body.appendChild(inp);
    const box = openModal({
      title,
      body,
      buttons: [
        { label: 'OK', primary: true, click: () => { const v = inp.value; closeModal(); cb && cb(v); } },
        { label: 'Cancel', click: closeModal }
      ]
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = inp.value; closeModal(); cb && cb(v); }
    });
    inp.select();
    return box;
  }

  window.ui = { fmtSize, fmtTime, fmtDate, iconFor, kndFor, toast, menu, hideMenu, openModal, closeModal, modalOpen, msgBox, promptBox };
})();
