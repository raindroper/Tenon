import { createHash } from 'node:crypto';
import type { Message } from '../../shared/types.js';
import type { Store } from '../store.js';
import { reviewPublicationHash } from './review-decisions.js';

interface ResponseContext {
  runId: string; caseId: string; replyTo?: string; automatic: boolean;
  notificationKey?: string;
  /** Reopen only this run's durable public buffer, never regenerate its content. */
  resume?: boolean;
  assertOwned(): void;
}
export const runResponseId = (runId: string): string => createHash('sha256').update(`reply-run:${runId}`).digest('hex');

/** One durable owner-facing projection per run; native memory remains the model's history. */
export class RunResponse {
  /** Publish an accepted review decision once. The lifecycle guard and the
   * visible write share a synchronous transaction with no await gap. */
  static publishReview(store: Store, input: { id: string; caseId: string; runId: string; content: string; contentHash: string; createdAt: string;
    reminder?: Message['reminder'] },
    assertCurrent: () => void): Message {
    return store.atomic(() => {
      const existing = store.get('messages', input.id);
      const hash = reviewPublicationHash(input.content, input.reminder);
      if (hash !== input.contentHash) throw new Error('回顾通知正文与原决定不一致，未投递。');
      if (existing) {
        if (existing.role !== 'assistant' || existing.caseId !== input.caseId || existing.runId !== input.runId
          || existing.outputState !== 'complete' || reviewPublicationHash(existing.content, existing.reminder) !== hash) {
          throw new Error('回顾通知标识已绑定其他内容，未覆盖原记录。');
        }
        return existing;
      }
      assertCurrent();
      const message: Message = { id: input.id, role: 'assistant', caseId: input.caseId, runId: input.runId,
        content: input.content, createdAt: input.createdAt, outputState: 'complete', ...(input.reminder ? { reminder: input.reminder } : {}) };
      store.put('messages', message);
      return message;
    });
  }
  readonly id: string;
  private text = '';
  private readonly notifications: string[] = [];
  private images: NonNullable<Message['attachments']> = [];
  private readonly createdAt: string;
  private readonly replyTo?: string;
  private state: NonNullable<Message['outputState']> = 'streaming';
  private note: string | undefined;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private failure: unknown;
  private lastWritten = '';

  constructor(private readonly store: Store, private readonly context: ResponseContext) {
    this.id = context.notificationKey ? createHash('sha256').update(`notification:${context.notificationKey}`).digest('hex') : runResponseId(context.runId);
    const saved = context.notificationKey || context.resume ? store.get('messages', this.id) : undefined;
    const previous = saved?.caseId === context.caseId && (context.notificationKey || saved.runId === context.runId) ? saved : undefined;
    this.createdAt = previous?.createdAt ?? new Date().toISOString();
    this.replyTo = context.replyTo ?? (context.resume ? previous?.replyTo : undefined);
    this.images = previous?.attachments ?? [];
    if (previous?.content.trim()) {
      if (context.resume && !context.notificationKey) this.text = previous.content;
      else this.notifications.push(previous.content);
    }
  }
  get hasContent(): boolean { return Boolean(this.content().trim()); }
  attachImages(images: NonNullable<Message['attachments']>): void {
    this.images = images;
  }
  appendFinal(content: string): void {
    const previous = this.content();
    if (!content || previous.includes(content)) return;
    if (content.startsWith(previous)) this.append(content.slice(previous.length));
    else this.append('\n\n' + content);
  }
  private content(): string {
    const text = this.context.automatic ? this.text : '';
    const notifications = this.notifications.filter(value => !text.includes(value));
    return [text, ...notifications].filter(value => value.trim()).join('\n\n');
  }
  private healthy(): void { if (this.failure) throw this.failure; }
  append(delta: string): void {
    this.healthy();
    if (this.closed || !this.context.automatic || !delta) return;
    this.text += delta;
    if (!this.lastWritten) this.checkpoint();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try { this.checkpoint(); } catch (error) { this.failure = error; }
      }, 250);
      this.timer.unref();
    }
  }
  notify(content: string): string {
    this.healthy();
    if (this.closed) throw new Error('本轮回复已经结束。');
    const value = content.trim();
    if (value && !this.notifications.some(previous => previous === value || this.context.notificationKey && previous.includes(value))) this.notifications.push(value);
    this.checkpoint(); return this.id;
  }
  checkpoint(): void {
    this.healthy(); clearTimeout(this.timer); this.timer = undefined;
    const content = this.content();
    if (!content.trim() && !this.images.length) return;
    const signature = JSON.stringify([content, this.state, this.note, this.images]);
    if (signature === this.lastWritten) return;
    this.context.assertOwned();
    this.store.put('messages', { id: this.id, role: 'assistant', content, caseId: this.context.caseId,
      runId: this.context.runId, createdAt: this.createdAt, outputState: this.state,
      ...(this.note ? { outputNote: this.note } : {}), ...(this.replyTo ? { replyTo: this.replyTo } : {}),
      ...(this.images.length ? { attachments: this.images } : {}) });
    this.lastWritten = signature;
  }
  continuation(): void {
    this.note = '正在续写剩余正文，已完成的操作不会在续写中重做。'; this.checkpoint();
  }
  finish(state: 'complete' | 'incomplete', note?: string, fallback: boolean | string = false): void {
    clearTimeout(this.timer); this.timer = undefined; this.closed = true;
    this.state = state; this.note = note;
    if (fallback && !this.hasContent && this.context.automatic) {
      this.text = typeof fallback === 'string' ? fallback : '模型本轮没有返回可展示的正文。';
    }
    // A transient checkpoint failure stops inference, but a final flush may
    // still save the accepted buffer after storage recovers.
    this.failure = undefined;
    this.checkpoint();
  }
  freeze(): void {
    try { this.finish('incomplete', '本轮已停止，已经收到的内容已保留。'); }
    catch (error) { this.failure = error; }
  }
  dispose(): void { clearTimeout(this.timer); this.timer = undefined; }
}
