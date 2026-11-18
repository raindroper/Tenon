import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { ewsConnectInput, ewsCredentials, type EwsConnectInput } from '../shared/ews.js';
import type { ConnectorConnection } from '../shared/connectors.js';
import { createEwsProvider, runEwsNative, type EwsTransport } from '../server/connectors/ews.js';
import { ConnectorProviderError } from '../server/connectors/types.js';
import { ConnectorService } from '../server/connectors/service.js';
import { EventInbox } from '../server/v2/events.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { createApp, exportRuntimeData } from '../server/index.js';

const secret = 'OFFLINE_EWS_PASSWORD_MARKER';
const certSecret = 'OFFLINE_PFX_PASSWORD_MARKER';
const certBytes = Buffer.from('OFFLINE_SYNTHETIC_PFX_MARKER').toString('base64');
const input = (): EwsConnectInput => ({ caseId: 'personal-growth', scope: 'inbox', endpoint: 'https://mail.example.test/EWS/Exchange.asmx',
  username: 'fixture@example.test', password: secret, certificate: { pkcs12Base64: certBytes, password: certSecret },
  observeNewMailAndAnalyze: true, persistCredentials: true });
const folder = { id: 'folder-id', displayName: '收件箱', totalCount: 100, unreadCount: 3 };
const content = 'EWS_BODY_EVIDENCE_' + '有界正文。'.repeat(1500);
const mail = { id: 'new-mail', revision: 'revision-1', subject: 'fixture mail', receivedAt: '2026-11-09T08:00:00Z',
  sender: 'fixture sender', body: content, encryption: 'smime-decrypted', bodyStatus: 'read', truncated: false, totalCharacters: content.length };
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function eventually<T>(read: () => T | undefined, limit = 10_000): Promise<T> {
  const end = Date.now() + limit;
  for (;;) { const value = read(); if (value) return value; assert.ok(Date.now() < end, 'Expected EWS runtime condition'); await delay(15); }
}

test('EWS connection admission requires exact endpoint, explicit persistence and model-analysis consent', async () => {
  assert.equal(ewsConnectInput.parse(input()).scope, 'inbox');
  assert.equal(ewsCredentials.parse({ endpoint: input().endpoint, username: 'fixture', password: ' secret ' }).password, ' secret ');
  for (const patch of [{ observeNewMailAndAnalyze: false }, { persistCredentials: undefined }, { scope: 'sentitems' },
    { endpoint: 'http://mail.example.test/EWS/Exchange.asmx' }, { endpoint: 'https://user:secret@mail.example.test/EWS/Exchange.asmx' },
    { endpoint: 'https://mail.example.test/owa/' }, { endpoint: 'https://mail.example.test/EWS/Exchange.asmx?redirect=other' },
    { endpoint: 'https://mail.example.test\\EWS\\Exchange.asmx' }, { certificate: { pkcs12Base64: 'invalid!', password: '' } },
  ]) assert.equal(ewsConnectInput.safeParse({ ...input(), ...patch }).success, false);
  await assert.rejects(runEwsNative({ operation: 'baseline', credentials: { endpoint: input().endpoint, username: 'fixture', password: secret } }, new AbortController().signal), /离线测试/);
});

test('EWS provider does not replay history, preserves pagination and reports unavailable encrypted bodies honestly', async () => {
  let calls = 0;
  const provider = createEwsProvider(async request => {
    calls++;
    if (request.operation === 'baseline') return folder;
    return { cursor: { ...request.cursor!, syncState: 'next', catchup: false }, more: false,
      changes: [{ ...mail, receivedAt: request.cursor!.since, body: '', bodyStatus: 'decrypt', totalCharacters: 0 }] };
  });
  const token = { accessToken: '', ews: { ...ewsCredentials.parse(inputWithoutConsent()), revision: 1 } };
  const baseline = await provider.scan({ token, scope: 'inbox', signal: new AbortController().signal });
  assert.deepEqual(baseline.changes, []); assert.equal(calls, 1); assert.equal(baseline.more, true);
  const page = await provider.scan({ token, scope: 'inbox', cursor: baseline.cursor, signal: new AbortController().signal });
  assert.match(page.changes[0].content, /尚未读取/); assert.doesNotMatch(page.changes[0].content, /正文已读取/);
  assert.match(page.notice!, /未能读取/);
  const wrong = createEwsProvider(async request => ({ cursor: { ...request.cursor!, folderId: 'different-folder' }, changes: [], more: false }));
  await assert.rejects(wrong.scan({ token, scope: 'inbox', cursor: baseline.cursor, signal: new AbortController().signal }), /原授权/);
});
function inputWithoutConsent() { const { caseId: _case, scope: _scope, observeNewMailAndAnalyze: _observe, persistCredentials: _persist, ...credentials } = input(); return credentials; }

test('HTTP EWS consent -> encrypted credentials -> restart -> new-mail evidence -> existing Rae analysis -> revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-ews-observation-'));
  let store = new Store(directory); let scans = 0; let calls = 0; let observed = false;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    calls++;
    const prompt = JSON.stringify(options.prompt);
    assert.doesNotMatch(prompt, /OFFLINE_EWS_PASSWORD_MARKER|OFFLINE_PFX_PASSWORD_MARKER/);
    assert.ok(!prompt.includes(certBytes));
    assert.ok(options.tools?.some(tool => tool.name === 'read_event'));
    observed = true;
    return { content: [{ type: 'text', text: '已读取新邮件线索，等待本人后续安排。' }], finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
  } });
  const transport: EwsTransport = async request => {
    assert.equal(request.credentials.password, secret); assert.equal(request.credentials.certificate?.password, certSecret);
    if (request.operation === 'baseline') return folder;
    scans++;
    return { cursor: { ...request.cursor!, syncState: 'cursor-' + scans, catchup: false }, more: false,
      changes: [{ ...mail, receivedAt: request.cursor!.since }] };
  };
  let runtime = await V2Coordinator.create(store, { dataDir: directory, ewsTransport: transport, model });
  let app = createApp({ store, runtime });
  const serve = async () => { await new Promise<void>(done => app.listen(0, '127.0.0.1', done)); return 'http://127.0.0.1:' + (app.address() as { port: number }).port; };
  let origin = await serve();
  let connection: ConnectorConnection;
  try {
    const invalid = await fetch(origin + '/api/connectors/ews', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input(), persistCredentials: false }) });
    assert.equal(invalid.status, 400); assert.equal((await runtime.connectorSettings.list()).connections.length, 0);
    const response = await fetch(origin + '/api/connectors/ews', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()) });
    assert.equal(response.status, 201); connection = await response.json() as ConnectorConnection;
    await assert.rejects(runtime.connectorSettings.connectEws(input()), /已有连接/);
    assert.equal((await runtime.connectorSettings.list()).connections.length, 1);
    assert.equal(connection.ews?.hasCertificate, true); assert.equal(connection.ews.credentialRevision, 1);
    const saved = await readFile(join(directory, 'connector-credentials', connection.id + '.json'), 'utf8');
    assert.ok(!saved.includes(secret) && !saved.includes(certSecret) && !saved.includes(certBytes));
    assert.equal(runtime.inbox.list().filter(item => item.kind === 'connector.change').length, 0);
    await new Promise<void>(done => app.close(() => done())); await runtime.close(); store.close();
    store = new Store(directory);
    runtime = await V2Coordinator.create(store, { dataDir: directory, ewsTransport: transport, model });
    app = createApp({ store, runtime }); origin = await serve();
    assert.equal((await runtime.connectorSettings.list()).connections[0].id, connection.id);
    await runtime.connectorSettings.sync(connection.id);
    const event = runtime.inbox.list().find(item => item.kind === 'connector.change')!;
    assert.equal(event.actor, 'external'); assert.equal(event.caseId, input().caseId);
    assert.ok(String(event.payload.content).endsWith(content), 'Long acquired mail remains available to existing read_event pagination');
    await runtime.connectorSettings.sync(connection.id);
    assert.equal(runtime.inbox.list().filter(item => item.kind === 'connector.change').length, 1, 'Same native revision is not delivered twice');
    const exported = JSON.stringify(await exportRuntimeData(store, runtime));
    assert.ok(!exported.includes(secret) && !exported.includes(certSecret) && !exported.includes(certBytes));
    assert.equal(calls, 0, 'Connecting and polling cannot enable inference');
    await store.updateSettings({ enabled: true, maxStepsPerRun: 2 }); runtime.start(); await runtime.request('manual');
    await eventually(() => observed || undefined);
    await eventually(() => runtime.status().state !== 'working' || undefined);
    await runtime.connectorSettings.disconnect(connection.id);
    assert.equal(runtime.sources.isEventAllowed(event), false); assert.ok(runtime.inbox.get(event.id), 'Historical evidence is preserved');
    assert.equal((await readdir(join(directory, 'connector-credentials'))).includes(connection.id + '.json'), false);
  } finally { await new Promise<void>(done => app.close(() => done())); await runtime.close(); store.close(); }
});

test('EWS credential rotation preserves scope and cursor, rejects stale revisions, and failed validation retains old secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-ews-rotation-')); const store = new Store(directory);
  const passwords: string[] = []; let baselineId = folder.id;
  const transport: EwsTransport = async request => {
    passwords.push(request.credentials.password);
    if (request.credentials.password === 'invalid-new-password') throw new ConnectorProviderError('fixture authentication failure', 401);
    return request.operation === 'baseline' ? { ...folder, id: baselineId }
      : { cursor: { ...request.cursor!, syncState: 'preserved-cursor', catchup: false }, changes: [], more: false };
  };
  const runtime = await V2Coordinator.create(store, { dataDir: directory, ewsTransport: transport });
  try {
    const connection = await runtime.connectorSettings.connectEws(input());
    await runtime.connectorSettings.sync(connection.id);
    await assert.rejects(runtime.connectorSettings.updateEws(connection.id, { expectedRevision: 1, password: 'invalid-new-password' }));
    baselineId = 'another-mailbox';
    await assert.rejects(runtime.connectorSettings.updateEws(connection.id, { expectedRevision: 1, password: 'updated-fixture-password' }), /身份已变化/);
    baselineId = folder.id;
    const changed = await runtime.connectorSettings.updateEws(connection.id, { expectedRevision: 1, password: 'updated-fixture-password', certificate: null });
    assert.equal(changed.ews?.credentialRevision, 2); assert.equal(changed.ews.hasCertificate, false);
    assert.equal(changed.ews.observingSince, connection.ews?.observingSince);
    await assert.rejects(runtime.connectorSettings.updateEws(connection.id, { expectedRevision: 1, password: 'stale-password' }), /已变化/);
    await runtime.connectorSettings.sync(connection.id); assert.equal(passwords.at(-1), 'updated-fixture-password');
  } finally { await runtime.close(); store.close(); }
});

test('disconnect drains EWS native work and discards a late mail response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-ews-drain-')); const store = new Store(directory);
  const entered = gate(); const aborted = gate(); const exited = gate();
  const runtime = await V2Coordinator.create(store, { dataDir: directory, ewsTransport: async (request, signal) => {
    if (request.operation === 'baseline') return folder;
    signal.addEventListener('abort', aborted.release, { once: true }); entered.release(); await exited.promise;
    return { cursor: { ...request.cursor!, syncState: 'late', catchup: false }, changes: [{ ...mail, receivedAt: request.cursor!.since }], more: false };
  } });
  try {
    const connection = await runtime.connectorSettings.connectEws(input());
    const reading = runtime.connectorSettings.sync(connection.id); await entered.promise;
    let settled = false; const stopping = runtime.connectorSettings.disconnect(connection.id).then(() => { settled = true; });
    await aborted.promise; await Promise.resolve(); assert.equal(settled, false);
    exited.release(); await reading; await stopping;
    assert.equal(runtime.inbox.list().some(item => item.kind === 'connector.change'), false);
  } finally { await runtime.close(); store.close(); }
});

test('authentication failure suspends automatic EWS retries until explicit owner action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-ews-auth-stop-')); const store = new Store(directory); const inbox = new EventInbox(':memory:');
  let scans = 0; let rejectLogin = true;
  const transport: EwsTransport = async request => {
    if (request.operation === 'baseline') return folder;
    scans++;
    if (rejectLogin) throw new ConnectorProviderError('fixture login rejected', 401);
    return { cursor: { ...request.cursor!, syncState: 'resumed', catchup: false }, changes: [], more: false };
  };
  const service = new ConnectorService(store, inbox, join(directory, 'credentials'), { ews: createEwsProvider(transport) },
    () => true, () => undefined, () => undefined, () => false, transport);
  try {
    const connection = await service.connectEws(input());
    assert.equal((await service.sync(connection.id)).status, 'error');
    const sourceId = 'connector:' + connection.id;
    const checkpoint = inbox.getCheckpoint<Record<string, unknown>>(sourceId, null, connection.id)!;
    assert.equal(checkpoint.needsAttention, true);
    inbox.ingestBatch([], { sourceId, sourceGeneration: connection.id, value: { ...checkpoint, nextAt: 0 } });
    service.tick(); await new Promise<void>(done => setImmediate(done)); assert.equal(scans, 1);
    rejectLogin = false;
    await service.updateEws(connection.id, { expectedRevision: 1, password: 'updated-fixture-password' });
    service.tick(); await service.sync(connection.id);
    assert.equal(scans, 2); assert.equal(service.list().connections[0].status, 'watching');
  } finally { await service.close(); inbox.close(); store.close(); }
});

test('revocation drains an accepted credential update without resurrecting or replacing a removed connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-ews-update-drain-')); const store = new Store(directory);
  const entered = gate(); const aborted = gate(); const exited = gate();
  const runtime = await V2Coordinator.create(store, { dataDir: directory, ewsTransport: async (request, signal) => {
    if (request.credentials.password === 'pending-password') {
      signal.addEventListener('abort', aborted.release, { once: true }); entered.release(); await exited.promise;
    }
    return folder;
  } });
  try {
    const connection = await runtime.connectorSettings.connectEws(input());
    const updating = runtime.connectorSettings.updateEws(connection.id, { expectedRevision: 1, password: 'pending-password' });
    const failed = assert.rejects(updating); await entered.promise;
    let disconnected = false; const stopping = runtime.connectorSettings.disconnect(connection.id).then(() => { disconnected = true; });
    await aborted.promise; await Promise.resolve(); assert.equal(disconnected, false);
    exited.release(); await failed; await stopping;
    assert.equal((await runtime.connectorSettings.list()).connections.length, 0);
    assert.equal((await readdir(join(directory, 'connector-credentials'))).includes(connection.id + '.json'), false);
  } finally { await runtime.close(); store.close(); }
});
