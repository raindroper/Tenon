import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, open } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceExecuteMessage, DeviceOperationReceipt } from '../shared/local-device.js';
import { deviceDirectoryLookupSchema } from '../shared/local-device.js';

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}
export interface JournalEntry { message: DeviceExecuteMessage; receipt: DeviceOperationReceipt; delivered?: boolean; interruptedReceipt?: DeviceOperationReceipt }
export class OperationJournal {
  constructor(private readonly directory: string) {}
  private file(id: string): string { return path.join(this.directory, createHash('sha256').update(id).digest('hex') + '.json'); }
  async get(id: string): Promise<JournalEntry | undefined> {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')) as JournalEntry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async save(entry: JournalEntry): Promise<void> { await atomicJson(this.file(entry.message.operationId), entry); }
  async entries(): Promise<JournalEntry[]> {
    await mkdir(this.directory, { recursive: true });
    const entries: JournalEntry[] = [];
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const entry = JSON.parse(await readFile(path.join(this.directory, file), 'utf8')) as JournalEntry;
      entries.push(entry);
    }
    return entries;
  }
  async recover(): Promise<JournalEntry[]> {
    const entries = await this.entries();
    for (const entry of entries) {
      // A native directory read has no child process or external side effect.
      // Once its owning process has restarted, that read is over. Preserve the
      // interrupted fact; do not rerun it or treat arbitrary readOnly commands
      // as equivalent. Upgrade old unknown directory journals the same way.
      const readOnly = deviceDirectoryLookupSchema.safeParse(entry.message.spec).success;
      if (['dispatched', 'running', 'cancel_requested'].includes(entry.receipt.state) || readOnly && entry.receipt.state === 'unknown') {
        entry.interruptedReceipt ??= structuredClone(entry.receipt);
        entry.receipt = { operationId: entry.message.operationId,
          ...(entry.receipt.startedAt ? { startedAt: entry.receipt.startedAt } : {}),
          state: readOnly ? 'failed' : 'unknown', error: readOnly
            ? '上次只读查询因客户端进程中断而结束，没有完整结果；未重新执行，可重新确认一次查询。'
            : '本地进程曾中断，不能确认原操作结果；不会自动重做。', finishedAt: new Date().toISOString() };
        entry.delivered = false;
        await this.save(entry);
      }
    }
    return entries;
  }
}
