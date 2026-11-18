import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CaseMemory } from '../server/v2/memory.js';
import { deepseekStreamResponse } from './support/deepseek-stream.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const sse = (delta: unknown, finishReason: string | null = null) => new TextEncoder().encode(`data: ${JSON.stringify({
  id: 'fixture-live', object: 'chat.completion.chunk', created: 0, model: 'fixture-vision',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(finishReason ? { usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } } : {}),
})}\n\n`);
async function fixture(fetch: NonNullable<Parameters<typeof createDeepSeek>[0]>['fetch']) {
  const prefix = join(tmpdir(), 'rae-stream-memory-'); const directory = await mkdtemp(prefix);
  const memory = new CaseMemory(`file:${join(directory, 'memory.db').replaceAll('\\', '/')}`);
  const item = await memory.createCase({ title: '流式公开回复', objective: '保留供应商实际返回的正文', domain: 'test' });
  const model = createDeepSeek({ apiKey: 'offline-fixture', baseURL: 'http://127.0.0.1:1/v1', fetch })('fixture-vision');
  return { memory, item, model, async close() {
    await memory.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  } };
}

test('real SDK streams public text before completion; default output cap is omitted and reasoning stays private', async () => {
  const finish = deferred(); const seen = deferred(); const text: string[] = []; let settled = false;
  let body: Record<string, unknown> | undefined;
  const f = await fixture(async (_url, options) => {
    body = JSON.parse(String(options?.body));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(sse({ role: 'assistant', reasoning_content: 'PRIVATE_REASONING_MUST_NOT_BE_BODY' }));
      controller.enqueue(sse({ content: '已收到的第一段' }));
      void finish.promise.then(() => {
        controller.enqueue(sse({ content: '，接着是第二段。' })); controller.enqueue(sse({}, 'stop')); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
      });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  let running: ReturnType<CaseMemory['runCase']> | undefined;
  try {
    running = f.memory.runCase({ caseId: f.item.id, model: f.model, message: '只返回实际正文。', instructions: '本地离线测试。',
      onText: delta => { text.push(delta); seen.resolve(); } }).finally(() => { settled = true; });
    await seen.promise; assert.equal(settled, false); assert.equal(text.join(''), '已收到的第一段');
    assert.equal(body?.stream, true); assert.equal('max_tokens' in body!, false); assert.equal('max_completion_tokens' in body!, false);
    finish.resolve(); const result = await running;
    assert.equal(result.text, '已收到的第一段，接着是第二段。'); assert.equal(text.join(''), result.text);
    assert.doesNotMatch(result.text, /PRIVATE_REASONING/); assert.equal(result.continuations, 0); assert.equal(result.steps, 1);
  } finally { finish.resolve(); await running; await f.close(); }
});

test('a length continuation uses the existing thread with no tools and consumes the original step budget once', async () => {
  const bodies: Array<Record<string, any>> = []; const deltas: string[] = []; let continued = 0; let actions = 0;
  const f = await fixture(async (_url, options) => {
    const body = JSON.parse(String(options?.body)); bodies.push(body);
    return bodies.length === 1 ? deepseekStreamResponse('第一段，', 'length') : deepseekStreamResponse('后续内容。');
  });
  try {
    const result = await f.memory.runCase({ caseId: f.item.id, model: f.model, message: 'ORIGINAL_OWNER_MESSAGE_SENTINEL', instructions: '本地离线测试。',
      maxSteps: 2, maxOutputTokens: 8192, maxOutputContinuations: 1, onOutputContinuation: () => { continued++; }, onText: delta => { deltas.push(delta); },
      tools: { write_fixture: createTool({ id: 'write_fixture', description: '本地测试的有副作用工具', inputSchema: z.object({}), execute: async () => { actions++; return { done: true }; } }) } });
    assert.equal(bodies.length, 2); assert.equal(continued, 1); assert.equal(actions, 0);
    assert.ok(bodies[0].tools.some((tool: any) => tool.function.name === 'write_fixture'));
    assert.ok(!bodies[1].tools?.length, 'the continuation must never retain action tools');
    assert.equal((JSON.stringify(bodies[1].messages).match(/ORIGINAL_OWNER_MESSAGE_SENTINEL/g) ?? []).length, 1, 'the original owner message must not be replayed');
    assert.match(JSON.stringify(bodies[1].messages), /第一段/); assert.match(JSON.stringify(bodies[1].messages), /继续补完上一轮/);
    assert.equal(bodies[0].max_tokens, 8192); assert.equal(bodies[1].max_tokens, 8192);
    assert.equal(result.steps, 2); assert.equal(result.continuations, 1); assert.equal(result.finishReason, 'stop');
    assert.equal(result.text, '第一段，后续内容。'); assert.equal(deltas.join(''), result.text);
    assert.equal(result.usage.inputTokens, 40); assert.equal(result.usage.outputTokens, 16);
  } finally { await f.close(); }
});

test('automatic continuation is bounded by original remaining steps, one extra call and actual public text', async () => {
  for (const [steps, allowed, visible, expected] of [[1, 1, true, 1], [4, 99, true, 2], [4, 1, false, 1], [4, 0, true, 1]] as const) {
    let calls = 0;
    const f = await fixture(async () => { calls++; return deepseekStreamResponse(visible ? '未完的正文' : '', 'length'); });
    try {
      const result = await f.memory.runCase({ caseId: f.item.id, model: f.model, message: '本地上限夹具。', instructions: '本地离线测试。', maxSteps: steps, maxOutputContinuations: allowed });
      assert.equal(calls, expected); assert.equal(result.steps, expected); assert.equal(result.continuations, expected - 1); assert.equal(result.finishReason, 'length');
    } finally { await f.close(); }
  }
});

test('an error after a public delta does not erase already delivered text or trigger continuation', async () => {
  const seen = deferred(); const fail = deferred(); const text: string[] = []; let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(sse({ role: 'assistant', content: '网络中断前已返回的内容' }));
      void fail.promise.then(() => controller.error(new Error('fixture transport disconnected')));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  let running: ReturnType<CaseMemory['runCase']> | undefined;
  try {
    running = f.memory.runCase({ caseId: f.item.id, model: f.model, message: '请保留已返回内容。', instructions: '本地离线测试。', maxOutputContinuations: 1,
      onText: delta => { text.push(delta); seen.resolve(); } });
    const rejected = assert.rejects(running, (error: any) => /fixture transport disconnected/.test(String(error?.cause ?? error)));
    await seen.promise; assert.equal(text.join(''), '网络中断前已返回的内容'); fail.resolve(); await rejected;
    assert.equal(calls, 1); assert.equal(text.join(''), '网络中断前已返回的内容');
  } finally { fail.resolve(); await running?.catch(() => undefined); await f.close(); }
});

test('cancelling the parent signal prevents a scheduled output continuation from issuing another call', async () => {
  const controller = new AbortController(); let calls = 0;
  const f = await fixture(async () => { calls++; return deepseekStreamResponse('保留已生成的第一段。', 'length'); });
  try {
    await assert.rejects(f.memory.runCase({ caseId: f.item.id, model: f.model, message: '续写前停止。', instructions: '本地离线测试。',
      signal: controller.signal, maxSteps: 4, maxOutputContinuations: 1, onOutputContinuation: () => controller.abort(new Error('fixture owner paused')) }), /fixture owner paused/);
    await delay(20); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('a rejected text publication aborts and drains the native stream before memory closes', async () => {
  let aborted = false; let chunks = 0;
  const f = await fixture(async (_url, options) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    options?.signal?.addEventListener('abort', () => { aborted = true; controller.error(options.signal!.reason); }, { once: true });
    controller.enqueue(sse({ role: 'assistant', content: '已经返回但不能越过已撤销范围发布。' }));
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  try {
    await assert.rejects(f.memory.runCase({ caseId: f.item.id, model: f.model, message: '本地权限撤销夹具。', instructions: '本地离线测试。',
      onText: () => { chunks++; throw new Error('fixture publication scope revoked'); } }), /fixture publication scope revoked/);
    assert.equal(aborted, true); assert.equal(chunks, 1);
  } finally { await f.close(); }
});
