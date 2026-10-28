'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL('file:///' + path.join(__dirname, 'docs', 'index.html').replace(/\\/g, '/'));
  await new Promise(r => setTimeout(r, 2500));
  win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
  await new Promise(r => setTimeout(r, 1600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'preview-landing.png'), img.toPNG());
  console.log('ok');
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
