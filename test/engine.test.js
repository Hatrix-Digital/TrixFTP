'use strict';
// TrixFTP engine smoke test: spins up a local FTP server (ftp-srv, dev-only)
// and exercises the FtpEngine: connect, list, mkdir, upload, download,
// resume, rename, delete, manual command. Run: node test/engine.test.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FtpSrv } = require('ftp-srv');
const { FtpEngine } = require('../lib/ftp');

const PORT = 22123;
const ROOT = path.join(os.tmpdir(), 'trixftp-test-' + Date.now());

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.error('  [FAIL] ' + name + (extra ? '  -- ' + extra : '')); }
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'hello.txt'), 'H'.repeat(5000));
  fs.mkdirSync(path.join(ROOT, 'sub'));
  fs.writeFileSync(path.join(ROOT, 'sub', 'data.bin'), Buffer.alloc(256 * 1024, 7));

  const server = new FtpSrv({
    url: `ftp://0.0.0.0:${PORT}`,
    'pasv_url': () => '127.0.0.1',
    'pasv_min': 10210,
    'pasv_max': 10240,
    anonymous: true,
    logLevel: 'error'
  });
  server.on('login', (data, resolve, reject) => resolve({ root: ROOT }));
  await server.listen();
  await new Promise(r => setTimeout(r, 500));

  const logs = [];
  const eng = new FtpEngine({
    proto: 'ftp', host: '127.0.0.1', port: PORT, user: 'anon', password: 'x',
    timeoutSec: 10
  }, {
    log: (lv, m) => logs.push(lv + ': ' + m),
    onClose: () => { },
    settings: () => ({ verifyTls: false, keepAlive: false, maxParallel: 2, speedLimit: 0 })
  });

  console.log('== connect ==');
  const cwd = await eng.init();
  ok('connected, cwd = /', cwd === '/', 'cwd=' + cwd);

  console.log('== list ==');
  const items = await eng.list('/');
  ok('2 entries', items.length === 2, JSON.stringify(items.map(i => i.name)));
  const hello = items.find(i => i.name === 'hello.txt');
  ok('hello.txt size 5000', hello && hello.size === 5000);
  const sub = items.find(i => i.name === 'sub');
  ok('sub is dir', sub && sub.isDir);

  console.log('== stat via cached parent listing ==');
  const st = await eng.stat('/sub/data.bin');
  ok('stat size 262144', st && st.size === 256 * 1024, JSON.stringify(st));

  console.log('== mkdir + upload ==');
  await eng.mkdirp('/made/up/dir');
  const dirs = await eng.list('/');
  ok('made exists', dirs.some(d => d.name === 'made'));

  const srcFile = path.join(ROOT, '_upload_src.txt');
  fs.writeFileSync(srcFile, 'U'.repeat(64 * 1024));
  const dl1 = eng.transfer({ direction: 'up', src: srcFile, dst: '/made/up/dir/up.txt', size: 64 * 1024, resumeOffset: 0, throttleBytes: 0, onProgress: () => { } });
  await dl1.done;
  const stUp = await eng.stat('/made/up/dir/up.txt');
  ok('upload verified 65536', stUp && stUp.size === 64 * 1024, JSON.stringify(stUp));

  console.log('== download ==');
  const dstFile = path.join(ROOT, '_downloaded.txt');
  const dl2 = eng.transfer({ direction: 'dn', src: '/made/up/dir/up.txt', dst: dstFile, size: 64 * 1024, resumeOffset: 0, throttleBytes: 0, onProgress: () => { } });
  await dl2.done;
  const got = fs.readFileSync(dstFile);
  ok('download size + content', got.length === 64 * 1024 && got[0] === 85);

  console.log('== resume download (offset) ==');
  fs.truncateSync(dstFile, 10); // pretend first 10 bytes done
  const dl3 = eng.transfer({ direction: 'dn', src: '/made/up/dir/up.txt', dst: dstFile, size: 64 * 1024, resumeOffset: 10, throttleBytes: 0, onProgress: () => { } });
  await dl3.done;
  const got2 = fs.readFileSync(dstFile);
  ok('resumed identical to source', Buffer.compare(got2, fs.readFileSync(srcFile)) === 0, 'len=' + got2.length);

  console.log('== resume upload (append remaining bytes to remote prefix) ==');
  // Full 64KB source on disk; remote already has the first 20KB (uploaded separately below).
  const fullSrc = srcFile; // 64 * 1024 bytes of 'U'
  // seed remote prefix by uploading first 20KB of the file directly:
  const seedPath = path.join(ROOT, '_seed.bin');
  fs.writeFileSync(seedPath, fs.readFileSync(fullSrc).slice(0, 20 * 1024));
  const seedT = eng.transfer({ direction: 'up', src: seedPath, dst: '/made/up/dir/partial.bin', size: 20 * 1024, resumeOffset: 0, throttleBytes: 0, onProgress: () => { } });
  await seedT.done;
  const stSeed = await eng.stat('/made/up/dir/partial.bin');
  ok('seed uploaded 20KB', stSeed && stSeed.size === 20 * 1024, JSON.stringify(stSeed));
  // now "resume": append bytes 20..64KB of the full file
  const dl4 = eng.transfer({ direction: 'up', src: fullSrc, dst: '/made/up/dir/partial.bin', size: 64 * 1024, resumeOffset: 20 * 1024, throttleBytes: 0, onProgress: () => { } });
  await dl4.done;
  const stP = await eng.stat('/made/up/dir/partial.bin');
  ok('resumed upload full 64KB', stP && stP.size === 64 * 1024, JSON.stringify(stP));

  console.log('== rename ==');
  await eng.rename('/made/up/dir/up.txt', '/made/up/dir/up-renamed.txt');
  ok('renamed', (await eng.list('/made/up/dir')).some(i => i.name === 'up-renamed.txt'));

  console.log('== manual command (FEAT) ==');
  const feat = await eng.execLine('FEAT');
  ok('FEAT responded', typeof feat === 'string' && feat.length > 0, String(feat));

  console.log('== remove file + tree ==');
  await eng.remove('/made/up/dir/up-renamed.txt', false);
  ok('file removed', !(await eng.list('/made/up/dir')).some(i => i.name === 'up-renamed.txt'));

  console.log('== progress callback fires ==');
  let lastP = 0;
  const big = path.join(ROOT, '_bigdl.bin');
  const dl5 = eng.transfer({
    direction: 'dn', src: '/sub/data.bin', dst: big, size: 256 * 1024,
    resumeOffset: 0, throttleBytes: 0, onProgress: (b) => { lastP = b; }
  });
  await dl5.done;
  ok('progress fired > 0', lastP > 0, String(lastP));

  await eng.close();
  server.close();

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
