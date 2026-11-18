import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError, markSessionBoundary, onSessionExpired } from '../api';

export interface Session { required: boolean; authenticated: boolean; username?: string }
type SessionState = { phase: 'checking' | 'ready' | 'error'; session: Session | null; busy: boolean; error: string; retry: 'check' | 'logout' };
type Transport = typeof api;
const failure = (cause: unknown) => cause instanceof Error ? cause.message : '暂时无法连接，请稍后重试。';

function readSession(value: Session): Session {
  if (!value || typeof value.required !== 'boolean' || typeof value.authenticated !== 'boolean' ||
    value.username !== undefined && typeof value.username !== 'string') throw new Error('登录状态无法读取，请重试。');
  return { required: value.required, authenticated: value.authenticated, ...(value.username ? { username: value.username } : {}) };
}

/** Session ownership stays outside the runtime; signed-out screens never mount its polling hook. */
export function createSessionController(transport: Transport = api) {
  let state: SessionState = { phase: 'checking', session: null, busy: false, error: '', retry: 'check' };
  let active = false; let version = 0; let lifecycle = 0;
  let request: AbortController | undefined; let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const update = (next: Partial<SessionState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  const current = (owner: number) => active && owner === version;
  const begin = () => { request?.abort(); request = new AbortController(); return { owner: ++version, signal: request.signal }; };
  const accept = (value: Session) => {
    const session = readSession(value); markSessionBoundary();
    update({ phase: 'ready', session, busy: false, error: '', retry: 'check' });
  };
  const expire = () => {
    if (!active) return;
    request?.abort(); version++; markSessionBoundary();
    update({ phase: 'ready', session: { required: true, authenticated: false }, busy: false, error: '登录已过期，请重新登录。', retry: 'check' });
  };
  const check = async () => {
    if (!active) return;
    const { owner, signal } = begin();
    update({ phase: 'checking', session: null, busy: false, error: '', retry: 'check' });
    try { const value = await transport<Session>('/api/auth/session', 'GET', undefined, signal); if (current(owner)) accept(value); }
    catch (cause) { if (current(owner)) update({ phase: 'error', error: failure(cause) }); }
  };
  const login = async (username: string, password: string): Promise<boolean> => {
    if (!active || state.busy) return false;
    const { owner, signal } = begin(); update({ busy: true, error: '' });
    try {
      const value = readSession(await transport<Session>('/api/auth/login', 'POST', { username, password }, signal));
      if (!current(owner)) return false;
      if (value.required && !value.authenticated) throw new Error('登录未完成，请重试。');
      accept(value); return true;
    } catch (cause) {
      if (current(owner)) update({ busy: false, error: failure(cause) });
      return false;
    }
  };
  const logout = async () => {
    if (!active || state.busy) return;
    const { owner, signal } = begin(); markSessionBoundary();
    update({ phase: 'checking', session: null, busy: true, error: '', retry: 'logout' });
    try {
      try { await transport('/api/auth/logout', 'POST', {}, signal); }
      catch (cause) { if (!(cause instanceof ApiError && cause.status === 401)) throw cause; }
      if (current(owner)) accept({ required: true, authenticated: false });
    } catch (cause) { if (current(owner)) update({ phase: 'error', busy: false, error: failure(cause), retry: 'logout' }); }
  };
  const stop = () => { active = false; version++; lifecycle++; request?.abort(); unsubscribe?.(); unsubscribe = undefined; };
  const start = () => {
    if (active) return () => {};
    active = true; const owner = ++lifecycle; unsubscribe = onSessionExpired(expire); void check();
    return () => { if (active && lifecycle === owner) stop(); };
  };
  return { getSnapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, stop, check, login, logout, expire };
}

export function useSession() {
  const [controller] = useState(() => createSessionController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => controller.start(), [controller]);
  return { ...state, check: controller.check, login: controller.login, logout: controller.logout };
}
