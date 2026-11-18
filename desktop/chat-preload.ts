import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopNotice } from '../shared/desktop-notifications.js';

contextBridge.exposeInMainWorld('raeNotifications', {
  show: (notice: DesktopNotice) => ipcRenderer.invoke('chat:notification', notice),
  clear: () => ipcRenderer.invoke('chat:notifications-clear'),
  setBadge: (count: number) => ipcRenderer.invoke('chat:notification-badge', count),
  onOpen: (listener: (caseId: string) => void) => {
    const receive = (_event: unknown, caseId: string) => listener(caseId);
    ipcRenderer.on('chat:notification-open', receive);
    return () => ipcRenderer.removeListener('chat:notification-open', receive);
  },
});

contextBridge.exposeInMainWorld('raeLocalDevice', {
  prepareModelLogin: () => ipcRenderer.invoke('chat:model-login-prepare'),
  openModelLogin: (input: { attemptId: string; authUrl: string }) => ipcRenderer.invoke('chat:model-login-open', input),
  cancelModelLogin: (input: { attemptId: string }) => ipcRenderer.invoke('chat:model-login-cancel', input),
  openWeChatSettings: () => ipcRenderer.invoke('chat:wechat-settings'),
  currentId: () => ipcRenderer.invoke('chat:local-device-id'),
  chooseProject: () => ipcRenderer.invoke('chat:choose-project'),
  openProjectPreview: (deviceId: string, url: string) => ipcRenderer.invoke('chat:project-preview', { deviceId, url }),
  openProjectFolder: (deviceId: string, operationId: string) => ipcRenderer.invoke('chat:project-folder', { deviceId, operationId }),
  onId: (listener: (id: string | undefined) => void) => {
    const receive = (_event: unknown, id: string | undefined) => listener(id);
    ipcRenderer.on('chat:local-device-changed', receive);
    return () => ipcRenderer.removeListener('chat:local-device-changed', receive);
  },
});
