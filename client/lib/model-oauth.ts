import type { SiwcLoginStart, SiwcLoginStatus } from '../../shared/model-connections';

export interface ModelLoginBridge {
  prepareModelLogin(): Promise<{ attemptId: string; redirectUri: string }>;
  openModelLogin(input: { attemptId: string; authUrl: string }): Promise<{ callbackUrl: string }>;
  cancelModelLogin(input: { attemptId: string }): Promise<void>;
}
export interface ModelLoginPopup { closed: boolean; location: { href: string }; close(): void }
interface Options {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  bridge?: ModelLoginBridge;
  popup?: ModelLoginPopup;
  name: string;
  connectionId?: string;
  reconsent?: boolean;
  now?: () => number;
  wait?: (signal: AbortSignal) => Promise<void>;
}

export function localModelLoginHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

export function modelLoginBridge(): ModelLoginBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as Window & { raeLocalDevice?: Partial<ModelLoginBridge> }).raeLocalDevice;
  return bridge?.prepareModelLogin && bridge.openModelLogin && bridge.cancelModelLogin ? bridge as ModelLoginBridge : undefined;
}

function interrupted(): Error { return new Error('登录已取消，已有账号和模型选择保持不变。'); }

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(interrupted());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(interrupted());
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The owner session transfers only the one-time callback; tokens stay on the server. */
export function createModelLogin(options: Options): { result: Promise<SiwcLoginStatus>; cancel(): Promise<void> } {
  const controller = new AbortController();
  let loginId: string | undefined;
  let attemptId: string | undefined;
  let finished = false;
  let cleanedLogin: string | undefined;
  let cleanedAttempt: string | undefined;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (signal => abortable(new Promise<void>(resolve => setTimeout(resolve, 1200)), signal));
  async function cleanup() {
    options.popup?.close();
    const actions: Promise<unknown>[] = [];
    if (loginId && cleanedLogin !== loginId) {
      cleanedLogin = loginId;
      actions.push(options.request(`/api/models/oauth/${encodeURIComponent(loginId)}`, 'DELETE'));
    }
    if (options.bridge && attemptId && cleanedAttempt !== attemptId) {
      cleanedAttempt = attemptId;
      actions.push(options.bridge.cancelModelLogin({ attemptId }));
    }
    const outcomes = await Promise.allSettled(actions);
    const failure = outcomes.find((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (failure) throw failure.reason;
  }
  const result = (async () => {
    try {
      const prepared = options.bridge ? await options.bridge.prepareModelLogin() : undefined;
      attemptId = prepared?.attemptId;
      if (controller.signal.aborted) throw interrupted();
      const login = await options.request<SiwcLoginStart>('/api/models/oauth/start', 'POST', {
        name: options.name, ...(options.connectionId ? { connectionId: options.connectionId } : {}),
        ...(options.reconsent ? { reconsent: true } : {}), ...(prepared ? { redirectUri: prepared.redirectUri } : {}),
      });
      loginId = login.loginId;
      if (controller.signal.aborted) throw interrupted();
      const url = new URL(login.authUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password) throw new Error('登录地址不是受支持的 OpenAI 授权地址。');
      if (options.bridge && prepared) {
        const callback = await abortable(options.bridge.openModelLogin({ attemptId: prepared.attemptId, authUrl: login.authUrl }), controller.signal);
        if (controller.signal.aborted) throw interrupted();
        // Once accepted, wait for the server receipt even if cancellation races completion.
        return await options.request<SiwcLoginStatus>(`/api/models/oauth/${encodeURIComponent(login.loginId)}/complete`, 'POST', { callbackUrl: callback.callbackUrl });
      }
      if (!options.popup || options.popup.closed) throw new Error('登录窗口未打开，请允许弹出窗口后重试。');
      options.popup.location.href = login.authUrl;
      while (!controller.signal.aborted && now() < login.expiresAt) {
        const status = await options.request<SiwcLoginStatus>(`/api/models/oauth/${encodeURIComponent(login.loginId)}`);
        if (status.status !== 'pending') return status;
        if (options.popup.closed) throw interrupted();
        await wait(controller.signal);
      }
      throw controller.signal.aborted ? interrupted() : new Error('登录已过期，请重新发起。');
    } catch (error) {
      await cleanup().catch(() => { /* Keep the original actionable failure; a retry can query server state. */ });
      throw error;
    } finally {
      options.popup?.close();
      if (options.bridge && attemptId && cleanedAttempt !== attemptId) {
        cleanedAttempt = attemptId;
        await options.bridge.cancelModelLogin({ attemptId }).catch(() => {});
      }
      finished = true;
    }
  })();
  return {
    result,
    async cancel() {
      if (finished) return;
      controller.abort();
      let failure: unknown;
      try { await cleanup(); } catch (error) { failure = error; }
      await result.catch(() => {});
      try { await cleanup(); } catch (error) { failure ??= error; }
      if (failure) throw new Error('已停止本机登录，但服务端取消未确认。请刷新连接状态后核对。');
    },
  };
}
