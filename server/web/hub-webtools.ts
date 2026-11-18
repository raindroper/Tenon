import { parseJsonEventStream, zodSchema } from 'ai';
import PQueue from 'p-queue';
import { z } from 'zod';

export interface WebToolResult {
  status: 'ok' | 'empty' | 'unavailable' | 'error'; content: string;
  sources: Array<{ title: string; url: string }>; sourceNote?: string; truncated?: boolean;
  basis?: 'gateway_summary';
}
export type TrackWebRequest = (work: () => Promise<WebToolResult>) => Promise<WebToolResult>;
interface Connection { apiBaseUrl: string; apiKey?: string; model: string }
interface HubWebToolsOptions { endpoint: string; connection: () => Connection; fetch?: typeof fetch; timeoutMs?: number }
const inputSchema = z.object({ query: z.string().trim().min(2).max(2000), num_results: z.number().int().min(1).max(10).default(5) }).strict();
const frameSchema = z.object({ type: z.string() }).passthrough();
const unavailable = (content: string): WebToolResult => ({ status: 'unavailable', content, sources: [], basis: 'gateway_summary' });
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const isHttpUrl = (value: string) => {
  try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && value.length <= 8192; }
  catch { return false; }
};

function endpoint(value: string): URL {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
    !(parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('Hub 搜索地址必须是 HTTPS 或本机 HTTP，且不能携带凭据、查询参数或片段。');
  }
  return parsed;
}
function isSearchItem(value: unknown): boolean {
  const item = object(value); const action = object(item?.action);
  return item?.type === 'web_search_call' && item.status === 'completed' && action?.type === 'search' && typeof action.query === 'string' && Boolean(action.query.trim());
}
function finalResult(response: Record<string, unknown>, searched: boolean): WebToolResult {
  const output = Array.isArray(response.output) ? response.output : [];
  searched ||= output.some(isSearchItem);
  const texts: string[] = []; const sources: WebToolResult['sources'] = []; const seen = new Set<string>();
  for (const value of output) {
    const item = object(value);
    if (item?.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) continue;
    for (const value of item.content) {
      const part = object(value);
      if (part?.type !== 'output_text' || typeof part.text !== 'string') continue;
      texts.push(part.text);
      for (const value of Array.isArray(part.annotations) ? part.annotations : []) {
        const annotation = object(value);
        if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string' || !isHttpUrl(annotation.url) || seen.has(annotation.url)) continue;
        sources.push({ title: typeof annotation.title === 'string' ? annotation.title.slice(0, 2000) : annotation.url, url: annotation.url });
        seen.add(annotation.url);
        if (sources.length >= 30) break;
      }
    }
  }
  const content = texts.join('\n\n');
  if (!searched || !sources.length || !content.trim()) return unavailable('Hub 没有返回可核验的搜索来源；不能把模型自行回答当作联网结果。');
  return { status: 'ok', content: content.slice(0, 100000), sources: sources.slice(0, 30), basis: 'gateway_summary',
    sourceNote: '这是 Hub 调用模型整理的检索摘要，不是网页原文；只有 sources 中的链接获得了网关引用验证。',
    truncated: response.status === 'incomplete' || content.length > 100000 };
}

/** Uses the existing gateway's supported Responses web-tools path; no source/module access. */
export class HubWebTools {
  private readonly queue = new PQueue({ concurrency: 1 });
  private readonly lifetime = new AbortController();
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private closed = false;
  private closing?: Promise<void>;

  static fromEnvironment(connection: () => Connection): HubWebTools | undefined {
    const url = process.env.RAE_HUB_SEARCH_URL?.trim();
    return url ? new HubWebTools({ endpoint: url, connection }) : undefined;
  }
  constructor(private readonly options: HubWebToolsOptions) {
    this.url = endpoint(options.endpoint).href;
    this.timeoutMs = Math.max(1, Math.min(90000, options.timeoutMs ?? 90000));
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  async run(op: 'web_search' | 'web_fetch', args: Record<string, unknown>, signal: AbortSignal, track?: TrackWebRequest): Promise<WebToolResult> {
    if (this.closed) throw new Error('网页搜索连接已经关闭。');
    signal.throwIfAborted();
    if (op === 'web_fetch') return unavailable('Hub 没有提供可独立核验的网页原文读取接口；当前仅接通带来源的检索摘要。');
    if (op !== 'web_search') throw new Error('不支持的网页工具。');
    const input = inputSchema.parse(args);
    if (this.queue.size >= 8) return unavailable('网页搜索正在处理其他请求，请稍后再试。');
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    return new Promise<WebToolResult>((done, fail) => {
      let started = false;
      const abortQueued = () => { if (!started) fail(combined.reason ?? new DOMException('网页搜索已停止。', 'AbortError')); };
      combined.addEventListener('abort', abortQueued, { once: true });
      void this.queue.add(async () => {
        started = true; combined.removeEventListener('abort', abortQueued); combined.throwIfAborted();
        let connection: Connection;
        try {
          connection = this.options.connection();
          const expected = endpoint(connection.apiBaseUrl); expected.pathname = expected.pathname.replace(/\/+$/, '') + '/responses';
          if (expected.href !== this.url) return unavailable('当前模型地址与已配置的 Hub 搜索地址不一致，未发送密钥或请求。');
        } catch { return unavailable('当前模型连接无法用于 Hub 搜索。'); }
        if (!connection.apiKey?.trim() || !connection.model.trim()) return unavailable('请先配置当前 Hub 的模型与访问密钥。');
        const work = () => this.request(connection, input, combined);
        return track ? track(work) : work();
      }).then(value => { combined.removeEventListener('abort', abortQueued); done(value); }, error => {
        combined.removeEventListener('abort', abortQueued); fail(error);
      });
      if (combined.aborted) abortQueued();
    });
  }
  private async request(connection: Connection, input: z.infer<typeof inputSchema>, signal: AbortSignal): Promise<WebToolResult> {
    const timeout = new AbortController(); const requestSignal = AbortSignal.any([signal, timeout.signal]);
    const deadline = setTimeout(() => timeout.abort(new DOMException('Hub 搜索超时。', 'TimeoutError')), this.timeoutMs); deadline.unref();
    let reader: ReadableStreamDefaultReader<unknown> | undefined;
    let transport: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let transportCancel: Promise<void> | undefined;
    let cancelPromise: Promise<void> | undefined;
    const cancelTransport = () => {
      if (transport && !transportCancel) transportCancel = transport.cancel(requestSignal.reason).catch(() => undefined);
      return transportCancel ?? Promise.resolve();
    };
    const cancel = () => {
      if (!reader && !transport) return Promise.resolve();
      if (!cancelPromise) cancelPromise = Promise.allSettled([reader?.cancel(requestSignal.reason), cancelTransport()]).then(() => undefined);
      return cancelPromise ?? Promise.resolve();
    };
    const abort = () => { void cancel(); };
    requestSignal.addEventListener('abort', abort, { once: true });
    try {
      requestSignal.throwIfAborted();
      const response = await this.fetch(this.url, { method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { Authorization: `Bearer ${connection.apiKey!.trim()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model: connection.model, stream: true, tools: [{ type: 'web_search' }, { type: 'web_fetch' }],
          tool_choice: 'auto', parallel_tool_calls: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text:
            '请实际调用 web_search 查询下面的数据，按需要用 web_fetch 阅读来源，整理有用的检索摘要并附准确的原始来源链接；不要用模型记忆冒充搜索，不要编造日期或出处。若工具不可用请明确说明。查询数据：\n' + JSON.stringify(input) }] }] }) });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return unavailable(`Hub 搜索请求失败（HTTP ${response.status}）。`); }
      if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        await response.body?.cancel().catch(() => undefined); return unavailable('Hub 没有返回可识别的搜索事件流。');
      }
      let bytes = 0;
      transport = response.body.getReader();
      const bounded = new ReadableStream<Uint8Array>({ async pull(controller) {
        const chunk = await transport!.read();
        if (chunk.done) { controller.close(); return; }
        bytes += chunk.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error('Search stream exceeded transport bound');
        controller.enqueue(chunk.value);
      }, cancel: () => cancelTransport() });
      reader = parseJsonEventStream({ stream: bounded, schema: zodSchema(frameSchema) }).getReader();
      if (requestSignal.aborted) await cancel();
      let searched = false; let final: Record<string, unknown> | undefined;
      for (;;) {
        const next = await reader.read(); requestSignal.throwIfAborted();
        if (next.done) break;
        const parsed = next.value as { success: boolean; value?: Record<string, unknown> };
        if (!parsed.success || !parsed.value) throw new Error('Invalid gateway search event');
        const frame = parsed.value;
        if (frame.type === 'error' || frame.type === 'response.failed') throw new Error('Gateway search failed');
        if (frame.type === 'response.output_item.done' && isSearchItem(frame.item)) searched = true;
        if (frame.type === 'response.completed' || frame.type === 'response.incomplete') {
          final = object(frame.response);
          if (!final) throw new Error('Missing gateway response');
          break;
        }
      }
      if (!final || !['completed', 'incomplete'].includes(String(final.status))) return unavailable('Hub 搜索没有完整返回可确认的结果。');
      return finalResult(final, searched);
    } catch {
      if (signal.aborted) throw signal.reason ?? new DOMException('网页搜索已停止。', 'AbortError');
      return unavailable(timeout.signal.aborted ? 'Hub 搜索超时，本次请求已经停止。' : 'Hub 搜索未能完整返回结果，请检查网关联网工具和网络出口。');
    } finally {
      clearTimeout(deadline); requestSignal.removeEventListener('abort', abort); await cancel(); reader?.releaseLock(); transport?.releaseLock();
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.lifetime.abort(new DOMException('网页搜索连接已关闭。', 'AbortError'));
    this.closing = this.queue.onIdle(); return this.closing;
  }
}
