'use strict';
// Transfer queue: sequential/parallel file transfers with resume,
// overwrite policies, pause/cancel, speed limit and progress events.
// Engine-agnostic: talks to session objects provided via ctx.getSession(sid).
//
// Session API contract (lib/ftp.js, lib/sftp.js):
//   isConn() -> bool
//   stat(path) -> {size, mtime, isDir} | null
//   mkdirp(path), list(path), remove(path, isDir), rename(from, to)
//   setTimes(path, mtimeSec)  // best effort
//   transfer(spec) -> { done: Promise, abort(): void }
//     spec = { direction:'up'|'dn', src, dst, size, mtime,
//              resumeOffset, throttleBytes,
//              onProgress(bytesAbsolute) }
//     done resolves -> {bytes} ; rejects on error/abort.

class Queue {
  constructor(ctx) {
    this.ctx = ctx; // { getSession, ensureSession, touch, settings, log }
    this.jobs = [];
    this.emit = (ev) => ctx && ctx.emit && ctx.emit(ev);
    this.globalPaused = false;
    this.askAllPolicy = null;   // 'overwrite' | 'skip' | 'resume' when user picks "apply to all"
    this.conns = new Map();     // active job id -> handle {abort}
    this.seq = 1;
  }

  // Resolve a usable session for a job:
  //  - reuse the stored sid if still connected,
  //  - else ask ctx.ensureSession (re-bind to same host or auto-reconnect).
  async getLiveSession(j) {
    const ctx = this.ctx;
    let ses = ctx.getSession(j.sid);
    if (ses && ses.isConn()) {
      if (typeof ctx.touch === 'function') ctx.touch(ses.id);
      return ses;
    }
    if (typeof ctx.ensureSession === 'function') {
      try { ses = await ctx.ensureSession(j); } catch (e) { ses = null; }
      if (ses && ses.isConn()) {
        j.sid = ses.id;
        if (typeof ctx.touch === 'function') ctx.touch(ses.id);
        return ses;
      }
    }
    return null;
  }

  nextId() { return 't' + (this.seq++); }

  // spec: {sid, dir:'up'|'dn', src, dst, isDir, size, mtime}
  add(specs) {
    const out = [];
    for (const s of specs) {
      const job = {
        id: this.nextId(), rootId: null,
        sid: s.sid, meta: s.meta || null, dir: s.dir, kind: s.isDir ? 'container' : 'file',
        src: s.src, dst: s.dst, name: baseName(s.dst),
        size: s.size || 0, mtime: s.mtime || 0,
        resumeOffset: 0, bytes: 0,
        state: 'queued', error: '', expanded: false,
        childTotal: 0, childDone: 0, startedAt: 0,
      };
      this.jobs.push(job);
      out.push(job);
      this.send('job', job);
    }
    this.pump();
    return out.map(j => j.id);
  }

  send(type, job) {
    this.emit({ type, job: snap(job) });
  }

  pause(id) {
    const j = this.jobs.find(x => x.id === id);
    if (j && j.state === 'queued') { j.state = 'paused'; this.send('job', j); }
  }
  resumeJob(id) {
    const j = this.jobs.find(x => x.id === id);
    if (j && j.state === 'paused') { j.state = 'queued'; this.send('job', j); this.pump(); }
  }
  pauseAll() {
    this.globalPaused = true;
    for (const j of this.jobs) if (j.state === 'queued') { j.state = 'paused'; this.send('job', j); }
  }
  resumeAll() {
    this.globalPaused = false;
    for (const j of this.jobs) if (j.state === 'paused') { j.state = 'queued'; this.send('job', j); }
    this.pump();
  }
  cancel(id) {
    const j = this.jobs.find(x => x.id === id);
    if (!j) return;
    if (j.state === 'queued' || j.state === 'paused' || j.state === 'starting') {
      j.state = 'canceled'; this.send('job', j); this.pump();
    } else if (j.state === 'active') {
      const h = this.conns.get(j.id);
      if (h) { try { h.abort(); } catch (e) { /* ignore */ } }
      j.state = 'canceling'; this.send('job', j);
    }
  }
  retry(id) {
    const j = this.jobs.find(x => x.id === id);
    if (!j || (j.state !== 'error' && j.state !== 'canceled')) return;
    j.state = 'queued'; j.error = ''; j.bytes = 0; j.resumeOffset = 0; j.expanded = false;
    j.childTotal = 0; j.childDone = 0;
    this.send('job', j);
    this.pump();
  }
  // Remove terminal jobs; force=true also cancels queued/paued.
  clear(force) {
    const hasActive = this.jobs.some(j => j.state === 'starting' || j.state === 'active' || j.state === 'canceling');
    if (!force && hasActive) return false;
    if (force) {
      for (const j of this.jobs) {
        if (j.state === 'queued' || j.state === 'paused') { try { this.cancel(j.id); } catch (e) { } }
      }
    }
    this.jobs = this.jobs.filter(j => !(j.state === 'done' || j.state === 'skipped' || j.state === 'error' || j.state === 'canceled' || j.state === 'canceling'));
    this.emit({ type: 'clear' });
    return true;
  }
  clearTerminal() {
    this.jobs = this.jobs.filter(j => !(j.state === 'done' || j.state === 'skipped'));
    this.emit({ type: 'clear' });
  }

  activeCount() { return this.jobs.filter(j => j.state === 'starting' || j.state === 'active' || j.state === 'canceling').length; }
  isBusy() { return this.jobs.some(j => j.state === 'starting' || j.state === 'active' || j.state === 'canceling' || j.state === 'queued'); }

  // ---- main pump ----
  pump() {
    if (this.globalPaused) return;
    const max = Math.max(1, Math.min(6, Number(this.ctx.settings().maxParallel) || 1));
    while (this.activeCount() < max) {
      const j = this.jobs.find(x => x.state === 'queued');
      if (!j) break;
      // Reserve the slot SYNCHRONOUSLY. startJob is async (session re-bind /
      // auto-reconnect awaits) and would otherwise not change the state until
      // the next microtask — the while loop would then pick the SAME job
      // forever and spiral into a synchronous OOM. (Crash on drag&drop fix.)
      j.state = 'starting';
      this.send('job', j);
      this.startJob(j).catch(() => { });
    }
  }

  async startJob(j) {
    if (this.globalPaused) { j.state = 'queued'; return; }
    // Resolve a session for this job. If the original sid died (tab closed,
    // reconnect, server drop) the queue re-binds to ANY live session for the
    // same host and, as a last resort, opens a fresh connection automatically.
    let ses = null;
    try { ses = await this.getLiveSession(j); } catch (e) { ses = null; }
    if (j.state !== 'starting') return;          // canceled while resolving
    if (!ses) {
      j.state = 'error'; j.error = 'session disconnected';
      this.send('job', j); this.pump(); this.maybeAllDone();
      return;
    }
    try {
      if (j.kind === 'container') {
        if (!j.expanded) { await this.expandDir(j, ses); if (j.expanded) return; // children enqueued; container waits
        }
        return; // finalization happens via child completion
      }
      await this.runFile(j, ses);
    } catch (e) {
      j.state = 'error'; j.error = String((e && e.message) || e);
      this.send('job', j);
      this.pump(); this.checkContainers(j); this.maybeAllDone();
    }
  }

  // Turn a container job into child jobs (inserted before it in queue order).
  async expandDir(j, ses) {
    j.expanded = true; // try marker; on failure reset
    let entries;
    try {
      entries = j.dir === 'dn'
        ? await ses.list(j.src)
        : await this.ctx.listLocal(j.src);
    } catch (e) {
      j.expanded = false;
      throw e;
    }
    j.rootId = j.rootId || j.id;
    const kids = [];
    for (const ent of entries) {
      const childSrc = j.dir === 'dn' ? joinPath(j.src, ent.name, true) : joinLocal(j.src, ent.name);
      const childDst = j.dir === 'dn' ? joinLocal(j.dst, ent.name) : joinPath(j.dst, ent.name, true);
      kids.push({
        id: this.nextId(), rootId: j.rootId,
        sid: j.sid, meta: j.meta, dir: j.dir, kind: ent.isDir ? 'container' : 'file',
        src: childSrc, dst: childDst, name: ent.name,
        size: ent.isDir ? 0 : (ent.size || 0), mtime: ent.mtime || 0,
        resumeOffset: 0, bytes: 0,
        state: 'queued', error: '', expanded: false,
        childTotal: 0, childDone: 0, startedAt: 0,
      });
    }
    // mkdir the target dir
    try {
      if (j.dir === 'dn') await this.ctx.ensureLocalDir(j.dst);
      else await ses.mkdirp(j.dst);
    } catch (e) { j.expanded = false; throw e; }
    const idx = this.jobs.findIndex(x => x.id === j.id);
    this.jobs.splice(idx, 0, ...kids);
    j.childTotal = kids.length; j.childDone = 0;
    j.state = 'parent'; // waiting for children
    j.size = 0; j.bytes = 0; j.parentAgg = { bytes: 0, size: 0 };
    for (const k of kids) if (k.kind === 'container') k.rootId = j.rootId;
    for (const k of kids) this.send('job', k);
    this.send('job', j);
    this.pump();
  }

  async runFile(j, ses) {
    j.state = 'active'; j.error = ''; j.startedAt = Date.now();
    this.send('job', j);

    const st = this.ctx.settings();
    const throttleBytes = Math.max(0, Number(st.speedLimit) || 0) * 1024;

    if (!j.rootId) {
      // decide resume/overwrite only for top-level (non-dir-expanded) files;
      // tree transfers inherit "resume" semantics per child by direct size check below
      await this.resolvePolicy(j, ses, st);
      if (j.state !== 'active') return; // policy set terminal state (skip/done)
    }

    // For tree children: implicit resume semantics (sizes known from listing)
    if (j.rootId && st.resume && j.size > 0) {
      try {
        const dstStat = j.dir === 'dn' ? await this.ctx.statLocal(j.dst) : await ses.stat(j.dst);
        if (dstStat && !dstStat.isDir && dstStat.size === j.size) {
          j.state = 'skipped'; j.bytes = j.size;
          this.send('job', j); this.finishChild(j); return;
        } else if (dstStat && !dstStat.isDir && dstStat.size < j.size) {
          j.resumeOffset = dstStat.size;
        }
      } catch (e) { /* fallthrough fresh copy */ }
    }

    const handle = ses.transfer({
      direction: j.dir, src: j.src, dst: j.dst,
      size: j.size, mtime: j.mtime,
      resumeOffset: j.resumeOffset || 0,
      throttleBytes,
      onProgress: (bytes) => {
        const clamped = Math.max(0, Math.min(bytes, j.size || bytes));
        if (clamped !== j.bytes) {
          j.bytes = clamped;
          // throttle UI events: at most ~10/s per job (progress bookkeeping
          // streams at chunk speed otherwise and floods both processes)
          const now = Date.now();
          if (now - (j.lastProgSent || 0) >= 100) { j.lastProgSent = now; this.send('progress', j); }
        }
      }
    });
    this.conns.set(j.id, handle);
    try {
      const res = await handle.done;
    } finally {
      this.conns.delete(j.id);
    }

    // restore times (best effort)
    if (st.preserveTimes && j.mtime > 0) {
      try {
        if (j.dir === 'dn') await this.ctx.utimesLocal(j.dst, j.mtime);
        else await ses.setTimes(j.dst, j.mtime);
      } catch (e) { /* ignore */ }
    }

    // verify size
    try {
      const v = j.dir === 'dn' ? await this.ctx.statLocal(j.dst) : await ses.stat(j.dst);
      if (v && j.size > 0 && v.size !== j.size) throw new Error(`size mismatch (${v.size} != ${j.size})`);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // If the transfer itself completed (all bytes sent) and only the
      // verification stat failed because the connection dropped, don't
      // punish the job — it is done as far as we can tell.
      const dropped = /not connected|disconnected|closed/i.test(msg);
      if (dropped && j.size > 0 && j.bytes >= j.size) {
        j.bytes = j.size; j.state = 'done'; this.send('job', j);
        this.finishChild(j); this.pump(); this.maybeAllDone();
        return;
      }
      j.state = 'error'; j.error = 'verify: ' + msg;
      this.send('job', j); this.finishChild(j); this.pump(); this.maybeAllDone();
      return;
    }

    j.bytes = j.size || j.bytes;
    j.state = 'done'; this.send('job', j);
    this.finishChild(j);
    this.pump(); this.maybeAllDone();
  }

  async resolvePolicy(j, ses, st) {
    if (j.resumeOffset > 0) return; // explicit resume request from UI
    let dstStat = null;
    try {
      dstStat = j.dir === 'dn' ? await this.ctx.statLocal(j.dst) : await ses.stat(j.dst);
    } catch (e) { dstStat = null; }
    if (!dstStat) return; // target missing -> fresh copy

    const policy = this.askAllPolicy || st.askOverwrite; // 'ask'|'skip'|'overwrite'|'resume'
    if (policy === 'resume') {
      if (dstStat.size === j.size && j.size > 0) { j.state = 'skipped'; this.send('job', j); return; }
      if (dstStat.size < j.size) { j.resumeOffset = dstStat.size; return; }
      return; // dst bigger -> fresh copy
    }
    if (policy === 'skip') {
      if (j.size > 0 && dstStat.size === j.size) { j.state = 'skipped'; this.send('job', j); }
      else { j.state = 'error'; j.error = 'target exists'; this.send('job', j); }
      return;
    }
    if (policy === 'overwrite') {
      if (j.size > 0 && dstStat.size === j.size) { j.state = 'skipped'; this.send('job', j); return; }
      return; // fresh copy
    }
    // ask renderer
    const answer = await new Promise((resolve) => {
      this.emit({
        type: 'ask', id: j.id,
        fileName: j.name, newSize: j.size, newMtime: j.mtime,
        curSize: dstStat.size, curMtime: dstStat.mtime || 0, isDir: dstStat.isDir,
        reply: resolve
      });
    });
    if (!answer || answer.action === 'cancel') {
      j.state = 'canceled'; j.error = 'canceled by user';
      this.send('job', j); return;
    }
    if (answer.applyAll) this.askAllPolicy = answer.action;
    if (answer.action === 'skip') {
      j.state = 'skipped'; this.send('job', j); return;
    }
    if (answer.action === 'resume' && dstStat.size < j.size) { j.resumeOffset = dstStat.size; return; }
    if (answer.action === 'rename') {
      // renderer computed a new destination
      j.dst = answer.newDst || j.dst; j.name = baseName(j.dst);
      return; // fresh copy to new name
    }
    // overwrite -> fresh copy
  }

  finishChild(j) {
    if (!j.rootId) return;
    const root = this.jobs.find(x => x.rootId === null && x.id === j.rootId);
    if (!root) return;
    root.childDone = (root.childDone || 0) + 1;
    if (root.parentAgg) { root.parentAgg.size += (j.size || 0); root.parentAgg.bytes += (j.state === 'done' || j.state === 'skipped' ? (j.size || 0) : 0); }
    root.size = root.parentAgg.size; root.bytes = root.parentAgg.bytes;
    this.send('job', root);
    if (root.childDone >= root.childTotal) this.finalizeContainer(root);
  }

  finalizeContainer(root) {
    const kids = this.jobs.filter(x => x.rootId === root.rootId);
    if (kids.some(k => k.state === 'error')) { root.state = 'error'; root.error = 'some files failed'; }
    else if (kids.every(k => k.state === 'skipped')) { root.state = 'skipped'; }
    else root.state = 'done';
    root.bytes = root.parentAgg?.bytes || 0; root.size = root.parentAgg?.size || 0;
    this.send('job', root);
    this.pump(); this.maybeAllDone();
  }

  checkContainers(changedJob) {
    // called after child terminal states to advance parents
    if (!changedJob.rootId) return;
  }

  maybeAllDone() {
    if (!this.isBusy()) { this.askAllPolicy = null; this.emit({ type: 'allDone' }); }
  }

  // Called by main when a session died. Queued jobs are NOT failed here —
  // they will attach to a live session (or auto-reconnect) when their turn
  // comes in startJob. Only a transfer in progress gets aborted.
  sessionDown(sid) {
    for (const j of this.jobs) {
      if (j.sid !== sid) continue;
      if (j.state === 'active') {
        const h = this.conns.get(j.id);
        if (h) { try { h.abort(); } catch (e) { } }
        j.state = 'canceling'; this.send('job', j);
      }
    }
  }
}

function snap(j) {
  return {
    id: j.id, rootId: j.rootId, sid: j.sid, dir: j.dir, kind: j.kind,
    name: j.name, src: j.src, dst: j.dst, size: j.size, bytes: j.bytes,
    resumeOffset: j.resumeOffset,
    state: j.state, error: j.error,
    childTotal: j.childTotal, childDone: j.childDone
  };
}

function baseName(p) {
  if (!p) return '';
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}
// Server paths always POSIX; join and normalize duplicate slashes.
function joinPath(base, name, ensureSlash) {
  let b = String(base || '').replace(/\\/g, '/');
  if (!b.endsWith('/')) b += '/';
  return b + String(name).replace(/^[\\/]+/, '');
}
function joinLocal(base, name) {
  const path = require('path');
  return path.join(base || '', name);
}

module.exports = { Queue };
