import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('inspector', {
  // VM Connection
  connect: (url: string) => ipcRenderer.invoke('vm:connect', url),
  autoDiscover: () => ipcRenderer.invoke('vm:autoDiscover'),
  disconnect: () => ipcRenderer.invoke('vm:disconnect'),

  // Widget Tree
  getWidgetTree: () => ipcRenderer.invoke('vm:getWidgetTree'),
  findWidgetAt: (x: number, y: number) => ipcRenderer.invoke('vm:findWidgetAt', x, y),

  // Screenshots
  takeScreenshot: () => ipcRenderer.invoke('device:screenshot'),
  startScreenStream: (intervalMs: number) => ipcRenderer.invoke('screenshot:startStream', intervalMs),
  stopScreenStream: () => ipcRenderer.invoke('screenshot:stopStream'),
  setPlatform: (platform: string) => ipcRenderer.invoke('device:setPlatform', platform),

  // Screenshot stream listener
  onScreenshotUpdate: (callback: (data: any) => void) => {
    ipcRenderer.on('screenshot:update', (_event, data) => callback(data));
  },
});
