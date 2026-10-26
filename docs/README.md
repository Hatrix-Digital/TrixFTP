# TrixFTP ⚡

**Modern FTP / FTPS / SFTP client for Windows, Linux & macOS** — dual-pane browsing,
transfer queue, site manager, drag & drop, resume, speed limits and auto-reconnect.

🌐 **Website & screenshots (demo data): <https://Hatrix-Digital.github.io/TrixFTP/>**

## Highlights

- 🗂️ Dual-pane browse with tabs, sorting, filtering, hidden files, directory compare
- 🚀 Transfer queue — up to 6 parallel jobs, pause/resume/retry, live speed & ETA
- 🔁 Auto-reconnect — queued jobs re-bind to a live session or open a new connection
- 🧷 Site manager with OS-encrypted password storage (Electron safeStorage)
- 🖱️ Drag & drop files or whole folders from the OS
- 🧭 Overwrite / skip / resume / rename policies with apply-to-all
- 🐢 Per-queue speed limiting (KB/s)
- ⌨️ Keyboard-first: type-ahead jump, F5, F8, Ctrl+S …
- Engines: [`basic-ftp`](https://github.com/patrickhildebrandt/basic-ftp) (FTP/FTPS) · [`ssh2`](https://github.com/mscdex/ssh2) (SFTP) · Electron 37

## Desktop app

This repository **is** the application: Electron main process (`main.js`), engines in `lib/`,
UI in `renderer/`, tests in `test/`. Latest installers are on the
[releases](https://github.com/Hatrix-Digital/TrixFTP/releases) page — see the root README for build instructions.

## Website (this repo)

Static 3D landing page (three.js) + demo screenshots.

```bash
# local preview of the site
cd site
npx http-server -p 4747
```

---

MIT License · © 2026 TrixFTP contributors
