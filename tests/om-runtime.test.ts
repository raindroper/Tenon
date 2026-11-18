import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockEmbeddingModelV4 } from 'ai/test';
import { LibSQLVector, MemoryLibSQL } from '@mastra/libsql';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';

type ModelOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type ModelRole = 'actor' | 'observer' | 'reflector';
const tokenTotals = { actor: [11, 2], observer: [17, 3], reflector: [23, 5] } as const;
const ownerHistory = '海棠演示确认改到十六日上午。场地仍在园区西楼，现场入场手续还没有确认。'
  + '彩排先用旧版样品验证投影连线，资料只有内部同事确认后才能定稿。'.repeat(12);
const observationText = '<observations>\nDate: Nov 6, 2026\n'
  + '* 🔴 (09:00) 本人确认海棠演示改到十六日上午。场地继续使用园区西楼。现场入场手续仍未确认。\n'
  + '* 🟡 (09:00) 本人准备先用旧版样品彩排，彩排目标是核对演示时使用的投影连线。\n'
  + '* 🟡 (09:00) 演示资料目前仍是草稿，只有在内部同事确认以后才能定稿。\n</observations>';
const reflectionText = '<observations>\n* 🔴 海棠演示定在十六日上午，入场待确认。\n</observations>';

function usageFor(role: ModelRole) {
  const [input, output] = tokenTotals[role];
  return { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 } };
}

function modelRole(prompt: ModelOptions['prompt']): ModelRole {
  const system = prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
  if (system.includes('Your memory observation reflections')) return 'reflector';
  return system.includes('Your observations will be the ONLY information') ? 'observer' : 'actor';
}

function gate() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}

async function waitFor(check: () => boolean, reason: string) {
  const deadline = performance.now() + 8000;
  while (!check()) {
    assert.ok(performance.now() < deadline, reason);
    await delay(10);
  }
}

async function fixture(options: { beforeModel?: (role: ModelRole, signal: AbortSignal | undefined, parameters: ModelOptions) => Promise<void>;
  beforeEmbed?: () => Promise<void>; observationTokens?: number; reflectionTokens?: number; reflectorText?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-om-runtime-'));
  const store = new Store(directory);
  store.getApiKey = () => undefined;
  const calls: { role: ModelRole; runId: string; tools: string[] }[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async parameters => {
    const role = modelRole(parameters.prompt);
    const run = store.list('runs').find(item => item.status === 'running');
    assert.ok(run?.pendingModelCalls, `A ${role} provider call must be durably pending before dispatch`);
    const tools = parameters.tools?.map(tool => tool.name) ?? [];
    calls.push({ role, runId: run.id, tools });
    await options.beforeModel?.(role, parameters.abortSignal, parameters);
    const usage = usageFor(role);
    if (tools.includes('publish_artifact') && parameters.prompt.at(-1)?.role !== 'tool') {
      return { content: [{ type: 'tool-call', toolCallId: 'fixture-artifact', toolName: 'publish_artifact',
        input: JSON.stringify({ title: '获准夹具', content: '这是一份离线测试草稿。', format: 'text' }) }],
      usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'fixture' } };
    }
    const text = role === 'actor' ? '先按你确认的演示时间准备。'
      : role === 'reflector' ? options.reflectorText ?? reflectionText : observationText;
    return { content: [{ type: 'text', text }], usage, warnings: [], finishReason: { unified: 'stop', raw: 'fixture' } };
  } });
  const embedder = new MockEmbeddingModelV4({ doEmbed: async ({ values }) => {
    await options.beforeEmbed?.();
    return { embeddings: values.map(() => Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0)), warnings: [] };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model, connectorProviders: {},
    memory: { embedder, observationTokens: options.observationTokens ?? 48, reflectionTokens: options.reflectionTokens ?? 100_000 } });
  const scene = await runtime.createCase({ title: '测试长对话', objective: '', domain: 'personal' });
  async function send(content: string) {
    const event = await runtime.ingestOwnerMessage(content, scene.id);
    await waitFor(() => runtime.inbox.get(event.id)?.status === 'processed'
      || store.list('runs').some(run => run.eventId === event.id && run.status === 'failed'), 'Owner turn did not settle');
    const settled = runtime.inbox.get(event.id);
    assert.equal(settled?.status, 'processed', settled?.lastError ?? 'Owner turn failed');
    assert.equal(settled?.attempts, 1, 'A failed memory cycle must not trigger an owner-turn retry');
    return event;
  }
  return { store, runtime, scene, calls, send, async close() { try { await runtime.close(); } finally { store.close(); } } };
}

test('native Observer and Reflector receive owner-zone clock facts without persisting a transient clock into raw history', async () => {
  const hostTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hostOffsetSeconds = -new Date().getTimezoneOffset() * 60;
  const timezone = hostOffsetSeconds === 20700 ? 'Asia/Shanghai' : 'Asia/Kathmandu';
  const offsetSeconds = timezone === 'Asia/Kathmandu' ? 20700 : 28800;
  const seen: ModelRole[] = [];
  const f = await fixture({ reflectionTokens: 120, beforeModel: async (role, _signal, parameters) => {
    const marker = '本次请求的时间事实（由程序计算，不是来源正文）：\n';
    const clocks = parameters.prompt.filter(message => message.role === 'system' && message.content.startsWith(marker));
    assert.equal(clocks.length, 1, `The actual ${role} request needs the same authoritative owner clock`);
    const clock = clocks[0]; assert.equal(clock.role, 'system');
    if (clock.role !== 'system') return;
    const facts = JSON.parse(clock.content.slice(marker.length).split('\n')[0]);
    assert.equal(facts.asOf.timezone, timezone); assert.equal(facts.asOf.offsetSeconds, offsetSeconds);
    assert.ok(Number.isFinite(Date.parse(facts.asOf.utc)));
    assert.ok(parameters.prompt.indexOf(clock) > 0, 'the native stable instructions remain before the changing clock');
    seen.push(role);
  } });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 1, timezone }); f.runtime.start();
    const seed = await f.send(ownerHistory);
    await f.store.updateSettings({ maxStepsPerRun: 4 });
    const event = await f.send('再核对演示日期和场地。');
    assert.deepEqual(seen, ['actor', 'observer', 'reflector', 'actor']);
    assert.notEqual(timezone, hostTimezone);
    assert.notEqual(offsetSeconds, hostOffsetSeconds);
    const run = f.store.list('runs').find(run => run.eventId === event.id)!;
    assert.equal(run.steps, 3); assert.equal(run.pendingModelCalls, 0);
    const seedRun = f.store.list('runs').find(run => run.eventId === seed.id)!;
    assert.deepEqual(seedRun.contextManifests?.map(context => context.role), ['actor']);
    assert.deepEqual(run.contextManifests?.map(context => context.role), ['observer', 'reflector', 'actor']);
    assert.ok(run.contextManifests?.every(context => context.time?.asOf.timezone === timezone && context.time.asOf.offsetSeconds === offsetSeconds));
    assert.doesNotMatch(JSON.stringify(await f.runtime.memory.history(f.scene.id)), /本次请求的时间事实|asOf/);
  } finally { await f.close(); }
});

test('owner chat shares the durable provider budget and usage with native observation and reflection', async () => {
  const f = await fixture({ reflectionTokens: 120 });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 1 });
    f.runtime.start();
    const seed = await f.send(ownerHistory);
    assert.deepEqual(f.calls.map(call => call.role), ['actor'], 'Keep the only available provider request for the reply');

    await f.store.updateSettings({ maxStepsPerRun: 4 });
    const reflectedTurn = await f.send('再核对一下这场演示的时间和场地。');
    const reflectedRun = f.store.list('runs').find(run => run.eventId === reflectedTurn.id);
    assert.deepEqual(f.calls.filter(call => call.runId === reflectedRun?.id).map(call => call.role), ['observer', 'reflector', 'actor']);
    const observations = await f.runtime.memory.observationsForCase(f.scene.id);
    assert.match(observations ?? '', /海棠演示定在十六日上午，入场待确认/);
    assert.doesNotMatch(observations ?? '', /草稿/);
    const recalled = await f.runtime.memory.semanticRecall('哪天进园展示', [f.scene.id], new AbortController().signal);
    assert.ok(recalled.some(hit => hit.caseId === f.scene.id && hit.messageId === seed.externalId),
      'Reflection must preserve semantic access to verified original messages');

    // Leave an observation-sized owner backlog while verifying non-owner runs.
    await f.store.updateSettings({ maxStepsPerRun: 1 });
    await f.send(ownerHistory);
    await f.store.updateSettings({ maxStepsPerRun: 4 });
    for (const run of f.store.list('runs')) {
      const roles = f.calls.filter(call => call.runId === run.id).map(call => call.role);
      assert.ok(roles.length <= 4, 'Auxiliary provider calls consume the same bounded turn');
      assert.equal(run.status, 'completed');
      assert.equal(run.steps, roles.length);
      assert.equal(run.inputTokens, roles.reduce((sum, role) => sum + tokenTotals[role][0], 0));
      assert.equal(run.outputTokens, roles.reduce((sum, role) => sum + tokenTotals[role][1], 0));
      assert.equal(run.usageStatus, 'reported');
      assert.equal(run.pendingModelCalls, 0);
    }
    assert.ok(f.calls.filter(call => call.role !== 'actor').every(call => !call.tools.includes('publish_artifact')));
    assert.ok(f.calls.some(call => call.role === 'actor' && call.tools.includes('recall')));

    const beforeExecution = f.calls.length;
    const task = await f.runtime.requestTask({ requestId: 'om-execution-fixture', spec: {
      caseId: f.scene.id, title: '明确委托测试', objective: '保存获准的离线草稿', expectedOutput: '夹具文本', capabilities: ['artifact'],
    } });
    await waitFor(() => f.runtime.consent.get(task.id)?.state === 'completed', 'Approved execution did not complete');
    assert.equal(f.store.list('artifacts').find(artifact => artifact.taskId === task.id)?.status, 'prepared');
    await waitFor(() => f.runtime.status().state === 'idle', 'Runtime did not become idle');
    const executionCalls = f.calls.slice(beforeExecution);
    assert.ok(executionCalls.length > 0);
    assert.ok(executionCalls.every(call => call.role === 'actor' && !call.tools.includes('recall')));

    const beforeWake = f.calls.length;
    const wake = f.runtime.inbox.scheduleWake({ caseId: f.scene.id, at: new Date().toISOString(),
      reason: '夹具复访已有进度', originEventId: 'fixture-origin' });
    f.runtime.inbox.releaseDueWakes();
    f.runtime.start();
    await waitFor(() => f.runtime.inbox.get(wake.id)?.status === 'processed', 'Learning wake did not finish');
    assert.deepEqual(f.calls.slice(beforeWake).map(call => call.role), ['actor']);
    assert.ok(!f.calls.at(-1)?.tools.includes('recall'));
    await waitFor(() => f.runtime.status().state === 'idle', 'Runtime did not become idle after the wake');
    assert.equal(f.runtime.status().nextWakeAt, null);
    const idleCalls = f.calls.length;
    f.runtime.start();
    await f.runtime.snapshot();
    assert.equal(f.calls.length, idleCalls, 'An idle runtime has no observation or reflection requests');
  } finally { await f.close(); }
});

test('an overlong native reflection cannot spend the request reserved for the owner reply', async () => {
  const f = await fixture({ reflectionTokens: 8, reflectorText: observationText });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 1 });
    f.runtime.start();
    await f.send(ownerHistory);
    await f.store.updateSettings({ maxStepsPerRun: 3 });
    const event = await f.send('再核对一下这场演示的时间。');
    const run = f.store.list('runs').find(item => item.eventId === event.id);
    assert.deepEqual(f.calls.filter(call => call.runId === run?.id).map(call => call.role), ['observer', 'reflector', 'actor']);
    assert.equal(run?.status, 'completed');
    assert.equal(run?.steps, 3);
    assert.equal(run?.pendingModelCalls, 0);
    assert.equal(run?.usageStatus, 'reported');
    assert.equal(run?.inputTokens, tokenTotals.observer[0] + tokenTotals.reflector[0] + tokenTotals.actor[0]);
    assert.equal(run?.outputTokens, tokenTotals.observer[1] + tokenTotals.reflector[1] + tokenTotals.actor[1]);
    assert.match(await f.runtime.memory.observationsForCase(f.scene.id) ?? '', /现场入场手续仍未确认/);
  } finally { await f.close(); }
});

test('ordinary owner replies reuse verified history and only repair an absent index during recall', async t => {
  const f = await fixture({ observationTokens: 1500 });
  const upsert = LibSQLVector.prototype.upsert;
  let denyWrites = false;
  const writes = t.mock.method(LibSQLVector.prototype, 'upsert', async function (this: LibSQLVector, args: Parameters<typeof upsert>[0]) {
    assert.ok(!denyWrites, 'An unchanged reply must not depend on a vector write');
    return upsert.call(this, args);
  });
  const deletes = t.mock.method(LibSQLVector.prototype, 'deleteVectors');
  const reads = t.mock.method(MemoryLibSQL.prototype, 'listMessages');
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 1 });
    f.runtime.start();
    const seed = await f.send(ownerHistory.repeat(16));
    await f.store.updateSettings({ maxStepsPerRun: 3 });
    await f.send('确认一下。');
    assert.deepEqual(f.calls.map(call => call.role), ['actor', 'observer', 'actor']);
    assert.equal(writes.mock.callCount(), 1, 'The native Observer already writes the new index group');
    assert.equal(deletes.mock.callCount(), 0);

    const write = writes.mock.calls[0];
    const vector = write.this as LibSQLVector;
    const indexName = write.arguments[0].indexName;
    const historyReads = () => reads.mock.calls.filter(call => {
      const [args] = call.arguments;
      return args.threadId === f.scene.id && args.resourceId === 'owner' && args.perPage === false;
    }).length;
    const beforeQuiet = historyReads();
    denyWrites = true;
    await f.send('明白。');
    denyWrites = false;
    assert.deepEqual(f.calls.map(call => call.role), ['actor', 'observer', 'actor', 'actor']);
    assert.equal(historyReads() - beforeQuiet, 1, 'All checks in a quiet turn share a single raw history read');
    assert.equal(writes.mock.callCount(), 1);
    assert.equal(deletes.mock.callCount(), 0);

    await vector.deleteVectors({ indexName, filter: { resource_id: 'owner', thread_id: f.scene.id } });
    const hits = await f.runtime.memory.semanticRecall('哪天进园展示', [f.scene.id], new AbortController().signal);
    assert.ok(hits.some(hit => hit.messageId === seed.externalId), 'An actual recall repairs a missing authorized group index');
    assert.equal(writes.mock.callCount(), 2);
    await f.runtime.memory.semanticRecall('哪天进园展示', [f.scene.id], new AbortController().signal);
    assert.equal(writes.mock.callCount(), 2, 'A usable current group does not need repair');
  } finally { await f.close(); }
});

test('cross-scene recall skips index repair while the target scene is observing', async t => {
  const observerEntered = gate();
  const release = gate();
  let holdObserver = false;
  const f = await fixture({ observationTokens: 1500, reflectionTokens: 120, beforeModel: async role => {
    if (role !== 'observer' || !holdObserver) return;
    observerEntered.release();
    await release.reached;
  } });
  const writes = t.mock.method(LibSQLVector.prototype, 'upsert');
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 1 });
    f.runtime.start();
    await f.send(ownerHistory.repeat(16));
    await f.store.updateSettings({ maxStepsPerRun: 4 });
    await f.send('确认一下。');

    await f.store.updateSettings({ maxStepsPerRun: 1 });
    const newSource = await f.send(ownerHistory.repeat(16) + '收到入场登记通知。');
    const write = writes.mock.calls.at(-1)!;
    const vector = write.this as LibSQLVector;
    await vector.deleteVectors({ indexName: write.arguments[0].indexName,
      filter: { resource_id: 'owner', thread_id: f.scene.id } });
    const before = writes.mock.callCount();

    await f.store.updateSettings({ maxStepsPerRun: 4 });
    holdObserver = true;
    const next = await f.runtime.ingestOwnerMessage('再对一下安排。', f.scene.id);
    await Promise.race([observerEntered.reached, delay(3000, undefined, { ref: false }).then(() => {
      throw new Error('Target scene did not enter Observer');
    })]);
    const signal = new AbortController().signal;
    const during = await Promise.race([
      f.runtime.memory.semanticRecall('哪天进园展示', [f.scene.id], signal),
      delay(3000, undefined, { ref: false }).then(() => { throw new Error('Recall waited for another scene model'); }),
    ]);
    assert.deepEqual(during, []);
    assert.equal(writes.mock.callCount(), before, 'Read-side repair cannot overwrite an in-flight observation generation');

    release.release();
    await waitFor(() => f.runtime.inbox.get(next.id)?.status === 'processed', 'Target scene did not finish observing');
    const after = await f.runtime.memory.semanticRecall('哪天进园展示', [f.scene.id], signal);
    assert.ok(after.some(hit => hit.messageId === newSource.externalId), 'The new generation remains searchable');
  } finally { release.release(); await f.close(); }
});

test('a native Reflector storage failure still fails the turn after its budget cutoff', async t => {
  const f = await fixture({ reflectionTokens: 8, reflectorText: observationText });
  const cleanupError = new Error('fixture Reflector cleanup write failed');
  const setReflectingFlag = MemoryLibSQL.prototype.setReflectingFlag;
  let failCleanup = false;
  const reflectionWrites = t.mock.method(MemoryLibSQL.prototype, 'setReflectingFlag', async function (this: MemoryLibSQL, id: string, active: boolean) {
    if (!active && failCleanup) throw cleanupError;
    return setReflectingFlag.call(this, id, active);
  });
  let actualError: unknown;
  const runCase = f.runtime.memory.runCase.bind(f.runtime.memory);
  t.mock.method(f.runtime.memory, 'runCase', async (input: Parameters<typeof runCase>[0]) => {
    try { return await runCase(input); }
    catch (error) { actualError = error; throw error; }
  });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 1 });
    f.runtime.start();
    await f.send(ownerHistory);
    await f.store.updateSettings({ maxStepsPerRun: 3 });
    failCleanup = true;
    const next = await f.runtime.ingestOwnerMessage('再核对一下这场演示的时间。', f.scene.id);
    await waitFor(() => f.store.list('runs').some(run => run.eventId === next.id && run.status !== 'running'), 'Owner turn did not settle');
    const run = f.store.list('runs').find(item => item.eventId === next.id);
    assert.ok(reflectionWrites.mock.calls.some(call => call.arguments[1] === false));
    assert.equal(actualError, cleanupError);
    assert.equal(run?.status, 'failed');
    assert.deepEqual(f.calls.filter(call => call.runId === run?.id).map(call => call.role), ['observer', 'reflector']);
  } finally { await f.close(); }
});

for (const action of ['stop', 'close'] as const) test(`${action} aborts and drains a pending native Observer call`, async () => {
  const release = gate();
  let observerEntered = false;
  let observedAbort = false;
  let providerFinished = false;
  let acknowledged = false;
  let stopping: Promise<void> | undefined;
  const f = await fixture({ beforeModel: async (role, signal) => {
    if (role !== 'observer') return;
    assert.ok(signal, 'Native Observer needs the owning turn abort signal');
    observerEntered = true;
    const abort = () => { observedAbort = true; };
    signal.addEventListener('abort', abort, { once: true });
    try { await release.reached; }
    finally { signal.removeEventListener('abort', abort); providerFinished = true; }
  } });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 1 });
    f.runtime.start();
    await f.send(ownerHistory);
    await f.store.updateSettings({ maxStepsPerRun: 3 });
    const next = await f.runtime.ingestOwnerMessage('接着聊演示。', f.scene.id);
    await waitFor(() => observerEntered, 'The second owner turn did not start its native Observer');
    stopping = f.runtime[action]().then(() => { acknowledged = true; assert.ok(providerFinished); });
    await waitFor(() => observedAbort, 'The native Observer did not receive cancellation');
    assert.equal(acknowledged, false, 'Cancellation cannot acknowledge while an accepted provider call is still blocked');
    release.release();
    await stopping;
    const run = f.store.list('runs').find(item => item.eventId === next.id);
    assert.deepEqual(f.calls.filter(call => call.runId === run?.id).map(call => call.role), ['observer']);
    assert.equal(run?.status, 'interrupted');
    assert.equal(run?.pendingModelCalls, 0);
    assert.equal(run?.usageStatus, 'unknown', 'A canceled model call must retain explicit missing usage');
    assert.equal(run?.inputTokens, 0);
    assert.equal(run?.outputTokens, 0);
  } finally { release.release(); try { await stopping; } finally { await f.close(); } }
});

test('stop drains a native observation index write before acknowledging cancellation', async () => {
  const release = gate();
  let indexing = false;
  let embeddingFinished = false;
  let observerSignal: AbortSignal | undefined;
  let acknowledged = false;
  let stopping: Promise<void> | undefined;
  const f = await fixture({
    beforeModel: async (role, signal) => { if (role === 'observer') observerSignal = signal; },
    beforeEmbed: async () => {
      indexing = true;
      await release.reached;
      embeddingFinished = true;
    },
  });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 1 });
    f.runtime.start();
    await f.send(ownerHistory);
    await f.store.updateSettings({ maxStepsPerRun: 3 });
    const next = await f.runtime.ingestOwnerMessage('再核对一次演示安排。', f.scene.id);
    await waitFor(() => indexing, 'Native Observer did not start indexing the observation');
    stopping = f.runtime.stop().then(() => { acknowledged = true; assert.ok(embeddingFinished); });
    await waitFor(() => observerSignal?.aborted === true, 'The owner run did not receive cancellation');
    assert.equal(acknowledged, false, 'Stop cannot acknowledge while the native index write is still in flight');
    release.release();
    await stopping;
    const run = f.store.list('runs').find(item => item.eventId === next.id);
    assert.deepEqual(f.calls.filter(call => call.runId === run?.id).map(call => call.role), ['observer']);
    assert.equal(run?.status, 'interrupted');
    assert.equal(run?.usageStatus, 'reported');
    assert.equal(run?.pendingModelCalls, 0);
    assert.equal(run?.inputTokens, tokenTotals.observer[0]);
    assert.equal(run?.outputTokens, tokenTotals.observer[1]);
  } finally { release.release(); try { await stopping; } finally { await f.close(); } }
});
