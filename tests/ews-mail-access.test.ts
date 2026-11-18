import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { EventInbox } from '../server/v2/events.js';
import { ConnectorService } from '../server/connectors/service.js';
import { createEwsProvider, type EwsNativeRequest, type EwsTransport } from '../server/connectors/ews.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { createApp } from '../server/index.js';
import type { EwsConnectInput, EwsMessagePage, EwsMessageReadPage } from '../shared/ews.js';

const password = 'OFFLINE_MAIL_ACCESS_PASSWORD';
const pfxPassword = 'OFFLINE_MAIL_ACCESS_PFX_PASSWORD';
const pfxBytes = Buffer.from('OFFLINE_MAIL_ACCESS_PFX_BYTES').toString('base64');
const body = 'Historical encrypted-body fixture. '.repeat(240);
const folder = { id: 'authorized-inbox', displayName: 'Fixture Inbox', totalCount: 10, unreadCount: 2 };
const historical = { id: 'old/mail+==', revision: 'old-revision', subject: 'Historical fixture subject',
  receivedAt: '2020-01-01T00:00:00Z', sender: 'Fixture sender', encryptionHint: 'smime', isRead: false };
const mail = { id: historical.id, revision: historical.revision, subject: historical.subject, receivedAt: historical.receivedAt,
  sender: historical.sender, body, encryption: 'smime-decrypted', bodyStatus: 'read', truncated: false, totalCharacters: body.length };
function input(caseId = 'case-one'): EwsConnectInput {
  return { caseId, scope: 'inbox', endpoint: 'https://mail.example.test/EWS/Exchange.asmx', username: 'fixture@example.test',
    password, certificate: { pkcs12Base64: pfxBytes, password: pfxPassword }, observeNewMailAndAnalyze: true, persistCredentials: true };
}
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
function nativeFixture() {
  const requests: EwsNativeRequest[] = [];
  let waitOperation: 'query' | 'read' | undefined; let waitEntered = gate(); let waitAborted = gate(); let waitExited = gate();
  const transport: EwsTransport = async (request, signal) => {
    requests.push(request);
    assert.ok(request.credentials.password.startsWith('OFFLINE_'));
    if (request.operation === waitOperation) {
      signal.addEventListener('abort', waitAborted.release, { once: true }); waitEntered.release(); await waitExited.promise;
    }
    if (request.operation === 'baseline') return folder;
    if (request.operation === 'query') return { messages: [historical], nextOffset: null, totalItems: 1 };
    if (request.operation === 'read') return mail;
    return { cursor: { ...request.cursor!, syncState: 'passive-next', catchup: false }, changes: [], more: false };
  };
  return { transport, requests, hold(operation: 'query' | 'read') {
    waitOperation = operation; waitEntered = gate(); waitAborted = gate(); waitExited = gate();
    return { entered: waitEntered.promise, aborted: waitAborted.promise, release: waitExited.release };
  } };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-access-'));
  const store = new Store(directory); const inbox = new EventInbox(':memory:'); const native = nativeFixture(); let changes = 0;
  const service = new ConnectorService(store, inbox, join(directory, 'credentials'), { ews: createEwsProvider(native.transport) },
    id => id === 'case-one' || id === 'case-two', () => undefined, () => { changes++; }, () => false, native.transport);
  const connection = await service.connectEws(input());
  function checkpoint() { return structuredClone(inbox.getCheckpoint<Record<string, unknown>>('connector:' + connection.id, null, connection.id)); }
  function owner(options: { caseId?: string; actor?: 'owner' | 'external'; role?: 'user' | 'assistant'; contentMismatch?: boolean; lease?: boolean } = {}) {
    const id = randomUUID(); const caseId = options.caseId ?? 'case-one'; const content = 'Please list the existing inbox and read the selected mail.';
    store.insert('messages', { id, role: options.role ?? 'user', caseId, content, createdAt: new Date().toISOString() });
    const event = inbox.ingest({ sourceId: 'owner-chat', externalId: id, kind: 'owner.message', actor: options.actor ?? 'owner',
      caseId, operation: 'create', occurredAt: new Date().toISOString(), payload: { messageId: id, content: options.contentMismatch ? 'different event content' : content } }).event;
    return options.lease === false ? event : inbox.claim(1, 60_000, [event.id])[0];
  }
  return { directory, store, inbox, native, service, connection, checkpoint, owner, changes: () => changes,
    async close() { await service.close(); inbox.close(); store.close(); } };
}
function assertNoCredentials(value: unknown) {
  const text = JSON.stringify(value); assert.ok(!text.includes(password) && !text.includes(pfxPassword) && !text.includes(pfxBytes));
}

test('owner UI HTTP query and read require explicit existing-inbox consent and work before passive baseline completes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-access-http-')); const store = new Store(directory); const native = nativeFixture();
  const runtime = await V2Coordinator.create(store, { dataDir: directory, ewsTransport: native.transport });
  const app = createApp({ store, runtime }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + (app.address() as { port: number }).port;
  const post = (path: string, data: unknown) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const connection = await runtime.connectorSettings.connectEws(input('personal-growth'));
    assert.equal(connection.ews?.establishingBaseline, true);
    const before = structuredClone(runtime.inbox.getCheckpoint('connector:' + connection.id, null, connection.id));
    const path = '/api/connectors/ews/' + connection.id;
    assert.equal((await post(path + '/messages', {})).status, 400);
    assert.equal(native.requests.filter(item => item.operation === 'query').length, 0);
    const response = await post(path + '/messages', { readExistingInbox: true, subject: 'Historical' });
    assert.equal(response.status, 200); const page = await response.json() as EwsMessagePage;
    assert.equal(page.messages[0].receivedAt, historical.receivedAt);
    assert.equal((await post(path + '/message', { messageId: historical.id, queryId: page.queryId })).status, 400);
    assert.equal(native.requests.filter(item => item.operation === 'read').length, 0);
    const read = await post(path + '/message', { readExistingInbox: true, messageId: historical.id, queryId: page.queryId });
    assert.equal(read.status, 200); const first = await read.json() as EwsMessageReadPage;
    assert.equal(first.content, body.slice(0, 4000)); assert.equal(first.nextOffset, 4000);
    const rest = await (await post(path + '/message', { readExistingInbox: true, messageId: historical.id, queryId: page.queryId, offset: first.nextOffset })).json() as EwsMessageReadPage;
    assert.equal(rest.content, body.slice(4000, 8000));
    const last = await (await post(path + '/message', { readExistingInbox: true, messageId: historical.id, queryId: page.queryId, offset: rest.nextOffset })).json() as EwsMessageReadPage;
    assert.equal(last.content, body.slice(8000)); assert.equal(last.nextOffset, null);
    assert.equal(first.content + rest.content + last.content, body);
    assert.equal(native.requests.filter(item => item.operation === 'read').length, 1);
    assert.deepEqual(runtime.inbox.getCheckpoint('connector:' + connection.id, null, connection.id), before);
    assertNoCredentials({ page, first, rest, last, directory: await runtime.connectorSettings.list() });
    const access = runtime.inbox.list().filter(item => item.kind === 'owner.mail_access');
    assert.deepEqual(access.map(item => [item.actor, item.sourceId, item.status]), [['owner', 'owner-ui', 'processed'], ['owner', 'owner-ui', 'processed']]);
    const receipts = runtime.inbox.list().filter(item => ['connector.mail_query', 'connector.mail_read'].includes(item.kind));
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) { assert.equal(receipt.actor, 'external'); assert.equal(receipt.status, 'processed'); assert.equal(runtime.sources.isEventAllowed(receipt), true); }
    assertNoCredentials(runtime.inbox.list());
    assert.equal(store.list('runs').length, 0, 'Direct inspection does not create another model run');
    assert.equal(store.getSettings().enabled, false);
  } finally { await new Promise<void>(done => app.close(() => done())); await runtime.close(); store.close(); }
});

test('current-owner access binds exact stored user message, case and active lease, with processed provenance receipts', async () => {
  const f = await fixture(); const controller = new AbortController();
  try {
    for (const options of [{ actor: 'external' as const }, { role: 'assistant' as const }, { caseId: 'case-two' }, { contentMismatch: true }, { lease: false }]) {
      const source = f.owner(options);
      await assert.rejects(async () => f.service.queryEwsMessagesForEvent('case-one', source.id, { connectionId: f.connection.id }, controller.signal), /当前明确的请求/);
    }
    const processed = f.owner(); f.inbox.ack(processed.id, processed.leaseToken!);
    await assert.rejects(async () => f.service.queryEwsMessagesForEvent('case-one', processed.id, { connectionId: f.connection.id }, controller.signal), /当前明确的请求/);
    assert.equal(f.native.requests.filter(item => item.operation === 'query').length, 0);
    const current = f.owner(); const before = f.checkpoint();
    const otherMailbox = await f.service.connectEws(input('case-two'));
    await assert.rejects(async () => f.service.queryEwsMessagesForEvent('case-one', current.id, { connectionId: otherMailbox.id }, controller.signal), /没有这份 EWS/);
    const page = await f.service.queryEwsMessagesForEvent('case-one', current.id, { connectionId: f.connection.id, subject: 'Historical' }, controller.signal);
    await assert.rejects(async () => f.service.readEwsMessage(f.connection.id,
      { readExistingInbox: true, queryId: page.queryId, messageId: historical.id, offset: 0, limit: 4000 }), /重新查询/);
    const result = await f.service.readEwsMessageForEvent('case-one', current.id, { connectionId: f.connection.id, queryId: page.queryId, messageId: historical.id }, controller.signal);
    assert.equal(result.encryption, 'smime-decrypted'); assert.equal(result.content, body.slice(0, 4000)); assert.deepEqual(f.checkpoint(), before);
    assert.equal(f.changes(), 0, 'Manual historical reads do not enter passive observation scheduling');
    const audits = f.inbox.list().filter(item => item.kind === 'owner.mail_access');
    assert.equal(audits.length, 2); assert.ok(audits.every(item => item.status === 'processed' && item.actor === 'owner' && item.causationId === current.id));
    const receipt = f.inbox.get(page.queryId)!; assert.equal(receipt.payload.ownerEventId, current.id); assert.equal(receipt.payload.accessSource, 'owner-chat');
    assertNoCredentials(f.inbox.list());
    const otherOwner = f.owner();
    await assert.rejects(async () => f.service.readEwsMessageForEvent('case-one', otherOwner.id, { connectionId: f.connection.id, queryId: page.queryId, messageId: historical.id }, controller.signal), /重新查询/);
  } finally { await f.close(); }
});

test('authorized pre-proposal research reads the inbox with agent provenance and cannot borrow owner sending context', async () => {
  const f = await fixture(); const signal = new AbortController().signal;
  try {
    let authorized = true;
    const review = f.inbox.ingest({ sourceId: 'upload:research', externalId: 'research', caseId: 'case-one', kind: 'growth.observation',
      actor: 'system', operation: 'create', occurredAt: new Date().toISOString(), payload: { eventIds: ['fixture-evidence'] } }).event;
    f.service.setResearchSourceGuard(event => event.id === review.id && authorized);
    await assert.rejects(async () => f.service.queryEwsMessagesForEvent('case-one', review.id, { connectionId: f.connection.id }, signal), /当前明确的请求|资料回顾/);
    f.inbox.claim(1, 60000, [review.id]);
    const page = await f.service.queryEwsMessagesForEvent('case-one', review.id, { connectionId: f.connection.id, subject: 'Historical' }, signal);
    const result = await f.service.readEwsMessageForEvent('case-one', review.id,
      { connectionId: f.connection.id, queryId: page.queryId, messageId: historical.id }, signal);
    assert.equal(result.content, body.slice(0, 4000));
    const research = f.inbox.list().filter(event => event.kind === 'connector.research_access');
    assert.equal(research.length, 2); assert.ok(research.every(event => event.actor === 'agent' && event.causationId === review.id));
    assert.equal(f.inbox.list().filter(event => event.kind === 'owner.mail_access').length, 0);
    const owner = f.owner();
    assert.throws(() => f.service.getEwsMessageContextForOwner('case-one', review.id,
      { connectionId: f.connection.id, queryId: page.queryId, messageId: historical.id }, signal), /当前明确的请求/);
    await assert.rejects(async () => f.service.readEwsMessageForEvent('case-one', owner.id,
      { connectionId: f.connection.id, queryId: page.queryId, messageId: historical.id }, signal), /重新查询/);
    authorized = false;
    await assert.rejects(async () => f.service.readEwsMessageForEvent('case-one', review.id,
      { connectionId: f.connection.id, queryId: page.queryId, messageId: historical.id }, signal), /当前明确的请求|资料回顾/);
    assert.equal(f.native.requests.filter(request => request.operation === 'read').length, 1);
    assertNoCredentials(research);
  } finally { await f.close(); }
});

test('UI query receipts reject forged, cross-connection, cross-channel and stale-revision IDs before native reading', async () => {
  const f = await fixture();
  try {
    const page = await f.service.queryEwsMessages(f.connection.id, { readExistingInbox: true, offset: 0, limit: 25 });
    const selected = { readExistingInbox: true as const, messageId: historical.id, queryId: page.queryId, offset: 0, limit: 4000 };
    await assert.rejects(async () => f.service.readEwsMessage(f.connection.id, { ...selected, queryId: randomUUID() }), /重新查询/);
    await assert.rejects(async () => f.service.readEwsMessage(f.connection.id, { ...selected, messageId: 'outside-mail' }), /重新查询/);
    const second = await f.service.connectEws(input('case-two'));
    await assert.rejects(async () => f.service.readEwsMessage(second.id, selected), /重新查询/);
    const source = f.owner();
    await assert.rejects(async () => f.service.readEwsMessageForEvent('case-one', source.id, { connectionId: f.connection.id, queryId: page.queryId, messageId: historical.id }, new AbortController().signal), /重新查询/);
    await f.service.updateEws(f.connection.id, { expectedRevision: 1, password: 'OFFLINE_UPDATED_MAIL_ACCESS_PASSWORD' });
    await assert.rejects(async () => f.service.readEwsMessage(f.connection.id, selected), /重新查询/);
    assert.equal(f.native.requests.filter(item => item.operation === 'read').length, 0);
  } finally { await f.close(); }
});

test('expired query receipts cannot return either new reads or already cached plaintext', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const page = await f.service.queryEwsMessages(f.connection.id, { readExistingInbox: true, offset: 0, limit: 25 });
    const selected = { readExistingInbox: true as const, messageId: historical.id, queryId: page.queryId, offset: 0, limit: 4000 };
    await f.service.readEwsMessage(f.connection.id, selected);
    t.mock.timers.tick(16 * 60_000);
    await assert.rejects(async () => f.service.readEwsMessage(f.connection.id, { ...selected, offset: 4000 }), /重新查询/);
    assert.equal(f.native.requests.filter(item => item.operation === 'read').length, 1);
  } finally { await f.close(); }
});

test('concurrent body pages for one query receipt share a single accepted native read', async () => {
  const f = await fixture(); const paused = f.native.hold('read');
  try {
    const page = await f.service.queryEwsMessages(f.connection.id, { readExistingInbox: true, offset: 0, limit: 25 });
    const selected = { readExistingInbox: true as const, messageId: historical.id, queryId: page.queryId, offset: 0, limit: 4000 };
    const first = f.service.readEwsMessage(f.connection.id, selected);
    const second = f.service.readEwsMessage(f.connection.id, { ...selected, offset: 4000 });
    await paused.entered; await new Promise<void>(done => setImmediate(done));
    const nativeReadsBeforeCompletion = f.native.requests.filter(item => item.operation === 'read').length;
    paused.release();
    const pages = await Promise.all([first, second]);
    assert.equal(pages[0].content, body.slice(0, 4000)); assert.equal(pages[1].content, body.slice(4000, 8000));
    assert.equal(nativeReadsBeforeCompletion, 1, 'A second page must join the accepted message read before its receipt exists');
    assert.equal(f.inbox.list().filter(item => item.kind === 'connector.mail_read').length, 1);
    assert.equal(f.inbox.list().filter(item => item.kind === 'owner.mail_access' && item.payload.operation === 'read').length, 1);
  } finally { paused.release(); await f.close(); }
});

test('an expired leased owner event is not a current request', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const source = f.owner(); t.mock.timers.tick(61_000);
    await assert.rejects(async () => f.service.queryEwsMessagesForEvent('case-one', source.id, { connectionId: f.connection.id }, new AbortController().signal), /当前明确的请求/);
    assert.equal(f.native.requests.filter(item => item.operation === 'query').length, 0);
  } finally { await f.close(); }
});

test('disconnect drains an accepted historical query and discards its late result', async () => {
  const f = await fixture(); const paused = f.native.hold('query');
  try {
    const reading = f.service.queryEwsMessages(f.connection.id, { readExistingInbox: true, offset: 0, limit: 25 }); const rejected = assert.rejects(reading);
    await paused.entered;
    let stopped = false; const stopping = f.service.disconnect(f.connection.id, async () => undefined).then(() => { stopped = true; });
    await paused.aborted; await Promise.resolve(); assert.equal(stopped, false);
    paused.release(); await rejected; await stopping;
    assert.equal(f.inbox.list().some(item => item.kind === 'connector.mail_query'), false);
  } finally { paused.release(); await f.close(); }
});

test('credential rotation drains a body read, discards plaintext and invalidates its original query receipt', async () => {
  const f = await fixture(); const paused = f.native.hold('read');
  try {
    const page = await f.service.queryEwsMessages(f.connection.id, { readExistingInbox: true, offset: 0, limit: 25 });
    const selected = { readExistingInbox: true as const, queryId: page.queryId, messageId: historical.id, offset: 0, limit: 4000 };
    const reading = f.service.readEwsMessage(f.connection.id, selected); const rejected = assert.rejects(reading);
    await paused.entered; let updated = false;
    const rotating = f.service.updateEws(f.connection.id, { expectedRevision: 1, password: 'OFFLINE_ROTATED_MAIL_ACCESS_PASSWORD' }).then(() => { updated = true; });
    await paused.aborted; await Promise.resolve(); assert.equal(updated, false);
    paused.release(); await rejected; await rotating;
    assert.equal(f.inbox.list().some(item => item.kind === 'connector.mail_read'), false);
    await assert.rejects(async () => f.service.readEwsMessage(f.connection.id, selected), /重新查询/);
  } finally { paused.release(); await f.close(); }
});
