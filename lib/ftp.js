'use strict';
// FTP/FTPS engine built on basic-ftp (passive mode; explicit + implicit TLS).
const { Client } = require('basic-ftp');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { Throttle } = require('./throttle');

function lastSeg(p) { return String(p || '').replace(/[\\/]+$/, '').split('/').pop() || ''; }
function parentOf(p) {
  p = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!p || p === '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

class FtpEngine {
  constructor(cfg, hooks) {
    // cfg: {proto:'ftp'|'ftpes'|'ftpes-implicit', host, port, user, password, dir, verifyTls, timeoutSec}
    // hooks: { log(level,msg), onClose(), settings() }
    this.cfg = cfg;
    this.hooks = hooks || {};
    this.type = 'ftp';
    this.alive = false;
    this.id = 'ftp' + Math.random().toString(36).slice(2, 9);
    this.client = null;
    this.cwd = '/';
    this.keepTimer = null;
    this.activeOps = 0;
    this.listCache = new Map(); // parentPath -> {t, entries}
    // basic-ftp allows only ONE task on a control connection at a time. A second
    // concurrent task closes the whole client with "User launched a task while
    // another one is still running" - which is exactly what happened when two
    // queue jobs stat()/mkdirp()/verify through the same session at once.
    // Every public control-connection call therefore goes through this chain.
    this._opChain = Promise.resolve();
    this._opPending = 0;
  }

  // Serialize a control-connection task for this session.
  _run(fn) {
    const next = this._opChain.then(fn);
    this._opPending++;
    const done = () => { this._opPending--; };
    next.then(done, done);
    // keep the chain alive even when a task rejects
    this._opChain = next.then(() => { }, () => { });
    return next;
  }

  log(level, msg) { try { this.hooks.log && this.hooks.log(level, msg); } catch (e) { } }

  isConn() { return this.alive && this.client && !this.client.closed; }

  _tlsOptions() {
    const st = (this.hooks.settings && this.hooks.settings()) || {};
    return {
      host: this.cfg.host,
      rejectUnauthorized: !!(this.cfg.verifyTls !== undefined ? this.cfg.verifyTls : st.verifyTls)
    };
  }

  async init() {
    const cfg = this.cfg;
    const cl = new Client(Math.max(5, Number(cfg.timeoutSec) || 30) * 1000);
    cl.ftp.verbose = (msg) => {
      const t = String(msg || '').trim();
      if (!t) return;
      if (t.startsWith('>')) this.log('out', t.slice(1).trim());
      else if (t.startsWith('<')) this.log('in', t.slice(1).trim());
    };
    const accessOpts = {
      host: cfg.host,
      port: cfg.port || 21,
      user: cfg.user || 'anonymous',
      password: cfg.password || 'guest',
      secure: cfg.proto === 'ftpes' ? true : (cfg.proto === 'ftpes-implicit' ? 'implicit' : false),
      secureOptions: (cfg.proto === 'ftpes' || cfg.proto === 'ftpes-implicit') ? this._tlsOptions() : undefined
    };
    await cl.access(accessOpts);
    this.client = cl;
    this.alive = true;
    cl.ftp.socket.on('close', () => this._dead('connection closed by server'));
    if (this.hooks.settings().keepAlive) this._keepAlive();
    if (cfg.dir) {
      try { await cl.cd(cfg.dir); } catch (e) { this.log('warn', `Cannot enter directory ${cfg.dir}: ${e.message}`); }
    }
    this.cwd = (await cl.pwd()).replace(/\\/g, '/') || '/';
    this.log('info', `Connected to ${cfg.host}:${accessOpts.port} as ${cfg.user || 'anonymous'}${cfg.proto !== 'ftp' ? ' (TLS)' : ''}`);
    return this.cwd;
  }

  _keepAlive() {
    if (this.keepTimer) return;
    this.keepTimer = setInterval(() => {
      if (!this.isConn() || this._opPending > 0) return;
      // NOOP is a control-connection task too: run it on the serialized chain
      // so it can never collide with a listing/stat/upload task.
      this._run(() => {
        if (!this.isConn()) return null;
        return this.client.send('NOOP').catch(() => { });
      }).catch(() => { });
    }, 20000);
    if (this.keepTimer.unref) this.keepTimer.unref();
  }

  _dead(msg) {
    if (!this.alive) return;
    this.alive = false;
    if (this.keepTimer) { clearInterval(this.keepTimer); this.keepTimer = null; }
    this.listCache.clear();
    try { this.client && this.client.close(); } catch (e) { }
    this.log('error', 'Disconnected: ' + (msg || ''));
    try { this.hooks.onClose && this.hooks.onClose(); } catch (e) { }
  }

  async close() {
    this.alive = false;
    if (this.keepTimer) { clearInterval(this.keepTimer); this.keepTimer = null; }
    try { this.client && this.client.close(); } catch (e) { }
    this.client = null;
  }

  // Directory listing with short-lived cache (stat() uses it to avoid re-listing).
  async _listUncached(dirPath) {
    let files;
    try {
      files = await this.client.list(dirPath && dirPath !== '/' ? dirPath : (dirPath === '/' ? '/' : '.'));
    } catch (e) {
      // Some servers don't like '/', retry with '.'
      if (dirPath === '/' && this.cwd === '/') throw e;
      files = await this.client.list('.');
    }
    this.listCache.set(dirPath || '.', { t: Date.now(), entries: files });
    return files;
  }

  async list(dirPath) {
    if (!this.isConn()) throw new Error('not connected');
    return this._run(async () => {
      if (!this.isConn()) throw new Error('not connected');
      const files = await this._listUncached(dirPath || '.');
      return files.filter(f => f.name !== '.' && f.name !== '..').map(f => ({
        name: f.name,
        isDir: f.isDirectory,
        isLink: f.isSymbolicLink,
        size: Number(f.size) || 0,
        mtime: f.modifiedAt ? Math.floor(f.modifiedAt.getTime() / 1000) : 0,
        rawMtime: String(f.rawModifiedAt || ''),
        perms: f.permissions ? [f.permissions.user, f.permissions.group, f.permissions.world].join('') : '',
        target: String(f.link || ''),
        owner: String(f.user || '')
      }));
    });
  }

  // Cached stat for a single path via parent directory listing.
  async stat(p) {
    if (!this.isConn()) throw new Error('not connected');
    return this._run(async () => {
      if (!this.isConn()) throw new Error('not connected');
      p = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
      if (p === '/') return { exists: true, isDir: true, size: 0, mtime: 0 };
      const parent = parentOf(p);
      const name = lastSeg(p);
      let entries = null;
      const cached = this.listCache.get(parent);
      if (cached && Date.now() - cached.t < 3000) entries = cached.entries;
      if (!entries) entries = await this._listUncached(parent);
      const f = entries.find(x => x.name === name);
      if (!f) return null;
      return {
        exists: true, isDir: f.isDirectory,
        size: Number(f.size) || 0,
        mtime: f.modifiedAt ? Math.floor(f.modifiedAt.getTime() / 1000) : 0
      };
    });
  }

  async getwd() {
    if (!this.isConn()) return this.cwd;
    return this._run(async () => (await this.client.pwd()).replace(/\\/g, '/'));
  }

  _invalidateListCache() { this.listCache.clear(); }

  async mkdirp(p) {
    if (!this.isConn()) throw new Error('not connected');
    return this._run(async () => {
      if (!this.isConn()) throw new Error('not connected');
      const save = this.cwd;
      await this.client.ensureDir(p);
      try { await this.client.cd(save); } catch (e) { /* cwd restored best effort */ }
      this._invalidateListCache();
    });
  }

  async remove(p, isDir) {
    if (!this.isConn()) throw new Error('not connected');
    return this._run(async () => {
      if (!this.isConn()) throw new Error('not connected');
      if (isDir) await this.client.removeDir(p);
      else await this.client.remove(p);
      this._invalidateListCache();
    });
  }

  async rename(from, to) {
    if (!this.isConn()) throw new Error('not connected');
    return this._run(async () => {
      if (!this.isConn()) throw new Error('not connected');
      await this.client.rename(from, to);
      this._invalidateListCache();
    });
  }

  // SITE CHMOD; mode like "755" or "rwxr-xr-x".
  async chmod(p, modeStr) {
    if (!this.isConn()) throw new Error('not connected');
    let oct = String(modeStr || '').trim();
    if (!/^[0-7]{3,4}$/.test(oct)) {
      oct = String(modeStr || '').replace(/[^rwx-]/g, '').padEnd(9, '-');
      const v = (s) => (s.includes('r') ? 4 : 0) | (s.includes('w') ? 2 : 0) | (s.includes('x') ? 1 : 0);
      oct = [oct.slice(0, 3), oct.slice(3, 6), oct.slice(6, 9)].map(v).join('');
    }
    return this._run(async () => {
      if (!this.isConn()) throw new Error('not connected');
      const res = await this.client.send('SITE CHMOD ' + oct + ' ' + p);
      return res.message || 'OK';
    });
  }

  // Create an empty remote file (STOR of an empty stream).
  async createEmpty(p) {
    if (!this.isConn()) throw new Error('not connected');
    return this._run(async () => {
      if (!this.isConn()) throw new Error('not connected');
      await this.client.uploadFrom(Readable.from([]), p);
      this._invalidateListCache();
      return { ok: true };
    });
  }

  // Best effort: SITE MFMT <YYYYMMDDHHMMSS> <path>
  async setTimes(p, mtimeSec) {
    if (!mtimeSec || !this.isConn()) return;
    const d = new Date(mtimeSec * 1000);
    const iso = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
    try {
      await this._run(async () => {
        if (!this.isConn()) return;
        await this.client.send('SITE MFMT ' + iso + ' ' + p);
      });
    } catch (e) { /* server may not support */ }
  }

  async execLine(cmd) {
    if (!this.isConn()) throw new Error('not connected');
    const forbidden = /^(LIST|RETR|STOR|PASV|PORT|EPSV|EPRT|STOU|APPE|MLSD|MLST)\b/i;
    if (forbidden.test(cmd.trim())) throw new Error('Transfer/data commands are executed by TrixFTP internally.');
    return this._run(async () => {
      if (!this.isConn()) throw new Error('not connected');
      const res = await this.client.send(cmd.trim());
      return res.message || String(res.code || '');
    });
  }

  // ---- transfer ----
  // spec: {direction:'up'|'dn', src, dst, size, mtime, resumeOffset, throttleBytes, onProgress(bytesAbs)}
  // returns { done: Promise<{bytes}>, abort() }
  transfer(spec) {
    const state = { aborted: false, client: null };
    const openOpts = {
      host: this.cfg.host, port: this.cfg.port || 21,
      user: this.cfg.user || 'anonymous', password: this.cfg.password || 'guest',
      secure: this.cfg.proto === 'ftpes' ? true : (this.cfg.proto === 'ftpes-implicit' ? 'implicit' : false),
      secureOptions: (this.cfg.proto !== 'ftp') ? this._tlsOptions() : undefined
    };
    const done = (async () => {
      const off = spec.resumeOffset || 0;
      const total = spec.size || 0;
      const report = (relBytes) => {
        if (state.aborted) return;
        const abs = Math.max(0, Math.min(total || (off + relBytes), off + relBytes));
        try { spec.onProgress(total ? abs : off + relBytes); } catch (e) { }
      };
      const cl = new Client(30000);
      state.client = cl;
      cl.ftp.verbose = () => { }; // quiet data connections
      await cl.access(openOpts);
      if (state.aborted) throw new Error('aborted');

      if (spec.direction === 'dn') {
        const fsOut = fs.createWriteStream(spec.dst, off > 0 ? { flags: 'r+', start: off } : { flags: 'w' });
        let dest = fsOut;
        if (spec.throttleBytes > 0) {
          const th = new Throttle(spec.throttleBytes);
          th.pipe(fsOut);
          dest = th;
        }
        cl.trackProgress(info => { if (info.type === 'download') report(info.bytes); });
        try {
          await cl.downloadTo(dest, spec.src, off);
          await waitFinish(fsOut);
        } finally {
          try { fsOut.destroy(); } catch (e) { }
        }
      } else {
        const rd = fs.createReadStream(spec.src, off > 0 ? { start: off } : {});
        let src = rd;
        if (spec.throttleBytes > 0) {
          const th = new Throttle(spec.throttleBytes);
          rd.pipe(th);
          src = th;
        }
        cl.trackProgress(info => { if (info.type === 'upload') report(info.bytes); });
        try {
          if (off > 0) await cl.appendFrom(src, spec.dst, { localStart: off });
          else await cl.uploadFrom(src, spec.dst);
        } finally {
          try { rd.destroy(); } catch (e) { }
        }
      }
      if (state.aborted) throw new Error('aborted');
      try { cl.close(); } catch (e) { }
      if (spec.direction === 'up') this._invalidateListCache();
      return { bytes: total };
    })();
    done.catch(() => { try { state.client && state.client.close(); } catch (e) { } });
    return {
      done,
      abort: () => {
        if (state.aborted) return;
        state.aborted = true;
        try { state.client && state.client.close(); } catch (e) { }
      }
    };
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
function waitFinish(stream) {
  return new Promise((resolve) => {
    if (stream.writableFinished) return resolve();
    stream.on('finish', resolve);
    stream.on('error', resolve);
  });
}

module.exports = { FtpEngine };
