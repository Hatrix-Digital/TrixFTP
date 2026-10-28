'use strict';
// Updater logic tests (run: node test/updater.test.js)
const assert = require('assert');
const { cmpVersions, isNewer, pickAsset } = require('../lib/updater');

const checks = [];
function test(name, fn) {
  try { fn(); checks.push({ name, pass: true }); }
  catch (e) { checks.push({ name, pass: false, err: e.message }); }
}

test('cmpVersions basic', () => {
  assert.strictEqual(cmpVersions('1.2.3', '1.2.3'), 0);
  assert.ok(cmpVersions('1.2.3', '1.2.2') > 0);
  assert.ok(cmpVersions('2.0.0', '1.9.9') > 0);
  assert.ok(cmpVersions('1.10.0', '1.9.9') > 0);   // numeric not string compare
  assert.ok(cmpVersions('1.0.1', '1.0.2') < 0);
});

test('isNewer strips v prefix', () => {
  assert.ok(isNewer('v1.0.1', '1.0.0'));
  assert.ok(!isNewer('v1.0.1', '1.0.1'));
  assert.ok(!isNewer('1.0.0', 'v1.0.1'));
});

test('pickAsset: win32 -> NSIS Setup exe', () => {
  const rel = { assets: [
    { name: 'TrixFTP.1.2.0.exe' },
    { name: 'TrixFTP.Setup.1.2.0.exe' },
    { name: 'TrixFTP.Setup.1.2.0.exe.blockmap' },
    { name: 'builder-debug.yml' }
  ] };
  const a = pickAsset(rel, 'win32', 'x64');
  assert.ok(a && a.name === 'TrixFTP.Setup.1.2.0.exe');
});

test('pickAsset: linux x64 -> plain AppImage only', () => {
  const rel = { assets: [
    { name: 'TrixFTP-1.2.0.AppImage' },
    { name: 'TrixFTP-1.2.0-arm64.AppImage' }
  ] };
  const a = pickAsset(rel, 'linux', 'x64');
  assert.ok(a && a.name === 'TrixFTP-1.2.0.AppImage');
  const arm = pickAsset(rel, 'linux', 'arm64');
  assert.ok(arm && arm.name === 'TrixFTP-1.2.0-arm64.AppImage');
});

test('pickAsset: darwin arm64 prefers arm dmg, falls back to plain', () => {
  const both = { assets: [{ name: 'TrixFTP-1.2.0.dmg' }, { name: 'TrixFTP-1.2.0-arm64.dmg' }] };
  const onlyPlain = { assets: [{ name: 'TrixFTP-1.2.0.dmg' }] };
  assert.ok(pickAsset(both, 'darwin', 'arm64').name.includes('arm64'));
  assert.ok(pickAsset(onlyPlain, 'darwin', 'arm64').name === 'TrixFTP-1.2.0.dmg');
  assert.ok(pickAsset(onlyPlain, 'darwin', 'x64').name === 'TrixFTP-1.2.0.dmg');
});

test('pickAsset: empty release -> null (no crash)', () => {
  assert.strictEqual(pickAsset(null, 'win32', 'x64'), null);
  assert.strictEqual(pickAsset({ assets: [] }, 'darwin', 'x64'), null);
});

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? '[PASS] ' : '[FAIL] ') + c.name + (c.err ? ' -> ' + c.err : ''));
  if (!c.pass) failed++;
}
console.log('RESULT: ' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
