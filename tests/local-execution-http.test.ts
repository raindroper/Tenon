import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server/index.js';
import { hashWebPassword, WebAuth } from '../server/web-auth.js';
import { DeviceBroker, DeviceOutcomeUnknownError } from '../server/devices/broker.js';
import { Store } from '../server/store.js';
import type { RuntimeApi } from '../server/runtime.js';
import type { LegacyDeviceCommandSpec, DeviceServerMessage } from '../shared/local-device.js';

const origin = 'https://rae-device-fixture.example';
const password = 'offline-device-fixture-password';
const command: Omit<LegacyDeviceCommandSpec, 'deviceId'> = { grantId: 'fixture-grant', grantRevision: 1,
  executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', 'echo fixture'], cwd: 'D:\\fixture', timeoutMs: 1000 };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-local-execution-http-'));
  const store = new Store(directory);
  const broker = new DeviceBroker({ file: join(directory, 'events.sqlite'), settlementTimeoutMs: 10 });
  const auth = new WebAuth({ username: 'fixture-owner', password: await hashWebPassword(password), publicOrigin: origin }, join(directory, 'auth.sqlite'));
  let ownerCalls = 0;
  const runtime = { devices: broker, snapshot: async () => { ownerCalls++; return { private: 'owner-state' }; },
    listDevices: async () => { ownerCalls++; return broker.listDevices(); }, listDeviceOperations: async () => broker.listOperations(),
    createDevicePairing: async () => { ownerCalls++; return broker.createPairing(); },
    renameDevice: async (id: string, input: { name: string }) => broker.renameDevice(id, input),
    revokeDevice: async (id: string) => { ownerCalls++; await broker.revokeDevice(id); return { id, revoked: true }; },
  } as unknown as RuntimeApi;
  const previous = process.env.RAE_PUBLIC_ORIGIN; process.env.RAE_PUBLIC_ORIGIN = origin;
  let app;
  try { app = createApp({ store, runtime, auth, distDir: directory }); }
  finally { if (previous === undefined) delete process.env.RAE_PUBLIC_ORIGIN; else process.env.RAE_PUBLIC_ORIGIN = previous; }
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const port = (app.address() as { port: number }).port;
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; json: any; text: string; cookie?: string }>((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'rae-device-fixture.example',
      ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json: unknown;
        try { json = JSON.parse(text); } catch { /* All expected responses below are checked as JSON. */ }
        done({ status: response.statusCode!, json, text, cookie: response.headers['set-cookie']?.[0] }); });
    }); outgoing.once('error', fail); outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Device fixture did not receive an HTTP response.'))); outgoing.end(payload);
  });
  return { broker, call, ownerCalls: () => ownerCalls,
    async login() { const response = await call('/api/auth/login', 'POST', { username: 'fixture-owner', password }, { origin }); assert.equal(response.status, 200); return response.cookie!.split(';')[0]; },
    async close() {
      await broker.close(); await new Promise<void>((done, fail) => app.close(error => error ? fail(error) : done())); await auth.close(); store.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /rae-local-execution-http-/);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('the real HTTP app keeps owner cookie authority and native device bearer authority separate', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/api/devices/pairings', 'POST', {}, { origin })).status, 401);
    assert.equal(f.ownerCalls(), 0);
    const cookie = await f.login();
    assert.equal((await f.call('/api/devices/pairings', 'POST', {}, { cookie })).status, 403);
    const pairing = await f.call('/api/devices/pairings', 'POST', {}, { cookie, origin });
    assert.equal(pairing.status, 201); assert.equal(typeof pairing.json.token, 'string');
    assert.equal((await f.call('/api/device/enroll', 'POST', { pairingToken: pairing.json.token, name: 'must not enroll', platform: 'win32' }, { cookie, origin })).status, 403);
    const enrollment = await f.call('/api/device/enroll', 'POST', { pairingToken: pairing.json.token, name: 'Offline Windows fixture', platform: 'win32' });
    assert.equal(enrollment.status, 201);
    const authorization = `Bearer ${enrollment.json.credential}`;
    const status = { grants: [{ id: command.grantId, revision: command.grantRevision, root: command.cwd, executable: command.executable, readOnly: false, available: true }], capabilities: ['local-command'] };
    assert.equal((await f.call('/api/devices', 'GET', undefined, { authorization })).status, 401);
    assert.equal((await f.call('/api/state', 'GET', undefined, { authorization })).status, 401);
    assert.equal((await f.call('/api/devices/pairings', 'POST', {}, { authorization })).status, 401);
    assert.equal((await f.call('/api/device/status', 'POST', status, { cookie })).status, 401);
    assert.equal((await f.call('/api/device/admit', 'POST', { operationId: 'forged', specHash: 'forged' }, { cookie })).status, 401);
    assert.equal((await f.call('/api/device/results', 'POST', { operationId: 'forged', state: 'completed', exitCode: 0 }, { cookie })).status, 401);
    assert.equal((await f.call('/api/device/status', 'POST', status, { authorization, origin })).status, 403);
    assert.equal((await f.call('/api/device/status', 'POST', status, { authorization, origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.call('/api/device/status', 'POST', status, { authorization })).status, 200);
    assert.equal((await f.call('/api/devices', 'GET', undefined, { cookie })).json.length, 1);
    const deviceId = enrollment.json.device.id as string;
    const renamePath = `/api/devices/${deviceId}/rename`;
    assert.equal((await f.call(renamePath, 'POST', { name: '家里电脑' }, { authorization })).status, 401);
    assert.equal((await f.call(renamePath, 'POST', { name: '家里电脑' }, { cookie })).status, 403);
    assert.equal((await f.call(renamePath, 'POST', { name: '  ' }, { cookie, origin })).status, 400);
    const renamed = await f.call(renamePath, 'POST', { name: ' 家里电脑 ' }, { cookie, origin });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.name, '家里电脑');
    assert.equal(renamed.json.id, deviceId);
    assert.equal(renamed.json.grants[0].revision, command.grantRevision);
    let dispatched: DeviceServerMessage | undefined;
    const detach = f.broker.attach(deviceId, message => { dispatched = message; });
    try {
      const result = f.broker.run({ ...command, deviceId }, { taskId: 'fixture-http-task', taskRevision: 2, runId: 'fixture-http-run',
        deadline: Date.now() + 1000, signal: new AbortController().signal, guard() {} });
      assert.equal(dispatched?.kind, 'execute');
      const operationId = dispatched!.operationId;
      const admission = { operationId, specHash: dispatched!.kind === 'execute' ? dispatched!.specHash : '' };
      assert.equal((await f.call('/api/device/results', 'POST', { operationId, state: 'running' }, { authorization })).status, 409);
      assert.equal((await f.call('/api/device/results', 'POST', { operationId, state: 'completed', exitCode: 0 }, { authorization })).status, 409);
      assert.equal((await f.call('/api/device/admit', 'POST', { ...admission, specHash: '0'.repeat(64) }, { authorization })).status, 403);
      assert.equal((await f.call('/api/device/admit', 'POST', admission, { authorization, origin })).status, 403);
      assert.equal((await f.call('/api/device/admit', 'POST', admission, { authorization })).status, 200);
      assert.equal((await f.call('/api/device/admit', 'POST', admission, { authorization })).status, 409, 'Spawn admission is single-use');
      const receipt = { operationId, state: 'completed', exitCode: 0, stdout: 'fixture.txt' };
      assert.equal((await f.call('/api/device/results', 'POST', receipt, { authorization, origin })).status, 403);
      assert.equal(f.broker.getOperation(operationId)!.receipt.state, 'dispatched');
      assert.equal((await f.call('/api/device/results', 'POST', receipt, { authorization })).status, 200);
      assert.equal((await result).state, 'completed');
    } finally { detach(); }
  } finally { await f.close(); }
});

test('revoked device credentials can settle their original operation but cannot publish grants or read owner data', async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(); const pairing = await f.call('/api/devices/pairings', 'POST', {}, { cookie, origin });
    const enrollment = await f.call('/api/device/enroll', 'POST', { pairingToken: pairing.json.token, name: 'Revocation fixture', platform: 'win32' });
    const deviceId = enrollment.json.device.id as string; const authorization = `Bearer ${enrollment.json.credential}`;
    const status = { grants: [{ id: command.grantId, revision: 1, root: command.cwd, executable: command.executable, readOnly: false, available: true }] };
    assert.equal((await f.call('/api/device/status', 'POST', status, { authorization })).status, 200);
    const sent: DeviceServerMessage[] = []; const detach = f.broker.attach(deviceId, message => { sent.push(message); });
    try {
      const result = f.broker.run({ ...command, deviceId }, { taskId: 'fixture-http-revoked-task', taskRevision: 2, runId: 'fixture-http-revoked-run',
        deadline: Date.now() + 1000, signal: new AbortController().signal, guard() {} }).catch(error => error);
      const operationId = sent[0].operationId;
      const admission = { operationId, specHash: sent[0].kind === 'execute' ? sent[0].specHash : '' };
      assert.equal((await f.call('/api/device/admit', 'POST', admission, { authorization })).status, 200);
      const revocation = await f.call(`/api/devices/${deviceId}/revoke`, 'POST', {}, { cookie, origin });
      assert.equal(revocation.status, 409, 'Unknown physical outcome cannot be acknowledged as fully stopped');
      assert.equal((await f.call(`/api/devices/${deviceId}/rename`, 'POST', { name: '已撤销电脑' }, { cookie, origin })).status, 409);
      assert.ok((await result) instanceof DeviceOutcomeUnknownError);
      assert.equal(sent.at(-1)!.kind, 'cancel');
      assert.equal((await f.call('/api/device/status', 'POST', status, { authorization })).status, 401);
      assert.equal((await f.call('/api/device/admit', 'POST', admission, { authorization })).status, 401);
      assert.equal((await f.call('/api/devices', 'GET', undefined, { authorization })).status, 401);
      const late = { operationId, state: 'cancelled', finishedAt: new Date().toISOString() };
      assert.equal((await f.call('/api/device/results', 'POST', late, { authorization })).status, 200);
      assert.equal(f.broker.getOperation(operationId)!.receipt.state, 'cancelled');
      assert.equal((await f.call('/api/device/results', 'POST', { ...late, operationId: 'other-operation' }, { authorization })).status, 404);
      assert.equal((await f.call('/api/device/status', 'POST', status, { authorization })).status, 401);
    } finally { detach(); }
  } finally { await f.close(); }
});
