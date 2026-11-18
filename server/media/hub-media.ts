import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { z } from 'zod';

export const MEDIA_TAGS = ['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video'] as const;
export type MediaTag = typeof MEDIA_TAGS[number];
export interface MediaGeneration {
  resolutions?: string[]; defaultResolution?: string; aspectRatios?: string[]; defaultAspectRatio?: string;
  defaultSeconds?: number; minSeconds?: number; maxSeconds?: number; maxPromptLength?: number;
  supportsFirstFrame?: boolean; supportsFirstLastFrame?: boolean; defaultEnableAudio?: boolean; audioMode?: string;
}
export interface HubMediaModel { id: string; name: string; tags: MediaTag[]; videoGeneration?: MediaGeneration }
export interface HubMediaCatalog { enabled: boolean; models: HubMediaModel[] }
export interface HubImageRequest { model?: string; prompt: string; size?: string; image?: string[] }
export interface HubVideoRequest {
  model?: string; prompt: string; seconds?: number; resolution?: string; aspect_ratio?: string; image?: string;
  negative_prompt?: string; enable_audio?: boolean;
}
export interface HubVideoStatus {
  id: string; status: 'queued' | 'in_progress' | 'completed' | 'failed'; model?: string; seconds?: number;
  error?: { code: string; message: string }; hasOutput?: true;
}
export interface MediaContent {
  body: ReadableStream<Uint8Array>; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4'; contentLength?: number;
}
export type HubImageSource = { url: string } | { b64: string };
interface Connection { apiBaseUrl: string; apiKey?: string }
interface HubMediaOptions { baseUrl: string; connection: () => Connection; fetch?: typeof fetch; imageTimeoutMs?: number }
export class HubMediaError extends Error {
  constructor(message: string, readonly uncertain = false, readonly status?: number,
    readonly retryable = status === undefined || status === 408 || status === 429 || status >= 500) { super(message); this.name = 'HubMediaError'; }
}
const permanentError = (message: string) => new HubMediaError(message, false, undefined, false);
const IMAGE_LIMIT = 20 * 1024 * 1024;
const VIDEO_LIMIT = 100 * 1024 * 1024;
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const generationSchema = z.object({
  resolutions: z.array(z.string()).optional(), defaultResolution: z.string().optional(), aspectRatios: z.array(z.string()).optional(), defaultAspectRatio: z.string().optional(),
  defaultSeconds: z.number().int().positive().optional(), minSeconds: z.number().int().positive().optional(), maxSeconds: z.number().int().positive().optional(),
  maxPromptLength: z.number().int().positive().optional(), supportsFirstFrame: z.boolean().optional(), supportsFirstLastFrame: z.boolean().optional(),
  defaultEnableAudio: z.boolean().optional(), audioMode: z.string().optional(),
});
const modelSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().min(1).max(300).optional(), tags: z.array(z.string()), videoGeneration: generationSchema.optional() });
const modelInput = z.string().trim().min(1).max(200).optional();
const imageData = z.string().max(2 * 1024 * 1024).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
const imageSchema = z.object({ model: modelInput, prompt: z.string().trim().min(1).max(20000), size: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(), image: z.array(imageData).min(1).max(3).optional() }).strict();
const videoSchema = z.object({ model: modelInput, prompt: z.string().trim().min(1).max(20000), seconds: z.number().int().positive().max(3600).optional(),
  resolution: z.string().min(1).max(30).optional(), aspect_ratio: z.string().min(1).max(30).optional(), image: imageData.optional(),
  negative_prompt: z.string().max(20000).optional(), enable_audio: z.boolean().optional() }).strict();
const videoStatusSchema = z.object({ id: identifier, status: z.enum(['queued', 'in_progress', 'completed', 'failed']), model: z.string().optional(),
  seconds: z.coerce.number().finite().positive().max(3600).optional(), error: z.object({ code: z.string(), message: z.string() }).optional(),
  url: z.string().optional(), videos: z.array(z.string()).optional() });

function baseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw permanentError('媒体网关地址必须是 HTTPS 或本机 HTTP，且不能携带凭据、查询参数或片段。');
  }
  return url.href.replace(/\/+$/, '');
}
function imageType(bytes: Uint8Array): MediaContent['mediaType'] | undefined {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'image/webp';
  return undefined;
}
function bounded(body: ReadableStream<Uint8Array>, mediaType: MediaContent['mediaType'], maximum: number, contentLength?: number): MediaContent {
  if (contentLength !== undefined && contentLength > maximum) { void body.cancel(); throw permanentError('生成文件超过本机接收上限。'); }
  const reader = body.getReader(); let bytes = 0; let header = Buffer.alloc(0); let checked = false;
  return { mediaType, ...(contentLength === undefined ? {} : { contentLength }), body: new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) { if (!checked) throw permanentError('生成文件内容不完整。'); controller.close(); reader.releaseLock(); return; }
          bytes += next.value.byteLength; if (bytes > maximum) throw permanentError('生成文件超过本机接收上限。');
          if (!checked) {
            header = Buffer.concat([header, next.value]); if (header.length < 12) continue;
            if (mediaType === 'video/mp4' ? header.toString('ascii', 4, 8) !== 'ftyp' : imageType(header) !== mediaType) throw permanentError('生成文件格式与声明不符。');
            checked = true; controller.enqueue(header); header = Buffer.alloc(0);
          } else controller.enqueue(next.value);
          return;
        }
      } catch (error) { await reader.cancel(error).catch(() => undefined); reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => undefined); reader.releaseLock(); },
  }) };
}
async function readJson(response: Response, maximum = 32 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw permanentError('媒体网关未返回内容。');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > maximum) throw permanentError('媒体网关返回内容过大。'); chunks.push(next.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw permanentError('媒体网关返回的 JSON 格式无效。'); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Media calls stay within the already configured Hub; POSTs are never retried. */
export class HubMediaClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  static fromEnvironment(connection: () => Connection): HubMediaClient | undefined {
    const url = process.env.RAE_HUB_MEDIA_URL?.trim(); return url ? new HubMediaClient({ baseUrl: url, connection }) : undefined;
  }
  constructor(private readonly options: HubMediaOptions) { this.base = baseUrl(options.baseUrl); this.fetch = options.fetch ?? globalThis.fetch; }
  private connection(): Required<Connection> {
    const value = this.options.connection();
    if (baseUrl(value.apiBaseUrl) !== this.base) throw permanentError('当前模型连接与媒体网关地址不一致，未发送密钥或请求。');
    if (!value.apiKey?.trim()) throw permanentError('请先配置当前 Hub 的访问密钥。');
    return { ...value, apiKey: value.apiKey.trim() };
  }
  private async request(path: string, signal: AbortSignal, body?: unknown, timeout = 30000): Promise<Response> {
    signal.throwIfAborted(); const connection = this.connection(); const submitting = body !== undefined;
    const input = body === undefined ? undefined : JSON.stringify(body);
    if (input !== undefined && Buffer.byteLength(input) > 2 * 1024 * 1024) throw permanentError('参考图片与提示词合计超过 2 MB，请减少参考图片。');
    try {
      const response = await this.fetch(this.base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), headers: { Authorization: `Bearer ${connection.apiKey}`, ...(submitting ? { 'Content-Type': 'application/json' } : {}) }, body: input });
      if (!response.ok) {
        let message = response.status === 404 ? 'Hub 媒体接口未启用、任务不存在或模型不可用。' : `媒体网关请求失败（HTTP ${response.status}）。`;
        try { const payload = await readJson(response, 64 * 1024) as { error?: { message?: unknown } }; if (typeof payload.error?.message === 'string') message = payload.error.message.slice(0, 1000).replaceAll(connection.apiKey, '[REDACTED]'); } catch {}
        const rejected = [400, 401, 403, 404, 413, 422, 429].includes(response.status);
        throw new HubMediaError(message, submitting && !rejected, response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof HubMediaError) throw error;
      throw new HubMediaError(submitting ? '提交媒体请求后连接中断，是否已生成尚不确定；本次不会自动重新提交。' : '读取媒体任务或产物失败，请稍后查询原任务。', submitting);
    }
  }
  async catalog(signal: AbortSignal): Promise<HubMediaCatalog> {
    const payload = z.object({ enabled: z.boolean(), models: z.array(modelSchema) }).parse(await readJson(await this.request('/media/models', signal), 1024 * 1024));
    const seen = new Set<string>();
    return { enabled: payload.enabled, models: payload.models.flatMap(model => {
      const tags = MEDIA_TAGS.filter(tag => model.tags.includes(tag)); if (!tags.length || seen.has(model.id)) return []; seen.add(model.id);
      return [{ id: model.id, name: model.name ?? model.id, tags, ...(model.videoGeneration ? { videoGeneration: model.videoGeneration } : {}) }];
    }) };
  }
  async generateImage(request: HubImageRequest, signal: AbortSignal): Promise<{ model: string; source: HubImageSource }> {
    const input = imageSchema.parse(request);
    const path = input.image?.length ? '/images/edits' : '/images/generations';
    const response = await this.request(path, signal, { ...input, n: 1, response_format: 'url' }, this.options.imageTimeoutMs ?? 240000);
    try {
      const payload = z.object({ model: z.string().optional(), data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional() })).min(1) }).parse(await readJson(response));
      const item = payload.data[0];
      const source: HubImageSource | undefined = item.url ? { url: publicImageUrl(item.url).href }
        : item.b64_json && item.b64_json.length <= Math.ceil(IMAGE_LIMIT / 3) * 4 ? { b64: item.b64_json } : undefined;
      if (!source) throw new Error('Missing or oversized image result');
      return { model: payload.model ?? input.model ?? '', source };
    } catch (error) {
      if (error instanceof HubMediaError) throw new HubMediaError(error.message, true, error.status, error.retryable);
      throw new HubMediaError('已收到生图回复，但文件内容无法确认；为避免重复消耗，不会自动重新生成。', true);
    }
  }
  async openImage(source: HubImageSource, signal: AbortSignal): Promise<MediaContent> {
    signal.throwIfAborted();
    if ('url' in source) return publicImage(source.url, signal);
    const bytes = Buffer.from(source.b64, 'base64');
    if (!bytes.length || bytes.length > IMAGE_LIMIT || bytes.toString('base64') !== source.b64) throw permanentError('图片产物编码无效或过大，原生成请求没有重新提交。');
    const type = imageType(bytes); if (!type) throw permanentError('图片产物格式不受支持，原生成请求没有重新提交。');
    return bounded(new Response(bytes).body!, type, IMAGE_LIMIT, bytes.length);
  }
  async submitVideo(request: HubVideoRequest, signal: AbortSignal): Promise<HubVideoStatus> {
    const input = videoSchema.parse(request);
    const response = await this.request('/videos', signal, input, 60000);
    try { return this.status(await readJson(response)); }
    catch { throw new HubMediaError('视频提交回复不完整，任务是否已建立尚不确定；不会自动重新提交。', true); }
  }
  private status(payload: unknown): HubVideoStatus {
    const parsed = videoStatusSchema.safeParse(payload);
    if (!parsed.success) throw permanentError('Hub 视频任务状态格式无效；原任务引用已保留。');
    const value = parsed.data;
    return { id: value.id, status: value.status, ...(value.model ? { model: value.model } : {}),
      ...(value.seconds === undefined ? {} : { seconds: Number(value.seconds) }), ...(value.error ? { error: value.error } : {}),
      ...(value.url || value.videos?.length ? { hasOutput: true } : {}) };
  }
  async videoStatus(id: string, signal: AbortSignal): Promise<HubVideoStatus> { return this.status(await readJson(await this.request('/videos/' + identifier.parse(id), signal), 64 * 1024)); }
  async cancelVideo(id: string, signal: AbortSignal): Promise<HubVideoStatus> { return this.status(await readJson(await this.request('/videos/' + identifier.parse(id) + '/cancel', signal, {}), 64 * 1024)); }
  async downloadVideo(id: string, signal: AbortSignal): Promise<MediaContent> {
    const response = await this.request('/videos/' + identifier.parse(id) + '/content', signal, undefined, 120000);
    if (response.headers.get('content-type')?.split(';')[0] !== 'video/mp4' || !response.body) { await response.body?.cancel(); throw permanentError('Hub 没有返回 MP4 视频文件。'); }
    const length = Number(response.headers.get('content-length')); return bounded(response.body, 'video/mp4', VIDEO_LIMIT, Number.isFinite(length) && length > 0 ? length : undefined);
  }
}

function publicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 0 || b === 168 || b === 88 && c === 99) || a === 100 && b >= 64 && b <= 127
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  const [first, second] = address.split(':').map(value => parseInt(value || '0', 16));
  return !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8) || first === 0x2002 || first === 0x3ffe || first === 0x3fff);
}
function publicImageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.length > 8192) throw permanentError('图片下载地址不是可安全读取的公开 HTTPS 地址。');
  return url;
}
async function publicImage(value: string, signal: AbortSignal): Promise<MediaContent> {
  const url = publicImageUrl(value);
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true }); signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !publicIp(item.address))) throw permanentError('图片下载地址不属于公开网络。');
  const selected = addresses[0];
  return new Promise<MediaContent>((done, fail) => {
    // Pin the validated address while preserving hostname/SNI; never send the Hub key to a CDN.
    const req = httpsRequest(url, { signal, lookup: (_hostname, options, callback) => options.all ? callback(null, [selected]) : callback(null, selected.address, selected.family) }, response => {
      if (response.statusCode !== 200) { response.resume(); fail(new HubMediaError('图片产物下载失败，或地址要求重定向；没有重新生成。', false, response.statusCode)); return; }
      const type = response.headers['content-type']?.split(';')[0];
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(type ?? '')) { response.resume(); fail(permanentError('图片产物类型不受支持。')); return; }
      const length = Number(response.headers['content-length']);
      const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
      try { done(bounded(body, type as MediaContent['mediaType'], IMAGE_LIMIT, Number.isFinite(length) && length > 0 ? length : undefined)); } catch (error) { response.destroy(); fail(error); }
    });
    req.once('error', () => fail(new HubMediaError('图片产物下载失败；没有重新生成。'))); req.setTimeout(30000, () => req.destroy()); req.end();
  });
}
