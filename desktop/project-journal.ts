import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectEvent, ProjectExecutionInput } from '../shared/local-project.js';
import { atomicJson } from './journal.js';
import type { ProjectDelivery } from '../shared/project-contract.js';

export interface LocalProjectEntry {
  input: ProjectExecutionInput;
  delivery?: ProjectDelivery;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  sequence: number;
  acknowledged: number;
  threadId?: string;
  turnId?: string;
  appliedRevision: number;
  realPath?: string;
  identity?: string;
  output: string;
  error?: string;
  environment?: 'active' | 'closed' | 'unknown';
  processId?: number;
  checkpoint?: string;
  checkpointConflict?: { fingerprint: string; dependencyId: string };
  workspaceArchive?: { id: string; hash: string; identity: string; requirementsRevision: number };
  finalFilesSnapshot?: { fingerprint: string; requirementsRevision: number };
}

/** An outbox supplements the engine's native history and never recreates task consent. */
export class ProjectJournal {
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string) {}
  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.writes.set(id, operation);
    void operation.finally(() => { if (this.writes.get(id) === operation) this.writes.delete(id); }).catch(() => {});
    return operation;
  }

  directory(id: string): string {
    return path.join(this.root, createHash('sha256').update(id).digest('hex'));
  }

  async get(id: string): Promise<LocalProjectEntry | undefined> {
    try { return JSON.parse(await readFile(path.join(this.directory(id), 'operation.json'), 'utf8')) as LocalProjectEntry; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async save(entry: LocalProjectEntry): Promise<void> {
    await this.serialize(entry.input.operationId, () => this.write(entry));
  }
  private write(entry: LocalProjectEntry): Promise<void> { return atomicJson(path.join(this.directory(entry.input.operationId), 'operation.json'), entry); }

  async list(): Promise<LocalProjectEntry[]> {
    await mkdir(this.root, { recursive: true });
    const entries: LocalProjectEntry[] = [];
    for (const directory of await readdir(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[a-f0-9]{64}$/.test(directory.name)) continue;
      const file = path.join(this.root, directory.name, 'operation.json');
      try { entries.push(JSON.parse(await readFile(file, 'utf8')) as LocalProjectEntry); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return entries;
  }

  async pending(entry: LocalProjectEntry): Promise<ProjectEvent[]> {
    const directory = path.join(this.directory(entry.input.operationId), 'outbox');
    await mkdir(directory, { recursive: true });
    const files = (await readdir(directory)).filter(name => /^\d{12}\.json$/.test(name)).sort();
    const events: ProjectEvent[] = [];
    for (const file of files) {
      const event = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as ProjectEvent;
      entry.sequence = Math.max(entry.sequence, event.sequence);
      if (event.sequence > entry.acknowledged) events.push(event);
    }
    return events;
  }

  async append(entry: LocalProjectEntry, event: ProjectEvent['event'], requirementsRevision = entry.input.requirementsRevision): Promise<ProjectEvent> {
    return this.serialize(entry.input.operationId, async () => {
    const value: ProjectEvent = { operationId: entry.input.operationId, sequence: entry.sequence + 1,
      requirementsRevision, at: new Date().toISOString(), event };
    const file = path.join(this.directory(entry.input.operationId), 'outbox', String(value.sequence).padStart(12, '0') + '.json');
    await atomicJson(file, value);
    entry.sequence = value.sequence;
    await this.write(entry);
    return value;
    });
  }

  async acknowledge(entry: LocalProjectEntry, sequence: number): Promise<void> {
    return this.serialize(entry.input.operationId, async () => {
    if (sequence <= entry.acknowledged) return;
    if (sequence > entry.sequence) throw new Error('项目回执序号超过本机日志。');
    const previous = entry.acknowledged;
    // Keep failed checkpoints eligible for an idempotent retry in this process.
    await this.write({ ...entry, acknowledged: sequence });
    entry.acknowledged = sequence;
    for (let value = previous + 1; value <= sequence; value++) {
      await unlink(path.join(this.directory(entry.input.operationId), 'outbox', String(value).padStart(12, '0') + '.json'))
        .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    });
  }
}
