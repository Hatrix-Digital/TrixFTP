'use strict';
// SFTP engine built on ssh2.
const { Client } = require('ssh2');
const fs = require('fs');
const { Throttle } = require('./throttle');

class SftpEngine {
  constructor(cfg, hooks) {
    // cfg: {proto:'sftp', host, port, user, password, dir, keyPath, keyPass, verifyTls(unused), timeoutSec}
    this.cfg = cfg;
    this.hooks = hooks || {};
    this.type = 'sftp';
    this.alive = false;
    this.id = 'sftp' + Math.random().toString(36).slice(2, 9);
    this.conn = null;
    this.sftp = null;
    this.cwd = '/';
  }

  log(level, msg) { try { this.hooks.log && this.hooks.log(level, msg); } catch (e) { } }
  isConn() { return this.alive && this.conn; }

  cb(fn) { return new Promise((resolve, reject) => fn((err, ...res) => err ? reject(err) : resolve(res.length > 1 ? res : res[0]))); }

  async init() {
    const cfg = this.cfg;
    const conn = new Client();
    this.conn = conn;
    const opts = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.user || 'anonymous',
      readyTimeout: Math.max(5, Number(cfg.timeoutSec) || 30) * 1000,
      keepaliveInterval: 20000,
      keepaliveCountMax: 6,
      tryKeyboard: false,
      debug: undefined
    };
    if (cfg.keyPath) {
      opts.privateKey = fs.readFileSync(cfg.keyPath);
      if (cfg.keyPass) opts.passphrase = cfg.keyPass;
    } else {
      opts.password = cfg.password || '';
    }
    conn.on('error', (e) => {
      if (this.alive) this._dead('SFTP error: ' + (e && e.message || e));
      else throw e;
    });
    conn.on('end', () => this._dead('connection closed'));
    conn.on('close', () => this._dead('connection closed'));
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('SFTP: timeout waiting for readiness')), opts.readyTimeout + 2000);
      conn.on('ready', () => { clearTimeout(to); resolve(); });
      conn.on('error', (e) => { clearTimeout(to); reject(e); });
      conn.connect(opts);
    });
    await new Promise((resolve, reject) => {
      conn.sftp((err, s) => err ? reject(err) : resolve(s));
    }).then(s => { this.sftp = s; });
    this.alive = true;
    let cwd;
    try { cwd = await this.cb(fn => this.sftp.realpath('.', fn)); } catch (e) { cwd = '/'; }
    this.cwd = String(cwd || '/').replace(/^\/{2,}/, '/');
    if (cfg.dir) {
      try {
        const st = await this.stat(cfg.dir);
        if (st && st.isDir) this.cwd = cfg.dir;
      } catch (e) { }
    }
    this.log('info', `Connected (SFTP) to ${cfg.host}:${opts.port} as ${cfg.user}`);
    return this.cwd;
  }

  _dead(msg) {
    if (!this.alive) return;
    this.alive = false;
    try { this.conn && this.conn.end(); } catch (e) { }
    this.conn = null; this.sftp = null;
    this.log('error', 'Disconnected: ' + (msg || ''));
    try { this.hooks.onClose && this.hooks.onClose(); } catch (e) { }
  }

  async close() { this._dead('closed by user'); }

  async list(dirPath) {
    if (!this.isConn()) throw new Error('not connected');
    const list = await this.cb(fn => this.sftp.readdir(dirPath || '.', fn));
    return list
      .filter(e => e.filename !== '.' && e.filename !== '..')
      .map(e => {
        const a = e.attrs || {};
        return {
          name: e.filename,
          isDir: !!(a.isDirectory && a.isDirectory()),
          isLink: !!(a.isSymbolicLink && a.isSymbolicLink()),
          size: Number(a.size) || 0,
          mtime: Number(a.mtime) || 0,
          rawMtime: '', target: '', owner: ''
        };
      });
  }

  async stat(p) {
    if (!this.isConn()) throw new Error('not connected');
    try {
      const a = await this.cb(fn => this.sftp.stat(p, fn));
      return { exists: true, isDir: !!(a && a.isDirectory && a.isDirectory()), size: Number(a.size) || 0, mtime: Number(a.mtime) || 0 };
    } catch (e) {
      return null;
    }
  }

  async getwd() { return this.cwd; }

  async mkdirp(p) {
    if (!this.isConn()) throw new Error('not connected');
    const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      try {
        await this.cb(fn => this.sftp.mkdir(cur, fn));
      } catch (e) {
        const ok = await this.stat(cur);
        if (!ok) throw e;
      }
    }
  }

  async remove(p, isDir) {
    if (!this.isConn()) throw new Error('not connected');
    if (isDir) await this._rmrf(p);
    else await this.cb(fn => this.sftp.unlink(p, fn));
  }

  async _rmrf(p) {
    const entries = await this.list(p);
    for (const e of entries) {
      const child = String(p).replace(/\/$/, '') + '/' + e.name;
      if (e.isDir && !e.isLink) await this._rmrf(child);
      else await this.cb(fn => this.sftp.unlink(child, fn)).catch(() => { });
    }
    await this.cb(fn => this.sftp.rmdir(p, fn));
  }

  async rename(from, to) {
    if (!this.isConn()) throw new Error('not connected');
    await this.cb(fn => this.sftp.rename(from, to, fn));
  }

  async createEmpty(p) {
    if (!this.isConn()) throw new Error('not connected');
    await this.cb(fn => this.sftp.writeFile(p, '', fn));
    return { ok: true };
  }

  async chmod(p, modeStr) {    if (!this.isConn()) throw new Error('not connected');
    let oct = String(modeStr || '').trim();
    if (!/^[0-7]{3,4}$/.test(oct)) {
      oct = String(modeStr || '').replace(/[^rwx-]/g, '').padEnd(9, '-');
      const v = (s) => (s.includes('r') ? 4 : 0) | (s.includes('w') ? 2 : 0) | (s.includes('x') ? 1 : 0);
      oct = [oct.slice(0, 3), oct.slice(3, 6), oct.slice(6, 9)].map(v).join('');
    }
    await this.cb(fn => this.sftp.chmod(p, parseInt(oct, 8), fn));
    return 'OK';
  }

  async setTimes(p, mtimeSec) {
    if (!mtimeSec || !this.isConn()) return;
    await this.cb(fn => this.sftp.utimes(p, mtimeSec, mtimeSec, fn));
  }

  async execLine() { throw new Error('Manual server commands are available for FTP sessions only.'); }

  // ---- transfer ----
  // spec: {direction, src, dst, size, mtime, resumeOffset, throttleBytes, onProgress(bytesAbs)}
  transfer(spec) {
    const state = { aborted: false, chan: null };
    const done = (async () => {
      if (!this.isConn()) throw new Error('not connected');
      // dedicated SFTP channel per transfer so aborts don't break others
      const chan = await new Promise((resolve, reject) => this.conn.sftp((err, s) => err ? reject(err) : resolve(s)));
      state.chan = chan;
      const off = spec.resumeOffset || 0;
      const total = spec.size || 0;
      const report = (abs) => {
        if (state.aborted) return;
        const a = total ? Math.max(0, Math.min(abs, total)) : abs;
        try { spec.onProgress(a); } catch (e) { }
      };

      const runFast = () => new Promise((resolve, reject) => {
        const wopts = {
          step: (t) => report(off + t)
        };
        if (spec.direction === 'dn') chan.fastGet(spec.src, spec.dst, wopts, (err) => err ? reject(err) : resolve({}));
        else chan.fastPut(spec.src, spec.dst, wopts, (err2) => err2 ? reject(err2) : resolve({}));
      });

      const runStream = () => new Promise((resolve, reject) => {
        let proc;
        if (spec.direction === 'dn') {
          const remote = chan.createReadStream(spec.src, off > 0 ? { start: off } : {});
          const local = fs.createWriteStream(spec.dst, off > 0 ? { flags: 'r+', start: off } : { flags: 'w' });
          let src = remote, dst = local;
          if (spec.throttleBytes > 0) {
            const th = new Throttle(spec.throttleBytes);
            remote.pipe(th); src = th;
          }
          src.on('data', c => { report(off + (report._base = (report._base || 0) + c.length)); });
          [remote, local, src].forEach(s => s && s.on('error', reject));
          proc = { streams: [remote, src, local] };
          dst.on('finish', () => resolve({}));
          src.pipe(dst);
        } else {
          const local = fs.createReadStream(spec.src, off > 0 ? { start: off } : {});
          const remote = chan.createWriteStream(spec.dst, off > 0 ? { flags: 'r+', start: off } : { flags: 'w' });
          let src = local;
          if (spec.throttleBytes > 0) {
            const th = new Throttle(spec.throttleBytes);
            local.pipe(th); src = th;
          }
          src.on('data', c => { report(off + (report._base = (report._base || 0) + c.length)); });
          [local, remote, src].forEach(s => s && s.on('error', reject));
          proc = { streams: [local, src, remote] };
          remote.on('close', () => resolve({}));
          src.pipe(remote);
        }
        state.cleanup = () => { try { proc.streams.forEach(s => s && s.destroy && s.destroy()); } catch (e) { } };
      });

      try {
        if (spec.resumeOffset > 0 || spec.throttleBytes > 0) await runStream();
        else await runFast();
      } catch (e) {
        if (state.aborted) throw new Error('aborted');
        throw e;
      } finally {
        try { state.cleanup && state.cleanup(); } catch (e) { }
        try { chan.end(); } catch (e) { }
      }
      if (state.aborted) throw new Error('aborted');
      return { bytes: total };
    })();
    done.catch(() => { });
    return {
      done,
      abort: () => {
        if (state.aborted) return;
        state.aborted = true;
        try { state.cleanup && state.cleanup(); } catch (e) { }
        try { state.chan && state.chan.end(); } catch (e) { }
      }
    };
  }
}

module.exports = { SftpEngine };
