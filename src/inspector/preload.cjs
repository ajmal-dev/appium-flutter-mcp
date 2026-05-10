const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inspector', {
  connect: (url) => ipcRenderer.invoke('vm:connect', url),
  autoDiscover: () => ipcRenderer.invoke('vm:autoDiscover'),
  disconnect: () => ipcRenderer.invoke('vm:disconnect'),
  getWidgetTree: () => ipcRenderer.invoke('vm:getWidgetTree'),
  findWidgetAt: (x, y) => ipcRenderer.invoke('vm:findWidgetAt', x, y),

  // WebView & Native inspection
  inspectWebview: () => ipcRenderer.invoke('webview:inspect'),
  inspectNative: () => ipcRenderer.invoke('native:inspect'),

  takeScreenshot: () => ipcRenderer.invoke('device:screenshot'),
  startScreenStream: (ms) => ipcRenderer.invoke('screenshot:startStream', ms),
  stopScreenStream: () => ipcRenderer.invoke('screenshot:stopStream'),
  onScreenshotUpdate: (cb) => { ipcRenderer.on('screenshot:update', (_e, d) => cb(d)); },
});
