# HRMS X Agent

A small Electron desktop app employees install and sign in to with their normal HRMS X
credentials. While running, it:

- Tracks active/idle time system-wide (using Electron's built-in OS idle detection — not a
  browser tab, and not a keystroke logger) and reports it to the same `/api/activity/ping`
  endpoint the web app's in-app tracker uses.
- Optionally captures periodic screenshots — **off by default**. HR has to turn it on for the
  whole organisation (Compliance > Monitoring in the web app), and even then each employee has
  to separately agree inside this agent before anything is captured for them. Declining just
  means screenshots stay off for that person; active-time tracking still works either way.
- Shows a tray icon at all times so it's never silently running in the background unannounced.

## What this does NOT do

No keystroke logging, no per-app or per-website usage tracking, no webcam/microphone access. If
your organisation needs those, they're a different, larger scope than what's built here.

## Running it locally

```bash
cd desktop-agent
npm install
npm start
```

By default it talks to the production backend (`https://hrms-x.onrender.com/api`). To point it
at a local backend instead:

```bash
HRMS_X_API_URL=http://localhost:5001/api npm start
```

## Building an installer

```bash
npm run dist
```

This uses `electron-builder` to produce a `.dmg` (macOS), `.exe`/NSIS installer (Windows), or
`.AppImage` (Linux) in `desktop-agent/dist/`, depending on the platform you build on.

**Important:** these builds are unsigned. On macOS, Gatekeeper will show an "unidentified
developer" warning the first time someone opens it (right-click → Open bypasses this once).
Signing and notarizing a macOS build requires an active Apple Developer account and certificate;
signing a Windows build requires a code-signing certificate. Neither is set up here — that's an
account/cost decision for you to make, not something that can be scaffolded in without real
credentials.

## Where session data lives

Login credentials are never stored — only the session token, returned by the same `/auth/login`
endpoint the web app uses, saved locally via `electron-store` (a small JSON file in the OS's
per-app data directory, e.g. `~/Library/Application Support/hrms-x-agent` on macOS). Logging out
from the tray menu or the in-app "Log out" button deletes it.
