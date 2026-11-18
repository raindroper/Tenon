import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { Store } from '../server/store.js';
import { WebAuth, hashWebPassword } from '../server/web-auth.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MAX_WECHAT_OBSERVATIONS_PER_DEVICE, type WeChatObservationGrant } from '../shared/wechat-observation.js';
import { createWeChatTools } from '../server/v2/wechat-tools.js';
import { caseSourceContext } from '../server/v2/source-context.js';
import type { ConnectorService } from '../server/connectors/service.js';

const origin = 'https://rae.example.test';
const ownerPath = '/api/wechat-observations';
const devicePath = '/api/device/wechatobservations';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-wechat-desktop-'));
  const store = new Store(directory);
  const runtime = await V2Coordinator.create(store, { dataDir: directory, connectorProviders: {} });
  const password = 'offline-wechat-fixture';
  const auth = new WebAuth({ username: 'rae', password: await hashWebPassword(password), publicOrigin: origin }, join(directory, 'auth.sqlite'));
  const previous = process.env.RAE_PUBLIC_ORIGIN;
  process.env.RAE_PUBLIC_ORIGIN = origin;
  let app;
  try { app = createApp({ store, runtime, auth }); }
  finally { if (previous === undefined) delete process.env.RAE_PUBLIC_ORIGIN; else process.env.RAE_PUBLIC_ORIGIN = previous; }
  t.after(async () => {
    await new Promise<void>((done, fail) => app.close(error => error ? fail(error) : done()));
    await runtime.close(); await auth.close(); store.close();
    // The test runner removes the isolated fixture after native SQLite handles exit.
  });
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const port = (app.address() as { port: number }).port;
  function call(path: string, method: string, input?: object, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: string; cookie?: string }>((done, fail) => {
      const payload = input === undefined ? undefined : JSON.stringify(input);
      const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers: {
        host: new URL(origin).host,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      } }, response => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => done({ status: response.statusCode!, body, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] }));
      });
      outgoing.on('error', fail); outgoing.end(payload);
    });
  }
  const login = await call('/api/auth/login', 'POST', { username: 'rae', password }, { origin });
  assert.equal(login.status, 200); assert.ok(login.cookie);
  const owner = { cookie: login.cookie, origin };
  const pair = (name: string) => runtime.devices.enroll({ pairingToken: runtime.devices.createPairing().token, name, platform: 'win32' });
  const device = pair('Windows fixture');
  const deviceHeaders = { authorization: `Bearer ${device.credential}` };
  const topic = await runtime.createCase({ title: 'Fixture topic', objective: 'Receive scoped fixture events', domain: 'test' });
  const selection = { deviceId: device.device.id, windowId: 'opaque-window-A', caseId: topic.id };
  async function start(input = selection) {
    const response = await call(ownerPath, 'POST', input, owner);
    assert.equal(response.status, 201, response.body);
    return JSON.parse(response.body) as WeChatObservationGrant;
  }
  const changes = () => runtime.inbox.list().filter(event => event.kind === 'connector.change');
  const connectors = (runtime as unknown as { connectors: ConnectorService }).connectors;
  return { call, device, deviceHeaders, owner, pair, runtime, selection, start, changes, store, connectors };
}

test('owner consent and exact paired device/window scope guard idempotent passive WeChat ingestion', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(ownerPath, 'POST', f.selection, f.deviceHeaders)).status, 401);
  assert.equal((await f.call(ownerPath, 'POST', f.selection, { cookie: f.owner.cookie })).status, 403);
  assert.equal((await f.call(ownerPath, 'POST', { ...f.selection, deviceId: 'missing-device' }, f.owner)).status, 409);
  const grant = await f.start();
  assert.equal(grant.caseId, f.selection.caseId);
  const binding = { grantId: grant.id, windowId: grant.windowId };
  const heartbeat = { ...binding, rows: [] };
  const second = f.pair('Other fixture');
  assert.equal((await f.call(devicePath, 'POST', heartbeat, f.owner)).status, 403);
  assert.equal((await f.call(devicePath, 'POST', heartbeat, { cookie: f.owner.cookie })).status, 401);
  assert.equal((await f.call(devicePath, 'POST', heartbeat, { authorization: `Bearer ${second.credential}` })).status, 404);
  assert.equal((await f.call(devicePath, 'POST', { ...heartbeat, windowId: 'other-window' }, f.deviceHeaders)).status, 404);
  assert.deepEqual(JSON.parse((await f.call(devicePath, 'POST', heartbeat, f.deviceHeaders)).body), { accepted: 0, duplicates: 0 });
  assert.deepEqual(f.changes(), []);

  const rows = [{ id: 'uia-event-1', text: '  仅授权窗口中的测试消息\n保留内容  ' }];
  const input = { ...binding, rows };
  const inserted = await f.call(devicePath, 'POST', input, f.deviceHeaders);
  assert.equal(inserted.status, 200); assert.deepEqual(JSON.parse(inserted.body), { accepted: 1, duplicates: 0 });
  const replay = await f.call(devicePath, 'POST', { ...binding, rows: [{ ...rows[0], text: '重放也不能改写既有证据' }] }, f.deviceHeaders);
  assert.deepEqual(JSON.parse(replay.body), { accepted: 0, duplicates: 1 });
  const [event] = f.changes();
  assert.equal(f.changes().length, 1);
  assert.equal(event.actor, 'external'); assert.equal(event.caseId, grant.caseId); assert.equal(event.sourceGeneration, grant.id);
  assert.deepEqual(event.payload, { provider: 'wechat-desktop', title: '微信桌面会话', content: rows[0].text });
  assert.equal(f.runtime.sources.isEventAllowed(event), true);
  assert.equal(f.runtime.sources.isEventAllowed({ ...event, caseId: 'other-case' }), false);
  assert.deepEqual(f.runtime.consent.list(), []);
  assert.deepEqual(f.store.list('sources'), []);
  const invalid = await f.call(devicePath, 'POST', { ...binding, rows: Array.from({ length: 3 }, (_, i) => ({ id: `oversized-${i}`, text: '密'.repeat(4000) })) }, f.deviceHeaders);
  assert.equal(invalid.status, 400); assert.doesNotMatch(invalid.body, /密/);
  assert.equal(f.changes().length, 1);

  assert.equal((await f.call(devicePath, 'DELETE', { ...binding, windowId: 'other-window' }, f.deviceHeaders)).status, 404);
  for (let i = 0; i < 2; i++) {
    const stopped = await f.call(devicePath, 'DELETE', binding, f.deviceHeaders);
    assert.equal(stopped.status, 200); assert.deepEqual(JSON.parse(stopped.body), { id: grant.id, stopped: true });
  }
  assert.equal((await f.call(devicePath, 'POST', heartbeat, f.deviceHeaders)).status, 409);
  const stoppedGrants = JSON.parse((await f.call(ownerPath, 'GET', undefined, f.owner)).body) as WeChatObservationGrant[];
  assert.ok(stoppedGrants[0]?.stoppedAt);
  assert.equal(f.runtime.sources.isEventAllowed(event), true, 'stopping transport preserves accepted evidence');
  f.runtime.inbox.captureObservations(candidate => f.runtime.sources.isEventAllowed(candidate));
  const observation = f.runtime.inbox.releaseObservation(candidate => f.runtime.sources.isEventAllowed(candidate), Date.now(), true, {
    caseId: grant.caseId, sourceGenerations: [grant.id],
  });
  assert.deepEqual(observation?.payload.eventIds, [event.id]);
  assert.deepEqual(f.runtime.consent.list(), []);
  assert.ok(!f.runtime.inbox.list().some(candidate => candidate.kind === 'task.execute'));
  const revoked = await f.call(`${ownerPath}/${grant.id}`, 'DELETE', undefined, f.owner);
  assert.equal(revoked.status, 200); assert.deepEqual(JSON.parse(revoked.body), { id: grant.id, revoked: true });
  assert.equal(f.runtime.sources.isEventAllowed(event), false);
  assert.equal(f.runtime.sources.isEventAllowed(observation!), false);
  assert.ok(f.runtime.inbox.get(event.id), 'revocation retains the archived event');
});

test('replaced and expired WeChat leases stay closed, and topic/device revocation fences historical observations', async t => {
  const f = await fixture(t);
  const first = await f.start();
  const renew = (grant: WeChatObservationGrant) => f.call(`${ownerPath}/${grant.id}`, 'PATCH', {
    deviceId: grant.deviceId, caseId: grant.caseId, windowId: grant.windowId,
  }, f.owner);
  const submit = async (grant: WeChatObservationGrant, id?: string) => f.call(devicePath, 'POST', {
    grantId: grant.id, windowId: grant.windowId, rows: id ? [{ id, text: id }] : [],
  }, f.deviceHeaders);
  assert.equal((await submit(first, 'first-change')).status, 200);
  const second = await f.start();
  assert.equal((await submit(first, 'replaced-cannot-ingest')).status, 409);
  assert.equal((await renew(first)).status, 409);
  assert.equal(f.runtime.sources.isEventAllowed(f.changes()[0]), true);
  assert.equal((await submit(second, 'second-change')).status, 200);
  const sourceId = `connector:${second.id}`;
  f.runtime.inbox.ingestBatch([], { sourceId, sourceGeneration: second.id, value: { expiresAt: new Date(0).toISOString() } });
  assert.equal((await submit(second)).status, 409);
  assert.ok(f.changes().every(event => f.runtime.sources.isEventAllowed(event)));

  const third = await f.start({ ...f.selection, windowId: 'opaque-window-C' });
  await f.runtime.cancelCase(third.caseId);
  assert.equal((await submit(third)).status, 409);
  assert.equal((await renew(third)).status, 409);
  await f.runtime.updateCase(third.caseId, { status: 'active' });
  assert.equal((await submit(third)).status, 409);
  assert.equal((await f.call(ownerPath, 'POST', { ...f.selection, windowId: third.windowId }, f.owner)).status, 409);
  assert.ok(f.changes().every(event => !f.runtime.sources.isEventAllowed(event)));
  const fourth = await f.start({ ...f.selection, windowId: 'opaque-window-D' });
  assert.equal((await submit(fourth, 'fourth-change')).status, 200);
  await f.runtime.revokeDevice(f.device.device.id);
  assert.equal((await submit(fourth)).status, 401);
  assert.equal((await renew(fourth)).status, 409);
  assert.equal((await f.call(ownerPath, 'POST', { ...f.selection, windowId: fourth.windowId }, f.owner)).status, 409);
  assert.ok(f.changes().every(event => !f.runtime.sources.isEventAllowed(event)));
  assert.deepEqual(JSON.parse((await f.call(ownerPath, 'GET', undefined, f.owner)).body), []);
});

test('owner renewal revives only an expired transport with the same event dedupe identity', async t => {
  const f = await fixture(t);
  const grant = await f.start();
  const path = `${ownerPath}/${grant.id}`;
  const scope = { grantId: grant.id, windowId: grant.windowId };
  const submitted = { ...scope, rows: [{ id: 'fixture-row', text: 'fixture message' }] };
  assert.equal((await f.call(devicePath, 'POST', submitted, f.deviceHeaders)).status, 200);
  const sourceId = `connector:${grant.id}`;
  f.runtime.inbox.ingestBatch([], { sourceId, sourceGeneration: grant.id, value: { expiresAt: new Date(0).toISOString() } });
  assert.equal((await f.call(devicePath, 'POST', submitted, f.deviceHeaders)).status, 409);
  assert.equal((await f.call(path, 'PATCH', f.selection, f.deviceHeaders)).status, 401);
  assert.equal((await f.call(path, 'PATCH', f.selection, { ...f.owner, origin: 'https://other.example.test' })).status, 403);
  assert.equal((await f.call(path, 'PATCH', { ...f.selection, extra: true }, f.owner)).status, 400);
  for (const field of ['deviceId', 'windowId', 'caseId'] as const) {
    assert.equal((await f.call(path, 'PATCH', { ...f.selection, [field]: 'mismatched-binding' }, f.owner)).status, 404);
  }
  const scopeKey = `connectors.wechat-desktop.scope.${grant.deviceId}.${grant.windowId}`;
  f.store.setMeta(scopeKey, null); // Older grants can exist without a separate scope record.
  const renewed = await f.call(path, 'PATCH', f.selection, f.owner);
  assert.equal(renewed.status, 200, renewed.body);
  const view = JSON.parse(renewed.body) as WeChatObservationGrant;
  assert.deepEqual({ ...view, expiresAt: grant.expiresAt }, grant);
  assert.ok(Date.parse(view.expiresAt) > Date.now());
  assert.deepEqual(JSON.parse((await f.call(path, 'PATCH', f.selection, f.owner)).body), view);
  const replay = await f.call(devicePath, 'POST', submitted, f.deviceHeaders);
  assert.equal(replay.status, 200);
  assert.deepEqual(JSON.parse(replay.body), { accepted: 0, duplicates: 1 });
  assert.deepEqual(f.changes().map(change => change.sourceGeneration), [grant.id]);
  assert.equal((await f.call(devicePath, 'DELETE', scope, f.deviceHeaders)).status, 200);
  assert.equal((await f.call(path, 'PATCH', f.selection, f.owner)).status, 409);
  const next = await f.start();
  assert.equal((await f.call(path, 'DELETE', undefined, f.owner)).status, 200);
  assert.equal((await f.call(`${ownerPath}/${next.id}`, 'PATCH', f.selection, f.owner)).status, 409);
  assert.equal((await f.call('/api/auth/logout', 'POST', {}, f.owner)).status, 200);
  assert.equal((await f.call(`${ownerPath}/${next.id}`, 'PATCH', f.selection, f.owner)).status, 401);
});

test('up to five independently scoped windows per device can watch concurrently', async t => {
  const f = await fixture(t);
  const otherCase = await f.runtime.createCase({ title: 'Second topic', objective: 'Observe the second window', domain: 'test' });
  const bindings = Array.from({ length: MAX_WECHAT_OBSERVATIONS_PER_DEVICE }, (_, index) => ({
    ...f.selection, caseId: index === 1 ? otherCase.id : f.selection.caseId, windowId: `opaque-window-${index}`,
  }));
  const grants = await Promise.all(bindings.map(binding => f.start(binding)));
  const [first, second] = grants;
  const scope = (grant: WeChatObservationGrant) => ({ grantId: grant.id, windowId: grant.windowId });
  const submit = (grant: WeChatObservationGrant, windowId = grant.windowId) => f.call(devicePath, 'POST', {
    grantId: grant.id, windowId, rows: [{ id: 'same-row-id', text: 'independent observation' }],
  }, f.deviceHeaders);
  assert.equal((await submit(first, second.windowId)).status, 404);
  assert.equal((await f.call(devicePath, 'DELETE', { ...scope(second), windowId: first.windowId }, f.deviceHeaders)).status, 404);
  assert.equal((await submit(first)).status, 200);
  assert.equal((await submit(second)).status, 200);
  assert.deepEqual(new Set(f.changes().map(event => event.caseId)), new Set([first.caseId, second.caseId]));

  const extra = { ...f.selection, windowId: 'one-too-many' };
  const rejected = await f.call(ownerPath, 'POST', extra, f.owner);
  assert.equal(rejected.status, 409);
  assert.match(rejected.body, /最多同时观察 5 个/);
  const otherDevice = f.pair('Independent device');
  const independent = await f.start({ ...bindings[0], deviceId: otherDevice.device.id });
  assert.equal((await f.call(devicePath, 'POST', { ...scope(independent), rows: [] }, f.deviceHeaders)).status, 404);

  const replacement = await f.start(bindings[0]);
  assert.notEqual(replacement.id, first.id);
  assert.equal((await submit(first)).status, 409);
  assert.equal((await submit(replacement)).status, 200);
  assert.equal((await submit(second)).status, 200);
  assert.ok(f.changes().every(event => f.runtime.sources.isEventAllowed(event)));

  assert.equal((await f.call(devicePath, 'DELETE', scope(second), f.deviceHeaders)).status, 200);
  await f.start(extra);
  assert.equal((await submit(second)).status, 409);
  assert.equal((await submit(replacement)).status, 200);
  const expiring = grants[2];
  f.runtime.inbox.ingestBatch([], { sourceId: `connector:${expiring.id}`, sourceGeneration: expiring.id, value: { expiresAt: new Date(0).toISOString() } });
  await f.start({ ...extra, windowId: 'after-expiry' });
  const noCapacity = await f.call(`${ownerPath}/${expiring.id}`, 'PATCH', bindings[2], f.owner);
  assert.equal(noCapacity.status, 409);
  assert.match(noCapacity.body, /最多同时观察 5 个/);
  assert.equal((await submit(expiring)).status, 409);
  assert.equal((await submit(replacement)).status, 200);
});

test('saved bindings resume after a normal stop and a durable revocation blocks automatic reauthorization', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-wechat-desktop-resume-'));
  const store = new Store(directory);
  const options = { dataDir: directory, connectorProviders: {} };
  let runtime = await V2Coordinator.create(store, options);
  t.after(async () => { await runtime.close(); store.close(); });
  const { device } = runtime.devices.enroll({ pairingToken: runtime.devices.createPairing().token, name: 'Fixture', platform: 'win32' });
  const topic = await runtime.createCase({ title: 'Topic A', objective: 'Observe A', domain: 'test' });
  const other = await runtime.createCase({ title: 'Topic B', objective: 'Observe B', domain: 'test' });
  const selection = { deviceId: device.id, windowId: 'saved-opaque-id', caseId: topic.id };
  const binding = (grant: WeChatObservationGrant) => ({ grantId: grant.id, windowId: grant.windowId });
  const first = await runtime.weChatObservations.start(selection);
  await runtime.weChatObservations.stopFromDevice(device.id, binding(first));
  await runtime.close();
  runtime = await V2Coordinator.create(store, options);
  await assert.rejects(runtime.weChatObservations.start({ ...selection, caseId: other.id }), /绑定了其他主题/);
  const resumed = await runtime.weChatObservations.start(selection);
  assert.notEqual(resumed.id, first.id);
  await runtime.weChatObservations.ingest(device.id, { ...binding(resumed), rows: [{ id: 'row', text: 'accepted before revocation' }] });
  const event = runtime.inbox.list().find(candidate => candidate.sourceGeneration === resumed.id)!;
  await runtime.weChatObservations.revoke(first.id);
  await assert.rejects(runtime.weChatObservations.ingest(device.id, { ...binding(resumed), rows: [] }), /授权已停止/);
  assert.equal(runtime.sources.isEventAllowed(event), false, 'revoking a saved conversation also closes its historical grant intervals');
  await runtime.close();
  runtime = await V2Coordinator.create(store, options);
  await assert.rejects(runtime.weChatObservations.start(selection), /授权已撤销/);
  await assert.rejects(runtime.weChatObservations.start({ ...selection, caseId: other.id }), /授权已撤销/);
  const readded = await runtime.weChatObservations.start({ ...selection, windowId: 'deliberately-readded' });
  assert.equal(readded.caseId, selection.caseId);
});

test('named WeChat evidence remains attributable and deduplicated across upgrades, stops and grant rotations', async t => {
  const f = await fixture(t);
  const legacy = await f.start();
  const submit = (grant: WeChatObservationGrant, rows: Array<{ id: string; text: string; sentAt?: string; senderName?: string; isSelf?: boolean }>) =>
    f.call(devicePath, 'POST', { grantId: grant.id, windowId: grant.windowId, rows }, f.deviceHeaders);
  await submit(legacy, [{ id: 'old-row', text: '旧客户端已收到的正文' }]);
  const selection = { ...f.selection, title: 'EPAI-产品-研发沟通群', chatType: 'group', analysisIntervalMinutes: 10 };
  const created = await f.call(ownerPath, 'POST', selection, f.owner);
  assert.equal(created.status, 201, created.body);
  const current = JSON.parse(created.body) as WeChatObservationGrant;
  assert.deepEqual(JSON.parse((await submit(current, [{ id: 'old-row', text: '重试不能改写历史' }])).body), { accepted: 0, duplicates: 1 });
  const body = { id: 'new-row', text: '周五完成接口联调', sentAt: '2026-11-06T10:01:00+08:00', senderName: '测试同事', isSelf: false };
  await submit(current, [body]);
  const state = await f.call(`${ownerPath}/${current.id}/status`, 'GET', undefined, f.owner);
  assert.equal(state.status, 200, state.body);
  const status = JSON.parse(state.body);
  assert.equal(status.totalRows, 2);
  assert.equal(status.title, selection.title);
  const known = status.recent.find((row: { senderName: string | null }) => row.senderName === body.senderName);
  const unknown = status.recent.find((row: { sentAt: string | null }) => row.sentAt === null);
  assert.equal(known.sentAt, '2026-11-06T02:01:00.000Z');
  assert.equal(known.isSelf, false);
  assert.equal(unknown.title, selection.title, 'legacy label binds only through the exact existing saved scope');
  assert.equal(unknown.sentAt, null, 'receipt time must not impersonate missing sender time');
  assert.equal((await f.call(`${ownerPath}/${current.id}/status`, 'GET', undefined, f.deviceHeaders)).status, 401);

  const tools = createWeChatTools(f.connectors, f.selection.caseId, () => {});
  const result = await tools.query_wechat_messages.execute!({ conversation: '产品', sender: '同事',
    from: '2026-11-06T00:00:00+08:00', until: '2026-11-06T23:59:59+08:00', limit: 10 }, {} as never) as any;
  assert.equal(result.matched, true); assert.equal(result.events.length, 1);
  assert.equal(result.events[0].content, body.text); assert.equal(result.unknownTimeCount, 1);
  const renamed = await f.call(`${ownerPath}/${current.id}`, 'PATCH', { ...selection, title: '新版研发沟通群' }, f.owner);
  assert.equal(renamed.status, 200, renamed.body);
  const byOldName = await tools.query_wechat_messages.execute!({ conversation: selection.title, limit: 10 }, {} as never) as any;
  assert.equal(byOldName.matched, true); assert.equal(byOldName.title, '新版研发沟通群');
  assert.equal(byOldName.events.find((row: { senderName: string | null }) => row.senderName === body.senderName).title,
    selection.title, 'recorded message title remains the title at capture time');
  const parts = await f.call(devicePath, 'POST', { grantId: current.id, windowId: current.windowId, rows: [
    { id: 'long-message-0', messageId: 'logical-message', text: ' '.repeat(4000), partIndex: 0, partCount: 2, messageType: 'text' },
    { id: 'long-message-1', messageId: 'logical-message', text: '结尾', partIndex: 1, partCount: 2, messageType: 'text' },
  ] }, f.deviceHeaders);
  assert.equal(parts.status, 200, parts.body);
  const count = f.connectors.localWeChatStatus(current.id);
  assert.equal(count.totalRows, 4); assert.equal(count.totalMessages, 3, 'fragments retain one logical message identity');
  const other = await f.runtime.createCase({ title: '隔离主题', objective: 'Keep evidence isolated', domain: 'test' });
  assert.deepEqual(f.connectors.listWeChatConversations(other.id), []);
  assert.throws(() => f.connectors.queryWeChatMessages(other.id, status.conversationId, { limit: 5 }), /当前主题/);
  await f.call(`${ownerPath}/${current.id}`, 'DELETE', undefined, f.owner);
  assert.deepEqual(f.connectors.listWeChatConversations(f.selection.caseId), []);
  assert.ok(f.changes().every(event => !f.runtime.sources.isEventAllowed(event)));
});

test('same-name WeChat scopes require a choice and paginate more than twenty messages without crossing grants', async t => {
  const f = await fixture(t);
  const startNamed = async (windowId: string) => JSON.parse((await f.call(ownerPath, 'POST', {
    ...f.selection, windowId, title: '同名研发群', chatType: 'group',
  }, f.owner)).body) as WeChatObservationGrant;
  const first = await startNamed('first-named');
  const second = await startNamed('second-named');
  for (let start = 0; start < 25; start += 20) {
    const response = await f.call(devicePath, 'POST', { grantId: first.id, windowId: first.windowId,
      rows: Array.from({ length: Math.min(20, 25 - start) }, (_, i) => ({ id: `row-${start + i}`, text: `消息 ${start + i}` })) }, f.deviceHeaders);
    assert.equal(response.status, 200, response.body);
  }
  const tools = createWeChatTools(f.connectors, f.selection.caseId, () => {});
  const ambiguous = await tools.query_wechat_messages.execute!({ conversation: '同名研发群', limit: 20 }, {} as never) as any;
  assert.equal(ambiguous.matched, false); assert.equal(ambiguous.conversations.length, 2);
  const source = f.connectors.localWeChatStatus(first.id);
  const page1 = f.connectors.queryWeChatMessages(first.caseId, source.conversationId, { limit: 20 });
  const page2 = f.connectors.queryWeChatMessages(first.caseId, source.conversationId, { limit: 20, before: page1.nextBefore! });
  assert.equal(page1.events.length, 20); assert.equal(page2.events.length, 5); assert.equal(page2.nextBefore, null);
  assert.equal(new Set([...page1.events, ...page2.events].map(row => row.id)).size, 25);
  const otherSource = f.connectors.localWeChatStatus(second.id);
  assert.throws(() => f.connectors.queryWeChatMessages(second.caseId, otherSource.conversationId,
    { limit: 20, before: page1.nextBefore! }), /不属于当前会话/);
});

test('revoked WeChat source tools are removed from later model turns and rejected inside the active turn', () => {
  const source = 'wechat-conversation';
  const prompt = [
    { role: 'user', content: [{ type: 'text', text: '查询群聊' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'lookup', toolName: 'query_wechat_messages', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'lookup', toolName: 'query_wechat_messages', output: {
      type: 'json', value: { conversationId: source, events: [{ id: 'old-event', content: 'private fixture' }] },
    } }] },
  ];
  const filter = caseSourceContext('case', () => true, () => false);
  assert.throws(() => filter.processLLMRequest({ prompt } as never), /来源已停用/);
  const result = filter.processLLMRequest({ prompt: [...prompt, { role: 'user', content: [{ type: 'text', text: '新问题' }] }] } as never) as any;
  assert.equal(result.prompt.length, 1);
  assert.doesNotMatch(JSON.stringify(result.prompt), /private fixture/);
});
