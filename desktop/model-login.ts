import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

interface Attempt {
  owner: number; redirectUri: string; server: Server; timer: ReturnType<typeof setTimeout>;
  state?: string; opened: boolean; settled: boolean;
  result: Promise<{ callbackUrl: string }>;
  resolve(value: { callbackUrl: string }): void; reject(error: Error): void;
}
const sameState = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Owns only the loopback code callback. OAuth verifiers and tokens remain in Tenon's backend. */
export class ModelLoginBridge {
  private readonly attempts = new Map<string, Attempt>();
  constructor(private readonly openExternal: (url: string) => Promise<unknown>, private readonly timeoutMs = 10 * 60_000) {}

  async prepare(owner: number): Promise<{ attemptId: string; redirectUri: string }> {
    if (this.attempts.size >= 4) throw new Error('请先完成或取消已有的 ChatGPT 登录。');
    const attemptId = randomUUID();
    let resolve!: Attempt['resolve'], reject!: Attempt['reject'];
    const result = new Promise<{ callbackUrl: string }>((yes, no) => { resolve = yes; reject = no; });
    void result.catch(() => {}); // A listener can expire before the renderer starts waiting.
    const server = createServer((request, response) => {
      const attempt = this.attempts.get(attemptId);
      const expectedHost = attempt && new URL(attempt.redirectUri).host;
      if (!attempt || !attempt.opened || attempt.settled || request.method !== 'GET' || request.headers.host !== expectedHost
        || !request.url || request.url.length > 16_384) { response.writeHead(400).end('Invalid login callback'); return; }
      let callback: URL;
      try { callback = new URL(request.url, attempt.redirectUri); }
      catch { response.writeHead(400).end('Invalid login callback'); return; }
      const state = callback.searchParams.get('state');
      if (callback.origin !== new URL(attempt.redirectUri).origin || callback.pathname !== '/auth/callback'
        || !state || !attempt.state || !sameState(state, attempt.state)
        || callback.searchParams.getAll('state').length !== 1
        || !(callback.searchParams.has('code') || callback.searchParams.has('error'))) {
        response.writeHead(400).end('Invalid login callback'); return;
      }
      attempt.settled = true; clearTimeout(attempt.timer);
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'" });
      response.end('授权结果已交给榫。请返回客户端查看连接状态。');
      attempt.resolve({ callbackUrl: callback.href });
      this.attempts.delete(attemptId);
      server.close(); server.closeIdleConnections();
    });
    server.keepAliveTimeout = 1_000; server.requestTimeout = 10_000;
    await new Promise<void>((yes, no) => {
      const failed = (error: Error) => no(error); server.once('error', failed);
      server.listen(0, '127.0.0.1', () => { server.off('error', failed); yes(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('无法创建本机登录回调。'); }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const timer = setTimeout(() => { void this.cancel(owner, attemptId).catch(() => {}); }, this.timeoutMs); timer.unref();
    this.attempts.set(attemptId, { owner, redirectUri, server, timer, result, resolve, reject, opened: false, settled: false });
    return { attemptId, redirectUri };
  }

  async open(owner: number, input: { attemptId: string; authUrl: string }): Promise<{ callbackUrl: string }> {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt || attempt.owner !== owner || attempt.opened || attempt.settled) throw new Error('本机登录已失效，请重新开始。');
    let url: URL;
    try { url = new URL(input.authUrl); } catch { throw new Error('ChatGPT 登录地址无效。'); }
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.hash
      || url.searchParams.get('redirect_uri') !== attempt.redirectUri || !url.searchParams.get('state')
      || url.searchParams.has('id_token_hint') || input.authUrl.length > 16_384) throw new Error('ChatGPT 登录地址与本次回调不匹配。');
    attempt.state = url.searchParams.get('state')!; attempt.opened = true;
    try { await this.openExternal(url.href); return await attempt.result; }
    catch (error) { await this.cancel(owner, input.attemptId); throw error; }
  }

  async cancel(owner: number, attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId); if (!attempt) return;
    if (attempt.owner !== owner) throw new Error('登录不属于当前窗口。');
    this.attempts.delete(attemptId); clearTimeout(attempt.timer); attempt.settled = true;
    attempt.reject(new Error('ChatGPT 登录已取消或超时。'));
    await new Promise<void>(resolve => { attempt.server.close(() => resolve()); attempt.server.closeAllConnections(); });
  }
  async close(owner?: number): Promise<void> {
    await Promise.all([...this.attempts].filter(([, attempt]) => owner === undefined || attempt.owner === owner)
      .map(([id, attempt]) => this.cancel(attempt.owner, id)));
  }
}
