import test from 'node:test';
import assert from 'node:assert/strict';
import { enrollFromLogin } from '../desktop/enrollment.js';

const origin = 'https://rae.example.com';
const token = 'a'.repeat(43);

test('desktop login uses the owner session only to request a pairing code', async context => {
  const device = { device: { id: 'local-device' }, credential: 'native-fixture-credential' };
  const enroll = context.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(url, `${origin}/api/device/enroll`);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('Origin'), false);
    assert.equal(headers.has('Cookie'), false);
    assert.deepEqual(JSON.parse(String(init?.body)), { pairingToken: token, name: '测试电脑', platform: 'win32' });
    return Response.json(device, { status: 201 });
  });
  const routes: string[] = [];
  const result = await enrollFromLogin({ baseUrl: origin, name: '测试电脑', isCurrent: () => true, ownerFetch: async (url, init) => {
    routes.push(url);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('Origin'), origin);
    return init.method === 'GET' ? Response.json({ required: true, authenticated: true }) : Response.json({ token });
  } });
  assert.deepEqual(routes, [`${origin}/api/auth/session`, `${origin}/api/devices/pairings`]);
  assert.deepEqual(result, device);
  assert.equal(enroll.mock.callCount(), 1);
});

test('desktop skips unauthenticated sessions and discards a pairing code received after logout', async context => {
  const enroll = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected native enrollment'); });
  let current = true;
  let requests = 0;
  const unauthenticated = await enrollFromLogin({ baseUrl: origin, name: '测试电脑', isCurrent: () => current, ownerFetch: async () => {
    requests++;
    return Response.json({ required: true, authenticated: false });
  } });
  assert.equal(unauthenticated, undefined);
  assert.equal(requests, 1);
  const stale = await enrollFromLogin({ baseUrl: origin, name: '测试电脑', isCurrent: () => current, ownerFetch: async (_url, init) => {
    if (init.method === 'GET') return Response.json({ required: true, authenticated: true });
    current = false;
    return Response.json({ token });
  } });
  assert.equal(stale, undefined);
  assert.equal(enroll.mock.callCount(), 0);
});
