'use strict';
// App updater: checks GitHub Releases for a newer build, picks the right
// installer for the current platform and provides fetch/download primitives.
// Pure Node (no Electron imports) so the logic stays unit-testable.
const https = require('https');
const fs = require('fs');

const REPO = 'Hatrix-Digital/TrixFTP';
const API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const UA = 'TrixFTP-Updater';

// ---------- version compare ("v1.2.3" style tolerant) ----------
function splitVer(v) {
  return String(v || '').replace(/^[^\d]*/, '').split(/[._+-]/).map(n => parseInt(n, 10) || 0);
}
function cmpVersions(a, b) {
  const A = splitVer(a), B = splitVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d) return d;
  }
  return 0;
}
function isNewer(remote, current) {
  return cmpVersions(remote, current) > 0;
}

// ---------- asset picking ----------
function pickAsset(release, platform, arch) {
  const assets = (release && release.assets) || [];
  if (platform === 'win32') {
    // NSIS installer, ignore *-blockmap requests; explicit fallback below
    const exe = assets.find(a => /^TrixFTP\.Setup\.\d+\.\d+\.\d+\.exe$/i.test(a.name));
    if (exe) return exe;
    return assets.find(a => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name)) || null;
  }
  if (platform === 'darwin') {
    const dmgs = assets.filter(a => /\.dmg$/i.test(a.name));
    if (arch === 'arm64') {
      const arm = dmgs.find(a => /arm64/i.test(a.name));
      if (arm) return arm;
    }
    return dmgs.find(a => !/arm64/i.test(a.name)) || dmgs[0] || null;
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return assets.find(a => /AppImage/i.test(a.name) && /arm64/i.test(a.name)) || null;
    return assets.find(a => /\.AppImage$/i.test(a.name) && !/arm64/i.test(a.name)) || null;
  }
  return null;
}

// ---------- network ----------
function fetchLatest(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(API_LATEST, {
      headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' },
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('GitHub API HTTP ' + res.statusCode));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad GitHub API response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Update check timed out')));
    req.on('error', reject);
  });
}

// Follow up to 5 redirects (release assets point to a CDN), write to dest.
function downloadFile(url, dest, onProgress, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const get = (target, redirects) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const req = https.get(target, { headers: { 'User-Agent': UA } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, target), redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + target)); }
        const total = Number(res.headers['content-length']) || 0;
        const ws = fs.createWriteStream(dest);
        let got = 0, lastPct = -1;
        res.on('data', c => {
          got += c.length;
          if (ws.write(c) === false) res.pause();
          ws.on('drain', () => res.resume()); // may register more than once; harmless
          const pct = total ? Math.min(100, Math.round((got / total) * 100)) : -1;
          if (pct !== lastPct) { lastPct = pct; try { onProgress && onProgress(pct, got, total); } catch (e) { } }
        });
        res.on('error', e => { try { ws.destroy(); } catch (x) { } reject(e); });
        ws.on('error', reject);
        ws.on('finish', () => resolve(dest));
        res.on('end', () => ws.end());
      });
      req.on('timeout', () => req.destroy(new Error('Download timed out')));
      req.on('error', reject);
    };
    get(url, 0);
  });
}

module.exports = { REPO, API_LATEST, cmpVersions, isNewer, pickAsset, fetchLatest, downloadFile };
