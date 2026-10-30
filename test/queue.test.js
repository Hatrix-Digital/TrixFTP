'use strict';
// Regression test for the pump OOM bug: async startJob must not let the
// while-loop in pump() re-pick the same queued job forever, and jobs must
// still complete (incl. dead-session -> auto-reconnect path).
const { Queue } = require('../lib/queue.js');

let live = { id: 'dead-sid', isConn: () => true }; // placeholder, dies below

function mkQueue(opts) {
  const transfers = [];
  const q = new Queue({
    settings: () => ({ maxParallel: opts.maxParallel || 2, speedLimit: 0, resume: false, preserveTimes: false, askOverwrite: 'overwrite' }),
    getSession: (sid) => (live.id === sid && live.isConn() ? live : null),
    ensureSession: async (j) => {
      if (opts.reconnect) {
        live = { id: 'reborn-' + (++opts.reborn || (opts.reborn = 1)), isConn: () => true };
        return live;
      }
      return null;
    },
    statLocal: async () => null,
    ensureLocalDir: async () => { },
    utimesLocal: async () => { },
    listLocal: async () => [{ name: 'a.txt', isDir: false, size: 10, mtime: 0 }],
    emit: (ev) => { if (ev.type === 'ask' && typeof ev.reply === 'function') ev.reply({ action: 'skip', applyAll: true }); },
    touch: () => { },
  });
  q.engine = {
    transfer: async (spec) => {
      transfers.push(spec.src);
      await new Promise(r => setTimeout(r, 5));
      spec.onProgress(spec.size);
      return { bytes: spec.size };
    },
  };
  // queue talks to "session" objects: wrap live additions
  const addLive = (id) => { const s = { id, isConn: opts.liveIsConn !== false ? () => true : () => false, transfer: q.engine.transfer, stat: async () => null, list: async () => [], mkdirp: async () => { }, setTimes: async () => { } }; live = s; return s; };
  return { q, transfers, addLive };
}

(async () => {
  const out = { pass: true, checks: [] };
  const check = (name, cond) => { out.checks.push({ name, cond: !!cond }); if (!cond) out.pass = false; };

  // 1) normal flow with maxParallel 3 and many jobs — must finish, not hang
  {
    const ctxv = mkQueue({ maxParallel: 3 });
    ctxv.addLive('s1');
    const timeout = setTimeout(() => { console.log(JSON.stringify({ fail: 'TIMEOUT: pump stuck' })); process.exit(1); }, 15000);
    const ids = ctxv.q.add([1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ sid: 's1', dir: 'up', src: 'f' + i, dst: '/f' + i, isDir: false, size: 100, mtime: 0 })));
    await new Promise(r => setTimeout(r, 1500));
    const states = ctxv.q.jobs.map(j => j.state);
    check('all jobs done (parallel, no infinite pump)', states.every(s => s === 'done'));
    check('every job transferred exactly once', ctxv.transfers.length === 8);
  }

  // 1b) a connection-loss error during the transfer is retried once, then succeeds
  {
    const ctxv = mkQueue({ maxParallel: 1 });
    const s1 = ctxv.addLive('s1');
    let calls = 0;
    const realTransfer = ctxv.q.engine.transfer;
    s1.transfer = (spec) => {
      calls++;
      if (calls === 1) {
        return { done: Promise.reject(new Error('Client is closed because User closed client during task')), abort() { } };
      }
      return realTransfer(spec);
    };
    ctxv.q.add([{ sid: 's1', dir: 'up', src: 'retry.bin', dst: '/retry.bin', isDir: false, size: 10, mtime: 0 }]);
    await new Promise(r => setTimeout(r, 500));
    check('connection-loss error -> job retried and done', ctxv.q.jobs.length === 1 && ctxv.q.jobs[0].state === 'done',
      JSON.stringify(ctxv.q.jobs.map(j => j.state + ':' + j.error)));
    check('retry transferred twice (fail + success)', calls === 2, 'calls=' + calls);
  }

  // 1c) jobs skipped by the conflict policy must not stall the pump
  {
    const ctxv = mkQueue({ maxParallel: 2 });
    const s1 = ctxv.addLive('s1');
    s1.stat = async () => ({ exists: true, isDir: false, size: 100, mtime: 0 });
    ctxv.q.add([1, 2, 3, 4, 5, 6].map(i => ({ sid: 's1', dir: 'up', src: 'sk' + i, dst: '/sk' + i, isDir: false, size: 100, mtime: 0 })));
    await new Promise(r => setTimeout(r, 800));
    check('skipped jobs do not stall the pump', ctxv.q.jobs.length === 6 && ctxv.q.jobs.every(j => j.state === 'skipped'),
      JSON.stringify(ctxv.q.jobs.map(j => j.state)));
    check('skipped jobs never transferred', ctxv.transfers.length === 0, 'transfers=' + ctxv.transfers.length);
  }

  // 2) dead session + ensureSession unavailable -> job errors, no hang
  {
    const ctxv = mkQueue({ maxParallel: 2, reconnect: false });
    ctxv.addLive('s1'); // then kill it
    const deadMark = { isConn: () => false }; // simulate the server dropping it
    const oldIsConn = live.isConn;
    live.isConn = deadMark.isConn;
    ctxv.q.add([{ sid: 's1', dir: 'up', src: 'x', dst: '/x', isDir: false, size: 10, mtime: 0 }]);
    await new Promise(r => setTimeout(r, 300));
    check('dead session -> error (no hang)', ctxv.q.jobs.every(j => j.state === 'error'));
  }

  // 3) dead session + auto-reconnect -> transfer succeeds on new session
  {
    const ctxv = mkQueue({ maxParallel: 2, reconnect: true });
    ctxv.addLive('s1');
    ctxv.q.getSession = (sid) => null; // original session gone
    ctxv.q.add([{ sid: 's1', dir: 'up', src: 'y', dst: '/y', isDir: false, size: 10, mtime: 0, meta: { host: 'h', user: 'u', proto: 'ftp', cfg: {} } }]);
    await new Promise(r => setTimeout(r, 800));
    check('auto-reconnect -> all done', ctxv.q.jobs.every(j => j.state === 'done'));
  }

  // 4) mixed: directory upload (container + children)
  {
    const ctxv = mkQueue({ maxParallel: 2 });
    ctxv.addLive('s1');
    ctxv.q.add([{ sid: 's1', dir: 'up', src: 'D', dst: '/D', isDir: true, size: 0, mtime: 0 }]);
    await new Promise(r => setTimeout(r, 600));
    check('dir upload completes', ctxv.q.jobs.every(j => j.state === 'done' || j.state === 'parent' || j.state === 'skipped'));
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
