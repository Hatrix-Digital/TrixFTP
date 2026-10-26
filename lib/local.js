'use strict';
// Local filesystem helpers (async promises API).
const fs = require('fs');
const path = require('path');

async function listDir(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (de) => {
    const name = de.name;
    if (name === '.' || name === '..') return null;
    const full = path.join(dir, name);
    const isLink = de.isSymbolicLink();
    let isDir = de.isDirectory();
    let size = 0, mtime = 0;
    try {
      if (!isDir || isLink) {
        const st = await fs.promises.stat(full);
        if (isLink) { isDir = false; } // show links as links (no recursive chase here)
        size = st.size;
        mtime = Math.floor(st.mtimeMs / 1000);
      } else {
        const st = await fs.promises.stat(full);
        mtime = Math.floor(st.mtimeMs / 1000);
      }
    } catch (e) { /* inaccessible entry: keep zeros */ }
    return { name, isDir, isLink, size, mtime, perms: null, target: '' };
  }));
  return items.filter(Boolean);
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function rmrf(p) {
  await fs.promises.rm(p, { recursive: true, force: true });
}

async function rename(from, to) {
  await fs.promises.rename(from, to);
}

// Returns {size, mtime, isDir} or null if missing.
async function statPath(p) {
  try {
    const st = await fs.promises.stat(p);
    return { exists: true, isDir: st.isDirectory(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
  } catch (e) {
    return null;
  }
}

async function writeEmpty(p) {
  const fh = await fs.promises.open(p, 'a');
  await fh.close();
}

// Enumerate Windows drive letters that exist on this machine.
async function listDrives() {
  const out = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  await Promise.all([...letters].map(async (ch) => {
    const p = ch + ':\\';
    try { await fs.promises.stat(p); out.push(ch + ':'); } catch (e) { /* not present */ }
  }));
  return out;
}

module.exports = { listDir, ensureDir, rmrf, rename, statPath, writeEmpty, listDrives };
