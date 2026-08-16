// Exposes a small, explicit API surface to the renderer. contextIsolation is
// on and nodeIntegration is off (see main.js BrowserWindow config), so the
// renderer never gets direct Node/Electron access — only what's listed here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hrmsAgent', {
  login: (email, password) => ipcRenderer.invoke('api:login', { email, password }),
  verifyOtp: (pendingToken, code) => ipcRenderer.invoke('api:verifyOtp', { pendingToken, code }),
  getSession: () => ipcRenderer.invoke('api:getSession'),
  logout: () => ipcRenderer.invoke('api:logout'),
  getMonitoringSettings: () => ipcRenderer.invoke('api:getMonitoringSettings'),
  setMonitoringConsent: (accepted) => ipcRenderer.invoke('api:setMonitoringConsent', { accepted }),
  getMyActivity: () => ipcRenderer.invoke('api:getMyActivity'),
  onSessionCleared: (callback) => ipcRenderer.on('session:cleared', callback),
});
