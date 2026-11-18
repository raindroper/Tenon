import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TaskRecord } from '../../shared/task-consent.js';
import { EWS_MAIL_OPERATION_PREFIX, mailBodySchema, mailTaskSpecSchema, type EwsMailOperation, type MailTaskSpec } from '../../shared/mail.js';
import { EWS_MAX_ATTACHMENT_BYTES, EWS_MAX_OUTGOING_ATTACHMENT_BYTES, EWS_MAX_OUTGOING_ATTACHMENTS,
  type EwsAttachmentPage, type EwsMailUpload, type EwsMessageContext, type EwsSelectionInput } from '../../shared/ews.js';
import type { Store } from '../store.js';
import type { EventInbox } from '../v2/events.js';
import { RuntimeInputError } from '../runtime.js';
import { ConnectorProviderError, type ConnectorToken } from './types.js';
import { getEwsMessageInfo, listEwsAttachments, readEwsAttachment, prepareEwsMessage, attachEwsFile,
  inspectEwsDraft, submitEwsDraft, readEwsSubmissionReceipt, EwsNativeOperationError, type EwsTransport } from './ews.js';
import { MailAttachments } from './mail-attachments.js';
import { matchesMailTask } from '../v2/mail-results.js';

export interface MailConnection {
  id: string; caseId: string; folderId: string; revision: number; token: ConnectorToken;
}
interface OwnerSelection { caseId: string; ownerEventId: string; signal: AbortSignal }
interface MailOptions {
  store: Store; inbox: EventInbox; directory: string; transport: EwsTransport;
  select(id: string, caseId?: string): MailConnection;
  assertSelection(id: string, input: EwsSelectionInput, owner?: OwnerSelection): void;
  assertOwner(caseId: string, eventId: string): void;
  allowedEvidence(eventId: string): boolean;
  run<T>(selection: MailConnection, work: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
  changed(): void;
  tasks(): readonly TaskRecord[];
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const contextKey = (id: string) => 'connectors.ews.mail-context.' + z.uuid().parse(id);
interface ContextRecord {
  id: string; caseId: string; connectionId: string; folderId: string; credentialRevision: number;
  createdAt: string; value: EwsMessageContext;
  ownerEventId?: string;
  attachments?: Array<{ id: string; reference: unknown; name: string; contentType: string; size: number;
    isInline: boolean; sourceProtected: boolean; supported: boolean }>;
}
const protectedSource = (value: string) => value === 'smime' || value === 'smime-decrypted';
const addressesEqual = (left: readonly { address: string }[] | readonly string[], right: readonly string[]) =>
  JSON.stringify(left.map(item => (typeof item === 'string' ? item : item.address).toLowerCase()).sort()) === JSON.stringify(right.map(item => item.toLowerCase()).sort());

/** Mail writes exist only here behind the existing approved task executor. */
export class EwsMail {
  private readonly files: MailAttachments;
  private readonly active = new Map<string, Promise<EwsMailOperation>>();
  private readonly readingContexts = new Map<string, Promise<EwsMessageContext>>();
  constructor(private readonly options: MailOptions) { this.files = new MailAttachments(options.store, options.directory, options.tasks); }
  private current(original: MailConnection): MailConnection {
    const current = this.options.select(original.id, original.caseId);
    if (current.folderId !== original.folderId || current.revision !== original.revision) throw new RuntimeInputError(409, '邮箱授权已更新，请重新选择邮件和附件。');
    return current;
  }
  context(id: string, input: EwsSelectionInput, owner?: OwnerSelection): Promise<EwsMessageContext> {
    this.options.assertSelection(id, input, owner);
    const selection = this.options.select(id, owner?.caseId);
    const key = JSON.stringify([id, selection.revision, input.queryId, input.messageId, owner?.ownerEventId]);
    const existing = this.readingContexts.get(key); if (existing) return existing;
    const reading = this.contextInternal(id, input, owner).finally(() => this.readingContexts.delete(key));
    this.readingContexts.set(key, reading); return reading;
  }
  private contextInternal(id: string, input: EwsSelectionInput, owner?: OwnerSelection): Promise<EwsMessageContext> {
    this.options.assertSelection(id, input, owner);
    const selection = this.options.select(id, owner?.caseId);
    return this.options.run(selection, async operationSignal => {
      const signal = owner ? AbortSignal.any([operationSignal, owner.signal]) : operationSignal;
      signal.throwIfAborted(); if (owner) this.options.assertOwner(owner.caseId, owner.ownerEventId);
      const info = await getEwsMessageInfo(selection.token, selection.folderId, input.messageId, signal, this.options.transport);
      signal.throwIfAborted(); this.current(selection); if (owner) this.options.assertOwner(owner.caseId, owner.ownerEventId);
      const contextId = randomUUID();
      const value: EwsMessageContext = { source: { contextId, messageId: input.messageId, revision: info.revision },
        credentialRevision: selection.revision, subject: info.subject, from: info.from, to: info.to, cc: info.cc,
        ...(info.replyTo ? { replyTo: info.replyTo } : {}), ...(info.selfAddress ? { selfAddress: info.selfAddress } : {}),
        encryption: info.encryption, bodyStatus: info.bodyStatus, body: info.body, totalCharacters: info.totalCharacters, truncated: info.truncated };
      const access = this.options.inbox.ingestProcessed({ sourceId: owner ? 'owner-chat' : 'owner-ui', externalId: contextId,
        kind: 'owner.mail_access', actor: 'owner', operation: 'create', caseId: selection.caseId, occurredAt: now(),
        ...(owner ? { causationId: owner.ownerEventId } : {}), payload: { operation: 'message-context', connectionId: id,
          messageId: input.messageId, queryId: input.queryId, credentialRevision: selection.revision, contextId } });
      const receipt = this.options.inbox.ingestProcessed({ sourceId: 'connector:' + id, sourceGeneration: id,
        externalId: contextId, kind: 'connector.mail_context', actor: 'external', operation: 'create', caseId: selection.caseId,
        occurredAt: now(), causationId: access.id, payload: { provider: 'ews', connectionId: id, folderId: selection.folderId,
          queryId: input.queryId, messageId: input.messageId, ...value } });
      value.evidenceId = receipt.id;
      this.options.store.setMeta(contextKey(contextId), { id: contextId, caseId: selection.caseId, connectionId: id,
        folderId: selection.folderId, credentialRevision: selection.revision, createdAt: now(), value,
        ...(owner ? { ownerEventId: owner.ownerEventId } : {}) } satisfies ContextRecord);
      return value;
    }, 60_000);
  }
  private getContext(id: string, selection: MailConnection): ContextRecord {
    const saved = this.options.store.getMeta<ContextRecord | undefined>(contextKey(id), undefined);
    if (!saved || saved.connectionId !== selection.id || saved.caseId !== selection.caseId || saved.folderId !== selection.folderId
      || saved.credentialRevision !== selection.revision || !saved.value.evidenceId || !this.options.allowedEvidence(saved.value.evidenceId)) throw new RuntimeInputError(409, '原邮件身份不属于当前邮箱授权，请重新选择。');
    return saved;
  }
  async attachments(id: string, input: EwsSelectionInput): Promise<EwsAttachmentPage> {
    const info = await this.context(id, input); const selection = this.options.select(id);
    return this.options.run(selection, async signal => {
      this.options.assertSelection(id, input); this.current(selection);
      const result = await listEwsAttachments(selection.token, selection.folderId, input.messageId, signal, this.options.transport);
      signal.throwIfAborted(); this.current(selection);
      if (result.revision !== info.source.revision) throw new RuntimeInputError(409, '邮件已更新，请重新读取附件列表。');
      const attachments = result.attachments.map(item => ({ ...item, id: randomUUID() }));
      const saved = this.getContext(info.source.contextId, selection);
      this.options.store.setMeta(contextKey(saved.id), { ...saved, attachments });
      const contexts = this.options.store.getMeta<string[]>('connectors.ews.attachment-contexts', []);
      this.options.store.setMeta('connectors.ews.attachment-contexts', [...contexts.slice(-127), saved.id]);
      return { sourceRef: info.source, attachments: attachments.map(({ reference: _reference, ...item }) => item) };
    }, 60_000);
  }
  async download(id: string, input: EwsSelectionInput & { attachmentId: string }): Promise<{ name: string; contentType: string; bytes: Buffer }> {
    this.options.assertSelection(id, input); const selection = this.options.select(id);
    // Attachment IDs are random handles bound to a previously queried message, never EWS IDs or paths.
    const contexts = this.options.store.getMeta<string[]>('connectors.ews.attachment-contexts', []);
    let context: ContextRecord | undefined;
    for (const contextId of contexts) {
      const candidate = this.options.store.getMeta<ContextRecord | undefined>(contextKey(contextId), undefined);
      if (candidate?.attachments?.some(item => item.id === input.attachmentId)) { context = candidate; break; }
    }
    if (!context || context.connectionId !== id || context.value.source.messageId !== input.messageId
      || Date.now() - Date.parse(context.createdAt) > 15 * 60_000) throw new RuntimeInputError(409, '请刷新所选邮件的附件列表。');
    const saved = this.getContext(context.id, selection); const item = saved.attachments!.find(item => item.id === input.attachmentId)!;
    if (!item.supported || item.size > EWS_MAX_ATTACHMENT_BYTES) throw new RuntimeInputError(409, '此附件类型或大小暂不支持下载。');
    return this.options.run(selection, async signal => {
      const result = await readEwsAttachment(selection.token, selection.folderId, input.messageId, saved.value.source.revision, item.reference, signal, this.options.transport);
      signal.throwIfAborted(); this.current(selection); this.options.assertSelection(id, input);
      const bytes = Buffer.from(result.base64, 'base64');
      if (bytes.length > EWS_MAX_ATTACHMENT_BYTES || bytes.length !== result.size || hash(bytes) !== result.sha256) throw new RuntimeInputError(409, '附件内容校验未通过。');
      return { name: item.name, contentType: item.contentType, bytes };
    }, 60_000);
  }
  upload(id: string, file: { name: string; contentType: string; bytes: Buffer }): EwsMailUpload {
    const selection = this.options.select(id);
    return this.files.save({ ...file, caseId: selection.caseId, connectionId: id, credentialRevision: selection.revision });
  }
  async uploadFromMessage(id: string, input: EwsSelectionInput & { attachmentId: string; allowProtectedSourcePlaintext?: true }): Promise<EwsMailUpload> {
    const contexts = this.options.store.getMeta<string[]>('connectors.ews.attachment-contexts', []);
    const item = contexts.flatMap(contextId => this.options.store.getMeta<ContextRecord | undefined>(contextKey(contextId), undefined)?.attachments ?? [])
      .find(item => item.id === input.attachmentId);
    if (item?.sourceProtected && !input.allowProtectedSourcePlaintext) throw new RuntimeInputError(409, '需要明确选择将受保护的原附件作为明文发送。');
    const file = await this.download(id, input); const selection = this.options.select(id);
    return this.files.save({ ...file, caseId: selection.caseId, connectionId: id, credentialRevision: selection.revision, sourceProtected: item?.sourceProtected });
  }
  removeUpload(id: string, uploadId: string): void {
    const selection = this.options.select(id);
    this.files.remove(uploadId, { caseId: selection.caseId, connectionId: id, credentialRevision: selection.revision });
  }
  operationForTask(taskId: string): EwsMailOperation | undefined {
    return this.options.store.getMeta<EwsMailOperation | undefined>(EWS_MAIL_OPERATION_PREFIX + taskId, undefined);
  }
  prepareScope(caseId: string, input: MailTaskSpec, ownerEventId?: string): MailTaskSpec {
    const spec = mailTaskSpecSchema.parse(input); const selection = this.options.select(spec.connectionId, caseId);
    if (ownerEventId) this.options.assertOwner(caseId, ownerEventId);
    if (selection.revision !== spec.credentialRevision) throw new RuntimeInputError(409, '邮箱凭据已更新，请重新确认发送范围。');
    if (spec.source) {
      const context = this.getContext(spec.source.contextId, selection);
      if (context.value.source.messageId !== spec.source.messageId || context.value.source.revision !== spec.source.revision
        || Date.now() - Date.parse(context.createdAt) > 15 * 60_000 || context.ownerEventId !== ownerEventId) throw new RuntimeInputError(409, '请重新选择当前邮件，再确认回复或转发。');
      if (protectedSource(context.value.encryption) && !spec.allowProtectedSourcePlaintext) throw new RuntimeInputError(409, '原邮件受保护；当前发信为明文，需要本人明确选择。');
    }
    const files = spec.attachments.map(file => this.files.select(file.id, { caseId, connectionId: selection.id, credentialRevision: selection.revision }, file.sha256));
    if (files.reduce((sum, file) => sum + file.size, 0) > EWS_MAX_OUTGOING_ATTACHMENT_BYTES) throw new RuntimeInputError(400, '每封邮件的附件总计不超过 10 MiB。');
    if (files.some(file => file.sourceProtected) && !spec.allowProtectedSourcePlaintext) throw new RuntimeInputError(409, '选中的附件来自受保护邮件，需要本人明确选择以明文发送。');
    return spec;
  }
  validateTask(task: TaskRecord): void {
    const spec = mailTaskSpecSchema.parse(task.spec.mail); const selection = this.options.select(spec.connectionId, task.spec.caseId);
    if (selection.revision !== spec.credentialRevision) throw new RuntimeInputError(409, '原任务的邮箱授权已更新，未继续使用原邮件资料。');
    if (spec.source) {
      const source = this.getContext(spec.source.contextId, selection);
      if (source.value.source.messageId !== spec.source.messageId || source.value.source.revision !== spec.source.revision
        || protectedSource(source.value.encryption) && !spec.allowProtectedSourcePlaintext) throw new RuntimeInputError(409, '原邮件资源与任务许可不一致。');
    }
    for (const file of spec.attachments) {
      const selected = this.files.select(file.id, { caseId: selection.caseId, connectionId: selection.id, credentialRevision: selection.revision }, file.sha256);
      if (selected.sourceProtected && !spec.allowProtectedSourcePlaintext) throw new RuntimeInputError(409, '未取得以明文发送原附件的明确许可。');
    }
  }
  taskContext(task: TaskRecord): EwsMessageContext | undefined {
    this.validateTask(task); const spec = mailTaskSpecSchema.parse(task.spec.mail);
    return spec.source ? this.getContext(spec.source.contextId, this.options.select(spec.connectionId, task.spec.caseId)).value : undefined;
  }
  execute(task: TaskRecord, execution: { body?: string; signal: AbortSignal; guard(): void }): Promise<EwsMailOperation> {
    const existing = this.active.get(task.id); if (existing) return existing;
    const work = this.executeInternal(task, execution).finally(() => { this.active.delete(task.id); });
    this.active.set(task.id, work); return work;
  }
  needsSubmissionReceipt(task: TaskRecord, at = Date.now()): boolean {
    const operation = this.operationForTask(task.id);
    return Boolean(task.dependencyId && operation && matchesMailTask(task, operation) && operation.state === 'submitted'
      && !operation.internetMessageId && operation.receiptLookup?.state !== 'unavailable'
      && (operation.receiptLookup?.attempts ?? 0) < 3 && (!operation.receiptLookup?.nextAt || Date.parse(operation.receiptLookup.nextAt) <= at));
  }
  reconcileSubmissionReceipt(task: TaskRecord, execution: { signal: AbortSignal; guard(): void }): Promise<EwsMailOperation> {
    const active = this.active.get(task.id); if (active) return active;
    const work = this.reconcileSubmissionReceiptInternal(task, execution).finally(() => this.active.delete(task.id));
    this.active.set(task.id, work); return work;
  }
  private async reconcileSubmissionReceiptInternal(task: TaskRecord, execution: { signal: AbortSignal; guard(): void }): Promise<EwsMailOperation> {
    execution.guard(); execution.signal.throwIfAborted(); this.validateTask(task);
    const operation = this.operationForTask(task.id);
    if (!operation || !matchesMailTask(task, operation) || operation.state !== 'submitted') throw new RuntimeInputError(409, '没有可核对的已提交邮件回执。');
    if (!this.needsSubmissionReceipt(task)) return operation;
    const selection = this.options.select(operation.connectionId, task.spec.caseId);
    const attempts = (operation.receiptLookup?.attempts ?? 0) + 1;
    const save = (lookup: NonNullable<EwsMailOperation['receiptLookup']>, found?: { internetMessageId: string; sentMessageId: string }) => {
      const current = this.operationForTask(task.id);
      if (!current || !matchesMailTask(task, current) || current.state !== 'submitted') throw new RuntimeInputError(409, '原邮件回执已变化。');
      const saved = { ...current, ...found, receiptLookup: lookup, replyTracking: Boolean(found || current.internetMessageId), updatedAt: now() };
      this.options.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, saved); this.options.changed(); return saved;
    };
    const nextAt = new Date(Date.now() + (attempts === 1 ? 15000 : 60000)).toISOString();
    save({ attempts, state: 'pending', nextAt });
    return this.options.run(selection, async signal => {
      const combined = AbortSignal.any([signal, execution.signal]);
      try {
        execution.guard(); combined.throwIfAborted(); this.validateTask(task);
        const activity = this.options.inbox.ingestProcessed({ sourceId: 'connector:' + selection.id, sourceGeneration: selection.id,
          kind: 'connector.task_access', actor: 'agent', operation: 'create', caseId: selection.caseId, occurredAt: now(),
          externalId: `submission-receipt:${operation.id}:${attempts}`, causationId: task.executionEventId,
          payload: { provider: 'ews', connectionId: selection.id, taskId: task.rootTaskId ?? task.id, mailTaskId: task.id,
            operationId: operation.id, purpose: 'submission_receipt', attempt: attempts } });
        const result = await readEwsSubmissionReceipt(selection.token, operation.id, combined, this.options.transport);
        execution.guard(); combined.throwIfAborted(); this.validateTask(task);
        this.options.inbox.ingestProcessed({ sourceId: 'connector:' + selection.id, sourceGeneration: selection.id,
          kind: 'connector.mail_submission_receipt', actor: 'external', operation: 'create', caseId: selection.caseId, occurredAt: now(),
          externalId: `submission-receipt-result:${operation.id}:${attempts}`, causationId: activity.id,
          payload: { provider: 'ews', connectionId: selection.id, operationId: operation.id, result } });
        if (result.state === 'found') return save({ attempts, state: 'found', checkedAt: now() },
          { internetMessageId: result.internetMessageId!, sentMessageId: result.sentMessageId! });
        const unavailable = result.state === 'ambiguous' || attempts >= 3;
        return save({ attempts, state: unavailable ? 'unavailable' : 'pending', checkedAt: now(),
          ...(unavailable ? {} : { nextAt }), reason: result.state === 'ambiguous' ? 'ambiguous' : 'not_indexed' });
      } catch (error) {
        execution.guard(); combined.throwIfAborted(); this.validateTask(task);
        const unavailable = attempts >= 3 || error instanceof ConnectorProviderError && [400, 401, 403, 409].includes(error.status);
        return save({ attempts, state: unavailable ? 'unavailable' : 'pending', checkedAt: now(),
          ...(unavailable ? {} : { nextAt }), reason: 'read_failed' });
      }
    }, 60_000);
  }
  private async executeInternal(task: TaskRecord, execution: { body?: string; signal: AbortSignal; guard(): void }): Promise<EwsMailOperation> {
    const spec = mailTaskSpecSchema.parse(task.spec.mail); const specHash = hash(JSON.stringify(spec));
    let operation = this.operationForTask(task.id);
    if (operation && !matchesMailTask(task, operation)) throw new RuntimeInputError(409, '原邮件操作与当前任务许可不一致。');
    if (operation && ['submitted', 'failed', 'unknown'].includes(operation.state)) return operation;
    const save = (changes: Partial<EwsMailOperation>) => {
      operation = { ...operation!, ...changes, updatedAt: now() };
      this.options.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, operation); this.options.changed();
      return operation;
    };
    if (operation?.phase && operation.phase !== 'prepared') return save({ state: 'unknown', error: '先前操作在 Exchange 请求期间中断，结果尚未核对；没有自动重发。' });
    execution.guard(); execution.signal.throwIfAborted();
    const selection = this.options.select(spec.connectionId, task.spec.caseId);
    if (selection.revision !== spec.credentialRevision) throw new RuntimeInputError(409, '任务绑定的邮箱凭据已更新，请重新确认发送范围。');
    const source = spec.source && this.getContext(spec.source.contextId, selection);
    if (source && (source.value.source.messageId !== spec.source!.messageId || source.value.source.revision !== spec.source!.revision)) throw new RuntimeInputError(409, '原邮件版本与许可不一致。');
    if (source && protectedSource(source.value.encryption) && !spec.allowProtectedSourcePlaintext) throw new RuntimeInputError(409, '原邮件受保护；当前仅支持明文发送，需要本人明确选择，暂不支持加密发信。');
    const files = spec.attachments.map(file => this.files.select(file.id, { caseId: selection.caseId,
      connectionId: selection.id, credentialRevision: selection.revision }, file.sha256));
    if (files.length > EWS_MAX_OUTGOING_ATTACHMENTS || files.reduce((sum, item) => sum + item.size, 0) > EWS_MAX_OUTGOING_ATTACHMENT_BYTES) throw new RuntimeInputError(400, '每封邮件最多 10 个附件，总计不超过 10 MiB。');
    const body = operation?.body ?? spec.body ?? execution.body;
    if (files.some(file => file.sourceProtected) && !spec.allowProtectedSourcePlaintext) throw new RuntimeInputError(409, '选中的附件来自受保护邮件，需要本人明确选择以明文发送。');
    if (!mailBodySchema.safeParse(body).success) throw new RuntimeInputError(400, '邮件正文缺失、包含无效字符或超过 200,000 字符。');
    if (body === undefined) throw new RuntimeInputError(400, '邮件正文缺失。');
    const payloadHash = hash(JSON.stringify({ ...spec, body }));
    if (operation?.payloadHash && operation.payloadHash !== payloadHash) throw new RuntimeInputError(409, '原邮件内容已冻结，不能替换后重发。');
    if (!operation) {
      operation = { id: hash('mail:' + task.id), taskId: task.id, caseId: task.spec.caseId, approvalRevision: task.approvalRevision!,
        requirementsRevision: task.requirementsRevision ?? 1, specHash, payloadHash, connectionId: selection.id,
        credentialRevision: selection.revision, body, phase: 'prepared', state: 'prepared', createdAt: now(), updatedAt: now() };
      this.options.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, operation);
    }
    this.files.pin(files.map(file => file.id), task.id);
    return this.options.run(selection, async operationSignal => {
      const signal = AbortSignal.any([execution.signal, operationSignal]);
      const guard = () => { execution.guard(); signal.throwIfAborted(); this.current(selection); };
      try {
        guard(); save({ state: 'submitting', phase: 'draft_creating' });
        let draft = await prepareEwsMessage(selection.token, { operationId: operation!.id, mode: spec.mode,
          ...(source ? { source: { folderId: selection.folderId, messageId: spec.source!.messageId, revision: spec.source!.revision } } : {}),
          to: spec.to.map(address => ({ address })), cc: spec.cc.map(address => ({ address })), bcc: spec.bcc.map(address => ({ address })),
          subject: spec.subject, body, allowPlaintextProtectedSource: spec.allowProtectedSourcePlaintext === true }, signal, this.options.transport);
        save({ phase: 'draft_saved', draftId: draft.draftId, draftChangeKey: draft.revision });
        for (const file of files) {
          guard(); const checked = this.files.select(file.id, { caseId: selection.caseId, connectionId: selection.id, credentialRevision: selection.revision }, file.sha256);
          save({ phase: 'attachment_adding' });
          draft = await attachEwsFile(selection.token, { operationId: operation!.id, draftId: draft.draftId, revision: draft.revision,
            file: { path: checked.path, sha256: file.sha256, size: file.size, name: file.name, contentType: file.contentType }, custodyRoot: this.files.root }, signal, this.options.transport);
          save({ phase: 'attachment_saved', draftChangeKey: draft.revision });
        }
        guard(); const actual = await inspectEwsDraft(selection.token, { operationId: operation!.id, draftId: draft.draftId }, signal, this.options.transport);
        if (!addressesEqual(actual.to, spec.to) || !addressesEqual(actual.cc, spec.cc) || !addressesEqual(actual.bcc, spec.bcc)
          || actual.subject !== spec.subject || actual.body.replaceAll('\r\n', '\n') !== body.replaceAll('\r\n', '\n')
          || actual.attachments.length !== files.length || actual.attachments.some((item, index) => item.name !== files[index].name || item.size !== files[index].size || item.sha256 !== files[index].sha256)) throw new RuntimeInputError(409, 'Exchange 草稿内容与授权范围不一致，已停止发送并保留草稿。');
        guard(); save({ phase: 'sending', draftChangeKey: actual.revision });
        const submitted = await submitEwsDraft(selection.token, { operationId: operation!.id, draftId: actual.draftId, revision: actual.revision, snapshotHash: actual.snapshotHash }, signal, this.options.transport);
        // Record factual completion even if permission was revoked while Exchange accepted the request.
        return save({ state: 'submitted', phase: 'submitted', submittedAt: now(), attachmentCount: files.length,
          ...(task.dependencyId ? { replyTracking: Boolean(submitted.internetMessageId),
            ...(!submitted.internetMessageId ? { receiptLookup: { attempts: 0, state: 'pending', nextAt: new Date(Date.now() + 5000).toISOString() } as const } : {}) } : {}),
          ...(submitted.internetMessageId ? { internetMessageId: submitted.internetMessageId } : {}),
          ...(submitted.sentMessageId ? { sentMessageId: submitted.sentMessageId } : {}) });
      } catch (error) {
        const uncertain = error instanceof EwsNativeOperationError ? error.outcomeUnknown : ['draft_creating', 'attachment_adding', 'sending'].includes(operation!.phase ?? '');
        return save({ state: uncertain ? 'unknown' : 'failed', ...(error instanceof EwsNativeOperationError && error.draftId ? { draftId: error.draftId } : {}), error: uncertain
          ? '邮件操作未收到确定回执，草稿或发送结果可能已生效；已停止且不会自动重发。'
          : '邮件没有提交发送；已创建的草稿保留，请检查邮箱授权和所选内容。' });
      }
    }, 5 * 60_000);
  }
}
