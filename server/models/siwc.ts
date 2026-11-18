import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import * as oauth from 'oauth4webapi';
import { modelContextWindowSchema, type ModelCatalogEntry, type ModelConnection, type SiwcLoginStart, type SiwcLoginStatus } from '../../shared/model-connections.js';
export type { SiwcLoginStart, SiwcLoginStatus } from '../../shared/model-connections.js';
import type { ModelConnections, OAuthCredentials } from './connections.js';
import { recordConnectionDiagnostic } from './diagnostics.js';

export const SIWC_ISSUER = 'https://auth.openai.com';
export const SIWC_RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const randomValue = () => randomBytes(32).toString('base64url');
const terminalRefreshErrors = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export class SiwcError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number, readonly requestId?: string) {
    super(message); this.name = 'SiwcError';
  }
}
interface LoginAttempt {
  view: SiwcLoginStatus; state: string; nonce: string; verifier: string; redirectUri: string;
  expected: { expectedCredentialVersion: number; expectedIdentityRevision: number; expectedEditRevision: number };
  previous?: OAuthCredentials; clientId?: string; controller: AbortController; server?: Server;
  timeout?: ReturnType<typeof setTimeout>; completion?: Promise<SiwcLoginStatus>;
}
export interface SiwcOptions { fetch?: typeof fetch; now?: () => number; loginTimeoutMs?: number; requestTimeoutMs?: number }

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateSiwcRedirect(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new SiwcError('invalid_callback', '登录回调地址无效。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1 || Number(url.port) > 65535 ||
    url.pathname !== '/auth/callback' || url.search || url.hash || url.username || url.password) {
    throw new SiwcError('invalid_callback', '登录回调必须由本机 127.0.0.1 监听器接收。');
  }
  return url.href;
}
function errorFromResponse(value: unknown, response: Response): SiwcError {
  const data = object(value) ? value : {};
  const nested = object(data.error) ? data.error : {};
  const raw = typeof data.error === 'string' ? data.error : nested.code;
  const code = typeof raw === 'string' && /^[a-zA-Z0-9_.-]{1,150}$/.test(raw) ? raw : `http_${response.status}`;
  const message = code === 'subscription_sharing_usage_limit_exceeded' ? 'ChatGPT 连接已达到用量限制，请在 ChatGPT 设置中管理用量。'
    : code === 'subscription_sharing_user_not_eligible' ? '当前 ChatGPT 账号或工作区不支持此应用使用套餐。'
    : terminalRefreshErrors.has(code) ? 'ChatGPT 会话已失效，请重新登录。'
    : response.status === 403 ? 'ChatGPT 拒绝了此请求的权限或服务区域，请检查连接资格。'
    : response.status === 503 ? 'ChatGPT 服务暂时不可用，请稍后重试。'
    : 'ChatGPT 请求失败，请检查连接或稍后重试。';
  return new SiwcError(code, message, response.status, response.headers.get('x-request-id') ?? undefined);
}

/** Owns SIWC registration and rotating sessions. It never reads Codex credentials. */
export class SiwcAuthService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly loginTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly attempts = new Map<string, LoginAttempt>();
  private readonly refreshes = new Map<string, Promise<OAuthCredentials>>();
  private readonly logouts = new Map<string, Promise<{ remoteRevoked: boolean; message?: string }>>();
  private readonly starts = new Set<Promise<SiwcLoginStart>>();
  private discoveryPromise?: Promise<oauth.AuthorizationServer>;
  private closed = false;

  constructor(private readonly connections: ModelConnections, options: SiwcOptions = {}) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now;
    this.loginTimeoutMs = options.loginTimeoutMs ?? 10 * 60_000; this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }
  private assertOpen(): void { if (this.closed) throw new SiwcError('closed', '模型连接服务正在关闭。'); }
  private connection(id: string): ModelConnection {
    const item = this.connections.get(id);
    if (!item || item.kind !== 'siwc') throw new SiwcError('connection_missing', '找不到 ChatGPT 连接。');
    return item;
  }
  private credential(id: string): OAuthCredentials | undefined {
    const value = this.connections.getCredential(id); return value?.kind === 'siwc' ? value : undefined;
  }
  private async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return this.fetcher(url, { ...init, signal, redirect: 'error' });
  }
  private async json(response: Response): Promise<unknown> {
    if (!response.body) throw new SiwcError('invalid_response', 'ChatGPT 返回了空响应。');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length;
        if (length > 1024 * 1024) throw new SiwcError('invalid_response', 'ChatGPT 响应超过连接协议限制。');
        chunks.push(next.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new SiwcError('invalid_response', 'ChatGPT 返回了无效响应。'); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private oauthOptions(signal?: AbortSignal): oauth.HttpRequestOptions<'POST', URLSearchParams> {
    return { [oauth.customFetch]: (url, options) => this.request(url, options), ...(signal ? { signal } : {}) };
  }
  private client(clientId: string, receivedAt = this.now()): oauth.Client {
    return { client_id: clientId, id_token_signed_response_alg: 'RS256', [oauth.clockTolerance]: 5,
      [oauth.clockSkew]: Math.floor(receivedAt / 1000) - Math.floor(Date.now() / 1000) };
  }
  private discovery(): Promise<oauth.AuthorizationServer> {
    this.discoveryPromise ??= (async () => {
      const response = await oauth.discoveryRequest(new URL(SIWC_ISSUER), { [oauth.customFetch]: (url, options) => this.request(url, options) });
      const value = await oauth.processDiscoveryResponse(new URL(SIWC_ISSUER), response);
      // SIWC credentials must never be redirected to a metadata-supplied third-party origin.
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
        if (key === 'revocation_endpoint' && value[key] === undefined) continue;
        const endpoint = value[key];
        if (typeof endpoint !== 'string') throw new SiwcError('discovery_failed', 'ChatGPT 登录配置不完整。');
        const parsed = new URL(endpoint);
        if (parsed.origin !== SIWC_ISSUER || parsed.username || parsed.password || parsed.hash) throw new SiwcError('discovery_failed', 'ChatGPT 登录配置来源无效。');
      }
      return value;
    })().catch(error => { this.discoveryPromise = undefined; throw error; });
    return this.discoveryPromise;
  }
  private async identity(response: Response, processed: oauth.TokenEndpointResponse): Promise<{ issuer: string; subject: string; email?: string }> {
    const discovery = await this.discovery();
    await oauth.validateApplicationLevelSignature(discovery, response, { [oauth.customFetch]: (url, options) => this.request(url, options) });
    const claims = oauth.getValidatedIdTokenClaims(processed);
    if (!claims) throw new SiwcError('invalid_id_token', 'ChatGPT 未返回可核对的账号身份。');
    return { issuer: claims.iss, subject: claims.sub, ...(typeof claims.email === 'string' ? { email: claims.email } : {}) };
  }
  private tokenFields(value: Record<string, unknown>, fallbackScope?: string): Pick<OAuthCredentials, 'accessToken' | 'refreshToken' | 'scope' | 'expiresAt'> {
    const scope = value.scope ?? fallbackScope;
    if (typeof value.access_token !== 'string' || !value.access_token || typeof value.refresh_token !== 'string' || !value.refresh_token ||
      typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
      !Number.isSafeInteger(this.now() + value.expires_in * 1000) || typeof scope !== 'string' ||
      typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') {
      throw new SiwcError('invalid_token_response', 'ChatGPT 未返回完整的可续期凭据。');
    }
    return { accessToken: value.access_token, refreshToken: value.refresh_token, scope, expiresAt: this.now() + value.expires_in * 1000 };
  }

  start(input: { connectionId?: string; name?: string; redirectUri?: string; reconsent?: boolean } = {}): Promise<SiwcLoginStart> {
    const pending = this.startLogin(input).finally(() => this.starts.delete(pending)); this.starts.add(pending); return pending;
  }
  private async startLogin(input: { connectionId?: string; name?: string; redirectUri?: string; reconsent?: boolean }): Promise<SiwcLoginStart> {
    this.assertOpen();
    const connection = input.connectionId ? this.connection(input.connectionId)
      : this.connections.upsert({ name: input.name?.trim() || 'ChatGPT', kind: 'siwc', protocol: 'siwc-responses' });
    if (this.logouts.has(connection.id)) throw new SiwcError('logout_pending', '此连接正在退出，请稍后重试。');
    if ([...this.attempts.values()].some(item => item.view.connectionId === connection.id && item.view.status === 'pending')) {
      throw new SiwcError('login_pending', '此连接已有登录正在进行。');
    }
    const discovery = await this.discovery(); this.assertOpen();
    if (this.logouts.has(connection.id) || [...this.attempts.values()].some(item => item.view.connectionId === connection.id && item.view.status === 'pending')) {
      throw new SiwcError('login_pending', '此连接已有登录或退出正在进行。');
    }
    const id = randomValue(); const controller = new AbortController();
    const previous = this.credential(connection.id); const registration = this.connections.getOAuthRegistration(connection.id);
    const attempt: LoginAttempt = { view: { loginId: id, connectionId: connection.id, status: 'pending', expiresAt: this.now() + this.loginTimeoutMs },
      state: oauth.generateRandomState(), nonce: oauth.generateRandomNonce(), verifier: oauth.generateRandomCodeVerifier(), redirectUri: input.redirectUri ? validateSiwcRedirect(input.redirectUri) : '',
      expected: { expectedCredentialVersion: connection.credentialVersion, expectedIdentityRevision: connection.identityRevision, expectedEditRevision: connection.editRevision },
      previous, clientId: registration?.clientId ?? previous?.clientId, controller };
    // Reserve the registration before awaiting the local listener, so concurrent starts cannot race.
    this.attempts.set(id, attempt);
    if (!input.redirectUri) {
      const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        if (request.method !== 'GET' || request.headers.host !== new URL(attempt.redirectUri).host) { response.writeHead(404).end(); return; }
        const callback = new URL(request.url ?? '/', attempt.redirectUri);
        if (callback.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
        void this.complete(id, callback.href).then(() => response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录处理完成，请返回 榫 Tenon。'),
          () => response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调未通过核对，请返回 榫 Tenon 重试。'));
      });
      server.requestTimeout = 15_000; server.headersTimeout = 10_000;
      try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); }
      catch { this.attempts.delete(id); server.close(); throw new SiwcError('callback_failed', '无法启动本机登录回调。'); }
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); this.attempts.delete(id); throw new SiwcError('callback_failed', '无法启动本机登录回调。'); }
      attempt.server = server; attempt.redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    }
    if (this.closed) { attempt.server?.close(); this.attempts.delete(id); this.assertOpen(); }
    attempt.timeout = setTimeout(() => { void this.cancel(id, '登录已超时，请重新开始。'); }, this.loginTimeoutMs); attempt.timeout.unref();
    const url = new URL(discovery.authorization_endpoint!);
    url.search = new URLSearchParams({ client_id: attempt.clientId ?? 'dynamic_agent_client', response_type: 'code', redirect_uri: attempt.redirectUri,
      scope: SCOPES, resource: SIWC_RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
      code_challenge: await oauth.calculatePKCECodeChallenge(attempt.verifier), ext_agent_host_id: this.connections.getOrCreateHostId(),
      ...(!attempt.clientId ? { agent_name_hint: 'Tenon' } : {}), ...(input.reconsent ? { prompt: 'consent' } : {}) }).toString();
    // Deliberately omit id_token_hint: the browser/renderer never receives tokens.
    return { ...attempt.view, authUrl: url.href, redirectUri: attempt.redirectUri };
  }
  status(loginId: string): SiwcLoginStatus {
    const attempt = this.attempts.get(loginId); if (!attempt) throw new SiwcError('login_missing', '登录请求不存在或服务已经重启。');
    return { ...attempt.view };
  }
  private finish(attempt: LoginAttempt): void {
    if (attempt.timeout) clearTimeout(attempt.timeout);
    // close() lets the accepted callback response drain, without cutting it off.
    attempt.server?.close();
    attempt.state = ''; attempt.nonce = ''; attempt.verifier = '';
    attempt.previous = undefined;
    // Keep only short-lived status receipts; do not accumulate authentication transactions.
    const timer = setTimeout(() => this.attempts.delete(attempt.view.loginId), 15 * 60_000); timer.unref();
  }
  async complete(loginId: string, callbackUrl: string): Promise<SiwcLoginStatus> {
    this.assertOpen(); const attempt = this.attempts.get(loginId);
    if (!attempt) throw new SiwcError('login_missing', '登录请求不存在或已过期。');
    if (attempt.view.status !== 'pending') return { ...attempt.view };
    if (attempt.completion) return attempt.completion;
    if (callbackUrl.length > 32768) throw new SiwcError('invalid_callback', '登录回调超出协议限制。');
    const callback = new URL(callbackUrl); const expected = new URL(attempt.redirectUri);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash) {
      throw new SiwcError('invalid_state', '登录回调与当前请求不匹配。');
    }
    const discovery = await this.discovery();
    if (attempt.view.status !== 'pending') return { ...attempt.view };
    if (attempt.completion) return attempt.completion;
    let parameters: URLSearchParams;
    try { parameters = oauth.validateAuthResponse(discovery, this.client(attempt.clientId ?? 'dynamic_agent_client'), callback, attempt.state); }
    catch (error) {
      if (error instanceof oauth.AuthorizationResponseError) {
        attempt.view.status = 'failed'; attempt.view.message = 'ChatGPT 登录未获同意。'; this.finish(attempt); return { ...attempt.view };
      }
      throw new SiwcError('invalid_state', '登录回调与当前请求不匹配。');
    }
    attempt.completion = (async () => {
      let uncommitted: Pick<OAuthCredentials, 'clientId' | 'refreshToken'> | undefined;
      try {
        if (this.now() >= attempt.view.expiresAt) throw new SiwcError('login_expired', '登录已超时，请重新开始。');
        if (callback.searchParams.has('error')) throw new SiwcError('access_denied', 'ChatGPT 登录未获同意。');
        const code = callback.searchParams.get('code'); const returnedClient = callback.searchParams.get('client_id');
        const clientId = returnedClient ?? attempt.clientId;
        if (!code || callback.searchParams.getAll('code').length !== 1 || callback.searchParams.getAll('client_id').length > 1 ||
          !clientId || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId) || clientId === 'dynamic_agent_client' ||
          attempt.clientId && returnedClient !== null && returnedClient !== attempt.clientId) {
          throw new SiwcError('registration_incomplete', 'ChatGPT 注册回调无效，请重新登录。');
        }
        attempt.controller.signal.throwIfAborted();
        const registration = this.connections.setOAuthRegistration(attempt.view.connectionId, { issuer: SIWC_ISSUER, clientId }, attempt.expected);
        attempt.expected.expectedEditRevision = registration.editRevision;
        const client = this.client(clientId);
        const response = await oauth.authorizationCodeGrantRequest(discovery, client, oauth.None(), parameters, attempt.redirectUri,
          attempt.verifier, { ...this.oauthOptions(attempt.controller.signal), additionalParameters: { resource: SIWC_RESOURCE } });
        const data = await oauth.processAuthorizationCodeResponse(discovery, client, response, { expectedNonce: attempt.nonce, requireIdToken: true });
        if (data.refresh_token) uncommitted = { clientId, refreshToken: data.refresh_token };
        const identity = await this.identity(response, data);
        if (attempt.previous && (identity.subject !== attempt.previous.subject || identity.issuer !== attempt.previous.issuer)) {
          throw new SiwcError('account_mismatch', '此次登录账号与保存的连接不同，请新增独立连接。');
        }
        attempt.controller.signal.throwIfAborted(); this.assertOpen();
        if (typeof data.scope !== 'string') throw new SiwcError('invalid_token_response', 'ChatGPT 未确认授予的权限。');
        const planAllowed = data.scope.split(/\s+/).includes(PLAN_SCOPE);
        if (!planAllowed) {
          this.connections.setOAuthIdentity(attempt.view.connectionId, { issuer: identity.issuer, subject: identity.subject, clientId,
            ...(identity.email ? { label: identity.email } : {}) }, attempt.expected);
        } else {
          const credentials: OAuthCredentials = { kind: 'siwc', ...this.tokenFields(data), clientId, issuer: identity.issuer, subject: identity.subject, idToken: data.id_token };
          this.connections.setOAuthCredentials(attempt.view.connectionId, credentials, attempt.expected);
          uncommitted = undefined;
        }
        if (uncommitted) { await this.revoke(uncommitted); uncommitted = undefined; }
        attempt.controller.signal.throwIfAborted();
        attempt.view.status = 'completed';
        attempt.view.message = planAllowed ? 'ChatGPT 已连接。' : '已登录，但尚未授权使用 ChatGPT 套餐。';
      } catch (error) {
        // A cancelled/failed login must not leave a newly issued renewable session active after drain.
        if (uncommitted) await this.revoke(uncommitted);
        if (attempt.view.status !== 'cancelled') { attempt.view.status = 'failed'; attempt.view.message = error instanceof SiwcError ? error.message : '登录核对失败，请重试。'; }
      } finally { this.finish(attempt); }
      return { ...attempt.view };
    })();
    return attempt.completion;
  }
  async cancel(loginId: string, message = '已取消登录。'): Promise<void> {
    const attempt = this.attempts.get(loginId); if (!attempt || attempt.view.status !== 'pending') return;
    attempt.view.status = 'cancelled'; attempt.view.message = message; attempt.controller.abort(new SiwcError('cancelled', message));
    if (attempt.completion) await attempt.completion; else this.finish(attempt);
  }

  private async refresh(id: string): Promise<OAuthCredentials> {
    const initial = this.connection(id); const old = this.credential(id);
    if (!old?.refreshToken) throw new SiwcError('invalid_grant', 'ChatGPT 会话已过期，请重新登录。');
    let expected = { expectedCredentialVersion: initial.credentialVersion, expectedIdentityRevision: initial.identityRevision };
    let checkpoint = old.pendingRefresh;
    try {
      const discovery = await this.discovery();
      let response: Response; let processed: oauth.TokenEndpointResponse;
      if (!checkpoint) {
        response = await oauth.refreshTokenGrantRequest(discovery, this.client(old.clientId), oauth.None(), old.refreshToken,
          { ...this.oauthOptions(), additionalParameters: { resource: SIWC_RESOURCE } });
        const value = await oauth.processRefreshTokenResponse(discovery, this.client(old.clientId), response); processed = value;
        const fields = this.tokenFields(value, old.scope);
        if (value.id_token !== undefined && typeof value.id_token !== 'string') throw new SiwcError('invalid_id_token', '刷新返回的账号身份无效。');
        if (typeof value.id_token === 'string') {
          checkpoint = { ...fields, refreshToken: fields.refreshToken!, idToken: value.id_token, receivedAt: this.now() };
          const saved = this.connections.setOAuthCredentials(id, { ...old, pendingRefresh: checkpoint }, expected);
          expected = { expectedCredentialVersion: saved.credentialVersion, expectedIdentityRevision: saved.identityRevision };
        } else {
          const updated = { ...old, ...fields }; delete updated.pendingRefresh;
          this.connections.setOAuthCredentials(id, updated, expected); return updated;
        }
      } else {
        // Resume SDK validation of the encrypted rotation receipt, not a second refresh of the consumed token.
        response = Response.json({ access_token: checkpoint.accessToken, refresh_token: checkpoint.refreshToken, id_token: checkpoint.idToken,
          token_type: 'Bearer', expires_in: Math.max(1, (checkpoint.expiresAt - checkpoint.receivedAt) / 1000), scope: checkpoint.scope });
        processed = await oauth.processRefreshTokenResponse(discovery, this.client(old.clientId, checkpoint.receivedAt), response);
      }
      if (!checkpoint.idToken) throw new SiwcError('invalid_id_token', '刷新凭据缺少待核对的身份。');
      const identity = await this.identity(response, processed);
      if (identity.subject !== old.subject || identity.issuer !== old.issuer) throw new SiwcError('account_mismatch', '刷新返回的账号与已连接账号不同。');
      const updated: OAuthCredentials = { ...old, accessToken: checkpoint.accessToken, refreshToken: checkpoint.refreshToken,
        expiresAt: checkpoint.expiresAt, scope: checkpoint.scope, idToken: checkpoint.idToken };
      delete updated.pendingRefresh;
      this.connections.setOAuthCredentials(id, updated, expected); return updated;
    } catch (error) {
      recordConnectionDiagnostic(this.connections, id, error, { expectedIdentityRevision: initial.identityRevision, expectedBindingRevision: initial.bindingRevision });
      const code = error instanceof oauth.ResponseBodyError ? error.error : error instanceof SiwcError ? error.code : undefined;
      if (code && terminalRefreshErrors.has(code)) {
        this.connections.clearCredential(id, expected);
      }
      if (error instanceof oauth.ResponseBodyError) throw errorFromResponse(error.cause, error.response);
      if (error instanceof SiwcError) throw error;
      // SDK validation errors can contain the parsed token response in cause; never propagate that secret-bearing object.
      throw new SiwcError('refresh_validation_failed', '暂时无法核对 ChatGPT 刷新结果，已保留连接，请稍后重试。');
    }
  }
  async accessToken(connectionId: string, signal?: AbortSignal, expectedIdentityRevision?: number): Promise<string> {
    this.assertOpen(); signal?.throwIfAborted();
    if (this.logouts.has(connectionId)) throw new SiwcError('logout_pending', 'ChatGPT 连接正在退出。');
    const initial = this.connection(connectionId);
    if (!initial.enabled || expectedIdentityRevision !== undefined && initial.identityRevision !== expectedIdentityRevision) throw new SiwcError('binding_changed', '模型连接已变更，请重新提交。');
    if (initial.status === 'scope-required') throw new SiwcError('plan_permission_missing', '当前连接尚未授权使用 ChatGPT 套餐。');
    if (initial.status !== 'ready') throw new SiwcError('login_required', '请先重新连接 ChatGPT。');
    let credentials = this.credential(connectionId);
    if (!credentials) throw new SiwcError('login_required', '请先连接 ChatGPT。');
    if (credentials.pendingRefresh || credentials.expiresAt <= this.now() + 60_000) {
      let refreshing = this.refreshes.get(connectionId);
      if (!refreshing) { refreshing = this.refresh(connectionId).finally(() => this.refreshes.delete(connectionId)); this.refreshes.set(connectionId, refreshing); }
      // A rotating refresh is a shared accepted mutation: drain it before honoring cancellation.
      credentials = await refreshing;
    }
    signal?.throwIfAborted(); this.assertOpen();
    const current = this.connection(connectionId);
    if (this.logouts.has(connectionId) || !current.enabled || current.identityRevision !== initial.identityRevision) throw new SiwcError('binding_changed', '模型连接已变更，请重新提交。');
    if (!credentials.scope.split(/\s+/).includes(PLAN_SCOPE)) throw new SiwcError('plan_permission_missing', '当前连接尚未授权使用 ChatGPT 套餐。');
    return credentials.accessToken;
  }
  private async revoke(credentials: Pick<OAuthCredentials, 'clientId' | 'refreshToken' | 'pendingRefresh'>): Promise<boolean> {
    const token = credentials.pendingRefresh?.refreshToken ?? credentials.refreshToken;
    if (!token) return false;
    try {
      const discovery = await this.discovery(); if (!discovery.revocation_endpoint) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await oauth.revocationRequest(discovery, this.client(credentials.clientId), oauth.None(), token,
            { ...this.oauthOptions(), additionalParameters: { token_type_hint: 'refresh_token' } });
          if (response.status === 200) { await oauth.processRevocationResponse(response); return true; }
          await response.body?.cancel(); if (response.status < 500) return false;
        } catch { if (attempt > 0) return false; }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch { /* The caller reports unconfirmed remote revocation without retaining local credentials. */ }
    return false;
  }
  logout(connectionId: string): Promise<{ remoteRevoked: boolean; message?: string }> {
    const existing = this.logouts.get(connectionId); if (existing) return existing;
    const work = (async () => {
      for (const attempt of this.attempts.values()) if (attempt.view.connectionId === connectionId) await this.cancel(attempt.view.loginId);
      await this.refreshes.get(connectionId)?.catch(() => undefined);
      const connection = this.connection(connectionId); const credentials = this.credential(connectionId);
      this.connections.clearCredential(connectionId, { expectedCredentialVersion: connection.credentialVersion, expectedIdentityRevision: connection.identityRevision });
      const remoteRevoked = !credentials || await this.revoke(credentials);
      return { remoteRevoked, ...(!remoteRevoked ? { message: '已清除本地凭据，但未确认远程撤销。可在 ChatGPT 设置中断开应用。' } : {}) };
    })().finally(() => this.logouts.delete(connectionId));
    this.logouts.set(connectionId, work); return work;
  }
  async listModels(connectionId: string, signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    const connection = this.connection(connectionId);
    try {
      const token = await this.accessToken(connectionId, signal, connection.identityRevision);
      const response = await this.request(`${SIWC_RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal });
      const value = await this.json(response);
      if (!response.ok) throw errorFromResponse(value, response);
      if (!object(value) || !Array.isArray(value.models)) throw new SiwcError('invalid_catalog', 'ChatGPT 返回的模型目录无效。');
      const models: ModelCatalogEntry[] = value.models.filter(object).filter(item => item.visibility === 'list' && typeof item.slug === 'string' && typeof item.display_name === 'string')
        .map(item => {
          const reasoning = Array.isArray(item.supported_reasoning_levels)
            ? [...new Set(item.supported_reasoning_levels.filter(object).map(level => level.effort)
              .filter((effort): effort is string => typeof effort === 'string' && effort.length > 0 && effort.length <= 80))].slice(0, 30) : undefined;
          const inputModalities = Array.isArray(item.input_modalities)
            ? [...new Set(item.input_modalities.filter((modality): modality is string =>
              typeof modality === 'string' && modality.length > 0 && modality.length <= 50))].slice(0, 20) : undefined;
          const window = modelContextWindowSchema.safeParse(item.context_window);
          return { id: String(item.slug), name: String(item.display_name), source: 'provider', updatedAt: new Date(this.now()).toISOString(),
            ...(reasoning === undefined ? {} : { reasoning }), ...(inputModalities === undefined ? {} : { inputModalities }),
            ...(window.success ? { contextWindow: window.data } : {}) };
        });
      signal?.throwIfAborted();
      this.connections.setCatalog(connectionId, models, { expectedIdentityRevision: connection.identityRevision,
        expectedBindingRevision: connection.bindingRevision }); return models;
    } catch (error) {
      if (!signal?.aborted) recordConnectionDiagnostic(this.connections, connectionId, error,
        { expectedIdentityRevision: connection.identityRevision, expectedBindingRevision: connection.bindingRevision });
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.starts]);
    await Promise.all([...this.attempts.values()].map(attempt => this.cancel(attempt.view.loginId)));
    await Promise.allSettled([...this.refreshes.values(), ...this.logouts.values()]);
  }
}
