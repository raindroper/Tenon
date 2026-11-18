import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import PQueue from 'p-queue';
import { SettingsInputSchema, Store } from './store.js';
import { RuntimeInputError, type RuntimeApi } from './runtime.js';
import { canonicalApiPath, routeRuntime, publicCaseHistory, messageInput, sourceInput, feedbackInput, runtimeViewScope } from './v2/http.js';
import { acquireRuntimeLease } from './runtime-lease.js';
import { TaskConsentError } from './v2/consent.js';
import { createRequestAccess, publicOrigin } from './http-access.js';
import { writeRuntimeExport } from './runtime-export.js';
import { ModelConnectionError } from './models/connections.js';
import { SiwcError } from './models/siwc.js';
import { RuntimeStateStream } from './runtime-stream.js';
import { loadWebAuthConfig, WebAuth, WebAuthError } from './web-auth.js';
import { serveMedia } from './media/http.js';
import { routeDeviceHttp } from './devices/http.js';
import { DeviceBrokerError } from './devices/broker.js';
import { ProjectError } from './devices/projects.js';
import { ConnectorProviderError } from './connectors/types.js';
import { GitHubOutcomeUnknownError } from './connectors/github-operations.js';
import { MailOutcomeUnknownError } from './v2/mail-results.js';
import { routeMailFiles } from './connectors/mail-http.js';
import { HttpError, readJsonBody as readJson } from './http.js';
import { projectFilePathSchema } from '../shared/project-files.js';

interface AppOptions { store: Store; runtime: RuntimeApi; distDir?: string; auth?: WebAuth }

function writePrivateDownload(response: ServerResponse, method: string, name: string, mediaType: string, bytes: Buffer, fallback: string): void {
  const encodedName = encodeURIComponent(name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16));
  response.writeHead(200, { 'content-type': mediaType, 'content-length': bytes.length,
    'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodedName}`, 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
  response.end(method === 'HEAD' ? undefined : bytes);
}

export async function exportRuntimeData(store: Store, runtime: RuntimeApi) {
  const { conversation: _conversation, casePreviews: _casePreviews, history: _history, ...snapshot } = await runtime.snapshot();
  const history = async (kind: 'runs' | 'events') => {
    const pages: Awaited<ReturnType<RuntimeApi['history']>>['items'][] = [];
    let before: string | undefined;
    do {
      const page = await runtime.history({ kind, ...(before ? { before } : {}) });
      pages.push(page.items); before = page.nextBefore ?? undefined;
    } while (before);
    return pages.reverse().flat();
  };
  const [runs, events] = await Promise.all([history('runs'), history('events')]);
  const caseDetails = await Promise.all(snapshot.cases.map(async item => {
    const detail = await runtime.getCaseDetails(item.id); return { ...detail, history: publicCaseHistory(detail.history) };
  }));
  const agentWeChat = await runtime.exportRetiredAgentWeChat?.();
  const contextState = await runtime.exportContextState?.();
  const understanding = await runtime.listPersonalMemory();
  return { ...snapshot, understanding, runs, events, messages: store.list('messages'), version: 3, exportedAt: new Date().toISOString(), caseDetails,
    modelCalls: store.list('modelCalls'),
    ...(contextState ? { contextState } : {}),
    localDevices: runtime.listDevices ? await runtime.listDevices() : [],
    deviceOperations: runtime.listDeviceOperations ? await runtime.listDeviceOperations() : [],
    archive: { ...snapshot.archive, readOnly: true, ...(agentWeChat ? { agentWeChat } : {}), records: {
      memories: store.list('memories'), initiatives: store.list('initiatives'), activities: store.list('activities'),
      feedback: store.list('feedback').filter(item => item.targetType === 'memory' || item.targetType === 'initiative'),
      artifacts: store.list('artifacts').filter(item => Boolean(item.initiativeId)),
      sharedProposals: store.getMeta<unknown[]>('v2.sharedProposals', []),
    } } };
}

export function createApp(options: AppOptions): Server {
  const { store, runtime } = options;
  if (!runtime) throw new Error('createApp requires one RuntimeApi instance');
  const publicEntry = publicOrigin(process.env.RAE_PUBLIC_ORIGIN);
  if (publicEntry && !options.auth) throw new Error('公网入口需要配置 RAE_AUTH_FILE 内置用户，不能以免登录模式启动。');
  const auth = options.auth;
  const requestAllowed = createRequestAccess(process.env.RAE_PUBLIC_ORIGIN);
  const root = resolve(options.distDir ?? 'dist');
  const serialize = (data: unknown): string => {
    return store.models.redact(JSON.stringify(data), true);
  };
  const stream = new RuntimeStateStream(runtime, serialize);
  const runtimeControls = new PQueue({ concurrency: 1 });
  const json = (response: ServerResponse, status: number, data: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(serialize(data));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const address = server.address(); const port = typeof address === 'object' && address ? address.port : 4317;
      if (!requestAllowed(request.headers, port)) throw new HttpError(403, '请求来源不在允许的应用入口中。');
      let path: string;
      const [rawPath, ...rawQuery] = (request.url ?? '/').split('?');
      const query = new URLSearchParams(rawQuery.join('?'));
      try { path = decodeURIComponent(rawPath); } catch { throw new HttpError(400, '路径无效。'); }
      if (!path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').includes('..')) throw new HttpError(400, '路径无效。');
      const method = request.method ?? 'GET'; path = canonicalApiPath(path, method);
      const weChatObservation = path === '/api/wechat-observations' || path.startsWith('/api/wechat-observations/');
      // Device credentials are separately scoped; a browser session never authenticates the local hand.
      if (runtime.devices && await routeDeviceHttp(runtime.devices, request, response, path, method, auth ? runtime.weChatObservations : undefined)) return;
      if (path === '/api/health' && method === 'GET') { json(response, 200, { ok: true, runtime: 'mastra' }); return; }
      if (path === '/api/auth/session' && method === 'GET') {
        json(response, 200, auth?.session(request) ?? { required: false, authenticated: true }); return;
      }
      if (path === '/api/auth/login' && method === 'POST') {
        if (!auth) throw new HttpError(409, '当前本机入口未启用网页登录。');
        auth.assertMutationOrigin(request);
        const result = await auth.login(await readJson(request), request);
        response.setHeader('set-cookie', result.cookie); json(response, 200, result.session); return;
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        if (!auth) throw new HttpError(409, '当前本机入口未启用网页登录。');
        auth.assertMutationOrigin(request); z.object({}).strict().parse(await readJson(request));
        response.setHeader('set-cookie', auth.logout(request)); json(response, 200, { ok: true }); return;
      }
      if (path.startsWith('/api/auth/')) throw new HttpError(405, '不支持此登录操作。');
      if (!auth && weChatObservation) {
        throw new HttpError(409, '微信桌面观察需要启用榫本人登录。');
      }
      if (path.startsWith('/api/') && auth) {
        if (!auth.isAuthenticated(request)) throw new HttpError(401, '登录已失效，请重新登录。');
        if (!['GET', 'HEAD'].includes(method)) auth.assertMutationOrigin(request);
      }
      if (path === '/api/state/stream' && method === 'GET') {
        const delta = query.get('delta') === '1'; if (delta) query.delete('delta');
        stream.connect(response, () => !auth || auth.isAuthenticated(request), runtimeViewScope(query), delta); return;
      }
      if (await routeMailFiles(runtime, request, response, path, method, () => readJson(request))) return;
      const projectFile = path.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/files\/content$/);
      if (projectFile && (method === 'GET' || method === 'HEAD')) {
        if (!runtime.projectFileContent) throw new HttpError(409, '文件领取尚未接通。');
        const selection = z.object({ delivery: z.string().regex(/^[a-f0-9]{64}$/), file: projectFilePathSchema.optional() }).strict().parse(Object.fromEntries(query));
        const result = await runtime.projectFileContent(projectFile[1], selection.delivery, selection.file);
        writePrivateDownload(response, method, result.name, result.contentType, result.bytes, 'task-file'); return;
      }
      if (path === '/api/export' && method === 'GET') {
        response.setHeader('content-disposition', 'attachment; filename="another-rae-export.json"');
        const data = await exportRuntimeData(store, runtime);
        await writeRuntimeExport(response, data, data.messages, store, id => runtime.devices?.projects.readEvidenceImage(id)); return;
      }
      const mediaContent = path.match(/^\/api\/media\/([A-Za-z0-9_-]+)\/content$/);
      if (mediaContent && (method === 'GET' || method === 'HEAD')) {
        await serveMedia(request, response, await runtime.getMediaContent(mediaContent[1])); return;
      }
      if (path === '/api/messages' && method === 'POST') {
        const input = messageInput.parse(await readJson(request));
        if (input.caseId && !await runtime.getCase(input.caseId)) throw new HttpError(404, '事项不存在。');
        if (input.replyTo) {
          const target = store.get('messages', input.replyTo); if (!target) throw new HttpError(404, '回复对象不存在。');
          if (input.caseId && target.caseId && target.caseId !== input.caseId) throw new HttpError(409, '回复对象属于其他事项。');
        }
        const event = await runtime.ingestOwnerMessage(input.content, input.caseId, input.replyTo, input.attachments, input.reasoningEffort,
          input.deviceId, input.requestId, input.files);
        const message = store.get('messages', String(event.payload.messageId));
        if (!message) throw new Error('Runtime did not persist the owner message');
        json(response, 202, message); return;
      }
      const chatFilePath = path.match(/^\/api\/chat\/files\/([a-f0-9-]{36})$/);
      if (chatFilePath && (method === 'GET' || method === 'HEAD')) {
        const file = store.readChatFile(chatFilePath[1]);
        if (!file) throw new HttpError(404, '附件不存在。');
        writePrivateDownload(response, method, file.attachment.name, file.attachment.mediaType, file.data, 'chat-file'); return;
      }
      const imagePath = path.match(/^\/api\/images\/([a-f0-9-]{36})$/);
      if (imagePath && (method === 'GET' || method === 'HEAD')) {
        const image = store.readImage(imagePath[1]) ?? runtime.devices?.projects.readEvidenceImage(imagePath[1]);
        if (!image) throw new HttpError(404, '图片不存在。');
        response.writeHead(200, { 'content-type': image.attachment.mediaType, 'content-length': image.data.length,
          'cache-control': 'private, no-store', 'content-disposition': 'inline', 'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
        response.end(method === 'HEAD' ? undefined : image.data); return;
      }
      if (path === '/api/sources' && method === 'POST') {
        const input = sourceInput.parse(await readJson(request));
        if (input.caseId && !await runtime.getCase(input.caseId)) throw new HttpError(404, '事项不存在。');
        json(response, 201, await runtime.addSource(input)); return;
      }
      if (/^\/api\/sources\/[^/]+$/.test(path) && method === 'DELETE') throw new HttpError(409, '完整资料遗忘尚未接通，本次没有删除原文或事项历史；目录来源可使用停用入口。');
      if (path === '/api/feedback' && method === 'POST') {
        const body = await readJson(request);
        if (body && typeof body === 'object' && 'targetType' in body && ['memory', 'initiative'].includes(String(body.targetType))) throw new HttpError(410, '旧版记录只读归档，请纠正个人理解或反馈真实消息、成果与事项。');
        const input = feedbackInput.parse(body); json(response, 201, await runtime.addFeedback(input)); return;
      }
      if (path === '/api/settings' && method === 'POST') {
        const { expectedEnabledRevision, ...values } = z.object({ expectedEnabledRevision: z.number().int().min(0).safe().optional() })
          .passthrough().parse(await readJson(request));
        const input = SettingsInputSchema.parse(values);
        if (input.enabled === undefined && expectedEnabledRevision !== undefined) throw new HttpError(400, '启停版本仅用于明确修改推理开关。');
        const settings = await runtimeControls.add(async () => {
          if (input.enabled !== undefined && (expectedEnabledRevision === undefined || expectedEnabledRevision !== store.getSettings().enabledRevision)) {
            throw new HttpError(409, '推理开关已更新或页面版本过旧，请重新打开设置后确认；本次没有修改设置。');
          }
          if (['model', 'apiBaseUrl', 'apiKey', 'clearApiKey', 'reasoningEffort', 'maxOutputTokens'].some(key => key in input)) {
            throw new HttpError(400, '模型设置已移至模型连接管理，请刷新页面后修改对应连接或默认配置。');
          }
          if (input.enabled !== undefined) await runtime.cancel();
          let saved;
          try { saved = await store.updateSettings(input); }
          catch (error) { if (store.getSettings().enabled) runtime.start(); throw error; }
          if (input.enabled !== undefined) { if (saved.enabled) runtime.start(); else await runtime.stop(); }
          return saved;
        });
        json(response, 200, settings); return;
      }
      if (path === '/api/settings/test' && method === 'POST') {
        z.object({}).strict().parse(await readJson(request)); json(response, 200, await runtime.checkConnection()); return;
      }
      if (path === '/api/control' && method === 'POST') {
        const { action } = z.object({ action: z.enum(['pause', 'resume', 'wake']) }).strict().parse(await readJson(request));
        const status = await runtimeControls.add(async () => {
          if (action === 'pause') { await store.updateSettings({ enabled: false }); await runtime.stop(); }
          else if (action === 'resume') { await store.updateSettings({ enabled: true }); runtime.start(); }
          else await runtime.request('manual');
          return runtime.status();
        });
        json(response, 200, status); return;
      }
      if (path.startsWith('/api/')) {
        const origin = publicEntry?.host === request.headers.host ? publicEntry?.origin : 'http://' + request.headers.host;
        const body = ['POST', 'PATCH'].includes(method) ? await readJson(request) : undefined;
        if (weChatObservation && method === 'PATCH' && !auth?.isAuthenticated(request)) throw new HttpError(401, '登录已失效，请重新登录。');
        const result = await routeRuntime(runtime, path, method, body, query, origin); json(response, result.status, result.body); return;
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持此请求方法。');
      let file = resolve(root, '.' + path);
      if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, '路径无效。');
      try { if (!(await stat(file)).isFile()) file = resolve(root, 'index.html'); }
      catch { if (extname(path)) throw new HttpError(404, '文件不存在。'); file = resolve(root, 'index.html'); }
      let content: Buffer; try { content = await readFile(file); } catch { throw new HttpError(404, '界面尚未构建，请先运行 npm run build。'); }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
      response.end(method === 'HEAD' ? undefined : content);
    })().catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof WebAuthError) {
        if (error.retryAfter) response.setHeader('retry-after', String(error.retryAfter));
        json(response, error.status, { error: error.message });
      }
      else if (error instanceof HttpError || error instanceof RuntimeInputError || error instanceof DeviceBrokerError || error instanceof ProjectError || error instanceof ModelConnectionError) json(response, error.status, { error: error.message });
      else if (error instanceof SiwcError) json(response, error.status && error.status !== 401 && error.status >= 400 && error.status <= 599 ? error.status : 409, { error: error.message, code: error.code });
      else if (error instanceof ConnectorProviderError) json(response, error.status === 401 ? 409 : error.status, { error: error.message });
      else if (error instanceof TaskConsentError) json(response, error.code === 'not_found' ? 404 : 409, { error: error.message });
      else if (error instanceof GitHubOutcomeUnknownError || error instanceof MailOutcomeUnknownError) json(response, 409, { error: error.message });
      else if (error instanceof z.ZodError) json(response, 400, { error: '输入无效，请检查字段、类型及长度。' });
      else json(response, 500, { error: '操作失败，请检查本机服务状态后重试。' });
    });
  });
  const close = server.close.bind(server);
  server.close = callback => { stream.close(); return close(callback); };
  server.requestTimeout = 30000; server.headersTimeout = 10000; return server;
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  let authConfig: ReturnType<typeof loadWebAuthConfig>;
  try {
    publicOrigin(process.env.RAE_PUBLIC_ORIGIN);
    authConfig = loadWebAuthConfig({ credentialsFile: process.env.RAE_AUTH_FILE, publicOrigin: process.env.RAE_PUBLIC_ORIGIN });
  }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; return; }
  const dataDir = resolve(process.env.RAE_DATA_DIR || 'data'); const lease = await acquireRuntimeLease(dataDir);
  let store: Store | undefined; let runtime: RuntimeApi | undefined; let app: Server | undefined; let auth: WebAuth | undefined;
  let closing: Promise<void> | undefined; let detachLeaseListener: (() => void) | undefined;
  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      const failures: unknown[] = [];
      const clean = async (work: () => unknown) => { try { await work(); } catch (error) { failures.push(error); } };
      // Keep the device result endpoint reachable until accepted native operations have drained.
      await clean(() => runtime?.beginShutdown());
      await clean(() => app?.listening ? new Promise<void>(done => app!.close(() => done())) : Promise.resolve());
      await clean(() => runtime?.close());
      await clean(() => auth?.close());
      await clean(() => store?.close()); detachLeaseListener?.(); await clean(() => lease.release());
      if (failures.length) throw new AggregateError(failures, 'Runtime shutdown failed');
    })();
    return closing;
  };
  const stop = () => { void shutdown().catch(() => { console.error('运行时关闭未完整完成，请检查本机状态。'); process.exitCode = 1; }); };
  try {
    lease.assertOwned(dataDir); store = new Store(dataDir);
    if (authConfig) auth = new WebAuth(authConfig, resolve(dataDir, 'web-auth.sqlite'));
    const { V2Coordinator } = await import('./v2/coordinator.js');
    runtime = await V2Coordinator.create(store, { dataDir, lease });
    lease.assertOwned(dataDir); app = createApp({ store, runtime, auth }); detachLeaseListener = lease.onLost(stop);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    app.once('error', () => { console.error('无法启动本机服务，请检查 4317 端口及数据目录。'); stop(); process.exitCode = 1; });
    lease.assertOwned(dataDir); app.listen(4317, '127.0.0.1', () => { runtime!.start(); console.info('榫 Tenon: http://127.0.0.1:4317'); });
  } catch (error) { await shutdown(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { console.error('本机服务初始化失败，请检查运行环境与数据目录。'); process.exitCode = 1; });
}
