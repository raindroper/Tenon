import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { createApp } from '../server/index.js';
import { Store } from '../server/store.js';
import type { RuntimeApi } from '../server/runtime.js';
import type { RuntimeModelCommands } from '../server/models/runtime.js';
import { ModelConnectionError } from '../server/models/connections.js';
import { SiwcError } from '../server/models/siwc.js';
import { routeRuntime } from '../server/v2/http.js';
import { HttpError } from '../server/http.js';
import type { ModelConnectionInput, ModelDirectory, ModelSelection, SiwcLoginStart, SiwcLoginStatus } from '../shared/model-connections.js';
import { api as clientApi, ApiError, onSessionExpired } from '../client/api.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-model-api-'));
  const store = new Store(directory);
  const accepted: { saves: number; tests: ModelSelection[]; logins: unknown[]; completions: Array<{ id: string; callback: string }>; cancellations: string[] } = {
    saves: 0, tests: [], logins: [], completions: [], cancellations: [],
  };
  let completeFailure: Error | undefined;
  let catalogFailure: Error | undefined;
  let cancelWait: Promise<void> | undefined;
  const login: SiwcLoginStart = { loginId: 'login-one', connectionId: 'siwc-one', status: 'pending', expiresAt: Date.now() + 60_000,
    authUrl: 'https://auth.openai.com/api/accounts/authorize?state=synthetic', redirectUri: 'http://127.0.0.1:1455/auth/callback' };
  const commands: RuntimeModelCommands = {
    list: async () => store.models.directory(),
    save: async input => { accepted.saves++; return store.models.upsert(input); },
    remove: async (id, revision) => { store.models.remove(id, revision); return store.models.directory(); },
    defaults: async input => store.models.setDefaults(input),
    scene: async (id, input) => store.models.setScene(id, input),
    catalog: async () => { if (catalogFailure) throw catalogFailure; return []; },
    test: async selection => { accepted.tests.push(selection); return { ok: true, message: 'offline receipt only' }; },
    login: async input => { accepted.logins.push(input); return login; },
    loginStatus: async () => login,
    completeLogin: async (id, callback) => {
      accepted.completions.push({ id, callback });
      if (completeFailure) throw completeFailure;
      return { ...login, status: 'completed' };
    },
    cancelLogin: async id => { accepted.cancellations.push(id); await cancelWait; },
    logout: async () => ({ remoteRevoked: false, message: '本地已退出，远端撤销未确认。' }),
  };
  const runtime = { modelConnections: commands, subscribe: () => () => {}, status: () => ({ state: 'paused' }) } as unknown as RuntimeApi;
  const app = createApp({ store, runtime });
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const address = app.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  return { store, runtime, commands, accepted, login, origin,
    failCompletion(error?: Error) { completeFailure = error; },
    failCatalog(error?: Error) { catalogFailure = error; },
    waitCancel(promise: Promise<void>) { cancelWait = promise; },
    call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any; text: string }> {
      return new Promise((done, fail) => {
        const req = request(origin + path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' } }, response => {
          let text = ''; response.on('data', chunk => { text += chunk; });
          response.on('end', () => done({ status: response.statusCode!, body: JSON.parse(text), text }));
        }); req.on('error', fail); req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    },
    async close() {
      app.closeAllConnections(); await new Promise<void>(done => app.close(() => done())); store.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /rae-model-api-/);
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
    },
  };
}

const input = (name = '连接一'): ModelConnectionInput => ({ name, kind: 'api-key', protocol: 'deepseek', endpoint: 'https://fixture.invalid/v1', apiKey: 'synthetic-private-key' });
const selection = (connectionId: string, modelId = 'fixture-model'): ModelSelection => ({ connectionId, modelId, reasoning: 'high', maxOutputTokens: null });

test('model connection HTTP creates named connections without changing defaults or exposing credentials', async () => {
  const f = await fixture();
  try {
    const before = (await f.call('/api/models')).body as ModelDirectory;
    const created = await f.call('/api/models/connections', 'POST', input());
    assert.equal(created.status, 201); assert.equal(created.body.name, '连接一'); assert.equal(created.body.credentialConfigured, true);
    assert.equal(created.body.apiKey, undefined); assert.equal(created.body.credentialRef, undefined);
    assert.equal(created.text.includes('synthetic-private-key'), false);
    const after = await f.call('/api/models');
    assert.deepEqual(after.body.defaults, before.defaults);
    assert.equal(after.body.connections.length, before.connections.length + 1);
    assert.equal(after.text.includes('synthetic-private-key'), false);
    assert.equal(f.store.getSettings().enabled, false);
    assert.equal(f.accepted.tests.length, 0);
  } finally { await f.close(); }
});

test('model HTTP validates input before mutation and scrubs caller-owned key fields on success or rejection', async () => {
  const f = await fixture();
  try {
    for (const invalid of [
      { ...input(), endpoint: 'https://user:password@fixture.invalid/v1' },
      { ...input(), accessToken: 'not-an-api-key-field' },
      { ...input(), kind: 'siwc' },
      { ...input(), enabled: 'yes' },
    ]) {
      assert.equal((await f.call('/api/models/connections', 'POST', invalid)).status, 400);
    }
    assert.equal(f.accepted.saves, 0);
    const validBody = input();
    const saved = await routeRuntime(f.runtime, '/api/models/connections', 'POST', validBody);
    assert.equal(saved.status, 201); assert.equal(validBody.apiKey, '');
    const invalidBody = { ...input(), arbitraryScope: true };
    await assert.rejects(routeRuntime(f.runtime, '/api/models/connections', 'POST', invalidBody), error => error instanceof z.ZodError);
    assert.equal(invalidBody.apiKey, '');
    const invalidPathBody = { ...input(), expectedRevision: 1 };
    await assert.rejects(routeRuntime(f.runtime, '/api/models/connections/not.valid', 'PATCH', invalidPathBody));
    assert.equal(invalidPathBody.apiKey, '');
    assert.equal(f.accepted.saves, 1);
  } finally { await f.close(); }
});

test('defaults and scenes accept only complete selections and preserve independent choices under CAS conflicts', async () => {
  const f = await fixture();
  try {
    const first = (await f.call('/api/models/connections', 'POST', input())).body;
    const second = (await f.call('/api/models/connections', 'POST', input('连接二'))).body;
    const original = f.store.models.getDefaults();
    for (const patch of [
      { global: { connectionId: first.id }, expectedRevision: original.revision },
      { global: selection(first.id) },
      { background: { mode: 'inherit-global', selection: selection(first.id) }, expectedRevision: original.revision },
      { global: selection(first.id), expectedRevision: original.revision, apiKey: 'injected' },
    ]) assert.equal((await f.call('/api/models/defaults', 'PATCH', patch)).status, 400);
    assert.deepEqual(f.store.models.getDefaults(), original);
    const global = await f.call('/api/models/defaults', 'PATCH', { global: selection(first.id), expectedRevision: original.revision });
    assert.equal(global.status, 200);
    const background = await f.call('/api/models/defaults', 'PATCH', { background: { mode: 'explicit', selection: selection(second.id, 'background-model') }, expectedRevision: global.body.revision });
    assert.equal(background.status, 200);
    assert.deepEqual(background.body.global, selection(first.id));
    const scene = await f.call('/api/models/scenes/scene-one', 'PATCH', { preference: { mode: 'explicit', selection: selection(first.id) }, expectedRevision: 0 });
    assert.equal(scene.status, 200);
    assert.equal((await f.call('/api/models/scenes/scene-one', 'PATCH', { preference: { mode: 'inherit-global' }, expectedRevision: 0 })).status, 409);
    const updates = await Promise.all([
      f.call('/api/models/defaults', 'PATCH', { global: selection(second.id), expectedRevision: background.body.revision }),
      f.call('/api/models/defaults', 'PATCH', { global: selection(first.id, 'another-model'), expectedRevision: background.body.revision }),
    ]);
    assert.deepEqual(updates.map(value => value.status).sort(), [200, 409]);
    assert.deepEqual(f.store.models.getScene('scene-one').preference, { mode: 'explicit', selection: selection(first.id) });
    assert.deepEqual(f.store.models.getDefaults().background, { mode: 'explicit', selection: selection(second.id, 'background-model') });
    assert.equal((await f.call('/api/models/scenes/scene-one', 'PATCH', { preference: { mode: 'inherit-global' }, expectedRevision: scene.body.revision })).status, 200);
    assert.deepEqual(f.store.models.getScene('scene-one').preference, { mode: 'inherit-global' });
    assert.equal(f.accepted.tests.length, 0);
  } finally { await f.close(); }
});

test('explicit connection tests cannot submit a different connection or implicit partial model selection', async () => {
  const f = await fixture();
  try {
    const saved = (await f.call('/api/models/connections', 'POST', input())).body;
    const path = `/api/models/connections/${saved.id}/test`;
    assert.equal((await f.call(path, 'POST', { selection: selection('another-connection') })).status, 400);
    assert.equal((await f.call(path, 'POST', { selection: { connectionId: saved.id, modelId: 'fixture-model' } })).status, 400);
    assert.equal((await f.call(path, 'POST', { selection: selection(saved.id), enabled: true })).status, 400);
    assert.equal(f.accepted.tests.length, 0);
    const tested = await f.call(path, 'POST', { selection: selection(saved.id) });
    assert.equal(tested.status, 200); assert.equal(tested.body.ok, true);
    assert.deepEqual(f.accepted.tests, [selection(saved.id)]);
    assert.equal(f.store.getSettings().enabled, false);
  } finally { await f.close(); }
});

test('OAuth completion forwards only its accepted callback and clears it on success or failure', async () => {
  const f = await fixture();
  try {
    const initiated = await f.call('/api/models/oauth/start', 'POST', { name: '账号一', redirectUri: f.login.redirectUri, reconsent: true });
    assert.equal(initiated.status, 200); assert.equal(initiated.body.authUrl, f.login.authUrl);
    assert.deepEqual(f.accepted.logins, [{ name: '账号一', redirectUri: f.login.redirectUri, reconsent: true }]);
    assert.equal((await f.call('/api/models/oauth/start', 'POST', { name: '账号二', accessToken: 'injected' })).status, 400);
    const callback = `${f.login.redirectUri}?code=one-time&state=synthetic`;
    const body = { callbackUrl: callback };
    const completed = await routeRuntime(f.runtime, '/api/models/oauth/login-one/complete', 'POST', body);
    assert.equal((completed.body as SiwcLoginStatus).status, 'completed'); assert.equal(body.callbackUrl, '');
    assert.deepEqual(f.accepted.completions, [{ id: 'login-one', callback }]);
    f.failCompletion(new SiwcError('invalid_grant', '授权码已过期，请重新登录。', 400));
    const failedBody = { callbackUrl: callback };
    await assert.rejects(routeRuntime(f.runtime, '/api/models/oauth/login-one/complete', 'POST', failedBody), error => error instanceof SiwcError);
    assert.equal(failedBody.callbackUrl, '');
    const invalidBody = { callbackUrl: callback, connectionId: 'other-account' };
    await assert.rejects(routeRuntime(f.runtime, '/api/models/oauth/login-one/complete', 'POST', invalidBody), error => error instanceof z.ZodError);
    assert.equal(invalidBody.callbackUrl, '');
    const status = await f.call('/api/models/oauth/login-one');
    assert.equal(status.status, 200); assert.equal(status.body.loginId, 'login-one');
    assert.equal((await f.call('/api/models/connections/siwc-one/logout', 'POST', {})).body.remoteRevoked, false);
  } finally { await f.close(); }
});

test('OAuth cancellation does not acknowledge completion before the accepted command drains', async () => {
  const f = await fixture();
  try {
    const cancellation = gate<void>(); f.waitCancel(cancellation.promise);
    let settled = false;
    const result = routeRuntime(f.runtime, '/api/models/oauth/login-one', 'DELETE').then(value => { settled = true; return value; });
    await Promise.resolve();
    assert.deepEqual(f.accepted.cancellations, ['login-one']); assert.equal(settled, false);
    cancellation.resolve();
    assert.deepEqual(await result, { status: 200, body: { cancelled: true } });
    await assert.rejects(routeRuntime(f.runtime, '/api/models/oauth/invalid.id', 'DELETE'), error => error instanceof z.ZodError);
    await assert.rejects(routeRuntime({} as RuntimeApi, '/api/models', 'GET'), error => error instanceof HttpError && error.status === 409);
  } finally { await f.close(); }
});

test('upstream OAuth 401 becomes an actionable connection error without expiring the AR client session', async context => {
  const f = await fixture();
  let sessionExpirations = 0;
  const unsubscribe = onSessionExpired(() => { sessionExpirations++; });
  try {
    f.failCatalog(new SiwcError('subscription_sharing_invalid_user', 'ChatGPT 授权需要重新连接。', 401, 'provider-request-one'));
    const response = await f.call('/api/models/connections/siwc-one/catalog', 'POST', {});
    assert.equal(response.status, 409); assert.equal(response.body.code, 'subscription_sharing_invalid_user');
    const originalFetch = globalThis.fetch;
    context.mock.method(globalThis, 'fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) => originalFetch(new URL(String(url), f.origin), init));
    await assert.rejects(clientApi('/api/models/connections/siwc-one/catalog', 'POST', {}), error => error instanceof ApiError && error.status === 409);
    assert.equal(sessionExpirations, 0);
    assert.equal((await f.call('/api/auth/session')).body.authenticated, true);
    f.failCatalog(new ModelConnectionError(409, '这个连接的密钥需要修复。'));
    assert.equal((await f.call('/api/models/connections/siwc-one/catalog', 'POST', {})).status, 409);
  } finally { unsubscribe(); await f.close(); }
});
