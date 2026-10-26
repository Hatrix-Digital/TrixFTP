'use strict';
// FilePane: list view for one side (local or remote) with sorting,
// filtering, selection, drag&drop and double-click navigation.
(function () {
  const fmtSize = window.ui.fmtSize;
  const fmtDate = window.ui.fmtDate;
  const iconFor = window.ui.iconFor;

  class FilePane {
    constructor(rootRoot, side, hooks) {
      // hooks: { navigate(side, path), runAction(side, act, item, items), onSelection(side), onFilter() }
      this.side = side;
      this.hooks = hooks;
      this.el = rootRoot;
      this.list = rootRoot.querySelector('.flist');
      this.pathInput = rootRoot.querySelector('.path-input');
      this.filterInput = rootRoot.querySelector('.filter-input');
      this.foot = rootRoot.querySelector('.pane-foot');
      this.colsHead = rootRoot.querySelector('.cols-head');
      this.driveSelect = rootRoot.querySelector('#localDrives') || null; // only local

      this.path = side === 'local' ? '' : '';
      this.items = [];
      this.selected = new Set();
      this.anchor = null;
      this.sortCol = 'name';
      this.sortDir = 1;
      this.showHidden = false;
      this.filter = '';
      this.compareMode = false;
      this.markMap = null; // name -> 'diff'|'left'|'right'|'ident'

      this._bind();
    }

    _bind() {
      this.colsHead.querySelectorAll('div[data-col]').forEach(col => {
        col.addEventListener('click', () => {
          const c = col.dataset.col;
          if (this.sortCol === c) this.sortDir *= -1;
          else { this.sortCol = c; this.sortDir = 1; }
          this.hooks.onSort && this.hooks.onSort();
          this.render();
        });
        col.dataset.sortCol = col.dataset.col;
      });
      this.pathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.hooks.navigate(this.side, this.pathInput.value, { fromInput: true });
      });
      this.filterInput.addEventListener('input', () => {
        this.filter = this.filterInput.value.trim().toLowerCase();
        this.render();
      });
      this.filterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { this.filterInput.value = ''; this.filter = ''; this.render(); this.filterInput.blur(); }
      });
      this.list.addEventListener('dragstart', (e) => this.onDragStart(e));
      this.list.addEventListener('dragover', (e) => {
        this.hooks.dragOver && this.hooks.dragOver(e, this.side);
      });
      this.list.addEventListener('dragleave', (e) => {
        this.list.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
      });
      this.list.addEventListener('drop', (e) => {
        this.list.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
        this.hooks.dropOn && this.hooks.dropOn(e, this.side, e.target.closest('.row'));
      });

      // list interactions
      this.list.addEventListener('mousedown', (e) => this.onMouseDown(e));
      this.list.addEventListener('dblclick', (e) => this.onDoubleClick(e));
      this.list.addEventListener('contextmenu', (e) => this.onContext(e));
      this.list.addEventListener('keydown', (e) => this.onKeyDown(e));
    }

    // ---------- data ----------
    setPath(p) {
      this.path = p;
      this.pathInput.value = p;
    }
    async setItems(items, { keepSelection = true } = {}) {
      const oldSel = keepSelection ? this.selected : null;
      this.items = items;
      this.selected = new Set();
      if (oldSel) for (const it of items) {
        const idx = items.indexOf(it);
        if (oldSel.has(it.name)) this.selected.add(it.name);
      }
      this.render();
    }
    refresh() { this.hooks.navigate(this.side, this.path, { refreshFlag: true }); }

    visibleItems() {
      let arr = this.items.filter(it => {
        if (!this.showHidden && it.name.startsWith('.')) return false;
        if (this.filter && !it.name.toLowerCase().includes(this.filter)) return false;
        return true;
      });
      const mul = this.sortDir;
      const col = this.sortCol;
      arr.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        let r = 0;
        if (col === 'name') r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        else if (col === 'size') r = (a.size || 0) - (b.size || 0);
        else if (col === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
        else r = window.ui.kndFor(a).localeCompare(window.ui.kndFor(b));
        return r * mul;
      });
      return arr;
    }

    // ---------- render ----------
    render() {
      this.list.innerHTML = '';
      // parent row
      const parent = document.createElement('div');
      parent.className = 'row parent';
      const pn = document.createElement('div'); pn.className = 'f-name';
      const pi = document.createElement('span'); pi.className = 'f-ico'; pi.textContent = '\u2B71'; // ⭱
      const pt = document.createElement('span'); pt.className = 'txt'; pt.textContent = ' .. (parent folder)';
      pn.appendChild(pi); pn.appendChild(pt);
      parent.appendChild(pn);
      parent.dataset.path = parentPath(this.path);
      parent.dataset.parent = '1';
      this.list.appendChild(parent);

      const items = this.visibleItems();
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'row' + (this.selected.has(it.name) ? ' selected' : '');
        row.dataset.name = it.name;
        row.dataset.isDir = it.isDir ? '1' : '';
        const mark = this.compareMode && this.markMap ? this.markMap.get(it.name) : null;
        if (mark) row.classList.add('mark-' + mark);

        const n = document.createElement('div'); n.className = 'f-name';
        const i = document.createElement('span'); i.className = 'f-ico'; i.textContent = iconFor(it.isDir, it.isLink, it.name);
        const t = document.createElement('span'); t.className = 'txt'; t.textContent = it.name;
        n.appendChild(i); n.appendChild(t);
        if (it.isLink) row.classList.add('link-arrow');

        const s = document.createElement('div'); s.className = 'f-size';
        s.textContent = it.isDir ? '<DIR>' : fmtSize(it.size);
        const m = document.createElement('div'); m.className = 'f-mtime'; m.textContent = fmtDate(it.mtime);
        const k = document.createElement('div'); k.className = 'f-kind'; k.textContent = window.ui.kndFor(it);
        n.title = it.name + (it.target ? ' \u2192 ' + it.target : '');
        row.appendChild(n); row.appendChild(s); row.appendChild(m); row.appendChild(k);
        this.list.appendChild(row);
      }
      this.renderFoot(items);
    }

    renderFoot(items) {
      const all = this.items.slice().filter(i => !this.filter || i.name.toLowerCase().includes(this.filter));
      const selBytes = this.getSelection(items).reduce((a, i) => a + (i.isDir ? 0 : (i.size || 0)), 0);
      const allBytes = all.reduce((a, i) => a + (i.isDir ? 0 : (i.size || 0)), 0);
      const dirCount = all.filter(i => i.isDir).length;
      const fileCount = all.length - dirCount;
      this.foot.textContent =
        `${all.length} items (${dirCount} folders, ${fileCount} files) | ${fmtSize(allBytes)} | ` +
        `${this.selected.size} selected (${fmtSize(selBytes)})`;
      if (window.onPaneFootChanged) window.onPaneFootChanged(this.side, this.foot.textContent);
    }

    // ---------- selection ----------
    getSelection(items) {
      const src = items || this.visibleItems();
      return src.filter(it => this.selected.has(it.name));
    }
    selectOnly(row) { this.selected.clear(); if (row && row.dataset.name) { this.selected.add(row.dataset.name); this.anchor = row.dataset.name; } }
    toggleSelect(row, additive) {
      const nm = row.dataset.name; if (!nm || row.dataset.parent) return;
      if (additive) {
        if (this.selected.has(nm)) this.selected.delete(nm); else this.selected.add(nm);
        this.anchor = nm;
      } else {
        if (this.selected.size === 1 && this.selected.has(nm)) { this.selected.clear(); } // toggle off = deselect
        else this.selectOnly(row);
      }
    }
    selectRange(aName, bName) {
      const items = this.visibleItems();
      const ia = items.findIndex(i => i.name === aName);
      const ib = items.findIndex(i => i.name === bName);
      if (ia < 0 || ib < 0) return;
      const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
      this.selected.clear();
      for (let x = lo; x <= hi; x++) this.selected.add(items[x].name);
      this.anchor = bName;
    }
    selectAll() {
      for (const it of this.visibleItems()) if (!it.isParent) this.selected.add(it.name);
      this.render();
    }
    invertSelection() {
      for (const it of this.visibleItems()) {
        if (this.selected.has(it.name)) this.selected.delete(it.name); else this.selected.add(it.name);
      }
      this.render();
    }

    onMouseDown(e) {
      const row = e.target.closest('.row');
      if (e.button === 0 || e.button === 2) {
        if (e.button === 2 && row && this.selected.has(row.dataset.name)) { /* keep selection for context menu */ }
        else if (row) {
          if (e.shiftKey && this.anchor) this.selectRange(this.anchor, row.dataset.name);
          else if (e.ctrlKey || e.metaKey) this.toggleSelect(row, true);
          else this.selectOnly(row);
        } else {
          this.selected.clear();
        }
        // update selection visuals IN PLACE (do not rebuild the DOM —
        // a rebuild between the two clicks would swallow the dblclick event)
        for (const r of this.list.querySelectorAll('.row')) {
          r.classList.toggle('selected', !!(r.dataset.name && this.selected.has(r.dataset.name)));
        }
        this.renderFoot(this.visibleItems());
        this.hooks.onSelection && this.hooks.onSelection(this.side);
      }
      this.list.focus({ preventScroll: true });
    }

    onDoubleClick(e) {
      const row = e.target.closest('.row');
      if (!row) return;
      const p = row.dataset.path || (this.pathJoin(row.dataset.name));
      if (row.dataset.parent || row.dataset.isDir) this.hooks.navigate(this.side, p);
      else this.hooks.runAction(this.side, 'open', { name: row.dataset.name });
    }

    onContext(e) {
      e.preventDefault();
      const row = e.target.closest('.row');
      if (row && !this.selected.has(row.dataset.name)) {
        if (e.ctrlKey) { this.toggleSelect(row, true); }
        else if (row.dataset.parent) this.selectOnly(null);
        else this.selectOnly(row);
        this.render();
        this.hooks.onSelection && this.hooks.onSelection(this.side);
      }
      this.hooks.onSelection && this.hooks.onSelection(this.side);
      window.app && window.app.showPaneMenu(this.side, e.clientX, e.clientY);
    }

    onKeyDown(e) {
      // type-ahead: typing letters jumps to items whose name starts with
      // the typed prefix (like Windows Explorer). Same letter pressed again
      // cycles to the next match; a short burst of letters accumulates.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this.typeAhead(e)) { e.preventDefault(); return; }
      }
      const items = this.visibleItems();
      const names = items.map(i => i.name);
      const cur = [...this.selected].pop() || names[0];
      const idx = names.indexOf(cur);
      const move = (d, additive) => {
        const ni = Math.max(0, Math.min(names.length - 1, (idx === -1 ? 0 : idx) + d));
        const row = this.list.querySelectorAll('.row:not(.parent)')[ni];
        if (!row) return;
        if (additive) this.toggleSelect(row, true);
        else this.selectOnly(row);
        row.scrollIntoView({ block: 'nearest' });
        this.render();
        this.hooks.onSelection && this.hooks.onSelection(this.side);
      };
      if (e.key === 'ArrowDown') { move(1, e.shiftKey || e.ctrlKey); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { move(-1, e.shiftKey || e.ctrlKey); e.preventDefault(); }
      else if (e.key === 'Home') { move(-1e9, e.shiftKey); e.preventDefault(); }
      else if (e.key === 'End') { move(1e9, e.shiftKey); e.preventDefault(); }
      else if (e.key === 'Enter') {
        const row = this.rowOf(cur);
        if (row) { if (row.dataset.isDir || row.dataset.parent) this.hooks.navigate(this.side, row.dataset.path || this.pathJoin(cur)); else this.hooks.runAction(this.side, 'open', { name: cur }); }
        e.preventDefault();
      } else if (e.key === 'Backspace') {
        this.hooks.navigate(this.side, parentPath(this.path), { refreshFlag: true });
        e.preventDefault();
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { this.selectAll(); e.preventDefault(); }
      else if (e.key === 'F5') { this.hooks.navigate(this.side, this.path, { refreshFlag: true }); e.preventDefault(); }
      else if (e.key === 'F2') { if (cur) this.hooks.runAction(this.side, 'rename', { name: cur }); e.preventDefault(); }
      else if (e.key === 'Delete') { const sel = this.getSelection(); if (sel.length) this.hooks.runAction(this.side, 'delete', { names: sel.map(i => i.name) }); e.preventDefault(); }
    }

    rowOf(name) {
      return [...this.list.querySelectorAll('.row')].find(r => r.dataset.name === name);
    }

    // Explorer-style keyboard search. Returns true when the key was consumed.
    typeAhead(e) {
      if (e.key === ' ') e.preventDefault(); // keep page scrolling off
      const ch = e.key.toLowerCase();
      const now = Date.now();
      // repeated same letter (within window) -> cycle: restart buffer with 1 char
      if (this._taLast === ch && now - (this._taLastAt || 0) < 800) this._taBuf = ch;
      else this._taBuf = (this._taBuf || '') + ch;
      this._taLast = ch; this._taLastAt = now;
      clearTimeout(this._taTimer);
      this._taTimer = setTimeout(() => { this._taBuf = ''; }, 800);

      const cards = this.visibleItems();
      const names = cards.map(i => i.name.toLowerCase());
      if (!names.length) return true;
      const cur = String([...this.selected].pop() || '').toLowerCase();
      const curIdx = names.indexOf(cur);
      const start = curIdx < 0 ? 0 : curIdx + 1; // search after current, wrap around
      let hit = -1;
      for (let off = 0; off < names.length; off++) {
        const i = (start + off) % names.length;
        if (names[i].startsWith(this._taBuf)) { hit = i; break; }
      }
      if (hit < 0) return true; // nothing matches; keep focus in pane
      const name = cards[hit].name;
      this.selected.clear(); this.selected.add(name); this.anchor = name;
      // update visuals in place (no DOM rebuild)
      for (const r of this.list.querySelectorAll('.row')) {
        r.classList.toggle('selected', !!(r.dataset.name && this.selected.has(r.dataset.name)));
      }
      const row = this.rowOf(name);
      if (row) row.scrollIntoView({ block: 'nearest' });
      this.renderFoot(this.visibleItems());
      this.hooks.onSelection && this.hooks.onSelection(this.side);
      return true;
    }

    pathJoin(name) {
      if (!name) return this.path;
      if (this.side === 'local') {
        const sep = window.__isWin ? '\\' : '/';
        const base = this.path.replace(/[\\/]+$/, '');
        return base ? base + sep + name : name;
      }
      return this.path.replace(/\/+$/, '') + '/' + name;
    }
    itemCount() { return this.items.length; }

    // drag source for rows
    onDragStart(e) {
      const row = e.target.closest('.row');
      if (!row) { e.preventDefault(); return; }
      if (!this.selected.has(row.dataset.name) && !row.dataset.parent) { e.preventDefault(); return; }
      const sel = this.getSelection();
      const paths = sel.length ? sel.map(i => this.pathJoin(i.name)) : [];
      if (!paths.length) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/trix-transfer', JSON.stringify({ side: this.side, paths }));
      e.dataTransfer.setData('text/plain', paths[0]);
      e.dataTransfer.effectAllowed = 'copy';
    }
    dragPayload(e) {
      const sel = this.getSelection();
      const paths = sel.map(i => this.pathJoin(i.name));
      return paths.length ? paths : (e.target.closest('.row') ? [this.pathJoin(e.target.closest('.row').dataset.name)] : []);
    }
  }

  function parentPath(p) {
    if (!p) return p;
    if (p === '/') return '/';
    let pp = p.replace(/[\\/]+$/, '');
    const i = Math.max(pp.lastIndexOf('\\'), pp.lastIndexOf('/'));
    if (i <= 0) {
      if (i === 0) return pp[0];
      return /[A-Za-z]:/.test(pp) ? pp.slice(0, 2) + (pp[2] ? '' : '') : '/';
    }
    return pp.slice(0, i === 0 ? 1 : i);
  }

  window.FilePane = FilePane;
  window.parentPathFallback = parentPath;
})();
