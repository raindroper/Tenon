import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as flush, setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { createApp, exportRuntimeData } from '../server/index.js';
import { SecretStore } from '../server/secrets.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { ConnectorService } from '../server/connectors/service.js';
import { ConnectorProviderError, type ConnectorProvider, type ScanInput } from '../server/connectors/types.js';
import type { ConnectorConnection, TencentDocsCredential } from '../shared/connectors.js';
import { routeRuntime } from '../server/v2/http.js';
import { EventInbox } from '../server/v2/events.js';

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
const deadline = () => Date.now() + 8000;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function eventually<T>(read: () => T | undefined): Promise<T> {
  const stop = deadline();
  for (;;) {
    const value = read();
    if (value) return value;
    assert.ok(Date.now() < stop, 'expected runtime condition before timeout');
    await delay(20);
  }
}

test('connector OAuth, automatic incremental capture and scoped proposal share the existing runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-connector-runtime-'));
  const store = new Store(directory);
  const scanned = deferred();
  let challenge: string;
  let callback: string;
  let eventId = '';
  let modelCalls = 0;
  const provider: ConnectorProvider = {
    validateScope: scope => scope.toLowerCase(),
    authorize(input) {
      challenge = input.challenge; callback = input.redirectUri;
      return new URL('https://example.invalid/authorize?state=' + input.state);
    },
    async exchange(input) {
      assert.equal(input.redirectUri, callback);
      assert.equal(input.code, 'one-time-code');
      assert.equal(createHash('sha256').update(input.verifier).digest('base64url'), challenge);
      return { accessToken: 'private-connector-credential' };
    },
    async refresh() { throw new Error('Unexpected refresh'); },
    async scan(input) {
      assert.equal(input.scope, 'owner/repository');
      assert.equal(input.token.accessToken, 'private-connector-credential');
      if (input.cursor === undefined) return { cursor: 'baseline', changes: [] };
      assert.equal(input.cursor, 'baseline');
      scanned.resolve();
      return { cursor: 'next', changes: [{ id: 'change', revision: 'v1', title: 'Fixture change', content: 'SCOPED_EVIDENCE' }] };
    },
  };
  const model = new MockLanguageModelV4({ doGenerate: async input => {
    modelCalls++;
    assert.match(JSON.stringify(input.prompt), new RegExp(eventId));
    assert.ok(input.tools?.some(tool => tool.name === 'finish_review'));
    assert.ok(!input.tools?.some(tool => ['propose_task', 'notify_user', 'publish_artifact', 'write_workspace', 'request_task', 'schedule_wake'].includes(tool.name)));
    assert.match(JSON.stringify(input.prompt), /owner.repository/);
    return { content: [{ type: 'tool-call', toolCallId: 'request', toolName: 'finish_review', input: JSON.stringify({
      outcome: 'propose', evidenceIds: [eventId], anchorEventId: eventId,
      ownerRelation: { kind: 'work_dependency', contextKeys: ['owner.repository'], rationale: '本人已明确关注此仓库的变化。' },
      whyOwnerNeedsToKnow: '本批已有本人关注范围中的仓库变更。', materialChange: { kind: 'new', fields: { change: 'SCOPED_EVIDENCE' } },
      situation: { title: '仓库变更', summary: '已有授权的变更记录可供整理。', status: 'ready', unknowns: [], missingInputs: [] },
      proposal: { title: '整理变更', objective: '整理当前仓库的已知变化', expectedOutput: '一份内部整理' },
    }) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage, warnings: [] };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, connectorProviders: { gmail: provider }, model });
  const app = createApp({ store, runtime });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (app.address() as { port: number }).port;
  const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  try {
    const started = await request('/api/connectors/gmail/start', 'POST', { caseId: 'personal-growth', scope: 'Owner/Repository' });
    assert.equal(started.status, 200);
    const { state } = await started.json() as { state: string };
    assert.equal(callback!, base + '/connector-callback/gmail');
    await assert.rejects(runtime.connectorSettings.complete('gmail', state, 'one-time-code', 'https://wrong.example'), /授权已失效/);
    const completed = await request('/api/connectors/gmail/complete', 'POST', { state, code: 'one-time-code' });
    assert.equal(completed.status, 201);
    const connected = await completed.json() as ConnectorConnection;
    assert.equal(connected.scope, 'owner/repository');
    assert.equal((await request('/api/connectors/gmail/complete', 'POST', { state, code: 'one-time-code' })).status, 409);
    const disposable = await runtime.createCase({ title: 'Stopped topic', objective: 'Fixture', domain: 'test' });
    const pending = await runtime.connectorSettings.start('gmail', { caseId: disposable.id, scope: 'owner/repository' }, base);
    await runtime.cancelCase(disposable.id);
    await runtime.updateCase(disposable.id, { status: 'active' });
    await assert.rejects(runtime.connectorSettings.complete('gmail', pending.state, 'one-time-code', base), /授权已失效/);
    assert.doesNotMatch(await (await request('/api/connectors')).text(), /private-connector-credential/);
    const sourceId = 'connector:' + connected.id;
    const saved = runtime.inbox.getCheckpoint<{ cursor: string; nextAt: number }>(sourceId, null, connected.id)!;
    assert.equal(saved.cursor, 'baseline');
    assert.ok(!runtime.inbox.list().some(event => event.sourceId === sourceId));
    runtime.inbox.ingestBatch([], { sourceId, sourceGeneration: connected.id, value: { ...saved, nextAt: 0 } });
    await scanned.promise;
    const evidence = await eventually(() => runtime.inbox.list().find(event => event.sourceId === sourceId && event.status === 'processed'));
    eventId = evidence.id;
    assert.equal(evidence.actor, 'external');
    assert.equal(evidence.caseId, 'personal-growth');
    assert.equal(runtime.sources.resolveEventCase(evidence), 'personal-growth');
    assert.equal(modelCalls, 0);
    assert.doesNotMatch(JSON.stringify(await exportRuntimeData(store, runtime)), /private-connector-credential/);

    await runtime.correctPersonalMemory('owner.repository', { value: '本人关注当前仓库中的产品变化', purpose: 'context' });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 2 });
    runtime.start();
    await runtime.request('manual');
    const task = await eventually(() => runtime.consent.list('personal-growth').find(item => item.state === 'proposed'));
    assert.deepEqual(task.spec.capabilities, ['artifact']);
    assert.equal(task.executionEventId, undefined);
    assert.equal(modelCalls, 1, 'one committed source decision ends the native review without another intake or confirmation call');
    const review = runtime.inbox.list().find(event => event.kind === 'growth.observation' && event.sourceId === sourceId)!;
    assert.equal(runtime.inbox.reviewDecision(review.id)?.input.outcome, 'propose');
    const removed = await request('/api/connectors/' + connected.id, 'DELETE');
    assert.equal(removed.status, 200);
    assert.equal(runtime.sources.isEventAllowed(evidence), false);
    assert.ok(runtime.inbox.get(evidence.id), 'archived observation must be retained');
    await assert.rejects(runtime.approveTask(task.id, task.revision), /观察连接已停用/);
  } finally {
    await new Promise<void>(resolve => app.close(() => resolve()));
    await runtime.close();
    store.close();
    // The isolated test runner removes the fixture once native handles exit.
  }
});

test('Tencent Docs waits thirty minutes between automatic scans and can still sync on demand', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-connector-cadence-'));
  const store = new Store(directory);
  const inbox = new EventInbox(':memory:');
  const start = Date.UTC(2026, 10, 6);
  const minute = 60_000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const reads = { tencent: [] as number[], gmail: [] as number[] };
  let failTencent = false;
  function provider(kind: keyof typeof reads): ConnectorProvider {
    return {
      ...(kind === 'tencent' ? { tokenGrantUrl: 'https://example.invalid/token' } : {}),
      validateScope: scope => scope,
      authorize: () => new URL('https://example.invalid/oauth'),
      async exchange() { return { accessToken: 'fixture' }; },
      async refresh() { throw new Error('Unexpected refresh'); },
      async scan({ cursor }) {
        reads[kind].push(Date.now() - start);
        if (kind === 'tencent' && failTencent) throw new ConnectorProviderError('fixture unavailable');
        return { cursor: cursor ?? 'base', changes: [] };
      },
    };
  }
  const service = new ConnectorService(store, inbox, join(directory, 'credentials'),
    { 'tencent-docs': provider('tencent'), gmail: provider('gmail') }, () => true, () => {}, () => {});
  const tickAt = async (minutes: number, offset = 0) => {
    t.mock.timers.setTime(start + minutes * minute + offset);
    service.tick();
    await flush();
  };
  try {
    const credential = service.saveTencentDocsCredential('fixture');
    const { id } = await service.connectTencentDocument({ caseId: 'topic', scope: 'file', credentialId: credential.id });
    const origin = 'https://rae.example.invalid';
    const { state } = await service.start('gmail', { caseId: 'topic', scope: 'owner/repo' }, origin);
    await service.complete('gmail', state, 'code', origin);

    await tickAt(5);
    assert.deepEqual(reads.gmail, [0, 5 * minute]);
    assert.deepEqual(reads.tencent, [0]);
    await tickAt(7);
    await service.sync(id);
    assert.deepEqual(reads.tencent, [0, 7 * minute]);

    await tickAt(37, -1);
    assert.deepEqual(reads.tencent, [0, 7 * minute], 'the manual scan establishes a new automatic due time');
    failTencent = true;
    await tickAt(37);
    assert.deepEqual(reads.tencent, [0, 7 * minute, 37 * minute]);
    assert.equal(service.list().connections.find(connection => connection.id === id)?.status, 'error');

    failTencent = false;
    await tickAt(67, -1);
    assert.deepEqual(reads.tencent, [0, 7 * minute, 37 * minute], 'a failure does not restore the five-minute cadence');
    await tickAt(67);
    assert.deepEqual(reads.tencent, [0, 7 * minute, 37 * minute, 67 * minute]);
    assert.equal(service.list().connections.find(connection => connection.id === id)?.status, 'watching');
  } finally {
    await service.close();
    inbox.close();
    store.close();
  }
});

test('an existing Tencent Docs checkpoint keeps its cursor and waits thirty minutes after the last attempt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-connector-cadence-upgrade-'));
  const store = new Store(directory);
  const inbox = new EventInbox(':memory:');
  const start = Date.UTC(2026, 10, 6);
  const minute = 60_000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const attemptedCursors: Array<string | undefined> = [];
  const provider: ConnectorProvider = {
    tokenGrantUrl: 'https://example.invalid/token',
    validateScope: scope => scope,
    authorize() { throw new Error('Unexpected OAuth'); },
    async exchange() { throw new Error('Unexpected OAuth'); },
    async refresh() { throw new Error('Unexpected refresh'); },
    async scan({ cursor }) {
      attemptedCursors.push(cursor);
      return { cursor: 'after-scan', changes: [] };
    },
  };
  const open = () => new ConnectorService(store, inbox, join(directory, 'credentials'),
    { 'tencent-docs': provider }, () => true, () => {}, () => {});
  let service = open();
  try {
    const credential = service.saveTencentDocsCredential('fixture');
    const { id } = await service.connectTencentDocument({ caseId: 'topic', scope: 'file', credentialId: credential.id });
    const sourceId = 'connector:' + id;
    // Last success at minute 0, last attempt failed at minute 10 under the old five-minute schedule.
    inbox.ingestBatch([], { sourceId, sourceGeneration: id, value: {
      cursor: 'legacy-cursor', lastSyncedAt: new Date(start).toISOString(), nextAt: start + 15 * minute, error: 'fixture unavailable',
    } });
    await service.close();
    service = open();
    service.recover();
    t.mock.timers.setTime(start + 40 * minute - 1);
    service.tick();
    await flush();
    assert.deepEqual(attemptedCursors, [undefined]);
    assert.equal(service.list().connections[0]?.status, 'error');

    t.mock.timers.setTime(start + 40 * minute);
    service.tick();
    await flush();
    assert.deepEqual(attemptedCursors, [undefined, 'legacy-cursor']);
    assert.equal(service.list().connections[0]?.status, 'watching');
  } finally {
    await service.close();
    inbox.close();
    store.close();
  }
});

test('Tencent Docs saves one credential for independently managed document watches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-tencent-credentials-'));
  const store = new Store(directory);
  const token = 'private-tencent-credential-fixture';
  const started = deferred();
  const release = deferred();
  const reads: string[] = [];
  const previews: string[] = [];
  let firstTitle = 'Document One';
  const summary = (scope: string) => ({
    title: scope === 'doc-one' ? firstTitle : 'Document Two',
    type: 'sheet',
    url: 'https://docs.qq.com/sheet/' + scope,
  });
  const provider: ConnectorProvider = {
    tokenGrantUrl: 'https://example.invalid/token',
    validateScope: scope => scope,
    authorize() { throw new Error('Unexpected OAuth'); },
    async exchange() { throw new Error('Unexpected OAuth'); },
    async refresh() { throw new Error('Unexpected refresh'); },
    async previewDocument({ scope, token: saved }) {
      previews.push(scope);
      assert.equal(saved.accessToken, token);
      return summary(scope);
    },
    async scan({ scope, token: saved }) {
      reads.push(scope);
      assert.equal(saved.accessToken, token);
      if (scope === 'doc-one') {
        started.resolve();
        await release.promise;
      }
      if (scope === 'unreadable') throw new ConnectorProviderError('fixture denied', 403);
      return { cursor: 'baseline:' + scope, changes: [], document: summary(scope) };
    },
  };
  const options = { dataDir: directory, connectorProviders: { 'tencent-docs': provider } };
  let runtime = await V2Coordinator.create(store, options);
  const endpoint = '/api/connectors/tencent-docs';
  const route = (path: string, method: string, body?: unknown) => routeRuntime(runtime, path, method, body);
  const credentialPath = (id: string) => endpoint + '/credentials/' + id;
  try {
    const caseId = 'personal-growth';
    await assert.rejects(route(endpoint + '/credentials', 'POST', { token, scope: 'doc-one' }));
    await assert.rejects(route(endpoint + '/token', 'POST', { token, caseId, scope: 'doc-one' }), { status: 404 });
    const saved = await route(endpoint + '/credentials', 'POST', { token });
    assert.equal(saved.status, 201);
    const credential = saved.body as TencentDocsCredential;
    assert.doesNotMatch(JSON.stringify(credential), /private-tencent-credential-fixture/);
    assert.deepEqual((await route(endpoint + '/credentials', 'POST', { token })).body, credential);
    assert.deepEqual(reads, [], 'saving a credential does not read any document');
    assert.deepEqual((await runtime.connectorSettings.list()).connections, []);

    const selection = { caseId, scope: 'doc-one', credentialId: credential.id };
    await assert.rejects(route(endpoint + '/preview', 'POST', { ...selection, token }));
    const preview = await route(endpoint + '/preview', 'POST', selection);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body, summary('doc-one'));
    assert.doesNotMatch(JSON.stringify(preview.body), /private-tencent-credential-fixture/);
    assert.deepEqual(previews, ['doc-one']);
    assert.deepEqual(reads, [], 'preview reads document metadata without a content scan');
    assert.deepEqual((await runtime.connectorSettings.list()).connections, []);
    assert.ok(!runtime.inbox.list().some(event => event.kind === 'connector.change'));

    await assert.rejects(route(endpoint + '/documents', 'POST', { ...selection, token }));
    await assert.rejects(route(endpoint + '/documents', 'POST', { ...selection, credentialId: randomUUID() }));
    assert.deepEqual(reads, []);
    const pending = route(endpoint + '/documents', 'POST', selection);
    try {
      await started.promise;
      await assert.rejects(route(credentialPath(credential.id), 'DELETE'), { status: 409 });
    } finally { release.resolve(); }
    const first = await pending;
    assert.equal(first.status, 201);
    const firstDocument = first.body as ConnectorConnection;
    assert.deepEqual(firstDocument.document, summary('doc-one'));
    const second = await route(endpoint + '/documents', 'POST', { ...selection, scope: 'doc-two' });
    assert.equal(second.status, 201);
    await assert.rejects(route(endpoint + '/documents', 'POST', { ...selection, scope: 'unreadable' }), { status: 403 });
    const listed = await runtime.connectorSettings.list();
    assert.deepEqual(reads, ['doc-one', 'doc-two', 'unreadable']);
    assert.deepEqual(listed.connections.map(({ scope, credentialId }) => ({ scope, credentialId })),
      ['doc-one', 'doc-two'].map(scope => ({ scope, credentialId: credential.id })));
    assert.deepEqual(listed.connections.map(({ document }) => document), ['doc-one', 'doc-two'].map(summary));
    assert.deepEqual(listed.tencentDocsCredentials, [credential]);
    assert.doesNotMatch(JSON.stringify(listed), /private-tencent-credential-fixture/);
    assert.doesNotMatch(JSON.stringify(await exportRuntimeData(store, runtime)), /private-tencent-credential-fixture/);
    await assert.rejects(route(credentialPath(credential.id), 'DELETE'), { status: 409 });

    firstTitle = 'Renamed Document';
    await route('/api/connectors/' + firstDocument.id + '/sync', 'POST', {});
    await runtime.close();
    runtime = await V2Coordinator.create(store, options);
    assert.deepEqual((await runtime.connectorSettings.list()).connections.find(connection => connection.id === firstDocument.id)?.document,
      summary('doc-one'), 'the latest known document metadata survives restart');
    for (const connection of listed.connections) {
      assert.equal((await route('/api/connectors/' + connection.id, 'DELETE')).status, 200);
    }

    await runtime.close();
    runtime = await V2Coordinator.create(store, options);
    assert.deepEqual((await runtime.connectorSettings.list()).tencentDocsCredentials, [credential]);
    assert.deepEqual((await runtime.connectorSettings.list()).connections, []);
    assert.deepEqual(reads, ['doc-one', 'doc-two', 'unreadable', 'doc-one']);
    const later = await route(endpoint + '/documents', 'POST', { ...selection, scope: 'doc-later' });
    assert.equal(later.status, 201);
    assert.equal(reads.at(-1), 'doc-later');
    await route('/api/connectors/' + (later.body as ConnectorConnection).id, 'DELETE');
    assert.deepEqual((await route(credentialPath(credential.id), 'DELETE')).body, { id: credential.id, removed: true });
    assert.deepEqual((await runtime.connectorSettings.list()).tencentDocsCredentials, []);
  } finally {
    release.resolve();
    await runtime.close();
    store.close();
  }
});

test('Tencent Docs migrates legacy watches without changing their identity, cursor or access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-tencent-credential-migration-'));
  const store = new Store(directory);
  const inbox = new EventInbox(':memory:');
  const credentialDirectory = join(directory, 'credentials');
  const connectedAt = new Date().toISOString();
  const docs = ['first', 'second', 'third'].map((scope, index) => ({
    id: randomUUID(), kind: 'tencent-docs', caseId: 'topic', scope, redirectUri: '', connectedAt,
    accessToken: index === 2 ? 'private-legacy-other' : 'private-legacy-shared',
  }));
  store.setMeta('connectors.v1', docs.map(({ accessToken: _accessToken, ...doc }) => doc));
  for (const doc of docs) {
    new SecretStore(credentialDirectory, doc.id + '.json').set(JSON.stringify({ accessToken: doc.accessToken }));
    inbox.ingestBatch([], {
      sourceId: 'connector:' + doc.id, sourceGeneration: doc.id,
      value: { cursor: 'before:' + doc.scope, lastSyncedAt: connectedAt, nextAt: Date.now() + 300_000 },
    });
  }
  const scans: { scope: string; cursor?: string; accessToken: string }[] = [];
  const provider: ConnectorProvider = {
    tokenGrantUrl: 'https://example.invalid/token',
    validateScope: scope => scope,
    authorize() { throw new Error('Unexpected OAuth'); },
    async exchange() { throw new Error('Unexpected OAuth'); },
    async refresh() { throw new Error('Unexpected refresh'); },
    async scan({ scope, cursor, token }) {
      scans.push({ scope, cursor, accessToken: token.accessToken });
      return { cursor: 'after:' + scope, changes: [] };
    },
  };
  const open = () => new ConnectorService(store, inbox, credentialDirectory,
    { 'tencent-docs': provider }, () => true, () => {}, () => {});
  let service = open();
  try {
    service.recover();
    const after = service.list();
    assert.equal(after.tencentDocsCredentials.length, 2);
    assert.deepEqual(after.connections.map(({ id, scope, lastSyncedAt }) => ({ id, scope, lastSyncedAt })),
      docs.map(({ id, scope }) => ({ id, scope, lastSyncedAt: connectedAt })));
    assert.ok(after.connections.every(connection => connection.credentialId));
    assert.equal(after.connections[0].credentialId, after.connections[1].credentialId);
    assert.notEqual(after.connections[0].credentialId, after.connections[2].credentialId);
    assert.doesNotMatch(JSON.stringify(after), /private-legacy-/);
    const filenames = await readdir(credentialDirectory);
    assert.ok(docs.every(doc => !filenames.includes(doc.id + '.json')), 'migrated per-document secrets must be removed');
    assert.deepEqual(scans, [], 'recovering credentials does not read any document');

    await service.close();
    service = open();
    service.recover();
    assert.deepEqual(service.list(), after, 'migration is idempotent across restart');
    for (const doc of docs) await service.sync(doc.id);
    assert.deepEqual(scans, docs.map(({ scope, accessToken }) => ({ scope, cursor: 'before:' + scope, accessToken })));
  } finally {
    await service.close();
    inbox.close();
    store.close();
  }
});

test('owner chat can read a newly connected Tencent document without crossing topic or disconnect boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-tencent-chat-read-'));
  const store = new Store(directory);
  const token = 'private-tencent-chat-fixture';
  const marker = 'FULL_TENCENT_DOCUMENT_CANARY';
  const reported = 'REPORTED_TENCENT_DOCUMENT_CANARY';
  const row = '| 其他 | 小雨 | ' + marker + ' |';
  const text = '| 业务 | 研发 | 备注 |\n| --- | --- | --- |\n'
    + '| 普通业务 | 普通研发 | Ordinary rows for testing a long document. |\n'.repeat(100)
    + '| 小雨 | 其他 | WRONG_COLUMN_CANARY |\n' + row;
  const rowOffset = text.indexOf(row);
  assert.ok(rowOffset > 3000);
  const scans: string[] = [];
  const reads: string[] = [];
  const document = (scope: string) => ({ title: 'Fixture ' + scope, type: 'sheet', url: 'https://docs.qq.com/sheet/' + scope });
  const provider: ConnectorProvider = {
    tokenGrantUrl: 'https://example.invalid/token',
    validateScope: scope => scope,
    authorize() { throw new Error('Unexpected OAuth'); },
    async exchange() { throw new Error('Unexpected OAuth'); },
    async refresh() { throw new Error('Unexpected refresh'); },
    async scan({ scope, token: saved }) {
      assert.equal(saved.accessToken, token);
      scans.push(scope);
      return { cursor: 'baseline:' + scope, changes: [], document: document(scope) };
    },
    async readDocument({ scope, token: saved, signal }) {
      signal.throwIfAborted();
      assert.equal(saved.accessToken, token);
      reads.push(scope);
      return { document: document(scope), content: scope === 'bound' ? text : 'Independent topic document' };
    },
  };
  let phase: 'no-doc' | 'read' | 'normal-linked' | 'longer-read' | 'other-topic' | 'after-disconnect' = 'no-doc';
  let steps = 0;
  let boundConnection = '';
  const toolCall = (toolName: string, input: unknown) => ({
    content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage, warnings: [],
  });
  const answer = (value: string) => ({
    content: [{ type: 'text' as const, text: value }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [],
  });
  const model = new MockLanguageModelV4({ doGenerate: async input => {
    steps++;
    const prompt = JSON.stringify(input.prompt);
    const latest = JSON.stringify(input.prompt.at(-1));
    assert.doesNotMatch(prompt, /private-tencent-chat-fixture/);
    if (phase === 'no-doc') {
      assert.ok(!input.tools?.some(tool => /connected_document/.test(tool.name)));
      assert.doesNotMatch(prompt, /read_connected_document|list_connected_documents|表格查询用原文/);
      return answer('Ordinary chat reply.');
    }
    if (phase === 'read' || phase === 'longer-read') {
      const finalStep = phase === 'read' ? 3 : 5;
      if (steps === 1) {
        assert.deepEqual(input.tools?.map(tool => tool.name).filter(name => /connected_document/.test(name)), ['read_connected_document']);
        assert.doesNotMatch(prompt, new RegExp(marker));
        return toolCall('read_connected_document', { query: '小雨', column: '研发' });
      }
      assert.match(latest, new RegExp(marker));
      if (steps === 2) {
        assert.match(latest, new RegExp(boundConnection));
        assert.match(latest, /totalMatches[^\d]*1(?!\d)/);
        assert.doesNotMatch(latest, /Ordinary rows|WRONG_COLUMN_CANARY/, 'search only returns matching rows from the selected column');
      }
      if (steps < finalStep) {
        assert.ok(input.tools?.some(tool => tool.name === 'read_connected_document'));
        return toolCall('read_connected_document', { document: boundConnection, offset: rowOffset - (steps - 2), limit: 200 });
      }
      assert.equal(steps, finalStep);
      assert.ok(input.tools?.some(tool => tool.name === 'read_connected_document'));
      return answer('Found in the connected document: ' + reported);
    }
    assert.doesNotMatch(prompt, new RegExp(marker), 'new turns do not replay the raw document result');
    if (phase === 'normal-linked') assert.match(prompt, new RegExp(reported), 'public answers remain available while their source is connected');
    if (phase === 'other-topic' && steps === 1) {
      assert.ok(input.tools?.some(tool => tool.name === 'read_connected_document'));
      return toolCall('read_connected_document', { document: boundConnection, query: '小雨' });
    }
    if (phase === 'after-disconnect') assert.doesNotMatch(prompt, new RegExp(reported));
    return answer('No authorized result for that document.');
  } });
  const options = { dataDir: directory, connectorProviders: { 'tencent-docs': provider }, model };
  let runtime = await V2Coordinator.create(store, options);
  const send = async (message: string, caseId: string) => {
    steps = 0;
    const event = await runtime.ingestOwnerMessage(message, caseId);
    return eventually(() => {
      const settled = runtime.inbox.get(event.id);
      return settled && (settled.status === 'processed' || settled.status === 'failed') ? settled : undefined;
    });
  };
  try {
    const current = await runtime.createCase({ title: 'Bound document topic', objective: 'Review the linked Tencent sheet', domain: 'fixture' });
    const other = await runtime.createCase({ title: 'Independent document topic', objective: 'Review a separate Tencent sheet', domain: 'other' });
    const ordinary = await runtime.createCase({ title: 'Ordinary chat', objective: 'Answer a general question', domain: 'general' });
    const credential = await runtime.connectorSettings.saveTencentDocsCredential(token);
    const add = (caseId: string, scope: string) => runtime.connectorSettings.connectTencentDocument({ caseId, scope, credentialId: credential.id });
    boundConnection = (await add(current.id, 'bound')).id;
    await add(other.id, 'independent');
    assert.deepEqual(scans, ['bound', 'independent']);
    assert.deepEqual(reads, []);
    assert.equal(steps, 0);
    assert.ok(!runtime.inbox.list().some(event => event.kind === 'connector.change'));

    await store.updateSettings({ enabled: true, maxStepsPerRun: 3 });
    runtime.start();
    assert.equal((await send('Please answer a general question.', ordinary.id)).status, 'processed');
    assert.equal(steps, 1);
    assert.deepEqual(reads, []);

    phase = 'read';
    const lookup = await send('请从这份腾讯文档的研发列中查找小雨。', current.id);
    assert.equal(lookup.status, 'processed');
    assert.equal(lookup.attempts, 1);
    assert.equal(steps, 3);
    const replies = store.list('messages').filter(message => message.role === 'assistant' && message.caseId === current.id);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].outputState, 'complete');
    assert.match(replies[0].content, new RegExp(reported));
    assert.deepEqual(reads, ['bound'], 'search and pagination within one reply reuse a single document read');
    assert.deepEqual(scans, ['bound', 'independent'], 'chat reads must not run a connector sync');
    assert.ok(!runtime.inbox.list().some(event => event.kind === 'connector.change'));

    phase = 'normal-linked';
    assert.equal((await send('Please answer another unrelated question.', current.id)).status, 'processed');
    assert.equal(steps, 1);
    assert.deepEqual(reads, ['bound']);

    phase = 'longer-read';
    await store.updateSettings({ maxStepsPerRun: 1 });
    const longerLookup = await send('再从这份腾讯文档核对小雨的记录。', current.id);
    assert.equal(longerLookup.status, 'processed');
    assert.equal(longerLookup.attempts, 1);
    assert.equal(steps, 5, 'owner pagination can finish with a one-step background setting');
    assert.deepEqual(reads, ['bound', 'bound'], 'each owner turn gets one document read');
    assert.deepEqual(scans, ['bound', 'independent']);

    phase = 'other-topic';
    await send('Try the document with connection ID ' + boundConnection + '.', other.id);
    assert.ok(steps > 0);
    assert.deepEqual(reads, ['bound', 'bound'], 'sharing one credential does not allow cross-topic reads');
    await runtime.connectorSettings.disconnect(boundConnection);
    await runtime.close();
    runtime = await V2Coordinator.create(store, options);
    runtime.start();
    phase = 'after-disconnect';
    assert.equal((await send('Continue without the disconnected source.', current.id)).status, 'processed');
    assert.equal(steps, 1);
    assert.deepEqual(reads, ['bound', 'bound']);
  } finally {
    await runtime.close();
    store.close();
  }
});

test('disconnect drains in-flight reads and fences results even when a provider returns after abort', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-connector-drain-'));
  const store = new Store(directory);
  const started = deferred();
  const release = deferred();
  let scan: ScanInput | undefined;
  const provider: ConnectorProvider = {
    tokenGrantUrl: 'https://example.invalid/token',
    validateScope: scope => scope,
    authorize() { throw new Error('Unexpected OAuth'); },
    async exchange() { throw new Error('Unexpected OAuth'); },
    async refresh() { throw new Error('Unexpected refresh'); },
    async scan(input) {
      if (!input.cursor) return { cursor: 'base', changes: [] };
      scan = input;
      started.resolve();
      await release.promise;
      return { cursor: 'late', changes: [{ id: 'late', revision: 'late', title: 'late', content: 'late' }] };
    },
  };
  const options = { dataDir: directory, connectorProviders: { 'tencent-docs': provider } };
  let runtime = await V2Coordinator.create(store, options);
  try {
    const credential = await runtime.connectorSettings.saveTencentDocsCredential('token');
    const { id } = await runtime.connectorSettings.connectTencentDocument({ caseId: 'personal-growth', scope: 'document', credentialId: credential.id });
    await runtime.close();
    runtime = await V2Coordinator.create(store, options);
    assert.equal((await runtime.connectorSettings.list()).connections[0].id, id);
    const sync = runtime.connectorSettings.sync(id);
    await started.promise;
    let settled = false;
    const disconnect = runtime.connectorSettings.disconnect(id).then(result => { settled = true; return result; });
    await eventually(() => scan?.signal.aborted || undefined);
    assert.equal(settled, false);
    await assert.rejects(runtime.connectorSettings.removeTencentDocsCredential(credential.id), { status: 409 });
    release.resolve();
    await Promise.all([sync, disconnect]);
    assert.ok(!runtime.inbox.list().some(event => event.kind === 'connector.change'));
    assert.deepEqual((await runtime.connectorSettings.list()).connections, []);
    assert.deepEqual(await runtime.connectorSettings.removeTencentDocsCredential(credential.id), { id: credential.id, removed: true });
  } finally {
    release.resolve();
    await runtime.close();
    store.close();
  }
});

test('retired Agent WeChat connections are archived, fenced, and keep their protected credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-legacy-wechat-archive-'));
  const store = new Store(directory);
  const inboxFile = join(directory, 'v2-events.sqlite');
  const legacyId = randomUUID();
  const disconnectedId = randomUUID();
  const githubId = randomUUID();
  const caseId = 'personal-growth';
  const occurredAt = new Date().toISOString();
  const sourceId = `connector:${legacyId}`;
  const scope = JSON.stringify({ accountId: 'fixture-account', threadIds: ['fixture-chat'] });
  const checkpoint = { cursor: 'legacy-cursor', lastSyncedAt: occurredAt, nextAt: 0 };
  const legacy = { id: legacyId, kind: 'agent-wechat', caseId, scope, connectedAt: occurredAt, redirectUri: '' };
  const github = { id: githubId, kind: 'github', caseId, scope: 'owner/repo', connectedAt: occurredAt, redirectUri: '' };
  store.setMeta('connectors.v1', [legacy, github]);
  const credential = new SecretStore(join(directory, 'connector-credentials'), `${legacyId}.json`);
  const saved = JSON.stringify({ accessToken: 'archived-fixture-credential', agentWeChatGrantId: 'archived-fixture-grant' });
  credential.set(saved);

  const oldInbox = new EventInbox(inboxFile);
  const change = (id: string, externalId: string, provider: string) => ({ sourceId: `connector:${id}`, sourceGeneration: id,
    caseId, externalId, kind: 'connector.change', operation: 'update' as const, actor: 'external' as const, occurredAt,
    payload: { provider, content: externalId } });
  const first = oldInbox.ingestBatch([change(legacyId, 'historical text', 'agent-wechat')], { sourceId, sourceGeneration: legacyId, value: checkpoint }).events[0];
  oldInbox.captureObservations(() => true);
  const review = oldInbox.releaseObservation(() => true, Date.now(), true)!;
  assert.equal(oldInbox.claim(1, 60_000, [review.id])[0]?.id, review.id);
  const removed = oldInbox.ingest(change(disconnectedId, 'previously disconnected text', 'agent-wechat')).event;
  oldInbox.captureObservations(() => true);
  assert.ok(oldInbox.nextObservationAt());
  const pending = oldInbox.ingest(change(legacyId, 'queued text', 'agent-wechat')).event;
  const other = oldInbox.ingest(change(githubId, 'unrelated provider text', 'github')).event;
  oldInbox.close();

  const options = { dataDir: directory, connectorProviders: {} };
  let runtime = await V2Coordinator.create(store, options);
  try {
    const directoryView = await runtime.connectorSettings.list();
    assert.ok(directoryView.providers.every(provider => String(provider.kind) !== 'agent-wechat'));
    assert.deepEqual(directoryView.connections.map(connection => connection.id), [githubId]);
    assert.deepEqual(store.getMeta('connectors.v1', []), [github]);
    assert.equal(credential.get(), saved);
    assert.deepEqual(runtime.inbox.getCheckpoint(sourceId, null, legacyId), checkpoint);
    assert.equal(runtime.inbox.nextObservationAt(), null);
    for (const event of [first, review, removed, pending]) {
      assert.equal(runtime.inbox.get(event.id)?.status, 'processed');
      assert.equal(runtime.sources.isEventAllowed(event), false);
    }
    assert.equal(runtime.inbox.get(other.id)?.status, 'pending');
    for (const [path, method] of [['qr', 'GET'], ['discover', 'POST'], ['token', 'POST']]) {
      await assert.rejects(routeRuntime(runtime, `/api/connectors/agent-wechat/${path}`, method, {}), { status: 404 });
    }
    await assert.rejects(async () => runtime.connectorSettings.sync(legacyId), { status: 404 });
    const archive = (await exportRuntimeData(store, runtime)).archive.agentWeChat;
    assert.deepEqual(archive?.connections, [{ id: legacyId, kind: 'agent-wechat', caseId, scope, connectedAt: occurredAt, lastSyncedAt: occurredAt }]);
    assert.deepEqual(archive?.events.map(event => event.id), [first.id, review.id, removed.id, pending.id]);
    assert.match(JSON.stringify(archive), /historical text/);
    assert.doesNotMatch(JSON.stringify(archive), /archived-fixture-credential|archived-fixture-grant|unrelated provider text/);

    await runtime.close();
    runtime = await V2Coordinator.create(store, options);
    assert.deepEqual(await runtime.exportRetiredAgentWeChat(), archive);
    assert.equal(credential.get(), saved);
  } finally {
    await runtime.close();
    store.close();
  }
});
