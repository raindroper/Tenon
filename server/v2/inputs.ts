import { createHash, randomUUID } from 'node:crypto';
import type { Feedback, Message, ReasoningPolicy, Source } from '../../shared/types.js';
import { OwnerMessageRequestConflict, type PreparedChatFile, type Store } from '../store.js';
import type { CaseService } from './case-service.js';
import type { EventInbox, StoredEvent } from './events.js';
import { RuntimeInputError, type RuntimeFeedbackInput } from '../runtime.js';
import { feedbackVersion } from '../feedback-version.js';
import type { ImageUpload } from '../../shared/chat-images.js';
import { MAX_CHAT_FILE_BYTES, MAX_CHAT_FILE_NAME, MAX_CHAT_FILES, MAX_CHAT_FILES_BYTES, type ChatFileUpload } from '../../shared/chat-files.js';
import { prepareImages, imageUploadsInput } from './images.js';
import { z } from 'zod';
import type { TaskOutcomeReference } from '../../shared/personal-memory.js';
import { bindMessageReasoning } from '../models/message-binding.js';

const messageId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const fileUpload = z.object({
  name: z.string().min(1).max(MAX_CHAT_FILE_NAME).refine(name => name.trim().length > 0 && name !== '.' && name !== '..'
    && !/[\\/\x00-\x1f\x7f]|\p{Surrogate}/u.test(name), '附件的文件名无效。'),
  mediaType: z.string().min(3).max(150).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
  data: z.string().max(Math.ceil(MAX_CHAT_FILE_BYTES / 3) * 4)
    .refine(data => data.length % 4 === 0 && !/[^A-Za-z0-9+/]/.test(data.replace(/={1,2}$/, '')), '附件数据无效。')
    .refine(data => Buffer.byteLength(data, 'base64') <= MAX_CHAT_FILE_BYTES, '单个文件不能超过 10 MiB。'),
}).strict();
const chatFilesInput = z.array(fileUpload).max(MAX_CHAT_FILES)
  .refine(files => files.reduce((size, file) => size + Buffer.byteLength(file.data, 'base64'), 0) <= MAX_CHAT_FILES_BYTES, '每条消息的文件合计不能超过 20 MiB。');
export const messageInput = z.object({ content: z.string().trim().max(20000), caseId: messageId.optional(), replyTo: messageId.optional(),
  attachments: imageUploadsInput.optional(), files: chatFilesInput.optional(),
  reasoningEffort: z.enum(['auto', 'none', 'low', 'high', 'max']).optional(), deviceId: messageId.optional(),
  requestId: z.string().uuid().optional() }).strict()
  .refine(input => input.content.length > 0 || Boolean(input.attachments?.length || input.files?.length), '请输入文字或添加附件。');

function prepareChatFiles(uploads: ChatFileUpload[] = []): PreparedChatFile[] {
  return chatFilesInput.parse(uploads).map(upload => {
    const data = Buffer.from(upload.data, 'base64');
    return { attachment: { id: randomUUID(), name: upload.name, mediaType: upload.mediaType, size: data.length }, data };
  });
}

export type FeedbackInput = RuntimeFeedbackInput;
export type SourceInput = Pick<Source, 'title' | 'content' | 'filename' | 'caseId'>;
const now = () => new Date().toISOString();
// The legacy HTTP override stays narrow; stored/internal reasoning records retain their historical type.
type OwnerMessageInput = Omit<z.infer<typeof messageInput>, 'reasoningEffort'> & { reasoningEffort?: ReasoningPolicy };
interface FeedbackContext { caseId?: string; targetContent: string; taskOutcome?: TaskOutcomeReference }
export interface OwnerInputOptions {
  feedbackOutcome?: (target: Pick<Feedback, 'targetType' | 'targetId'> & { caseId?: string; targetContent: string }) => TaskOutcomeReference | undefined;
}
const messageFingerprint = (input: OwnerMessageInput) => createHash('sha256').update(JSON.stringify([
  input.content, input.caseId ?? null, input.replyTo ?? null, input.reasoningEffort ?? null, input.deviceId ?? null,
  (input.attachments ?? []).map(image => [image.name, image.data]),
  ...(input.files?.length ? [{ files: input.files.map(file => [file.name, file.mediaType, createHash('sha256').update(file.data).digest('hex')]) }] : []),
])).digest('hex');

/** Owner commands and recovery share event construction; frontend-provided target text is never trusted. */
export class OwnerInputs {
  private readonly pendingMessages = new Map<string, { fingerprint: string; work: Promise<StoredEvent> }>();
  constructor(private readonly store: Store, private readonly inbox: EventInbox, private readonly cases: CaseService,
    private readonly defaultCase: () => Promise<string>, private readonly options: OwnerInputOptions = {}) {}

  private messageEvent(message: Message): StoredEvent {
    let event = this.inbox.ingest({ sourceId: 'owner-chat', externalId: message.id, kind: 'owner.message', actor: 'owner', operation: 'create',
      occurredAt: message.createdAt, ...(message.caseId ? { caseId: message.caseId } : {}),
      payload: { content: message.content, messageId: message.id, ...(message.timezone ? { timezone: message.timezone } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.files?.length ? { files: message.files } : {}),
        ...(message.reasoningEffort !== undefined ? { reasoningEffort: message.reasoningEffort } : {}),
        ...(message.modelBinding !== undefined ? { modelBinding: message.modelBinding } : {}),
        ...(message.deviceId !== undefined ? { deviceId: message.deviceId } : {}) } }).event;
    if (!event.caseId && message.caseId) event = this.inbox.bindCase(event.id, message.caseId);
    if (event.caseId && event.caseId !== message.caseId) this.store.put('messages', { ...message, caseId: event.caseId });
    return event;
  }
  private sourceEvent(source: Source): void {
    let event = this.inbox.ingest({ sourceId: `store-source:${source.id}`, externalId: source.id, version: createHash('sha256').update(source.content).digest('hex'),
      kind: 'owner.source', operation: 'create', actor: 'owner', occurredAt: source.createdAt, ...(source.caseId ? { caseId: source.caseId } : {}),
      payload: { sourceId: source.id, title: source.title, content: source.content } }).event;
    if (!event.caseId && source.caseId) event = this.inbox.bindCase(event.id, source.caseId);
    if (event.caseId && event.caseId !== source.caseId) this.store.put('sources', { ...source, caseId: event.caseId });
  }
  private async feedbackContext(input: Pick<Feedback, 'targetType' | 'targetId' | 'targetVersion'>, recovering = false): Promise<FeedbackContext> {
    const checkVersion = (content: string) => {
      if (!recovering && input.targetVersion !== undefined && input.targetVersion !== feedbackVersion(content)) {
        throw new RuntimeInputError(409, '反馈对象的正文已更新，请关闭面板，查看当前内容后再评价。');
      }
    };
    if (input.targetType === 'case') {
      const item = await this.cases.get(input.targetId); if (!item) { if (recovering) return { targetContent: '' }; throw new RuntimeInputError(404, '反馈事项不存在。'); }
      const targetContent = `${item.title}\n${item.objective}`;
      checkVersion(targetContent); return { caseId: item.id, targetContent };
    }
    if (input.targetType === 'message' || input.targetType === 'artifact') {
      const item = this.store.get(input.targetType === 'message' ? 'messages' : 'artifacts', input.targetId);
      if (!item) { if (recovering) return { targetContent: '' }; throw new RuntimeInputError(404, '反馈对象不存在。'); }
      if (!recovering && 'outputState' in item && item.outputState === 'streaming') throw new RuntimeInputError(409, '请等这条回复结束后再评价。');
      checkVersion(item.content);
      const targetContent = item.content.slice(0, 8000);
      const taskOutcome = recovering ? undefined : this.options.feedbackOutcome?.({ targetType: input.targetType, targetId: input.targetId,
        caseId: item.caseId, targetContent });
      return { ...(item.caseId ? { caseId: item.caseId } : {}), targetContent, ...(taskOutcome ? { taskOutcome } : {}) };
    }
    // Retired records remain exportable. Their old feedback can be recovered as
    // unscoped evidence, but cannot edit the new personal memory by ID.
    const item = this.store.get(input.targetType === 'memory' ? 'memories' : 'initiatives', input.targetId);
    return { targetContent: item ? 'content' in item ? item.content : `${item.title}\n${item.why}` : '' };
  }
  private feedbackEvent(item: Feedback, context: FeedbackContext): void {
    let event = this.inbox.ingest({ sourceId: 'owner-feedback', externalId: item.id, kind: 'owner.feedback', actor: 'owner', operation: 'create', occurredAt: item.createdAt,
      ...(context.caseId ? { caseId: context.caseId } : {}), payload: { ...item, targetContent: context.targetContent } }).event;
    if (!event.caseId && context.caseId) event = this.inbox.bindCase(event.id, context.caseId);
    if (event.caseId && event.caseId !== item.caseId) this.store.put('feedback', { ...item, caseId: event.caseId, targetContent: context.targetContent });
  }
  async recover(): Promise<void> {
    for (const message of this.store.list('messages')) if (message.role === 'user') {
      const scoped = message.caseId ? message : { ...message, caseId: await this.defaultCase() };
      if (!message.caseId) this.store.put('messages', scoped); this.messageEvent(scoped);
    }
    for (const source of this.store.list('sources')) {
      const scoped = source.caseId ? source : { ...source, caseId: await this.defaultCase() };
      if (!source.caseId) this.store.put('sources', scoped); this.sourceEvent(scoped);
    }
    for (const item of this.store.list('feedback')) if (['message', 'artifact', 'case'].includes(item.targetType)) {
      const context = item.targetContent === undefined ? await this.feedbackContext(item, true) : {
        caseId: item.caseId, targetContent: item.targetContent, ...(item.taskOutcome ? { taskOutcome: item.taskOutcome } : {}) };
      context.caseId ??= await this.defaultCase(); this.feedbackEvent(item, context);
    }
  }
  /** Reconcile accepted submissions without reviving their topic or resetting the original event. */
  replayMessage(input: OwnerMessageInput): Promise<StoredEvent> | undefined {
    if (!input.requestId) return undefined;
    const fingerprint = messageFingerprint(input);
    const pending = this.pendingMessages.get(input.requestId);
    const saved = this.store.ownerMessageRequest(input.requestId);
    if (pending && pending.fingerprint !== fingerprint || saved && saved.fingerprint !== fingerprint) {
      throw new RuntimeInputError(409, '消息提交编号已绑定其他内容或范围，请作为新消息发送。');
    }
    if (pending) return pending.work;
    return saved ? Promise.resolve(this.messageEvent(saved.message)) : undefined;
  }
  async message(content: string, caseId?: string, replyTo?: string, attachments?: ImageUpload[], reasoningEffort?: ReasoningPolicy,
    deviceId?: string, requestId?: string, files?: ChatFileUpload[]): Promise<StoredEvent> {
    const input = { content, caseId, replyTo, attachments, reasoningEffort, deviceId, requestId, files };
    const replay = this.replayMessage(input); if (replay) return replay;
    const fingerprint = messageFingerprint(input);
    const work = this.persistMessage(input, fingerprint).finally(() => {
      if (requestId && this.pendingMessages.get(requestId)?.work === work) this.pendingMessages.delete(requestId);
    });
    if (requestId) this.pendingMessages.set(requestId, { fingerprint, work });
    return work;
  }
  private async persistMessage(input: OwnerMessageInput, fingerprint: string): Promise<StoredEvent> {
    let { caseId } = input;
    const { content, replyTo, attachments, reasoningEffort, deviceId, requestId, files } = input;
    if (replyTo) {
      const target = this.store.get('messages', replyTo);
      if (!target) throw new RuntimeInputError(404, '回复对象不存在。');
      if (caseId && target.caseId && caseId !== target.caseId) throw new RuntimeInputError(409, '回复对象与当前事项不一致。');
      caseId ??= target.caseId;
    }
    const targetCaseId = caseId ?? await this.defaultCase();
    return this.cases.serializeOwnerWrite(targetCaseId, async () => {
      await this.cases.requireOpen(targetCaseId);
      const images = await prepareImages(attachments);
      const chatFiles = prepareChatFiles(files);
      await this.cases.activate(targetCaseId);
      const message: Message = { id: randomUUID(), role: 'user', content, createdAt: now(), timezone: this.store.getSettings().timezone, caseId: targetCaseId, ...(replyTo ? { replyTo } : {}),
        ...(images.length ? { attachments: images.map(image => image.attachment) } : {}), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(chatFiles.length ? { files: chatFiles.map(file => file.attachment) } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}) };
      try {
        const accepted = this.store.atomic(() => {
          message.modelBinding = bindMessageReasoning(this.store.models.resolve({ caseId: targetCaseId, purpose: 'conversation' }), message) ?? null;
          return this.store.insertOwnerMessage(message, images, requestId ? { id: requestId, fingerprint } : undefined, chatFiles);
        });
        return this.messageEvent(accepted);
      } catch (error) {
        if (error instanceof OwnerMessageRequestConflict) throw new RuntimeInputError(409, error.message);
        throw error;
      }
    });
  }
  async source(input: SourceInput): Promise<Source> {
    input = { ...input, caseId: input.caseId ?? await this.defaultCase() };
    if (input.caseId && !await this.cases.get(input.caseId)) throw new RuntimeInputError(404, '资料所属事项不存在。');
    const source: Source = { ...input, id: randomUUID(), createdAt: now() }; this.store.insert('sources', source); this.sourceEvent(source); return source;
  }
  async feedback(input: FeedbackInput): Promise<Feedback & FeedbackInput> {
    const context = await this.feedbackContext(input);
    context.caseId ??= await this.defaultCase();
    const item: Feedback & FeedbackInput = { targetType: input.targetType, targetId: input.targetId, verdict: input.verdict, comment: input.comment,
      ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }), id: randomUUID(), createdAt: now(), targetContent: context.targetContent,
      ...(context.caseId ? { caseId: context.caseId } : {}), ...(context.taskOutcome ? { taskOutcome: context.taskOutcome } : {}) };
    this.store.insert('feedback', item); this.feedbackEvent(item, context); return item;
  }
}
