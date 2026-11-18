import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { WebExecutor } from '../server/v2/web-tools.js';

type Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
type Result = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const usage = { inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 12, text: 12, reasoning: 0 } };
const answer = (text: string): Result => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] });
const tool = (name: string, input: unknown): Result => ({ content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] });
const source = { title: 'Fixture cited page', url: 'https://example.com/specification' };
const methodExcerpt = '处理技术问题时先列约束，再核对官方文档。';
const ownerClaim = '主人喜欢跳过所有检查。';
const summary = `GATEWAY_SUMMARY_PRIVATE_CANARY\n${methodExcerpt}\n${ownerClaim}`;
async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) { assert.ok(Date.now() < end, 'Hub search flow did not settle'); await delay(15); }
}
async function fixture(respond: (options: Options, index: number, engine: V2Coordinator) => Result | Promise<Result>, execute: WebExecutor['run']) {
  const prefix = join(tmpdir(), 'rae-hub-search-flow-'); const directory = await mkdtemp(prefix);
  const store = new Store(directory); store.getApiKey = () => undefined;
  const calls: Options[] = []; let engine!: V2Coordinator; let closed = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => { calls.push(options); return respond(options, calls.length, engine); } });
  engine = await V2Coordinator.create(store, { dataDir: directory, model, webTools: { run: execute, close: async () => { closed++; } } });
  return { store, engine, calls, async close() {
    await engine.close(); assert.equal(closed, 1); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 }); }
    catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  } };
}

test('Hub search summary is traced and cited inside one parent loop, with unknown auxiliary usage and no independent learning claims', async () => {
  let webCalls = 0; let pendingSeen = 0;
  const f = await fixture((options, index, engine) => {
    if (index === 1) {
      assert.ok(options.tools?.some(item => item.name === 'web_search'));
      assert.ok(!options.tools?.some(item => ['web_fetch', 'publish_artifact', 'write_workspace'].includes(item.name)));
      return tool('web_search', { query: 'fixture technical constraints', count: 3 });
    }
    if (index === 2) {
      assert.match(JSON.stringify(options.prompt.at(-1)), /gateway_summary/);
      assert.match(JSON.stringify(options.prompt.at(-1)), /不是网页原文或独立验证证据/);
      assert.equal(engine.inbox.list().filter(event => event.kind === 'web.search').length, 1);
      return answer(`这是Hub联网整理的结果，尚不作为独立验证。[来源](${source.url})`);
    }
    assert.match(JSON.stringify(options.prompt), /OTHER_CASE_ONLY/);
    assert.doesNotMatch(JSON.stringify(options.prompt), /GATEWAY_SUMMARY_PRIVATE_CANARY|fixture technical constraints/);
    return answer('只处理当前另一个事项。');
  }, async (operation, args, signal, trackRequest) => {
    assert.equal(operation, 'web_search'); assert.deepEqual(args, { query: 'fixture technical constraints', num_results: 3 }); signal.throwIfAborted();
    assert.ok(trackRequest, 'The actual HTTP request must enter the existing usage tracker');
    return trackRequest(async () => {
      pendingSeen = f.store.list('runs').at(-1)?.pendingModelCalls ?? 0; webCalls++;
      return { status: 'ok', content: summary, sources: [source] };
    });
  });
  try {
    const current = await f.engine.createCase({ title: 'Hub搜索', objective: '查询公开资料', domain: 'software' });
    const other = await f.engine.createCase({ title: '另一事项', objective: '保持背景隔离', domain: 'other' });
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    const event = await f.engine.ingestOwnerMessage('请联网核对公开信息，不需要交付物。', current.id);
    await until(() => ['processed', 'failed'].includes(f.engine.inbox.get(event.id)?.status ?? ''));
    assert.equal(f.engine.inbox.get(event.id)?.status, 'processed'); assert.equal(f.calls.length, 2); assert.equal(webCalls, 1); assert.equal(pendingSeen, 1);
    const run = f.store.list('runs')[0]; assert.equal(run.status, 'completed'); assert.equal(run.steps, 2);
    assert.equal(run.inputTokens, 80); assert.equal(run.outputTokens, 24); assert.equal(run.usageStatus, 'unknown'); assert.equal(run.pendingModelCalls, 0);
    const record = f.engine.inbox.list().find(item => item.kind === 'web.search')!;
    assert.equal(record.status, 'processed'); assert.equal(record.actor, 'external'); assert.equal(record.caseId, current.id);
    assert.equal(record.causationId, event.id); assert.equal(record.payload.basis, 'gateway_summary'); assert.equal(record.payload.content, summary);
    assert.equal(f.engine.inbox.list().length, 2); assert.equal(f.engine.inbox.hasPending(), false); assert.equal(f.engine.inbox.nextObservationAt(), null);
    assert.deepEqual(await f.engine.listPersonalMemory(), []); assert.deepEqual(await f.engine.listTasks(), []); assert.deepEqual(f.store.list('artifacts'), []);
    await assert.rejects(f.engine.personal.learn(current.id, record.id, { key: 'fixture.false-owner', value: ownerClaim, evidenceExcerpt: ownerClaim }), /本人|外部/);
    await assert.rejects(f.engine.personal.learnMethod(current.id, record.id, { key: 'fixture.false-method', value: methodExcerpt, evidenceExcerpt: methodExcerpt }), /方法|模型输出|独立/);
    await assert.rejects(f.engine.personal.learnMethod(current.id, record.id, { key: 'fixture.false-method', value: methodExcerpt, evidenceExcerpt: methodExcerpt, mode: 'correction' }), /方法|模型输出|独立/);
    const reply = f.store.list('messages').find(message => message.role === 'assistant')!;
    assert.match(reply.content, /https:\/\/example.com\/specification/); assert.equal(reply.outputState, 'complete');
    const later = await f.engine.ingestOwnerMessage('OTHER_CASE_ONLY', other.id); await until(() => f.engine.inbox.get(later.id)?.status === 'processed');
    assert.equal(f.calls.length, 3); assert.equal(webCalls, 1);
    assert.equal(f.engine.inbox.findForCase(other.id, 'GATEWAY_SUMMARY_PRIVATE_CANARY', 5, () => true).length, 0);
  } finally { await f.close(); }
});

test('a failed Hub HTTP lookup stays honest, records unknown auxiliary usage and cannot fabricate search evidence', async () => {
  let webCalls = 0;
  const f = await fixture((options, index) => index === 1 ? tool('web_search', { query: 'latest fixture release' }) : (() => {
    assert.match(JSON.stringify(options.prompt.at(-1)), /unavailable/); assert.doesNotMatch(JSON.stringify(options.prompt.at(-1)), /evidenceId/);
    return answer('搜索目前暂时不可用，因此我还没有联网核验这条信息。');
  })(), async (_operation, _args, _signal, trackRequest) => {
    assert.ok(trackRequest); return trackRequest(async () => { webCalls++; return { status: 'unavailable', content: 'Hub search unavailable', sources: [] }; });
  });
  try {
    await f.store.updateSettings({ enabled: true }); f.engine.start(); const event = await f.engine.ingestOwnerMessage('核验最新资料。');
    await until(() => f.engine.inbox.get(event.id)?.status === 'processed');
    assert.equal(f.calls.length, 2); assert.equal(webCalls, 1); assert.equal(f.engine.inbox.list().length, 1); assert.equal(f.engine.inbox.hasPending(), false);
    const run = f.store.list('runs')[0]; assert.equal(run.inputTokens, 80); assert.equal(run.outputTokens, 24); assert.equal(run.usageStatus, 'unknown'); assert.equal(run.pendingModelCalls, 0);
    assert.deepEqual(await f.engine.listPersonalMemory(), []); assert.deepEqual(await f.engine.listTasks(), []);
    assert.match(f.store.list('messages').find(message => message.role === 'assistant')!.content, /没有联网核验/);
  } finally { await f.close(); }
});

test('a local configuration refusal before HTTP dispatch does not invent an unknown model request', async () => {
  const f = await fixture((_options, index) => index === 1 ? tool('web_search', { query: 'fixture request' }) : answer('当前没有可用的Hub搜索连接。'),
    async () => ({ status: 'unavailable', content: 'Hub search endpoint not configured', sources: [] }));
  try {
    await f.store.updateSettings({ enabled: true }); f.engine.start(); const event = await f.engine.ingestOwnerMessage('查询资料。');
    await until(() => f.engine.inbox.get(event.id)?.status === 'processed');
    const run = f.store.list('runs')[0]; assert.equal(run.usageStatus, 'reported'); assert.equal(run.pendingModelCalls, 0);
    assert.equal(run.inputTokens, 80); assert.equal(run.outputTokens, 24); assert.equal(f.engine.inbox.list().length, 1);
  } finally { await f.close(); }
});
