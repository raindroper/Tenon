import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { weChatObservationBatch } from '../shared/wechat-observation.js';
import { atomicJson } from './journal.js';

const cursor = z.string().min(1).max(16 * 1024);
const progressSchema = z.object({
  cursor, coverageStartAt: z.string().datetime(),
  title: z.string().min(1).max(200).optional(),
  coverageNote: z.string().max(300).optional(),
  pending: z.object({ cursor, rows: weChatObservationBatch.shape.rows }).strict().optional(),
  receivedRows: z.number().int().nonnegative(), lastReceivedAt: z.string().datetime().optional(),
  recent: weChatObservationBatch.shape.rows,
}).strict();
export type WeChatProgress = z.infer<typeof progressSchema>;
export interface WeChatProgressStorage {
  load(id: string, binding: string): Promise<WeChatProgress | undefined>;
  save(id: string, binding: string, value: WeChatProgress): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The whole record, including cursors and pending message text, is encrypted by Windows safeStorage. */
export class WeChatProgressJournal implements WeChatProgressStorage {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: () => string,
    private readonly encrypt: (value: string) => string, private readonly decrypt: (value: string) => string) {}

  private file(id: string): string {
    return path.join(this.directory(), createHash('sha256').update(id).digest('hex') + '.json');
  }
  async load(id: string, binding: string): Promise<WeChatProgress | undefined> {
    await this.writes;
    try {
      const envelope = z.object({ encrypted: z.string().max(512 * 1024) }).strict().parse(JSON.parse(await readFile(this.file(id), 'utf8')));
      const record = z.object({ binding: z.string(), progress: progressSchema }).strict().parse(JSON.parse(this.decrypt(envelope.encrypted)));
      if (record.binding !== binding) throw new Error('微信观察范围与已保存断点不一致，请核对账号和场景。');
      return record.progress;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('无法读取加密的微信采集断点。请核对本机账号，或明确选择从现在重新开始。');
    }
  }
  save(id: string, binding: string, value: WeChatProgress): Promise<void> {
    const snapshot = progressSchema.parse(value);
    const work = this.writes.then(() => atomicJson(this.file(id), { encrypted: this.encrypt(JSON.stringify({ binding, progress: snapshot })) }));
    this.writes = work.catch(() => {});
    return work;
  }
  remove(id: string): Promise<void> {
    const work = this.writes.then(() => unlink(this.file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }));
    this.writes = work.catch(() => {});
    return work;
  }
}
