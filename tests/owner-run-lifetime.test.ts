import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { Run } from '../shared/types.js';
import type { TaskSpec } from '../shared/task-consent.js';
import { EventInbox } from '../server/v2/events.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { const started = performance.now(); while (!check()) { assert(performance.now() - started < 20_000, 'Lifetime fixture did not settle'); await delay(5); } }
async function fixture(model: MockLanguageModelV4) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-owner-lifetime-')); const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: join(directory, 'native'), model });
  const internal = runtime as unknown as { tick(): Promise<void>; taskExecutor: { recover(): Promise<void>; hasTask(id: string): boolean; accept(event: ReturnType<EventInbox['claim']>[number]): Promise<void> } };
  return { directory, store, runtime, internal, async close() { await runtime.close(); store.close(); } };
}
type StreamOptions = Parameters<MockLanguageModelV4['doStream']>[0];
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;
function heldStream(options: StreamOptions, release: ReturnType<typeof gate>, entered: ReturnType<typeof gate>, prefix: string) {
  let closed = false;
  return new ReadableStream<StreamPart>({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'reply' });
    controller.enqueue({ type: 'text-delta', id: 'reply', delta: prefix }); entered.resolve();
    const abort = () => { if (!closed) { closed = true; controller.error(options.abortSignal?.reason ?? new DOMException('Stopped', 'AbortError')); } };
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    if (options.abortSignal?.aborted) abort();
    void release.promise.then(() => { if (closed) return; closed = true; options.abortSignal?.removeEventListener('abort', abort);
      controller.enqueue({ type: 'text-end', id: 'reply' }); controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); controller.close(); });
  }, cancel() { closed = true; } });
}

test('owner conversation can remain active for hours with only live ownership renewal and no five-minute total timer', async () => {
  const entered = gate(); const release = gate(); let calls = 0;
  const f = await fixture(new MockLanguageModelV4({ doStream: async options => { calls++; return { stream: heldStream(options, release, entered, 'Already received public text.') }; } }));
  const originalNow = Date.now; const originalTimeout = globalThis.setTimeout; let clock = originalNow(); let fiveMinuteTimers = 0;
  try {
    const event = await f.runtime.ingestOwnerMessage('Take the time required to answer this substantial question.'); await f.store.updateSettings({ enabled: true });
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => { if (milliseconds === 300000) fiveMinuteTimers++; return originalTimeout(callback, milliseconds, ...args); }) as typeof setTimeout;
    f.runtime.start(); await entered.promise; globalThis.setTimeout = originalTimeout;
    await until(() => f.store.list('messages').some(message => message.role === 'assistant' && message.content.includes('Already received')));
    const claimed = f.runtime.inbox.get(event.id)!; assert(claimed.leaseToken); Date.now = () => clock;
    for (let period = 0; period < 14; period++) { clock += 9 * 60000; await f.internal.tick(); }
    assert.equal(fiveMinuteTimers, 0); assert.equal(calls, 1); assert.equal(f.runtime.inbox.get(event.id)?.attempts, 1);
    assert.equal(f.runtime.inbox.get(event.id)?.leaseToken, claimed.leaseToken);
    assert(Date.parse(f.runtime.inbox.get(event.id)!.leaseUntil!) > clock);
    release.resolve(); await until(() => f.runtime.inbox.get(event.id)?.status === 'processed');
    assert.equal(f.store.list('runs').find(run => run.eventId === event.id)?.status, 'completed');
  } finally { Date.now = originalNow; globalThis.setTimeout = originalTimeout; release.resolve(); await f.close(); }
});

test('manual stop remains effective after a long owner stream and preserves received text without replay', async () => {
  const entered = gate(); const release = gate(); let calls = 0;
  const f = await fixture(new MockLanguageModelV4({ doStream: async options => { calls++; return { stream: heldStream(options, release, entered, 'Preserved before manual stop.') }; } }));
  const originalNow = Date.now; let clock = originalNow();
  try {
    const event = await f.runtime.ingestOwnerMessage('Continue until I stop you.'); await f.store.updateSettings({ enabled: true }); f.runtime.start(); await entered.promise;
    await until(() => f.store.list('messages').some(message => message.role === 'assistant')); Date.now = () => clock;
    clock += 6 * 60000; await f.internal.tick(); await f.runtime.stop();
    const saved = f.store.list('messages').find(message => message.role === 'assistant')!;
    assert.match(saved.content, /Preserved before manual stop/); assert.equal(saved.outputState, 'incomplete');
    assert.equal(f.runtime.inbox.get(event.id)?.status, 'failed'); f.runtime.request('recovery'); f.runtime.start(); await delay(20); assert.equal(calls, 1);
  } finally { Date.now = originalNow; release.resolve(); await f.close(); }
});

test('a worker that slept past its lease stops and quarantines only its original event instead of auto-replaying', async () => {
  const entered = gate(); const release = gate(); let calls = 0;
  const f = await fixture(new MockLanguageModelV4({ doStream: async options => { calls++; return { stream: heldStream(options, release, entered, 'Received before lost ownership.') }; } }));
  const originalNow = Date.now; let clock = originalNow();
  try {
    const event = await f.runtime.ingestOwnerMessage('Work while the current owner keeps the execution lease.'); await f.store.updateSettings({ enabled: true }); f.runtime.start(); await entered.promise;
    await until(() => f.store.list('messages').some(message => message.role === 'assistant')); Date.now = () => clock;
    clock += 11 * 60000; await f.internal.tick(); await until(() => f.runtime.inbox.get(event.id)?.status === 'failed');
    await until(() => !f.store.list('runs').some(run => run.eventId === event.id && run.status === 'running'));
    f.runtime.request('recovery'); f.runtime.start(); await delay(20); assert.equal(calls, 1);
    assert.match(f.store.list('messages').find(message => message.role === 'assistant')!.content, /Received before lost ownership/);
  } finally { Date.now = originalNow; release.resolve(); await f.close(); }
});

test('owner-scheduled wake has no total timer and finishes its delivered notification without a trailing model call', async () => {
  let calls = 0; const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => { calls++; return call('finish_review', { outcome: 'complete', message: 'The requested daily update is delivered.' }); } }));
  const originalTimeout = globalThis.setTimeout; let fiveMinuteTimers = 0;
  try {
    const owner = await f.runtime.ingestOwnerMessage('Each day at 09:30, give me one AI frontier update.');
    f.runtime.inbox.consumeLocal(['owner.message'], event => event.id === owner.id);
    const scheduled = f.runtime.inbox.scheduleWake({ caseId: owner.caseId!, at: new Date(Date.now() - 100).toISOString(), reason: 'The owner requested daily AI frontier update', originEventId: owner.id });
    f.runtime.inbox.releaseDueWakes(); await f.store.updateSettings({ enabled: true });
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => { if (milliseconds === 300000) fiveMinuteTimers++; return originalTimeout(callback, milliseconds, ...args); }) as typeof setTimeout;
    f.runtime.start(); await until(() => f.runtime.inbox.get(scheduled.id)?.status === 'processed'); globalThis.setTimeout = originalTimeout;
    assert.equal(calls, 1); assert.equal(fiveMinuteTimers, 0);
    const message = f.store.list('messages').find(message => message.role === 'assistant')!;
    assert.equal(message.content, 'The requested daily update is delivered.'); assert.equal(message.outputState, 'complete');
    assert.equal(f.store.list('runs').find(run => run.eventId === scheduled.id)?.reviewOutcome, 'complete');
  } finally { globalThis.setTimeout = originalTimeout; await f.close(); }
});

test('new delegated task survives elapsed wall time and completes after more than 20 model calls', async () => {
  const entered = gate(); const release = gate(); let calls = 0;
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => {
    calls++;
    if (calls === 1) { entered.resolve(); await release.promise; }
    if (calls <= 20) return call('find_case_evidence', { query: 'task evidence ' + calls });
    if (calls === 21) return call('publish_artifact', { title: 'Requested result', content: 'Durably saved output', format: 'text' });
    return answer('Saved the requested result.');
  } }));
  const originalNow = Date.now; let clock = originalNow();
  try {
    const scene = await f.runtime.createCase({ title: 'Long explicit task', objective: 'Owner requested substantial work', domain: 'fixture' });
    const spec: TaskSpec = { caseId: scene.id, title: 'Requested long task', objective: 'Complete the owner goal without an arbitrary total time cap', expectedOutput: 'A saved artifact', capabilities: ['artifact'] };
    const task = await f.runtime.requestTask({ requestId: 'long-owner-task', spec }); await f.store.updateSettings({ enabled: true, maxStepsPerRun: 5 }); f.runtime.start(); await entered.promise;
    const initial = f.store.list('runs').find(run => run.taskId === task.id)!; assert.equal(initial.taskExecution?.deadline, null); assert.equal(initial.taskExecution?.stepLimit, null);
    Date.now = () => clock; for (let period = 0; period < 14; period++) { clock += 9 * 60000; await f.internal.tick(); }
    release.resolve(); await until(() => f.runtime.consent.get(task.id)?.state === 'completed');
    const done = f.store.get('runs', initial.id)!; assert.equal(done.taskExecution?.deadline, null); assert.equal(done.taskExecution?.stepLimit, null); assert.equal(done.steps, 22);
  } finally { Date.now = originalNow; release.resolve(); await f.close(); }
});

test('recovery preserves a null deadline and original remaining steps while an old finite deadline stays finite', async () => {
  for (const expired of [false, true]) {
    let calls = 0; const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => { calls++; return calls === 1
      ? call('publish_artifact', { title: 'Recovered result', content: 'Saved under the remaining original budget', format: 'text' }) : answer('Recovered.'); } }));
    try {
      const scene = await f.runtime.createCase({ title: 'Recovery fixture', objective: 'Keep the exact original limits', domain: 'fixture' });
      const spec: TaskSpec = { caseId: scene.id, title: 'Recover existing task', objective: 'Resume only safe unstarted work', expectedOutput: 'Saved output', capabilities: ['artifact'] };
      const admitted = f.runtime.consent.request(spec, 'recover-owner-task'); const task = f.runtime.consent.begin(admitted.id, admitted.approvalRevision!);
      const deadline = expired ? Date.now() - 1000 : null;
      const run: Run = { id: randomUUID(), taskId: task.id, caseId: scene.id, eventId: task.executionEventId!, mode: 'execution', trigger: 'recovery', status: 'interrupted',
        startedAt: new Date().toISOString(), steps: 1, inputTokens: 0, outputTokens: 0, usageStatus: 'not_used', taskExecution: { requirementsRevision: 1, deadline, stepLimit: 4, pausedBeforeProgress: true } };
      f.store.insert('runs', run); await f.store.updateSettings({ enabled: true, maxStepsPerRun: 50 }); await f.internal.taskExecutor.recover(); f.runtime.start();
      await until(() => ['completed', 'failed'].includes(f.runtime.consent.get(task.id)!.state) && !f.internal.taskExecutor.hasTask(task.id));
      const saved = f.store.get('runs', run.id)!; assert.equal(saved.taskExecution?.deadline, deadline); assert.equal(saved.taskExecution?.stepLimit, 4);
      assert.equal(calls, expired ? 0 : 2); assert.equal(saved.steps, expired ? 1 : 3);
    } finally { await f.close(); }
  }
});

test('lease renewal keeps claim identity and never refreshes an expired or replaced token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-owner-lease-')); const inbox = new EventInbox(join(directory, 'events.sqlite'));
  const originalNow = Date.now; let clock = originalNow(); Date.now = () => clock;
  try {
    const event = inbox.ingest({ sourceId: 'fixture', externalId: 'lease', caseId: 'scene', kind: 'owner.message', actor: 'owner', operation: 'create', occurredAt: new Date().toISOString(), payload: {} }).event;
    const first = inbox.claim(1, 1000, [event.id])[0]; clock += 500;
    assert.equal(inbox.renewLease(event.id, first.leaseToken!, 1000), true); assert.equal(inbox.get(event.id)?.attempts, 1);
    clock += 1001; assert.equal(inbox.renewLease(event.id, first.leaseToken!, 1000), false);
    const replacement = inbox.claim(1, 1000, [event.id])[0]; assert.notEqual(first.leaseToken, replacement.leaseToken);
    assert.equal(inbox.renewLease(event.id, first.leaseToken!, 1000), false);
    assert.equal(inbox.quarantineExpiredLease(event.id, first.leaseToken!, 'old worker expired'), false);
    assert.equal(inbox.get(event.id)?.leaseToken, replacement.leaseToken); assert.equal(inbox.get(event.id)?.status, 'leased');
    clock += 1001; assert.equal(inbox.quarantineExpiredLease(event.id, replacement.leaseToken!, 'expired original worker'), true);
    assert.equal(inbox.get(event.id)?.status, 'failed'); assert.equal(inbox.ready(1).length, 0);
  } finally { Date.now = originalNow; inbox.close(); }
});

test('stopping an expired owner round before any heartbeat quarantines it and never replays its paid attempt', async () => {
  for (const prefix of ['Accepted text before the stop.', '']) {
    const entered = gate(); const release = gate(); let calls = 0;
    const f = await fixture(new MockLanguageModelV4({ doStream: async options => { calls++; return { stream: heldStream(options, release, entered, prefix) }; } }));
    const originalNow = Date.now; let clock = originalNow();
    try {
      const event = await f.runtime.ingestOwnerMessage('Keep this real attempt instead of replaying after stop.'); await f.store.updateSettings({ enabled: true }); f.runtime.start(); await entered.promise;
      if (prefix) await until(() => f.store.list('messages').some(message => message.role === 'assistant'));
      Date.now = () => clock; clock += 11 * 60000;
      // Deliberately stop before tick(): the failing ack/release path owns quarantine.
      await f.runtime.stop(); assert.equal(f.runtime.inbox.get(event.id)?.status, 'failed');
      assert.match(f.runtime.inbox.get(event.id)?.lastError ?? '', /已停止.*不会自动重新执行/);
      assert.equal(f.runtime.inbox.ready(100).some(value => value.id === event.id), false);
      const saved = f.store.list('messages').find(message => message.role === 'assistant');
      if (prefix) { assert.equal(saved?.content, prefix); assert.match(saved?.outputNote ?? '', /已停止.*不会自动重新执行/); }
      assert.match(f.store.list('runs').find(run => run.eventId === event.id)?.error ?? '', /已停止.*不会自动重新执行/);
      f.runtime.start(); f.runtime.request('recovery'); await delay(20); assert.equal(calls, 1);
    } finally { Date.now = originalNow; release.resolve(); await f.close(); }
  }
});

test('safe task pause cannot release a replacement token and expired original task pauses do not auto-restart', async () => {
  for (const replace of [false, true]) {
    const entered = gate(); const release = gate(); let calls = 0;
    const f = await fixture(new MockLanguageModelV4({ doStream: async options => { calls++; return { stream: heldStream(options, release, entered, '') }; } }));
    const originalNow = Date.now; let clock = originalNow();
    try {
      const scene = await f.runtime.createCase({ title: 'Captured task token', objective: 'Stop only this original task attempt', domain: 'fixture' });
      const spec: TaskSpec = { caseId: scene.id, title: 'Owner task', objective: 'Prepare the requested output', expectedOutput: 'Saved output', capabilities: ['artifact'] };
      const task = await f.runtime.requestTask({ requestId: 'expired-safe-pause', spec }); await f.store.updateSettings({ enabled: true }); f.runtime.start(); await entered.promise;
      const original = f.runtime.inbox.get(task.executionEventId!)!; assert(original.leaseToken); Date.now = () => clock; clock += 11 * 60000;
      const replacement = replace ? f.runtime.inbox.claim(1, 600000, [original.id])[0] : undefined;
      await f.runtime.stop(); const current = f.runtime.inbox.get(original.id)!;
      if (replacement) {
        assert.equal(current.status, 'leased'); assert.equal(current.leaseToken, replacement.leaseToken);
        assert.notEqual(current.leaseToken, original.leaseToken);
      } else {
        // The workflow may acknowledge its failed delivery after quarantine;
        // neither terminal transport status may make it eligible again.
        assert(['failed', 'processed'].includes(current.status)); assert.equal(f.runtime.consent.get(task.id)?.state, 'failed');
        assert.equal(f.runtime.inbox.ready(100).some(value => value.id === original.id), false);
        const run = f.store.list('runs').find(run => run.taskId === task.id)!;
        assert.equal(run.taskExecution?.pausedBeforeProgress, undefined); assert.match(run.error ?? '', /已停止.*不会自动重新执行/);
        await f.internal.taskExecutor.recover(); f.runtime.start(); await delay(20); assert.equal(calls, 1);
      }
    } finally { Date.now = originalNow; release.resolve(); await f.close(); }
  }
});

test('task admission release and final ack quarantine only the original expired claim', async () => {
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => { assert.fail('An unavailable task cannot call a model'); } }));
  const originalNow = Date.now; let clock = originalNow();
  try {
    const scene = await f.runtime.createCase({ title: 'Admission quarantine', objective: 'Keep stopped task delivery terminal', domain: 'fixture' });
    const spec: TaskSpec = { caseId: scene.id, title: 'Owner task', objective: 'Prepare output only after admission', expectedOutput: 'Saved output', capabilities: ['artifact'] };
    const task = f.runtime.consent.request(spec, 'expired-admission'); const claim = f.runtime.inbox.claim(1, 600000, [task.executionEventId!])[0];
    Date.now = () => clock; clock += 11 * 60000; await f.internal.taskExecutor.accept(claim);
    assert.equal(f.runtime.inbox.get(claim.id)?.status, 'failed'); assert.match(f.runtime.inbox.get(claim.id)?.lastError ?? '', /已停止.*不会自动重新执行/);
  } finally { Date.now = originalNow; await f.close(); }
});
