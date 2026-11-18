import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ModelConnection, ModelSelection } from '../shared/model-connections.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const answer = (text = '已处理本轮合成资料。') => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const tool = (name: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: name, input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' } });
const selection = (connection: ModelConnection, modelId: string): ModelSelection => ({ connectionId: connection.id, modelId, reasoning: 'none', maxOutputTokens: null });
async function until(check: () => boolean, explanation: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < deadline, explanation); await delay(10); }
}
async function fixture(model?: LanguageModelV4) {
  const prefix = join(tmpdir(), 'rae-model-binding-runtime-'); const directory = await mkdtemp(prefix); const store = new Store(directory);
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  return { directory, store, get runtime() { return runtime; }, async reopen() {
    await runtime.close(); runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  }, async close() {
    await runtime.close(); store.close(); const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
    catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
  } };
}
async function setGlobal(f: Awaited<ReturnType<typeof fixture>>, value: ModelSelection | null) {
  return f.runtime.modelConnections.defaults({ global: value, expectedRevision: f.store.models.getDefaults().revision });
}
async function apiConnection(f: Awaited<ReturnType<typeof fixture>>, name: string, endpoint = 'https://offline.invalid/v1', apiKey?: string) {
  return f.runtime.modelConnections.save({ name, kind: 'api-key', protocol: 'deepseek', endpoint, ...(apiKey ? { apiKey } : {}) });
}
async function localProvider() {
  const requests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ authorization: request.headers.authorization, body });
    const base = { id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '合成接口已处理。', reasoning_content: '' }, finish_reason: null }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
  return { endpoint, requests, close: () => new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }) };
}

test('accepted messages retain scene bindings through queueing, default edits and runtime recovery', async () => {
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => answer() }));
  try {
    const first = await apiConnection(f, 'First'), second = await apiConnection(f, 'Second');
    await setGlobal(f, selection(first, 'model-first'));
    const scene = await f.runtime.createCase({ title: '绑定队列', objective: '检验受理时固定选择', domain: 'fixture' });
    const accepted = await f.runtime.ingestOwnerMessage('FIRST_BINDING_MESSAGE', scene.id);
    const saved = f.store.get('messages', accepted.externalId)!;
    assert.equal(saved.modelBinding?.selection.connectionId, first.id);
    assert.deepEqual(accepted.payload.modelBinding, saved.modelBinding);
    await setGlobal(f, selection(second, 'model-second'));
    const later = await f.runtime.ingestOwnerMessage('SECOND_BINDING_MESSAGE', scene.id);
    await f.reopen();
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => [accepted, later].every(event => f.runtime.inbox.get(event.id)?.status === 'processed'), 'Both accepted messages must finish');
    const runs = f.store.list('runs');
    assert.equal(runs.find(run => run.eventId === accepted.id)?.modelBinding?.selection.connectionId, first.id);
    assert.equal(runs.find(run => run.eventId === later.id)?.modelBinding?.selection.connectionId, second.id);
    assert.equal(runs.filter(run => run.status === 'completed').length, 2);
  } finally { await f.close(); }
});

test('reconstructing an event after accepted-message persistence does not resolve a newer default', async () => {
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => answer() }));
  try {
    const first = await apiConnection(f, 'First'), second = await apiConnection(f, 'Second');
    await setGlobal(f, selection(first, 'before-crash'));
    const scene = await f.runtime.createCase({ title: '受理恢复', objective: '消息已存但事件未存的故障点', domain: 'fixture' });
    const ingest = f.runtime.inbox.ingest.bind(f.runtime.inbox);
    f.runtime.inbox.ingest = input => { if (input.kind === 'owner.message') throw new Error('injected event persistence failure'); return ingest(input); };
    await assert.rejects(f.runtime.ingestOwnerMessage('ACCEPTED_BEFORE_EVENT', scene.id), /injected event/);
    f.runtime.inbox.ingest = ingest;
    const accepted = f.store.list('messages').find(message => message.content === 'ACCEPTED_BEFORE_EVENT')!;
    assert.equal(accepted.modelBinding?.selection.connectionId, first.id);
    await setGlobal(f, selection(second, 'after-crash'));
    await f.reopen();
    const event = f.runtime.inbox.list().find(item => item.externalId === accepted.id)!;
    assert.ok(event); assert.deepEqual(event.payload.modelBinding, accepted.modelBinding);
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.runtime.inbox.get(event.id)?.status === 'processed', 'Recovered accepted event must finish');
    assert.equal(f.store.list('runs').find(run => run.eventId === event.id)?.modelBinding?.selection.modelId, 'before-crash');
  } finally { await f.close(); }
});

test('changing a default does not cancel an in-flight turn or rewrite its accepted binding', async () => {
  let release!: () => void; const gate = new Promise<void>(done => { release = done; }); let entered = false; let aborted = false;
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async options => {
    entered = true; options.abortSignal?.addEventListener('abort', () => { aborted = true; }, { once: true }); await gate; return answer();
  } }));
  try {
    const first = await apiConnection(f, 'First'), second = await apiConnection(f, 'Second'); await setGlobal(f, selection(first, 'old-default'));
    const scene = await f.runtime.createCase({ title: '在途设置', objective: '默认变化不取消运行', domain: 'fixture' });
    const event = await f.runtime.ingestOwnerMessage('HELD_IN_FLIGHT', scene.id);
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => entered, 'Model must reach the deterministic gate');
    await setGlobal(f, selection(second, 'new-default'));
    assert.equal(aborted, false); assert.equal(f.runtime.inbox.get(event.id)?.status, 'leased');
    release(); await until(() => f.runtime.inbox.get(event.id)?.status === 'processed', 'Original turn must complete');
    assert.equal(f.store.list('runs').find(run => run.eventId === event.id)?.modelBinding?.selection.connectionId, first.id);
  } finally { release(); await f.close(); }
});

test('autonomous observation uses the background default while owner growth-mode conversation uses its scene', async () => {
  let evidenceId = '';
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async options => options.tools?.some(item => item.name === 'finish_review')
    ? tool('finish_review', { outcome: 'silent', evidenceIds: [evidenceId] }) : answer() }));
  try {
    const foreground = await apiConnection(f, 'Foreground'), background = await apiConnection(f, 'Background');
    await setGlobal(f, selection(foreground, 'foreground-model'));
    await f.runtime.modelConnections.defaults({ background: { mode: 'explicit', selection: selection(background, 'background-model') }, expectedRevision: f.store.models.getDefaults().revision });
    const scene = await f.runtime.createCase({ title: '同场景两种用途', objective: '区分自主回顾和本人交流', domain: 'fixture' });
    const directory = join(f.directory, 'observed'); await mkdir(directory); await writeFile(join(directory, 'README.md'), '合成资料：今天的讨论需要核查证据。');
    await f.runtime.registerWorkspaceSource({ sourceId: 'binding-observation', root: directory, caseId: scene.id, include: ['README.md'] });
    evidenceId = f.runtime.inbox.list().find(event => event.kind === 'workspace.file')!.id;
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.runtime.inbox.get(evidenceId)?.status === 'processed', 'Observed file must be captured without inference');
    f.runtime.request('manual');
    await until(() => f.store.list('runs').some(run => run.trigger === 'source' && run.status === 'completed'), 'Background review must complete');
    const owner = await f.runtime.ingestOwnerMessage('OWNER_FOREGROUND_MESSAGE', scene.id);
    await until(() => f.runtime.inbox.get(owner.id)?.status === 'processed', 'Owner conversation must complete');
    const review = f.store.list('runs').find(run => run.trigger === 'source')!, chat = f.store.list('runs').find(run => run.eventId === owner.id)!;
    assert.equal(review.mode, 'growth'); assert.equal(chat.mode, 'growth');
    assert.equal(review.modelBinding?.selection.connectionId, background.id);
    assert.equal(review.modelBinding?.source, 'background');
    assert.equal(chat.modelBinding?.selection.connectionId, foreground.id);
    assert.equal(chat.modelBinding?.purpose, 'conversation');
  } finally { await f.close(); }
});

test('an approved background task preserves its admission binding when the scene and background defaults change', async () => {
  let calls = 0;
  const f = await fixture(new MockLanguageModelV4({ doGenerate: async () => ++calls === 1
    ? tool('publish_artifact', { title: '合成任务成果', content: 'TASK_BINDING_RESULT', format: 'markdown' }) : answer('成果已保存。') }));
  try {
    const first = await apiConnection(f, 'Task origin'), second = await apiConnection(f, 'New selection');
    await setGlobal(f, selection(first, 'task-origin-model'));
    const scene = await f.runtime.createCase({ title: '任务来源', objective: '保持获准任务的原始选择', domain: 'fixture' });
    const task = await f.runtime.requestTask({ requestId: randomUUID(), spec: { caseId: scene.id, title: '合成文本委托', objective: '保存明确获准的合成结果',
      expectedOutput: '一份文本成果', capabilities: ['artifact'] } });
    assert.equal(task.modelBinding?.selection.connectionId, first.id);
    await f.runtime.modelConnections.scene(scene.id, { preference: { mode: 'explicit', selection: selection(second, 'new-scene-model') }, expectedRevision: 0 });
    await f.runtime.modelConnections.defaults({ background: { mode: 'explicit', selection: selection(second, 'new-background-model') }, expectedRevision: f.store.models.getDefaults().revision });
    await f.reopen(); await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.runtime.consent.get(task.id)?.state === 'completed', 'Original approved task must complete');
    const run = f.store.list('runs').find(item => item.taskId === task.id)!;
    assert.equal(run.modelBinding?.selection.connectionId, first.id);
    assert.equal(run.modelBinding?.selection.modelId, 'task-origin-model');
    assert.equal(f.store.list('artifacts')[0]?.content, 'TASK_BINDING_RESULT');
  } finally { await f.close(); }
});

test('valid scene connections bypass an unavailable global and isolate local provider credentials and context', async () => {
  const upstream = await localProvider(); const f = await fixture();
  try {
    const unavailable = await apiConnection(f, 'Unavailable global'); await setGlobal(f, selection(unavailable, 'unavailable-model'));
    const one = await apiConnection(f, 'Account one', upstream.endpoint, 'fixture-account-one'), two = await apiConnection(f, 'Account two', upstream.endpoint, 'fixture-account-two');
    const first = await f.runtime.createCase({ title: '场景甲', objective: '只处理甲的资料', domain: 'fixture' });
    const second = await f.runtime.createCase({ title: '场景乙', objective: '只处理乙的资料', domain: 'fixture' });
    await f.runtime.modelConnections.scene(first.id, { preference: { mode: 'explicit', selection: selection(one, 'account-one-model') }, expectedRevision: 0 });
    await f.runtime.modelConnections.scene(second.id, { preference: { mode: 'explicit', selection: selection(two, 'account-two-model') }, expectedRevision: 0 });
    const oneEvent = await f.runtime.ingestOwnerMessage('ACCOUNT_ONE_PRIVATE_SENTINEL', first.id), twoEvent = await f.runtime.ingestOwnerMessage('ACCOUNT_TWO_PRIVATE_SENTINEL', second.id);
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => [oneEvent, twoEvent].every(event => f.runtime.inbox.get(event.id)?.status === 'processed'), 'Both valid scene overrides must finish');
    assert.equal(upstream.requests.length, 2);
    const firstRequest = upstream.requests.find(request => request.body.model === 'account-one-model')!;
    const secondRequest = upstream.requests.find(request => request.body.model === 'account-two-model')!;
    assert.equal(firstRequest.authorization, 'Bearer fixture-account-one'); assert.equal(secondRequest.authorization, 'Bearer fixture-account-two');
    assert.match(JSON.stringify(firstRequest.body), /ACCOUNT_ONE_PRIVATE_SENTINEL/); assert.doesNotMatch(JSON.stringify(firstRequest.body), /ACCOUNT_TWO_PRIVATE_SENTINEL/);
    assert.match(JSON.stringify(secondRequest.body), /ACCOUNT_TWO_PRIVATE_SENTINEL/); assert.doesNotMatch(JSON.stringify(secondRequest.body), /ACCOUNT_ONE_PRIVATE_SENTINEL/);
    assert.equal(f.store.list('runs').filter(run => run.status === 'completed').length, 2);
  } finally { await f.close(); await upstream.close(); }
});

test('a message accepted with no model binding cannot silently acquire a later global selection', async () => {
  const upstream = await localProvider(); const f = await fixture();
  try {
    await setGlobal(f, null);
    const scene = await f.runtime.createCase({ title: '尚未选择模型', objective: '未配置消息保留明确状态', domain: 'fixture' });
    const accepted = await f.runtime.ingestOwnerMessage('ACCEPTED_WITHOUT_MODEL', scene.id);
    assert.equal(f.store.get('messages', accepted.externalId)?.modelBinding, null);
    const connection = await apiConnection(f, 'Later configured', upstream.endpoint, 'fixture-later-key'); await setGlobal(f, selection(connection, 'later-model'));
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.store.list('runs').some(run => run.eventId === accepted.id && run.status !== 'running'), 'Unconfigured accepted run must finish with an explicit setup error');
    assert.equal(upstream.requests.length, 0);
    assert.equal(f.store.list('runs').find(run => run.eventId === accepted.id)?.modelBinding, null);
  } finally { await f.close(); await upstream.close(); }
});
