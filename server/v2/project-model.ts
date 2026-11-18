import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Run } from '../../shared/types.js';
import type { ProjectOperation } from '../../shared/local-project.js';
import { ProjectModelStream, projectModelFailureFrame, type ProjectModelFailureCode } from '../../shared/project-model-stream.js';
import { ProjectStreamWriteTimeoutError, writeProjectStreamFrame } from '../../shared/project-stream-write.js';
import type { Store } from '../store.js';
import { ProjectError, type ProjectBroker } from '../devices/projects.js';
import type { UsageTracker } from './usage.js';
import type { MeteredUsage } from './metering.js';
import { prepareResponses } from '../models/provider.js';
import { SiwcAuthService } from '../models/siwc.js';
import { clearModelDiagnostic, readModelErrorResponse, recordModelDiagnostic } from '../models/diagnostics.js';

export function responsesUsage(value: unknown): MeteredUsage {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const valid = (number: unknown): number is number => Number.isSafeInteger(number) && Number(number) >= 0;
  const input = valid(usage.input_tokens) ? usage.input_tokens : undefined;
  const output = valid(usage.output_tokens) ? usage.output_tokens : undefined;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0,
    usageStatus: input !== undefined && output !== undefined ? 'reported' : input !== undefined || output !== undefined ? 'partial' : 'unknown' };
}

interface Options {
  store: Store;
  projects: ProjectBroker;
  usage: UsageTracker;
  run: Run;
  signal: AbortSignal;
  guard(): void;
  save(): void;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  firstResponseTimeoutMs?: number;
  writeTimeoutMs?: number;
  modelAuth?: SiwcAuthService;
}

function isNativeCompaction(raw: Record<string, unknown>): boolean {
  // The pinned app-server labels its own Responses requests before provider normalization.
  const metadata = raw.client_metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const encoded = (metadata as Record<string, unknown>)['x-codex-turn-metadata'];
  if (typeof encoded !== 'string') return false;
  try { return JSON.parse(encoded)?.request_kind === 'compaction'; }
  catch { return false; }
}

/** A scoped transport adapter to the owner's existing endpoint. It never interprets task consent. */
export async function forwardProjectModel(options: Options, operation: ProjectOperation, _request: IncomingMessage,
  response: ServerResponse, raw: Record<string, unknown>, requestId: string): Promise<void> {
  options.guard(); options.signal.throwIfAborted();
  const settings = options.store.getSettings();
  const binding = options.run.modelBinding !== undefined ? options.run.modelBinding : (settings.model === operation.input.model.model
    ? options.store.models.resolve({ purpose: 'task' }) : undefined);
  if (!binding || raw.model !== operation.input.model.model || binding.selection.modelId !== operation.input.model.model) {
    throw new ProjectError(409, '项目模型连接已经改变，请恢复当前任务后再继续。');
  }
  options.store.models.assertBinding(binding);
  if (raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.some(tool =>
    !tool || typeof tool !== 'object' || !['function', 'custom', 'namespace'].includes(String((tool as Record<string, unknown>).type))))) {
    throw new ProjectError(400, '本地项目模型请求包含未接入的供应商内置操作。');
  }
  const compaction = isNativeCompaction(raw);
  const prepared = await prepareResponses(binding, { ...raw, stream: true, store: false }, { connections: options.store.models,
    auth: options.modelAuth ?? new SiwcAuthService(options.store.models), signal: options.signal });
  options.guard(); options.signal.throwIfAborted(); options.store.models.assertBinding(binding);
  const { endpoint, body, headers } = prepared;
  options.projects.beginModel(operation, requestId, compaction ? 'compaction' : undefined);
  options.run.steps++;
  options.run.taskExecution!.modelStarted = true;
  const settle = options.usage.external(options.run, `${operation.input.operationId}:${requestId}`, options.signal, options.guard);
  options.save();
  let usage: MeteredUsage = { inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' };
  let publicText = '';
  let checkpoint = Date.now();
  let checkpointLength = 0;
  let failure: ProjectModelFailureCode | undefined;
  let providerFailure: Record<string, unknown> | undefined;
  let diagnosticRecorded = false;
  let streaming = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let readerEnded = false;
  const frames = new ProjectModelStream(prepared.mapResponseEvent);
  const monotonicStart = performance.now();
  let receivedBytes = 0;
  let forwardedBytes = 0;
  let responseId: string | undefined;
  let firstByteMs: number | undefined;
  let terminalMs: number | undefined;
  const nativeStreamLifetime = (operation.input.contract?.version ?? 1) >= 2;
  const requestTimeoutMs = options.requestTimeoutMs ?? (nativeStreamLifetime ? undefined : 180_000);
  const timeout = requestTimeoutMs === undefined ? undefined : AbortSignal.timeout(requestTimeoutMs);
  const firstResponse = new AbortController();
  const firstResponseTimer = setTimeout(() => firstResponse.abort(new DOMException('等待模型响应超时。', 'TimeoutError')),
    options.firstResponseTimeoutMs ?? requestTimeoutMs ?? 180_000);
  firstResponseTimer.unref();
  const disconnected = new AbortController();
  const signal = AbortSignal.any([options.signal, firstResponse.signal, disconnected.signal, ...timeout ? [timeout] : []]);
  // This response belongs to the paired execution device, not a UI progress subscription.
  const consumerClosed = () => {
    if (!frames.terminal) disconnected.abort(new DOMException('原生模型接收端已关闭。', 'AbortError'));
  };
  if (nativeStreamLifetime) {
    response.once('close', consumerClosed);
    if (response.destroyed) consumerClosed();
  }
  const cancel = () => {
    if (reader && !cancellation) {
      cancellation = reader.cancel(signal.reason);
      // An abort listener can start cancellation before this function reaches its
      // finally block. Keep the rejection handled until the drain observes it.
      void cancellation.catch(() => undefined);
    }
  };
  const readEvent = (event: Record<string, unknown>) => {
    const result = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : undefined;
    if (typeof result?.id === 'string') responseId = result.id;
    if (result?.usage) usage = responsesUsage(result.usage);
    if (!compaction && event.type === 'response.output_text.delta' && typeof event.delta === 'string') publicText += event.delta;
    if (event.type === 'response.failed' || event.type === 'error') providerFailure = event;
  };
  const checkpointText = () => {
    if (publicText.length === checkpointLength) return;
    options.projects.modelText(operation.input.operationId, requestId, publicText);
    checkpointLength = publicText.length;
    checkpoint = Date.now();
  };
  try {
    const upstream = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST', redirect: 'error',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify(body), signal,
    });
    signal.throwIfAborted();
    if (!upstream.ok) {
      failure = 'provider_http_error';
      recordModelDiagnostic(binding, await readModelErrorResponse(upstream), options.store.models); diagnosticRecorded = true;
      throw new ProjectError(502, `项目模型服务返回 ${upstream.status}，已记录实际调用。`);
    }
    const contentType = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    // Some Responses routes omit Content-Type even for a valid SSE body. The
    // requested protocol and validated terminal event remain authoritative;
    // an explicitly incompatible media type must still fail before forwarding.
    if (!upstream.body || contentType && contentType !== 'text/event-stream') {
      failure = 'invalid_stream';
      await upstream.body?.cancel().catch(() => undefined);
      throw new ProjectError(502, '项目模型服务没有返回可识别的流式响应。');
    }
    reader = upstream.body.getReader();
    void reader.closed.then(() => { readerEnded = true; }, () => { readerEnded = true; });
    signal.addEventListener('abort', cancel, { once: true });
    signal.throwIfAborted();
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    if (!response.destroyed) response.flushHeaders();
    streaming = true;
    while (!frames.terminal) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      clearTimeout(firstResponseTimer);
      firstByteMs ??= performance.now() - monotonicStart;
      receivedBytes += next.value.byteLength;
      const output = frames.push(next.value, readEvent);
      forwardedBytes += Buffer.byteLength(output);
      if (frames.terminal) terminalMs = performance.now() - monotonicStart;
      // Legacy requests still finish metering after a device disconnect. V2 cancels
      // that response when its native consumer is gone and records partial usage.
      if (output) await writeProjectStreamFrame(response, output, signal, options.writeTimeoutMs);
      if (!frames.terminal && Date.now() - checkpoint >= 250) checkpointText();
    }
    failure = frames.failure;
    if (!frames.terminal) {
      failure = 'missing_terminal';
      if (!response.destroyed) response.end(projectModelFailureFrame(failure, '项目模型响应流已关闭，未收到结束事件。'));
    } else if (!response.destroyed) response.end();
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    if (error instanceof ProjectStreamWriteTimeoutError) response.destroy();
    failure = error instanceof ProjectStreamWriteTimeoutError ? 'downstream_timeout'
      : options.signal.aborted ? 'task_stopped'
      : timeout?.aborted && signal.reason === timeout.reason ? 'request_timeout'
      : firstResponse.signal.aborted && signal.reason === firstResponse.signal.reason ? 'first_response_timeout'
      : 'transport_interrupted';
    const message = failure === 'request_timeout' ? '项目模型请求超时，已保存收到的正文。'
      : failure === 'first_response_timeout' ? '模型服务未及时开始响应，本次请求已结束。'
      : failure === 'downstream_timeout' ? '项目模型接收端长时间未继续读取，已保存收到的正文。'
      : failure === 'task_stopped' ? '项目模型请求已停止。' : '项目模型响应流中断，已保存收到的正文。';
    if (!streaming) throw new ProjectError(failure === 'request_timeout' || failure === 'first_response_timeout' ? 504 : failure === 'task_stopped' ? 409 : 502, message);
    if (!response.destroyed) response.end(projectModelFailureFrame(failure, message));
  } finally {
    clearTimeout(firstResponseTimer);
    if (nativeStreamLifetime) response.removeListener('close', consumerClosed);
    signal.removeEventListener('abort', cancel);
    const finalErrors: unknown[] = [];
    const record = (save: () => void) => {
      try { save(); }
      catch (error) { finalErrors.push(error); failure ??= 'transport_interrupted'; }
    };
    try {
      record(() => options.projects.modelTiming(operation.input.operationId, requestId, { responseId, receivedBytes, forwardedBytes, firstByteMs, terminalMs,
        source: 'server_monotonic', elapsedMs: performance.now() - monotonicStart }));
      record(() => {
        if (!diagnosticRecorded && failure && failure !== 'task_stopped') {
          recordModelDiagnostic(binding, providerFailure ?? { code: failure === 'provider_incomplete' ? 'response_incomplete' : failure }, options.store.models);
        } else if (!failure && frames.terminal) clearModelDiagnostic(binding, options.store.models);
      });
      record(checkpointText);
      record(() => settle(usage));
    } finally {
      let drained = true;
      try { cancel(); await cancellation; }
      catch (error) {
        // Cancelling an already errored fetch reader rejects too. Its settled
        // closed promise confirms that reader has actually ended.
        if (!readerEnded) { drained = false; finalErrors.push(error); }
      }
      try { reader?.releaseLock(); }
      catch (error) { drained = false; finalErrors.push(error); }
      if (drained) record(() => options.projects.settleModel(operation.input.operationId, requestId, usage, failure));
    }
    if (finalErrors.length) throw new AggregateError(finalErrors, '项目模型收尾发生错误，请核对原请求记录。');
  }
}
