'use strict';
// Renders the demo UI stage (docs/shots/app.html) and captures screenshots
// into site/assets/. Run: electron shot.js  (needs the static server on :4747)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'docs', 'assets');
const SHOTS = [
  ['#main', 'shot-main.png'],
  ['#queue', 'shot-queue.png'],
  ['#sites', 'shot-sites.png'],
];

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, useContentSize: true,
    webPreferences: { offscreen: true },
  });
  for (const [hash, name] of SHOTS) {
    // fresh load per variant (hash-only navigation would not re-run the script)
    await win.loadURL('http://127.0.0.1:4747/shots/app.html?v=' + Date.now() + hash);
    await new Promise(r => setTimeout(r, 1200));
    let img = await win.webContents.capturePage();
    if (img.isEmpty()) {
      // offscreen fallback: force a paint cycle
      await new Promise(r => setTimeout(r, 800));
      img = await win.webContents.capturePage();
    }
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('captured', name, img.getSize().width + 'x' + img.getSize().height);
  }
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
