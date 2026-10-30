'use strict';
// Regression test for the "cannot upload several files at once" bug.
//
// Two queue jobs used to call stat()/mkdirp()/verify through the same FTP
// session at the same time. basic-ftp allows only one task per control
// connection and closes the client with "User launched a task while another
// one is still running", so every extra parallel job failed with
// "Client is closed because ..." / "session disconnected".
//
// Run: node test/parallel.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FtpSrv } = require('ftp-srv');
const { FtpEngine } = require('../lib/ftp');
const { Queue } = require('../lib/queue');

const PORT = 22125;
const ROOT = path.join(os.tmpdir(), 'trixftp-par-' + Date.now());
const LOCAL = path.join(ROOT, 'local');
const REMOTE = path.join(ROOT, 'remote');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.error('  [FAIL] ' + name + (extra ? '  -- ' + extra : '')); }
}

function mkSettings(over) {
  return Object.assign({
    maxParallel: 3, speedLimit: 0, resume: false, preserveTimes: false,
    askOverwrite: 'overwrite', keepAlive: true, verifyTls: false
  }, over || {});
}

async function main() {
  fs.mkdirSync(LOCAL, { recursive: true });
  fs.mkdirSync(REMOTE, { recursive: true });

  const server = new FtpSrv({
    url: `ftp://0.0.0.0:${PORT}`, pasv_url: () => '127.0.0.1',
    pasv_min: 10410, pasv_max: 10460, anonymous: true, logLevel: 'error'
  });
  server.on('login', (data, resolve) => resolve({ root: REMOTE }));
  await server.listen();
  await new Promise(r => setTimeout(r, 400));

  const settings = mkSettings();
  const sessions = new Map();
  const errors = [];
  const engine = new FtpEngine({
    proto: 'ftp', host: '127.0.0.1', port: PORT, user: 'anon', password: 'x', timeoutSec: 10
  }, {
    log: () => { },
    onClose: () => { },
    settings: () => settings
  });
  await engine.init();
  sessions.set(engine.id, engine);

  const q = new Queue({
    settings: () => settings,
    getSession: (sid) => sessions.get(sid) || null,
    ensureSession: async () => null,
    statLocal: async (p) => {
      try { const s = fs.statSync(p); return { exists: true, isDir: s.isDirectory(), size: s.size, mtime: Math.floor(s.mtimeMs / 1000) }; }
      catch (e) { return null; }
    },
    ensureLocalDir: async (p) => fs.mkdirSync(p, { recursive: true }),
    utimesLocal: async () => { },
    listLocal: async (p) => fs.readdirSync(p, { withFileTypes: true }).map(d => {
      const st = fs.statSync(path.join(p, d.name));
      return { name: d.name, isDir: d.isDirectory(), size: d.isDirectory() ? 0 : st.size, mtime: Math.floor(st.mtimeMs / 1000) };
    }),
    emit: (ev) => {
      if (ev.type === 'job' && ev.job.state === 'error') errors.push(ev.job.name + ': ' + ev.job.error);
    },
    touch: () => { }
  });

  async function waitIdle(ms) {
    const t0 = Date.now();
    while (q.isBusy() && Date.now() - t0 < (ms || 30000)) await new Promise(r => setTimeout(r, 50));
  }

  // ---- 1) parallel file uploads (the reported bug) ----
  console.log('== 1) 8 files, maxParallel 3 ==');
  const files = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(LOCAL, 'f' + i + '.bin');
    fs.writeFileSync(p, Buffer.alloc(384 * 1024 + i * 7, i));
    files.push(p);
  }
  q.add(files.map(p => ({
    sid: engine.id, dir: 'up', src: p, dst: '/' + path.basename(p),
    isDir: false, size: fs.statSync(p).size, mtime: 0
  })));
  await waitIdle();
  ok('all 8 jobs done', q.jobs.every(j => j.state === 'done'), JSON.stringify(q.jobs.map(j => j.state)));
  ok('no job errors', errors.length === 0, errors.join(' | '));
  ok('all remote sizes correct', files.every(p => {
    const st = fs.statSync(path.join(REMOTE, path.basename(p)));
    return st.size === fs.statSync(p).size;
  }));

  // ---- 2) UI traffic (list/stat) while transfers run ----
  console.log('== 2) listing/stat during parallel transfers ==');
  errors.length = 0;
  q.clearTerminal();
  const big = [];
  for (let i = 0; i < 4; i++) {
    const p = path.join(LOCAL, 'big' + i + '.bin');
    fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024, i));
    big.push(p);
  }
  q.add(big.map(p => ({
    sid: engine.id, dir: 'up', src: p, dst: '/' + path.basename(p),
    isDir: false, size: fs.statSync(p).size, mtime: 0
  })));
  const uiErrors = [];
  const uiWork = [];
  for (let i = 0; i < 12; i++) {
    uiWork.push(engine.list('/').catch(e => uiErrors.push('list: ' + e.message)));
    uiWork.push(engine.stat('/big0.bin').catch(e => uiErrors.push('stat: ' + e.message)));
  }
  await Promise.all(uiWork);
  await waitIdle(60000);
  ok('transfers finished while UI was polling', q.jobs.every(j => j.state === 'done'), JSON.stringify(q.jobs.map(j => j.state)));
  ok('no UI call errors', uiErrors.length === 0, uiErrors.join(' | '));
  ok('no job errors during polling', errors.length === 0, errors.join(' | '));

  // ---- 3) directory upload (container + children) ----
  console.log('== 3) directory upload with a nested folder ==');
  errors.length = 0;
  q.clearTerminal();
  const tree = path.join(LOCAL, 'tree');
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'a.txt'), 'A'.repeat(1000));
  fs.writeFileSync(path.join(tree, 'b.txt'), 'B'.repeat(2000));
  fs.writeFileSync(path.join(tree, 'sub', 'c.txt'), 'C'.repeat(3000));
  q.add([{ sid: engine.id, dir: 'up', src: tree, dst: '/tree', isDir: true, size: 0, mtime: 0 }]);
  await waitIdle(30000);
  ok('tree files uploaded', ['a.txt', 'b.txt', path.join('sub', 'c.txt')].every(f =>
    fs.existsSync(path.join(REMOTE, 'tree', f))));
  ok('no errors in tree upload', errors.length === 0, errors.join(' | '));
  const treeJobs = q.jobs.map(j => j.name + ':' + j.state);
  ok('all tree jobs terminal', q.jobs.every(j => ['done', 'skipped', 'error'].includes(j.state)), treeJobs.join(' | '));
  const treeRoot = q.jobs.find(j => j.name === 'tree');
  ok('root folder reported done', treeRoot && treeRoot.state === 'done', JSON.stringify(treeJobs));

  // ---- 4) re-upload with resume policy (default user settings) ----
  console.log('== 4) re-upload same files, resume policy ==');
  errors.length = 0;
  q.clearTerminal();
  settings.resume = true;
  settings.askOverwrite = 'resume';
  q.add(files.map(p => ({
    sid: engine.id, dir: 'up', src: p, dst: '/' + path.basename(p),
    isDir: false, size: fs.statSync(p).size, mtime: 0
  })));
  await waitIdle();
  ok('identical remote files skipped', q.jobs.every(j => j.state === 'skipped'), JSON.stringify(q.jobs.map(j => j.state)));
  ok('no errors with resume policy', errors.length === 0, errors.join(' | '));

  // partial remote file -> resumed upload completes with the right size
  const partPath = path.join(LOCAL, 'part.bin');
  fs.writeFileSync(partPath, Buffer.alloc(300 * 1024, 9));
  fs.writeFileSync(path.join(REMOTE, 'part.bin'), Buffer.alloc(100 * 1024, 9));
  q.clearTerminal();
  errors.length = 0;
  const [partId] = q.add([{ sid: engine.id, dir: 'up', src: partPath, dst: '/part.bin', isDir: false, size: fs.statSync(partPath).size, mtime: 0 }]);
  await waitIdle();
  const partJob = q.jobs.find(j => j.id === partId);
  ok('partial upload resumed to full size', partJob && partJob.state === 'done' &&
    fs.statSync(path.join(REMOTE, 'part.bin')).size === 300 * 1024,
    JSON.stringify({ state: partJob && partJob.state, error: partJob && partJob.error }));
  ok('no errors on resumed upload', errors.length === 0, errors.join(' | '));

  try { await engine.close(); } catch (e) { }
  server.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
