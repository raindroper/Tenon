import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DeviceBroker } from '../server/devices/broker.js';
import { routeDeviceHttp } from '../server/devices/http.js';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceOutcomeUnknownError } from '../server/devices/broker.js';
import { z } from 'zod';
import { localProjectCapability, localProjectSpecSchema, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectSpecHash } from '../server/devices/projects.js';

test('device HTTP uses one-use enrollment and scoped bearer auth; browser origin and owner APIs are rejected', async () => {
  const broker = new DeviceBroker({ file: ':memory:' }); const server = createServer((request, response) => {
    void routeDeviceHttp(broker, request, response, request.url ?? '/').then(handled => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const pairing = broker.createPairing(); const input = { pairingToken: pairing.token, name: 'HTTP PC', platform: 'win32' };
    assert.equal((await post('/api/device/enroll', input, { origin: 'https://hostile.example' })).status, 403);
    const response = await post('/api/device/enroll', input); assert.equal(response.status, 201); const enrollment = await response.json() as { device: { id: string }; credential: string };
    assert.equal((await post('/api/device/enroll', input)).status, 403);
    assert.equal((await post('/api/device/status', { grants: [] })).status, 401);
    const authorization = `Bearer ${enrollment.credential}`;
    const updated = await post('/api/device/status', { grants: [], capabilities: ['mxc'] }, { authorization }); assert.equal(updated.status, 200);
    const publicView = await updated.text(); assert.equal(publicView.includes(enrollment.credential), false);
    assert.equal((await post('/api/device/status', { grants: [], extra: true }, { authorization })).status, 400);
    assert.equal((await fetch(base + '/api/devices', { headers: { authorization } })).status, 404);
    await broker.revokeDevice(enrollment.device.id);
    assert.equal((await post('/api/device/status', { grants: [] }, { authorization })).status, 401);
  } finally { await broker.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test('SSE reconnect sends a pending cancellation after headers and never resends execute', async () => {
  const broker = new DeviceBroker({ file: ':memory:', settlementTimeoutMs: 1000 }); const enrolled = broker.enroll({ pairingToken: broker.createPairing().token, name: 'Reconnect', platform: 'win32' });
  const grant = { id: 'grant', revision: 1, root: 'C:\\work', executable: 'C:\\Windows\\System32\\cmd.exe', readOnly: true, available: true };
  broker.updateDevice(enrolled.device.id, { grants: [grant] });
  const detach = broker.attach(enrolled.device.id, () => {}); const controller = new AbortController();
  const execution = broker.run({ deviceId: enrolled.device.id, grantId: grant.id, grantRevision: 1, executable: grant.executable, args: ['/d', '/c', 'echo fixture'], cwd: grant.root, timeoutMs: 5000 },
    { taskId: 'sse-task', taskRevision: 2, runId: 'sse-run', deadline: Date.now() + 5000, signal: controller.signal, guard() {} });
  const rejected = execution.catch(error => { assert.ok(error instanceof DeviceOutcomeUnknownError); });
  controller.abort(); detach();
  const server = createServer((request, response) => { void routeDeviceHttp(broker, request, response, request.url ?? '/'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const streamController = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/device/events`, { headers: { authorization: `Bearer ${enrolled.credential}` }, signal: streamController.signal });
    assert.equal(response.status, 200); assert.ok(response.headers.get('content-type')?.startsWith('text/event-stream'));
    const reader = response.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"kind":"cancel"/); assert.doesNotMatch(first, /"kind":"execute"/);
    const operationId = broker.operationForTask('sse-task')!.operationId; broker.recordResult(enrolled.device.id, { operationId, state: 'cancelled', exitCode: 1 });
    await execution; streamController.abort(); await reader.cancel().catch(() => {}); await rejected;
  } finally { streamController.abort(); await delay(5); await broker.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test('project tool argument failures identify the field and bound without exposing argument values or bypassing authorization', async () => {
  const broker = new DeviceBroker({ file: ':memory:' });
  const enrolled = broker.enroll({ name: 'Fixture PC', platform: 'win32', pairingToken: broker.createPairing().token });
  broker.updateDevice(enrolled.device.id, { grants: [], capabilities: [localProjectCapability] });
  const detach = broker.attach(enrolled.device.id, () => {});
  const spec = localProjectSpecSchema.parse({ deviceId: enrolled.device.id, root: 'D:\\fixture', network: false });
  const input: ProjectExecutionInput = { operationId: 'tool-errors', taskId: 'task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Fixture', objective: 'Read authorized evidence', expectedOutput: 'Evidence',
    ownerRequest: 'Read evidence', updates: [], model: { model: 'fixture', reasoningEffort: 'default', maxOutputTokens: null },
    stepLimit: null, deadline: null, issuedAt: new Date().toISOString() };
  let tools = 0;
  const pending = broker.projects.run(input, { signal: new AbortController().signal, guard() {}, onEvent() {}, async model() {},
    async context(_operation, raw) { tools++; return z.object({ limit: z.number().int().min(1).max(10) }).strict().parse(raw.arguments); } });
  const server = createServer((request, response) => { void routeDeviceHttp(broker, request, response, request.url ?? '/'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const authorization = { operationId: input.operationId, specHash: input.specHash, requirementsRevision: 1 };
  const post = (arguments_: unknown, permission = authorization) => fetch(`http://127.0.0.1:${address.port}/api/device/projectcontext`, {
    method: 'POST', headers: { authorization: 'Bearer ' + enrolled.credential, 'content-type': 'application/json' },
    body: JSON.stringify({ authorization: permission, input: { action: 'call', name: 'find_case_evidence', arguments: arguments_ } }),
  });
  try {
    const oversized = await post({ limit: 12 }); assert.equal(oversized.status, 400);
    const body = await oversized.json() as { error: string; code: string; tool: string; issues: Array<{ field: string; limit?: string }> };
    assert.match(body.error, /find_case_evidence.limit 最大为 10/);
    assert.equal(body.code, 'invalid_tool_arguments'); assert.equal(body.tool, 'find_case_evidence');
    assert.equal(body.issues[0].field, 'limit'); assert.equal(body.issues[0].limit, '10');
    const badType = await post({ limit: 'PRIVATE_ARGUMENT' }); assert.equal(badType.status, 400);
    const badTypeBody = await badType.text(); assert.match(badTypeBody, /需要 number/); assert.doesNotMatch(badTypeBody, /PRIVATE_ARGUMENT/);
    const extra = await post({ limit: 5, PRIVATE_ARGUMENT: enrolled.credential }); assert.equal(extra.status, 400);
    assert.doesNotMatch(await extra.text(), new RegExp('PRIVATE_ARGUMENT|' + enrolled.credential));
    const before = tools;
    const denied = await post({ limit: 12 }, { ...authorization, specHash: '0'.repeat(64) }); assert.equal(denied.status, 403);
    assert.equal(tools, before); assert.doesNotMatch(await denied.text(), /invalid_tool_arguments/);
  } finally {
    broker.projects.record(enrolled.device.id, { operationId: input.operationId, sequence: 1, requirementsRevision: 1,
      at: new Date().toISOString(), event: { kind: 'finished', state: 'cancelled', output: 'Fixture closed' } });
    await pending; detach(); await broker.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
