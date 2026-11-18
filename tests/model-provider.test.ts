import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { SiwcAuthService, SIWC_ISSUER } from '../server/models/siwc.js';
import { createModel, guardResponsesStream, normalizeSiwcResponses, prepareResponses } from '../server/models/provider.js';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';

function fixture() {
  const prefix = join(tmpdir(), 'rae-model-provider-'); const directory = mkdtempSync(prefix); const store = new Store(directory);
  const item = store.models.upsert({ name: 'Synthetic ChatGPT', kind: 'siwc', protocol: 'siwc-responses' });
  store.models.setOAuthCredentials(item.id, { kind: 'siwc', issuer: SIWC_ISSUER, clientId: 'synthetic-client', subject: 'synthetic-owner',
    accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh', scope: 'openid chatgpt.tokens.use.direct', expiresAt: Date.now() + 3600_000 },
    { expectedCredentialVersion: item.credentialVersion, expectedIdentityRevision: item.identityRevision });
  const binding = store.models.resolve({ purpose: 'conversation', selection: { connectionId: item.id, modelId: 'gpt-6.1-sol', reasoning: 'default', maxOutputTokens: null } })!;
  const auth = new SiwcAuthService(store.models, { fetch: async () => { assert.fail('fixture must not contact authentication'); } });
  return { store, binding, auth, async close() { await auth.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); } };
}
function stream(events: unknown[]): Response { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }); }
const textEvents = [
  { type: 'response.created', response: { id: 'response-one', created_at: 1234, model: 'gpt-6.1-sol' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'message-one' } },
  { type: 'response.output_text.delta', item_id: 'message-one', delta: 'durable partial text' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'message-one' } },
];
const completed = { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } };
const options: LanguageModelV4CallOptions = { prompt: [{ role: 'system', content: 'Only authorized tools.' }, { role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
  maxOutputTokens: 5, temperature: 0.4, topP: 0.5, tools: [{ type: 'function', name: 'read_fixture', inputSchema: { type: 'object', properties: {} } }] };
async function parts(stream: ReadableStream<LanguageModelV4StreamPart>) { const result: LanguageModelV4StreamPart[] = []; const reader = stream.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) return result; result.push(next.value); } } finally { reader.releaseLock(); } }

test('SIWC uses maintained OpenAI streaming SDK, normalizes parameters and namespaces, and records provider-reported usage', async () => {
  const f = fixture(); const requests: Record<string, unknown>[] = [];
  try {
    const model = createModel(f.binding, f.store.models, f.auth, async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses'); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access-token');
      requests.push(JSON.parse(String(init?.body))); return stream([...textEvents, completed]);
    });
    const generated = await model.doGenerate({ ...options, providerOptions: { openai: { reasoningEffort: 'high' } } });
    assert.equal(generated.content.find(part => part.type === 'text')?.text, 'durable partial text'); assert.equal(generated.usage.inputTokens.total, 12); assert.equal(generated.usage.outputTokens.total, 7);
    const body = requests[0]; assert.equal(body.store, false); assert.equal(body.stream, true);
    for (const key of ['max_output_tokens', 'temperature', 'top_p', 'previous_response_id']) assert.equal(key in body, false);
    assert.equal((body.reasoning as Record<string, unknown> | undefined)?.effort, undefined);
    assert.ok(JSON.stringify(body.input).includes('developer')); assert.equal(JSON.stringify(body.input).includes('"system"'), false);
    assert.deepEqual((body.tools as Array<{ type: string; name: string; tools: Array<{ name: string }> }>).map(tool => [tool.type, tool.name, tool.tools.map(child => child.name)]), [['namespace', 'rae', ['read_fixture']]]);
  } finally { await f.close(); }
});

test('namespaced tool-call SSE becomes the original AR function call with intact arguments', async () => {
  const f = fixture();
  try {
    const item = { type: 'function_call', id: 'tool-item', call_id: 'call-one', name: 'read_fixture', namespace: 'rae', arguments: '{"id":"source"}' };
    const model = createModel(f.binding, f.store.models, f.auth, async () => stream([
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed' } }, completed,
    ]));
    const result = await model.doGenerate(options); const call = result.content.find(part => part.type === 'tool-call');
    assert.equal(call?.toolName, 'read_fixture'); assert.equal(call?.input, '{"id":"source"}'); assert.equal(result.finishReason.unified, 'tool-calls');
  } finally { await f.close(); }
});

test('raw SIWC consumers restore only adapter-created tool namespaces without colliding with declared namespaces', async () => {
  const f = fixture();
  try {
    const input = [
      { type: 'function_call', name: 'read_fixture', call_id: 'plain', arguments: '{}' },
      { type: 'function_call', name: 'read_fixture', namespace: 'rae', call_id: 'declared', arguments: '{}' },
    ];
    const prepared = await prepareResponses(f.binding, { input, tools: [
      { type: 'function', name: 'read_fixture', parameters: { type: 'object' } },
      { type: 'custom', name: 'patch_fixture' },
      { type: 'namespace', name: 'rae', tools: [{ type: 'function', name: 'read_fixture', parameters: { type: 'object' } }] },
    ] }, { connections: f.store.models, auth: f.auth });
    const normalized = prepared.body.input as Array<Record<string, unknown>>;
    assert.equal(normalized[0].namespace, 'rae_1'); assert.equal(normalized[1].namespace, 'rae');
    assert.deepEqual((prepared.body.tools as Array<{ name: string }>).map(tool => tool.name), ['rae', 'rae_1']);
    const restore = prepared.mapResponseEvent!; assert.equal(typeof restore, 'function');
    const item = { type: 'function_call', id: 'item', call_id: 'plain', name: 'read_fixture', namespace: 'rae_1',
      arguments: '{"namespace":"rae_1","name":"read_fixture"}' };
    const added = restore({ type: 'response.output_item.added', output_index: 0, item });
    assert.deepEqual(added.item, { type: 'function_call', id: 'item', call_id: 'plain', name: 'read_fixture', arguments: item.arguments });
    assert.equal(item.namespace, 'rae_1', 'Received protocol evidence remains unchanged');
    const patch = { type: 'custom_tool_call', id: 'patch', call_id: 'patch', name: 'patch_fixture', namespace: 'rae_1', input: 'literal patch data' };
    const declared = { ...item, namespace: 'rae' };
    const unknown = { ...item, name: 'not_declared' };
    const wrongType = { ...item, type: 'custom_tool_call' };
    const untyped = { name: 'not_declared', namespace: 'rae_1' };
    const terminal = restore({ type: 'response.completed', response: { id: 'response', status: 'completed', output: [item, patch, declared, unknown, wrongType, untyped] } });
    const output = (terminal.response as { output: Array<Record<string, unknown>> }).output;
    assert.equal(output[0].namespace, undefined); assert.equal(output[1].namespace, undefined);
    assert.equal(output[1].input, patch.input); assert.equal(output[1].call_id, patch.call_id);
    assert.equal(output[2], declared); assert.equal(output[3], unknown); assert.equal(output[4], wrongType);
    assert.equal(output[5], untyped);
    assert.equal(input[0].namespace, undefined, 'Caller history is not mutated by wire normalization');
  } finally { await f.close(); }
});

test('a partial response followed by EOF remains partial and cannot emit a success finish', async () => {
  const f = fixture();
  try {
    const model = createModel(f.binding, f.store.models, f.auth, async () => stream(textEvents)); const result = await model.doStream(options);
    const received = await parts(result.stream);
    assert.ok(received.some(part => part.type === 'text-delta')); assert.ok(received.some(part => part.type === 'error'));
    assert.equal(received.find(part => part.type === 'finish')?.finishReason.unified, 'error');
  } finally { await f.close(); }
});

test('usage failure after visible text preserves error and reported usage instead of switching billing or accounts', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const model = createModel(f.binding, f.store.models, f.auth, async () => { calls++; return stream([...textEvents,
      { type: 'response.failed', sequence_number: 5, response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture usage limit' }, usage: completed.response.usage } }]); });
    const received = await parts((await model.doStream(options)).stream);
    assert.equal(calls, 1); assert.ok(received.some(part => part.type === 'text-delta')); assert.ok(received.some(part => part.type === 'error'));
    const finish = received.find(part => part.type === 'finish'); assert.equal(finish?.finishReason.unified, 'error'); assert.equal(finish?.usage.outputTokens.total, 7);
    assert.equal(f.store.models.get(f.binding.selection.connectionId)?.status, 'ready');
    assert.equal(f.store.models.get(f.binding.selection.connectionId)?.recentDiagnostic?.category, 'quota');
    const recovered = createModel(f.binding, f.store.models, f.auth, async () => stream([...textEvents, completed]));
    await recovered.doGenerate(options); assert.equal(f.store.models.get(f.binding.selection.connectionId)?.recentDiagnostic, undefined);
  } finally { await f.close(); }
});

test('HTTP 401 keeps OAuth connected and stores only a safe permission diagnostic', async () => {
  const f = fixture();
  try {
    const model = createModel(f.binding, f.store.models, f.auth, async () => Response.json({ error: { code: 'subscription_sharing_invalid_user', message: 'private upstream token fixture-access-token' } }, { status: 401 }));
    await assert.rejects(async () => model.doStream(options));
    const connection = f.store.models.get(f.binding.selection.connectionId)!;
    assert.equal(connection.status, 'ready'); assert.equal(connection.recentDiagnostic?.category, 'permission'); assert.equal(connection.recentDiagnostic?.status, 401);
    assert.equal(JSON.stringify(connection.recentDiagnostic).includes('fixture-access-token'), false);
    assert.equal(f.store.models.getCredential(connection.id)?.kind, 'siwc');
  } finally { await f.close(); }
});

test('explicit invalid_api_key marks only that key connection and late errors cannot replace a new key diagnostic', async () => {
  const f = fixture();
  try {
    let key = f.store.models.upsert({ name: 'API key account', kind: 'api-key', protocol: 'openai-chat', endpoint: 'https://api.invalid/v1', apiKey: 'private-key-one' });
    const selected = { connectionId: key.id, modelId: 'fixture-model', reasoning: 'default', maxOutputTokens: null };
    let binding = f.store.models.resolve({ purpose: 'conversation', selection: selected })!;
    const model = createModel(binding, f.store.models, f.auth, async () => Response.json({ error: { code: 'invalid_api_key', message: 'private-key-one' } }, { status: 401 }));
    await assert.rejects(async () => model.doGenerate({ prompt: options.prompt }));
    assert.equal(f.store.models.get(key.id)?.status, 'reauth-required'); assert.equal(f.store.models.get(key.id)?.recentDiagnostic?.category, 'credential');
    assert.equal(f.store.models.get(f.binding.selection.connectionId)?.recentDiagnostic, undefined);
    key = f.store.models.get(key.id)!;
    key = f.store.models.upsert({ id: key.id, name: key.name, kind: 'api-key', protocol: 'openai-chat', endpoint: key.endpoint, apiKey: 'private-key-two', expectedRevision: key.editRevision });
    binding = f.store.models.resolve({ purpose: 'conversation', selection: selected })!;
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const late = createModel(binding, f.store.models, f.auth, async () => { enter(); await gate; return Response.json({ error: { code: 'model_not_found', message: 'private model error' } }, { status: 404 }); });
    const pending = assert.rejects(async () => late.doGenerate({ prompt: options.prompt })); await entered;
    const priorDiagnostic = f.store.models.get(key.id)?.recentDiagnostic;
    key = f.store.models.upsert({ id: key.id, name: key.name, kind: 'api-key', protocol: 'openai-chat', endpoint: key.endpoint, apiKey: 'private-key-three', expectedRevision: key.editRevision });
    release(); await pending;
    assert.deepEqual(f.store.models.get(key.id)?.recentDiagnostic, priorDiagnostic); assert.equal(f.store.models.get(key.id)?.status, 'ready');
  } finally { await f.close(); }
});

test('an incomplete Responses terminal never clears the diagnostic even when no incomplete reason is returned', async () => {
  const f = fixture();
  try {
    const model = createModel(f.binding, f.store.models, f.auth, async () => stream([...textEvents, { type: 'response.incomplete', response: {} }]));
    await parts((await model.doStream(options)).stream);
    assert.equal(f.store.models.get(f.binding.selection.connectionId)?.recentDiagnostic?.code, 'response_incomplete');
  } finally { await f.close(); }
});

test('transport cancellation reaches reader and stale binding cannot dispatch with another connection', async () => {
  let cancelled = false; const raw = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  await guardResponsesStream(raw).body!.cancel(); assert.equal(cancelled, true);
  const f = fixture();
  try {
    let calls = 0; const model = createModel(f.binding, f.store.models, f.auth, async () => { calls++; return stream([completed]); });
    const connection = f.store.models.get(f.binding.selection.connectionId)!;
    f.store.models.upsert({ id: connection.id, expectedRevision: connection.editRevision, name: connection.name, kind: 'siwc', protocol: 'siwc-responses', enabled: false });
    await assert.rejects(async () => model.doStream(options)); assert.equal(calls, 0);
    assert.equal(f.store.models.get(connection.id)?.recentDiagnostic, undefined);
  } finally { await f.close(); }
});

test('normalizer refuses unsupported hosted tools and preserves explicit history; legacy Hub project route stays Responses', async () => {
  assert.throws(() => normalizeSiwcResponses({ input: [], tools: [{ type: 'tool_search' }] }), /不支持/);
  assert.throws(() => normalizeSiwcResponses({ input: [], tools: [{ type: 'mcp' }] }), /不支持/);
  const input = [{ role: 'system', content: 'system' }, { type: 'function_call', name: 'read_fixture', call_id: 'old-call', arguments: '{}' }, { type: 'function_call_output', call_id: 'old-call', output: 'kept' }];
  const normalized = normalizeSiwcResponses({ input, tools: [{ type: 'function', name: 'read_fixture', parameters: {} }], previous_response_id: 'not-used' });
  assert.equal((normalized.input as Array<Record<string, unknown>>)[1].namespace, 'rae'); assert.equal((normalized.input as unknown[]).length, 3);
  const f = fixture();
  try {
    const connection = f.store.models.upsert({ name: 'Existing Hub', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://hub.invalid/v1', apiKey: 'fixture-hub-key' });
    const binding = f.store.models.resolve({ purpose: 'task', selection: { connectionId: connection.id, modelId: 'project-model', reasoning: 'default', maxOutputTokens: null } })!;
    const request = await prepareResponses(binding, { model: 'stale-model', input: [{ role: 'user', content: 'project' }], reasoning: { effort: 'high' }, stream: true }, { connections: f.store.models, auth: f.auth });
    assert.equal(request.endpoint, 'https://hub.invalid/v1/responses'); assert.equal(request.body.model, 'project-model'); assert.equal(request.body.reasoning, undefined); assert.equal('thinking' in request.body, false);
  } finally { await f.close(); }
});

test('provider default removes inherited Codex effort while preserving unrelated Responses reasoning settings', async () => {
  const f = fixture();
  try {
    const raw = { input: [{ role: 'user', content: 'fixture' }], reasoning: { effort: 'high', summary: 'auto' }, reasoning_effort: 'max', thinking: { type: 'enabled' } };
    const request = await prepareResponses(f.binding, raw, { connections: f.store.models, auth: f.auth });
    assert.deepEqual(request.body.reasoning, { summary: 'auto' }); assert.equal(request.body.reasoning_effort, undefined); assert.equal(request.body.thinking, undefined);
    assert.equal(raw.reasoning.effort, 'high', 'normalization must not mutate the caller history/request');
    for (const effort of ['max', 'ultra']) {
      const selection = { ...f.binding.selection, reasoning: effort };
      const binding = f.store.models.resolve({ purpose: 'task', selection })!;
      const explicit = await prepareResponses(binding, { input: [], reasoning: { effort: 'low', summary: 'auto' } }, { connections: f.store.models, auth: f.auth });
      assert.deepEqual(explicit.body.reasoning, { effort, summary: 'auto' }, 'explicit effort is forwarded unchanged, never mapped to a lower level');
    }
  } finally { await f.close(); }
});

test('DeepSeek SDK default omits inherited thinking and effort, while explicit max remains max', async () => {
  const f = fixture();
  try {
    const connection = f.store.models.upsert({ name: 'DeepSeek fixture', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://deepseek.invalid/v1', apiKey: 'deepseek-fixture-key' });
    const requests: Record<string, unknown>[] = [];
    const transport: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'fixture-result', object: 'chat.completion', created: 1234, model: 'deepseek-v4-flash', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    };
    for (const reasoning of ['default', 'max']) {
      const binding = f.store.models.resolve({ purpose: 'conversation', selection: { connectionId: connection.id, modelId: 'deepseek-v4-flash', reasoning, maxOutputTokens: null } })!;
      const model = createModel(binding, f.store.models, f.auth, transport);
      await model.doGenerate({ prompt: options.prompt, providerOptions: { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } } });
    }
    assert.equal(requests[0].thinking, undefined); assert.equal(requests[0].reasoning_effort, undefined);
    assert.deepEqual(requests[1].thinking, { type: 'enabled' }); assert.equal(requests[1].reasoning_effort, 'max');
  } finally { await f.close(); }
});
