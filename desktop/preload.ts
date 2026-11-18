import { contextBridge, ipcRenderer } from 'electron';

// This preload is attached only to the bundled, trusted local controller.
// The chat window uses a separate bridge for reading its device ID.
contextBridge.exposeInMainWorld('raeDevice', {
  state: () => ipcRenderer.invoke('device:state'),
  pair: (baseUrl: string, token: string, name: string) => ipcRenderer.invoke('device:pair', { baseUrl, token, name }),
  revokeGrant: (id: string) => ipcRenderer.invoke('device:revoke-grant', { id }),
  pause: () => ipcRenderer.invoke('device:pause'),
  resume: () => ipcRenderer.invoke('device:resume'),
  reconnect: () => ipcRenderer.invoke('device:reconnect'),
  openChat: () => ipcRenderer.invoke('device:open-chat'),
  checkUpdate: () => ipcRenderer.invoke('device:check-update'),
  installUpdate: () => ipcRenderer.invoke('device:install-update'),
  wechatWindows: () => ipcRenderer.invoke('device:wechat-windows'),
  wechatTopics: () => ipcRenderer.invoke('device:wechat-topics'),
  wechatSettings: () => ipcRenderer.invoke('device:wechat-settings'),
  wechatAdd: (windowIds: string[], caseId: string, options: unknown) => ipcRenderer.invoke('device:wechat-add', windowIds, caseId, options),
  wechatAction: (entryId: string, action: string, options?: unknown) => ipcRenderer.invoke('device:wechat-action', entryId, action, options),
  wechatRemove: (entryId: string) => ipcRenderer.invoke('device:wechat-remove', entryId),
  wechatSetAutoStart: (enabled: boolean) => ipcRenderer.invoke('device:wechat-auto-start', enabled),
  onWeChatSettings: (listener: (state: unknown) => void) => {
    const receive = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('device:wechat-settings-changed', receive);
    return () => ipcRenderer.removeListener('device:wechat-settings-changed', receive);
  },
  onWeChatReset: (listener: () => void) => {
    const receive = () => listener();
    ipcRenderer.on('device:wechat-reset', receive);
    return () => ipcRenderer.removeListener('device:wechat-reset', receive);
  },
  onState: (listener: (state: unknown) => void) => {
    const receive = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('device:changed', receive);
    return () => ipcRenderer.removeListener('device:changed', receive);
  },
});
