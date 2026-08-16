// HRMS X Agent — Electron main process.
//
// Scope, deliberately: this agent does system-wide ACTIVE/IDLE time
// detection (via Electron's built-in powerMonitor, which reads real OS idle
// time — no extra native input hooks needed) and OPTIONAL periodic
// screenshots. Screenshots are off unless the employee's organisation has
// explicitly turned them on AND the employee has separately consented
// inside this agent (see renderer/consent.js) — the backend independently
// enforces both checks too, so this agent can't accidentally capture
// screenshots even if something here is misconfigured.
//
// A tray icon is always shown while the agent is running so its presence is
// never invisible to the person using the machine.

const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, desktopCapturer, nativeImage, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Point this at your deployed backend, or override with the HRMS_X_API_URL
// env var for local development (e.g. http://localhost:5001/api).
const DEFAULT_API_URL = 'https://hrms-x.onrender.com/api';
const API_URL = process.env.HRMS_X_API_URL || DEFAULT_API_URL;

const HEARTBEAT_MS = 5 * 60 * 1000;       // matches backend HEARTBEAT_MINUTES in activityController.js
const IDLE_THRESHOLD_SECONDS = 5 * 60;    // no OS-level input in this window = idle, don't ping
const SETTINGS_POLL_MS = 15 * 60 * 1000;  // how often to re-check the tenant's monitoring settings

const store = new Store({ name: 'hrms-x-agent-session' });

let mainWindow = null;
let tray = null;
let heartbeatInterval = null;
let screenshotInterval = null;
let settingsPollInterval = null;

// ── Minimal HTTP client (no axios dependency needed for this small surface) ─
function apiRequest(method, pathName, { body, token, tenantId } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL.replace(/\/$/, '') + pathName);
    const isHttps = url.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : null;

    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (tenantId) headers['X-Tenant-ID'] = tenantId;

    const req = (isHttps ? https : http).request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = { success: false, message: 'Invalid response from server.' }; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.message || `Request failed (${res.statusCode}).`));
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Session (persisted locally, NOT in renderer localStorage) ──────────────
const getSession = () => store.get('session', null);
const setSession = (session) => store.set('session', session);
const clearSession = () => store.delete('session');

// ── Window / tray ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 520,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (e) => {
    // Closing the window just hides it — the agent keeps tracking in the
    // background via the tray, same as most time-tracking desktop apps.
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function updateTray(statusLabel) {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: `Status: ${statusLabel}`, enabled: false },
    { type: 'separator' },
    { label: 'Open HRMS X Agent', click: () => { mainWindow.show(); } },
    { label: 'Log out', click: handleLogout },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`HRMS X Agent — ${statusLabel}`);
}

function createTray() {
  const icon = nativeImage.createEmpty(); // simple/blank tray icon; swap for a real asset before distributing
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromNamedImage('NSStatusAvailable', [0, 0, 0, 1]) : icon);
  tray.setToolTip('HRMS X Agent');
  updateTray(getSession() ? 'Signed in' : 'Not signed in');
  tray.on('click', () => { mainWindow.show(); });
}

// ── Tracking loops ──────────────────────────────────────────────────────
async function sendHeartbeatIfActive() {
  const session = getSession();
  if (!session?.token) return;

  const idleSeconds = powerMonitor.getSystemIdleTime();
  if (idleSeconds >= IDLE_THRESHOLD_SECONDS) return; // idle — skip this tick

  try {
    await apiRequest('POST', '/activity/ping', { token: session.token, tenantId: session.tenantId });
  } catch (err) {
    console.error('Heartbeat failed:', err.message);
  }
}

async function captureAndUploadScreenshot() {
  const session = getSession();
  if (!session?.token) return;
  if (!session.monitoringConsent?.accepted) return; // employee hasn't consented — never capture

  try {
    const settings = await apiRequest('GET', '/monitoring/settings', { token: session.token, tenantId: session.tenantId });
    if (!settings?.data?.screenshotsEnabled) return; // tenant has since turned it off

    const primaryDisplay = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(primaryDisplay.size.width / 2), height: Math.round(primaryDisplay.size.height / 2) },
    });
    const primary = sources[0];
    if (!primary) return;

    const pngBuffer = primary.thumbnail.toPNG();
    const imageBase64 = pngBuffer.toString('base64');

    await apiRequest('POST', '/monitoring/screenshot', {
      token: session.token,
      tenantId: session.tenantId,
      body: { imageBase64, contentType: 'image/png' },
    });
  } catch (err) {
    console.error('Screenshot capture/upload failed:', err.message);
  }
}

async function refreshMonitoringLoop() {
  const session = getSession();
  if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null; }
  if (!session?.token || !session.monitoringConsent?.accepted) return;

  try {
    const settings = await apiRequest('GET', '/monitoring/settings', { token: session.token, tenantId: session.tenantId });
    if (settings?.data?.screenshotsEnabled) {
      const intervalMs = Math.max(Number(settings.data.screenshotIntervalMinutes) || 30, 5) * 60 * 1000;
      screenshotInterval = setInterval(captureAndUploadScreenshot, intervalMs);
    }
  } catch (err) {
    console.error('Failed to refresh monitoring settings:', err.message);
  }
}

function startTracking() {
  stopTracking();
  heartbeatInterval = setInterval(sendHeartbeatIfActive, HEARTBEAT_MS);
  refreshMonitoringLoop();
  settingsPollInterval = setInterval(refreshMonitoringLoop, SETTINGS_POLL_MS);
  updateTray('Active');
}

function stopTracking() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null; }
  if (settingsPollInterval) { clearInterval(settingsPollInterval); settingsPollInterval = null; }
}

function handleLogout() {
  clearSession();
  stopTracking();
  updateTray('Not signed in');
  if (mainWindow) {
    mainWindow.show();
    mainWindow.webContents.send('session:cleared');
  }
}

// ── IPC bridge (renderer talks to the backend only through here) ───────────
// Login mirrors the web app: email + password only. /auth/login is a public
// (tenant-bypassed) route that looks the account up by email and returns
// which tenant it belongs to — the agent doesn't need the employee to know
// or enter a tenant ID up front.
function sessionFromLoginResult(result) {
  return {
    token: result.data.token,
    tenantId: result.data.tenant?._id,
    tenantName: result.data.tenant?.name,
    user: { id: result.data._id, name: result.data.name, email: result.data.email, role: result.data.role },
    monitoringConsent: result.data.monitoringConsent || { accepted: false },
  };
}

ipcMain.handle('api:login', async (event, { email, password }) => {
  const result = await apiRequest('POST', '/auth/login', { body: { email, password } });
  if (result?.data?.requiresOtp) return result; // 2FA — renderer handles the OTP step, no session saved yet

  if (result?.data?.role !== 'Employee') {
    throw new Error('This agent is for employee accounts. HR admins should use the web app.');
  }

  const session = sessionFromLoginResult(result);
  setSession(session);
  startTracking();
  return result;
});

ipcMain.handle('api:verifyOtp', async (event, { pendingToken, code }) => {
  const result = await apiRequest('POST', '/auth/verify-otp', { body: { pendingToken, code } });
  if (result?.data?.role !== 'Employee') {
    throw new Error('This agent is for employee accounts. HR admins should use the web app.');
  }
  const session = sessionFromLoginResult(result);
  setSession(session);
  startTracking();
  return result;
});

ipcMain.handle('api:getSession', async () => getSession());

ipcMain.handle('api:logout', async () => { handleLogout(); return { success: true }; });

ipcMain.handle('api:getMonitoringSettings', async () => {
  const session = getSession();
  if (!session?.token) throw new Error('Not signed in.');
  return apiRequest('GET', '/monitoring/settings', { token: session.token, tenantId: session.tenantId });
});

ipcMain.handle('api:setMonitoringConsent', async (event, { accepted }) => {
  const session = getSession();
  if (!session?.token) throw new Error('Not signed in.');
  const result = await apiRequest('PUT', '/monitoring/consent', {
    token: session.token,
    tenantId: session.tenantId,
    body: { accepted, version: 'agent-v1' },
  });
  session.monitoringConsent = result.data;
  setSession(session);
  refreshMonitoringLoop();
  return result;
});

ipcMain.handle('api:getMyActivity', async () => {
  const session = getSession();
  if (!session?.token) throw new Error('Not signed in.');
  return apiRequest('GET', '/activity/me?days=1', { token: session.token, tenantId: session.tenantId });
});

// ── App lifecycle ───────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();

  const session = getSession();
  if (session?.token) startTracking();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in the tray on all platforms rather than quitting — the
  // whole point is that tracking continues while the window is closed.
});

app.on('before-quit', () => { app.isQuitting = true; stopTracking(); });
