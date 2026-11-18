import { useEffect, useState, useSyncExternalStore } from 'react';
import { SUPPORTED_RUNTIME_SCHEMA_VERSIONS, type RuntimeView, type RuntimeViewScope } from '../../shared/runtime-view';
import { api, ApiError, onSessionExpired, connectRuntime, runtimeViewUrl, type Perform, type RuntimeConnectionHealth, type RuntimeConnector } from '../api';

interface RuntimeState {
  runtime: RuntimeView | null;
  connectionError: string;
  error: string;
  notice: string;
  busy: string[];
  connection: RuntimeConnectionHealth;
}
type LiveScope = Pick<RuntimeViewScope, 'caseId'>;
type RuntimeReader = (signal: AbortSignal, scope?: LiveScope) => Promise<RuntimeView>;
const readRuntime: RuntimeReader = (signal, scope) => api<RuntimeView>(runtimeViewUrl('/api/state', scope), 'GET', undefined, signal);
const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

function validateRuntime(value: RuntimeView, scope?: LiveScope): void {
  if (value?.runtime !== 'mastra' || !SUPPORTED_RUNTIME_SCHEMA_VERSIONS.includes(value.schemaVersion) || !value.status?.todayUsage ||
    !value.conversation || value.conversation.caseId !== (scope?.caseId ?? null) || value.conversation.before !== null ||
    !value.casePreviews || typeof value.casePreviews !== 'object' ||
    !Array.isArray(value.messages) || !Array.isArray(value.cases) || !Array.isArray(value.tasks) ||
    !Array.isArray(value.understanding) || !Array.isArray(value.sources) || !Array.isArray(value.runs) ||
    !Array.isArray(value.artifacts) || !Array.isArray(value.workspaceSources) || !Array.isArray(value.grants)) {
    throw new Error('当前页面与后端数据版本不兼容，请刷新页面更新客户端后重试。');
  }
}

/** The sole server-snapshot owner. Exported so request races can be tested without a DOM/runtime. */
export function createRuntimeController(read: RuntimeReader = readRuntime, connect: RuntimeConnector = connectRuntime) {
  let state: RuntimeState = { runtime: null, connectionError: '', error: '', notice: '', busy: [], connection: { state: 'connecting' } };
  let active = false;
  let scope: LiveScope | undefined;
  let generation = 0;
  let requestVersion = 0;
  let streamVersion = 0;
  let readController: AbortController | undefined;
  let disconnect: (() => void) | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeSession: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const pending = new Set<string>();
  const current = (owner: number) => active && generation === owner;
  const update = (values: Partial<RuntimeState>) => {
    state = { ...state, ...values };
    for (const listener of listeners) listener();
  };
  const dismissNotice = () => { clearTimeout(noticeTimer); if (active) update({ notice: '' }); };
  const notify = (text: string) => {
    clearTimeout(noticeTimer); update({ notice: text });
    noticeTimer = setTimeout(dismissNotice, 4000);
  };
  const refresh = async (): Promise<boolean> => {
    if (!active) return false;
    const owner = generation; const version = ++requestVersion;
    readController?.abort();
    const controller = new AbortController(); readController = controller;
    try {
      const next = await read(controller.signal, scope);
      if (!current(owner) || controller.signal.aborted || version !== requestVersion) return false;
      validateRuntime(next, scope);
      update({ runtime: next, connectionError: '' }); return true;
    } catch (cause) {
      if (current(owner) && !controller.signal.aborted && version === requestVersion) {
        if (cause instanceof ApiError && cause.status === 401) stop();
        else update({ connectionError: message(cause, '暂时无法连接服务。') });
      }
      return false;
    } finally { if (readController === controller) readController = undefined; }
  };
  const stop = () => {
    if (!active) return;
    active = false; generation++; requestVersion++; streamVersion++;
    disconnect?.(); disconnect = undefined;
    clearTimeout(noticeTimer); readController?.abort(); readController = undefined;
    unsubscribeSession?.(); unsubscribeSession = undefined;
    update({ runtime: null, connectionError: '', error: '', notice: '', busy: [], connection: { state: 'connecting' } });
  };
  const connectStream = (owner: number) => {
    const streamOwner = ++streamVersion;
    disconnect?.(); disconnect = undefined;
    const ownsStream = () => current(owner) && streamVersion === streamOwner;
    update({ connection: { state: 'connecting' } });
    const closeStream = connect(next => {
      if (!ownsStream()) return;
      try {
        validateRuntime(next, scope);
        // A live snapshot supersedes any older HTTP read still in flight.
        requestVersion++; readController?.abort(); readController = undefined;
        update({ runtime: next, connectionError: '', connection: { state: 'connected', lastHeartbeatAt: Date.now() } });
      } catch (cause) { update({ connectionError: message(cause, '实时数据无法读取。') }); }
    }, cause => {
      if (ownsStream()) update({ connectionError: message(cause, '实时连接中断，正在重连…'), connection: { ...state.connection, state: 'reconnecting' } });
    }, scope, connection => { if (ownsStream()) update({ connection }); });
    if (ownsStream()) disconnect = closeStream; else closeStream();
  };
  const reconnect = () => { if (active) connectStream(generation); };
  const setScope = ({ caseId }: LiveScope) => {
    if (scope?.caseId === caseId) return;
    scope = { caseId };
    if (!active) return;
    reconnect();
    void refresh();
  };
  const start = () => {
    if (active) return () => {};
    active = true; const owner = ++generation;
    unsubscribeSession = onSessionExpired(stop);
    update({ busy: [...pending], notice: '' });
    connectStream(owner);
    void refresh();
    return () => { if (current(owner)) stop(); };
  };
  const perform: Perform = async (key, work, success, options) => {
    if (!active || pending.has(key)) return false;
    const owner = generation;
    pending.add(key); update({ busy: [...pending], error: '' });
    try {
      await work();
      if (!current(owner)) return false;
      if (options?.refreshInBackground) void refresh();
      else await refresh();
      if (!current(owner)) return false;
      if (success) notify(success);
      // A successful mutation stays successful even if its subsequent read fails.
      // Reporting failure here could encourage replaying an already accepted operation.
      return true;
    } catch (cause) {
      if (current(owner)) {
        if (cause instanceof ApiError && cause.status === 401) stop();
        else update({ error: message(cause, '操作没有完成，请重试。') });
      }
      return false;
    } finally {
      pending.delete(key);
      if (active) update({ busy: [...pending] });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, stop, refresh, reconnect, perform, setScope,
    dismissError: () => { if (active) update({ error: '' }); },
    dismissNotice,
  };
}

export function useRuntime({ caseId }: LiveScope = {}) {
  const [controller] = useState(() => createRuntimeController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => controller.setScope({ caseId }), [controller, caseId]);
  useEffect(() => controller.start(), [controller]);
  return { ...state, refresh: controller.refresh, reconnect: controller.reconnect, perform: controller.perform,
    dismissError: controller.dismissError, dismissNotice: controller.dismissNotice };
}
