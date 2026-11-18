import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import PQueue from 'p-queue';
import { ewsCredentials, ewsStoredCredentials, EWS_MAX_BODY_CHARS, type EwsCredentials, type EwsQueryInput } from '../../shared/ews.js';
import { ConnectorProviderError, type ConnectorProvider, type ConnectorToken } from './types.js';

const nativeId = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const ewsCursor = z.object({ version: z.literal(1), folderId: nativeId, since: z.iso.datetime({ offset: true }),
  syncState: z.string().min(1).max(262144).nullable(), catchup: z.boolean(),
  pending: z.array(z.object({ id: nativeId, revision: nativeId }).strict()).max(512),
}).strict();
const folder = z.object({ id: nativeId, displayName: z.string().min(1).max(300),
  totalCount: z.number().int().nonnegative(), unreadCount: z.number().int().nonnegative() }).strict();
const change = z.object({ id: nativeId, revision: nativeId, subject: z.string().max(240), receivedAt: z.iso.datetime({ offset: true }),
  sender: z.string().max(400), body: z.string().max(EWS_MAX_BODY_CHARS),
  encryption: z.enum(['none', 'smime', 'smime-signed-unverified', 'smime-decrypted']),
  bodyStatus: z.enum(['read', 'empty', 'certificate_missing', 'decrypt', 'mime', 'smime_container', 'response_limit']),
  truncated: z.boolean(), totalCharacters: z.number().int().nonnegative(),
  internetMessageId: z.string().max(4096).nullish().catch(undefined), inReplyTo: z.string().max(4096).nullish().catch(undefined),
  references: z.string().max(16000).nullish().catch(undefined), senderAddress: z.string().max(400).nullish().catch(undefined),
}).strict();
const scanned = z.object({ cursor: ewsCursor, changes: z.array(change).max(6), more: z.boolean() }).strict();
export interface EwsNativeRequest {
  operation: 'baseline' | 'scan' | 'query' | 'read' | 'message-info' | 'list-attachments' | 'read-attachment'
    | 'prepare-message' | 'attach-file' | 'inspect-draft' | 'submit-draft' | 'submission-receipt'; credentials: EwsCredentials; cursor?: z.infer<typeof ewsCursor>;
  query?: { folderId: string; subject?: string; offset: number; limit: number };
  read?: { folderId: string; messageId: string };
  info?: { folderId: string; messageId: string };
  attachments?: { folderId: string; messageId: string };
  attachment?: { folderId: string; messageId: string; revision: string; reference: string };
  prepare?: EwsPrepareMessage;
  attach?: EwsAttachFile;
  inspect?: EwsInspectDraft;
  submit?: EwsSubmitDraft;
  submission?: { operationId: string };
}
export type EwsTransport = (request: EwsNativeRequest, signal: AbortSignal) => Promise<unknown>;
const nativeQueue = new PQueue({ concurrency: 2 });
const nativeFile = () => resolve(process.env.RAE_EWS_WORKER_PATH?.trim() || resolve('.local', 'ews-runtime',
  `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`, process.platform === 'win32' ? 'AnotherRae.Ews.exe' : 'AnotherRae.Ews'));
export function ewsAvailable(): boolean { return ['win32', 'linux'].includes(process.platform) && existsSync(nativeFile()); }

export class EwsNativeOperationError extends ConnectorProviderError {
  constructor(message: string, status = 502, public readonly dispatched = false,
    public readonly outcomeUnknown = false, public readonly draftId?: string) { super(message, status); }
}
function nativeError(value: unknown): ConnectorProviderError {
  const parsed = z.object({ error: z.string(), ewsCode: z.string().regex(/^Error[A-Za-z]{1,80}$/).nullish(),
    dispatched: z.boolean().optional(), outcomeUnknown: z.boolean().optional(), draftId: nativeId.nullish() }).safeParse(value);
  const code = parsed.success ? parsed.data.error : '';
  const ewsCode = parsed.success ? parsed.data.ewsCode : undefined;
  if (parsed.success && (parsed.data.dispatched || parsed.data.outcomeUnknown)) return new EwsNativeOperationError(
    parsed.data.outcomeUnknown ? '邮件操作未收到确定回执，已停止；请核对草稿或已发送邮件，不会自动重试。' : 'Exchange 未接受本次邮件操作，已停止。',
    409, parsed.data.dispatched, parsed.data.outcomeUnknown, parsed.data.draftId ?? undefined);
  if (code === 'authentication') return new ConnectorProviderError('EWS 登录未通过，请更新邮箱密码或核对账号策略。', 401);
  if (code === 'certificate') return new ConnectorProviderError('无法打开 PFX/P12 或未找到私钥，请核对证书文件和密码。', 400);
  if (code === 'forbidden' || ewsCode === 'ErrorAccessDenied') return new ConnectorProviderError('EWS 拒绝访问已授权收件箱。', 403);
  if (code === 'throttled') return new ConnectorProviderError('EWS 正在限制请求频率，请稍后同步。', 429);
  if (code === 'scope') return new ConnectorProviderError('收件箱身份已变化，请刷新连接后重新查询。', 409);
  if (['revision', 'draft_scope', 'snapshot', 'protected_source'].includes(code)) return new ConnectorProviderError('邮件或草稿已变化，或缺少受保护内容的明文发送许可；请重新选择并确认。', 409);
  if (['unsupported_attachment', 'attachment_not_found', 'invalid_attachment', 'invalid_file', 'file_limit'].includes(code)) return new ConnectorProviderError('附件不在本次可用范围内，或文件校验未通过。', 409);
  if (ewsCode === 'ErrorInvalidSyncStateData') return new ConnectorProviderError('EWS 同步游标已失效，请重新连接；不会自动扩大历史读取范围。', 409);
  if (code === 'timeout') return new ConnectorProviderError('EWS 请求超时，已保留同步位置。');
  return new ConnectorProviderError('EWS 读取未完成，请检查网络、证书及服务配置；未跟随跳转或降级认证。');
}

export function exchangeWithEwsWorker(request: EwsNativeRequest, signal: AbortSignal,
  launch: () => ChildProcessWithoutNullStreams): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    const write = ['prepare-message', 'attach-file', 'submit-draft'].includes(request.operation);
    const interrupted = () => write ? new EwsNativeOperationError('邮件操作未收到确定回执，已停止且不会自动重试。', 409, true, true)
      : new ConnectorProviderError('EWS 请求未完成，已保留同步位置。');
    let child: ChildProcessWithoutNullStreams;
    try { child = launch(); } catch { reject(new ConnectorProviderError('无法启动 EWS 适配器。')); return; }
    const decoder = new StringDecoder('utf8'); let output = ''; let bytes = 0; let failed = false;
    const stop = () => { failed = true; child.kill(); };
    const timer = setTimeout(stop, ['baseline', 'scan', 'query', 'read'].includes(request.operation) ? 20_000 : 60_000);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { stop(); return; }
      output += decoder.write(chunk);
    });
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', stop); child.on('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', stop);
      if (signal.aborted) { reject(write ? interrupted() : signal.reason ?? new ConnectorProviderError('EWS 请求已停止。', 409)); return; }
      if (failed || code !== 0) { reject(interrupted()); return; }
      try {
        const envelope = z.object({ ok: z.boolean(), result: z.unknown().optional() }).passthrough().parse(JSON.parse(output + decoder.end()));
        if (!envelope.ok) {
          const mapped = nativeError(envelope);
          const certainty = z.object({ dispatched: z.boolean(), outcomeUnknown: z.boolean(), draftId: nativeId.nullish() }).safeParse(envelope);
          reject(write && certainty.success && !(mapped instanceof EwsNativeOperationError) ? new EwsNativeOperationError(
            mapped.message, mapped.status, certainty.data.dispatched, certainty.data.outcomeUnknown, certainty.data.draftId ?? undefined) : mapped);
          return;
        }
        accept(envelope.result);
      } catch { reject(write ? interrupted() : new ConnectorProviderError('EWS 适配器未返回有效结果。')); }
    });
    if (signal.aborted) { stop(); child.stdin.end(); return; }
    child.stdin.end(JSON.stringify(request));
  });
}

export const runEwsNative: EwsTransport = async (request, signal) => {
  signal.throwIfAborted();
  if (process.env.RAE_OFFLINE_TESTS === '1') throw new ConnectorProviderError('离线测试禁止真实 EWS 网络请求。');
  if (!ewsAvailable()) throw new ConnectorProviderError('请先在服务端运行 npm run prepare:ews。', 409);
  if (nativeQueue.size + nativeQueue.pending >= 8) throw new ConnectorProviderError('邮件请求较多，请等待当前查询完成后再试。', 429);
  // Do not race a running worker against PQueue's abort rejection: cancellation
  // must settle only after its native process has actually closed.
  return nativeQueue.add(() => {
    signal.throwIfAborted();
    return exchangeWithEwsWorker(request, signal, () => spawn(nativeFile(), [], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, LANG: process.env.LANG ?? 'C.UTF-8', DOTNET_EnableDiagnostics: '0' },
    }));
  });
};

export async function checkEwsCredentials(token: ConnectorToken, signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const { revision: _revision, ...credentials } = ewsStoredCredentials.parse(token.ews);
  return folder.parse(await transport({ operation: 'baseline', credentials: ewsCredentials.parse(credentials) }, signal));
}
const queryPage = z.object({ messages: z.array(z.object({ id: nativeId, revision: nativeId,
  subject: z.string().max(240), receivedAt: z.iso.datetime({ offset: true }), sender: z.string().max(400),
  encryptionHint: z.string().max(100), isRead: z.boolean(),
}).strict()).max(25), nextOffset: z.number().int().min(1).max(10000).nullable(), totalItems: z.number().int().nonnegative(),
}).strict();
export async function queryEwsInbox(token: ConnectorToken, folderId: string, input: EwsQueryInput,
  signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const { revision: _revision, ...credentials } = ewsStoredCredentials.parse(token.ews);
  const result = queryPage.parse(await transport({ operation: 'query', credentials,
    query: { folderId, offset: input.offset, limit: input.limit, ...(input.subject ? { subject: input.subject } : {}) } }, signal));
  if (result.messages.length > input.limit || result.nextOffset !== null && result.nextOffset <= input.offset) {
    throw new ConnectorProviderError('EWS 列表返回了无效分页。');
  }
  return result;
}
export async function readEwsInboxMessage(token: ConnectorToken, folderId: string, messageId: string,
  signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const { revision: _revision, ...credentials } = ewsStoredCredentials.parse(token.ews);
  const raw = await transport({ operation: 'read', credentials, read: { folderId, messageId } }, signal);
  if (raw === null) throw new ConnectorProviderError('邮件不存在或已离开当前收件箱，请重新查询。', 404);
  const result = change.parse(raw);
  if (result.id !== messageId) throw new ConnectorProviderError('EWS 返回的邮件与所选邮件不符。');
  return result;
}
const recipient = z.object({ address: z.string().min(3).max(320), name: z.string().max(200).nullable().optional() }).strict();
const nativeSource = z.object({ folderId: nativeId, messageId: nativeId, revision: nativeId }).strict();
const prepareMessage = z.object({ operationId: nativeId, mode: z.enum(['send', 'reply', 'replyAll', 'forward']), source: nativeSource.optional(),
  to: z.array(recipient).max(50), cc: z.array(recipient).max(50), bcc: z.array(recipient).max(50),
  subject: z.string().max(998), body: z.string().max(200000), allowPlaintextProtectedSource: z.boolean(),
}).strict().refine(value => value.to.length + value.cc.length + value.bcc.length > 0 && value.to.length + value.cc.length + value.bcc.length <= 50);
const attachFile = z.object({ operationId: nativeId, draftId: nativeId, revision: nativeId, custodyRoot: z.string().min(1).max(4096),
  file: z.object({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(5 * 1024 * 1024),
    name: z.string().min(1).max(200), contentType: z.string().min(1).max(200) }).strict(),
}).strict();
const inspectDraft = z.object({ operationId: nativeId, draftId: nativeId }).strict();
const submitDraft = inspectDraft.extend({ revision: nativeId, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type EwsPrepareMessage = z.infer<typeof prepareMessage>;
export type EwsAttachFile = z.infer<typeof attachFile>;
export type EwsInspectDraft = z.infer<typeof inspectDraft>;
export type EwsSubmitDraft = z.infer<typeof submitDraft>;
const messageInfo = z.object({ messageId: nativeId, revision: nativeId, subject: z.string().max(998), from: z.string().max(400),
  to: z.array(z.string().max(400)).max(500), cc: z.array(z.string().max(400)).max(500), bcc: z.array(z.string().max(400)).max(500),
  replyTo: z.array(z.string().max(400)).max(500), selfAddress: z.string().max(320).nullish(), internetMessageId: z.string().max(4096),
  encryption: change.shape.encryption, bodyStatus: change.shape.bodyStatus, body: change.shape.body,
  totalCharacters: change.shape.totalCharacters, truncated: z.boolean(),
}).strict();
const attachmentPage = z.object({ messageId: nativeId, revision: nativeId, sourceProtected: z.boolean(), attachments: z.array(z.object({
  reference: z.string().min(1).max(16000), name: z.string().min(1).max(200), contentType: z.string().max(200), size: z.number().int().nonnegative(),
  isInline: z.boolean(), kind: z.enum(['file', 'item']), supported: z.boolean(), sourceProtected: z.boolean(), unsupportedReason: z.string().max(100).nullish(),
}).strict()).max(100) }).strict();
const attachmentBytes = z.object({ name: z.string().min(1).max(200), contentType: z.string().max(200), size: z.number().int().min(0).max(5 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), base64: z.string().max(6990520), isInline: z.boolean(), sourceProtected: z.boolean(),
}).strict();
const draftSnapshot = z.object({ operationId: nativeId, draftId: nativeId, revision: nativeId, to: z.array(recipient).max(50),
  cc: z.array(recipient).max(50), bcc: z.array(recipient).max(50), subject: z.string().max(998), body: z.string().max(200000),
  attachments: z.array(z.object({ id: nativeId, name: z.string().min(1).max(200), contentType: z.string().max(200),
    size: z.number().int().min(0).max(5 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(10),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type EwsDraftSnapshot = z.infer<typeof draftSnapshot>;
function nativeCredentials(token: ConnectorToken): EwsCredentials { const { revision: _revision, ...credentials } = ewsStoredCredentials.parse(token.ews); return credentials; }
export async function getEwsMessageInfo(token: ConnectorToken, folderId: string, messageId: string, signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const result = messageInfo.parse(await transport({ operation: 'message-info', credentials: nativeCredentials(token), info: { folderId, messageId } }, signal));
  if (result.messageId !== messageId) throw new ConnectorProviderError('EWS 返回的邮件与所选邮件不符。'); return result;
}
export async function listEwsAttachments(token: ConnectorToken, folderId: string, messageId: string, signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const result = attachmentPage.parse(await transport({ operation: 'list-attachments', credentials: nativeCredentials(token), attachments: { folderId, messageId } }, signal));
  if (result.messageId !== messageId) throw new ConnectorProviderError('EWS 返回的附件与所选邮件不符。'); return result;
}
export async function readEwsAttachment(token: ConnectorToken, folderId: string, messageId: string, revision: string, reference: unknown,
  signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  return attachmentBytes.parse(await transport({ operation: 'read-attachment', credentials: nativeCredentials(token),
    attachment: { folderId, messageId, revision, reference: z.string().min(1).max(16000).parse(reference) } }, signal));
}
export async function prepareEwsMessage(token: ConnectorToken, prepare: EwsPrepareMessage, signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const result = draftSnapshot.parse(await transport({ operation: 'prepare-message', credentials: nativeCredentials(token), prepare: prepareMessage.parse(prepare) }, signal));
  if (result.operationId !== prepare.operationId) throw new ConnectorProviderError('EWS 草稿身份校验未通过。'); return result;
}
export async function attachEwsFile(token: ConnectorToken, attach: EwsAttachFile, signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const result = draftSnapshot.parse(await transport({ operation: 'attach-file', credentials: nativeCredentials(token), attach: attachFile.parse(attach) }, signal));
  if (result.operationId !== attach.operationId || result.draftId !== attach.draftId) throw new ConnectorProviderError('EWS 草稿身份校验未通过。'); return result;
}
export async function inspectEwsDraft(token: ConnectorToken, inspect: EwsInspectDraft, signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const result = draftSnapshot.parse(await transport({ operation: 'inspect-draft', credentials: nativeCredentials(token), inspect: inspectDraft.parse(inspect) }, signal));
  if (result.operationId !== inspect.operationId || result.draftId !== inspect.draftId) throw new ConnectorProviderError('EWS 草稿身份校验未通过。'); return result;
}
export async function submitEwsDraft(token: ConnectorToken, submit: EwsSubmitDraft, signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const result = z.object({ state: z.literal('submitted'), operationId: nativeId, draftId: nativeId, revision: nativeId,
    internetMessageId: z.string().max(4096).nullish(), sentMessageId: nativeId.nullish() }).strict().parse(
    await transport({ operation: 'submit-draft', credentials: nativeCredentials(token), submit: submitDraft.parse(submit) }, signal));
  if (result.operationId !== submit.operationId || result.draftId !== submit.draftId || result.revision !== submit.revision) throw new ConnectorProviderError('EWS 发送回执身份校验未通过。'); return result;
}
export async function readEwsSubmissionReceipt(token: ConnectorToken, operationId: string, signal: AbortSignal, transport: EwsTransport = runEwsNative) {
  const result = z.object({ state: z.enum(['found', 'pending', 'ambiguous']), operationId: nativeId,
    internetMessageId: nativeId.nullish(), sentMessageId: nativeId.nullish() }).strict().refine(value =>
    value.state === 'found' ? Boolean(value.internetMessageId && value.sentMessageId) : !value.internetMessageId && !value.sentMessageId).parse(
    await transport({ operation: 'submission-receipt', credentials: nativeCredentials(token), submission: { operationId: nativeId.parse(operationId) } }, signal));
  if (result.operationId !== operationId) throw new ConnectorProviderError('EWS 已发送邮件回执身份校验未通过。');
  return result;
}
const statusText = {
  read: '正文已读取', empty: '正文为空', certificate_missing: 'S/MIME 正文尚未读取：未配置解密证书',
  decrypt: 'S/MIME 正文尚未读取：现有证书未能解密', mime: '正文尚未读取：邮件格式无法解析',
  smime_container: '正文尚未读取：S/MIME 容器不明确', response_limit: '正文尚未读取：超过本次读取上限',
};
export function createEwsProvider(transport: EwsTransport = runEwsNative): ConnectorProvider {
  const unsupported = () => { throw new ConnectorProviderError('请在连接器中填写 EWS 登录信息和解密证书。', 409); };
  return {
    validateScope(scope) {
      if (scope !== 'inbox') throw new ConnectorProviderError('EWS 第一版仅支持收件箱新邮件。', 400);
      return scope;
    },
    authorize: unsupported, exchange: async () => unsupported(), refresh: async () => unsupported(),
    async scan(input) {
      if (input.scope !== 'inbox') throw new ConnectorProviderError('EWS 读取范围无效。', 400);
      const { revision: _revision, ...credentials } = ewsStoredCredentials.parse(input.token.ews);
      if (input.cursor === undefined) {
        const since = new Date().toISOString();
        const baseline = await checkEwsCredentials(input.token, input.signal, transport);
        return { cursor: JSON.stringify({ version: 1, folderId: baseline.id, since, syncState: null, catchup: true, pending: [] }), changes: [], more: true };
      }
      const previous = ewsCursor.parse(JSON.parse(input.cursor));
      const result = scanned.parse(await transport({ operation: 'scan', credentials, cursor: previous }, input.signal));
      if (result.cursor.folderId !== previous.folderId || result.cursor.since !== previous.since
        || result.more !== (result.cursor.catchup || result.cursor.pending.length > 0)
        || result.changes.some(mail => Date.parse(mail.receivedAt) < Date.parse(previous.since))) {
        throw new ConnectorProviderError('EWS 返回的范围与原授权不符。');
      }
      const changes = result.changes.map(mail => ({ id: mail.id, revision: mail.revision, title: mail.subject || '（无主题）', content: [
        `EWS 收件箱邮件：${mail.subject || '（无主题）'}`, `发件人：${mail.sender}`, `收到时间：${mail.receivedAt}`,
        `正文状态：${statusText[mail.bodyStatus]}${mail.encryption === 'smime-decrypted' ? '（S/MIME 已解密；未验证邮件数字签名）' : ''}`,
        ...(mail.truncated ? [`正文共 ${mail.totalCharacters} 个字符，本次保留前 ${mail.body.length} 个字符。`] : []), mail.body,
      ].filter(Boolean).join('\n'), mailThread: { messageId: mail.id, sender: mail.senderAddress ?? mail.sender,
        ...(mail.internetMessageId ? { internetMessageId: mail.internetMessageId } : {}),
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
        ...(mail.references ? { references: mail.references.match(/<[^<>\s]+>/g)?.slice(-100) ?? [] } : {}) } }));
      return { cursor: JSON.stringify(result.cursor), changes, more: result.more,
        notice: result.changes.some(mail => !['read', 'empty'].includes(mail.bodyStatus)) ? '部分新邮件的正文未能读取，已保留主题和具体原因。' : undefined };
    },
  };
}
