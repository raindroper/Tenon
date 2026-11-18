import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import type { ModelBinding } from '../../shared/model-connections.js';
import type { ModelConnections } from './connections.js';
import { SiwcAuthService, SiwcError, SIWC_RESOURCE } from './siwc.js';
import { clearModelDiagnostic, recordModelDiagnostic } from './diagnostics.js';

type JsonObject = Record<string, unknown>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const siwcOmitted = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
  'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'];
const unsupportedTools = new Set(['image_generation', 'file_search', 'code_interpreter', 'computer_use_preview', 'computer_use', 'computer', 'mcp', 'tool_search', 'programmatic_tool_calling']);

function siwcFlatToolNamespace(raw: JsonObject): string {
  const occupied = new Set((Array.isArray(raw.tools) ? raw.tools : []).filter(tool => object(tool) && tool.type === 'namespace')
    .map(tool => (tool as JsonObject).name));
  let name = 'rae';
  for (let suffix = 1; occupied.has(name); suffix++) name = `rae_${suffix}`;
  return name;
}

/** Undo only the namespace this request's adapter introduced, never a caller-declared tool identity. */
export function restoreSiwcToolIdentity(raw: JsonObject): (event: JsonObject) => JsonObject {
  const namespace = siwcFlatToolNamespace(raw);
  const flat = new Map((Array.isArray(raw.tools) ? raw.tools : []).filter(tool => object(tool)
    && (tool.type === 'function' || tool.type === 'custom') && typeof tool.name === 'string')
    .map(tool => [(tool as JsonObject).name, (tool as JsonObject).type === 'function' ? 'function_call' : 'custom_tool_call']));
  const restore = (item: unknown): unknown => {
    if (!object(item) || item.namespace !== namespace || typeof item.name !== 'string' || !flat.has(item.name) || flat.get(item.name) !== item.type) return item;
    const { namespace: _adapterNamespace, ...original } = item;
    return original;
  };
  return event => {
    const item = restore(event.item);
    let response = event.response;
    if (object(response) && Array.isArray(response.output)) {
      const original = response.output;
      const output = original.map(restore);
      if (output.some((item, index) => item !== original[index])) response = { ...response, output };
    }
    return item === event.item && response === event.response ? event : { ...event, ...(item !== event.item ? { item } : {}), ...(response !== event.response ? { response } : {}) };
  };
}

/** Normalize only the officially documented SIWC wire differences. Never adds tools or grants. */
export function normalizeSiwcResponses(raw: JsonObject): JsonObject {
  const body = structuredClone(raw);
  const flatNamespace = siwcFlatToolNamespace(raw);
  for (const name of siwcOmitted) delete body[name];
  body.store = false; body.stream = true;
  if (!Array.isArray(body.input)) throw new SiwcError('invalid_input', 'ChatGPT 套餐请求必须包含完整的输入数组。');
  const plainTools: JsonObject[] = []; const groupedTools: unknown[] = []; const toolNames = new Set<string>();
  const validateTool = (tool: unknown): JsonObject => {
    if (!object(tool) || typeof tool.type !== 'string' || unsupportedTools.has(tool.type)) throw new SiwcError('unsupported_tool', 'ChatGPT 套餐不支持此工具协议。');
    if (tool.type !== 'function' && tool.type !== 'custom') throw new SiwcError('unsupported_tool', 'ChatGPT 套餐命名空间仅支持函数或自定义工具。');
    if (typeof tool.name !== 'string' || !tool.name) throw new SiwcError('invalid_tool', '模型工具缺少名称。');
    toolNames.add(tool.name); return tool;
  };
  const validateNamespace = (tool: JsonObject) => {
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) throw new SiwcError('invalid_namespace', '模型工具命名空间无效。');
    tool.tools.forEach(validateTool);
  };
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new SiwcError('invalid_tools', '模型工具协议无效。');
  for (const tool of (body.tools as unknown[] | undefined) ?? []) {
    if (!object(tool)) throw new SiwcError('invalid_tool', '模型工具协议无效。');
    if (tool.type === 'function' || tool.type === 'custom') plainTools.push(validateTool(tool));
    else if (tool.type === 'namespace') {
      validateNamespace(tool); groupedTools.push(tool);
    } else if (tool.type === 'web_search' || tool.type === 'web_search_preview') groupedTools.push(tool);
    else throw new SiwcError('unsupported_tool', 'ChatGPT 套餐不支持此内置工具。');
  }
  if (plainTools.length) {
    groupedTools.push({ type: 'namespace', name: flatNamespace, description: 'Tools authorized by the current Tenon task.', tools: plainTools });
  }
  if (body.tools !== undefined) body.tools = groupedTools;
  if (object(body.tool_choice) && body.tool_choice.type !== undefined) {
    // Forced choices for namespaced tools differ from flat Responses tools. Do not silently relax them.
    throw new SiwcError('unsupported_tool_choice', 'ChatGPT 套餐连接当前支持 auto、none 或 required 工具选择。');
  }
  body.input = body.input.map(item => {
    if (!object(item)) return item;
    if (item.role === 'system') return { ...item, role: 'developer' };
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.name === 'string' && toolNames.has(item.name) && !item.namespace && plainTools.some(tool => tool.name === item.name)) {
      return { ...item, namespace: flatNamespace };
    }
    if (item.type === 'additional_tools') {
      if (!Array.isArray(item.tools)) throw new SiwcError('invalid_tools', '历史工具协议无效。');
      item.tools.forEach(tool => { if (object(tool) && tool.type === 'namespace') validateNamespace(tool); else validateTool(tool); });
    }
    return item;
  });
  return body;
}

export function providerOptionsFor(binding: ModelBinding, reasoning?: { effort: string }): Record<string, Record<string, JsonValue>> {
  const selected = binding.selection.reasoning;
  const effort = selected === 'auto' ? reasoning?.effort : selected === 'default' ? undefined : selected;
  if (binding.protocol === 'deepseek') return effort ? { deepseek: effort === 'none' ? { thinking: { type: 'disabled' } }
    : { thinking: { type: 'enabled' }, reasoningEffort: effort } } : {};
  return { openai: { ...(binding.protocol !== 'openai-chat' ? { store: false, systemMessageMode: 'developer' } : {}), ...(effort ? { reasoningEffort: effort } : {}) } };
}
export interface ModelRequestContext { connections: ModelConnections; auth: SiwcAuthService; signal?: AbortSignal }
export interface PreparedModelRequest {
  endpoint: string; headers: Record<string, string>; body: JsonObject;
  /** Raw protocol consumers must receive the tool identities they originally declared. */
  mapResponseEvent?: (event: JsonObject) => JsonObject;
}

/** Resolve credentials immediately before dispatch; settings changes never silently retarget a saved binding. */
export async function prepareModelRequest(binding: ModelBinding, raw: JsonObject, context: ModelRequestContext): Promise<PreparedModelRequest> {
  return prepareRequest(binding, raw, context, binding.protocol === 'siwc-responses' || binding.protocol === 'openai-responses');
}
async function prepareRequest(binding: ModelBinding, raw: JsonObject, context: ModelRequestContext, responses: boolean): Promise<PreparedModelRequest> {
  context.signal?.throwIfAborted();
  context.connections.assertBinding(binding);
  const token = binding.protocol === 'siwc-responses'
    ? await context.auth.accessToken(binding.selection.connectionId, context.signal, binding.identityRevision)
    : (() => { const credential = context.connections.getCredential(binding.selection.connectionId);
      if (credential?.kind !== 'api-key') throw new SiwcError('credential_missing', '此模型连接缺少 API 密钥。'); return credential.apiKey; })();
  context.signal?.throwIfAborted(); context.connections.assertBinding(binding);
  let body: JsonObject = { ...structuredClone(raw), model: binding.selection.modelId };
  const max = binding.selection.maxOutputTokens;
  if (responses) { delete body.max_tokens; delete body.max_completion_tokens; if (max === null) delete body.max_output_tokens; else body.max_output_tokens = max; }
  else {
    delete body.max_output_tokens;
    if (max === null) { delete body.max_tokens; delete body.max_completion_tokens; }
    else if (binding.protocol === 'deepseek') { body.max_tokens = max; delete body.max_completion_tokens; }
    else { body.max_completion_tokens = max; delete body.max_tokens; }
  }
  const effort = binding.selection.reasoning;
  if (effort === 'default') {
    // Codex and SDK callers may already have filled an effort. The saved selection owns the wire contract.
    delete body.reasoning_effort; delete body.thinking;
    if (object(body.reasoning)) {
      const reasoning = { ...body.reasoning }; delete reasoning.effort;
      if (Object.keys(reasoning).length) body.reasoning = reasoning; else delete body.reasoning;
    } else delete body.reasoning;
  } else if (effort !== 'auto') {
    if (binding.protocol === 'deepseek' && !responses) { body.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' }; if (effort !== 'none') body.reasoning_effort = effort; }
    else if (responses) body.reasoning = { ...(object(body.reasoning) ? body.reasoning : {}), effort };
    else body.reasoning_effort = effort;
  }
  if (binding.protocol === 'siwc-responses') {
    if (binding.endpoint !== SIWC_RESOURCE) throw new SiwcError('invalid_endpoint', 'ChatGPT 套餐只能连接官方 Responses 接口。');
    body = normalizeSiwcResponses(body);
  }
  return { endpoint: `${binding.endpoint.replace(/\/+$/, '')}/${responses ? 'responses' : 'chat/completions'}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body };
}
export async function prepareResponses(binding: ModelBinding, raw: JsonObject, context: ModelRequestContext): Promise<PreparedModelRequest> {
  // The deployed DeepSeek-compatible Hub serves chat completions for Tenon and Responses for the existing project harness.
  if (binding.protocol === 'openai-chat') throw new SiwcError('protocol_mismatch', '此连接未声明支持项目 Responses 协议。');
  const prepared = await prepareRequest(binding, raw, context, true);
  return binding.protocol === 'siwc-responses' ? { ...prepared, mapResponseEvent: restoreSiwcToolIdentity(raw) } : prepared;
}

/** The provider SDK emits a finish on EOF; require an actual server terminal event before allowing that. */
export function guardResponsesStream(response: Response, signal?: AbortSignal, onTerminal?: (event: 'completed' | 'failed' | 'incomplete') => void): Response {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = ''; let terminal = false;
  const inspect = (frame: string) => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event: unknown; try { event = JSON.parse(data); } catch { throw new SiwcError('invalid_stream', '模型返回了无效流事件。'); }
    if (object(event) && (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error')) {
      terminal = true;
      onTerminal?.(event.type === 'response.incomplete' || object(event.response) && event.response.status === 'incomplete' ? 'incomplete'
        : event.type === 'response.completed' ? 'completed' : 'failed');
    }
  };
  const parse = () => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(pending); if (!match) break;
      inspect(pending.slice(0, match.index)); pending = pending.slice(match.index + match[0].length);
    }
    if (pending.length > 8 * 1024 * 1024) throw new SiwcError('invalid_stream', '模型流事件超过协议限制。');
  };
  const failEvent = (controller: ReadableStreamDefaultController<Uint8Array>, message: string) => {
    // An explicit local error keeps already queued output drainable. controller.error() would discard it.
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'error', sequence_number: 0, code: 'rae_stream_interrupted', message, param: null })}\n\n`));
    controller.close();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          pending += decoder.decode(); parse(); if (pending.trim()) inspect(pending);
          reader.releaseLock();
          if (!terminal) failEvent(controller, '模型连接在完成前中断，已收到的内容不是完整结果。');
          else controller.close();
          return;
        }
        pending += decoder.decode(next.value, { stream: true }); parse(); controller.enqueue(next.value);
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        if (signal?.aborted) controller.error(signal.reason);
        else if (terminal) controller.close();
        else failEvent(controller, '模型流在完成前中断，已收到的内容不是完整结果。');
      }
    },
    async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function collectResponse(result: LanguageModelV4StreamResult): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4Content[] = []; const blocks = new Map<string, Extract<LanguageModelV4Content, { type: 'text' | 'reasoning' }>>();
  let finish: Extract<LanguageModelV4StreamPart, { type: 'finish' }> | undefined;
  let warnings: LanguageModelV4GenerateResult['warnings'] = []; let metadata: LanguageModelV4GenerateResult['response'] = result.response;
  const reader = result.stream.getReader();
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break; const part = next.value;
      if (part.type === 'error') throw part.error;
      if (part.type === 'stream-start') warnings = part.warnings;
      else if (part.type === 'text-start' || part.type === 'reasoning-start') {
        const block = { type: part.type === 'text-start' ? 'text' as const : 'reasoning' as const, text: '', providerMetadata: part.providerMetadata };
        blocks.set(part.id, block); content.push(block);
      } else if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
        let block = blocks.get(part.id);
        if (!block) { const fresh: Extract<LanguageModelV4Content, { type: 'text' | 'reasoning' }> = { type: part.type === 'text-delta' ? 'text' : 'reasoning', text: '' }; blocks.set(part.id, fresh); content.push(fresh); block = fresh; }
        block.text += part.delta; if (part.providerMetadata) block.providerMetadata = part.providerMetadata;
      } else if (part.type === 'text-end' || part.type === 'reasoning-end') {
        const block = blocks.get(part.id); if (block && part.providerMetadata) block.providerMetadata = part.providerMetadata;
        if (block?.type === 'text' && part.type === 'text-end' && part.citations) block.citations = part.citations;
      } else if (part.type === 'finish') finish = part;
      else if (part.type === 'response-metadata') { const { type: _type, ...value } = part; metadata = { ...metadata, ...value }; }
      else if (['tool-call', 'tool-result', 'tool-approval-request', 'file', 'source', 'custom', 'reasoning-file'].includes(part.type)) content.push(part as LanguageModelV4Content);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!finish) throw new SiwcError('stream_interrupted', '模型未返回完成状态。');
  return { content, usage: finish.usage, finishReason: finish.finishReason, warnings, providerMetadata: finish.providerMetadata, request: result.request, response: metadata };
}

export function createModel(binding: ModelBinding, connections: ModelConnections, auth: SiwcAuthService, fetcher: typeof fetch = fetch): LanguageModelV4 {
  const wireState = new AsyncLocalStorage<{ terminal?: 'completed' | 'failed' | 'incomplete' }>();
  const responses = binding.protocol === 'siwc-responses' || binding.protocol === 'openai-responses';
  const transport: typeof fetch = async (_input, init) => {
    if (typeof init?.body !== 'string') throw new SiwcError('invalid_request', '模型请求未使用 JSON 协议。');
    const raw: unknown = JSON.parse(init.body); if (!object(raw)) throw new SiwcError('invalid_request', '模型请求无效。');
    const prepared = await prepareModelRequest(binding, raw, { connections, auth, signal: init.signal ?? undefined });
    const response = await fetcher(prepared.endpoint, { ...init, headers: prepared.headers, body: JSON.stringify(prepared.body), redirect: 'error' });
    const state = wireState.getStore();
    return responses && prepared.body.stream === true ? guardResponsesStream(response, init.signal ?? undefined, terminal => { if (state) state.terminal = terminal; }) : response;
  };
  const model: LanguageModelV4 = binding.protocol === 'deepseek'
    ? createDeepSeek({ apiKey: 'resolved-at-dispatch', baseURL: binding.endpoint, fetch: transport })(binding.selection.modelId)
    : (() => { const provider = createOpenAI({ apiKey: 'resolved-at-dispatch', baseURL: binding.endpoint, fetch: transport });
      const upstream = binding.protocol === 'openai-chat' ? provider.chat(binding.selection.modelId) : provider.responses(binding.selection.modelId);
      // Newer provider v4 adds heartbeat parts. Adapt that transport-only extension to the installed Mastra/AI SDK contract.
      return { specificationVersion: 'v4', provider: upstream.provider, modelId: upstream.modelId, supportedUrls: upstream.supportedUrls,
        doGenerate: options => upstream.doGenerate(options),
        async doStream(options) { const result = await upstream.doStream(options);
          return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(part, controller) { if (part.type !== 'ping') controller.enqueue(part); } })) }; } } satisfies LanguageModelV4;
    })();
  const configure = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => {
    const defaults = providerOptionsFor(binding); const providerOptions = { ...options.providerOptions };
    if (binding.selection.reasoning === 'default') {
      for (const name of ['openai', 'deepseek']) if (providerOptions[name]) {
        const values = { ...providerOptions[name] }; delete values.reasoningEffort;
        if (name === 'deepseek') delete values.thinking;
        providerOptions[name] = values;
      }
    }
    for (const [name, values] of Object.entries(defaults)) providerOptions[name] = { ...providerOptions[name], ...values };
    const configured = { ...options, providerOptions, ...(binding.selection.maxOutputTokens === null ? { maxOutputTokens: undefined } : { maxOutputTokens: binding.selection.maxOutputTokens }) };
    // Newer provider SDK versions also recognize a generic call-level reasoning option.
    if (binding.selection.reasoning === 'default') Reflect.deleteProperty(configured, 'reasoning');
    return configured;
  };
  const recordFailure = (error: unknown, signal?: AbortSignal) => {
    if (!signal?.aborted) recordModelDiagnostic(binding, error, connections);
    else if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') recordModelDiagnostic(binding, signal.reason, connections);
  };
  const success = (finishReason: LanguageModelV4GenerateResult['finishReason']) => {
    if (['stop', 'tool-calls', 'content-filter'].includes(finishReason.unified)) clearModelDiagnostic(binding, connections);
    else recordModelDiagnostic(binding, { code: finishReason.unified === 'length' ? 'response_incomplete' : 'model_response_failed' }, connections);
  };
  const invokeStream = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> => {
    try {
      const state: { terminal?: 'completed' | 'failed' | 'incomplete' } = {};
      const result = await wireState.run(state, () => model.doStream(configure(options))); const reader = result.stream.getReader(); let failed = false;
      return { ...result, stream: new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller) {
          try {
            const next = await reader.read(); if (next.done) { controller.close(); reader.releaseLock(); return; }
            const part = next.value;
            if (part.type === 'error') { failed = true; recordFailure(part.error, options.abortSignal); }
            else if (part.type === 'finish' && !failed && !options.abortSignal?.aborted) {
              if (responses && state.terminal !== 'completed') recordModelDiagnostic(binding, { code: state.terminal === 'incomplete' ? 'response_incomplete' : 'model_response_failed' }, connections);
              else success(part.finishReason);
            }
            controller.enqueue(part);
          } catch (error) { failed = true; await reader.cancel(error).catch(() => undefined); recordFailure(error, options.abortSignal); controller.error(error); }
        },
        async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
      }) };
    } catch (error) { recordFailure(error, options.abortSignal); throw error; }
  };
  return new Proxy(model, { get(target, key) {
    if (key === 'doStream') return invokeStream;
    if (key === 'doGenerate') return async (options: LanguageModelV4CallOptions) => {
      if (binding.protocol === 'siwc-responses') return collectResponse(await invokeStream(options));
      try { const result = await target.doGenerate(configure(options));
        if (!options.abortSignal?.aborted) {
          const status = object(result.response?.body) ? result.response.body.status : undefined;
          if (responses && (status === 'incomplete' || status === 'failed')) recordModelDiagnostic(binding, { code: status === 'incomplete' ? 'response_incomplete' : 'model_response_failed' }, connections);
          else success(result.finishReason);
        }
        return result;
      }
      catch (error) { recordFailure(error, options.abortSignal); throw error; }
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
