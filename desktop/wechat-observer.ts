import { setTimeout as delay } from 'node:timers/promises';
import { WeChatDatabaseError, WeChatDatabaseReader, type WeChatChat } from './wechat-database.js';
import { pushWeChatRows, registerWeChatGrant, renewWeChatGrant, stopWeChatGrant, WeChatGrantUnavailable, WeChatLoginRequired, type OwnerFetch, type WeChatGrant, type WeChatTopic } from './wechat-transport.js';
import { DeviceHttpError } from './transport.js';
import { MAX_WECHAT_OBSERVATIONS_PER_DEVICE } from '../shared/wechat-observation.js';
import type { SavedWeChatSettings } from './wechat-settings.js';
import type { WeChatProgress, WeChatProgressStorage } from './wechat-progress.js';

const intervalMs = 12000;
const initialRetryMs = 2000;
const maxRetryMs = 30000;
const initialMessage = '选择微信会话和榫场景后，即可开始在后台观察新消息。';
const watchingMessage = '正在后台观察选定会话的新增文字。';
const reconnectingMessage = '榫暂时无法连接，恢复后将从上次的读取位置继续。';
const retryableRead = (error: unknown) => error instanceof WeChatDatabaseError &&
  ['not-running', 'account-ambiguous', 'database-busy'].includes(error.code);
export interface WeChatObservationView {
  phase: 'idle' | 'starting' | 'watching' | 'reconnecting' | 'stopping' | 'paused';
  title?: string;
  topicTitle?: string;
  message: string;
  receivedRows?: number;
  pendingRows?: number;
  lastReceivedAt?: string;
  coverageStartAt?: string;
  coverageNote?: string;
  recent?: WeChatProgress['recent'];
  grantId?: string;
}
interface Connection { baseUrl: string; token: string; grant: WeChatGrant }
interface PairedConnection { baseUrl: string; token: string; deviceId: string; ownerFetch: OwnerFetch }
interface ActiveObservation extends Connection { abort: AbortController; completion: Promise<void> }
export class WeChatObserver {
  private active?: ActiveObservation;
  private view: WeChatObservationView = { phase: 'idle', message: initialMessage };
  private wait?: AbortController;
  private progress?: WeChatProgress;

  constructor(private readonly reader: WeChatDatabaseReader, private readonly publish: (value: WeChatObservationView) => void,
    private readonly storage?: WeChatProgressStorage) {}

  state(): WeChatObservationView { return this.view; }

  private setView(view: WeChatObservationView): void {
    if (JSON.stringify(this.view) === JSON.stringify(view)) return;
    this.view = view;
    this.publish(view);
  }

  async start(input: {
    chat: WeChatChat; windowId: string; topic: WeChatTopic; deviceId: string;
    baseUrl: string; token: string; ownerFetch: OwnerFetch; signal: AbortSignal;
    historySince?: string; historyUntil?: string; analysisIntervalMinutes?: number; addedAt?: string;
  }): Promise<WeChatObservationView> {
    if (this.active || this.view.phase === 'starting' || this.view.phase === 'reconnecting') throw new Error('当前会话已开始观察。');
    const { chat, windowId, topic, baseUrl, token, signal } = input;
    const display = { title: chat.title, topicTitle: topic.title };
    const binding = JSON.stringify([baseUrl, input.deviceId, chat.accountId, chat.chatId, topic.id]);
    this.setView({ ...display, phase: 'starting', message: '正在核对微信会话和新增消息起点…' });
    try {
      const saved = await this.storage?.load(windowId, binding);
      if (saved) {
        for (;;) {
          try {
            const current = await this.reader.verify(chat, signal);
            if (current.chatTitle) saved.title = current.chatTitle;
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (!retryableRead(error)) throw error;
            this.setView({ ...display, phase: 'reconnecting', message: (error as Error).message + ' 恢复后会自动重试。' });
            await delay(intervalMs, undefined, { signal });
          }
        }
      }
      let initial = saved;
      while (!initial) {
        try {
          initial = { cursor: await this.reader.baseline(chat, signal, input.historySince, input.historyUntil),
            coverageStartAt: input.historySince ?? new Date().toISOString(), receivedRows: 0, recent: [],
            ...(!input.addedAt && this.storage && !input.historySince ? {
              coverageNote: '旧版未保存本机断点，本次从新起点继续。此前空缺可用「补采历史」选择时段核对。' } : {}) };
        } catch (error) {
          signal.throwIfAborted();
          if (!retryableRead(error)) throw error;
          this.setView({ ...display, phase: 'reconnecting', message: (error as Error).message + ' 恢复后会自动重试。' });
          await delay(intervalMs, undefined, { signal });
        }
      }
      display.title = initial.title ?? chat.title;
      await this.storage?.save(windowId, binding, initial);
      this.progress = initial;
      let grant: WeChatGrant;
      for (let retryMs = initialRetryMs; ; retryMs = Math.min(retryMs * 2, maxRetryMs)) {
        signal.throwIfAborted();
        try {
          grant = await registerWeChatGrant(baseUrl, input.ownerFetch, { windowId, deviceId: input.deviceId, caseId: topic.id,
            title: display.title, chatType: chat.chatId.endsWith('@chatroom') ? 'group' : 'private',
            historySince: initial.coverageStartAt, historyUntil: input.historyUntil, analysisIntervalMinutes: input.analysisIntervalMinutes ?? 10 });
          break;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof WeChatGrantUnavailable || error instanceof WeChatLoginRequired) throw error;
          this.setView({ ...display, phase: 'reconnecting', message: '榫暂时无法连接，将自动重试启动观察。' });
          await delay(retryMs, undefined, { signal });
        }
      }
      if (signal.aborted) {
        await stopWeChatGrant(baseUrl, token, grant).catch(() => {});
        throw new Error('启动已取消，请重新选择会话。');
      }
      const abort = new AbortController();
      const completion = this.observe({ baseUrl, token, grant }, input.ownerFetch, chat, binding, abort.signal);
      this.active = { baseUrl, token, grant, abort, completion };
      this.setView({ ...display, ...this.progressView(), grantId: grant.id, phase: 'watching', message: watchingMessage });
      return this.view;
    } catch (error) {
      this.setView(signal.aborted ? { phase: 'idle', message: initialMessage } : {
        ...display, phase: 'paused', message: error instanceof Error ? error.message : '无法恢复微信观察。',
      });
      throw error;
    }
  }

  private progressView() {
    const value = this.progress;
    return value ? { receivedRows: value.receivedRows, lastReceivedAt: value.lastReceivedAt,
      coverageStartAt: value.coverageStartAt, coverageNote: value.coverageNote, pendingRows: value.pending?.rows.length ?? 0, recent: value.recent } : {};
  }

  sync(): void { this.wait?.abort(); }

  private async observe(connection: Connection, ownerFetch: OwnerFetch, chat: WeChatChat, binding: string, signal: AbortSignal): Promise<void> {
    let position = this.progress!.cursor;
    let readIssue: string | undefined;
    let waitMs = intervalMs;
    let retryMs = initialRetryMs;
    let renewalRequired = false;
    let pending: Awaited<ReturnType<WeChatDatabaseReader['read']>> | undefined = this.progress!.pending;
    let reading: Promise<void> | undefined;
    let readError: unknown;
    const readLifetime = new AbortController();
    const observationSignal = AbortSignal.any([signal, readLifetime.signal]);
    const { baseUrl, token, grant } = connection;
    try {
      for (;;) {
        this.wait = new AbortController();
        try { await delay(waitMs, undefined, { signal: AbortSignal.any([observationSignal, this.wait.signal]) }); }
        catch { observationSignal.throwIfAborted(); }
        const batch = pending;
        try {
          if (renewalRequired) {
            await renewWeChatGrant(baseUrl, ownerFetch, grant, observationSignal);
            renewalRequired = false;
          }
          observationSignal.throwIfAborted();
          await pushWeChatRows(baseUrl, token, grant, batch?.rows ?? [], observationSignal);
        } catch (error) {
          observationSignal.throwIfAborted();
          if (error instanceof WeChatGrantUnavailable) throw error;
          if (error instanceof DeviceHttpError) {
            if (error.status === 409) {
              renewalRequired = true;
            } else if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
              throw new WeChatGrantUnavailable();
            }
          }
          this.setView({ ...this.view, phase: 'reconnecting', message: error instanceof WeChatLoginRequired ? error.message : reconnectingMessage });
          waitMs = retryMs;
          retryMs = Math.min(retryMs * 2, maxRetryMs);
          continue;
        }
        observationSignal.throwIfAborted();
        waitMs = intervalMs;
        retryMs = initialRetryMs;
        if (batch) {
          const progress: WeChatProgress = { ...this.progress!, cursor: batch.cursor, pending: undefined,
            receivedRows: this.progress!.receivedRows + batch.rows.length, lastReceivedAt: new Date().toISOString(),
            recent: [...this.progress!.recent, ...batch.rows].slice(-5) };
          await this.storage?.save(grant.windowId, binding, progress);
          this.progress = progress;
          position = batch.cursor;
          pending = undefined;
        }
        this.setView({ ...this.view, ...this.progressView(), phase: readIssue ? 'reconnecting' : 'watching', message: readIssue ?? watchingMessage });
        if (reading || pending) continue;
        // Keep one batch in memory until its receipt. The network loop never waits for the shared reader.
        reading = this.reader.read(chat, position, observationSignal).then(async change => {
          readIssue = undefined;
          const progress = { ...this.progress!, ...(change.chatTitle ? { title: change.chatTitle } : {}),
            ...(change.rows.length ? { pending: { cursor: change.cursor, rows: change.rows } } : { cursor: change.cursor }) };
          await this.storage?.save(grant.windowId, binding, progress);
          this.progress = progress;
          if (change.chatTitle && change.chatTitle !== grant.title) { grant.title = change.chatTitle; renewalRequired = true; }
          if (change.rows.length) pending = change;
          else position = change.cursor;
          this.setView({ ...this.view, ...this.progressView(), title: change.chatTitle ?? this.view.title });
        }).catch(error => {
          if (observationSignal.aborted) return;
          if (retryableRead(error)) { readIssue = (error as Error).message + ' 恢复后会自动重试。'; return; }
          readError = error;
          readLifetime.abort();
        }).finally(() => { reading = undefined; });
      }
    } catch (error) {
      const cause = readError ?? error;
      if (!signal.aborted) this.setView({ ...this.view, phase: 'paused',
        message: cause instanceof Error ? cause.message : '本机微信读取失败，已暂停观察。' });
    } finally {
      readLifetime.abort();
      await reading;
    }
  }

  cancel(): void { this.active?.abort.abort(); }

  async stop(): Promise<WeChatObservationView> {
    const active = this.active;
    if (!active) return this.view;
    this.setView({ ...this.view, phase: 'stopping', message: '正在停止本机观察并关闭采集连接…' });
    active.abort.abort();
    await active.completion;
    this.active = undefined;
    let message = '已停止观察。此前收到的变化仍可在所选场景中回顾。';
    try { await stopWeChatGrant(active.baseUrl, active.token, active.grant); }
    catch { message = '本机观察已停止。榫未确认关闭连接，服务端租约到期后失效。'; }
    this.setView({ ...this.view, ...this.progressView(), phase: 'idle', message });
    return this.view;
  }
}

interface SavedSession {
  observer: WeChatObserver;
  abort: AbortController;
  starting: Promise<void>;
  needsLogin: boolean;
}

export class SavedWeChatObservers {
  private readonly sessions = new Map<string, SavedSession>();

  private readonly lastViews = new Map<string, WeChatObservationView>();
  constructor(private readonly reader: WeChatDatabaseReader, private readonly publish: () => void,
    private readonly storage?: WeChatProgressStorage) {}

  state(settings: SavedWeChatSettings) {
    return {
      autoStart: settings.autoStart, limit: MAX_WECHAT_OBSERVATIONS_PER_DEVICE,
      entries: settings.entries.map(entry => {
        if ('legacyTitle' in entry) return { id: entry.id, title: entry.legacyTitle, topicTitle: entry.topic.title,
          phase: 'paused', message: '旧版窗口选择无法核验为当前账号会话。请移除这条旧设置，再重新选择。' };
        const status = this.sessions.get(entry.id)?.observer.state() ?? this.lastViews.get(entry.id);
        return {
          ...status,
          id: entry.id, title: status?.title ?? entry.chat.title, topicTitle: entry.topic.title,
          paused: Boolean(entry.paused), analysisIntervalMinutes: entry.analysisIntervalMinutes ?? 10,
          phase: entry.paused ? 'paused' : status?.phase ?? 'idle',
          message: status?.message ?? (settings.autoStart ? '正在等待已配对的榫登录会话。' : '已保存，自动观察已关闭。'),
        };
      }),
    };
  }

  restore(settings: SavedWeChatSettings, connection: PairedConnection, afterLogin = false): void {
    if (!settings.autoStart) return;
    for (const entry of settings.entries) {
      if (!('chat' in entry) || entry.paused) continue;
      const previous = this.sessions.get(entry.id);
      if (previous && (!afterLogin || !previous.needsLogin)) continue;
      const observer = new WeChatObserver(this.reader, value => { this.lastViews.set(entry.id, value); this.publish(); }, this.storage);
      const abort = new AbortController();
      const session = { observer, abort, starting: Promise.resolve(), needsLogin: false };
      this.sessions.set(entry.id, session);
      session.starting = observer.start({ ...connection, chat: entry.chat, windowId: entry.id, topic: entry.topic, signal: abort.signal,
        historySince: entry.historySince, historyUntil: entry.historyUntil, analysisIntervalMinutes: entry.analysisIntervalMinutes, addedAt: entry.addedAt })
        .then(() => {}, error => { session.needsLogin = error instanceof WeChatLoginRequired; });
    }
  }

  cancel(): void {
    for (const session of this.sessions.values()) {
      session.abort.abort();
      session.observer.cancel();
    }
  }

  sync(id: string): void { this.sessions.get(id)?.observer.sync(); }
  grantId(id: string): string | undefined { return this.sessions.get(id)?.observer.state().grantId ?? this.lastViews.get(id)?.grantId; }

  async stop(id?: string): Promise<void> {
    const selected = [...this.sessions].filter(([entryId]) => id === undefined || id === entryId);
    await Promise.all(selected.map(async ([entryId, session]) => {
      session.abort.abort();
      session.observer.cancel();
      await session.starting;
      await session.observer.stop();
      if (this.sessions.get(entryId) === session) this.sessions.delete(entryId);
    }));
    if (!this.sessions.size) await this.reader.close();
    this.publish();
  }
}
