import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EventInbox, WorkspaceWatcher, type InboxEvent } from './events.js';

export interface WorkspaceSourceConfig { sourceId: string; root: string; caseId: string; include?: string[] }
export type SourceState = 'starting' | 'active' | 'failed' | 'removed';
interface SourceConnection extends WorkspaceSourceConfig {
  generation: string; connectionId: string; status: SourceState; health: string | null;
  createdAt: string; updatedAt: string; removedAt?: string;
}
export interface SourceStatus extends SourceConnection { watching: boolean; observationRoots: readonly string[] }
export interface LegacySourceState {
  sources?: WorkspaceSourceConfig[]; sourceRoutes?: Record<string, string>; eventCases?: Record<string, string>; disabledSources?: string[];
}
export interface SourceRegistryOptions {
  onEvents?: () => void;
  mutateCase?: (caseId: string, change: () => Promise<void>, sourceId?: string) => Promise<unknown>;
  resolveConnectorCase?: (event: InboxEvent) => string | undefined;
  resolveTaskOutcomeCase?: (event: InboxEvent) => string | undefined;
}
const SourceSchema = z.object({ sourceId: z.string().trim().min(1).max(200), root: z.string().min(1).max(4000).refine(isAbsolute, 'Source root must be absolute'),
  caseId: z.string().trim().min(1).max(200), include: z.array(z.string().min(1).max(500)).max(50).optional() }).strict();
const now = (): string => new Date().toISOString();
const databaseError = (error: unknown): boolean => /^ERR_SQLITE|^SQLITE/.test(String((error as { code?: unknown })?.code ?? ''));
class SourceStartError extends Error { constructor(readonly sourceId: string, cause: unknown) { super(`Source ${sourceId} could not be started`, { cause }); } }

/** Owns connection identity and its migration in the same persistent database as the inbox. */
class SourceRepository {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if (file === ':memory:') throw new Error('SourceRegistry requires a persistent inbox database');
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS source_connections (connection_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, generation TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_current (source_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_registry_state (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  }
  private decode(row: { json?: unknown } | undefined): SourceConnection | undefined { return row ? JSON.parse(String(row.json)) as SourceConnection : undefined; }
  get(sourceId: string): SourceConnection | undefined {
    return this.decode(this.db.prepare('SELECT c.json FROM source_current s JOIN source_connections c ON c.connection_id=s.connection_id WHERE s.source_id=?').get(sourceId));
  }
  byGeneration(generation: string): SourceConnection | undefined { return this.decode(this.db.prepare('SELECT json FROM source_connections WHERE generation=?').get(generation)); }
  list(): SourceConnection[] {
    return this.db.prepare('SELECT c.json FROM source_current s JOIN source_connections c ON c.connection_id=s.connection_id ORDER BY s.rowid').all()
      .map(row => this.decode(row)!);
  }
  create(config: WorkspaceSourceConfig, status: SourceState = 'starting', current = true): SourceConnection {
    const id = randomUUID(); const date = now();
    const connection: SourceConnection = { ...config, generation: id, connectionId: id, status, health: null, createdAt: date, updatedAt: date,
      ...(status === 'removed' ? { removedAt: date } : {}) };
    this.db.prepare('INSERT INTO source_connections(connection_id,source_id,generation,json) VALUES(?,?,?,?)').run(id, config.sourceId, id, JSON.stringify(connection));
    if (current) this.db.prepare('INSERT INTO source_current(source_id,connection_id) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET connection_id=excluded.connection_id').run(config.sourceId, id);
    return connection;
  }
  state(connection: SourceConnection, status: SourceState, health: string | null = null): SourceConnection {
    const value: SourceConnection = { ...connection, status, health, updatedAt: now(), ...(status === 'removed' ? { removedAt: now() } : {}) };
    this.db.prepare('UPDATE source_connections SET json=? WHERE connection_id=?').run(JSON.stringify(value), connection.connectionId);
    return value;
  }
  migrateOnce(legacy: LegacySourceState): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare("SELECT 1 FROM source_registry_state WHERE key='legacy-migration-v1'").get()) { this.db.exec('COMMIT'); return; }
      const disabled = new Set(legacy.disabledSources ?? []);
      const configurations = new Map<string, WorkspaceSourceConfig>();
      for (const source of legacy.sources ?? []) {
        const config = SourceSchema.parse(source); configurations.set(config.sourceId, { ...config, root: resolve(config.root) });
      }
      for (const config of configurations.values()) if (!this.get(config.sourceId)) this.create(config, disabled.has(config.sourceId) ? 'removed' : 'starting');
      const retired = new Map<string, SourceConnection>();
      const rows = this.db.prepare("SELECT id,json FROM events WHERE json_extract(json,'$.kind')='workspace.file' AND source_generation='' ORDER BY rowid").all();
      for (const row of rows) {
        const event = JSON.parse(String(row.json)) as InboxEvent;
        // Mutable sourceRoutes are deliberately NOT evidence of an old event's owner.
        const owner = event.caseId || legacy.eventCases?.[event.id];
        const group = JSON.stringify([event.sourceId, owner ?? null]);
        let connection = retired.get(group);
        if (!connection) {
          connection = this.create({ sourceId: event.sourceId, root: configurations.get(event.sourceId)?.root ?? '', caseId: owner ?? '' }, 'removed', false);
          connection = this.state(connection, 'removed', owner ? 'Historical connection retained for its original case only' : 'Legacy event ownership is unproven; event quarantined');
          retired.set(group, connection);
        }
        const migrated = { ...event, sourceGeneration: connection.generation, ...(owner ? { caseId: owner } : {}) };
        this.db.prepare(`UPDATE events SET json=?,source_generation=?,status=CASE WHEN status='leased' THEN 'pending' ELSE status END,
          lease_until=NULL,lease_token=NULL,last_error=COALESCE(last_error,?) WHERE id=?`)
          .run(JSON.stringify(migrated), connection.generation, owner ? 'Historical source generation is retired' : 'Legacy source event quarantined: original case cannot be proven', event.id);
      }
      this.db.prepare('INSERT INTO source_registry_state(key,json) VALUES(?,?)').run('legacy-migration-v1', JSON.stringify({ completedAt: now(), retiredEvents: rows.length }));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

/** Connection lifecycle, watcher ownership and immutable event provenance live here, not in caller metadata. */
export class SourceRegistry {
  private readonly repository: SourceRepository;
  private readonly watchers = new Map<string, WorkspaceWatcher>();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private closeOperation?: Promise<void>;
  constructor(private readonly inbox: EventInbox, private readonly options: SourceRegistryOptions = {}) { this.repository = new SourceRepository(inbox.file); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.closeOperation) return Promise.reject(new Error('SourceRegistry is closed'));
    const result = this.lifecycle.catch(() => undefined).then(work);
    this.lifecycle = result.catch(() => undefined); return result;
  }
  init(legacy: LegacySourceState = {}): Promise<void> {
    if (this.initialization) return this.initialization;
    if (this.initialized) return Promise.resolve();
    this.initialization = this.serialize(async () => {
      this.repository.migrateOnce(legacy); this.initialized = true;
      const failures: SourceStartError[] = [];
      for (const record of this.repository.list()) if (record.status !== 'removed') {
        try { await this.start(record); }
        catch (error) { if (error instanceof SourceStartError) failures.push(error); else throw error; }
      }
      if (failures.length) throw new AggregateError(failures, 'Some sources could not be restored; failed configurations remain visible');
    }).finally(() => { this.initialization = undefined; });
    return this.initialization;
  }
  private config(record: WorkspaceSourceConfig): WorkspaceSourceConfig {
    return { sourceId: record.sourceId, root: record.root, caseId: record.caseId, ...(record.include ? { include: [...record.include] } : {}) };
  }
  private view(record: SourceConnection): SourceStatus {
    const watcher = this.watchers.get(record.connectionId);
    return { ...record, health: watcher?.lastError ?? record.health, watching: Boolean(watcher) && record.status === 'active', observationRoots: watcher?.observationRoots ?? [] };
  }
  get(sourceId: string): SourceStatus | undefined { const record = this.repository.get(sourceId); return record ? this.view(record) : undefined; }
  list(): SourceStatus[] { return this.repository.list().filter(record => record.status !== 'removed').map(record => this.view(record)); }
  private async start(record: SourceConnection): Promise<void> {
    if (this.watchers.has(record.connectionId)) return;
    let watcher: WorkspaceWatcher | undefined;
    try {
      watcher = new WorkspaceWatcher(this.inbox, { ...this.config(record), sourceGeneration: record.generation, onEvents: this.options.onEvents });
      this.repository.state(record, 'starting');
      await watcher.start(); this.watchers.set(record.connectionId, watcher); this.repository.state(record, 'active'); this.options.onEvents?.();
    } catch (error) {
      await watcher?.stop(); this.watchers.delete(record.connectionId);
      if (databaseError(error)) throw error;
      this.repository.state(record, 'failed', error instanceof Error ? error.message : 'Source startup failed');
      throw new SourceStartError(record.sourceId, error);
    }
  }
  async register(input: WorkspaceSourceConfig): Promise<SourceStatus> {
    if (!this.initialized) await this.init();
    const parsed = SourceSchema.parse(input); const config = { ...parsed, root: resolve(parsed.root) };
    // Validate glob shape before retiring an otherwise healthy connection.
    new WorkspaceWatcher(this.inbox, config);
    return this.serialize(async () => {
      const previous = this.repository.get(config.sourceId);
      if (previous && previous.status !== 'removed' && isDeepStrictEqual(this.config(previous), config)) {
        await this.start(previous); return this.get(config.sourceId)!;
      }
      const replace = async (): Promise<void> => {
        if (previous && previous.status !== 'removed') {
          this.repository.state(previous, 'removed');
          await this.watchers.get(previous.connectionId)?.stop(); this.watchers.delete(previous.connectionId);
        }
      };
      if (previous && previous.status !== 'removed' && this.options.mutateCase) await this.options.mutateCase(previous.caseId, replace, previous.sourceId); else await replace();
      const record = this.repository.create(config);
      await this.start(record); return this.get(config.sourceId)!;
    });
  }
  async remove(sourceId: string): Promise<void> {
    if (!this.initialized) await this.init();
    return this.serialize(async () => {
      const record = this.repository.get(sourceId); if (!record || record.status === 'removed') return;
      const remove = async (): Promise<void> => {
        this.repository.state(record, 'removed'); await this.watchers.get(record.connectionId)?.stop(); this.watchers.delete(record.connectionId);
      };
      if (this.options.mutateCase) await this.options.mutateCase(record.caseId, remove, record.sourceId); else await remove();
    });
  }
  resolveEventCase(event: InboxEvent): string | undefined {
    if (event.kind === 'task.outcome') return this.options.resolveTaskOutcomeCase?.(event);
    if (['connector.change', 'connector.document_snapshot', 'connector.mail_query', 'connector.mail_read', 'connector.mail_context', 'connector.github_read', 'connector.document_read'].includes(event.kind) || event.kind === 'growth.observation' && event.sourceId.startsWith('connector:')) {
      return this.options.resolveConnectorCase?.(event);
    }
    if (event.sourceGeneration) {
      const record = this.repository.byGeneration(event.sourceGeneration);
      return record && record.sourceId === event.sourceId && record.caseId && event.caseId === record.caseId ? record.caseId : undefined;
    }
    return event.kind === 'workspace.file' ? undefined : event.caseId;
  }
  isEventAllowed(event: InboxEvent): boolean {
    if (event.kind === 'task.outcome') return Boolean(this.options.resolveTaskOutcomeCase?.(event));
    if (['connector.change', 'connector.document_snapshot', 'connector.mail_query', 'connector.mail_read', 'connector.mail_context', 'connector.github_read', 'connector.document_read'].includes(event.kind) || event.kind === 'growth.observation' && event.sourceId.startsWith('connector:')) {
      return Boolean(this.options.resolveConnectorCase?.(event));
    }
    if (event.kind !== 'workspace.file' && !event.sourceGeneration) return true;
    if (!event.sourceGeneration) return false;
    const current = this.repository.get(event.sourceId);
    return Boolean(current && current.status === 'active' && current.generation === event.sourceGeneration && current.caseId === event.caseId);
  }
  async reconcile(): Promise<void> {
    if (!this.initialized) await this.init();
    return this.serialize(async () => {
      const failures: SourceStartError[] = [];
      for (const record of this.repository.list()) if (record.status !== 'removed') {
        const watcher = this.watchers.get(record.connectionId);
        if (!watcher) {
          try { await this.start(record); } catch (error) { if (error instanceof SourceStartError) failures.push(error); else throw error; }
        } else {
          try { await watcher.reconcile(); this.repository.state(record, 'active'); }
          catch (error) {
            if (databaseError(error)) throw error;
            this.repository.state(record, 'active', watcher.lastError ?? 'Source reconciliation failed');
            failures.push(new SourceStartError(record.sourceId, error));
          }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Some sources remain unavailable; snapshots retained');
    });
  }
  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    // Fence admission synchronously, then drain the exact accepted lifecycle tail.
    // Concurrent callers must not race watcher cleanup or close SQLite twice.
    const accepted = this.lifecycle;
    this.closeOperation = (async () => {
      await accepted;
      const results = await Promise.allSettled([...this.watchers.values()].map(watcher => watcher.stop()));
      this.watchers.clear(); this.repository.close();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Source watchers did not close cleanly');
    })();
    return this.closeOperation;
  }
}
