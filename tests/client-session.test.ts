import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, markSessionBoundary, onSessionExpired } from '../client/api.js';
import { createSessionController, type Session } from '../client/state/useSession.js';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let count = 0; count < 6; count++) await Promise.resolve(); }
const anonymous: Session = { required: true, authenticated: false };
const signedIn: Session = { required: true, authenticated: true, username: 'rae' };

test('session check gates access, login sends credentials once, and controllers never retain passwords', async () => {
  const check = deferred<Session>(); const login = deferred<Session>(); const requests: Array<{ path: string; body: unknown }> = [];
  const controller = createSessionController(async <T>(path: string, _method?: string, body?: unknown) => {
    requests.push({ path, body }); return (path.endsWith('/session') ? check.promise : login.promise) as Promise<T>;
  });
  const stop = controller.start();
  try {
    assert.equal(controller.getSnapshot().phase, 'checking'); assert.equal(controller.getSnapshot().session, null);
    check.resolve(anonymous); await flush(); assert.deepEqual(controller.getSnapshot().session, anonymous);
    const submit = controller.login('rae', 'fixture password');
    assert.equal(await controller.login('rae', 'duplicate'), false); assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], { path: '/api/auth/login', body: { username: 'rae', password: 'fixture password' } });
    login.resolve(signedIn); assert.equal(await submit, true);
    assert.deepEqual(controller.getSnapshot().session, signedIn);
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /fixture password/);
  } finally { stop(); }
});

test('local unprotected mode is explicit and failed initial checks can be retried without exposing a runtime', async () => {
  let available = false;
  const controller = createSessionController(async <T>() => {
    if (!available) throw new Error('Network offline');
    return { required: false, authenticated: true } as T;
  });
  const stop = controller.start();
  try {
    await flush(); assert.equal(controller.getSnapshot().phase, 'error'); assert.equal(controller.getSnapshot().session, null);
    available = true; await controller.check();
    assert.deepEqual(controller.getSnapshot().session, { required: false, authenticated: true });
  } finally { stop(); }
});

test('wrong passwords stay on the login screen without triggering a session-wide expiry', async () => {
  const controller = createSessionController(async <T>(path: string) => {
    if (path.endsWith('/login')) throw new ApiError(401, '用户名或密码错误。');
    return anonymous as T;
  });
  const stop = controller.start();
  try {
    await flush(); assert.equal(await controller.login('rae', 'wrong'), false);
    assert.deepEqual(controller.getSnapshot().session, anonymous); assert.equal(controller.getSnapshot().busy, false);
    assert.equal(controller.getSnapshot().error, '用户名或密码错误。');
  } finally { stop(); }
});

test('logout hides private screens immediately, failures retry logout and never silently restore the previous view', async () => {
  const logout = deferred<unknown>(); let calls = 0;
  const controller = createSessionController(async <T>(path: string) => {
    if (path.endsWith('/logout')) { calls++; return logout.promise as Promise<T>; }
    return signedIn as T;
  });
  const stop = controller.start();
  try {
    await flush(); const pending = controller.logout();
    assert.equal(controller.getSnapshot().phase, 'checking'); assert.equal(controller.getSnapshot().session, null);
    logout.reject(new Error('Connection lost')); await pending;
    assert.equal(controller.getSnapshot().phase, 'error'); assert.equal(controller.getSnapshot().retry, 'logout');
    assert.equal(controller.getSnapshot().session, null); assert.equal(calls, 1);
  } finally { stop(); }
});

test('an expired logout is successful and late session reads cannot replace a more recent login', async () => {
  const old = deferred<Session>(); let checks = 0;
  const controller = createSessionController(async <T>(path: string) => {
    if (path.endsWith('/session')) { checks++; return old.promise as Promise<T>; }
    if (path.endsWith('/logout')) throw new ApiError(401, 'Session expired');
    return signedIn as T;
  });
  const stop = controller.start();
  try {
    assert.equal(await controller.login('rae', 'fixture'), true);
    old.resolve(anonymous); await flush(); assert.deepEqual(controller.getSnapshot().session, signedIn);
    await controller.logout(); assert.deepEqual(controller.getSnapshot().session, anonymous); assert.equal(checks, 1);
  } finally { stop(); }
});

test('stale lifecycle cleanup cannot stop a replacement session controller', async () => {
  const reads: Array<ReturnType<typeof deferred<Session>> & { signal?: AbortSignal }> = [];
  const controller = createSessionController(async <T>(_path: string, _method?: string, _body?: unknown, signal?: AbortSignal) => {
    const read = { ...deferred<Session>(), signal }; reads.push(read); return read.promise as Promise<T>;
  });
  const stop = controller.start(); stop(); const stopAgain = controller.start();
  try {
    stop(); assert.equal(reads[1].signal?.aborted, false);
    reads[1].resolve(signedIn); await flush(); reads[0].resolve(anonymous); await flush();
    assert.deepEqual(controller.getSnapshot().session, signedIn);
  } finally { stopAgain(); }
});

test('transport notifies only current business 401s and a stale request cannot expire a later login', async context => {
  const old = deferred<Response>(); let mode: 'old' | 'current' | 'login' = 'old'; let expired = 0;
  context.mock.method(globalThis, 'fetch', async () => mode === 'old' ? old.promise : new Response('{"error":"unauthorized"}', { status: 401 }));
  const unsubscribe = onSessionExpired(() => { expired++; });
  try {
    const pending = api('/api/state'); markSessionBoundary(); old.resolve(new Response('{"error":"expired"}', { status: 401 }));
    await assert.rejects(pending, ApiError); assert.equal(expired, 0);
    mode = 'current'; await assert.rejects(api('/api/state'), ApiError); assert.equal(expired, 1);
    mode = 'login'; await assert.rejects(api('/api/auth/login', 'POST', {}), ApiError); assert.equal(expired, 1);
  } finally { unsubscribe(); }
});
