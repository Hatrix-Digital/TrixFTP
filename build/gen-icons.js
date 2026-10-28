'use strict';
// Renders build/icon.svg to PNGs in every needed size, then assembles
// Windows .ico (PNG-compressed entries, Vista+) and macOS .icns directly.
// Run: node_modules\.bin\electron.cmd build\gen-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const B = __dirname;
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

app.whenReady().then(async () => {
  const pngDir = path.join(B, 'png');
  fs.mkdirSync(pngDir, { recursive: true });

  const w = new BrowserWindow({ width: 640, height: 640, show: false, webPreferences: { offscreen: true } });
  await w.loadURL('file:///' + path.join(B, 'gen-page.html').replace(/\\/g, '/'));
  // wait for the <img> to finish decoding the SVG
  await w.webContents.executeJavaScript(
    `new Promise(res => { var i = document.getElementById('src'); i.onload = res; i.onerror = res; i.src = 'file:///${path.join(B, 'icon.svg').replace(/\\/g, '/')}' + '?t=' + Date.now(); })`
  );
  const out = await w.webContents.executeJavaScript(`window.run(${JSON.stringify(SIZES)})`);

  const pngs = {};
  for (const s of SIZES) {
    const buf = Buffer.from(String(out[s]).replace(/^data:image\/png;base64,/, ''), 'base64');
    fs.writeFileSync(path.join(pngDir, `icon-${s}.png`), buf);
    pngs[s] = buf;
  }
  w.destroy();

  fs.writeFileSync(path.join(B, 'icon.png'), pngs[512]);

  fs.writeFileSync(path.join(B, 'icon.ico'), buildIco([16, 24, 32, 48, 64, 128, 256].map(s => ({ s, d: pngs[s] }))));

  fs.writeFileSync(path.join(B, 'icon.icns'), buildIcns({
    icp4: pngs[16], icp5: pngs[32], icp6: pngs[64],
    ic07: pngs[128], ic08: pngs[256], ic09: pngs[512]
  }));

  console.log('icons written:', fs.readdirSync(B).filter(f => f.startsWith('icon.')).join(' '));
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });

// ---------- .ico ----------
// Inline one or more PNG images in an .ico container (PNG entries, supported
// since Windows Vista; 256px entry uses width/height byte 0).
function buildIco(entries) {
  const count = entries.length;
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const parts = [];
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.s >= 256 ? 0 : e.s;      // width (0 = 256)
    dir[o + 1] = e.s >= 256 ? 0 : e.s;  // height
    dir[o + 2] = 0;                     // palette
    dir[o + 3] = 0;                     // reserved
    dir.writeUInt16LE(1, o + 4);        // planes
    dir.writeUInt16LE(32, o + 6);       // bpp
    dir.writeUInt32LE(e.d.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.d.length;
    parts.push(e.d);
  });
  return Buffer.concat([head, dir, ...parts]);
}

// ---------- .icns ----------
// Types: icp4=16, icp5=32, icp6=64 (PNG-encoded variants),
//	ic07=128, ic08=256, ic09=512.
function buildIcns(map) {
  const chunks = [];
  let total = 8;
  for (const [type, data] of Object.entries(map)) {
    if (!data) continue;
    total += 8 + data.length;
    chunks.push({ type, data });
  }
  const buf = Buffer.alloc(total);
  buf.write('icns', 0, 'ascii');
  buf.writeUInt32BE(total, 4);
  let o = 8;
  for (const c of chunks) {
    buf.write(c.type.replace(/^icp([456])$/, (m, d) => 'icp' + d), o, 'ascii');
    buf.writeUInt32BE(8 + c.data.length, o + 4);
    c.data.copy(buf, o + 8);
    o += 8 + c.data.length;
  }
  return buf;
}
