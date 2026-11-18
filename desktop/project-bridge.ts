import { createServer, type Server } from 'node:http';
import { buffer as readBody } from 'node:stream/consumers';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ProjectExecutionInput, ProjectGuardInput } from '../shared/local-project.js';
import type { ImageAttachment } from '../shared/chat-images.js';
import { ProjectModelStream, projectModelFailureFrame } from '../shared/project-model-stream.js';
import { ProjectStreamWriteTimeoutError, writeProjectStreamFrame } from '../shared/project-stream-write.js';
import { deviceFetch, DeviceHttpError } from './transport.js';
import { setTimeout as delay } from 'node:timers/promises';

interface Options {
  baseUrl: string;
  credential: string;
  input(): ProjectExecutionInput;
  signal: AbortSignal;
  assertLocal(): Promise<void>;
  request?: typeof deviceFetch;
  /** Fault-injection seam; production uses bounded backoff within the same request deadline. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  writeTimeoutMs?: number;
  modelTransport?(event: { requestId: string; requirementsRevision: number; responseId?: string; state: 'receiving' | 'received'; bytes: number }): Promise<void>;
}
/** Only the task-local opaque token enters Codex. The paired-device credential stays in this process. */
export class ProjectBridge {
  readonly token = randomBytes(32).toString('base64url');
  private readonly server: Server;
  private readonly pending = new Set<Promise<void>>();
  private readonly modelRequests = new Set<AbortController>();
  private address?: string;
  private accepting = true;
  private closing?: Promise<void>;

  constructor(private readonly options: Options) {
    this.server = createServer((request, response) => {
      const operation = (async () => {
        const stream = new ProjectModelStream();
        let controller: AbortController | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let cancellation: Promise<void> | undefined;
        let signal: AbortSignal | undefined;
        const cancel = () => { if (reader) cancellation ??= reader.cancel(signal?.reason).catch(() => undefined); };
        const abortUpload = () => { if (!request.complete) request.destroy(); };
        const consumerClosed = () => {
          if (!stream.terminal) controller?.abort(new DOMException('原生模型接收端已关闭。', 'AbortError'));
        };
        try {
          const value = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
          const provided = Buffer.from(value);
          const expected = Buffer.from(this.token);
          if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
            response.writeHead(401).end(); return;
          }
          if (!this.accepting || options.signal.aborted) throw new Error('当前项目会话正在停止。');
          await options.assertLocal();
          const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
          if (request.method !== 'POST' || !['/authorize', '/v1/responses'].includes(route)) { response.writeHead(404).end(); return; }
          if (route === '/authorize') {
            const hook = JSON.parse((await readBody(request)).toString('utf8')) as { tool_name?: unknown };
            if (options.input().spec.desktop && ['apply_patch', 'functions.apply_patch'].includes(String(hook.tool_name))) {
              response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '本次 Windows 应用任务未开放原生文件修改工具。' }));
              return;
            }
            await this.guard();
            response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"accepted":true}');
            return;
          }
          // Capture the scope before reading or forwarding asynchronous input. A
          // requirement update can fence this request but cannot relabel its facts.
          const authorization = this.authorization();
          if (!this.accepting || options.signal.aborted) throw new Error('当前项目会话正在停止。');
          controller = new AbortController(); this.modelRequests.add(controller);
          signal = AbortSignal.any([options.signal, controller.signal]);
          signal.addEventListener('abort', abortUpload, { once: true });
          response.once('close', consumerClosed);
          if (response.destroyed) consumerClosed();
          signal.throwIfAborted();
          const body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
          signal.removeEventListener('abort', abortUpload);
          signal.throwIfAborted();
          const requestId = randomUUID();
          const upstream = await (options.request ?? deviceFetch)(options.baseUrl, '/api/device/projectmodel', options.credential, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authorization, requestId, request: body }), signal,
          });
          if (!upstream.body) throw new Error('项目模型返回了空传输。');
          reader = upstream.body.getReader();
          signal.addEventListener('abort', cancel, { once: true });
          signal.throwIfAborted();
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform' });
          response.flushHeaders();
          let bytes = 0; let responseId: string | undefined; let checkpoint = performance.now();
          await options.modelTransport?.({ requestId, requirementsRevision: authorization.requirementsRevision, state: 'receiving', bytes });
          while (!stream.terminal) {
            const next = await reader.read();
            signal.throwIfAborted();
            if (next.done) break;
            const chunk = next.value;
            bytes += chunk.byteLength;
            const frames = stream.push(chunk, event => {
              const result = event.response as { id?: unknown } | undefined;
              if (typeof result?.id === 'string') responseId = result.id;
            });
            if (frames) await writeProjectStreamFrame(response, frames, signal, options.writeTimeoutMs);
            if (performance.now() - checkpoint >= 1000) {
              await options.modelTransport?.({ requestId, requirementsRevision: authorization.requirementsRevision, responseId, state: 'receiving', bytes }); checkpoint = performance.now();
            }
          }
          if (!stream.terminal) throw new Error('项目模型响应流结束时缺少终止事件。');
          await options.modelTransport?.({ requestId, requirementsRevision: authorization.requirementsRevision, responseId, state: 'received', bytes });
          if (!response.destroyed) response.end();
        } catch (error) {
          if (error instanceof ProjectStreamWriteTimeoutError) response.destroy();
          if (response.destroyed || response.writableEnded) return;
          if (response.headersSent) {
            const code = error instanceof ProjectStreamWriteTimeoutError ? 'downstream_timeout' : signal?.aborted ? 'task_stopped' : 'transport_interrupted';
            response.end(stream.terminal ? undefined : projectModelFailureFrame(code,
              code === 'task_stopped' ? '原生模型读取已停止，已收到的内容保留。' : '项目模型响应流中断，已收到的内容保留。'));
          } else {
            response.writeHead(409, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : '项目调用未完成。' } }));
          }
        } finally {
          response.removeListener('close', consumerClosed);
          signal?.removeEventListener('abort', abortUpload);
          signal?.removeEventListener('abort', cancel);
          cancel(); await cancellation; reader?.releaseLock();
          if (controller) this.modelRequests.delete(controller);
        }
      })().finally(() => this.pending.delete(operation));
      this.pending.add(operation);
    });
  }

  authorization(): ProjectGuardInput {
    const input = this.options.input();
    return { operationId: input.operationId, specHash: input.specHash, requirementsRevision: input.requirementsRevision };
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.address = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
    return this.address;
  }

  async guard(): Promise<{ sequence: number; input: ProjectExecutionInput }> {
    this.options.signal.throwIfAborted();
    const signal = AbortSignal.any([this.options.signal, AbortSignal.timeout(15000)]);
    const body = JSON.stringify(this.authorization());
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await (this.options.request ?? deviceFetch)(this.options.baseUrl, '/api/device/projectguard', this.options.credential, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal,
        });
        const result = await response.json() as { sequence: number; input: ProjectExecutionInput };
        signal.throwIfAborted(); return result;
      } catch (error) {
        signal.throwIfAborted();
        const transient = error instanceof DeviceHttpError ? [502, 503, 504].includes(error.status)
          : error instanceof TypeError || error instanceof Error && ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']
            .includes(String((error as Error & { code?: string; cause?: { code?: string } }).cause?.code ?? (error as Error & { code?: string }).code));
        if (!transient || attempt >= 2) throw error;
        // Only this read-only permission query is retried. Model submissions and tool calls are never replayed here.
        const wait = this.options.wait ?? ((ms: number, aborted: AbortSignal) => delay(ms, undefined, { signal: aborted }));
        await wait(attempt === 0 ? 200 : 600, signal);
      }
    }
  }

  async context(input: Record<string, unknown>): Promise<unknown> {
    this.options.signal.throwIfAborted();
    const response = await (this.options.request ?? deviceFetch)(this.options.baseUrl, '/api/device/projectcontext', this.options.credential, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorization: this.authorization(), input }), signal: this.options.signal,
    });
    return response.json();
  }

  async evidence(revision: number, name: string, bytes: Buffer): Promise<ImageAttachment> {
    this.options.signal.throwIfAborted();
    const authorization = this.authorization();
    if (authorization.requirementsRevision !== revision) throw new Error('截图对应的任务要求已更新。');
    const response = await (this.options.request ?? deviceFetch)(this.options.baseUrl, '/api/device/projectevidence', this.options.credential, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorization, image: { name, data: bytes.toString('base64') } }),
      signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(15000)]),
    });
    return response.json() as Promise<ImageAttachment>;
  }

  fence(): void {
    this.accepting = false;
    for (const controller of this.modelRequests) controller.abort(new DOMException('项目已停止接收模型操作。', 'AbortError'));
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.fence();
      await Promise.allSettled(this.pending);
      if (this.address) await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    })();
    return this.closing;
  }
}
