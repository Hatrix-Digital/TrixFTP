# TrixFTP

[![Build & Release](https://github.com/Hatrix-Digital/TrixFTP/actions/workflows/build.yml/badge.svg)](https://github.com/Hatrix-Digital/TrixFTP/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Fast, modern dual-pane FTP / FTPS / SFTP desktop client for Windows, macOS and Linux** —
built with Electron ([`basic-ftp`](https://github.com/patrickhildebrandt/basic-ftp) for FTP/FTPS,
[`ssh2`](https://github.com/mscdex/ssh2) for SFTP). All application code in this repository
is original; libraries are MIT-licensed third-party components.

🌐 **Website (3D landing page + screenshots with demo data):**
<https://Hatrix-Digital.github.io/TrixFTP/> — sources in [`docs/`](docs/).

## Features

### Connections
- FTP, FTPS (explicit TLS), SFTP (SSH2, password or key auth)
- Site Manager: saved hosts with OS-encrypted passwords (Electron `safeStorage` — DPAPI on Windows, keychain elsewhere)
- Quick Connect bar, multiple simultaneous sessions in tabs, keep-alive (FTP NOOP / SSH keepalive), passive transfers over EPSV/PASV/PRET

### File browsing (dual pane)
- Local + remote panes with full column info (name, size, mtime, type), sorting, filtering, hidden-file toggle
- Explorer-style keyboard: **type-ahead jump-to-letter**, F5 refresh, F2 rename, F8 sites, Ctrl+S, drag & drop
- Directory compare (marks files only on one side or with differing size)

### Transfers
- Transfer queue: up to 6 parallel jobs, pause/resume all, retry failed, live speed & ETA
- Resume interrupted transfers via REST/size offset
- Speed limiting per queue (KB/s)
- Overwrite/skip/resume/rename/cancel conflict policies with "apply to all"
- **Auto-reconnect**: if a session dies (or the tab is closed), queued jobs re-bind to any live
  session for the same host or automatically open a fresh connection with stored credentials

## Getting started

```bash
npm install
npm start            # run the app in dev mode
npm run test:engine  # engine smoke test (spins up a local FTP server)
npm run dist         # build installers for the current OS
```

## Installers (v1.0.0)

| OS | Artifact |
|---|---|
| Windows x64 | `TrixFTP Setup 1.0.0.exe` (NSIS) + portable `.exe` |
| macOS | `TrixFTP-1.0.0.dmg` + `.zip` *(unsigned — right-click → Open)* |
| Linux | `TrixFtp-1.0.0.AppImage` + `.deb` |

Grab them from [**Releases**](https://github.com/Hatrix-Digital/TrixFTP/releases) — or trigger a
build yourself: push a `v*` tag or run the **Build & Release** workflow manually
(`Actions → Build & Release → Run workflow`). All three platforms build in parallel.

> Builds are not code-signed. SmartScreen/Gatekeeper will ask — choose "Run anyway" / right-click → Open.

## Project layout

```
main.js         Electron main process, IPC glue, session pool, queue context
preload.js      contextBridge API (window.trix)
lib/            ftp.js (FTP/FTPS engine) · sftp.js (SFTP engine) · queue.js · store.js · local.js
renderer/       index.html · styles.css (dashboard UI) · app.js · pane.js · ui.js
test/           engine.test.js (self-contained engine smoke test)
docs/            Static website (3D landing page, three.js) + demo screenshot generator
shot.js         offline renderer that produces docs/assets/*.png from docs/shots/
```

## License

[MIT](LICENSE) — © 2026 TrixFTP contributors
