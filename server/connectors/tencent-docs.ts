import { createHash } from 'node:crypto';
import { parseJsonEventStream, zodSchema } from 'ai';
import { z } from 'zod';
import type { ConnectorDocumentMetadata } from '../../shared/connectors.js';
import { assertProviderOk, readProviderJson, requestProvider } from './oauth.js';
import { ConnectorProviderError, type ConnectorProvider, type ScanInput } from './types.js';

const provider = '腾讯文档';
const endpoint = 'https://docs.qq.com/openapi/mcp';
const tokenGrantUrl = 'https://docs.qq.com/open/auth/mcp.html';
const requestedVersion = '2025-06-18';
const acceptedVersions = new Set(['2024-11-05', '2025-03-26', requestedVersion, '2025-11-25']);
const fileIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const filePathPattern = /^\/(?:doc|sheet|slide|form|mind|flowchart|board|smartcanvas|smartsheet|pdf|aio)\/([A-Za-z0-9_-]{1,128})\/?$/;
const rpcFrame = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(), error: z.unknown().optional() });
const toolResult = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() });
const documentContent = z.object({ content: z.string() });
const documentInfo = z.object({ file_id: z.string().optional(), file_name: z.string().optional(),
  title: z.string().optional(), file_url: z.string().optional(), url: z.string().optional(), type: z.unknown().optional() });
const cursorSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative() });

function documentUrl(value: string): { id: string; url: string; type: string } | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== 'https://docs.qq.com' || parsed.username || parsed.password) return undefined;
    const match = filePathPattern.exec(parsed.pathname);
    if (match) return { id: match[1], url: parsed.origin + parsed.pathname, type: parsed.pathname.split('/')[1] };
  } catch { /* a raw document ID is validated separately */ }
}

function validateScope(scope: string): string {
  const value = scope.trim();
  if (fileIdPattern.test(value)) return value;
  const document = documentUrl(value);
  if (document) return document.id;
  throw new ConnectorProviderError('请输入一个腾讯文档文件 ID 或 docs.qq.com 文档直链。', 400);
}

type ReadStage = '建立连接' | '获取工具列表' | '读取文件信息' | '读取正文';

function invalidResponse(stage: ReadStage): ConnectorProviderError {
  return new ConnectorProviderError(`腾讯文档返回的数据格式无法识别（${stage}）。`);
}

function upstreamError(error: unknown): ConnectorProviderError {
  const message = JSON.stringify(error) ?? '';
  if (/\b4000(?:06|12)\b|Token 鉴权失败/i.test(message)) return new ConnectorProviderError('腾讯文档授权已失效，请重新获取 Token。', 401);
  if (/\b400005\b/.test(message)) return new ConnectorProviderError('腾讯文档拒绝访问，请检查授权账号能否打开该文件。', 403);
  if (/\b40000[78]\b|VIP权限不足|积分不足/.test(message)) return new ConnectorProviderError('腾讯文档上游报告会员权限或额度不足。', 403);
  return new ConnectorProviderError('腾讯文档未能读取指定文件，请检查文档权限和类型。');
}

async function readRpcFrame(response: Response, id: number, signal: AbortSignal, stage: ReadStage) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    const parsed = rpcFrame.safeParse(await readProviderJson(response, signal, provider));
    if (!parsed.success || parsed.data.id !== id && !(parsed.data.id == null && parsed.data.error !== undefined)) throw invalidResponse(stage);
    return parsed.data;
  }
  if (!response.body) throw invalidResponse(stage);
  const source = response.body.getReader();
  let bytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await source.read();
      if (done) { controller.close(); return; }
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new ConnectorProviderError(`腾讯文档响应超出读取上限（${stage}）。`);
      controller.enqueue(value);
    },
    cancel: () => source.cancel().catch(() => undefined),
  });
  const frames = parseJsonEventStream({ stream, schema: zodSchema(rpcFrame) }).getReader();
  try {
    for (;;) {
      const { value, done } = await frames.read();
      signal.throwIfAborted();
      if (done) throw invalidResponse(stage);
      if (!value.success) throw invalidResponse(stage);
      const frame = value.value;
      if (frame.id === id || frame.id == null && frame.error !== undefined) return frame;
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ConnectorProviderError) throw error;
    throw invalidResponse(stage);
  } finally {
    await frames.cancel().catch(() => undefined);
    await source.cancel().catch(() => undefined);
    frames.releaseLock();
    source.releaseLock();
  }
}

function unwrapTool(result: unknown, stage: ReadStage): unknown {
  const parsed = toolResult.safeParse(result);
  if (!parsed.success) throw invalidResponse(stage);
  const { isError, structuredContent, content } = parsed.data;
  const text = content?.find(item => item.type === 'text')?.text;
  let data: unknown = structuredContent;
  if (data === undefined && text !== undefined) {
    try { data = JSON.parse(text); }
    catch { if (isError) throw upstreamError(text); else throw invalidResponse(stage); }
  }
  if (isError) throw upstreamError(data ?? text);
  const error = z.object({ error: z.unknown().optional() }).safeParse(data);
  if (!error.success) throw invalidResponse(stage);
  if (error.data.error) throw upstreamError(error.data.error);
  return data;
}

type ReadInput = Omit<ScanInput, 'cursor'>;
type DocumentSession = {
  scope: string;
  names: Set<string>;
  call(stage: '读取文件信息' | '读取正文', name: string): Promise<unknown>;
};

async function withDocumentSession<T>({ token, scope: rawScope, signal: parentSignal }: ReadInput,
  purpose: 'metadata' | 'content', work: (session: DocumentSession) => Promise<T>): Promise<T> {
  const scope = validateScope(rawScope);
  if (!/^[\x21-\x7e]{1,16384}$/.test(token.accessToken)) {
    throw new ConnectorProviderError('请输入腾讯文档授权页提供的个人 Token。', 401);
  }
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(25_000)]);
  const headers = new Headers({ Authorization: token.accessToken, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream' });
  let sessionId: string | null = null;
  let nextId = 1;
  async function rpc(stage: ReadStage, method: 'initialize' | 'notifications/initialized' | 'tools/list' | 'tools/call', params: object = {}) {
    const id = method === 'notifications/initialized' ? undefined : nextId++;
    const response = await requestProvider(endpoint, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }, signal, provider);
    await assertProviderOk(response, provider);
    if (id === undefined) { await response.body?.cancel().catch(() => undefined); return; }
    const frame = await readRpcFrame(response, id, signal, stage);
    if (frame.error !== undefined) throw upstreamError(frame.error);
    if (method === 'initialize') sessionId = response.headers.get('mcp-session-id');
    return frame.result;
  }

  try {
    const init = z.object({ protocolVersion: z.string() }).safeParse(await rpc('建立连接', 'initialize', {
      protocolVersion: requestedVersion, capabilities: {}, clientInfo: { name: 'AnotherRae', version: '0.1.3' },
    }));
    if (!init.success || !acceptedVersions.has(init.data.protocolVersion)) throw invalidResponse('建立连接');
    headers.set('MCP-Protocol-Version', init.data.protocolVersion);
    if (sessionId) headers.set('Mcp-Session-Id', sessionId);
    await rpc('建立连接', 'notifications/initialized');

    const names = new Set<string>();
    let nextCursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const list = z.object({ tools: z.array(z.object({ name: z.string() })), nextCursor: z.string().max(4096).optional() })
        .safeParse(await rpc('获取工具列表', 'tools/list', nextCursor ? { cursor: nextCursor } : {}));
      if (!list.success) throw invalidResponse('获取工具列表');
      for (const tool of list.data.tools) names.add(tool.name);
      nextCursor = list.data.nextCursor;
      if (!nextCursor || names.has('manage.query_file_info')
        && (purpose === 'metadata' || names.has('get_content') || names.has('manage.get_content'))) break;
    }
    return await work({ scope, names, call: async (stage, name) => unwrapTool(await rpc(stage, 'tools/call', {
      name, arguments: { file_id: scope },
    }), stage) });
  } catch (error) {
    parentSignal.throwIfAborted();
    if (signal.aborted) throw new ConnectorProviderError('腾讯文档读取超时。');
    throw error;
  } finally {
    if (sessionId && !signal.aborted) {
      await requestProvider(endpoint, { method: 'DELETE', headers }, signal, provider)
        .then(response => response.body?.cancel()).catch(() => undefined);
    }
  }
}

async function readDocumentInfo(session: DocumentSession): Promise<ConnectorDocumentMetadata | undefined> {
  if (!session.names.has('manage.query_file_info')) return;
  const info = documentInfo.safeParse(await session.call('读取文件信息', 'manage.query_file_info'));
  if (!info.success) throw invalidResponse('读取文件信息');
  const target = documentUrl(info.data.file_url ?? info.data.url ?? '');
  const matchesUrl = target?.id === session.scope;
  // A share-link ID can differ from Tencent's canonical file ID.
  if (info.data.file_id !== undefined && info.data.file_id !== session.scope && !matchesUrl) {
    throw invalidResponse('读取文件信息');
  }
  const type = typeof info.data.type === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(info.data.type)
    ? info.data.type : matchesUrl ? target.type : undefined;
  return {
    title: (info.data.file_name || info.data.title || '腾讯文档').slice(0, 200),
    ...(type ? { type } : {}),
    ...(matchesUrl ? { url: target.url } : {}),
  };
}

async function previewDocument(input: ReadInput): Promise<ConnectorDocumentMetadata> {
  return withDocumentSession(input, 'metadata', async session => {
    const document = await readDocumentInfo(session);
    if (!document) throw new ConnectorProviderError('腾讯文档当前未提供可用的文件信息工具。');
    return document;
  });
}

async function readDocumentContent(session: DocumentSession) {
  const readTool = session.names.has('get_content') ? 'get_content'
    : session.names.has('manage.get_content') ? 'manage.get_content' : undefined;
  if (!readTool) throw new ConnectorProviderError('腾讯文档当前未提供可用的正文读取工具。');
  const document = await readDocumentInfo(session);
  const body = documentContent.safeParse(await session.call('读取正文', readTool));
  if (!body.success) throw invalidResponse('读取正文');
  return { content: body.data.content, ...(document ? { document } : {}) };
}

function readDocument(input: ReadInput) {
  return withDocumentSession(input, 'content', readDocumentContent);
}

async function scan({ cursor, ...input }: ScanInput) {
  let previous: z.infer<typeof cursorSchema> | undefined;
  try { previous = cursor === undefined ? undefined : cursorSchema.parse(JSON.parse(cursor)); }
  catch { throw new ConnectorProviderError('腾讯文档同步游标无法识别，请重新连接。', 409); }
  return withDocumentSession(input, 'content', async session => {
    const { content, document } = await readDocumentContent(session);
    const title = document?.title ?? '腾讯文档';
    const digest = createHash('sha256').update(JSON.stringify([title, content])).digest('hex');
    const changed = previous !== undefined && previous.digest !== digest;
    const revision = (previous?.revision ?? 0) + (changed ? 1 : 0);
    const snapshot = { id: session.scope, revision: `${revision}:${digest}`, title,
      content: content.slice(0, 200_000), totalCharacters: content.length, truncated: content.length > 200_000, url: document?.url };
    return { cursor: JSON.stringify({ digest, revision }), ...(document ? { document } : {}),
      documentSnapshot: snapshot, changes: changed ? [snapshot] : [] };
  });
}

export function createTencentDocsProvider(_env: NodeJS.ProcessEnv): ConnectorProvider {
  const manualGrant = (): never => { throw new ConnectorProviderError('请在腾讯文档官方页面获取个人 Token 后连接。', 409); };
  return { tokenGrantUrl, validateScope, authorize: () => new URL(tokenGrantUrl),
    exchange: async () => manualGrant(), refresh: async () => manualGrant(), scan, previewDocument, readDocument };
}
