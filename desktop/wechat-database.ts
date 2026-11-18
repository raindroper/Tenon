import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { weChatObservationBatch } from '../shared/wechat-observation.js';

const directory = fileURLToPath(new URL('./wechat-db/', import.meta.url));
const outputLimit = 1024 * 1024;
const timeoutMs = 75_000;

export const weChatChatSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{64}$/),
  chatId: z.string().regex(/^[A-Za-z0-9_.@-]{1,200}$/),
  title: z.string().min(1).max(200).refine(value => Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value)),
  chatType: z.enum(['group', 'private']).optional(),
  disambiguation: z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
}).strict();
export type WeChatChat = z.infer<typeof weChatChatSchema>;
type Binding = Pick<WeChatChat, 'accountId' | 'chatId'>;

const cursor = z.string().min(1).max(16 * 1024);
const chatList = z.object({ chats: z.array(weChatChatSchema).max(500) }).strict();
const baseline = z.object({ cursor }).strict();
const verifiedChat = z.object({ chatTitle: weChatChatSchema.shape.title.optional() }).strict();
const readResult = z.object({ cursor, rows: weChatObservationBatch.shape.rows, chatTitle: weChatChatSchema.shape.title.optional() }).strict().refine(value =>
  weChatObservationBatch.safeParse({ grantId: 'reader', windowId: 'reader', rows: value.rows }).success &&
  new Set(value.rows.map(row => row.id)).size === value.rows.length);
const reply = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: z.number().int(), ok: z.literal(false), error: z.string().max(64) }).strict(),
]);

const errors: Record<string, string> = {
  'not-running': '请在本机打开并登录电脑版微信。',
  'unsupported-version': '当前仅验证了 Windows 微信 4.1.15.56。',
  'unsupported-platform': '当前微信后台观察仅支持 Windows x64。',
  'account-ambiguous': '无法确认正在登录的微信账号，请检查微信登录状态。',
  'account-changed': '微信账号已变化，请重新选择要观察的会话。',
  'chat-unavailable': '已选微信会话已不可读取，请重新选择。',
  'access-denied': 'Windows 拒绝了对本机微信的只读访问。',
  'database-busy': '微信正在更新本机消息库，暂时无法取得一致的只读副本。',
  'database-too-large': '微信消息库超过当前读取组件支持的大小。',
  'database-unreadable': '无法安全读取本机微信消息库。',
  'shard-unavailable': '无法确认该会话的全部增量位置，观察已暂停。',
  'shard-changed': '微信消息库已发生变化。请重新开启这条会话的观察。',
  'invalid-cursor': '微信消息位置已经变化。请重新开启这条会话的观察。',
  'unsupported-schema': '本机微信消息库的格式超出当前支持范围。',
};

export class WeChatDatabaseError extends Error {
  constructor(readonly code: string) {
    super(Object.hasOwn(errors, code) ? errors[code] : '本机微信读取失败。');
  }
}

type ReaderProcess = ChildProcessByStdio<Writable, Readable, null>;
type Reader = { child: ReaderProcess; closed: Promise<void>; ended: boolean };

export class WeChatDatabaseReader {
  private process?: Reader;
  private closing?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private nextId = 0;

  list(signal: AbortSignal) {
    return this.request('list', {}, chatList, signal).then(value => value.chats);
  }

  verify(chat: Binding, signal: AbortSignal) {
    return this.request('verify', { accountId: chat.accountId, chatId: chat.chatId }, verifiedChat, signal);
  }

  baseline(chat: Binding, signal: AbortSignal, since?: string, until?: string) {
    return this.request('baseline', { accountId: chat.accountId, chatId: chat.chatId,
      ...(since ? { since } : {}), ...(until ? { until } : {}),
    }, baseline, signal).then(value => value.cursor);
  }

  read(chat: Binding, position: string, signal: AbortSignal) {
    return this.request('read', { accountId: chat.accountId, chatId: chat.chatId, cursor: position }, readResult, signal);
  }

  async close(): Promise<void> {
    clearTimeout(this.idle);
    const reader = this.process;
    if (!reader) return this.closing;
    this.process = undefined;
    this.trackClose(reader.closed);
    reader.child.stdin.end();
    const kill = setTimeout(() => reader.child.kill(), 1500);
    try { await reader.closed; }
    finally { clearTimeout(kill); }
  }

  private trackClose(closed: Promise<void>): void {
    this.closing = closed;
    void closed.then(() => { if (this.closing === closed) this.closing = undefined; });
  }

  private async start(): Promise<Reader> {
    const parent = await realpath(tmpdir());
    const scratch = await mkdtemp(path.join(parent, 'rae-wechat-'));
    const removeScratch = async () => {
      if (await realpath(scratch).catch(() => undefined) === scratch && path.dirname(scratch) === parent) {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    };
    let child: ReaderProcess;
    try {
      child = spawn(path.join(directory, 'runtime', 'python.exe'), ['-I', '-B', '-u', '-X', 'utf8', path.join(directory, 'reader.py'), scratch], {
        cwd: directory, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
    } catch (error) { await removeScratch(); throw error; }
    const closed = new Promise<void>(resolve => child.once('close', () => {
      reader.ended = true;
      if (this.process === reader) {
        this.process = undefined;
        this.trackClose(reader.closed);
      }
      void removeScratch().catch(() => {}).then(resolve);
    }));
    const reader = { child, closed, ended: false };
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    this.process = reader;
    return reader;
  }

  private request<T>(command: 'list' | 'verify' | 'baseline' | 'read', args: object, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const next = this.queue.then(async () => {
      await this.closing;
      signal.throwIfAborted();
      clearTimeout(this.idle);
      const reader = this.process ?? await this.start();
      try { return await this.exchange(reader, command, args, schema, signal); }
      finally {
        if (this.process === reader) {
          this.idle = setTimeout(() => { void this.close(); }, 60_000);
          this.idle.unref();
        }
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private exchange<T>(reader: Reader, command: string, args: object, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    if (reader.ended) return reader.closed.then(() => { throw new Error('本机微信读取组件已退出。'); });
    const { child } = reader;
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      let stopped: Error | undefined;
      const cleanup = () => {
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        child.stdout.off('data', onData);
        child.off('close', onClose);
      };
      const stop = (error: Error) => { stopped ??= error; child.kill(); };
      const abort = () => stop(new Error('微信读取已取消。'));
      const deadline = setTimeout(() => stop(new Error('读取微信数据库超时。')), timeoutMs);
      const onClose = () => {
        cleanup();
        void reader.closed.then(() => reject(stopped ?? new Error('本机微信读取组件未能运行。')));
      };
      const onData = (chunk: Buffer) => {
        if (stopped) return;
        bytes += chunk.length;
        if (bytes > outputLimit) { stop(new Error('本机微信读取结果超出大小限制。')); return; }
        chunks.push(chunk);
        const newline = chunk.indexOf(10);
        if (newline < 0) return;
        try {
          if (newline !== chunk.length - 1) throw new Error('Unexpected framing');
          const response = reply.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))));
          if (response.id !== id) throw new Error('Unexpected response ID');
          if (response.ok) {
            const result = schema.parse(response.result);
            cleanup(); resolve(result);
          } else {
            cleanup(); reject(new WeChatDatabaseError(response.error));
          }
        } catch { stop(new Error('本机微信读取组件返回了无效数据。')); }
      };
      child.stdout.on('data', onData);
      child.once('close', onClose);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else child.stdin.write(`${JSON.stringify({ id, command, args })}\n`, error => { if (error) stop(new Error('本机微信读取请求未送达。')); });
    });
  }
}
