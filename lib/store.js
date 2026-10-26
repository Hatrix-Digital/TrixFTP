'use strict';
// Persistent store for sites (bookmarks) and app settings.
// Written/run inside the Electron main process.
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  verifyTls: false,        // FTPS: reject unauthorized/self-signed certificates
  maxParallel: 2,          // max simultaneous transfers
  speedLimit: 0,           // KB/s global limit, 0 = unlimited
  askOverwrite: true,      // ask on existing targets ('skip'/'overwrite' also supported)
  resume: true,            // resume partially transferred files
  preserveTimes: true,     // keep file modification times after transfer
  keepAlive: true,         // periodic NOOP/keepalive
  showHidden: false,       // show dotfiles by default
  savePasswords: true      // store passwords in site manager
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, sites: [], settings: { ...DEFAULT_SETTINGS } };
    this.encrypt = null; // fn(plainStr) -> Buffer (safeStorage), set by main
    this.decrypt = null; // fn(Buffer) -> string
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data = {
          version: raw.version || 1,
          sites: Array.isArray(raw.sites) ? raw.sites : [],
          settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }
        };
      }
    } catch (e) { /* first run or unreadable -> defaults */ }
    // migrate corrupted ids (e.g. serialized Event objects) -> real string ids
    let fixed = false;
    for (const s of this.data.sites) {
      if (typeof s.id !== 'string' || !s.id) {
        s.id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        fixed = true;
      }
    }
    if (fixed) this.save();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8');
    } catch (e) { /* best effort */ }
  }

  // ---- sites ----
  listSites() { return this.data.sites.slice(); }
  upsertSite(site) {
    if (!site || !site.host) throw new Error('host required');
    if (typeof site.id !== 'string' || !site.id) site.id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    site.name = site.name || site.host;
    site.lastUsed = Date.now();
    const i = this.data.sites.findIndex(s => s.id === site.id);
    const hasPwd = typeof site.pwd === 'string' && site.pwd.length > 0;
    const keepOldPwd = i >= 0 && !hasPwd ? this.data.sites[i].pwd : '';
    const rec = { ...site, pwd: hasPwd ? site.pwd : keepOldPwd };
    if (i >= 0) this.data.sites[i] = rec; else this.data.sites.push(rec);
    this.save();
    return rec;
  }
  deleteSite(id) {
    const n = this.data.sites.length;
    this.data.sites = this.data.sites.filter(s => s.id !== id);
    if (this.data.sites.length !== n) this.save();
  }
  // Password protection with Electron safeStorage (falls back to plain text).
  encodePwd(plain) {
    if (!plain || !this.encrypt || process.env.TRIXFTP_NO_ENCRYPT) return plain;
    try { return 'enc1:' + this.encrypt(plain).toString('base64'); } catch (e) { return plain; }
  }
  decodePwd(stored) {
    if (typeof stored !== 'string' || !stored.startsWith('enc1:')) return stored || '';
    if (!this.decrypt) return '';
    try { return this.decrypt(Buffer.from(stored.slice(5), 'base64')); } catch (e) { return ''; }
  }
  sitesForUi() { // masked passwords
    return this.data.sites.map(s => ({ ...s, pwd: s.pwd ? '********' : '', hasPwd: !!s.pwd }));
  }
  siteForConnect(id) { // decoded password
    const s = this.data.sites.find(x => x.id === id);
    if (!s) return null;
    return { ...s, pwd: this.decodePwd(s.pwd) };
  }

  // ---- settings ----
  getSettings() { return { ...this.data.settings }; }
  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...(patch || {}) };
    this.save();
    return { ...this.data.settings };
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
