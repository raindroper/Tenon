import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { EWS_MAX_ATTACHMENT_BYTES, type EwsMailUpload } from '../../shared/ews.js';
import type { Store } from '../store.js';
import type { TaskRecord } from '../../shared/task-consent.js';
import { EWS_MAIL_OPERATION_PREFIX, type EwsMailOperation } from '../../shared/mail.js';
import { RuntimeInputError } from '../runtime.js';

const INDEX = 'connectors.ews.mail-attachments';
const TTL = 24 * 60 * 60_000;
const MAX_DISK = 256 * 1024 * 1024;
const MAX_FILES = 128;
export interface StoredMailAttachment extends EwsMailUpload {
  caseId: string; connectionId: string; credentialRevision: number; createdAt: string;
  taskIds: string[]; sourceProtected: boolean;
  removedAt?: string;
}
const fileName = z.string().trim().min(1).max(200).refine(value => !/[\\/\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..');
const contentType = z.string().max(150).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Immutable private files. Public IDs never encode or accept a filesystem path. */
export class MailAttachments {
  readonly root: string;
  constructor(private readonly store: Store, directory: string, private readonly tasks: () => readonly TaskRecord[] = () => []) {
    this.root = resolve(directory, 'mail-attachments');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) throw new Error('Mail attachment directory must be private and regular');
  }
  private records(): StoredMailAttachment[] { return this.store.getMeta<StoredMailAttachment[]>(INDEX, []); }
  private custody(item: StoredMailAttachment): { retained: boolean; touchedAt: number } {
    const tasks = this.tasks().filter(task => task.spec.caseId === item.caseId && task.spec.mail?.connectionId === item.connectionId
      && task.spec.mail.credentialRevision === item.credentialRevision && task.spec.mail.attachments.some(file => file.id === item.id && file.sha256 === item.sha256));
    const taskMap = new Map(tasks.map(task => [task.id, task])); const ids = new Set([...item.taskIds, ...taskMap.keys()]);
    let touchedAt = Date.parse(item.createdAt); let retained = false;
    for (const id of ids) {
      const task = taskMap.get(id); const operation = this.store.getMeta<EwsMailOperation | undefined>(EWS_MAIL_OPERATION_PREFIX + id, undefined);
      touchedAt = Math.max(touchedAt, Date.parse(task?.updatedAt ?? item.createdAt), Date.parse(operation?.updatedAt ?? item.createdAt));
      if (task && ['proposed', 'approved', 'running'].includes(task.state) || operation && ['submitting', 'unknown'].includes(operation.state)
        || operation?.state === 'prepared' && !task || !task && !operation) retained = true;
    }
    return { retained, touchedAt };
  }
  private path(id: string): string { return join(this.root, z.uuid().parse(id)); }
  private regular(id: string): string {
    const path = this.path(id); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > EWS_MAX_ATTACHMENT_BYTES) throw new RuntimeInputError(409, '附件文件已变化，请重新上传。');
    return path;
  }
  cleanup(): void {
    const records = this.records(); let changed = false;
    const keep: StoredMailAttachment[] = [];
    for (const item of records) {
      const custody = this.custody(item);
      if (item.removedAt || custody.retained || Date.now() - custody.touchedAt <= TTL) { keep.push(item); continue; }
      try { unlinkSync(this.regular(item.id)); } catch { keep.push(item); continue; }
      changed = true; keep.push({ ...item, removedAt: new Date().toISOString() });
    }
    if (changed) this.store.setMeta(INDEX, keep);
  }
  save(input: { name: string; contentType: string; bytes: Buffer; caseId: string; connectionId: string; credentialRevision: number; sourceProtected?: boolean }): EwsMailUpload {
    this.cleanup();
    const records = this.records(); const name = fileName.parse(input.name);
    const type = contentType.safeParse(input.contentType).success ? input.contentType : 'application/octet-stream';
    if (input.bytes.length > EWS_MAX_ATTACHMENT_BYTES) throw new RuntimeInputError(400, '每个附件最多 5 MiB。');
    const present = records.filter(item => !item.removedAt);
    if (present.length >= MAX_FILES || present.reduce((sum, item) => sum + item.size, 0) + input.bytes.length > MAX_DISK) throw new RuntimeInputError(409, '邮件附件暂存空间已满，请移除未提交的附件。');
    const id = randomUUID(); const path = this.path(id);
    const handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(handle, input.bytes); fsyncSync(handle); } catch (error) { closeSync(handle); unlinkSync(path); throw error; }
    closeSync(handle);
    const item: StoredMailAttachment = { id, name, contentType: type, size: input.bytes.length, sha256: digest(input.bytes),
      caseId: input.caseId, connectionId: input.connectionId, credentialRevision: input.credentialRevision,
      createdAt: new Date().toISOString(), taskIds: [], sourceProtected: input.sourceProtected === true };
    try { this.store.setMeta(INDEX, [...records, item]); } catch (error) { unlinkSync(path); throw error; }
    return this.public(item);
  }
  private public(item: StoredMailAttachment): EwsMailUpload {
    const { id, name, contentType, size, sha256 } = item; return { id, name, contentType, size, sha256 };
  }
  select(id: string, scope: { caseId: string; connectionId: string; credentialRevision: number }, sha256?: string): StoredMailAttachment & { path: string } {
    const item = this.records().find(item => item.id === id);
    const custody = item && this.custody(item);
    if (!item || item.removedAt || item.caseId !== scope.caseId || item.connectionId !== scope.connectionId || item.credentialRevision !== scope.credentialRevision
      || !custody!.retained && Date.now() - custody!.touchedAt > TTL || sha256 !== undefined && sha256 !== item.sha256) throw new RuntimeInputError(409, '附件不属于当前邮箱授权、已过期或内容版本不一致，请重新选择。');
    let path: string;
    try {
      path = this.regular(id);
      const handle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { const stat = fstatSync(handle); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== item.size || digest(readFileSync(handle)) !== item.sha256) throw new Error('changed'); }
      finally { closeSync(handle); }
    } catch { throw new RuntimeInputError(409, '附件文件已变化，请重新上传。'); }
    return { ...item, path };
  }
  pin(ids: readonly string[], taskId: string): void {
    const wanted = new Set(ids);
    const records = this.records().map(item => wanted.has(item.id) && !item.taskIds.includes(taskId) ? { ...item, taskIds: [...item.taskIds, taskId] } : item);
    this.store.setMeta(INDEX, records);
  }
  remove(id: string, scope: { caseId: string; connectionId: string; credentialRevision: number }): void {
    const item = this.select(id, scope);
    if (this.custody(item).retained) throw new RuntimeInputError(409, '附件已绑定未结束或结果未知的任务，保留原文件以供回执核对。');
    unlinkSync(item.path); this.store.setMeta(INDEX, this.records().map(record => record.id === id ? { ...record, removedAt: new Date().toISOString() } : record));
  }
}
