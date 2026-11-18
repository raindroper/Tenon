import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DeviceEnrollment } from '../shared/local-device.js';
import { atomicJson } from './journal.js';
import { allowPagePermission, secureBaseUrl, type LocalGrant } from './security.js';
import { enrollDevice, enrollFromLogin } from './enrollment.js';
import { createDesktopUpdater, type DesktopUpdateInfo } from './updater.js';
import { WeChatDatabaseReader, type WeChatChat } from './wechat-database.js';
import { listWeChatTopics, readWeChatStatus, analyzeWeChat, findWeChatGrant, revokeWeChatGrant, type WeChatTopic } from './wechat-transport.js';
import { SavedWeChatObservers } from './wechat-observer.js';
import { readSavedWeChatSettings, sameWeChatChat, type SavedWeChatSettings } from './wechat-settings.js';
import { MAX_WECHAT_OBSERVATIONS_PER_DEVICE } from '../shared/wechat-observation.js';
import { WeChatProgressJournal } from './wechat-progress.js';
import { DesktopNotifications, taskbarBadgeBitmap, taskbarBadgeSize } from './notifications.js';
import { desktopBadgeCountSchema } from '../shared/desktop-notifications.js';
import { isLocalPreviewUrl } from '../shared/local-project.js';
import { ProjectJournal } from './project-journal.js';
import { desktopProfile } from './publisher-profile.js';
import { captureProject, projectResources } from './project-configuration.js';
import { ModelLoginBridge } from './model-login.js';

app.setAppUserModelId(desktopProfile.appId);
// Electron otherwise derives both the device store and the browser profile from productName.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const profile = path.join(app.getPath('appData'), 'Another Rae');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const controllerUrl = pathToFileURL(path.join(directory, 'controller.html')).href;
const chatGptUsageUrl = 'https://chatgpt.com/settings/usage';
interface Settings { baseUrl: string; name: string; deviceId?: string; encryptedCredential?: string; grants: LocalGrant[]; paused: boolean; wechat: SavedWeChatSettings }
let settings: Settings = { baseUrl: desktopProfile.baseUrl, name: '我的 Windows 电脑', grants: [], paused: true, wechat: readSavedWeChatSettings(undefined) };
let status = settings.baseUrl ? '在桌面客户端登录后，这台电脑会自动连接。' : '请先在手动配对中填写你的 HTTPS 服务地址并连接设备。';
let controller: BrowserWindow | undefined;
let chat: BrowserWindow | undefined;
let chatBadgeCount = 0;
let worker: UtilityProcess | undefined;
let tray: Tray | undefined;
let workerReady = false;
let online = false;
let quitting = false;
let closing = false;
let workerWasConfigured = false;
let unconfirmedWorkerExit = false;
let draining = false;
let localMutation: Promise<unknown> = Promise.resolve();
let wechatScope = new AbortController();
let wechatLoginAvailable = false;
const wechatChats = new Map<string, { chat: WeChatChat; ambiguous: boolean }>();
const wechatTopics = new Map<string, WeChatTopic>();
const wechatReader = new WeChatDatabaseReader();
const modelLogin = new ModelLoginBridge(url => shell.openExternal(url));
const wechatProgress = new WeChatProgressJournal(() => path.join(app.getPath('userData'), 'wechat-progress'), value => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法保存微信断点。');
  return safeStorage.encryptString(value).toString('base64');
}, value => safeStorage.decryptString(Buffer.from(value, 'base64')));
const wechatObservers = new SavedWeChatObservers(wechatReader, publishWeChat, wechatProgress);
const desktopNotifications = new DesktopNotifications((title, body) => {
  if (!Notification.isSupported()) throw new Error('当前 Windows 环境不支持桌面通知。');
  return new Notification({ title, body, icon: path.join(directory, 'tray.png') });
}, caseId => {
  if (closing || !chat || chat.isDestroyed() || !isConfiguredChat(chat.webContents.getURL())) return;
  openChat(); chat.webContents.send('chat:notification-open', caseId);
}, () => Boolean(chat && !chat.isDestroyed() && chat.isVisible() && !chat.isMinimized() && chat.isFocused()));

function applyChatBadge(): void {
  if (!chat || chat.isDestroyed()) return;
  const count = chatBadgeCount;
  const image = count ? nativeImage.createFromBitmap(taskbarBadgeBitmap(count), { width: taskbarBadgeSize, height: taskbarBadgeSize }) : null;
  chat.setOverlayIcon(image, count ? `${count} 个未读场景` : '');
}

function clearChatNotifications(): void {
  desktopNotifications.clear();
  if (chatBadgeCount === 0) return;
  chatBadgeCount = 0;
  applyChatBadge();
}
const wechatOptionsSchema = z.object({ historySince: z.string().datetime().optional(), historyUntil: z.string().datetime().optional(),
  analysisIntervalMinutes: z.number().int().min(1).max(60).default(10) }).strict()
  .refine(value => !value.historySince || Date.parse(value.historySince) <= Date.now(), '开始时间不能晚于现在。')
  .refine(value => !value.historyUntil || Boolean(value.historySince && value.historyUntil >= value.historySince && Date.parse(value.historyUntil) <= Date.now()), '历史结束时间无效。');
function publishWeChat(): void {
  if (controller && !controller.isDestroyed()) controller.webContents.send('device:wechat-settings-changed', wechatObservers.state(settings.wechat));
}
const updateEnabled = Boolean(desktopProfile.updates) && app.isPackaged && process.platform === 'win32' && process.arch === 'x64';
let updater: ReturnType<typeof createDesktopUpdater> | undefined;
type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error';
let updatePhase: UpdatePhase = 'idle';
let updateMessage = updateEnabled ? '可以手动检查是否有新版本。' : desktopProfile.updates ? 'Windows x64 安装版支持更新。' : '此安装包未配置更新来源。';
let updateInfo: DesktopUpdateInfo | undefined;
let updateCheck: Promise<void> | undefined;
const stopWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
const stateFile = () => path.join(app.getPath('userData'), 'device.json');
const persist = () => atomicJson(stateFile(), settings);
function view() { return { baseUrl: settings.baseUrl, name: settings.name, paired: Boolean(settings.deviceId), paused: settings.paused, online, closing,
  update: { enabled: updateEnabled, currentVersion: app.getVersion(), availableVersion: updateInfo?.version, phase: updatePhase, message: updateMessage },
  status, grants: settings.grants.map(({ id, revision, root, executable, readOnly, toolchainRoot, available, reason }) => ({ id, revision, root, executable, readOnly, toolchainRoot, available, reason })), draining }; }
function publish() { if (controller && !controller.isDestroyed()) controller.webContents.send('device:changed', view()); }
function isConfiguredChat(url: string): boolean {
  try { return new URL(url).origin === settings.baseUrl; } catch { return false; }
}
function credential(): string {
  if (!settings.encryptedCredential || !safeStorage.isEncryptionAvailable()) throw new Error('设备凭据不可用，请重新配对。');
  return safeStorage.decryptString(Buffer.from(settings.encryptedCredential, 'base64'));
}
function trusted(event: IpcMainInvokeEvent, readOnly = false): void {
  if (!controller || event.sender !== controller.webContents || event.senderFrame?.url !== controllerUrl || event.senderFrame !== event.sender.mainFrame) throw new Error('仅本地设备控制台可使用此入口。');
  if (closing && !readOnly) throw new Error('应用正在结束本地操作，不再接受新的设备变更。');
}
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = localMutation.then(work); localMutation = next.catch(() => {}); return next;
}
function resetWeChat(): void {
  wechatScope.abort();
  wechatScope = new AbortController();
  wechatChats.clear();
  wechatTopics.clear();
  if (controller && !controller.isDestroyed()) controller.webContents.send('device:wechat-reset');
}
function requireWeChatScope(signal: AbortSignal): void {
  if (signal.aborted || !controller?.isVisible() || controller.isMinimized()) throw new Error('请重新打开本地设备面板并选择微信会话。');
}
function wechatRequest<T>(event: IpcMainInvokeEvent, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  trusted(event);
  const { signal } = wechatScope;
  return serialize(async () => {
    requireWeChatScope(signal);
    return work(signal);
  });
}
function wechatOwnerFetch() {
  if (!chat || chat.isDestroyed() || !isConfiguredChat(chat.webContents.getURL())) throw new Error('请先在榫桌面客户端登录。');
  const session = chat.webContents.session;
  return (url: string, init: RequestInit) => session.fetch(url, init);
}
function restoreWeChat(afterLogin = false, onlyId?: string): void {
  if (closing || !onlyId && !settings.wechat.autoStart || !settings.wechat.entries.length || !settings.deviceId || !wechatLoginAvailable) return;
  if (!chat || chat.isDestroyed() || !isConfiguredChat(chat.webContents.getURL())) return;
  const selected = onlyId ? { ...settings.wechat, autoStart: true, entries: settings.wechat.entries.filter(entry => entry.id === onlyId) } : settings.wechat;
  wechatObservers.restore(selected, { baseUrl: settings.baseUrl, deviceId: settings.deviceId,
    token: credential(), ownerFetch: wechatOwnerFetch() }, afterLogin);
}
async function persistWeChat(wechat: SavedWeChatSettings): Promise<void> {
  const next = { ...settings, wechat };
  await atomicJson(stateFile(), next);
  settings = next;
  publishWeChat();
}
function setUpdatePhase(phase: UpdatePhase, message: string): void {
  updatePhase = phase;
  updateMessage = message;
  publish();
}

async function checkForDesktopUpdate(): Promise<ReturnType<typeof view>> {
  const activeUpdater = updater;
  if (!activeUpdater || !updateEnabled || closing) return view();
  if (updateCheck) {
    await updateCheck;
    return view();
  }
  updateInfo = undefined;
  setUpdatePhase('checking', '正在检查桌面更新…');
  const check = (async () => {
    try {
      updateInfo = await activeUpdater.check();
      if (updateInfo) setUpdatePhase('available', `发现新版本 ${updateInfo.version}。`);
      else setUpdatePhase('current', '已是最新版本。');
    } catch (error) {
      setUpdatePhase('error', error instanceof Error ? error.message : '检查更新失败，请稍后重试。');
    }
  })();
  updateCheck = check;
  try { await check; }
  finally { updateCheck = undefined; }
  return view();
}

function quitAfterDrain(): void {
  quitting = true;
  clearChatNotifications();
  try { worker?.kill(); } catch { /* The worker has already acknowledged its drain. */ }
  app.quit();
}

async function installDesktopUpdate(): Promise<ReturnType<typeof view>> {
  const activeUpdater = updater;
  const candidate = updateInfo;
  if (!activeUpdater || !updateEnabled || !candidate || updateCheck || closing) throw new Error('请先检查并确认可用的桌面更新。');

  // Fence owner mutations before the operation enters the existing lifecycle queue.
  closing = true;
  setUpdatePhase('downloading', `正在下载 ${candidate.version} 安装包…`);
  return serialize(async () => {
    let drainStarted = false;
    let drained = false;
    try {
      let displayedProgress = -1;
      await activeUpdater.download(candidate, percent => {
        if (updatePhase !== 'downloading' || !Number.isFinite(percent)) return;
        const progress = Math.floor(Math.min(100, Math.max(0, percent)));
        if (progress <= displayedProgress) return;
        displayedProgress = progress;
        setUpdatePhase('downloading', `正在下载安装包 ${progress}%。`);
      });
      setUpdatePhase('installing', '安装包已验证，正在等待本地操作结束…');
      drainStarted = true;
      await wechatObservers.stop();
      await stopWorker();
      drained = true;
      await activeUpdater.install();
      quitAfterDrain();
    } catch (error) {
      if (!drainStarted || drained) closing = false;
      if (drained) {
        status = '安装未启动，正在恢复设备连接…';
        try { configureWorker(); restoreWeChat(); }
        catch { status = '安装未启动，设备连接需手动恢复。'; }
      }
      if (drainStarted && !drained) status = '本地操作结束未确认。';
      setUpdatePhase('error', error instanceof Error ? error.message : '安装未启动，请稍后重试。');
    }
    return view();
  });
}
async function stopWorker(): Promise<void> {
  if (unconfirmedWorkerExit) throw new Error('执行进程曾意外退出，原操作停止未确认；不会声明安全退出完成。');
  if (!worker || !workerReady) return;
  draining = true; status = '正在等待本地原生操作和输出结束…'; publish();
  const requestId = randomUUID();
  await new Promise<void>((resolve, reject) => { stopWaiters.set(requestId, { resolve, reject }); worker!.postMessage({ kind: 'stop', requestId }); });
  workerWasConfigured = false;
  online = false;
  draining = false; publish();
}
function configureWorker(): void {
  if (closing || !worker || !workerReady || settings.paused || !settings.deviceId) return;
  if (unconfirmedWorkerExit) throw new Error('本地执行状态未确认，请检查原操作后重启应用。');
  workerWasConfigured = true;
  worker.postMessage({ kind: 'configure', configuration: { baseUrl: settings.baseUrl, deviceId: settings.deviceId,
    credential: credential(), grants: settings.grants, privateDirectory: app.getPath('userData'), downloadsDirectory: app.getPath('downloads'), version: app.getVersion(),
    projectResources: projectResources(directory, app.isPackaged ? path.join(process.resourcesPath, 'vendor') : undefined) } });
}
async function saveEnrollment(baseUrl: string, name: string, enrollment: DeviceEnrollment): Promise<void> {
  const next = { ...settings, baseUrl, name, deviceId: enrollment.device.id,
    encryptedCredential: safeStorage.encryptString(enrollment.credential).toString('base64'), paused: false,
    wechat: settings.deviceId === enrollment.device.id ? settings.wechat : { ...settings.wechat, autoStart: false } };
  await atomicJson(stateFile(), next);
  settings = next;
  status = '这台电脑已登记，正在连接…';
  configureWorker();
  if (chat && !chat.isDestroyed() && isConfiguredChat(chat.webContents.getURL())) chat.webContents.send('chat:local-device-changed', settings.deviceId);
  publishWeChat();
  publish();
}
function launchWorker(): void {
  worker = utilityProcess.fork(path.join(directory, 'utility.js'), [], { serviceName: 'Tenon Local Hand', stdio: 'pipe' });
  worker.on('message', message => {
    if (message.kind === 'ready') { workerReady = true; configureWorker(); }
    else if (message.kind === 'connection') { online = message.online === true; publish(); }
    else if (message.kind === 'status') { status = String(message.message).slice(0, 4000); publish(); }
    else if (message.kind === 'grants') {
      for (const grant of settings.grants) { const reported = message.grants.find((item: { id: string; revision: number }) => item.id === grant.id && item.revision === grant.revision); if (reported) { grant.available = reported.available; grant.reason = reported.reason; } }
      publish();
    } else if (message.kind === 'stopped') { stopWaiters.get(message.requestId)?.resolve(); stopWaiters.delete(message.requestId); }
    else if (message.kind === 'stop-failed') { stopWaiters.get(message.requestId)?.reject(new Error(String(message.error))); stopWaiters.delete(message.requestId); }
  });
  worker.on('exit', () => { if (!quitting && workerWasConfigured) unconfirmedWorkerExit = true; workerReady = false; online = false; worker = undefined; for (const waiter of stopWaiters.values()) waiter.reject(new Error('执行进程断开，不能确认原操作停止。')); stopWaiters.clear(); status = '本地执行进程已退出；未确认的操作保留未知状态。请重启应用检查。'; publish(); });
  worker.stderr?.on('data', () => { /* Never expose native diagnostics or local credentials to the remote page. */ });
}
function createController(): void {
  if (controller && !controller.isDestroyed()) { controller.show(); controller.focus(); return; }
  controller = new BrowserWindow({ width: 900, height: 780, minWidth: 640, minHeight: 560, title: '榫 · 本地设备', backgroundColor: '#f4f1ea', icon: path.join(directory, 'tray.png'),
    webPreferences: { preload: path.join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  controller.removeMenu();
  controller.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controller.webContents.on('will-navigate', event => event.preventDefault());
  controller.webContents.on('render-process-gone', resetWeChat);
  void controller.loadURL(controllerUrl);
  controller.on('hide', resetWeChat);
  controller.on('minimize', resetWeChat);
  controller.on('close', event => { if (!quitting) { event.preventDefault(); controller?.hide(); } });
}
function openChat(): void {
  if (!settings.baseUrl) { createController(); return; }
  if (chat && !chat.isDestroyed()) { if (chat.isMinimized()) chat.restore(); chat.show(); chat.focus(); return; }
  const origin = secureBaseUrl(settings.baseUrl);
  chat = new BrowserWindow({ width: 1100, height: 850, minWidth: 480, title: '榫 Tenon', icon: path.join(directory, 'tray.png'),
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#f6f8fb', symbolColor: '#1a2330', height: 64 }, backgroundColor: '#f6f8fb',
    webPreferences: { preload: path.join(directory, 'chat-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'persist:rae-chat', backgroundThrottling: false } });
  chat.removeMenu();
  chat.webContents.setWindowOpenHandler(({ url }) => {
    if (!closing && url === chatGptUsageUrl) {
      void shell.openExternal(chatGptUsageUrl).catch(() => {
        if (!closing) dialog.showErrorBox('无法打开 ChatGPT 用量设置', `请在系统浏览器中访问 ${chatGptUsageUrl}`);
      });
    }
    return { action: 'deny' };
  });
  const blockOutsideOrigin = (event: { preventDefault(): void }, target: string) => { try { if (new URL(target).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } };
  chat.webContents.on('will-navigate', blockOutsideOrigin);
  chat.webContents.on('will-redirect', blockOutsideOrigin);
  chat.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(webContents === chat?.webContents && allowPagePermission(permission, origin, details.requestingUrl, details.isMainFrame)));
  chat.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    webContents === chat?.webContents && allowPagePermission(permission, origin, requestingOrigin, details.isMainFrame));
  const window = chat;
  const modelLoginOwner = window.webContents.id;
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  const reapplyBadge = () => { if (chat === window && chatBadgeCount > 0) applyChatBadge(); };
  window.on('show', reapplyBadge);
  window.on('restore', reapplyBadge);
  window.webContents.on('did-start-navigation', ({ isSameDocument, isMainFrame }) => {
    if (isMainFrame && !isSameDocument) clearChatNotifications();
  });
  window.webContents.on('render-process-gone', clearChatNotifications);
  const session = window.webContents.session;
  let loginRevision = 0;
  let attemptedRevision = -1;
  function connectAfterLogin(): void {
    if (closing || settings.deviceId || settings.encryptedCredential) return;
    void serialize(async () => {
      const revision = loginRevision;
      const isCurrent = () => !closing && !window.isDestroyed() && chat === window && settings.baseUrl === origin && revision === loginRevision;
      if (!isCurrent() || attemptedRevision === revision || settings.deviceId || settings.encryptedCredential || !safeStorage.isEncryptionAvailable()) return;
      attemptedRevision = revision;
      const enrollment = await enrollFromLogin({ baseUrl: origin, name: settings.name, ownerFetch: (url, init) => session.fetch(url, init), isCurrent });
      if (enrollment) await saveEnrollment(origin, settings.name, enrollment);
    }).catch(() => {
      if (!closing && chat === window && !settings.deviceId) {
        status = '这台电脑暂时无法连接。可以刷新对话重试，或在此窗口手动配对。';
        publish();
      }
    });
  }
  const host = new URL(origin).hostname;
  const matchesOwnerCookie = (cookie: Electron.Cookie) => cookie.name === '__Host-rae_session' && cookie.domain === host &&
    cookie.path === '/' && cookie.secure && cookie.httpOnly && cookie.hostOnly;
  function onCookieChanged(_event: unknown, cookie: Electron.Cookie, _cause: string, removed: boolean): void {
    if (!matchesOwnerCookie(cookie)) return;
    loginRevision++;
    wechatLoginAvailable = !removed;
    resetWeChat();
    if (removed) {
      void modelLogin.close(modelLoginOwner);
      clearChatNotifications();
      wechatObservers.cancel();
      void serialize(() => wechatObservers.stop());
    } else {
      connectAfterLogin();
      void serialize(async () => restoreWeChat(true)).catch(() => {});
    }
  }
  session.cookies.on('changed', onCookieChanged);
  window.webContents.on('did-finish-load', () => {
    const revision = ++loginRevision;
    connectAfterLogin();
    void session.cookies.get({ url: origin, name: '__Host-rae_session' }).then(cookies => serialize(async () => {
      if (closing || window.isDestroyed() || chat !== window || settings.baseUrl !== origin || revision !== loginRevision) return;
      wechatLoginAvailable = cookies.some(matchesOwnerCookie);
      restoreWeChat(true);
    })).catch(() => {});
  });
  window.once('closed', () => {
    void modelLogin.close(modelLoginOwner);
    if (chat === window) clearChatNotifications();
    session.cookies.removeListener('changed', onCookieChanged);
    wechatLoginAvailable = false;
    resetWeChat();
  });
  void chat.loadURL(origin);
}
async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  if (process.platform !== 'win32') throw new Error('当前桌面本地执行仅支持 Windows。');
  updater = createDesktopUpdater({ currentVersion: app.getVersion(), enabled: updateEnabled });
  try {
    const saved = JSON.parse(await readFile(stateFile(), 'utf8')) as Partial<Settings>;
    const baseUrl = saved.baseUrl ?? settings.baseUrl;
    if (!baseUrl && (saved.deviceId || saved.encryptedCredential)) throw new Error('已配对设备缺少服务地址。');
    settings = { ...settings, ...saved, baseUrl: baseUrl ? secureBaseUrl(baseUrl) : '', wechat: readSavedWeChatSettings(saved.wechat) };
    if (settings.deviceId) status = settings.paused ? '本地执行已暂停。' : '这台电脑已登记，正在连接…';
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { settings.paused = true; status = '本地配置无法读取，请重新配对并核对授权。'; } }
  ipcMain.handle('device:state', event => { trusted(event, true); return view(); });
  ipcMain.handle('device:wechat-windows', event => wechatRequest(event, async signal => {
    wechatChats.clear();
    const chats = await wechatReader.list(signal);
    requireWeChatScope(signal);
    const titles = new Map<string, number>();
    const titleKey = (title: string) => title.normalize('NFKC').trim().toLowerCase();
    for (const chat of chats) { const key = titleKey(chat.title); titles.set(key, (titles.get(key) ?? 0) + 1); }
    return chats.map(chat => {
      const id = randomUUID();
      const ambiguous = (titles.get(titleKey(chat.title)) ?? 0) > 1;
      wechatChats.set(id, { chat, ambiguous });
      return { id, title: chat.title, ambiguous, chatType: chat.chatId.endsWith('@chatroom') ? 'group' : 'private',
        disambiguation: chat.disambiguation,
        saved: settings.wechat.entries.some(entry => 'chat' in entry && sameWeChatChat(entry.chat, chat)) };
    });
  }));
  ipcMain.handle('device:wechat-topics', event => wechatRequest(event, async signal => {
    wechatTopics.clear();
    const topics = await listWeChatTopics(settings.baseUrl, wechatOwnerFetch());
    requireWeChatScope(signal);
    for (const topic of topics) wechatTopics.set(topic.id, topic);
    return topics;
  }));
  ipcMain.handle('device:wechat-add', (event, selectionIds: unknown, caseId: unknown, options: unknown = {}) => wechatRequest(event, async () => {
    const selectedOptions = wechatOptionsSchema.parse(options);
    const topic = typeof caseId === 'string' ? wechatTopics.get(caseId) : undefined;
    if (!Array.isArray(selectionIds) || selectionIds.length < 1 || selectionIds.length > MAX_WECHAT_OBSERVATIONS_PER_DEVICE ||
      selectionIds.some(id => typeof id !== 'string') || new Set(selectionIds).size !== selectionIds.length || !topic) throw new Error('请勾选微信会话和一个榫场景。');
    if (!settings.deviceId) throw new Error('请先登录榫桌面客户端并登记这台电脑。');
    const entries = [...settings.wechat.entries];
    if (entries.length + selectionIds.length > MAX_WECHAT_OBSERVATIONS_PER_DEVICE) throw new Error(`最多保存 ${MAX_WECHAT_OBSERVATIONS_PER_DEVICE} 个微信会话。`);
    for (const selectionId of selectionIds) {
      const choice = wechatChats.get(selectionId);
      if (!choice) throw new Error('会话已变化，请重新查找。');
      if (entries.some(entry => 'chat' in entry && sameWeChatChat(entry.chat, choice.chat))) throw new Error('已经保存了这条会话。如需换场景，请先移除旧条目。');
      entries.push({ id: randomUUID(), chat: choice.chat, topic, addedAt: new Date().toISOString(), ...selectedOptions });
    }
    const next = { ...settings.wechat, entries };
    if (readSavedWeChatSettings(next).entries.length !== entries.length) throw new Error('所选会话信息无效，请刷新会话和场景后重试。');
    await persistWeChat(next);
    restoreWeChat();
    return wechatObservers.state(settings.wechat);
  }));
  ipcMain.handle('device:wechat-settings', event => { trusted(event, true); return wechatObservers.state(settings.wechat); });
  ipcMain.handle('device:wechat-remove', (event, id: unknown) => { trusted(event); return serialize(async () => {
    if (typeof id !== 'string' || !settings.wechat.entries.some(entry => entry.id === id)) throw new Error('微信观察范围已变化，请重新查看。');
    await persistWeChat({ ...settings.wechat, entries: settings.wechat.entries.map(entry => entry.id === id ? { ...entry, paused: true } : entry) });
    await wechatObservers.stop(id);
    const grantId = wechatObservers.grantId(id) ?? await findWeChatGrant(settings.baseUrl, wechatOwnerFetch(), settings.deviceId!, id);
    if (grantId) await revokeWeChatGrant(settings.baseUrl, wechatOwnerFetch(), grantId);
    const entries = settings.wechat.entries.filter(entry => entry.id !== id);
    await persistWeChat({ autoStart: settings.wechat.autoStart && entries.some(entry => 'chat' in entry), entries });
    await wechatProgress.remove(id);
    return wechatObservers.state(settings.wechat);
  }); });
  ipcMain.handle('device:wechat-action', (event, id: unknown, action: unknown, interval: unknown) => wechatRequest(event, async signal => {
    const entry = settings.wechat.entries.find(item => item.id === id);
    if (!entry || !('chat' in entry)) throw new Error('请重新选择已保存的微信会话。');
    if (action === 'status' || action === 'analyze') {
      const grantId = wechatObservers.grantId(entry.id) ?? await findWeChatGrant(settings.baseUrl, wechatOwnerFetch(), settings.deviceId!, entry.id);
      if (!grantId) throw new Error('这条会话还没有在榫上开始观察。');
      if (action === 'analyze') await analyzeWeChat(settings.baseUrl, wechatOwnerFetch(), grantId);
      return { settings: wechatObservers.state(settings.wechat), detail: await readWeChatStatus(settings.baseUrl, wechatOwnerFetch(), grantId) };
    }
    if (!['pause', 'resume', 'restart-now', 'sync', 'interval', 'history'].includes(String(action))) throw new Error('未知的微信观察操作。');
    if (action === 'sync') { wechatObservers.sync(entry.id); return { settings: wechatObservers.state(settings.wechat) }; }
    const history = action === 'history' ? wechatOptionsSchema.parse(interval) : undefined;
    if (history && !history.historySince) throw new Error('请选择要补采的历史开始时间。');
    const cadence = action === 'interval' ? z.number().int().min(1).max(60).parse(interval) : undefined;
    await wechatObservers.stop(entry.id);
    const nextEntry = { ...entry, paused: action === 'interval' ? entry.paused : action === 'pause' };
    if (action === 'restart-now' || history) {
      const cursor = await wechatReader.baseline(entry.chat, signal, history?.historySince, history?.historyUntil);
      nextEntry.addedAt = new Date().toISOString();
      nextEntry.historySince = history?.historySince ?? nextEntry.addedAt;
      nextEntry.historyUntil = history?.historyUntil;
      const binding = JSON.stringify([settings.baseUrl, settings.deviceId, entry.chat.accountId, entry.chat.chatId, entry.topic.id]);
      await wechatProgress.save(entry.id, binding, { cursor, title: entry.chat.title,
        coverageStartAt: nextEntry.historySince, receivedRows: 0, recent: [] });
    }
    if (cadence) nextEntry.analysisIntervalMinutes = cadence;
    await persistWeChat({ ...settings.wechat,
      entries: settings.wechat.entries.map(item => item.id === entry.id ? nextEntry : item) });
    if (action !== 'pause' && !nextEntry.paused) restoreWeChat(false, entry.id);
    return { settings: wechatObservers.state(settings.wechat) };
  }));
  ipcMain.handle('device:wechat-auto-start', (event, enabled: unknown) => { trusted(event); return serialize(async () => {
    if (typeof enabled !== 'boolean') throw new Error('自动观察设置无效。');
    if (enabled && (!settings.deviceId || !settings.wechat.entries.some(entry => 'chat' in entry))) throw new Error('请先登记这台电脑并保存要观察的微信会话。');
    await persistWeChat({ ...settings.wechat, autoStart: enabled });
    if (enabled) restoreWeChat(); else await wechatObservers.stop();
    return wechatObservers.state(settings.wechat);
  }); });
  ipcMain.handle('chat:local-device-id', event => {
    if (!chat || chat.isDestroyed() || event.sender !== chat.webContents || event.senderFrame !== event.sender.mainFrame || !isConfiguredChat(event.senderFrame?.url ?? '')) return undefined;
    return settings.deviceId;
  });
  const trustedNotification = (event: IpcMainInvokeEvent) => {
    if (closing || !chat || chat.isDestroyed() || event.sender !== chat.webContents || event.senderFrame !== event.sender.mainFrame
      || !isConfiguredChat(event.senderFrame?.url ?? '')) throw new Error('通知仅限已连接的榫主窗口。');
  };
  ipcMain.handle('chat:model-login-prepare', event => { trustedNotification(event); return modelLogin.prepare(event.sender.id); });
  ipcMain.handle('chat:model-login-open', (event, value: unknown) => {
    trustedNotification(event);
    return modelLogin.open(event.sender.id, z.object({ attemptId: z.string().uuid(), authUrl: z.string().max(16_384) }).strict().parse(value));
  });
  ipcMain.handle('chat:model-login-cancel', (event, value: unknown) => {
    trustedNotification(event);
    return modelLogin.cancel(event.sender.id, z.object({ attemptId: z.string().uuid() }).strict().parse(value).attemptId);
  });
  ipcMain.handle('chat:notification', (event, value: unknown) => { trustedNotification(event); return desktopNotifications.show(value); });
  ipcMain.handle('chat:notifications-clear', event => { trustedNotification(event); desktopNotifications.clear(); });
  ipcMain.handle('chat:notification-badge', (event, value: unknown) => {
    trustedNotification(event);
    const count = desktopBadgeCountSchema.parse(value);
    if (count === chatBadgeCount) return;
    chatBadgeCount = count;
    applyChatBadge();
  });
  ipcMain.handle('chat:choose-project', async event => {
    trustedNotification(event);
    const result = await dialog.showOpenDialog(chat!, { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? undefined : { deviceId: settings.deviceId, root: result.filePaths[0] };
  });
  ipcMain.handle('chat:project-folder', async (event, value: unknown) => {
    trustedNotification(event);
    const input = z.object({ deviceId: z.string(), operationId: z.string().min(1).max(200) }).strict().parse(value);
    if (input.deviceId !== settings.deviceId) throw new Error('请在执行该任务的电脑上打开工作区。');
    const journal = new ProjectJournal(path.join(app.getPath('userData'), 'projects'));
    const entry = await journal.get(input.operationId);
    if (!entry?.realPath || !entry.identity || entry.input.spec.deviceId !== settings.deviceId) throw new Error('本机没有该任务的工作区。');
    const captured = await captureProject(entry.input, { realPath: entry.realPath, identity: entry.identity }, path.join(journal.directory(input.operationId), 'workspace'));
    const error = await shell.openPath(captured.realPath);
    if (error) throw new Error('无法打开该工作区文件夹。');
    return { opened: true };
  });
  ipcMain.handle('chat:project-preview', async (event, value: unknown) => {
    trustedNotification(event);
    const input = z.object({ deviceId: z.string(), url: z.string().max(4000) }).strict().parse(value);
    if (input.deviceId !== settings.deviceId || !isLocalPreviewUrl(input.url)) throw new Error('请在执行这个项目的电脑上打开预览。');
    const preview = new BrowserWindow({ title: '项目预览 · 榫 Tenon', width: 1200, height: 820,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'project-preview-' + randomUUID() } });
    preview.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    preview.webContents.session.setPermissionCheckHandler(() => false);
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    preview.webContents.on('will-navigate', (navigation, url) => { if (!isLocalPreviewUrl(url)) navigation.preventDefault(); });
    preview.webContents.on('will-redirect', (navigation, url) => { if (!isLocalPreviewUrl(url)) navigation.preventDefault(); });
    await preview.loadURL(input.url); return { opened: true };
  });
  ipcMain.handle('chat:wechat-settings', event => {
    if (!chat || chat.isDestroyed() || event.sender !== chat.webContents || event.senderFrame !== event.sender.mainFrame
      || !isConfiguredChat(event.senderFrame?.url ?? '')) throw new Error('请从已连接的榫客户端打开微信观察设置。');
    createController();
  });
  ipcMain.handle('device:pair', (event, value: { baseUrl: string; token: string; name: string }) => { trusted(event); return serialize(async () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全凭据存储不可用。');
    const baseUrl = secureBaseUrl(value.baseUrl);
    const addressChanged = baseUrl !== settings.baseUrl;
    if (addressChanged && (settings.deviceId || settings.encryptedCredential || settings.grants.length || settings.wechat.entries.length)) throw new Error('此客户端配置已绑定现有服务。请在当前服务上重新配对。');
    if (typeof value.token !== 'string' || value.token.length < 10 || value.token.length > 1000 || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 100) throw new Error('配对信息无效。');
    await wechatObservers.stop();
    await stopWorker();
    const enrollment = await enrollDevice(baseUrl, value.name.trim(), value.token.trim());
    await saveEnrollment(baseUrl, value.name.trim(), enrollment);
    if (addressChanged) { chat?.destroy(); openChat(); }
    return view();
  }); });
  ipcMain.handle('device:revoke-grant', (event, value: { id: string }) => { trusted(event); return serialize(async () => {
    if (typeof value.id !== 'string') throw new Error('授权编号无效。');
    await stopWorker(); settings.grants = settings.grants.filter(item => item.id !== value.id); await persist(); configureWorker(); publish(); return view();
  }); });
  ipcMain.handle('device:pause', event => { trusted(event); return serialize(async () => { settings.paused = true; await persist(); await stopWorker(); status = '本地执行已暂停。'; publish(); return view(); }); });
  ipcMain.handle('device:resume', event => { trusted(event); return serialize(async () => { if (!settings.deviceId) throw new Error('请先配对设备。'); settings.paused = false; await persist(); configureWorker(); publish(); return view(); }); });
  ipcMain.handle('device:reconnect', event => { trusted(event); return serialize(async () => {
    if (!settings.deviceId) {
      if (chat && !chat.isDestroyed()) chat.webContents.reload();
      openChat();
    } else if (!online && !settings.paused) {
      await stopWorker();
      status = '正在重新连接…';
      if (worker) configureWorker(); else launchWorker();
      publish();
    }
    return view();
  }); });
  ipcMain.handle('device:open-chat', event => { trusted(event); openChat(); });
  ipcMain.handle('device:check-update', event => { trusted(event); return checkForDesktopUpdate(); });
  ipcMain.handle('device:install-update', event => { trusted(event); return installDesktopUpdate(); });
  tray = new Tray(nativeImage.createFromPath(path.join(directory, 'tray.png')).resize({ width: 24, height: 24 }));
  tray.setToolTip('榫 Tenon · 本地设备');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开榫', click: openChat },
    { label: '本地设备与授权', click: createController },
    { label: '检查更新', enabled: updateEnabled, click: () => { createController(); void checkForDesktopUpdate(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('double-click', createController);
  app.on('second-instance', createController);
  app.on('before-quit', event => {
    if (quitting) return;
    if (closing) { event.preventDefault(); return; }
    closing = true;
    clearChatNotifications();
    resetWeChat();
    wechatObservers.cancel();
    event.preventDefault(); draining = true; status = '正在安全结束本地操作…'; publish();
    void serialize(async () => { await modelLogin.close(); await wechatObservers.stop(); await stopWorker(); quitAfterDrain(); }).catch(error => { status = `退出尚未完成：${(error as Error).message}`; publish(); });
  });
  launchWorker(); openChat();
}
app.on('window-all-closed', () => { /* Tray owns the desktop process lifecycle. */ });
void bootstrap().catch(error => { dialog.showErrorBox('榫无法启动', (error as Error).message); app.exit(1); });
