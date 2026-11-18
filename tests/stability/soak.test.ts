import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { MockEmbeddingModelV4 } from 'ai/test';
import { createClient } from '@libsql/client';
import { LibSQLVector } from '@mastra/libsql';
import type { RuntimeView, RuntimeViewDelta } from '../../shared/runtime-view.js';
import type { Message } from '../../shared/types.js';
import { Store } from '../../server/store.js';
import { V2Coordinator } from '../../server/v2/coordinator.js';
import { createApp } from '../../server/index.js';
import { MockLanguageModelV4 } from '../support/model.js';

// Kept outside tests/*.test.ts: this is an explicit bounded endurance gate,
// not a several-minute tax on every focused regression or routine release.
const durationMs = Number(process.env.RAE_STABILITY_DURATION_MS ?? 180_000);
if (!Number.isInteger(durationMs) || durationMs < 3000 || durationMs > 900_000) throw new Error('Stability duration must be 3000–900000ms');
const initialEvents = 10_000, initialRuns = 2000;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
type ModelOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type ModelRole = 'actor' | 'observer' | 'reflector';
function modelRole(prompt: ModelOptions['prompt']): ModelRole {
  const system = prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
  if (system.includes('Your memory observation reflections')) return 'reflector';
  return system.includes('Your observations will be the ONLY information') ? 'observer' : 'actor';
}

async function until(check: () => boolean, message: string) {
  const deadline = performance.now() + 10_000;
  while (!check()) { if (performance.now() > deadline) throw new Error(message); await delay(10); }
}

async function observe(base: string, caseId: string, slow: boolean) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/state/stream?delta=1&caseId=${caseId}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  let latest: RuntimeView | undefined, revision = '', buffer = '', frames = 0, failure: unknown;
  let first!: () => void; const ready = new Promise<void>(done => { first = done; });
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      while (buffer.includes('\n\n')) {
        const end = buffer.indexOf('\n\n'), source = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = source.match(/^event: (.+)$/m)?.[1], data = source.match(/^data: (.+)$/m)?.[1];
        if (!data || !event) continue;
        if (event === 'state') latest = JSON.parse(data) as RuntimeView;
        else if (event === 'state-delta') {
          const delta = JSON.parse(data) as RuntimeViewDelta;
          assert.equal(delta.base, revision, 'SSE deltas must always match the last delivered version');
          assert.ok(latest); latest = { ...latest, ...delta.replace };
          for (const key of delta.remove ?? []) delete latest[key];
        } else continue;
        revision = source.match(/^id: (.+)$/m)?.[1] ?? '';
        assert.ok(latest.messages.every(message => message.caseId === caseId));
        assert.ok(latest.messages.length <= 40 && latest.events.length <= 80 && latest.runs.length <= 80);
        frames++; first();
      }
      if (slow) await delay(150, undefined, { signal: controller.signal });
    }
  })().catch(error => { if (!controller.signal.aborted) failure = error; first(); });
  await Promise.race([ready, delay(10_000, undefined, { signal: controller.signal }).then(() => { throw new Error('SSE initial state timed out'); })]);
  if (failure) throw failure;
  return { get frames() { return frames; }, check() { if (failure) throw failure; assert.ok(latest); }, async close() { controller.abort(); await reading; if (failure) throw failure; } };
}

test('offline fixture checks a native vector index using the database engine that owns it', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-soak-vector-check-'));
  const path = join(directory, 'vector.sqlite'); const url = `file:${path.replaceAll('\\', '/')}`;
  const vector = new LibSQLVector({ id: 'soak-vector-check', url });
  const embedding = Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
  try {
    await vector.createIndex({ indexName: 'fixture_vectors', dimension: 512 });
    await vector.upsert({ indexName: 'fixture_vectors', ids: ['fixture-vector'], vectors: [embedding], metadata: [{ fixture: true }] });
    assert.equal((await vector.describeIndex({ indexName: 'fixture_vectors' })).count, 1);
    assert.equal((await vector.query({ indexName: 'fixture_vectors', queryVector: embedding, topK: 1 }))[0]?.id, 'fixture-vector');
  } finally { await vector.close(); }
  const ordinary = new DatabaseSync(path, { readOnly: true }); let ordinaryResult: unknown;
  try { ordinaryResult = ordinary.prepare('PRAGMA quick_check').all().map(row => row.quick_check); } finally { ordinary.close(); }
  const native = createClient({ url });
  try {
    const nativeResult = (await native.execute('PRAGMA quick_check')).rows.map(row => row.quick_check);
    context.diagnostic(JSON.stringify({ vectorIntegrity: { ordinary: ordinaryResult, native: nativeResult } }));
    assert.deepEqual(nativeResult, ['ok']);
  } finally { native.close(); }
});

test('bounded offline endurance: concurrent idempotent writes, SSE reconnects, restarts, complete export and integrity', { timeout: durationMs + 120_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-stability-soak-'));
  let store = new Store(directory); store.getApiKey = () => undefined;
  let calls = 0, embeddingCalls = 0;
  const roleCalls: Record<ModelRole, number> = { actor: 0, observer: 0, reflector: 0 };
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const role = modelRole(options.prompt); calls++; roleCalls[role]++;
    const latestRequest = JSON.stringify(options.prompt).match(/Synthetic request \d+/g)?.at(-1) ?? 'Synthetic requests';
    const text = role === 'actor' ? 'OFFLINE_ENDURANCE_REPLY' : role === 'observer'
      ? `<observations>\n* 🟡 The owner sent ${latestRequest} as part of this offline endurance fixture.\n</observations>`
      : '<observations>\n* 🟡 The owner sends numbered synthetic requests in this offline endurance fixture.\n</observations>';
    return { content: [{ type: 'text', text }], usage, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } };
  } });
  // Exercise the normal OM thresholds and indexing without reading an installed
  // native model or making an embedding request outside the offline fixture.
  const embedder = new MockEmbeddingModelV4({ doEmbed: async ({ values }) => {
    embeddingCalls++;
    return { embeddings: values.map(() => Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0)), warnings: [] };
  } });
  const inspectFailures = (engine: V2Coordinator) => {
    const runCase = engine.memory.runCase.bind(engine.memory);
    engine.memory.runCase = async input => {
      try { return await runCase(input); }
      catch (error) {
        const chain: { name: string; message: string }[] = [];
        let cause: unknown = error;
        for (let depth = 0; depth < 4 && cause instanceof Error; depth++, cause = cause.cause) chain.push({ name: cause.name, message: cause.message.slice(0, 240) });
        context.diagnostic(JSON.stringify({ fixtureFailure: chain })); throw error;
      }
    };
    return engine;
  };
  let runtime = inspectFailures(await V2Coordinator.create(store, { dataDir: directory, model, memory: { embedder } }));
  let app: Server | undefined; let base = ''; let open = true;
  const topics: string[] = [];
  let fast: Awaited<ReturnType<typeof observe>> | undefined, slow: Awaited<ReturnType<typeof observe>> | undefined;
  const accepted = new Map<string, string>(); const samples: { elapsedMs: number; rss: number; heapUsed: number; snapshotBytes: number; snapshotMs: number }[] = [];
  let batches = 0, restarts = 0, reconnects = 0, deliveredFrames = 0;
  const launch = async () => {
    app = createApp({ store, runtime }); await new Promise<void>(done => app!.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    runtime.start(); fast = await observe(base, topics[0], false); slow = await observe(base, topics[1], true);
  };
  const stop = async () => {
    if (fast) { deliveredFrames += fast.frames; await fast.close(); fast = undefined; }
    if (slow) { deliveredFrames += slow.frames; await slow.close(); slow = undefined; }
    await runtime.beginShutdown();
    if (app) { await new Promise<void>(done => app!.close(() => done())); app = undefined; }
    await runtime.close(); store.close(); open = false;
  };
  try {
    for (let index = 0; index < 3; index++) topics.push((await runtime.createCase({ title: `Soak ${index}`, objective: 'Offline synthetic endurance', domain: 'fixture' })).id);
    const old = '2020-01-01T00:00:00.000Z';
    runtime.inbox.ingestBatch(Array.from({ length: initialEvents }, (_, index) => ({ id: `history-${index}`, sourceId: 'fixture-history',
      externalId: String(index), caseId: topics[index % topics.length], kind: 'fixture.history', actor: 'system' as const,
      operation: 'create' as const, occurredAt: old, payload: { content: 'Synthetic historical record' } })), { sourceId: 'fixture-history', value: null });
    runtime.inbox.consumeLocal(['fixture.history'], () => true);
    store.atomic(() => { for (let index = 0; index < initialRuns; index++) store.insert('runs', { id: `run-history-${index}`,
      caseId: topics[index % topics.length], trigger: 'timer', mode: 'growth', status: 'completed', startedAt: old,
      steps: 1, inputTokens: 10, outputTokens: 2, usageStatus: 'reported' }); });
    await store.updateSettings({ enabled: true }); await launch();
    const started = performance.now(); let nextRestart = started + durationMs / 3;
    while (performance.now() - started < durationMs) {
      const iteration = performance.now();
      for (const topic of topics.slice(0, 2)) {
        const requestId = randomUUID();
        const body = { content: `Synthetic request ${batches}`, caseId: topic, requestId };
        const send = async () => {
          const response = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          assert.equal(response.status, 202, await response.clone().text()); return response.json() as Promise<Message>;
        };
        const duplicates = await Promise.all([send(), send()]);
        assert.equal(duplicates[0].id, duplicates[1].id); accepted.set(requestId, duplicates[0].id);
      }
      await until(() => store.list('messages').filter(message => message.role === 'assistant' && message.outputState === 'complete').length === accepted.size
        && !runtime.inbox.hasPending(), 'Replies did not settle');
      assert.equal(roleCalls.actor, accepted.size, 'Duplicate requests or restarts must not cause extra reply calls');
      const newRuns = store.list('runs').filter(run => !run.id.startsWith('run-history-'));
      assert.equal(newRuns.length, accepted.size, 'Memory work stays inside the original owner run.');
      assert.equal(newRuns.reduce((total, run) => total + run.steps, 0), calls, 'Every observer, reflector and reply call consumes a real run step.');
      assert.equal(calls, roleCalls.actor + roleCalls.observer + roleCalls.reflector);
      assert.equal(store.list('messages').filter(message => message.role === 'user').length, accepted.size);
      fast!.check(); slow!.check();
      const snapshotStart = performance.now(), view = await runtime.snapshot({ caseId: topics[0] });
      const snapshotMs = performance.now() - snapshotStart, snapshotBytes = Buffer.byteLength(JSON.stringify(view));
      assert.ok(snapshotBytes < 256 * 1024, `History leaked into live snapshot: ${snapshotBytes} bytes`);
      assert.deepEqual(view.status.todayUsage, { inputTokens: calls * 10, outputTokens: calls * 2, usageStatus: 'reported' });
      if (batches % 10 === 0) { const { rss, heapUsed } = process.memoryUsage(); samples.push({ elapsedMs: Math.round(performance.now() - started), rss, heapUsed, snapshotBytes, snapshotMs }); }
      if (batches % 7 === 6) { deliveredFrames += fast!.frames; await fast!.close(); fast = await observe(base, topics[0], false); reconnects++; }
      batches++;
      if (performance.now() >= nextRestart && restarts < 2) {
        await stop(); store = new Store(directory); open = true; store.getApiKey = () => undefined;
        runtime = inspectFailures(await V2Coordinator.create(store, { dataDir: directory, model, memory: { embedder } })); await launch(); restarts++;
        nextRestart = started + durationMs * (restarts + 1) / 3;
        assert.equal(store.list('messages').filter(message => message.role === 'user').length, accepted.size);
      }
      if (batches % 30 === 0) context.diagnostic(JSON.stringify({ ...samples.at(-1), elapsedMs: Math.round(performance.now() - started), accepted: accepted.size, restarts, reconnects }));
      await delay(Math.max(0, 1000 - (performance.now() - iteration)));
    }
    const response = await fetch(`${base}/api/export`); assert.equal(response.status, 200);
    const exported = await response.json() as { messages: Message[]; runs: unknown[]; events: unknown[] };
    assert.equal(exported.messages.filter(message => message.role === 'user').length, accepted.size);
    assert.equal(exported.messages.filter(message => message.role === 'assistant').length, accepted.size);
    assert.equal(exported.runs.length, initialRuns + accepted.size);
    assert.equal(exported.events.length, initialEvents + accepted.size);
    assert.equal(roleCalls.actor, accepted.size); assert.equal(restarts, 2);
    if (durationMs >= 180_000) {
      assert.ok(roleCalls.observer > 0, 'The default endurance run must cross the real observation threshold.');
      assert.ok(embeddingCalls > 0, 'Observed history must exercise native indexing through the offline embedder.');
    }
    await stop();
    for (const file of ['rae.sqlite', 'v2-events.sqlite', 'v2-memory.sqlite']) {
      if (file === 'v2-memory.sqlite') {
        // libsql_vector_idx is an engine-owned ANN index, not an ordinary
        // SQLite B-tree. Stock node:sqlite falsely reports missing entries.
        const database = createClient({ url: `file:${join(directory, file).replaceAll('\\', '/')}` });
        try {
          await database.execute('PRAGMA query_only=ON');
          assert.deepEqual((await database.execute('PRAGMA quick_check')).rows.map(row => row.quick_check), ['ok']);
        } finally { database.close(); }
      } else {
        const database = new DatabaseSync(join(directory, file), { readOnly: true });
        try { assert.deepEqual(database.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']); }
        finally { database.close(); }
      }
    }
    context.diagnostic(JSON.stringify({ durationMs: Math.round(performance.now() - started), initialEvents, initialRuns,
      accepted: accepted.size, modelCalls: calls, roleCalls, embeddingCalls, restarts, reconnects, deliveredFrames, samples, integrity: 'ok', externalModelCalls: 0 }));
  } finally { if (open) await stop(); }
});
