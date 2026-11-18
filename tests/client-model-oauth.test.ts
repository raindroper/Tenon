import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelLogin, localModelLoginHost, type ModelLoginBridge } from '../client/lib/model-oauth.js';
import type { SiwcLoginStart, SiwcLoginStatus } from '../shared/model-connections.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const start: SiwcLoginStart = { loginId: 'login-one', connectionId: 'siwc-one', status: 'pending', expiresAt: 10000,
  authUrl: 'https://auth.openai.com/api/accounts/authorize?state=one', redirectUri: 'http://127.0.0.1:12345/auth/callback' };
const completed: SiwcLoginStatus = { loginId: start.loginId, connectionId: start.connectionId, status: 'completed', expiresAt: start.expiresAt };

test('desktop login transfers its one-time callback to the owner session without changing defaults', async () => {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  const nativeCalls: string[] = [];
  const callbackUrl = `${start.redirectUri}?code=one-time&state=one&client_id=issued-client`;
  const bridge: ModelLoginBridge = {
    async prepareModelLogin() { nativeCalls.push('prepare'); return { attemptId: 'native-one', redirectUri: start.redirectUri }; },
    async openModelLogin(input) { nativeCalls.push('open'); assert.equal(input.attemptId, 'native-one'); assert.equal(input.authUrl, start.authUrl); return { callbackUrl }; },
    async cancelModelLogin(input) { nativeCalls.push('close'); assert.equal(input.attemptId, 'native-one'); },
  };
  const login = createModelLogin({ name: '我的账号', bridge, connectionId: 'siwc-one', reconsent: true,
    request: async <T>(path: string, method?: string, body?: unknown) => {
      calls.push({ path, method, body });
      if (path.endsWith('/start')) return start as T;
      if (path.endsWith('/complete')) return completed as T;
      throw new Error('unexpected request');
    },
  });
  assert.deepEqual(await login.result, completed);
  assert.deepEqual(nativeCalls, ['prepare', 'open', 'close']);
  assert.deepEqual(calls, [
    { path: '/api/models/oauth/start', method: 'POST', body: { name: '我的账号', connectionId: 'siwc-one', reconsent: true, redirectUri: start.redirectUri } },
    { path: '/api/models/oauth/login-one/complete', method: 'POST', body: { callbackUrl } },
  ]);
  await login.cancel();
  assert.equal(calls.length, 2, 'finished login does not issue cancellation or change any default');
});

test('cancellation drains native listener and prevents a late callback from being submitted', async () => {
  const opened = gate<void>();
  const callback = gate<{ callbackUrl: string }>();
  const calls: string[] = [];
  let nativeCancelled = 0;
  const login = createModelLogin({ name: '账号', bridge: {
    async prepareModelLogin() { return { attemptId: 'native-one', redirectUri: start.redirectUri }; },
    async openModelLogin() { opened.resolve(); return callback.promise; },
    async cancelModelLogin() { nativeCancelled++; },
  }, request: async <T>(path: string, method?: string) => {
    calls.push(`${method ?? 'GET'} ${path}`);
    return (path.endsWith('/start') ? start : { ...completed, status: 'cancelled' }) as T;
  } });
  const rejected = assert.rejects(login.result, /登录已取消/);
  await opened.promise;
  await login.cancel();
  callback.resolve({ callbackUrl: `${start.redirectUri}?code=late` });
  await rejected;
  assert.equal(nativeCancelled, 1);
  assert.deepEqual(calls, ['POST /api/models/oauth/start', 'DELETE /api/models/oauth/login-one']);
});

test('cancelling while the server starts a login still cleans up the returned login ID', async () => {
  const requested = gate<void>();
  const started = gate<SiwcLoginStart>();
  const calls: string[] = [];
  let opens = 0;
  const login = createModelLogin({ name: '账号', bridge: {
    async prepareModelLogin() { return { attemptId: 'native-one', redirectUri: start.redirectUri }; },
    async openModelLogin() { opens++; return { callbackUrl: '' }; },
    async cancelModelLogin() {},
  }, request: async <T>(path: string, method?: string) => {
    calls.push(`${method ?? 'GET'} ${path}`);
    if (path.endsWith('/start')) { requested.resolve(); return await started.promise as T; }
    return { ...completed, status: 'cancelled' } as T;
  } });
  const rejected = assert.rejects(login.result, /登录已取消/);
  await requested.promise;
  const cancelling = login.cancel();
  started.resolve(start);
  await cancelling; await rejected;
  assert.equal(opens, 0);
  assert.deepEqual(calls, ['POST /api/models/oauth/start', 'DELETE /api/models/oauth/login-one']);
});

test('local browser polling completes without sending callbacks through application state', async () => {
  const popup = { closed: false, location: { href: '' }, close() { this.closed = true; } };
  const calls: string[] = [];
  const login = createModelLogin({ name: '账号', popup, now: () => 1000,
    request: async <T>(path: string) => { calls.push(path); return (path.endsWith('/start') ? start : completed) as T; },
  });
  assert.equal((await login.result).status, 'completed');
  assert.equal(popup.location.href, start.authUrl);
  assert.equal(popup.closed, true);
  assert.deepEqual(calls, ['/api/models/oauth/start', '/api/models/oauth/login-one']);
  assert.equal(localModelLoginHost('127.0.0.1'), true);
  assert.equal(localModelLoginHost('localhost.example.com'), false);
  assert.equal(localModelLoginHost('ar.example.com'), false);
});

test('untrusted authorization hosts are never opened and the pending session is cancelled', async () => {
  const popup = { closed: false, location: { href: '' }, close() { this.closed = true; } };
  const calls: string[] = [];
  const login = createModelLogin({ name: '账号', popup, request: async <T>(path: string, method?: string) => {
    calls.push(`${method ?? 'GET'} ${path}`);
    return (path.endsWith('/start') ? { ...start, authUrl: 'https://auth.openai.com.example.com/authorize' } : completed) as T;
  } });
  await assert.rejects(login.result, /受支持的 OpenAI/);
  assert.equal(popup.location.href, '');
  assert.equal(popup.closed, true);
  assert.deepEqual(calls, ['POST /api/models/oauth/start', 'DELETE /api/models/oauth/login-one']);
});
