import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from 'ai/test';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';

type StreamOptions = Parameters<MockLanguageModelV4['doStream']>[0];
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;
const usage = { inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 8, text: 8, reasoning: 0 } };
const finish = (reason: 'stop' | 'length' | 'tool-calls' = 'stop'): StreamPart => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage });
const parts = (text: string, reason: 'stop' | 'length' = 'stop'): StreamPart[] => [
  { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: text }, { type: 'text-end', id: 'answer' }, finish(reason),
];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean, message = 'stream did not settle') {
  const deadline = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < deadline, message); await delay(10); }
}
async function fixture(make: (options: StreamOptions, index: number) => Promise<ReadableStream<StreamPart>> | ReadableStream<StreamPart>) {
  const prefix = join(tmpdir(), 'rae-stream-delivery-'); const directory = await mkdtemp(prefix);
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const calls: StreamOptions[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('production must use the native streaming path'); },
    doStream: async options => { calls.push(options); return { stream: await make(options, calls.length) }; } });
  const engine = await V2Coordinator.create(store, { dataDir: join(directory, 'native'), model });
  return { store, engine, calls,
    async start(content = '请回答这条消息。') {
      const event = await engine.ingestOwnerMessage(content);
      await store.updateSettings({ enabled: true, maxOutputContinuations: 0 }); engine.start(); return event;
    },
    async close() {
      await engine.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
      try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); }
      catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    },
  };
}
const replies = (store: Store) => store.list('messages').filter(message => message.role === 'assistant');

test('returned public text is durable and visible before the stream finishes, then the same message becomes complete', async () => {
  const gate = deferred();
  const f = await fixture(() => new ReadableStream<StreamPart>({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    controller.enqueue({ type: 'reasoning-start', id: 'private' }); controller.enqueue({ type: 'reasoning-delta', id: 'private', delta: 'PRIVATE_REASONING_NEVER_PUBLIC' }); controller.enqueue({ type: 'reasoning-end', id: 'private' });
    controller.enqueue({ type: 'text-start', id: 'answer' }); controller.enqueue({ type: 'text-delta', id: 'answer', delta: '已经收到的第一段。' });
    void gate.promise.then(() => { controller.enqueue({ type: 'text-delta', id: 'answer', delta: '这是后续返回的第二段。' }); controller.enqueue({ type: 'text-end', id: 'answer' }); controller.enqueue(finish()); controller.close(); });
  } }));
  try {
    const event = await f.start();
    await until(() => replies(f.store).some(message => message.content.includes('第一段')), 'first public delta was hidden until completion');
    const partial = replies(f.store)[0]; assert.equal(partial.outputState, 'streaming'); assert.equal(partial.replyTo, event.payload.messageId);
    assert.doesNotMatch(partial.content, /PRIVATE_REASONING/); assert.equal(f.engine.inbox.get(event.id)?.status, 'leased');
    assert.equal(f.store.list('runs')[0].status, 'running'); assert.equal(f.store.list('runs')[0].pendingModelCalls, 1);
    gate.resolve(); await until(() => f.engine.inbox.get(event.id)?.status === 'processed');
    const complete = replies(f.store); assert.equal(complete.length, 1); assert.equal(complete[0].id, partial.id); assert.equal(complete[0].outputState, 'complete');
    assert.match(complete[0].content, /第一段。.*第二段。/s); assert.doesNotMatch(complete[0].content, /PRIVATE_REASONING/);
    assert.equal(f.store.list('runs')[0].pendingModelCalls, 0); assert.equal(f.store.list('runs')[0].usageStatus, 'reported');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].maxOutputTokens, undefined, 'provider default must not be replaced by another small application cap');
  } finally { gate.resolve(); await f.close(); }
});

test('a broken stream retains received answer bytes, marks them incomplete, and never replays the paid attempt', async () => {
  const gate = deferred();
  const f = await fixture(() => new ReadableStream<StreamPart>({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'answer' });
    controller.enqueue({ type: 'text-delta', id: 'answer', delta: '断线前已经返回的正文。' });
    void gate.promise.then(() => controller.error(new Error('fixture provider connection lost')));
  } }));
  try {
    const event = await f.start(); await until(() => replies(f.store).length > 0);
    const partialId = replies(f.store)[0].id;
    gate.resolve(); await until(() => f.engine.inbox.get(event.id)?.status === 'failed');
    const kept = replies(f.store); assert.equal(kept.length, 1); assert.equal(kept[0].id, partialId); assert.match(kept[0].content, /断线前已经返回/);
    assert.equal(kept[0].outputState, 'incomplete'); assert.ok(kept[0].outputNote);
    assert.equal(f.store.list('runs')[0].status, 'failed'); assert.equal(f.store.list('runs')[0].pendingModelCalls, 0); assert.equal(f.store.list('runs')[0].usageStatus, 'unknown');
    f.engine.request('recovery'); await delay(100); assert.equal(f.calls.length, 1); assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
  } finally { gate.resolve(); await f.close(); }
});

test('pause preserves already displayed text and fences late bytes without leaving a pending usage marker', async () => {
  const late = deferred(); let attemptedLate = false;
  const f = await fixture(options => new ReadableStream<StreamPart>({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'answer' });
    controller.enqueue({ type: 'text-delta', id: 'answer', delta: '暂停前已经收到。' });
    options.abortSignal?.addEventListener('abort', () => controller.error(new DOMException('fixture request aborted', 'AbortError')), { once: true });
    void late.promise.then(() => { attemptedLate = true; try { controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'LATE_BYTES_MUST_NOT_APPEAR' }); controller.enqueue(finish()); controller.close(); } catch { /* a canceled transport cannot publish again */ } });
  } }));
  try {
    const event = await f.start(); await until(() => replies(f.store).length > 0);
    const id = replies(f.store)[0].id;
    await f.engine.stop();
    const stopped = replies(f.store)[0]; assert.equal(stopped.id, id); assert.match(stopped.content, /暂停前已经收到/); assert.equal(stopped.outputState, 'incomplete');
    assert.equal(f.store.list('runs')[0].status, 'interrupted'); assert.equal(f.store.list('runs')[0].pendingModelCalls, 0);
    late.resolve(); await until(() => attemptedLate); await delay(30);
    assert.equal(replies(f.store)[0].content, stopped.content); assert.doesNotMatch(replies(f.store)[0].content, /LATE_BYTES/);
    assert.equal(f.calls.length, 1); assert.notEqual(f.engine.inbox.get(event.id)?.status, 'processed');
  } finally { late.resolve(); await f.close(); }
});

test('stopping a streamed chat reply preserves its text and releases the queued follow-up without aborting another scene', async () => {
  const late = deferred(); const attemptedLate = deferred(); const releaseOther = deferred();
  const f = await fixture((options, index) => new ReadableStream<StreamPart>({ start(controller) {
    if (index >= 3) {
      for (const part of parts('接着回答你的补充。')) controller.enqueue(part);
      controller.close(); return;
    }
    controller.enqueue({ type: 'stream-start', warnings: [] });
    controller.enqueue({ type: 'text-start', id: 'answer' });
    controller.enqueue({ type: 'text-delta', id: 'answer', delta: index === 1 ? '停止前已经收到。' : '另一个场景正在回复。' });
    options.abortSignal?.addEventListener('abort', () => controller.error(options.abortSignal!.reason), { once: true });
    void (index === 1 ? late.promise : releaseOther.promise).then(() => {
      try {
        controller.enqueue({ type: 'text-delta', id: 'answer', delta: index === 1 ? '迟到的正文不应显示。' : '另一个场景继续完成。' });
        controller.enqueue({ type: 'text-end', id: 'answer' }); controller.enqueue(finish()); controller.close();
      } catch { /* A cancelled stream cannot write again. */ }
      finally { if (index === 1) attemptedLate.resolve(); }
    });
  } }));
  try {
    await f.store.updateSettings({ maxStepsPerRun: 1 });
    const first = await f.start('请回答最初的问题。');
    await until(() => replies(f.store).some(message => message.replyTo === first.payload.messageId));
    const initial = replies(f.store).find(message => message.replyTo === first.payload.messageId)!;
    const followup = await f.engine.ingestOwnerMessage('补充一个要求。', first.caseId);
    const other = await f.engine.createCase({ title: '另一个场景', objective: '验证单轮停止的范围', domain: 'fixture' });
    const otherMessage = await f.engine.ingestOwnerMessage('处理这段独立对话。', other.id);
    await until(() => replies(f.store).some(message => message.replyTo === otherMessage.payload.messageId));
    assert.equal(f.engine.inbox.get(followup.id)?.status, 'pending');
    assert.equal(f.engine.inbox.get(first.id)?.status, 'leased');

    assert.deepEqual(await f.engine.stopChatRun(initial.runId!), { stopped: true });
    assert.equal(f.store.getSettings().enabled, true);
    assert.equal(f.calls[0].abortSignal?.aborted, true);
    assert.equal(f.calls[1].abortSignal?.aborted, false);
    assert.equal(f.engine.inbox.get(otherMessage.id)?.status, 'leased');
    assert.equal(f.engine.inbox.get(first.id)?.status, 'failed');
    assert.equal(f.engine.inbox.get(first.id)?.ownerStoppedRunId, initial.runId);
    assert.equal(f.store.get('runs', initial.runId!)?.status, 'interrupted');
    assert.equal(f.store.get('runs', initial.runId!)?.stopReason, 'owner_stopped');
    assert.equal(f.store.get('runs', initial.runId!)?.pendingModelCalls, 0);
    const stopped = f.store.get('messages', initial.id);
    assert.equal(stopped?.content, initial.content);
    assert.equal(stopped.outputState, 'incomplete');
    assert.match(stopped.outputNote ?? '', /已停止回复/);

    late.resolve(); await attemptedLate.promise;
    await until(() => f.engine.inbox.get(followup.id)?.status === 'processed');
    assert.deepEqual(await f.engine.stopChatRun(initial.runId!), { stopped: true });
    assert.equal(f.store.get('messages', initial.id)?.content, initial.content);
    assert.equal(f.engine.inbox.get(first.id)?.attempts, 1);
    assert.equal(f.calls.length, 3);
    releaseOther.resolve(); await until(() => f.engine.inbox.get(otherMessage.id)?.status === 'processed');
    assert.match(replies(f.store).find(message => message.replyTo === otherMessage.payload.messageId)?.content ?? '', /继续完成/);
  } finally { late.resolve(); releaseOther.resolve(); await f.close(); }
});

test('stopping before public text suppresses automatic retry and leaves an explicit retry independently stoppable', async () => {
  const f = await fixture((options, index) => new ReadableStream<StreamPart>({ start(controller) {
    if (index === 2 || index > 3) {
      for (const part of parts('已经处理下一条消息。')) controller.enqueue(part);
      controller.close(); return;
    }
    controller.enqueue({ type: 'stream-start', warnings: [] });
    options.abortSignal?.addEventListener('abort', () => controller.error(options.abortSignal!.reason), { once: true });
  } }));
  try {
    const event = await f.start(); await until(() => f.calls.length > 0);
    const run = f.store.list('runs').find(item => item.eventId === event.id)!;
    assert.equal(replies(f.store).length, 0);
    assert.deepEqual(await f.engine.stopChatRun(run.id), { stopped: true });
    const next = await f.engine.ingestOwnerMessage('请处理新的消息。', event.caseId);
    await until(() => f.engine.inbox.get(next.id)?.status === 'processed');
    assert.equal(f.engine.inbox.get(event.id)?.status, 'failed');
    assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
    assert.equal(f.store.get('runs', run.id)?.status, 'interrupted');
    assert.equal(f.store.get('runs', run.id)?.stopReason, 'owner_stopped');
    assert.equal(f.calls.length, 2);

    await f.engine.retryEvent(event.id); await until(() => f.calls.length === 3);
    const retried = f.store.list('runs').find(item => item.eventId === event.id && item.id !== run.id)!;
    assert.deepEqual(await f.engine.stopChatRun(run.id), { stopped: true });
    assert.equal(f.calls[2].abortSignal?.aborted, false);
    assert.deepEqual(await f.engine.stopChatRun(retried.id), { stopped: true });
    assert.equal(f.engine.inbox.get(event.id)?.ownerStoppedRunId, retried.id);
    assert.equal(f.engine.inbox.get(event.id)?.attempts, 2);
  } finally { await f.close(); }
});

test('an image-only owner message can stop its active model stream without text consent', async () => {
  const f = await fixture(options => new ReadableStream<StreamPart>({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] });
    options.abortSignal?.addEventListener('abort', () => controller.error(options.abortSignal!.reason), { once: true });
  } }));
  try {
    const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#39584a' } }).png().toBuffer();
    const event = await f.engine.ingestOwnerMessage('', undefined, undefined, [{ name: 'image.png', data: png.toString('base64') }]);
    const saved = f.store.get('messages', event.externalId);
    assert.equal(saved?.content, '');
    assert.equal(saved.attachments?.length, 1);
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    await until(() => f.calls.length > 0, 'the image-only owner message did not start the model');

    const run = f.store.list('runs').find(item => item.eventId === event.id)!;
    assert.equal(run.status, 'running');
    assert.ok(!f.calls[0].tools?.some(tool => tool.type === 'function' && tool.name === 'request_task'));
    assert.deepEqual(await f.engine.stopChatRun(run.id), { stopped: true });
    assert.equal(f.calls[0].abortSignal?.aborted, true);
    assert.equal(f.engine.inbox.get(event.id)?.ownerStoppedRunId, run.id);
    assert.equal(f.store.get('runs', run.id)?.status, 'interrupted');
    assert.equal(f.store.get('runs', run.id)?.stopReason, 'owner_stopped');
  } finally { await f.close(); }
});

test('a committed stop fences replay even if writing the terminal run state fails', async () => {
  const f = await fixture((options, index) => new ReadableStream<StreamPart>({ start(controller) {
    if (index > 1) {
      for (const part of parts('新消息正常完成。')) controller.enqueue(part);
      controller.close(); return;
    }
    controller.enqueue({ type: 'stream-start', warnings: [] });
    options.abortSignal?.addEventListener('abort', () => controller.error(options.abortSignal!.reason), { once: true });
  } }));
  const put = f.store.put.bind(f.store);
  try {
    const event = await f.start(); await until(() => f.calls.length > 0);
    const run = f.store.list('runs').find(item => item.eventId === event.id)!;
    let failedWrites = 0;
    f.store.put = ((name, item) => {
      if (name === 'runs' && item.id === run.id && 'status' in item && item.status === 'interrupted') {
        failedWrites++; throw new Error('fixture terminal run write failed');
      }
      return put(name, item);
    }) as Store['put'];

    await assert.rejects(f.engine.stopChatRun(run.id));
    assert.ok(failedWrites > 0);
    assert.equal(f.store.get('runs', run.id)?.status, 'running');
    assert.equal(f.engine.inbox.get(event.id)?.status, 'failed');
    assert.equal(f.engine.inbox.get(event.id)?.ownerStoppedRunId, run.id);
    await assert.rejects(f.engine.retryEvent(event.id), { status: 409 });

    const next = await f.engine.ingestOwnerMessage('处理下一条消息。', event.caseId);
    await until(() => f.engine.inbox.get(next.id)?.status === 'processed');
    assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
    assert.equal(f.calls.length, 2);
  } finally { f.store.put = put; await f.close(); }
});

test('a length-limited answer may continue once in the same run without receiving any action tools', async () => {
  const f = await fixture((options, index) => {
    if (index === 2) {
      assert.equal(options.tools?.length ?? 0, 0, 'continuation must not be able to replay scheduling, memory or workspace actions');
      assert.equal(options.maxOutputTokens, undefined);
    }
    return new ReadableStream<StreamPart>({ start(controller) { for (const part of parts(index === 1 ? '第一段答案。' : '接着补完答案。', index === 1 ? 'length' : 'stop')) controller.enqueue(part); controller.close(); } });
  });
  try {
    await f.store.updateSettings({ enabled: true, maxOutputContinuations: 1 });
    const event = await f.engine.ingestOwnerMessage('请完整说明。'); f.engine.start();
    await until(() => f.engine.inbox.get(event.id)?.status === 'processed');
    assert.equal(f.calls.length, 2); assert.equal(f.store.list('runs').length, 1); assert.equal(f.store.list('runs')[0].steps, 2);
    const answer = replies(f.store); assert.equal(answer.length, 1); assert.equal(answer[0].outputState, 'complete');
    assert.match(answer[0].content, /第一段答案。.*接着补完答案。/s);
    assert.equal(f.store.list('runs')[0].inputTokens, 60); assert.equal(f.store.list('runs')[0].outputTokens, 16);
    assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
  } finally { await f.close(); }
});

test('a passive background stream stays quiet without an explicit owner notification', async () => {
  const f = await fixture(() => new ReadableStream<StreamPart>({ start(controller) { for (const part of parts('内部公开总结也不自动打扰本人。')) controller.enqueue(part); controller.close(); } }));
  try {
    const item = await f.engine.createCase({ title: '被动背景', objective: '保持必要的安静', domain: 'background' });
    const event = f.engine.inbox.ingest({ sourceId: 'fixture-passive', externalId: 'one', kind: 'case.wake', actor: 'system', caseId: item.id, operation: 'create', occurredAt: new Date().toISOString(), payload: {} }).event;
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await until(() => f.engine.inbox.get(event.id)?.status === 'processed');
    assert.equal(replies(f.store).length, 0); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('owner replies can continue once independently of the background step setting', async () => {
  for (const maxStepsPerRun of [1, 4]) {
    const f = await fixture((_options, index) => new ReadableStream<StreamPart>({ start(controller) {
      for (const part of parts(`已经收到第${index}段。`, 'length')) controller.enqueue(part); controller.close();
    } }));
    try {
      await f.store.updateSettings({ enabled: true, maxStepsPerRun, maxOutputContinuations: 1 });
      const event = await f.engine.ingestOwnerMessage('达到接口长度限制时接着写一次即可。'); f.engine.start();
      await until(() => f.engine.inbox.get(event.id)?.status === 'processed');
      const expected = 2;
      assert.equal(f.calls.length, expected); assert.equal(f.store.list('runs').length, 1); assert.equal(f.store.list('runs')[0].steps, expected);
      assert.equal(f.store.list('runs')[0].stopReason, 'output_limit');
      const partial = replies(f.store); assert.equal(partial.length, 1); assert.equal(partial[0].outputState, 'incomplete');
      assert.match(partial[0].content, /第1段/);
      assert.match(partial[0].content, /第2段/);
      assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
      f.engine.request('recovery'); await delay(50); assert.equal(f.calls.length, expected);
    } finally { await f.close(); }
  }
});

test('a successful scheduling action followed by a provider failure is not replayed even without a text answer', async () => {
  const at = new Date(Date.now() + 86400000).toISOString();
  const f = await fixture((_options, index) => {
    if (index !== 1) throw new Error('fixture failed after a committed reminder');
    const frames: StreamPart[] = [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'committed-action', toolName: 'schedule_wake', input: JSON.stringify({ at, reason: '已提交安排', message: '真实的单次提醒' }) }, finish('tool-calls')];
    return new ReadableStream({ start(controller) { for (const part of frames) controller.enqueue(part); controller.close(); } });
  });
  try {
    const event = await f.start('请保存这个提醒。'); await until(() => f.engine.inbox.get(event.id)?.status === 'failed');
    assert.equal(f.calls.length, 2); assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
    assert.equal(f.engine.inbox.wakeReceipts('personal-growth', event.id).scheduledCount, 1);
    f.engine.request('recovery'); await delay(100); assert.equal(f.calls.length, 2);
    assert.equal(f.engine.inbox.wakeReceipts('personal-growth', event.id).scheduledCount, 1);
    const kept = replies(f.store);
    assert.ok(kept.some(message => `${message.content}\n${message.outputNote ?? ''}`.includes('已保存 1 条时间安排')), 'a committed operation must remain visible despite the missing final answer');
    assert.equal(f.store.list('runs')[0].pendingModelCalls, 0);
  } finally { await f.close(); }
});

test('reopening a durable unfinished response keeps its text and clears the stale generating state without inference', async () => {
  const prefix = join(tmpdir(), 'rae-stream-reopen-'); const directory = await mkdtemp(prefix);
  const data = join(directory, 'store'); const native = join(directory, 'native');
  let calls = 0;
  const model = new MockLanguageModelV4({ doStream: async () => { calls++; throw new Error('reopening a saved fragment must not infer'); } });
  let store = new Store(data); store.getApiKey = () => undefined;
  let engine = await V2Coordinator.create(store, { dataDir: native, model });
  try {
    const item = await engine.createCase({ title: '故障前的对话', objective: '保留已经收到的内容', domain: 'recovery' });
    const event = await engine.ingestOwnerMessage('这条问题的部分答复已经生成。', item.id);
    engine.inbox.claim(1, 60_000, [event.id]);
    store.insert('runs', { id: 'crashed-run', eventId: event.id, trigger: 'chat', mode: 'growth', caseId: item.id, status: 'running', startedAt: new Date().toISOString(), steps: 0,
      inputTokens: 0, outputTokens: 0, pendingModelCalls: 1 });
    store.insert('messages', { id: 'durable-fragment', role: 'assistant', content: '进程退出前已经保存的正文。', caseId: item.id, runId: 'crashed-run', createdAt: new Date().toISOString(), outputState: 'streaming' });
    const uncertain = await engine.ingestOwnerMessage('这个动作已经开始，结果尚未确认。', item.id); engine.inbox.claim(1, 60_000, [uncertain.id]);
    store.insert('runs', { id: 'uncertain-action-run', eventId: uncertain.id, trigger: 'chat', mode: 'growth', caseId: item.id, status: 'running', startedAt: new Date().toISOString(), steps: 0,
      inputTokens: 30, outputTokens: 8, pendingModelCalls: 0, usageStatus: 'reported', toolCallsStarted: 1 });
    const stopped = await engine.ingestOwnerMessage('还没有公开正文就收到停止指令。', item.id);
    const [stoppedClaim] = engine.inbox.claim(1, 60_000, [stopped.id]);
    store.insert('runs', { id: 'stop-requested-run', eventId: stopped.id, trigger: 'chat', mode: 'growth', caseId: item.id, status: 'running',
      startedAt: new Date().toISOString(), steps: 0, inputTokens: 0, outputTokens: 0, pendingModelCalls: 1 });
    assert.equal(engine.inbox.stopOwnerMessage(stopped.id, stoppedClaim.leaseToken!, 'stop-requested-run', '已停止回复。'), true);
    assert.equal(store.get('runs', 'stop-requested-run')?.stopReason, undefined);
    await store.updateSettings({ enabled: true }); await engine.close(); store.close();
    store = new Store(data); store.getApiKey = () => undefined; engine = await V2Coordinator.create(store, { dataDir: native, model });
    const kept = store.get('messages', 'durable-fragment');
    assert.equal(kept?.content, '进程退出前已经保存的正文。'); assert.equal(kept.outputState, 'incomplete'); assert.ok(kept.outputNote);
    assert.equal(store.get('runs', 'crashed-run')?.status, 'interrupted'); assert.equal(store.get('runs', 'crashed-run')?.pendingModelCalls, 0);
    assert.equal(store.get('runs', 'crashed-run')?.usageStatus, 'unknown'); assert.equal(engine.inbox.get(event.id)?.status, 'failed');
    assert.equal(engine.inbox.get(uncertain.id)?.status, 'failed', 'an unknown prior tool outcome cannot be silently executed again after a crash');
    assert.equal(store.get('runs', 'uncertain-action-run')?.status, 'interrupted');
    assert.equal(engine.inbox.get(stopped.id)?.status, 'failed', 'a committed owner stop must not be retried even without text or tools');
    assert.equal(engine.inbox.get(stopped.id)?.ownerStoppedRunId, 'stop-requested-run');
    assert.equal(store.get('runs', 'stop-requested-run')?.status, 'interrupted');
    assert.equal(store.get('runs', 'stop-requested-run')?.stopReason, 'owner_stopped');
    engine.start(); engine.request('recovery'); await delay(100); assert.equal(calls, 0);
  } finally {
    await engine.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
});

test('a checkpoint write failure retains received text and still settles the event instead of replaying the model', async () => {
  const second = deferred(); const end = deferred(); let injected = false;
  const f = await fixture(() => new ReadableStream<StreamPart>({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 'answer' });
    controller.enqueue({ type: 'text-delta', id: 'answer', delta: '第一段已经成功保存。' });
    void second.promise.then(async () => {
      controller.enqueue({ type: 'text-delta', id: 'answer', delta: '第二段已经收到但首次保存失败。' });
      await end.promise;
      try { controller.enqueue({ type: 'text-end', id: 'answer' }); controller.enqueue(finish()); controller.close(); } catch { /* the model may already have been canceled */ }
    });
  } }));
  const put = f.store.put.bind(f.store);
  try {
    const event = await f.start(); await until(() => replies(f.store).length > 0);
    const first = replies(f.store)[0];
    f.store.put = ((name, item) => {
      if (name === 'messages' && 'content' in item && item.id === first.id && String(item.content).includes('第二段') && !injected) {
        injected = true; throw new Error('fixture checkpoint write failed once');
      }
      return put(name, item);
    }) as Store['put'];
    second.resolve(); await until(() => injected, 'the streaming checkpoint must attempt its durable write before provider completion');
    end.resolve(); await until(() => f.engine.inbox.get(event.id)?.status === 'failed');
    assert.equal(f.store.list('runs')[0].status, 'failed'); assert.equal(f.store.list('runs')[0].pendingModelCalls, 0);
    assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
    const kept = replies(f.store); assert.equal(kept.length, 1); assert.equal(kept[0].id, first.id); assert.equal(kept[0].outputState, 'incomplete');
    assert.match(kept[0].content, /第一段已经成功保存/); assert.match(kept[0].content, /第二段已经收到/);
    assert.ok(kept[0].outputNote);
    f.engine.request('recovery'); await delay(100); assert.equal(f.calls.length, 1);
  } finally { f.store.put = put; second.resolve(); end.resolve(); await f.close(); }
});
