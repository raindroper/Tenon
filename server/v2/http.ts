import { extname } from 'node:path';
import { z } from 'zod';
import { projectRequestSchema, serverProjectResourceSchema } from '../../shared/local-project.js';
import type { RuntimeApi } from '../runtime.js';
import { deviceRenameSchema } from '../devices/broker.js';
import { taskRequestSpecSchema } from './consent.js';
import { connectorKinds } from '../../shared/connectors.js';
import { ewsConnectInput, ewsUpdateInput, ewsQueryInput, ewsReadInput, ewsSelectionInput, ewsAttachmentInput } from '../../shared/ews.js';
import { githubConnectInputSchema, githubUpdateInputSchema, githubUpgradeInputSchema } from '../../shared/github-connection.js';
import { oauthAppInputSchema, oauthAppKindSchema } from '../../shared/oauth-apps.js';
import { weChatObservationId, weChatObservationSelection } from '../../shared/wechat-observation.js';
export { messageInput } from './inputs.js';

import { HttpError } from '../http.js';
import { modelConnectionInputSchema, modelPreferenceSchema, modelSelectionSchema } from '../../shared/model-connections.js';
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const viewScope = z.object({ caseId: id.optional(), before: id.optional() }).strict().refine(scope => !scope.before || Boolean(scope.caseId));
export function runtimeViewScope(query: URLSearchParams) { return viewScope.parse(Object.fromEntries(query)); }
const short = (max: number) => z.string().trim().min(1).max(max);
const connectorSelection = z.object({ caseId: id, scope: short(300) }).strict();
const connectorKind = z.enum(connectorKinds);
const connectorToken = short(8192).refine(value => !/[\r\n\0]/.test(value));
const extensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml', '.toml']);
export const sourceInput = z.object({ title: short(200), content: z.string().trim().min(1)
  .refine(value => Buffer.byteLength(value, 'utf8') <= 200 * 1024 && !value.includes('\0'), '仅支持不超过200KB的文本资料。'),
  filename: z.string().max(250).refine(value => !/[\\/\0]/.test(value) && extensions.has(extname(value).toLowerCase()), '文件类型或名称无效。').optional(), caseId: id.optional() }).strict();
export const feedbackInput = z.object({ targetType: z.enum(['message', 'artifact', 'case']), targetId: id,
  verdict: z.enum(['useful', 'off_target', 'correction', 'not_now']), comment: z.string().trim().max(10000).default(''),
  targetVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const memoryCorrection = z.object({ value: short(2000), kind: z.enum(['fact', 'preference', 'habit', 'experience']).optional(),
  subject: z.enum(['owner', 'agent']).optional(),
  purpose: z.enum(['identity', 'interaction', 'context']).optional(),
  identity: z.object({ kind: z.enum(['name', 'alias']), value: short(200), platform: short(200).optional(), conversationId: short(200).optional() }).strict().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  scope: z.enum(['case', 'domain', 'global']).optional(), domains: z.array(short(100)).min(1).max(20).optional(), caseIds: z.array(id).max(30).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional() }).strict();

export function canonicalApiPath(path: string, method: string): string {
  // V2 source deletion stops a directory connection; it never deletes an uploaded text.
  const source = path.match(/^\/api\/v2\/sources\/([^/]+)$/);
  if (source && method === 'DELETE') return '/api/sources/workspace/' + source[1];
  return path.replace(/^\/api\/v2\//, '/api/');
}
export function publicCaseHistory(messages: readonly unknown[]) {
  return messages.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const message = value as Record<string, unknown>;
    const content = message.content && typeof message.content === 'object' ? message.content as Record<string, unknown> : {};
    const parts = Array.isArray(content.parts) ? content.parts.filter(part => part && typeof part === 'object' && ['text', 'tool-invocation'].includes(String(part.type))) : [];
    return [{ id: message.id, role: message.role, threadId: message.threadId, createdAt: message.createdAt, content: { format: 2, parts } }];
  });
}

/** Domain mutations share this handler under canonical and compatibility URLs. */
export async function routeRuntime(api: RuntimeApi, originalPath: string, method: string, body?: unknown, query = new URLSearchParams(), origin?: string): Promise<{ status: number; body: unknown }> {
  const path = canonicalApiPath(originalPath, method);
  if (path === '/api/models' || path.startsWith('/api/models/')) {
    const models = api.modelConnections;
    if (!models) throw new HttpError(409, '当前运行时未提供模型连接管理。');
    if (path === '/api/models' && method === 'GET') return { status: 200, body: await models.list() };
    if (path === '/api/models/connections' && method === 'POST') {
      try { return { status: 201, body: await models.save(modelConnectionInputSchema.parse(body)) }; }
      finally { if (body && typeof body === 'object') (body as Record<string, unknown>).apiKey = ''; }
    }
    const connection = path.match(/^\/api\/models\/connections\/([^/]+)$/);
    if (connection && method === 'PATCH') {
      try { return { status: 200, body: await models.save(modelConnectionInputSchema.parse({ ...(body && typeof body === 'object' ? body : {}), id: id.parse(connection[1]) })) }; }
      finally { if (body && typeof body === 'object') (body as Record<string, unknown>).apiKey = ''; }
    }
    if (connection && method === 'DELETE') {
      const input = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(body);
      return { status: 200, body: await models.remove(id.parse(connection[1]), input.expectedRevision) };
    }
    if (path === '/api/models/defaults' && method === 'PATCH') return { status: 200, body: await models.defaults(z.object({
      global: modelSelectionSchema.nullable().optional(), background: modelPreferenceSchema.optional(), expectedRevision: z.number().int().nonnegative(),
    }).strict().parse(body)) };
    const scene = path.match(/^\/api\/models\/scenes\/([^/]+)$/);
    if (scene && method === 'PATCH') return { status: 200, body: await models.scene(id.parse(scene[1]), z.object({
      preference: modelPreferenceSchema, expectedRevision: z.number().int().nonnegative(),
    }).strict().parse(body)) };
    const action = path.match(/^\/api\/models\/connections\/([^/]+)\/(catalog|test|logout)$/);
    if (action && method === 'POST') {
      const connectionId = id.parse(action[1]);
      if (action[2] === 'test') {
        const { selection } = z.object({ selection: modelSelectionSchema }).strict().parse(body);
        if (selection.connectionId !== connectionId) throw new HttpError(400, '测试模型不属于当前连接。');
        return { status: 200, body: await models.test(selection) };
      }
      z.object({}).strict().parse(body);
      return { status: 200, body: action[2] === 'catalog' ? await models.catalog(connectionId) : await models.logout(connectionId) };
    }
    if (path === '/api/models/oauth/start' && method === 'POST') return { status: 200, body: await models.login(z.object({
      connectionId: id.optional(), name: z.string().trim().min(1).max(100).optional(), redirectUri: z.string().max(200).optional(), reconsent: z.boolean().optional(),
    }).strict().parse(body)) };
    const login = path.match(/^\/api\/models\/oauth\/([^/]+)(\/complete)?$/);
    if (login) {
      const loginId = id.parse(login[1]);
      if (login[2] && method === 'POST') {
        try { return { status: 200, body: await models.completeLogin(loginId, z.object({ callbackUrl: z.string().max(16_384) }).strict().parse(body).callbackUrl) }; }
        finally { if (body && typeof body === 'object') (body as Record<string, unknown>).callbackUrl = ''; }
      }
      if (!login[2] && method === 'GET') return { status: 200, body: await models.loginStatus(loginId) };
      if (!login[2] && method === 'DELETE') { await models.cancelLogin(loginId); return { status: 200, body: { cancelled: true } }; }
    }
    throw new HttpError(404, '模型连接操作不存在。');
  }
  if (path === '/api/state' && method === 'GET') return { status: 200, body: await api.snapshot(runtimeViewScope(query)) };
  const history = path.match(/^\/api\/history\/(runs|events)$/);
  if (history && method === 'GET') {
    const scope = z.object({ caseId: id.optional(), before: z.string().min(1).max(300).optional() }).strict().parse(Object.fromEntries(query));
    return { status: 200, body: await api.history({ ...scope, kind: history[1] as 'runs' | 'events' }) };
  }
  const stopRun = path.match(/^\/api\/runs\/([^/]+)\/stop$/);
  if (stopRun && method === 'POST') {
    z.object({}).strict().parse(body);
    return { status: 200, body: await api.stopChatRun(id.parse(stopRun[1])) };
  }
  if (path === '/api/wechat-observations' || path.startsWith('/api/wechat-observations/')) {
    const observations = api.weChatObservations;
    if (!observations) throw new HttpError(409, '当前运行时没有微信桌面观察。');
    if (path === '/api/wechat-observations' && method === 'GET') return { status: 200, body: await observations.list() };
    if (path === '/api/wechat-observations' && method === 'POST') return { status: 201, body: await observations.start(weChatObservationSelection.parse(body)) };
    const status = path.match(/^\/api\/wechat-observations\/([^/]+)\/status$/);
    if (status && method === 'GET') return { status: 200, body: await observations.status(weChatObservationId.parse(status[1])) };
    const analyze = path.match(/^\/api\/wechat-observations\/([^/]+)\/analyze$/);
    if (analyze && method === 'POST') {
      z.object({}).strict().parse(body);
      return { status: 200, body: await observations.analyze(weChatObservationId.parse(analyze[1])) };
    }
    const grant = path.match(/^\/api\/wechat-observations\/([^/]+)$/);
    if (grant && method === 'PATCH') {
      return { status: 200, body: await observations.renew(weChatObservationId.parse(grant[1]), weChatObservationSelection.parse(body)) };
    }
    if (grant && method === 'DELETE') return { status: 200, body: await observations.revoke(weChatObservationId.parse(grant[1])) };
    throw new HttpError(404, '微信观察操作不存在。');
  }
  if (path === '/api/connectors' || path.startsWith('/api/connectors/')) {
    const settings = api.connectorSettings;
    if (!settings) throw new HttpError(409, '当前运行时未提供连接器。');
    if (path === '/api/connectors' && method === 'GET') return { status: 200, body: await settings.list() };
    const githubAccount = path.match(/^\/api\/connectors\/github\/([^/]+)\/account$/);
    if (githubAccount && method === 'POST') return { status: 200, body: await settings.upgradeGitHub(id.parse(githubAccount[1]), githubUpgradeInputSchema.parse(body)) };
    const githubUpdate = path.match(/^\/api\/connectors\/github\/([^/]+)\/credentials$/);
    if ((path === '/api/connectors/github' && method === 'POST') || (githubUpdate && method === 'PATCH')) {
      try {
        return githubUpdate
          ? { status: 200, body: await settings.updateGitHub(id.parse(githubUpdate[1]), githubUpdateInputSchema.parse(body)) }
          : { status: 201, body: await settings.connectGitHub(githubConnectInputSchema.parse(body)) };
      } finally { if (body && typeof body === 'object') (body as Record<string, unknown>).token = ''; }
    }
    const oauthApp = path.match(/^\/api\/connectors\/(gmail|outlook)\/app$/);
    if (oauthApp && method === 'POST') {
      try { return { status: 200, body: await settings.saveOAuthApp(oauthAppKindSchema.parse(oauthApp[1]), oauthAppInputSchema.parse(body)) }; }
      finally { if (body && typeof body === 'object') (body as Record<string, unknown>).clientSecret = ''; }
    }
    const selectedMail = path.match(/^\/api\/connectors\/ews\/([^/]+)\/(message-context|attachments|mail-uploads\/from-message)$/);
    if (selectedMail && method === 'POST') {
      const connectionId = id.parse(selectedMail[1]);
      if (selectedMail[2] === 'message-context') return { status: 200, body: await settings.getEwsMessageContext(connectionId, ewsSelectionInput.parse(body)) };
      if (selectedMail[2] === 'attachments') return { status: 200, body: await settings.listEwsMessageAttachments(connectionId, ewsSelectionInput.parse(body)) };
      return { status: 201, body: await settings.copyEwsMailAttachment(connectionId,
        ewsAttachmentInput.extend({ allowProtectedSourcePlaintext: z.literal(true).optional() }).strict().parse(body)) };
    }
    const mailUpload = path.match(/^\/api\/connectors\/ews\/([^/]+)\/mail-uploads\/([^/]+)$/);
    if (mailUpload && method === 'DELETE') {
      await settings.removeEwsMailAttachment(id.parse(mailUpload[1]), z.uuid().parse(mailUpload[2])); return { status: 200, body: { removed: true } };
    }
    const ewsMail = path.match(/^\/api\/connectors\/ews\/([^/]+)\/(messages|message)$/);
    if (ewsMail && method === 'POST') {
      const connectionId = id.parse(ewsMail[1]);
      return { status: 200, body: ewsMail[2] === 'messages'
        ? await settings.queryEwsMessages(connectionId, ewsQueryInput.parse(body))
        : await settings.readEwsMessage(connectionId, ewsReadInput.parse(body)) };
    }
    const ewsUpdate = path.match(/^\/api\/connectors\/ews\/([^/]+)\/credentials$/);
    if ((path === '/api/connectors/ews' && method === 'POST') || (ewsUpdate && method === 'PATCH')) {
      try {
        if (ewsUpdate) return { status: 200, body: await settings.updateEws(id.parse(ewsUpdate[1]), ewsUpdateInput.parse(body)) };
        return { status: 201, body: await settings.connectEws(ewsConnectInput.parse(body)) };
      }
      finally {
        if (body && typeof body === 'object') {
          const submitted = body as Record<string, unknown>;
          submitted.password = ''; submitted.username = ''; submitted.certificate = undefined;
        }
      }
    }
    if (path === '/api/connectors/tencent-docs/credentials' && method === 'POST') {
      const { token } = z.object({ token: connectorToken }).strict().parse(body);
      return { status: 201, body: await settings.saveTencentDocsCredential(token) };
    }
    const tencentCredential = path.match(/^\/api\/connectors\/tencent-docs\/credentials\/([^/]+)$/);
    if (tencentCredential && method === 'DELETE') {
      return { status: 200, body: await settings.removeTencentDocsCredential(z.uuid().parse(tencentCredential[1])) };
    }
    if ((path === '/api/connectors/tencent-docs/preview' || path === '/api/connectors/tencent-docs/documents') && method === 'POST') {
      const input = connectorSelection.extend({ credentialId: z.uuid() }).parse(body);
      if (path.endsWith('/preview')) return { status: 200, body: await settings.previewTencentDocument(input) };
      return { status: 201, body: await settings.connectTencentDocument(input) };
    }
    const action = path.match(/^\/api\/connectors\/([^/]+)\/(start|complete|sync)$/);
    if (action && method === 'POST') {
      const [, name, command] = action;
      if (command === 'sync') {
        z.object({}).strict().parse(body);
        return { status: 200, body: await settings.sync(id.parse(name)) };
      }
      const kind = connectorKind.parse(name);
      if (!origin) throw new HttpError(400, '缺少连接器授权入口。');
      if (command === 'start') return { status: 200, body: await settings.start(kind, connectorSelection.extend({ connectionId: id.optional() }).parse(body), origin) };
      const input = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: short(8192) }).strict().parse(body);
      return { status: 201, body: await settings.complete(kind, input.state, input.code, origin) };
    }
    const connection = path.match(/^\/api\/connectors\/([^/]+)$/);
    if (connection && method === 'DELETE') return { status: 200, body: await settings.disconnect(id.parse(connection[1])) };
    throw new HttpError(404, '连接器操作不存在。');
  }
  if (path === '/api/devices' && method === 'GET') {
    if (!api.listDevices) throw new HttpError(409, '当前运行时没有本地设备连接。');
    return { status: 200, body: await api.listDevices() };
  }
  if (path === '/api/device-operations' && method === 'GET') {
    if (!api.listDeviceOperations) throw new HttpError(409, '当前运行时没有本地设备连接。');
    return { status: 200, body: await api.listDeviceOperations() };
  }
  if (path === '/api/devices/pairings' && method === 'POST') {
    z.object({}).strict().parse(body);
    if (!api.createDevicePairing) throw new HttpError(409, '当前运行时没有本地设备连接。');
    return { status: 201, body: await api.createDevicePairing() };
  }
  const deviceRename = path.match(/^\/api\/devices\/([^/]+)\/rename$/);
  if (deviceRename && method === 'POST') {
    const input = deviceRenameSchema.parse(body);
    if (!api.renameDevice) throw new HttpError(409, '当前运行时没有本地设备连接。');
    return { status: 200, body: await api.renameDevice(id.parse(deviceRename[1]), input) };
  }
  const deviceRevoke = path.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (deviceRevoke && method === 'POST') {
    z.object({}).strict().parse(body);
    if (!api.revokeDevice) throw new HttpError(409, '当前运行时没有本地设备连接。');
    return { status: 200, body: await api.revokeDevice(id.parse(deviceRevoke[1])) };
  }
  if (path === '/api/media/models' && method === 'GET') return { status: 200, body: await api.listMediaModels() };
  const mediaCancel = path.match(/^\/api\/media\/([^/]+)\/cancel$/);
  if (mediaCancel && method === 'POST') {
    z.object({}).strict().parse(body); return { status: 200, body: await api.cancelMediaJob(id.parse(mediaCancel[1])) };
  }
  const eventRetry = path.match(/^\/api\/events\/([^/]+)\/retry$/);
  if (eventRetry && method === 'POST') {
    z.object({}).strict().parse(body);
    return { status: 202, body: await api.retryEvent(id.parse(eventRetry[1])) };
  }
  if (path === '/api/tasks' && method === 'GET') return { status: 200, body: await api.listTasks() };
  const taskInput = path.match(/^\/api\/tasks\/([^/]+)\/inputs\/([^/]+)$/);
  if (taskInput && method === 'POST') {
    if (!api.answerTaskInput) throw new HttpError(409, '当前运行时尚未接入持久任务输入。');
    const input = z.object({ revision: z.number().int().positive(), answers: z.record(id, short(20000)) }).strict().parse(body);
    return { status: 200, body: await api.answerTaskInput(id.parse(taskInput[1]), id.parse(taskInput[2]), input.revision, input.answers) };
  }
  const acceptDelivery = path.match(/^\/api\/tasks\/([^/]+)\/accept$/);
  if (acceptDelivery && method === 'POST') {
    if (!api.acceptTaskDelivery) throw new HttpError(409, '当前运行时尚未接入任务验收。');
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(body);
    return { status: 200, body: await api.acceptTaskDelivery(id.parse(acceptDelivery[1]), revision) };
  }
  const projectTask = path.match(/^\/api\/tasks\/([^/]+)\/project$/);
  const projectFiles = path.match(/^\/api\/tasks\/([^/]+)\/files$/);
  if (projectFiles && method === 'POST') {
    if (!api.prepareProjectFiles) throw new HttpError(409, '当前运行时尚未接入文件领取。');
    const input = z.union([z.object({}).strict(), z.object({ dependencyId: id, revision: z.number().int().positive() }).strict()]).parse(body);
    const stage = typeof input.dependencyId === 'string' ? { dependencyId: input.dependencyId, revision: input.revision } : undefined;
    return { status: 200, body: { delivery: await api.prepareProjectFiles(id.parse(projectFiles[1]), stage) } };
  }
  if (projectTask && method === 'GET') {
    if (!api.projectTask) throw new HttpError(409, '当前运行时尚未接入项目执行。');
    return { status: 200, body: { operation: await api.projectTask(id.parse(projectTask[1])) } };
  }
  const projectStop = path.match(/^\/api\/tasks\/([^/]+)\/project-stop$/);
  if (projectStop && method === 'POST') {
    if (!api.stopProjectEnvironment) throw new HttpError(409, '当前运行时尚未接入项目执行。');
    return { status: 200, body: await api.stopProjectEnvironment(id.parse(projectStop[1])) };
  }
  const mailOperation = path.match(/^\/api\/tasks\/([^/]+)\/mail-operation$/);
  if (mailOperation && method === 'GET') return { status: 200, body: { operation: await api.getMailOperation(id.parse(mailOperation[1])) } };
  if (path === '/api/tasks' && method === 'POST') {
    const input = z.object({ requestId: id, spec: taskRequestSpecSchema }).strict().parse(body);
    if (input.spec.caseId !== 'personal-growth' && !await api.getCase(input.spec.caseId)) throw new HttpError(404, '场景不存在。');
    return { status: 201, body: await api.requestTask(input) };
  }
  const taskAction = path.match(/^\/api\/tasks\/([^/]+)\/(approve|reject|revoke)$/);
  if (taskAction && method === 'POST') {
    const taskId = id.parse(taskAction[1]);
    const revisionInput = z.object({ revision: z.number().int().positive() }).strict();
    if (taskAction[2] === 'approve') {
      const { revision, serverResources, project } = revisionInput.extend({ serverResources: serverProjectResourceSchema.optional(), project: projectRequestSchema.optional() }).parse(body);
      return { status: 200, body: await api.approveTask(taskId, revision, undefined, serverResources, project) };
    }
    const { revision } = revisionInput.parse(body);
    const result = taskAction[2] === 'reject' ? await api.rejectTask(taskId, revision) : await api.revokeTask(taskId, revision);
    return { status: 200, body: result };
  }
  if (/^\/api\/(memories|initiatives)(\/|$)/.test(path)) throw new HttpError(410, '旧版记忆和议程已退役为只读归档，请使用个人理解与事项操作；历史数据仍保留在导出中。');
  if (path === '/api/cases' && method === 'GET') return { status: 200, body: await api.listCases() };
  const caseImages = path.match(/^\/api\/cases\/([^/]+)\/images$/);
  if (caseImages && method === 'GET') {
    return { status: 200, body: await api.listCaseImages(id.parse(caseImages[1])) };
  }
  if (path === '/api/cases' && method === 'POST') {
    const input = z.object({ title: short(200), objective: z.string().trim().max(8000), domain: short(100), requestId: z.string().uuid().optional() }).strict().parse(body);
    return { status: 201, body: await api.createCase(input) };
  }
  const casePath = path.match(/^\/api\/cases\/([^/]+)$/);
  if (casePath && (method === 'GET' || method === 'PATCH')) {
    const caseId = id.parse(casePath[1]); if (!await api.getCase(caseId)) throw new HttpError(404, '事项不存在。');
    if (method === 'GET') { const details = await api.getCaseDetails(caseId); return { status: 200, body: { ...details, history: publicCaseHistory(details.history) } }; }
    const input = z.object({ title: short(200).optional(), objective: z.string().trim().max(8000).optional(), status: z.enum(['active', 'waiting', 'cancelled']).optional() }).strict()
      .refine(value => Object.keys(value).length > 0).parse(body);
    return { status: 200, body: await api.updateCase(caseId, input) };
  }
  if (path === '/api/personal-memory' && method === 'GET') {
    if (query.size) {
      const input = z.object({ offset: z.coerce.number().int().min(0).max(10000000).default(0),
        limit: z.coerce.number().int().min(1).max(200).default(50), subject: z.enum(['owner', 'agent']).optional() }).strict().parse(Object.fromEntries(query));
      if (!api.pagePersonalMemory) throw new HttpError(503, '当前运行时未提供记忆分页。');
      return { status: 200, body: await api.pagePersonalMemory(input) };
    }
    return { status: 200, body: await api.listPersonalMemory() };
  }
  const restore = path.match(/^\/api\/personal-memory\/(.+)\/restore$/);
  if (restore && method === 'POST') {
    const input = z.object({ revision: z.number().int().min(1), expectedRevision: z.number().int().positive().optional() }).strict().parse(body);
    return { status: 200, body: await api.restorePersonalMemory(short(200).parse(restore[1]), input.revision,
      input.expectedRevision === undefined ? undefined : { source: { kind: 'legacy' }, expectedRevision: input.expectedRevision }) };
  }
  const fact = path.match(/^\/api\/personal-memory\/(.+)$/);
  if (fact && method === 'PATCH') return { status: 200, body: await api.correctPersonalMemory(short(200).parse(fact[1]), memoryCorrection.parse(body)) };
  if (fact && method === 'DELETE') {
    const input = z.object({ expectedRevision: z.number().int().positive().optional() }).strict().parse(body ?? {});
    return { status: 200, body: await api.retractPersonalMemory(short(200).parse(fact[1]),
      input.expectedRevision === undefined ? undefined : { source: { kind: 'legacy' }, expectedRevision: input.expectedRevision }) };
  }
  if (path === '/api/shared-facts' && method === 'POST') {
    const input = z.object({ key: short(200), value: short(2000), domains: z.array(short(100)).min(1).max(20), evidenceIds: z.array(short(200)).min(1).max(30) }).strict().parse(body);
    // Compatibility owner input enters personal memory, never another shared store.
    const global = input.domains.includes('*');
    const entry = await api.correctPersonalMemory(input.key, { value: input.value, scope: global ? 'global' : 'domain', ...(global ? {} : { domains: input.domains }) });
    return { status: 200, body: { saved: true, entry } };
  }
  if (path === '/api/sources/workspace' && method === 'POST') {
    const input = z.object({ sourceId: id, root: short(4000), caseId: id, include: z.array(short(500)).min(1).max(40).optional() }).strict().parse(body);
    if (!await api.getCase(input.caseId)) throw new HttpError(404, '事项不存在。');
    return { status: 201, body: await api.registerWorkspaceSource(input) };
  }
  const sourcePath = path.match(/^\/api\/sources\/workspace\/([^/]+)$/);
  if (sourcePath && method === 'DELETE') { await api.removeWorkspaceSource(id.parse(sourcePath[1])); return { status: 200, body: { removed: true, historyRetained: true } }; }
  if (path === '/api/workspaces' && method === 'POST') {
    const input = z.object({ caseId: id, repoRoot: short(4000), allowedFiles: z.array(short(500)).min(1).max(30),
      jsonRules: z.array(z.object({ file: short(500), path: z.array(short(200)).max(30), equals: z.json() }).strict()).max(50).optional() }).strict().parse(body);
    if (!await api.getCase(input.caseId)) throw new HttpError(404, '事项不存在。');
    return { status: 201, body: await api.prepareWorkspace(input) };
  }
  const handoff = path.match(/^\/api\/workspaces\/([^/]+)\/handoff$/);
  if (handoff && method === 'GET') return { status: 200, body: await api.getWorkspaceHandoff(id.parse(handoff[1])) };
  const grant = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (grant && method === 'DELETE') return { status: 200, body: await api.revokeWorkspace(id.parse(grant[1])) };
  throw new HttpError(404, '接口不存在。');
}
