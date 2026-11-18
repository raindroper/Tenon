import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockEmbeddingModelV4 } from 'ai/test';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { SIWC_ISSUER } from '../server/models/siwc.js';
import type { ModelCatalogEntry, ModelDirectory, ModelProtocol, ModelSelection } from '../shared/model-connections.js';
import type { SceneMemoryOptions } from '../server/v2/memory.js';
import { ProjectBroker, projectSpecHash } from '../server/devices/projects.js';
import { localProjectCapability, localProjectSpecSchema, type ProjectExecutionInput } from '../shared/local-project.js';
import { forwardProjectModel } from '../server/v2/project-model.js';
import { UsageTracker } from '../server/v2/usage.js';
import type { Run } from '../shared/types.js';

type Body = Record<string, unknown>;
type Role = 'actor' | 'observer' | 'reflector';
interface Capture { url: string; authorization: string | undefined; body: Body; role: Role }
type Reply = { text: string } | { tool: string; input: unknown };
const object = (value: unknown): value is Body => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const observations = '<observations>\nDate: Nov 14, 2026\n'
  + '* 🔴 (09:00) 本人确认合成演示在十六日上午进行，使用园区西楼的会议室。\n'
  + '* 🟡 (09:00) 合成演示使用旧版样品核对投影连线，资料只有内部确认后才能定稿。\n</observations>';
const reflection = '<observations>\n* 🔴 合成演示在十六日上午进行，入场安排待确认。\n</observations>';
function roleFor(body: Body): Role {
  const text = JSON.stringify(body.input ?? body.messages);
  return text.includes('Your memory observation reflections') ? 'reflector'
    : text.includes('Your observations will be the ONLY information') ? 'observer' : 'actor';
}
function toolNames(tools: unknown): string[] {
  return Array.isArray(tools) ? tools.flatMap(value => !object(value) ? [] : value.type === 'namespace' ? toolNames(value.tools)
    : typeof value.name === 'string' ? [value.name] : object(value.function) && typeof value.function.name === 'string' ? [value.function.name] : []) : [];
}
const end = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
async function until(predicate: () => boolean, note: string) {
  const deadline = performance.now() + 15_000;
  while (!predicate()) { assert.ok(performance.now() < deadline, note); await delay(10); }
}
function responsePayload(capture: Capture, reply: Reply): { stream: boolean; value: string } {
  const body = capture.body, id = randomUUID();
  if (capture.url.endsWith('/responses')) {
    assert.equal(body.stream, true, 'Rae actor/auxiliary Responses transport must stream');
    const item = 'tool' in reply ? { type: 'function_call', id: 'item-' + id, call_id: id, name: reply.tool,
      ...(capture.url.includes('/siwc/') ? { namespace: 'rae' } : {}), arguments: JSON.stringify(reply.input) }
      : { type: 'message', id: 'item-' + id, role: 'assistant', content: [{ type: 'output_text', text: reply.text, annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id, created_at: 1, model: body.model } },
      { type: 'response.output_item.added', output_index: 0, item: 'tool' in reply ? { ...item, arguments: '' } : { ...item, content: [] } },
      'tool' in reply ? { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: JSON.stringify(reply.input) }
        : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: reply.text },
      { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed' } },
      { type: 'response.completed', response: { id, model: body.model, status: 'completed', output: [item],
        usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 } } },
    ];
    return { stream: true, value: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') };
  }
  const usage = { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 };
  const tool = 'tool' in reply ? { id, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.input) } } : undefined;
  const message = { role: 'assistant', reasoning_content: '', ...(tool ? { content: null, tool_calls: [tool] } : { content: 'text' in reply ? reply.text : '' }) };
  if (body.stream !== true) return { stream: false, value: JSON.stringify({ id, object: 'chat.completion', model: body.model, created: 1,
    choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }) };
  const base = { id, object: 'chat.completion.chunk', created: 1, model: body.model };
  return { stream: true, value: 'data: ' + JSON.stringify({ ...base, choices: [{ index: 0,
    delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, ...tool }] } : message, finish_reason: null }] }) + '\n\n'
    + 'data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }) + '\n\ndata: [DONE]\n\n' };
}

/** Uses actual HTTP owner commands, Mastra and installed provider SDKs. Only the remote provider is simulated. */
async function fixture(memory: SceneMemoryOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-routing-wire-'));
  const store = new Store(directory); const requests: Capture[] = []; let evidenceId = '';
  let responder: ((request: Capture) => Reply | Promise<Reply>) | undefined;
  const upstream = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/deepseek/v1/models') {
        assert.equal(request.headers.authorization, 'Bearer fixture-catalog');
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [
          { id: 'wire-catalog', context_window: 1_048_576 }, { id: 'unknown-window' }, { id: 'invalid-window', context_window: -100 },
        ] }));
        return;
      }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: Body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const captured: Capture = { url: request.url!, authorization: request.headers.authorization, body, role: roleFor(body) };
      requests.push(captured);
      const reply = responder ? await responder(captured) : captured.role === 'observer' ? { text: observations }
        : captured.role === 'reflector' ? { text: reflection }
        : toolNames(body.tools).includes('finish_review') ? { tool: 'finish_review', input: { outcome: 'silent', evidenceIds: [evidenceId] } }
        : { text: '合成请求已完成。' };
      const result = responsePayload(captured, reply);
      response.writeHead(200, { 'Content-Type': result.stream ? 'text/event-stream' : 'application/json' }); response.end(result.value);
    } catch { response.writeHead(500).end('Fixture provider failed'); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + (upstream.address() as { port: number }).port;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://api.openai.com/v1/responses') return originalFetch(endpoint + '/siwc/v1/responses', init);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'No real provider or credential endpoint is permitted');
    return originalFetch(input, init);
  };
  let runtime = await V2Coordinator.create(store, { dataDir: directory, connectorProviders: {}, memory });
  const failures: unknown[] = [];
  const observeFailures = () => {
    const execute = runtime.memory.runCase.bind(runtime.memory);
    runtime.memory.runCase = input => execute(input).catch(error => { failures.push(error); throw error; });
  };
  observeFailures();
  let app = createApp({ store, runtime });
  const listen = () => new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve)); await listen();
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const address = app.address() as { port: number }; const origin = 'http://127.0.0.1:' + address.port;
    const response = await originalFetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const result = await response.json(); assert.ok(response.ok, path + ': ' + JSON.stringify(result)); return result as T;
  }
  async function processed(id: string) {
    try { await until(() => ['processed', 'failed'].includes(runtime.inbox.get(id)?.status ?? ''), 'Run must reach its terminal event'); }
    catch (error) { throw new Error(String(failures.at(-1) ?? error)); }
    const event = runtime.inbox.get(id)!; assert.equal(event.status, 'processed', String(failures.at(-1) ?? event.lastError ?? 'Run did not complete'));
    return store.list('runs').filter(run => run.eventId === id).at(-1)!;
  }
  return { store, requests, api, directory, get runtime() { return runtime; },
    set responder(value: typeof responder) { responder = value; },
    async connection(protocol: ModelProtocol, label: string): Promise<ModelSelection> {
      const created = await api<{ id: string; credentialVersion: number }>('/api/models/connections', 'POST', protocol === 'siwc-responses'
        ? { name: label, kind: 'siwc', protocol }
        : { name: label, kind: 'api-key', protocol, endpoint: endpoint + '/' + protocol + '/v1', apiKey: 'fixture-' + label });
      if (protocol === 'siwc-responses') store.models.setOAuthCredentials(created.id, { kind: 'siwc', issuer: SIWC_ISSUER, clientId: 'fixture-' + label,
        subject: 'fixture-owner-' + label, accessToken: 'fixture-' + label, refreshToken: 'fixture-refresh-' + label,
        scope: 'openid chatgpt.tokens.use.direct', expiresAt: Date.now() + 3600_000 }, { expectedCredentialVersion: created.credentialVersion });
      return { connectionId: created.id, modelId: 'wire-' + label, reasoning: 'low', maxOutputTokens: null };
    },
    global: (selection: ModelSelection | null) => api('/api/models/defaults', 'PATCH', { global: selection, expectedRevision: store.models.getDefaults().revision }),
    background: (selection?: ModelSelection) => api('/api/models/defaults', 'PATCH', { background: selection ? { mode: 'explicit', selection } : { mode: 'inherit-global' }, expectedRevision: store.models.getDefaults().revision }),
    scene: (id: string, selection?: ModelSelection) => api('/api/models/scenes/' + id, 'PATCH', { preference: selection ? { mode: 'explicit', selection } : { mode: 'inherit-global' }, expectedRevision: store.models.getScene(id).revision }),
    createScene: (name: string) => api<{ id: string }>('/api/cases', 'POST', { title: name, objective: '隔离的模型路由验证', domain: 'fixture' }),
    async send(sceneId: string, content = '请核对当前合成问题。', reasoningEffort?: string) {
      const message = await api<{ id: string }>('/api/messages', 'POST', { caseId: sceneId, content, ...(reasoningEffort ? { reasoningEffort } : {}) });
      const event = runtime.inbox.list().find(item => item.externalId === message.id && item.kind === 'owner.message')!;
      return event.id;
    }, processed,
    async enable() { await store.updateSettings({ enabled: true }); runtime.start(); },
    async reopen() { await end(app); await runtime.close(); runtime = await V2Coordinator.create(store, { dataDir: directory, connectorProviders: {}, memory }); observeFailures(); app = createApp({ store, runtime }); await listen(); },
    async review(sceneId: string) {
      const sourceId = randomUUID(); const root = join(directory, sourceId); await mkdir(root); await writeFile(join(root, 'README.md'), '合成资料：需要核对本周演示计划。');
      await runtime.registerWorkspaceSource({ sourceId, root, caseId: sceneId, include: ['README.md'] });
      evidenceId = runtime.inbox.list().find(event => event.sourceId === sourceId && event.kind === 'workspace.file')!.id;
      await until(() => runtime.inbox.get(evidenceId)?.status === 'processed', 'Source must be captured');
      const old = new Set(store.list('runs').map(run => run.id)); runtime.request('manual');
      await until(() => store.list('runs').some(run => !old.has(run.id) && run.trigger === 'source' && run.status !== 'running'), 'Review must complete');
      const run = store.list('runs').find(run => !old.has(run.id) && run.trigger === 'source')!;
      assert.equal(run.status, 'completed', String(failures.at(-1) ?? run.error)); return run;
    },
    async close() { try { await end(app); await runtime.close(); } finally { store.close(); globalThis.fetch = originalFetch; await end(upstream); } },
  };
}

function assertWire(request: Capture, selected: ModelSelection, protocol: ModelProtocol, expectedEffort = selected.reasoning) {
  assert.equal(request.body.model, selected.modelId);
  const label = selected.modelId.replace(/^wire-/, '');
  assert.equal(request.authorization, 'Bearer fixture-' + label);
  assert.equal(request.url, '/' + (protocol === 'siwc-responses' ? 'siwc' : protocol) + '/v1/' + (protocol.endsWith('responses') ? 'responses' : 'chat/completions'));
  if (protocol === 'deepseek') {
    assert.deepEqual(request.body.thinking, expectedEffort === 'default' ? undefined : { type: expectedEffort === 'none' ? 'disabled' : 'enabled' });
    assert.equal(request.body.reasoning_effort, ['none', 'default'].includes(expectedEffort) ? undefined : expectedEffort);
  } else if (protocol.endsWith('responses')) assert.equal(object(request.body.reasoning) ? request.body.reasoning.effort : undefined, expectedEffort === 'default' ? undefined : expectedEffort);
  else assert.equal(request.body.reasoning_effort, expectedEffort === 'default' ? undefined : expectedEffort);
  if (protocol === 'siwc-responses') { assert.equal(request.body.stream, true); assert.equal(request.body.store, false); }
}

test('catalog refresh exposes the DeepSeek context window while inference stays paused', async () => {
  const f = await fixture();
  try {
    const selected = await f.connection('deepseek', 'catalog');
    const entries = await f.api<ModelCatalogEntry[]>(`/api/models/connections/${selected.connectionId}/catalog`, 'POST', {});
    assert.deepEqual(entries.map(({ id, contextWindow }) => [id, contextWindow]),
      [['wire-catalog', 1_048_576], ['unknown-window', undefined], ['invalid-window', undefined]]);
    const directory = await f.api<ModelDirectory>('/api/models');
    assert.deepEqual(directory.connections.find(connection => connection.id === selected.connectionId)?.models, entries);
    assert.equal(f.store.models.resolve({ purpose: 'task', selection: selected })?.contextWindow, 1_048_576);
    assert.equal(f.store.getSettings().enabled, false);
    assert.deepEqual(f.requests, []);
  } finally { await f.close(); }
});

for (const protocol of ['deepseek', 'openai-chat', 'openai-responses', 'siwc-responses'] as const) {
  test(`${protocol}: global, background and scene settings reach the actual SDK request`, async () => {
    const f = await fixture();
    try {
      const global = await f.connection(protocol, 'global');
      const background = { ...await f.connection(protocol, 'background'), reasoning: 'high' };
      const scene = { ...await f.connection(protocol, 'scene'), reasoning: protocol === 'deepseek' ? 'max' : protocol === 'openai-chat' ? 'medium' : 'ultra' };
      await f.global(global); await f.background(background);
      const inherited = await f.createScene('跟随全局'), overridden = await f.createScene('场景覆盖');
      await f.scene(overridden.id, scene); await f.enable();
      let index = f.requests.length; const first = await f.processed(await f.send(inherited.id));
      assert.equal(first.modelBinding?.source, 'global'); assertWire(f.requests[index], global, protocol);
      index = f.requests.length; const second = await f.processed(await f.send(overridden.id));
      assert.equal(second.modelBinding?.source, 'scene'); assertWire(f.requests[index], scene, protocol);
      index = f.requests.length; const review = await f.review(overridden.id);
      assert.equal(review.modelBinding?.source, 'background'); assertWire(f.requests[index], background, protocol);
      assert.equal(review.reasoning?.effort, 'high');
      await f.background(); index = f.requests.length;
      const inheritedReview = await f.review(overridden.id);
      assert.equal(inheritedReview.modelBinding?.source, 'global'); assertWire(f.requests[index], global, protocol);
      const changed = { ...global, reasoning: 'high' }; await f.global(changed);
      index = f.requests.length; await f.processed(await f.send(inherited.id)); assertWire(f.requests[index], changed, protocol);
      index = f.requests.length; await f.processed(await f.send(overridden.id)); assertWire(f.requests[index], scene, protocol);
      await f.scene(overridden.id); index = f.requests.length;
      await f.processed(await f.send(overridden.id)); assertWire(f.requests[index], changed, protocol);
    } finally { await f.close(); }
  });
}

test('queued messages retain their original model and effort on the wire after configuration changes and recovery', async () => {
  const f = await fixture();
  try {
    const original = { ...await f.connection('siwc-responses', 'original'), reasoning: 'ultra' };
    const later = { ...await f.connection('deepseek', 'later'), reasoning: 'max' };
    await f.global(original); const scene = await f.createScene('排队恢复');
    const first = await f.send(scene.id, 'FIRST_ACCEPTED_SENTINEL'); await f.global(later);
    const second = await f.send(scene.id, 'SECOND_ACCEPTED_SENTINEL'); await f.reopen(); await f.enable();
    await f.processed(first); await f.processed(second);
    assert.equal(f.requests.length, 2); assertWire(f.requests[0], original, 'siwc-responses'); assertWire(f.requests[1], later, 'deepseek');
  } finally { await f.close(); }
});

test('tool continuation keeps the selected SIWC model and effort while defaults change in flight', async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const original = { ...await f.connection('siwc-responses', 'tool-origin'), reasoning: 'max' };
    const later = { ...await f.connection('deepseek', 'tool-next'), reasoning: 'low' };
    await f.global(original); const scene = await f.createScene('工具续步');
    f.responder = async () => {
      if (f.requests.length === 1) { await gate; return { tool: 'list_tasks', input: {} }; }
      return { text: '已核对当前任务。' };
    };
    await f.enable(); const event = await f.send(scene.id);
    await until(() => f.requests.length === 1, 'First request must be held by the deterministic gate');
    await f.global(later); release(); await f.processed(event);
    assert.equal(f.requests.length, 2); f.requests.forEach(request => assertWire(request, original, 'siwc-responses'));
    await f.processed(await f.send(scene.id)); assertWire(f.requests[2], later, 'deepseek');
  } finally { release(); await f.close(); }
});

test('native observer and reflector use the current scene model and effort, not the autonomous background default', async () => {
  const embedder = new MockEmbeddingModelV4({ doEmbed: async ({ values }) => ({ embeddings: values.map(() => Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0)), warnings: [] }) });
  const f = await fixture({ embedder, observationTokens: 48, reflectionTokens: 120 });
  try {
    const selected = { ...await f.connection('siwc-responses', 'memory-scene'), reasoning: 'high' };
    await f.global(await f.connection('deepseek', 'other-global')); await f.background(await f.connection('deepseek', 'other-background'));
    const scene = await f.createScene('附带记忆'); await f.scene(scene.id, selected); await f.enable();
    await f.processed(await f.send(scene.id, '合成演示在十六日上午进行。'.repeat(80)));
    await f.processed(await f.send(scene.id, '请接着核对演示准备。'));
    assert.deepEqual(f.requests.map(request => request.role), ['actor', 'observer', 'reflector', 'actor']);
    f.requests.forEach(request => assertWire(request, selected, 'siwc-responses'));
  } finally { await f.close(); }
});

test('an approved asynchronous task uses its admitted scene model and effort on every request', async () => {
  const f = await fixture();
  try {
    const selected = { ...await f.connection('siwc-responses', 'approved-scene'), reasoning: 'ultra' };
    const alternate = { ...await f.connection('deepseek', 'other-task-default'), reasoning: 'none' };
    await f.global(alternate); await f.background(alternate);
    const scene = await f.createScene('获准后台执行'); await f.scene(scene.id, selected);
    const task = await f.api<{ id: string }>('/api/tasks', 'POST', { requestId: randomUUID(), spec: { caseId: scene.id,
      title: '保存合成文本', objective: '保存这次明确委托的合成文本。', expectedOutput: '一份保存的文本', capabilities: ['artifact'] } });
    await f.scene(scene.id, alternate); await f.reopen();
    f.responder = () => f.requests.length === 1 ? { tool: 'publish_artifact', input: { title: '合成结果', content: 'TASK_WIRE_RESULT', format: 'text' } }
      : { text: '已保存合成结果。' };
    await f.enable();
    await until(() => ['completed', 'failed'].includes(f.runtime.consent.get(task.id)?.state ?? ''), 'Approved task must settle');
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed', f.runtime.consent.get(task.id)?.error ?? 'Task did not finish');
    assert.equal(f.requests.length, 2); f.requests.forEach(request => assertWire(request, selected, 'siwc-responses'));
    assert.equal(f.store.list('artifacts')[0]?.content, 'TASK_WIRE_RESULT');
  } finally { await f.close(); }
});

test('DeepSeek explicit off/default and automatic reasoning survive the complete routing path', async () => {
  const f = await fixture();
  try {
    const selected = await f.connection('deepseek', 'effort-switch');
    const scene = await f.createScene('强度切换'); await f.global(selected); await f.enable();
    for (const reasoning of ['max', 'none', 'default', 'auto'] as const) {
      const choice = { ...selected, reasoning }; await f.scene(scene.id, choice);
      const index = f.requests.length; await f.processed(await f.send(scene.id, '请说明这次合成问题的依据。'));
      assertWire(f.requests[index], choice, 'deepseek', reasoning === 'auto' ? 'high' : reasoning);
    }
    const greeting = await f.createScene('首次寒暄'); await f.scene(greeting.id, { ...selected, reasoning: 'auto' });
    const index = f.requests.length; await f.processed(await f.send(greeting.id, '你好'));
    assertWire(f.requests[index], selected, 'deepseek', 'low');
  } finally { await f.close(); }
});

test('a disabled scene selection cannot dispatch through the valid global or background connection', async () => {
  const f = await fixture();
  try {
    const selected = await f.connection('siwc-responses', 'disabled-scene'); const alternate = await f.connection('deepseek', 'valid-default');
    await f.global(alternate); await f.background(alternate);
    const scene = await f.createScene('拒绝静默回退'); await f.scene(scene.id, selected);
    const event = await f.send(scene.id); const connection = f.store.models.get(selected.connectionId)!;
    await f.api('/api/models/connections/' + connection.id, 'PATCH', { name: connection.name, kind: connection.kind,
      protocol: connection.protocol, enabled: false, expectedRevision: connection.editRevision });
    await f.enable();
    await until(() => f.store.list('runs').some(run => run.eventId === event && run.status !== 'running'), 'Disabled binding must fail visibly');
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.list('runs').find(run => run.eventId === event)?.modelBinding?.selection.connectionId, selected.connectionId);
  } finally { await f.close(); }
});

test('legacy explicit message effort agrees with the recorded decision and the final production provider request', async () => {
  const f = await fixture();
  try {
    const selected = { ...await f.connection('deepseek', 'legacy-message'), reasoning: 'low' }; await f.global(selected);
    const scene = await f.createScene('旧消息兼容'); const event = await f.send(scene.id, '按这条消息指定的强度处理。', 'max');
    await f.enable(); const run = await f.processed(event);
    assert.equal(run.reasoning?.effort, 'max');
    assert.equal(run.modelBinding?.selection.reasoning, 'max');
    assertWire(f.requests[0], selected, 'deepseek', 'max');
  } finally { await f.close(); }
});

test('historical message bindings are normalized only for new dispatch and source-bound task admission', async () => {
  const f = await fixture();
  try {
    const selected = { ...await f.connection('deepseek', 'historical'), reasoning: 'low' }; await f.global(selected);
    const scene = await f.createScene('历史消息强度');
    // Represents a 0.1.25 record that saved the global binding separately from its explicit message effort.
    const originalBinding = f.store.models.resolve({ caseId: scene.id, purpose: 'conversation' })!;
    const messageId = randomUUID();
    f.store.insert('messages', { id: messageId, caseId: scene.id, createdAt: new Date().toISOString(), role: 'user',
      content: '请保存这份合成文本。', reasoningEffort: 'max', modelBinding: originalBinding });
    await f.reopen();
    const event = f.runtime.inbox.list().find(item => item.externalId === messageId)!;
    const task = f.runtime.consent.requestOwnerTask({ caseId: scene.id, title: '历史来源合成任务', objective: '保存原本人请求的合成内容',
      expectedOutput: '已保存的文本', capabilities: ['artifact'] }, event.id);
    assert.equal(task.modelBinding?.selection.reasoning, 'max');
    let published = false;
    f.responder = request => {
      if (toolNames(request.body.tools).includes('publish_artifact') && !published) {
        published = true; return { tool: 'publish_artifact', input: { title: '历史合成结果', content: 'HISTORICAL_TASK_RESULT', format: 'text' } };
      }
      return { text: '合成处理已完成。' };
    };
    await f.enable(); await f.processed(event.id);
    await until(() => ['completed', 'failed'].includes(f.runtime.consent.get(task.id)?.state ?? ''), 'Historical source task must settle');
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed');
    assert.ok(f.requests.length >= 3); f.requests.forEach(request => assertWire(request, selected, 'deepseek', 'max'));
    assert.deepEqual(f.store.get('messages', messageId)?.modelBinding, originalBinding, 'Historical records are not rewritten to claim different past usage');
  } finally { await f.close(); }
});

for (const protocol of ['deepseek', 'siwc-responses'] as const) {
  test(`${protocol}: project relay sends the admitted model and effort instead of current defaults or native guesses`, async () => {
    const f = await fixture(); const db = new DatabaseSync(':memory:');
    const broker = new ProjectBroker(db, { device: id => ({ id, name: 'Fixture device', platform: 'win32', online: true,
      capabilities: [localProjectCapability], grants: [], createdAt: new Date().toISOString() }), send() {}, assertActive() {}, changed() {}, result() {} });
    let native: Promise<unknown> | undefined;
    try {
      const selected = { ...await f.connection(protocol, 'native-project'), reasoning: protocol === 'deepseek' ? 'max' : 'ultra' };
      const alternate = await f.connection('deepseek', 'unrelated');
      await f.global(alternate); const scene = await f.createScene('项目模型中继'); await f.scene(scene.id, selected);
      const event = await f.send(scene.id); const accepted = f.runtime.inbox.get(event)!;
      const binding = f.store.get('messages', accepted.externalId)!.modelBinding!;
      await f.scene(scene.id, alternate); await f.background(alternate);
      const spec = localProjectSpecSchema.parse({ deviceId: 'fixture-device' });
      const input: ProjectExecutionInput = { operationId: 'fixture-operation', taskId: 'fixture-task', runId: 'fixture-project-run', approvalRevision: 1,
        requirementsRevision: 1, spec, specHash: projectSpecHash(spec), title: '合成项目中继', objective: '验证模型参数', expectedOutput: '模拟回执', ownerRequest: 'fixture', updates: [],
        model: { model: selected.modelId, reasoningEffort: 'low', maxOutputTokens: null }, stepLimit: 2, deadline: null, issuedAt: new Date().toISOString() };
      const controller = new AbortController();
      native = broker.run(input, { signal: controller.signal, guard() {}, onEvent() {}, async model() {}, async context() {} });
      const run: Run = { id: input.runId, taskId: input.taskId, trigger: 'manual', mode: 'execution', status: 'running', startedAt: new Date().toISOString(),
        steps: 0, inputTokens: 0, outputTokens: 0, modelBinding: binding, taskExecution: { requirementsRevision: 1, deadline: null, stepLimit: 2 } };
      f.store.insert('runs', run);
      f.responder = () => ({ tool: 'fixture_tool', input: { value: 'kept' } });
      const chunks: string[] = [];
      const response = { destroyed: false, writeHead() {}, flushHeaders() {}, write(value: string) { chunks.push(value); }, end() {} } as unknown as ServerResponse;
      await forwardProjectModel({ store: f.store, projects: broker, run, usage: new UsageTracker(f.store), signal: controller.signal,
        guard() {}, save() { f.store.put('runs', run); } }, broker.get(input.operationId)!, {} as IncomingMessage, response,
      { model: selected.modelId, input: [{ role: 'user', content: 'fixture project' }], reasoning: { effort: 'low' }, max_output_tokens: 17, store: true,
        tools: [{ type: 'function', name: 'fixture_tool', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }, 'fixture-request');
      assert.equal(f.requests.length, 1); const request = f.requests[0];
      assert.equal(request.url, '/' + (protocol === 'deepseek' ? 'deepseek' : 'siwc') + '/v1/responses');
      assert.equal(request.authorization, 'Bearer fixture-native-project'); assert.equal(request.body.model, selected.modelId);
      assert.equal(object(request.body.reasoning) ? request.body.reasoning.effort : undefined, selected.reasoning);
      assert.equal(request.body.store, false); assert.equal(request.body.stream, true); assert.equal(request.body.max_output_tokens, undefined);
      const frames = chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const call = frames.find(frame => frame.type === 'response.output_item.done')?.item;
      assert.equal(call?.name, 'fixture_tool'); assert.equal(call?.namespace, undefined);
      assert.deepEqual(JSON.parse(call?.arguments), { value: 'kept' });
    } finally {
      if (native) { broker.record('fixture-device', { operationId: 'fixture-operation', sequence: 1, requirementsRevision: 1,
        at: new Date().toISOString(), event: { kind: 'finished', state: 'completed', output: 'fixture complete' } }); await native; }
      db.close(); await f.close();
    }
  });
}
