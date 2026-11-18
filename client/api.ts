import type { RuntimeView, RuntimeViewDelta, RuntimeViewScope } from '../shared/runtime-view';
import { createSessionProbe } from './lib/session-probe';

export type Perform = (key: string, work: () => Promise<unknown>, success?: string, options?: { refreshInBackground?: boolean }) => Promise<boolean>;

export interface RuntimeConnectionHealth {
  state: 'connecting' | 'connected' | 'reconnecting';
  /** Local receipt time, independent of the server clock or any execution-progress timestamp. */
  lastHeartbeatAt?: number;
}
export type RuntimeConnector = (receive: (snapshot: RuntimeView) => void, fail: (cause: unknown) => void, scope?: RuntimeViewScope,
  onHealth?: (health: RuntimeConnectionHealth) => void) => () => void;

export function runtimeViewUrl(path: string, scope?: RuntimeViewScope, delta = false): string {
  const query = new URLSearchParams();
  if (delta) query.set('delta', '1');
  if (scope?.caseId) query.set('caseId', scope.caseId);
  if (scope?.before) query.set('before', scope.before);
  return query.size ? `${path}?${query}` : path;
}

/** Native reconnects handle network loss; terminal HTTP failures need a fresh EventSource. */
export const connectRuntime: RuntimeConnector = (receive, fail, scope, onHealth) => {
  const requestEpoch = sessionEpoch;
  let closed = false;
  let source: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let health: RuntimeConnectionHealth | undefined;
  const current = () => !closed && requestEpoch === sessionEpoch;
  const report = (state: RuntimeConnectionHealth['state'], receivedAt = health?.lastHeartbeatAt) => {
    if (!current() || health?.state === state && health.lastHeartbeatAt === receivedAt) return;
    health = { state, ...(receivedAt === undefined ? {} : { lastHeartbeatAt: receivedAt }) };
    onHealth?.(health);
  };
  const close = () => {
    closed = true; clearTimeout(reconnectTimer); reconnectTimer = undefined;
    clearTimeout(heartbeatTimer); heartbeatTimer = undefined;
    sessionCheck.close(); source?.close(); source = undefined; streamClosers.delete(close);
  };
  const expire = () => { if (current()) { close(); for (const listener of expiredListeners) listener(); } };
  const sessionCheck = createSessionProbe(signal => api('/api/auth/session', 'GET', undefined, signal), current, expire);
  const retry = () => {
    if (!current() || reconnectTimer) return;
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(reconnectAttempt++, 4));
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; if (current()) open(); }, delay);
  };
  const open = () => {
    if (!current()) return;
    let next: EventSource;
    try { next = new EventSource(runtimeViewUrl('/api/state/stream', scope, true)); }
    catch { report('reconnecting'); fail(new Error('无法建立实时连接，正在重连…')); retry(); return; }
    source = next;
    let snapshot: RuntimeView | undefined;
    let revision = '';
    const ownsSource = () => current() && source === next;
    const watch = () => {
      if (!ownsSource()) return;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        if (!ownsSource()) return;
        report('reconnecting');
        fail(new Error('实时连接暂未收到心跳，正在重新连接…'));
        source = undefined; next.close(); retry();
      }, 45_000);
    };
    const received = () => {
      report('connected', Date.now()); reconnectAttempt = 0; watch();
    };
    const accept = (event: Event, delta: boolean) => {
      if (!ownsSource()) return;
      try {
        const { data, lastEventId } = event as MessageEvent<string>;
        if (delta) {
          const patch = JSON.parse(data) as RuntimeViewDelta;
          if (!snapshot || !lastEventId || patch.base !== revision || !patch.replace || typeof patch.replace !== 'object' || Array.isArray(patch.replace)) {
            throw new Error('实时数据版本不连续。');
          }
          snapshot = { ...snapshot, ...patch.replace };
          for (const key of patch.remove ?? []) {
            if (!['mediaJobs', 'devices', 'projectWorkspaces', 'projectOperations'].includes(key)) throw new Error('实时数据包含无效字段。');
            delete snapshot[key];
          }
        } else snapshot = JSON.parse(data) as RuntimeView;
        revision = lastEventId; receive(snapshot); received();
      } catch {
        clearTimeout(heartbeatTimer); heartbeatTimer = undefined; report('reconnecting');
        fail(new Error('实时数据无法读取，正在重新同步…'));
        source = undefined; next.close(); retry();
      }
    };
    next.addEventListener('state', event => accept(event, false));
    next.addEventListener('state-delta', event => accept(event, true));
    next.addEventListener('heartbeat', event => {
      if (!ownsSource() || next.readyState === 0 || next.readyState === 2) return;
      try {
        const data: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (data && typeof data === 'object' && 'serverTime' in data && typeof data.serverTime === 'string' &&
          data.serverTime.length <= 40 && Number.isFinite(Date.parse(data.serverTime))) received();
      } catch { /* Malformed heartbeat data cannot certify connection health. */ }
    });
    next.addEventListener('open', () => { if (ownsSource()) watch(); });
    next.addEventListener('session-expired', () => { if (ownsSource()) expire(); });
    next.onerror = () => {
      if (!ownsSource()) return;
      clearTimeout(heartbeatTimer); heartbeatTimer = undefined; report('reconnecting');
      snapshot = undefined; revision = '';
      fail(new Error('与服务的实时连接中断，正在重连…'));
      sessionCheck.check();
      // CONNECTING belongs to the browser's retry loop; only CLOSED is terminal.
      if (next.readyState === 2) { source = undefined; next.close(); retry(); }
    };
    watch();
  };
  streamClosers.add(close); report('connecting'); open();
  return close;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

let sessionEpoch = 0;
const expiredListeners = new Set<() => void>();
const streamClosers = new Set<() => void>();
/** A request from an earlier login must not expire its replacement session. */
export function markSessionBoundary(): void { sessionEpoch++; for (const close of [...streamClosers]) close(); }
export function onSessionExpired(listener: () => void): () => void {
  expiredListeners.add(listener); return () => { expiredListeners.delete(listener); };
}

/** JSON, multipart and binary requests share one session and HTTP-error boundary. */
export async function apiResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const requestEpoch = sessionEpoch;
  const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : null;
    if (response.status === 401 && !path.startsWith('/api/auth/') && requestEpoch === sessionEpoch) {
      for (const listener of expiredListeners) listener();
    }
    throw new ApiError(response.status, message || `请求没有完成（${response.status}），请稍后重试。`);
  }
  return response;
}

/** JSON transport only; runtime state and screen transitions belong to their owners. */
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await apiResponse(path, {
    method, signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (data === null) throw new Error('服务返回的数据无法读取，请刷新后重试。');
  return data as T;
}

export function stopReply(runId: string): Promise<{ stopped: boolean }> {
  return api(`/api/runs/${encodeURIComponent(runId)}/stop`, 'POST', {});
}
