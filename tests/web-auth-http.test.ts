import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/index.js';
import { hashWebPassword, WebAuth } from '../server/web-auth.js';
import { Store } from '../server/store.js';
import type { RuntimeApi } from '../server/runtime.js';

const origin = 'https://rae.example.com';
const password = 'offline-only-test-password';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-web-login-http-'));
  const store = new Store(directory);
  const dist = join(directory, 'dist'); await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Public login shell</title>');
  const auth = new WebAuth({ username: 'rae', password: await hashWebPassword(password), publicOrigin: origin }, join(directory, 'auth.sqlite'));
  let runtimeCalls = 0;
  const runtime = { snapshot: async () => { runtimeCalls++; return { marker: 'private-owner-data' }; },
    createCase: async () => { runtimeCalls++; return { id: 'new-owner-case' }; } } as unknown as RuntimeApi;
  const previous = process.env.RAE_PUBLIC_ORIGIN;
  process.env.RAE_PUBLIC_ORIGIN = origin;
  let app;
  try { app = createApp({ store, runtime, distDir: dist, auth }); }
  finally { if (previous === undefined) delete process.env.RAE_PUBLIC_ORIGIN; else process.env.RAE_PUBLIC_ORIGIN = previous; }
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const port = (app.address() as { port: number }).port;
  return { auth, directory, runtimeCalls: () => runtimeCalls,
    call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
      return new Promise<{ status: number; body: string; json: any; cookie?: string }>((done, fail) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'rae.example.com',
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers } }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json: unknown; try { json = JSON.parse(text); } catch {}
            done({ status: response.statusCode!, body: text, json, cookie: response.headers['set-cookie']?.[0] }); });
        }); outgoing.on('error', fail); outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Web auth fixture did not receive an HTTP response.'))); outgoing.end(payload);
      });
    },
    async close() {
      await new Promise<void>((done, fail) => app.close(error => error ? fail(error) : done())); await auth.close(); store.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /rae-web-login-http-/);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('one auth gate protects every runtime path including exports, images and compatibility aliases', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/')).status, 200);
    assert.equal((await f.call('/api/health')).status, 200);
    assert.deepEqual((await f.call('/api/auth/session')).json, { required: true, authenticated: false });
    for (const path of ['/api/state', '/api/v2/state', '/api/export', '/api/images/11111111-1111-4111-8111-111111111111',
      '/api/chat/files/11111111-1111-4111-8111-111111111111', '/api/cases', '/api/unknown']) {
      const response = await f.call(path); assert.equal(response.status, 401, path); assert.doesNotMatch(response.body, /private-owner-data/);
    }
    assert.equal((await f.call('/api/messages', 'POST', { content: 'must not be ingested' })).status, 401);
    assert.equal((await f.call('/api/state', 'GET', undefined, { host: `127.0.0.1:4317` })).status, 401, 'Loopback Host cannot bypass enabled auth');
    assert.equal((await f.call('/api/state', 'GET', undefined, { authorization: 'Basic ' + Buffer.from('rae:' + password).toString('base64') })).status, 401, 'Retired BasicAuth cannot authenticate');
    assert.equal(f.runtimeCalls(), 0);
  } finally { await f.close(); }
});

test('login validates same origin and emits a secure opaque session without exposing credentials', async () => {
  const f = await fixture();
  try {
    const rejectedOrigins: Record<string, string>[] = [{}, { origin: 'null' }, { origin: 'https://evil.example', 'x-forwarded-origin': origin }, { origin: 'http://rae.example.com', 'x-forwarded-proto': 'https' }];
    for (const headers of rejectedOrigins) {
      assert.equal((await f.call('/api/auth/login', 'POST', { username: 'rae', password }, headers)).status, 403);
    }
    const wrong = await f.call('/api/auth/login', 'POST', { username: 'rae', password: 'wrong' }, { origin });
    assert.equal(wrong.status, 401); assert.doesNotMatch(wrong.body, /scrypt|salt|hash/);
    const login = await f.call('/api/auth/login', 'POST', { username: 'rae', password }, { origin });
    assert.equal(login.status, 200); assert.deepEqual(login.json, { required: true, authenticated: true, username: 'rae' });
    assert.ok(login.cookie); assert.match(login.cookie, /HttpOnly/i); assert.match(login.cookie, /Secure/); assert.match(login.cookie, /SameSite=Strict/); assert.doesNotMatch(login.cookie, /Domain=|offline-only/);
    const cookie = login.cookie.split(';')[0];
    assert.equal((await f.call('/api/state', 'GET', undefined, { cookie })).json.marker, 'private-owner-data');
    assert.deepEqual((await f.call('/api/auth/session', 'GET', undefined, { cookie })).json, login.json);
    assert.equal(f.runtimeCalls(), 1);
  } finally { await f.close(); }
});

test('authenticated mutations require origin and logout revokes the session before replay', async () => {
  const f = await fixture();
  try {
    const login = await f.call('/api/auth/login', 'POST', { username: 'rae', password }, { origin });
    const cookie = login.cookie!.split(';')[0];
    const body = { title: 'owner request', objective: 'offline test', domain: 'test' };
    assert.equal((await f.call('/api/cases', 'POST', body, { cookie })).status, 403);
    assert.equal(f.runtimeCalls(), 0);
    assert.equal((await f.call('/api/cases', 'POST', body, { cookie, origin })).status, 201);
    assert.equal(f.runtimeCalls(), 1);
    assert.equal((await f.call('/api/auth/logout', 'POST', {}, { cookie })).status, 403);
    const logout = await f.call('/api/auth/logout', 'POST', {}, { cookie, origin });
    assert.equal(logout.status, 200); assert.match(logout.cookie!, /Max-Age=0/);
    assert.equal((await f.call('/api/state', 'GET', undefined, { cookie })).status, 401);
    assert.equal((await f.call('/api/auth/logout')).status, 405);
    assert.equal((await f.call('/api/cases', 'POST', body, { cookie, origin })).status, 401);
    assert.equal(f.runtimeCalls(), 1);
  } finally { await f.close(); }
});

test('a public deployment without built-in credentials fails before creating runtime data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-login-fail-closed-')); const data = join(directory, 'must-not-exist');
  try {
    const environment = { ...process.env, DEEPSEEK_API_KEY: '', RAE_PUBLIC_ORIGIN: origin, RAE_DATA_DIR: data };
    delete (environment as Record<string, string | undefined>).RAE_AUTH_FILE;
    const result = spawnSync(process.execPath, ['--import', './scripts/test-network-guard.mjs', '--import', 'tsx', 'server/index.ts'], {
      cwd: process.cwd(), env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /RAE_AUTH_FILE/); assert.equal(existsSync(data), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
