import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModelSelection } from '../shared/model-connections.js';
import type { Run } from '../shared/types.js';
import type { ProjectOperation } from '../shared/local-project.js';
import type { ProjectBroker } from '../server/devices/projects.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { UsageTracker } from '../server/v2/usage.js';
import { forwardProjectModel } from '../server/v2/project-model.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const answer = () => ({ content: [{ type: 'text' as const, text: 'OK' }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const select = (connectionId: string): ModelSelection => ({ connectionId, modelId: 'fixture', reasoning: 'none', maxOutputTokens: null });
async function until(check: () => boolean) { const end = Date.now() + 6000; while (!check()) { assert.ok(Date.now() < end, 'Expected deterministic fixture state'); await delay(5); } }
async function fixture(model: MockLanguageModelV4) {
  const prefix = join(tmpdir(), 'rae-model-lifecycle-'); const directory = await mkdtemp(prefix); const store = new Store(directory);
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  return { store, runtime, async close() {
    await runtime.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); }
    catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
  } };
}

test('stopping one model connection does not wait for another connection test', async () => {
  let release!: () => void; const gate = new Promise<void>(done => { release = done; }); let started = false;
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => { started = true; await gate; return answer(); } }));
  let probe: Promise<unknown> | undefined; let stopped: Promise<unknown> | undefined;
  try {
    const a = f.store.models.upsert({ name: 'A', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://a.invalid/v1' });
    const b = f.store.models.upsert({ name: 'B', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://b.invalid/v1' });
    probe = f.runtime.checkConnection(select(b.id)); await until(() => started);
    let settled = false;
    stopped = f.runtime.modelConnections.save({ id: a.id, expectedRevision: a.editRevision, name: a.name, kind: a.kind, protocol: a.protocol,
      endpoint: a.endpoint, enabled: false }).then(() => { settled = true; });
    await delay(100);
    assert.equal(settled, true, 'B remains behind its gate and must not delay stopping A');
  } finally { release(); await Promise.allSettled([probe, stopped]); await f.close(); }
});

test('a stopped connection test waits for the accepted provider call to drain', async () => {
  let release!: () => void; const gate = new Promise<void>(done => { release = done; }); let started = false; let aborted = false; let drained = false;
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async options => {
    started = true; options.abortSignal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    await gate; drained = true; return answer();
  } }));
  let probe: Promise<unknown> | undefined; let stopped: Promise<unknown> | undefined;
  try {
    const a = f.store.models.upsert({ name: 'A', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://a.invalid/v1' });
    probe = f.runtime.checkConnection(select(a.id)); await until(() => started);
    let settled = false;
    stopped = f.runtime.modelConnections.save({ id: a.id, expectedRevision: a.editRevision, name: a.name, kind: a.kind, protocol: a.protocol,
      endpoint: a.endpoint, enabled: false }).then(() => { settled = true; });
    await until(() => aborted); await delay(50);
    assert.equal(drained, false); assert.equal(settled, false, 'stop must await the accepted local provider operation, not only its abort race');
  } finally { release(); await Promise.allSettled([probe, stopped]); await f.close(); }
});

test('explicit owner retry after API-key repair resolves a new binding without changing original message provenance', async () => {
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => answer() }));
  try {
    let connection = f.store.models.upsert({ name: 'Repairable', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://repair.invalid/v1', apiKey: 'fixture-before-repair' });
    await f.runtime.modelConnections.defaults({ global: select(connection.id), expectedRevision: f.store.models.getDefaults().revision });
    const scene = await f.runtime.createCase({ title: '明确恢复', objective: '修复后显式重试', domain: 'fixture' });
    const accepted = await f.runtime.ingestOwnerMessage('ORIGINAL_OWNER_REQUEST', scene.id);
    const originalMessage = f.store.get('messages', accepted.externalId)!;
    const [claimed] = f.runtime.inbox.claim(1, 60_000, [accepted.id]); f.runtime.inbox.fail(claimed.id, 'fixture credential failure', claimed.leaseToken!);
    connection = await f.runtime.modelConnections.save({ id: connection.id, expectedRevision: connection.editRevision, name: connection.name, kind: connection.kind,
      protocol: connection.protocol, endpoint: connection.endpoint, apiKey: 'fixture-after-repair' });
    assert.notEqual(connection.identityRevision, originalMessage.modelBinding?.identityRevision);
    await f.runtime.retryEvent(accepted.id);
    const delegated = f.runtime.consent.requestOwnerTask({ caseId: scene.id, title: '合成恢复后委托', objective: '检验当前来源回合的绑定',
      expectedOutput: '一份合成结果', capabilities: ['artifact'] }, accepted.id);
    assert.equal(delegated.modelBinding?.identityRevision, connection.identityRevision, 'delegation must inherit the actual retried turn, not the original obsolete binding');
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.runtime.inbox.get(accepted.id)?.status === 'processed');
    const run = f.store.list('runs').find(item => item.eventId === accepted.id)!;
    assert.equal(run.modelBinding?.identityRevision, connection.identityRevision, 'explicit retry must have a usable repaired binding');
    assert.equal(f.store.get('messages', accepted.externalId)?.content, originalMessage.content);
  } finally { await f.close(); }
});

test('Hub auxiliary model activity must not be attributed to the conversation model account', async () => {
  const prefix = join(tmpdir(), 'rae-model-auxiliary-'); const directory = await mkdtemp(prefix); const store = new Store(directory);
  try {
    const connection = store.models.upsert({ name: 'Main account', kind: 'siwc', protocol: 'siwc-responses' });
    const run: Run = { id: 'run', trigger: 'chat', status: 'running', startedAt: new Date().toISOString(), steps: 0, inputTokens: 0, outputTokens: 0,
      modelBinding: store.models.resolve({ purpose: 'conversation', selection: select(connection.id) }) };
    store.insert('runs', run);
    await new UsageTracker(store).trackUnknown(run, new AbortController().signal, async () => 'Hub result');
    assert.equal(store.list('modelCalls').length, 1);
    assert.notEqual(store.list('modelCalls')[0].binding?.selection.connectionId, connection.id,
      'trackUnknown is an external hosted service; the current model binding does not identify its provider');
  } finally { store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
});

test('project Responses rejects an explicitly unconfigured task instead of selecting the new global', async () => {
  const prefix = join(tmpdir(), 'rae-model-null-project-'); const directory = await mkdtemp(prefix); const store = new Store(directory);
  let fetched = 0;
  try {
    store.getApiKey = () => 'fixture-key';
    const run: Run = { id: 'project-run', taskId: 'task', mode: 'execution', trigger: 'manual', status: 'running', startedAt: new Date().toISOString(),
      modelBinding: null, steps: 0, inputTokens: 0, outputTokens: 0, usageStatus: 'not_used', taskExecution: { deadline: null, stepLimit: 2, requirementsRevision: 1 } };
    store.insert('runs', run);
    const operation = { input: { operationId: 'operation', model: { model: store.getSettings().model, maxOutputTokens: null } } } as ProjectOperation;
    const projects = { beginModel() {}, modelText() {}, settleModel() {} } as unknown as ProjectBroker;
    const response = { destroyed: true, writeHead() {}, end() {} } as unknown as ServerResponse;
    await assert.rejects(forwardProjectModel({ store, projects, run, usage: new UsageTracker(store), signal: new AbortController().signal, guard() {}, save() {},
      fetch: async () => { fetched++; return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); },
    }, operation, {} as IncomingMessage, response, { model: store.getSettings().model, input: [] }, 'request'), /项目模型连接/);
    assert.equal(fetched, 0);
  } finally { store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
});
