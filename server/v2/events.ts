import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import fastGlob from 'fast-glob';
import { z } from 'zod';
import type { RuntimeEventSummary, RuntimeHistoryPage } from '../../shared/runtime-view.js';
import type { ReviewAttentionItem, ReviewDecisionRecord, ReviewOutboxRecord } from './review-decisions.js';
import { modelBindingSchema, type ModelBinding } from '../../shared/model-connections.js';

export type EventStatus = 'pending' | 'leased' | 'processed' | 'failed';
export interface InboxEvent {
  id: string; sourceId: string; externalId: string; kind: string;
  operation: 'create' | 'update' | 'delete'; occurredAt: string; receivedAt: string;
  payloadRef?: string; payload: Record<string, unknown>;
  actor: 'owner' | 'external' | 'agent' | 'system'; causationId?: string; caseId?: string; version?: string;
  sourceGeneration?: string;
}
export type EventInput = Omit<InboxEvent, 'id' | 'receivedAt'> & Partial<Pick<InboxEvent, 'id' | 'receivedAt'>>;
export interface StoredEvent extends InboxEvent {
  /** Written only by the explicit owner retry command, never ingested from an external source. */
  modelRetries?: Array<{ at: string; previous: ModelBinding | null; binding: ModelBinding; reason: 'missing-connection' | 'repaired-credential' }>;
  status: EventStatus; attempts: number; leaseUntil: string | null; leaseToken: string | null; lastError: string | null;
  ownerStoppedRunId?: string;
}
export class EventRetryError extends Error {
  constructor(readonly code: 'not_found' | 'conflict', message: string) { super(message); }
}
export interface SourceCheckpoint { sourceId: string; value: unknown; sourceGeneration?: string }
interface EventRow { json: string; status: EventStatus; attempts: number; lease_until: number | null; lease_token: string | null; last_error: string | null }
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid event timestamp');
const EventSchema = z.object({
  id: z.string().min(1).max(300), sourceId: z.string().min(1).max(300), externalId: z.string().min(1).max(2000),
  kind: z.string().min(1).max(200), operation: z.enum(['create', 'update', 'delete']), occurredAt: timestamp, receivedAt: timestamp,
  payloadRef: z.string().max(4000).optional(), payload: z.record(z.string(), z.unknown()),
  actor: z.enum(['owner', 'external', 'agent', 'system']), causationId: z.string().max(300).optional(),
  caseId: z.string().max(300).optional(), version: z.string().min(1).max(2000).optional(),
  sourceGeneration: z.string().min(1).max(300).optional(),
}).strict();
const STATUSES: EventStatus[] = ['pending', 'leased', 'processed', 'failed'];
const MAX_SERIALIZED_BYTES = 1024 * 1024;
export const SOURCE_REVIEW_INTERVAL_MS = 5 * 60_000;
const connectorHistoryFilter = `(
  (json_extract(json,'$.kind')='connector.change' AND json_extract(json,'$.payload.provider')=?)
  OR (json_extract(json,'$.kind') IN ('connector.change','growth.observation')
    AND source_id=('connector:' || source_generation) AND source_generation IN (SELECT value FROM json_each(?)))
)`;
function wakeSummary(json: string): { id: string; at: string; reason: string; message?: string } {
  const value = JSON.parse(json) as { id: string; at: string; reason: string; message?: string };
  return { id: value.id, at: value.at, reason: value.reason.slice(0, 200), ...(value.message ? { message: value.message.slice(0, 300) } : {}) };
}

/** Thin SQLite repository: no timers, model calls, channels or user notifications. */
export class EventInbox {
  readonly file: string;
  private readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(file: string, options: { requireReviewQueueMarker?: boolean } = {}) {
    this.file = file === ':memory:' ? file : resolve(file);
    if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    if (options.requireReviewQueueMarker) {
      const checkpoints = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='source_checkpoints'").get();
      if (!checkpoints || !this.db.prepare("SELECT 1 FROM source_checkpoints WHERE source_id='source-review-queue-v1'").get()) {
        this.db.close(); throw new Error('当前内核缺少资料回顾队列迁移标记，请核对匹配的完整数据备份。');
      }
    }
    if (file !== ':memory:' && process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
        version TEXT NOT NULL, operation TEXT NOT NULL, json TEXT NOT NULL, source_generation TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','processed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, lease_token TEXT, last_error TEXT,
        UNIQUE(source_id,source_generation,external_id,version,operation)
      );
      CREATE INDEX IF NOT EXISTS events_delivery ON events(status,lease_until);
      CREATE INDEX IF NOT EXISTS events_connector_changes ON events(json_extract(json,'$.kind')) WHERE json_extract(json,'$.kind')='connector.change';
      CREATE TABLE IF NOT EXISTS growth_wakes (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('scheduled','fired','cancelled')));
      CREATE INDEX IF NOT EXISTS growth_wakes_due ON growth_wakes(state,at);
      CREATE TABLE IF NOT EXISTS source_checkpoints (source_id TEXT PRIMARY KEY, json TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS review_decisions (
        id TEXT PRIMARY KEY, review_event_id TEXT NOT NULL, case_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_decisions_case ON review_decisions(case_id);
      CREATE TABLE IF NOT EXISTS review_attention_items (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, conversation_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_attention_conversation ON review_attention_items(case_id,conversation_id);
      CREATE TABLE IF NOT EXISTS review_notification_outbox (
        decision_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL
          CHECK(state IN ('pending','delivered','invalidated','needs_reassessment')), json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_notification_pending ON review_notification_outbox(state);`);
    const reviewTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='review_decisions'").get();
    if (/review_event_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(String(reviewTable?.sql))) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE review_decisions RENAME TO review_decisions_before_revisions;
        CREATE TABLE review_decisions (id TEXT PRIMARY KEY,review_event_id TEXT NOT NULL,case_id TEXT NOT NULL,json TEXT NOT NULL);
        INSERT INTO review_decisions SELECT id,review_event_id,case_id,json FROM review_decisions_before_revisions ORDER BY rowid;
        DROP TABLE review_decisions_before_revisions;
        CREATE INDEX review_decisions_case ON review_decisions(case_id);
        COMMIT;`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS review_decisions_event ON review_decisions(review_event_id)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_review_items (
      event_id TEXT PRIMARY KEY, batch_id TEXT, retired INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS source_review_batch ON source_review_items(batch_id,retired);
      CREATE TABLE IF NOT EXISTS source_review_sources (
        source_id TEXT NOT NULL, generation TEXT NOT NULL, case_id TEXT NOT NULL,
        interval_ms INTEGER NOT NULL, next_at INTEGER NOT NULL, drain_until INTEGER NOT NULL DEFAULT 0,
        last_dispatched INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source_id,generation,case_id));`);
    if (!this.db.prepare('PRAGMA table_info(events)').all().some(column => column.name === 'source_generation')) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE events RENAME TO events_before_generation;
        CREATE TABLE events (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, version TEXT NOT NULL,
          operation TEXT NOT NULL, json TEXT NOT NULL, source_generation TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','processed','failed')),
          attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, lease_token TEXT, last_error TEXT,
          UNIQUE(source_id,source_generation,external_id,version,operation));
        INSERT INTO events SELECT id,source_id,external_id,version,operation,json,
          COALESCE(json_extract(json,'$.sourceGeneration'),''),status,attempts,lease_until,lease_token,last_error
          FROM events_before_generation ORDER BY rowid;
        DROP TABLE events_before_generation;
        CREATE INDEX events_delivery ON events(status,lease_until);
        COMMIT;`);
    }
    if (!this.db.prepare('PRAGMA table_info(events)').all().some(column => column.name === 'retry_at')) {
      this.db.exec('ALTER TABLE events ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_source_generation_case ON events(source_generation,json_extract(json,'$.caseId'))`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_case_history ON events(json_extract(json,'$.caseId'));
      CREATE INDEX IF NOT EXISTS events_owner_message ON events(external_id) WHERE source_id='owner-chat' AND json_extract(json,'$.kind')='owner.message'`);
    this.migrateSourceReviews();
  }
  private migrateSourceReviews(): void {
    if (this.getCheckpoint('source-review-queue-v1')) return;
    this.atomic(() => {
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
      if (tables.has('wechat_analysis_items')) {
        this.db.exec('INSERT OR IGNORE INTO source_review_items(event_id,batch_id) SELECT event_id,batch_id FROM wechat_analysis_items');
      }
      if (tables.has('wechat_analysis_sources')) {
        const drain = this.db.prepare('PRAGMA table_info(wechat_analysis_sources)').all().some(row => row.name === 'drain_until') ? 'drain_until' : '0';
        this.db.exec(`INSERT OR IGNORE INTO source_review_sources(source_id,generation,case_id,interval_ms,next_at,drain_until)
          SELECT source_id,generation,case_id,interval_ms,next_at,${drain} FROM wechat_analysis_sources`);
      }
      if (!this.getCheckpoint('wechat-analysis-migration-v1')) {
        this.db.exec(`INSERT OR IGNORE INTO source_review_items(event_id)
          SELECT id FROM events WHERE json_extract(json,'$.kind')='connector.change'
            AND json_extract(json,'$.payload.provider')='wechat-desktop';
          INSERT OR IGNORE INTO source_review_sources(source_id,generation,case_id,interval_ms,next_at)
          SELECT source_id,source_generation,json_extract(json,'$.caseId'),600000,0 FROM events
          WHERE json_extract(json,'$.kind')='connector.change' AND json_extract(json,'$.payload.provider')='wechat-desktop'
            AND json_extract(json,'$.caseId') IS NOT NULL GROUP BY source_id,source_generation,json_extract(json,'$.caseId');`);
      }
      const summaries = tables.has('growth_observations') ? this.db.prepare('SELECT * FROM growth_observations').all() : [];
      const attention = tables.has('growth_attention') ? this.db.prepare('SELECT * FROM growth_attention').all() : [];
      for (const row of summaries) {
        const summary = JSON.parse(String(row.json)) as { firstAt: string; lastAt: string; eventIds: string[] };
        this.db.prepare(`INSERT OR IGNORE INTO source_review_items(event_id)
          SELECT id FROM events WHERE source_id=? AND source_generation=? AND json_extract(json,'$.caseId')=?
            AND json_extract(json,'$.kind') IN ('connector.change','workspace.file','owner.source')
            AND json_extract(json,'$.receivedAt')>=? AND json_extract(json,'$.receivedAt')<=?`)
          .run(String(row.source_id), String(row.generation), String(row.case_id), summary.firstAt, summary.lastAt);
        this.db.prepare(`INSERT OR IGNORE INTO source_review_sources(source_id,generation,case_id,interval_ms,next_at)
          VALUES(?,?,?,?,?)`).run(String(row.source_id), String(row.generation), String(row.case_id), SOURCE_REVIEW_INTERVAL_MS,
          Math.min(Date.now(), Date.parse(summary.firstAt) + SOURCE_REVIEW_INTERVAL_MS));
      }
      // Old batch membership is authoritative, including failed and cancelled work.
      this.db.exec(`INSERT OR IGNORE INTO source_review_items(event_id,batch_id)
        SELECT original.id,review.id FROM events review,json_each(review.json,'$.payload.eventIds') member
        JOIN events original ON original.id=member.value
        WHERE json_extract(review.json,'$.kind')='growth.observation' ORDER BY review.rowid DESC;
        UPDATE source_review_items SET batch_id=(
          SELECT review.id FROM events review,json_each(review.json,'$.payload.eventIds') member
          WHERE json_extract(review.json,'$.kind')='growth.observation' AND member.value=event_id
          ORDER BY review.rowid DESC LIMIT 1) WHERE batch_id IS NULL;`);
      this.db.prepare('INSERT INTO source_checkpoints(source_id,json) VALUES(?,?)').run('source-review-queue-v1',
        JSON.stringify({ completedAt: new Date().toISOString(), legacyPendingSummaries: summaries, legacyAttention: attention }));
      this.db.exec('DROP TABLE IF EXISTS growth_observations; DROP TABLE IF EXISTS growth_attention; DROP TABLE IF EXISTS wechat_analysis_items; DROP TABLE IF EXISTS wechat_analysis_sources');
    });
  }
  private atomic<T>(work: () => T): T {
    if (this.inTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  private decode(row: EventRow): StoredEvent {
    return { ...JSON.parse(row.json) as InboxEvent & Pick<StoredEvent, 'ownerStoppedRunId'>, status: row.status, attempts: row.attempts,
      leaseUntil: row.lease_until === null ? null : new Date(row.lease_until).toISOString(),
      leaseToken: row.lease_token, lastError: row.last_error };
  }
  ingest(input: EventInput): { event: StoredEvent; duplicate: boolean } {
    const event = EventSchema.parse({ ...input, id: input.id ?? randomUUID(), receivedAt: input.receivedAt ?? new Date().toISOString() });
    const json = JSON.stringify(event);
    if (Buffer.byteLength(json) > MAX_SERIALIZED_BYTES) throw new Error('Event payload is too large');
    return this.atomic(() => {
      const existing = this.db.prepare('SELECT * FROM events WHERE source_id=? AND source_generation=? AND external_id=? AND version=? AND operation=?')
        .get(event.sourceId, event.sourceGeneration ?? '', event.externalId, event.version ?? '', event.operation) as unknown as EventRow | undefined;
      if (existing) return { event: this.decode(existing), duplicate: true };
      this.db.prepare('INSERT INTO events(id,source_id,source_generation,external_id,version,operation,json) VALUES(?,?,?,?,?,?,?)')
        .run(event.id, event.sourceId, event.sourceGeneration ?? '', event.externalId, event.version ?? '', event.operation, json);
      return { event: { ...event, status: 'pending', attempts: 0, leaseUntil: null, leaseToken: null, lastError: null }, duplicate: false };
    });
  }
  ingestBatch(events: EventInput[], checkpoint: SourceCheckpoint): { events: StoredEvent[]; duplicates: number };
  ingestBatch(sourceId: string, events: EventInput[], nextCheckpoint: unknown): { events: StoredEvent[]; duplicates: number };
  ingestBatch(first: EventInput[] | string, second: SourceCheckpoint | EventInput[], third?: unknown): { events: StoredEvent[]; duplicates: number } {
    const events = typeof first === 'string' ? second as EventInput[] : first;
    const checkpoint: SourceCheckpoint = typeof first === 'string' ? { sourceId: first, value: third } : second as SourceCheckpoint;
    if (!checkpoint.sourceId || checkpoint.sourceId.length > 300 || events.some(event => event.sourceId !== checkpoint.sourceId || event.sourceGeneration !== checkpoint.sourceGeneration)) {
      throw new Error('A checkpoint batch must belong to one source');
    }
    const json = JSON.stringify(checkpoint.value);
    if (json === undefined || Buffer.byteLength(json) > 8 * MAX_SERIALIZED_BYTES) throw new Error('Invalid checkpoint');
    return this.atomic(() => {
      const results = events.map(event => this.ingest(event));
      this.db.prepare('INSERT INTO source_checkpoints(source_id,json) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET json=excluded.json')
        .run(this.checkpointKey(checkpoint.sourceId, checkpoint.sourceGeneration), json);
      return { events: results.map(result => result.event), duplicates: results.filter(result => result.duplicate).length };
    });
  }
  private checkpointKey(sourceId: string, generation?: string): string { return generation ? JSON.stringify([sourceId, generation]) : sourceId; }
  getCheckpoint<T = unknown>(sourceId: string, fallback: T | null = null, generation?: string): T | null {
    const row = this.db.prepare('SELECT json FROM source_checkpoints WHERE source_id=?').get(this.checkpointKey(sourceId, generation));
    return row ? JSON.parse(String(row.json)) as T : structuredClone(fallback);
  }
  get(id: string): StoredEvent | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as unknown as EventRow | undefined;
    return row ? this.decode(row) : undefined;
  }
  changesAfter(sourceId: string, since: string, cursor: number, limit: number): { through: number; events: Array<{ cursor: number; event: StoredEvent }> } {
    const latest = Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS value FROM events WHERE source_id=? AND json_extract(json,'$.kind')='connector.change'").get(sourceId)?.value ?? 0);
    if (latest <= cursor) return { through: cursor, events: [] };
    const events = this.db.prepare("SELECT rowid AS cursor,* FROM events WHERE source_id=? AND rowid>? AND rowid<=? AND json_extract(json,'$.kind')='connector.change' AND julianday(json_extract(json,'$.receivedAt'))>=julianday(?) ORDER BY rowid LIMIT ?")
      .all(sourceId, cursor, latest, since, limit).map(row => ({ cursor: Number(row.cursor), event: this.decode(row as unknown as EventRow) }));
    return { through: events.length === limit ? events.at(-1)!.cursor : latest, events };
  }
  documentVersion(sourceId: string, generation: string, version: string): StoredEvent | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE source_id=? AND source_generation=? AND version=? AND json_extract(json,'$.kind') IN ('connector.change','connector.document_snapshot') ORDER BY rowid DESC LIMIT 1")
      .get(sourceId, generation, version) as unknown as EventRow | undefined;
    return row ? this.decode(row) : undefined;
  }
  /** Explicit owner recovery reopens the original message, never fabricates new provenance or effects. */
  retryFailedOwnerMessage(id: string, modelRetry?: Omit<NonNullable<StoredEvent['modelRetries']>[number], 'at'>): StoredEvent {
    return this.atomic(() => {
      const event = this.get(id);
      if (!event) throw new EventRetryError('not_found', '原消息事件不存在。');
      if (event.actor !== 'owner' || event.kind !== 'owner.message') throw new EventRetryError('conflict', '只能重新处理本人发送的消息。');
      if (event.status !== 'failed') throw new EventRetryError('conflict', '这条消息没有处于失败状态，无需重复处理。');
      if (modelRetry) {
        const binding = modelBindingSchema.parse(modelRetry.binding);
        const previous = modelRetry.previous === null ? null : modelBindingSchema.parse(modelRetry.previous);
        const reason = z.enum(['missing-connection', 'repaired-credential']).parse(modelRetry.reason);
        const history = [...event.modelRetries ?? [], { previous, binding, reason, at: new Date().toISOString() }];
        this.db.prepare("UPDATE events SET json=json_set(json,'$.modelRetries',json(?)) WHERE id=?").run(JSON.stringify(history), id);
      }
      this.db.prepare("UPDATE events SET status='pending',lease_until=NULL,lease_token=NULL,last_error=NULL,json=json_remove(json,'$.ownerStoppedRunId') WHERE id=? AND status='failed'").run(id);
      return this.get(id)!;
    });
  }
  /** Read-only tool observations are evidence, not work waiting for another model turn. */
  ingestProcessed(input: EventInput): StoredEvent {
    return this.atomic(() => {
      const { event } = this.ingest(input);
      this.consumeLocal([event.kind], item => item.id === event.id);
      return this.get(event.id)!;
    });
  }
  /** Acknowledge collection and retain every event's review membership in one transaction. */
  captureObservations(eligible: (event: StoredEvent) => boolean, timestamp = Date.now()): number {
    return this.atomic(() => {
      let count = 0;
      const rows = this.db.prepare(`SELECT * FROM events WHERE (status='pending' OR (status='leased' AND lease_until<=?))
        AND json_extract(json,'$.kind') IN ('workspace.file','owner.source','connector.change') ORDER BY rowid`).iterate(timestamp);
      for (const row of rows) {
        const event = this.decode(row as unknown as EventRow); if (!event.caseId || !eligible(event)) continue;
        const generation = event.sourceGeneration ?? '';
        const pending = this.db.prepare(`SELECT 1 FROM source_review_items q JOIN events e ON e.id=q.event_id
          WHERE e.source_id=? AND e.source_generation=? AND json_extract(e.json,'$.caseId')=?
            AND q.batch_id IS NULL AND q.retired=0 LIMIT 1`).get(event.sourceId, generation, event.caseId);
        const interval = event.payload.provider === 'wechat-desktop' ? 600000 : SOURCE_REVIEW_INTERVAL_MS;
        this.db.prepare(`INSERT OR IGNORE INTO source_review_sources(source_id,generation,case_id,interval_ms,next_at)
          VALUES(?,?,?,?,?)`).run(event.sourceId, generation, event.caseId, interval, timestamp + interval);
        const inserted = this.db.prepare('INSERT OR IGNORE INTO source_review_items(event_id) VALUES(?)').run(event.id);
        if (!pending && inserted.changes) this.db.prepare(`UPDATE source_review_sources SET next_at=?+interval_ms,drain_until=0
          WHERE source_id=? AND generation=? AND case_id=?`).run(timestamp, event.sourceId, generation, event.caseId);
        this.db.prepare("UPDATE events SET status='processed',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=?").run(event.id); count++;
        if (count >= 1000) break;
      }
      return count;
    });
  }
  nextObservationAt(): string | null {
    const next = this.db.prepare(`SELECT MIN(s.next_at) AS next_at FROM source_review_sources s
      JOIN events e ON e.source_id=s.source_id AND e.source_generation=s.generation AND json_extract(e.json,'$.caseId')=s.case_id
      JOIN source_review_items q ON q.event_id=e.id WHERE q.batch_id IS NULL AND q.retired=0`).get()?.next_at;
    return typeof next === 'number' ? new Date(next).toISOString() : null;
  }
  setObservationInterval(sourceId: string, generation: string, caseId: string, minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Invalid analysis interval');
    const interval = minutes * 60000;
    this.db.prepare(`INSERT INTO source_review_sources(source_id,generation,case_id,interval_ms,next_at) VALUES(?,?,?,?,?)
      ON CONFLICT(source_id,generation,case_id) DO UPDATE SET interval_ms=excluded.interval_ms,
        next_at=MIN(source_review_sources.next_at,excluded.next_at)`).run(sourceId, generation, caseId, interval, Date.now() + interval);
  }
  retireObservationSources(generations: readonly string[]): void {
    this.atomic(() => {
      this.db.prepare('DELETE FROM source_review_sources WHERE generation IN (SELECT value FROM json_each(?))').run(JSON.stringify(generations));
      this.db.prepare(`UPDATE source_review_items SET retired=1 WHERE batch_id IS NULL AND event_id IN
        (SELECT id FROM events WHERE source_generation IN (SELECT value FROM json_each(?)))`).run(JSON.stringify(generations));
    });
  }
  observationStats(generations: string[]) {
    const rows = this.db.prepare(`SELECT review.status,COUNT(*) AS count,MAX(json_extract(review.json,'$.payload.analysisCompletedAt')) AS completed
      FROM events e JOIN source_review_items q ON q.event_id=e.id LEFT JOIN events review ON review.id=q.batch_id
      WHERE q.retired=0 AND e.source_generation IN (SELECT value FROM json_each(?)) GROUP BY review.status`).all(JSON.stringify(generations));
    const count = (status: string | null) => Number(rows.find(row => row.status === status)?.count ?? 0);
    const completed = rows.find(row => row.status === 'processed')?.completed;
    return { pendingCount: count(null), processingCount: count('pending') + count('leased'), failedCount: count('failed'),
      analyzedCount: count('processed'), lastAnalyzedAt: typeof completed === 'string' ? completed : null };
  }
  /** Durable, bounded pages; the batch event's terminal status is the analysis receipt. */
  releaseObservation(eligible: (event: InboxEvent) => boolean, timestamp = Date.now(), manual = false,
    scope?: { caseId: string; sourceGenerations: string[] }): StoredEvent | undefined {
    return this.atomic(() => {
      const sources = this.db.prepare(`SELECT s.* FROM source_review_sources s WHERE EXISTS (
        SELECT 1 FROM events e JOIN source_review_items q ON q.event_id=e.id
        WHERE e.source_id=s.source_id AND e.source_generation=s.generation AND json_extract(e.json,'$.caseId')=s.case_id AND q.retired=0)
        ORDER BY next_at,last_dispatched,s.rowid`).all();
      for (const source of sources) {
        const sourceId = String(source.source_id), generation = String(source.generation), caseId = String(source.case_id);
        if (scope && (scope.caseId !== caseId || !scope.sourceGenerations.includes(generation))) continue;
        if (!manual && Number(source.next_at) > timestamp) continue;
        const active = this.db.prepare(`SELECT review.* FROM events review WHERE source_id=? AND source_generation=?
          AND json_extract(json,'$.caseId')=?
          AND json_extract(json,'$.kind')='growth.observation'
          AND json_extract(json,'$.payload.reviewItemId') IS NULL
          AND (status IN ('pending','leased') OR (? AND status='failed' AND json_extract(json,'$.payload.analysisTerminal') IS NULL))
          ORDER BY (status='failed'), rowid DESC LIMIT 1`)
          .get(sourceId, generation, caseId, Number(manual && Boolean(scope))) as unknown as EventRow | undefined;
        if (active && active.status !== 'failed') continue;
        const cutoff = Number(source.drain_until) || Number(this.db.prepare(`SELECT MAX(e.rowid) AS last FROM events e
          JOIN source_review_items q ON q.event_id=e.id WHERE e.source_id=? AND e.source_generation=? AND json_extract(e.json,'$.caseId')=?
            AND q.batch_id IS NULL AND q.retired=0`).get(sourceId, generation, caseId)?.last ?? 0);
        const candidates = this.db.prepare(`SELECT e.* FROM events e JOIN source_review_items q ON q.event_id=e.id
          WHERE e.source_id=? AND e.source_generation=? AND json_extract(e.json,'$.caseId')=?
            AND q.batch_id IS NULL AND q.retired=0 AND e.rowid<=? ORDER BY e.rowid LIMIT 20`).all(sourceId, generation, caseId, cutoff);
        const selected: StoredEvent[] = [];
        let size = 0;
        for (const row of candidates) {
          const event = this.decode(row as unknown as EventRow);
          if (!eligible(event)) {
            this.db.prepare('UPDATE source_review_items SET retired=1 WHERE event_id=? AND batch_id IS NULL').run(event.id);
            continue;
          }
          const length = Math.min(String(event.payload.content ?? '').length, event.payload.provider === 'wechat-desktop' ? 12000 : 500);
          if (selected.length && size + length > 12000) break;
          selected.push(event); size += length;
        }
        if (!selected.length) {
          // An explicit source-scoped request can reconsider the original batch. A failed
          // batch never absorbs or blocks new evidence, and regular dispatch never retries it.
          const retry = active ? this.decode(active) : undefined;
          if (!retry || !eligible(retry)) continue;
          this.db.prepare("UPDATE events SET status='pending',retry_at=0,last_error=NULL,json=json_remove(json,'$.payload.analysisNeedsReassessment') WHERE id=? AND status='failed'").run(retry.id);
          return this.get(retry.id);
        }
        const id = randomUUID();
        const batch = this.ingest({ id, sourceId, ...(generation ? { sourceGeneration: generation } : {}), caseId, externalId: `growth:${id}`,
          kind: 'growth.observation', actor: 'system', operation: 'create', occurredAt: new Date(timestamp).toISOString(),
          payload: { ...(typeof selected[0].payload.provider === 'string' ? { provider: selected[0].payload.provider } : {}),
            eventIds: selected.map(event => event.id), changeCount: selected.length,
            firstAt: selected[0].receivedAt, lastAt: selected.at(-1)!.receivedAt,
            purpose: '理解本批新信息与本人当前事项的关系，发现有依据的帮助机会；提议等待本人决定，外部资料不授予执行许可。' } }).event;
        for (const event of selected) this.db.prepare('UPDATE source_review_items SET batch_id=? WHERE event_id=? AND batch_id IS NULL').run(id, event.id);
        const remaining = this.db.prepare(`SELECT 1 FROM events e JOIN source_review_items q ON q.event_id=e.id
          WHERE e.source_id=? AND e.source_generation=? AND json_extract(e.json,'$.caseId')=?
            AND q.batch_id IS NULL AND q.retired=0 AND e.rowid<=? LIMIT 1`).get(sourceId, generation, caseId, cutoff);
        this.db.prepare('UPDATE source_review_sources SET next_at=?,drain_until=?,last_dispatched=? WHERE source_id=? AND generation=? AND case_id=?')
          .run(remaining ? timestamp : timestamp + Number(source.interval_ms), remaining ? cutoff : 0, timestamp, sourceId, generation, caseId);
        return batch;
      }
      return undefined;
    });
  }
  scheduleWake(input: { caseId: string; at: string; reason: string; originEventId: string; message?: string }): { id: string; at: string } {
    const value = z.object({ caseId: z.string().min(1).max(200), at: timestamp, reason: z.string().trim().min(1).max(800),
      originEventId: z.string().min(1).max(300), message: z.string().trim().min(1).max(4000).optional() }).strict().parse(input);
    const at = new Date(value.at).toISOString(); const id = createHash('sha256').update(JSON.stringify([value.originEventId, value.caseId, at, value.reason, value.message ?? null])).digest('hex');
    this.db.prepare("INSERT OR IGNORE INTO growth_wakes VALUES(?,?,?,?,'scheduled')").run(id, value.caseId, at, JSON.stringify({ ...value, at, id }));
    return { id, at };
  }
  releaseDueWakes(at = Date.now(), eligible: (event: InboxEvent) => boolean = () => true): number {
    return this.atomic(() => {
      const rows = this.db.prepare("SELECT json FROM growth_wakes WHERE state='scheduled' AND at<=? ORDER BY at").all(new Date(at).toISOString());
      let released = 0;
      for (const row of rows) {
        const wake = JSON.parse(String(row.json)) as { id: string; caseId: string; at: string; reason: string; originEventId: string; message?: string;
          review?: { itemId: string; revision: number } };
        if (wake.review) {
          const item = this.reviewAttention(wake.review.itemId), anchor = item ? this.get(item.anchorEventId) : undefined;
          if (!item || item.revision !== wake.review.revision || item.situation?.status === 'resolved' || !anchor
            || item.evidence.some(reference => { const source = this.get(reference.eventId); return !source || !eligible(source); })) {
            this.db.prepare("UPDATE growth_wakes SET state='cancelled' WHERE id=? AND state='scheduled'").run(wake.id);
            continue;
          }
          this.ingest({ id: wake.id, sourceId: anchor.sourceId, ...(anchor.sourceGeneration ? { sourceGeneration: anchor.sourceGeneration } : {}),
            externalId: wake.id, caseId: item.caseId, causationId: wake.originEventId, kind: 'growth.observation', actor: 'system', operation: 'create', occurredAt: wake.at,
            payload: { reviewItemId: item.id, reviewItemRevision: item.revision, eventIds: item.evidence.map(reference => reference.eventId),
              purpose: wake.reason, changeCount: 0, firstAt: wake.at, lastAt: wake.at } });
        } else {
          this.ingest({ id: wake.id, sourceId: 'growth-wake', externalId: wake.id, caseId: wake.caseId, causationId: wake.originEventId,
            kind: wake.message ? 'growth.reminder' : 'case.wake', actor: 'system', operation: 'create', occurredAt: wake.at,
            payload: { wakeId: wake.id, reason: wake.reason, ...(wake.message ? { message: wake.message } : {}) } });
        }
        this.db.prepare("UPDATE growth_wakes SET state='fired' WHERE id=? AND state='scheduled'").run(wake.id);
        released++;
      }
      return released;
    });
  }
  cancelWakes(caseId: string): void {
    this.atomic(() => {
      // A fired wake can still be waiting for inference after its timer was released.
      this.db.prepare(`UPDATE events SET status='processed',lease_until=NULL,lease_token=NULL,last_error=NULL
        WHERE status IN ('pending','leased') AND id IN (SELECT id FROM growth_wakes WHERE case_id=? AND state='fired')`).run(caseId);
      this.db.prepare("UPDATE growth_wakes SET state='cancelled' WHERE case_id=? AND state='scheduled'").run(caseId);
    });
  }
  scheduledWakes(caseId: string): Array<{ id: string; at: string; reason: string; message?: string }> {
    return this.db.prepare("SELECT json FROM growth_wakes WHERE case_id=? AND state='scheduled' ORDER BY at LIMIT 20").all(caseId).map(row => wakeSummary(String(row.json)));
  }
  /** Read confirmed, still-scheduled effects of this original event; no competing writable ledger. */
  wakeReceipts(caseId: string, originEventId: string): { scheduledCount: number; scheduled: Array<{ id: string; at: string; reason: string; message?: string }> } {
    const where = "case_id=? AND state='scheduled' AND json_extract(json,'$.originEventId')=?";
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM growth_wakes WHERE ${where}`).get(caseId, originEventId)!;
    const rows = this.db.prepare(`SELECT json FROM growth_wakes WHERE ${where} ORDER BY at,id LIMIT 20`).all(caseId, originEventId);
    return { scheduledCount: Number(count.count), scheduled: rows.map(row => wakeSummary(String(row.json))) };
  }
  cancelWake(caseId: string, id: string): boolean { return Boolean(this.db.prepare("UPDATE growth_wakes SET state='cancelled' WHERE case_id=? AND id=? AND state='scheduled'").run(caseId, id).changes); }
  nextWakeAt(): string | null { const row = this.db.prepare("SELECT at FROM growth_wakes WHERE state='scheduled' ORDER BY at LIMIT 1").get(); return row ? String(row.at) : null; }
  consumeLocal(kinds: string[], eligible: (event: StoredEvent) => boolean): number {
    if (!kinds.length || kinds.length > 20) throw new Error('Invalid local event kinds');
    return this.atomic(() => {
      let count = 0;
      for (const row of this.db.prepare(`SELECT * FROM events WHERE (status='pending' OR (status='leased' AND lease_until<=?))
        AND json_extract(json,'$.kind') IN (${kinds.map(() => '?').join(',')}) ORDER BY rowid`).all(Date.now(), ...kinds)) {
        const event = this.decode(row as unknown as EventRow); if (!eligible(event)) continue;
        this.db.prepare("UPDATE events SET status='processed',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=?").run(event.id); count++;
      }
      return count;
    });
  }
  private connectorHistoryGenerations(provider: string, known: readonly string[]): string {
    const rows = this.db.prepare(`SELECT DISTINCT source_generation FROM events
      WHERE json_extract(json,'$.kind')='connector.change' AND json_extract(json,'$.payload.provider')=?
        AND source_generation<>'' AND source_id=('connector:' || source_generation)`).all(provider);
    return JSON.stringify([...new Set([...known, ...rows.map(row => String(row.source_generation))])]);
  }
  /** Stop pending reviews during retirement while retaining all original events and checkpoints. */
  retireConnectorHistory(provider: string, known: readonly string[]): void {
    this.atomic(() => {
      const generations = this.connectorHistoryGenerations(provider, known);
      this.db.prepare(`UPDATE events SET status='processed',lease_until=NULL,lease_token=NULL
        WHERE status IN ('pending','leased') AND ${connectorHistoryFilter}`).run(provider, generations);
      this.retireObservationSources(JSON.parse(generations) as string[]);
    });
  }
  archivedConnectorEvents(provider: string, known: readonly string[]): InboxEvent[] {
    const generations = this.connectorHistoryGenerations(provider, known);
    return this.db.prepare(`SELECT json FROM events WHERE ${connectorHistoryFilter} ORDER BY rowid`).all(provider, generations)
      .map(row => JSON.parse(String(row.json)) as InboxEvent);
  }
  /** Bounded, case-scoped evidence lookup; callers also apply live source authorization. */
  existingWeChatExternalIds(caseId: string, generations: string[], externalIds: string[]): Set<string> {
    const rows = this.db.prepare(`SELECT external_id FROM events WHERE json_extract(json,'$.caseId')=?
      AND json_extract(json,'$.kind')='connector.change' AND json_extract(json,'$.payload.provider')='wechat-desktop'
      AND source_generation IN (SELECT value FROM json_each(?)) AND external_id IN (SELECT value FROM json_each(?))`)
      .all(caseId, JSON.stringify(generations), JSON.stringify(externalIds));
    return new Set(rows.map(row => String(row.external_id)));
  }
  weChatEvidenceStats(caseId: string, generations: string[]) {
    const row = this.db.prepare(`SELECT COUNT(*) AS total,
      COUNT(DISTINCT COALESCE(json_extract(json,'$.payload.messageId'),external_id)) AS messages, MAX(json_extract(json,'$.receivedAt')) AS received,
      MIN(json_extract(json,'$.payload.sentAt')) AS earliest, MAX(json_extract(json,'$.payload.sentAt')) AS latest
      FROM events WHERE json_extract(json,'$.caseId')=? AND json_extract(json,'$.kind')='connector.change'
      AND json_extract(json,'$.payload.provider')='wechat-desktop' AND source_generation IN (SELECT value FROM json_each(?))`)
      .get(caseId, JSON.stringify(generations))!;
    return { totalRows: Number(row.total), totalMessages: Number(row.messages), lastReceivedAt: row.received === null ? null : String(row.received),
      earliestMessageAt: row.earliest === null ? null : String(row.earliest), latestMessageAt: row.latest === null ? null : String(row.latest) };
  }
  queryWeChatEvidence(caseId: string, generations: string[], options: {
    query?: string; sender?: string; from?: string; until?: string; before?: string; limit: number;
  }): { events: StoredEvent[]; nextBefore: string | null; unknownTimeCount: number } {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20) throw new Error('Invalid WeChat query limit');
    const scope = `json_extract(json,'$.caseId')=? AND json_extract(json,'$.kind')='connector.change'
      AND json_extract(json,'$.payload.provider')='wechat-desktop' AND source_generation IN (SELECT value FROM json_each(?))`;
    const params: Array<string | number> = [caseId, JSON.stringify(generations)];
    const filters = [scope];
    const messageOrder = "COALESCE(json_extract(json,'$.payload.sentAt'),json_extract(json,'$.receivedAt'))";
    if (options.query) { filters.push("instr(lower(COALESCE(json_extract(json,'$.payload.content'),'')),lower(?))>0"); params.push(options.query); }
    if (options.sender) { filters.push("instr(lower(COALESCE(json_extract(json,'$.payload.senderName'),'')),lower(?))>0"); params.push(options.sender); }
    if (options.from) { filters.push("json_extract(json,'$.payload.sentAt')>=?"); params.push(new Date(options.from).toISOString()); }
    if (options.until) { filters.push("json_extract(json,'$.payload.sentAt')<?"); params.push(new Date(options.until).toISOString()); }
    if (options.before) {
      const anchor = this.db.prepare(`SELECT rowid,${messageOrder} AS message_time FROM events WHERE ${scope} AND id=?`).get(caseId, JSON.stringify(generations), options.before);
      if (!anchor) throw new Error('微信查询位置不属于当前会话。');
      filters.push(`(${messageOrder},rowid)<(?,?)`); params.push(String(anchor.message_time), Number(anchor.rowid));
    }
    const found = this.db.prepare(`SELECT * FROM events WHERE ${filters.join(' AND ')} ORDER BY ${messageOrder} DESC,rowid DESC LIMIT ?`)
      .all(...params, options.limit + 1).map(row => this.decode(row as unknown as EventRow));
    const events = found.slice(0, options.limit);
    const unknown = this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${scope} AND json_extract(json,'$.payload.sentAt') IS NULL`)
      .get(caseId, JSON.stringify(generations))!;
    return { events, nextBefore: found.length > options.limit ? events.at(-1)!.id : null, unknownTimeCount: Number(unknown.count) };
  }
  /** A conversation window is evidence, not additional analysis coverage. Anchors must be in the exact live scope. */
  weChatNeighborhood(caseId: string, generations: string[], anchorIds: readonly string[],
    eligible: (event: StoredEvent) => boolean, before = 20): { events: StoredEvent[]; truncated: boolean } {
    if (!anchorIds.length || anchorIds.length > 40 || !Number.isInteger(before) || before < 0 || before > 40) throw new Error('Invalid conversation window');
    const scope = `json_extract(json,'$.caseId')=? AND json_extract(json,'$.kind')='connector.change'
      AND json_extract(json,'$.payload.provider')='wechat-desktop' AND source_generation IN (SELECT value FROM json_each(?))`;
    const order = "COALESCE(json_extract(json,'$.payload.sentAt'),json_extract(json,'$.receivedAt'))";
    const anchors = anchorIds.map(id => this.db.prepare(`SELECT rowid,${order} AS message_time,* FROM events WHERE ${scope} AND id=?`)
      .get(caseId, JSON.stringify(generations), id));
    if (anchors.some(row => !row || !eligible(this.decode(row as unknown as EventRow)))) throw new Error('Conversation anchor is unavailable');
    const first = [...anchors].sort((a, b) => String(a!.message_time).localeCompare(String(b!.message_time)) || Number(a!.rowid) - Number(b!.rowid))[0]!;
    const earlierRows = this.db.prepare(`SELECT rowid,* FROM events WHERE ${scope} AND (${order},rowid)<(?,?) ORDER BY ${order} DESC,rowid DESC LIMIT ?`)
      .all(caseId, JSON.stringify(generations), String(first.message_time), Number(first.rowid), before + 1);
    const earlier = earlierRows.map(row => this.decode(row as unknown as EventRow)).filter(eligible);
    const positions = new Map([...earlierRows, ...anchors].map(row => [String(row!.id), Number(row!.rowid)]));
    const events = [...earlier.slice(0, before).reverse(), ...anchors.map(row => this.decode(row as unknown as EventRow))];
    const unique = [...new Map(events.map(event => [event.id, event])).values()]
      .sort((a, b) => String(a.payload.sentAt ?? a.receivedAt).localeCompare(String(b.payload.sentAt ?? b.receivedAt)) || positions.get(a.id)! - positions.get(b.id)!);
    return { events: unique, truncated: earlier.length > before };
  }
  reviewDecision(id: string): ReviewDecisionRecord | undefined {
    const row = this.db.prepare('SELECT json FROM review_decisions WHERE id=? OR review_event_id=? ORDER BY rowid DESC LIMIT 1').get(id, id);
    return row ? JSON.parse(String(row.json)) as ReviewDecisionRecord : undefined;
  }
  /** Terminal passive work retains its old membership and cannot block genuinely later new messages. */
  markReviewTerminal(id: string, reason: 'step_limit' | 'deadline'): boolean {
    const event = this.get(id);
    if (!event || event.kind !== 'growth.observation' || event.status !== 'failed') return false;
    return Boolean(this.db.prepare(`UPDATE events SET json=json_remove(json_set(json,'$.payload.analysisTerminal',json(?)),
      '$.payload.analysisNeedsReassessment') WHERE id=? AND status='failed'`)
      .run(JSON.stringify({ reason, at: new Date().toISOString() }), id).changes);
  }
  /** A new owner correction needs explicit reconsideration, not an idle model retry or a fresh budget. */
  markReviewNeedsReassessment(id: string): boolean {
    const event = this.get(id);
    if (!event || event.kind !== 'growth.observation' || event.payload.analysisTerminal || !['processed', 'leased', 'failed'].includes(event.status)) return false;
    return Boolean(this.db.prepare(`UPDATE events SET status='failed',lease_until=NULL,lease_token=NULL,retry_at=0,
      last_error='本人背景已改变，原判断未公开；等待在原预算内明确复核。',json=json_set(json,'$.payload.analysisNeedsReassessment',json('true'))
      WHERE id=? AND json_extract(json,'$.payload.analysisTerminal') IS NULL`).run(id).changes);
  }
  reviewAttention(id: string): ReviewAttentionItem | undefined {
    const row = this.db.prepare('SELECT json FROM review_attention_items WHERE id=?').get(id);
    return row ? JSON.parse(String(row.json)) as ReviewAttentionItem : undefined;
  }
  reviewAttentionForCase(caseId: string, conversationId?: string, options: { query?: string; offset?: number; limit?: number } = {}): ReviewAttentionItem[] {
    const { query = '', offset = 0, limit = 40 } = options;
    if (query.length > 200 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('Invalid attention query');
    const rows = this.db.prepare(`SELECT json FROM review_attention_items WHERE case_id=?
      ${conversationId === undefined ? '' : 'AND conversation_id=?'}
      AND instr(COALESCE(json_extract(json,'$.situation.title'),'') || COALESCE(json_extract(json,'$.situation.summary'),'')
        || json_extract(json,'$.fields'),?)>0
      ORDER BY CASE WHEN json_extract(json,'$.situation.status')='resolved' THEN 1 ELSE 0 END,
        COALESCE(julianday(json_extract(json,'$.situation.dueAt')),1e20),json_extract(json,'$.updatedAt') DESC,id
      LIMIT ? OFFSET ?`).all(caseId, ...(conversationId === undefined ? [] : [conversationId]), query, limit, offset);
    return rows.map(row => JSON.parse(String(row.json)) as ReviewAttentionItem);
  }
  /** Journal, derived item and publication intent commit together. No task writer is called inside this transaction. */
  commitReviewDecision(record: ReviewDecisionRecord, attention?: ReviewAttentionItem, outbox?: ReviewOutboxRecord,
    expectedAttentionRevision = 0): void {
    this.atomic(() => {
      const existing = this.reviewDecision(record.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('A committed review decision cannot change');
        return;
      }
      if (record.reassessmentOf) {
        const previous = this.reviewDecision(record.reviewEventId), pending = this.reviewOutbox(record.reassessmentOf);
        if (previous?.id !== record.reassessmentOf || pending?.state !== 'needs_reassessment') throw new Error('The original reassessment marker changed');
        const settled = { ...pending, state: 'invalidated' as const, reason: `superseded_by:${record.id}` };
        this.db.prepare("UPDATE review_notification_outbox SET state='invalidated',json=? WHERE decision_id=? AND state='needs_reassessment'")
          .run(JSON.stringify(settled), record.reassessmentOf);
      }
      if (attention && (this.reviewAttention(attention.id)?.revision ?? 0) !== expectedAttentionRevision) throw new Error('Review item changed; inspect the current item before committing');
      this.db.prepare('INSERT INTO review_decisions(id,review_event_id,case_id,json) VALUES(?,?,?,?)')
        .run(record.id, record.reviewEventId, record.caseId, JSON.stringify(record));
      if (attention) this.db.prepare(`INSERT INTO review_attention_items(id,case_id,conversation_id,json) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET json=excluded.json`).run(attention.id, attention.caseId, attention.conversationId, JSON.stringify(attention));
      if (attention) {
        this.cancelAttentionWakes(attention.id, record.reviewEventId);
        const situation = attention.situation, at = situation?.reviewAt;
        if (situation && at && situation.status !== 'resolved' && Date.parse(at) > Date.now()) {
          const id = createHash('sha256').update(`attention-wake:${attention.id}:${attention.revision}:${at}`).digest('hex');
          const value = { id, caseId: attention.caseId, at: new Date(at).toISOString(), originEventId: record.reviewEventId,
            reason: `核对已保存事项「${situation.title}」在约定时点的帮助价值与当前状态。`,
            review: { itemId: attention.id, revision: attention.revision } };
          this.db.prepare("INSERT OR IGNORE INTO growth_wakes VALUES(?,?,?,?,'scheduled')").run(id, value.caseId, value.at, JSON.stringify(value));
        }
      }
      if (outbox) this.db.prepare('INSERT INTO review_notification_outbox(decision_id,message_id,state,json) VALUES(?,?,?,?)')
        .run(outbox.decisionId, outbox.messageId, outbox.state, JSON.stringify(outbox));
    });
  }
  reviewOutbox(decisionId: string): ReviewOutboxRecord | undefined {
    const row = this.db.prepare('SELECT json FROM review_notification_outbox WHERE decision_id=?').get(decisionId);
    return row ? JSON.parse(String(row.json)) as ReviewOutboxRecord : undefined;
  }
  cancelProposalWakes(taskId: string): void {
    this.atomic(() => {
      const items = this.db.prepare(`SELECT item.id FROM review_attention_items item
        JOIN review_notification_outbox publication ON publication.decision_id=COALESCE(json_extract(item.json,'$.proposalDecisionId'),json_extract(item.json,'$.publicationDecisionId'))
        WHERE json_extract(publication.json,'$.receipt.taskId')=?`).all(taskId);
      for (const item of items) this.cancelAttentionWakes(String(item.id));
    });
  }
  private cancelAttentionWakes(itemId: string, settlingEventId = ''): void {
    // A timer may already have released an inbox event while awaiting model capacity.
    // The decision currently being committed is allowed to settle its own event.
    this.db.prepare(`UPDATE events SET status='processed',lease_until=NULL,lease_token=NULL,last_error=NULL
      WHERE status IN ('pending','leased') AND id<>? AND id IN (
        SELECT id FROM growth_wakes WHERE state='fired' AND json_extract(json,'$.review.itemId')=?)`).run(settlingEventId, itemId);
    this.db.prepare(`UPDATE growth_wakes SET state='cancelled' WHERE state IN ('scheduled','fired') AND id<>?
      AND json_extract(json,'$.review.itemId')=?`).run(settlingEventId, itemId);
  }
  pendingReviewOutbox(): ReviewOutboxRecord[] {
    return this.db.prepare("SELECT json FROM review_notification_outbox WHERE state='pending' ORDER BY rowid LIMIT 100").all()
      .map(row => JSON.parse(String(row.json)) as ReviewOutboxRecord);
  }
  reviewReassessments(): ReviewOutboxRecord[] {
    return this.db.prepare("SELECT json FROM review_notification_outbox WHERE state='needs_reassessment' ORDER BY rowid LIMIT 100").all()
      .map(row => JSON.parse(String(row.json)) as ReviewOutboxRecord);
  }
  exportReviewJournal(): { decisions: ReviewDecisionRecord[]; attentionItems: ReviewAttentionItem[]; publications: ReviewOutboxRecord[] } {
    const read = <T>(table: string) => this.db.prepare(`SELECT json FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.json)) as T);
    return { decisions: read<ReviewDecisionRecord>('review_decisions'), attentionItems: read<ReviewAttentionItem>('review_attention_items'),
      publications: read<ReviewOutboxRecord>('review_notification_outbox') };
  }
  transitionReviewOutbox(decisionId: string, state: Exclude<ReviewOutboxRecord['state'], 'pending'>,
    receipt?: ReviewOutboxRecord['receipt'], reason?: string): ReviewOutboxRecord {
    return this.atomic(() => {
      const current = this.reviewOutbox(decisionId); if (!current) throw new Error('Review publication does not exist');
      if (current.state !== 'pending') {
        if (current.state !== state || state === 'delivered' && JSON.stringify(current.receipt) !== JSON.stringify(receipt)) throw new Error('Review publication is already settled differently');
        return current;
      }
      const next = { ...current, state, ...(receipt ? { receipt } : {}), ...(reason ? { reason } : {}) };
      this.db.prepare('UPDATE review_notification_outbox SET state=?,json=? WHERE decision_id=? AND state=\'pending\'')
        .run(state, JSON.stringify(next), decisionId);
      return next;
    });
  }
  findForCase(caseId: string, query: string, limit: number, eligible: (event: StoredEvent) => boolean): StoredEvent[] {
    if (!caseId || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid case evidence query');
    const rows = this.db.prepare(`SELECT * FROM events WHERE json_extract(json,'$.caseId')=?
      AND instr(COALESCE(json_extract(json,'$.payload.content'),'') || COALESCE(json_extract(json,'$.payload.comment'),'') || external_id, ?) > 0
      ORDER BY rowid DESC`).iterate(caseId, query);
    const found: StoredEvent[] = [];
    for (const row of rows) { const event = this.decode(row as unknown as EventRow); if (eligible(event)) found.push(event); if (found.length === limit) break; }
    return found;
  }
  hasPending(): boolean { return Boolean(this.db.prepare("SELECT 1 FROM events WHERE status IN ('pending','leased') LIMIT 1").get()); }
  coolingDownCases(): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT json_extract(json,'$.caseId') AS case_id FROM events WHERE status='pending' AND retry_at>?").all(Date.now());
    return new Set(rows.flatMap(row => typeof row.case_id === 'string' ? [row.case_id] : []));
  }
  ready(limit = 100, eligible?: (event: StoredEvent) => boolean): StoredEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid ready limit');
    const result: StoredEvent[] = [];
    const now = Date.now();
    for (const row of this.db.prepare("SELECT * FROM events WHERE (status='pending' AND retry_at<=?) OR (status='leased' AND lease_until<=?) ORDER BY rowid").iterate(now, now)) {
      const event = this.decode(row as unknown as EventRow);
      if (!eligible || eligible(event)) result.push(event);
      if (result.length >= limit) break;
    }
    return result;
  }
  getCaseId(id: string): string | undefined { return this.get(id)?.caseId; }
  bindCase(id: string, caseId: string): StoredEvent {
    if (!caseId || caseId.length > 300) throw new Error('Invalid case binding');
    return this.atomic(() => {
      const event = this.get(id); if (!event) throw new Error('Event does not exist');
      if (event.caseId && event.caseId !== caseId) throw new Error('Event case binding is immutable');
      if (event.kind === 'workspace.file' && !event.caseId) throw new Error('Legacy source events require registry migration, not intake routing');
      const { status: _status, attempts: _attempts, leaseUntil: _until, leaseToken: _token, lastError: _error, ...original } = event;
      this.db.prepare('UPDATE events SET json=? WHERE id=?').run(JSON.stringify({ ...original, caseId }), id);
      return this.get(id)!;
    });
  }
  list(status?: EventStatus): StoredEvent[] {
    if (status !== undefined && !STATUSES.includes(status)) throw new Error('Invalid event status');
    const rows = status === undefined ? this.db.prepare('SELECT * FROM events ORDER BY rowid').all()
      : this.db.prepare('SELECT * FROM events WHERE status=? ORDER BY rowid').all(status);
    return (rows as unknown as EventRow[]).map(row => this.decode(row));
  }
  private summaries(where: string, parameters: Array<string | number>, descending = false, limit = 41): RuntimeEventSummary[] {
    const rows = this.db.prepare(`SELECT id, source_id AS sourceId, operation, status, attempts, last_error AS lastError,
      json_extract(json,'$.kind') AS kind, json_extract(json,'$.caseId') AS caseId,
      json_extract(json,'$.occurredAt') AS occurredAt, json_extract(json,'$.receivedAt') AS receivedAt,
      CASE WHEN json_extract(json,'$.kind')='owner.message' AND json_type(json,'$.payload.messageId')='text'
      THEN json_extract(json,'$.payload.messageId') END AS messageId
      FROM events ${where} ORDER BY rowid ${descending ? 'DESC' : 'ASC'} LIMIT ?`).all(...parameters, limit);
    type SummaryRow = Omit<RuntimeEventSummary, 'caseId' | 'messageId'> & { caseId: string | null; messageId: string | null };
    return (rows as unknown as SummaryRow[]).map(({ caseId, messageId, ...row }) => ({ ...row,
      ...(caseId === null ? {} : { caseId }), ...(messageId === null ? {} : { messageId }) }));
  }
  history({ caseId, before }: { caseId?: string; before?: string } = {}): RuntimeHistoryPage<RuntimeEventSummary> | undefined {
    const filters = caseId === undefined ? [] : ["json_extract(json,'$.caseId')=?"];
    const parameters: Array<string | number> = caseId === undefined ? [] : [caseId];
    if (before !== undefined) {
      const anchor = this.db.prepare(`SELECT rowid FROM events WHERE id=?${filters.length ? ' AND ' + filters.join(' AND ') : ''}`).get(before, ...parameters);
      if (!anchor) return;
      filters.push('rowid<?'); parameters.push(Number(anchor.rowid));
    }
    const rows = this.summaries(filters.length ? 'WHERE ' + filters.join(' AND ') : '', parameters, true);
    const items = rows.slice(0, 40).reverse();
    return { items, nextBefore: rows.length > 40 ? items[0].id : null };
  }
  summariesForMessages(ids: readonly string[]): RuntimeEventSummary[] {
    if (ids.length > 40) throw new Error('Event associations exceed the visible message page');
    if (!ids.length) return [];
    return this.summaries(`WHERE source_id='owner-chat' AND json_extract(json,'$.kind')='owner.message'
      AND external_id IN (${ids.map(() => '?').join(',')})`, [...ids], false, 40);
  }
  ownerMessageEventIds(ids: readonly string[]): ReadonlyMap<string, string | null> {
    if (ids.length > 40) throw new Error('Event associations exceed the visible message page');
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`
      SELECT external_id, CASE WHEN count(*)=1 AND min(operation)='create' THEN min(id) END AS event_id
      FROM events WHERE source_id='owner-chat' AND json_extract(json,'$.kind')='owner.message'
        AND external_id IN (SELECT value FROM json_each(?))
      GROUP BY external_id
    `).all(JSON.stringify(ids));
    return new Map(rows.map(row => [String(row.external_id), row.event_id === null ? null : String(row.event_id)]));
  }
  claim(limit = 20, leaseMs = 60_000, eligibleIds?: string[]): StoredEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) throw new Error('Invalid lease limits');
    if (eligibleIds && (eligibleIds.length > 1000 || eligibleIds.some(id => typeof id !== 'string' || !id || id.length > 300))) throw new Error('Invalid eligible event IDs');
    if (eligibleIds?.length === 0) return [];
    return this.atomic(() => {
      const now = Date.now();
      const scope = eligibleIds ? ` AND id IN (${eligibleIds.map(() => '?').join(',')})` : '';
      const rows = this.db.prepare(`SELECT id FROM events WHERE ((status='pending' AND retry_at<=?) OR (status='leased' AND lease_until<=?))${scope} ORDER BY rowid LIMIT ?`).all(now, now, ...(eligibleIds ?? []), limit);
      return rows.map(row => {
        this.db.prepare("UPDATE events SET status='leased',lease_until=?,lease_token=?,retry_at=0,attempts=attempts+1 WHERE id=?")
          .run(now + leaseMs, randomUUID(), String(row.id));
        return this.decode(this.db.prepare('SELECT * FROM events WHERE id=?').get(String(row.id)) as unknown as EventRow);
      });
    });
  }
  /** Refresh live processing ownership, never a business deadline or a replacement lease. */
  renewLease(id: string, leaseToken: string, leaseMs = 10 * 60000): boolean {
    if (!id || !leaseToken || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) throw new Error('Invalid lease renewal');
    const now = Date.now();
    return Boolean(this.db.prepare("UPDATE events SET lease_until=? WHERE id=? AND status='leased' AND lease_token=? AND lease_until>?")
      .run(now + leaseMs, id, leaseToken, now).changes);
  }
  /** A live worker that slept past its lease may quarantine only that expired token. */
  quarantineExpiredLease(id: string, leaseToken: string, error: string): boolean {
    return Boolean(this.db.prepare("UPDATE events SET status='failed',lease_until=NULL,lease_token=NULL,last_error=? WHERE id=? AND status='leased' AND lease_token=? AND lease_until<=?")
      .run(error.slice(0, 2000), id, leaseToken, Date.now()).changes);
  }
  /** The stop receipt and replay fence commit together against the exact owner-chat attempt. */
  stopOwnerMessage(id: string, leaseToken: string, runId: string, note: string): boolean {
    return Boolean(this.db.prepare(`UPDATE events SET status='failed',lease_until=NULL,lease_token=NULL,last_error=?,
      json=json_set(json,'$.ownerStoppedRunId',?) WHERE id=? AND status='leased' AND lease_token=?
      AND source_id='owner-chat' AND operation='create' AND json_extract(json,'$.kind')='owner.message'
      AND json_extract(json,'$.actor')='owner'`).run(note, runId, id, leaseToken).changes);
  }
  /** Pass the claim token to prevent an expired worker acknowledging a replacement lease. */
  ack(id: string, leaseToken?: string): void {
    const result = this.db.prepare(`UPDATE events SET status='processed',lease_until=NULL,lease_token=NULL,last_error=NULL,
      json=CASE WHEN json_extract(json,'$.payload.provider')='wechat-desktop' AND json_extract(json,'$.kind')='growth.observation'
        THEN json_set(json,'$.payload.analysisCompletedAt',?) ELSE json END
      WHERE id=? AND status='leased' AND lease_until>?${leaseToken === undefined ? '' : ' AND lease_token=?'}`)
      .run(new Date().toISOString(), ...(leaseToken === undefined ? [id, Date.now()] : [id, Date.now(), leaseToken]));
    if (!result.changes) throw new Error('Event lease is absent, expired or no longer owned');
  }
  retry(id: string, error: string, leaseToken?: string, retryAt = 0): void { this.release(id, error, 'pending', leaseToken, retryAt); }
  fail(id: string, error: string, leaseToken?: string): void { this.release(id, error, 'failed', leaseToken); }
  /** Only the exclusive runtime startup uses this after its former worker has died. */
  recoverInterruptedProgress(id: string, error: string): void {
    this.db.prepare("UPDATE events SET status='failed',lease_until=NULL,lease_token=NULL,last_error=? WHERE id=? AND status IN ('pending','leased')")
      .run(error.slice(0, 2000), id);
  }
  /** Receipt reconciliation may close a quarantined execution event, never lease
   * or retry it. Task/operation provenance is verified by the completion owner. */
  acknowledgeRecoveredTask(id: string): void {
    this.db.prepare("UPDATE events SET status='processed',last_error=NULL WHERE id=? AND status='failed' AND lease_token IS NULL AND json_extract(json,'$.kind')='task.execute' AND json_extract(json,'$.sourceId')='task-consent'")
      .run(id);
  }
  private release(id: string, error: string, status: 'pending' | 'failed', leaseToken?: string, retryAt = 0): void {
    const result = this.db.prepare(`UPDATE events SET status=?,lease_until=NULL,lease_token=NULL,last_error=?,retry_at=? WHERE id=?
      AND status='leased' AND lease_until>?${leaseToken === undefined ? '' : ' AND lease_token=?'}`)
      .run(status, String(error).slice(0, 2000), retryAt, id, Date.now(), ...(leaseToken === undefined ? [] : [leaseToken]));
    if (!result.changes) throw new Error('Event lease is absent, expired or no longer owned');
  }
  close(): void { this.db.close(); }
}

export interface WorkspaceWatcherConfig { sourceId: string; sourceGeneration?: string; caseId?: string; root: string; include?: string[]; onEvents?: () => void }
interface FileSnapshot { sha256: string; size: number; mtimeMs: number; content: string }
interface WorkspaceCheckpoint { schema: 1; root: string; generation: number; files: Record<string, Omit<FileSnapshot, 'content'>> }
export interface ReconcileResult { created: number; updated: number; deleted: number }
interface ObservationRoot { path: string; directory: boolean }
const IGNORED = new Set(['.git', 'node_modules', 'data', '.local', 'dist']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1']);
const MAX_TEXT_BYTES = 200 * 1024;
const ROOT_FILE_LIMIT = 20_000;

/** Observes only one explicitly authorized root; all discovery is ordinary filesystem I/O. */
export class WorkspaceWatcher {
  private root = '';
  private authorized = false;
  private watcher: FSWatcher | undefined;
  private presenceWatcher: FSWatcher | undefined;
  private presencePaths: string[] = [];
  private presenceRefresh: Promise<void> = Promise.resolve();
  private presenceAbort = new AbortController();
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private starting: Promise<void> | undefined;
  private startupAbort: AbortController | undefined;
  private wakePending = false;
  private observationPlan: ObservationRoot[] = [];
  private includePositive: string[] = [];
  private includeNegative: string[] = [];
  lastError: string | null = null;
  constructor(private readonly inbox: EventInbox, private readonly config: WorkspaceWatcherConfig) {
    if (!config.sourceId || config.sourceId.length > 300 || !isAbsolute(config.root)) throw new Error('An absolute authorized root and sourceId are required');
    if (config.include?.length) this.patternTasks(config.include);
  }
  get observationRoots(): readonly string[] { return Object.freeze(this.observationPlan.map(item => item.path)); }
  private validatePattern(pattern: string): void {
    if (!pattern || isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || /[\\\0]/.test(pattern) || pattern.split('/').includes('..')) {
      throw new Error('Include patterns must stay relative to the authorized root');
    }
  }
  private patternTasks(patterns: string[]): fastGlob.Task[] {
    for (const pattern of patterns) this.validatePattern(pattern.startsWith('!') && !pattern.startsWith('!(') ? pattern.slice(1) : pattern);
    const tasks = fastGlob.generateTasks(patterns, { dot: true, followSymbolicLinks: false });
    if (!tasks.length) throw new Error('Include must select at least one positive pattern');
    for (const task of tasks) {
      this.validatePattern(task.base);
      for (const pattern of [...task.positive, ...task.negative]) this.validatePattern(pattern);
    }
    return tasks;
  }
  private async planObservation(): Promise<void> {
    if (!this.config.include?.length) { this.observationPlan = [{ path: this.root, directory: true }]; return; }
    const tasks = this.patternTasks(this.config.include);
    const normalized = (pattern: string): string => pattern.replace(/^(?:\.\/)+/, '');
    this.includePositive = [...new Set(tasks.flatMap(task => task.positive).map(normalized))];
    this.includeNegative = [...new Set(tasks.flatMap(task => task.negative).map(normalized))];
    const candidates = tasks.flatMap(task => task.dynamic
      ? [{ path: resolve(this.root, task.base), directory: true }]
      : task.positive.map(path => ({ path: resolve(this.root, path), directory: false })));
    candidates.sort((a, b) => a.path.length - b.path.length || Number(b.directory) - Number(a.directory));
    const selected: ObservationRoot[] = [];
    for (const candidate of candidates) {
      if (!this.inside(candidate.path) || this.excluded(candidate.path)) throw new Error('Include targets an excluded or unauthorized path');
      if (selected.some(existing => existing.path === candidate.path || (existing.directory && this.descendant(existing.path, candidate.path)))) continue;
      await this.validateObservationPath(candidate.path);
      selected.push(candidate);
    }
    this.observationPlan = selected;
  }
  private descendant(parent: string, path: string): boolean {
    const rel = relative(parent, path);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  }
  private async validateObservationPath(path: string): Promise<void> {
    if (!this.inside(path)) throw new Error('Observation path escapes the authorized root');
    const parts = relative(this.root, path).split(sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      current = resolve(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !this.inside(await realpath(current))) throw new Error('Observation roots cannot contain symlinks or junctions');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
  }
  private inObservationScope(path: string): boolean {
    return this.observationPlan.some(item => item.path === path || (item.directory && this.descendant(item.path, path)) || this.descendant(path, item.path));
  }
  private directoryCanContainMatches(path: string): boolean {
    if (!this.config.include?.length) return true;
    const rel = relative(this.root, path).split(sep).join('/');
    if (!rel) return true;
    // Match fast-glob's directory pruning: dynamic file exclusions do not exclude a same-named directory tree.
    if (this.includeNegative.some(pattern => (pattern.endsWith('/**') || !fastGlob.isDynamicPattern(basename(pattern))) &&
      (matchesGlob(rel, pattern) || matchesGlob(`${rel}/`, pattern)))) return false;
    const parts = rel.split('/');
    return this.includePositive.some(pattern => {
      const patternParts = pattern.split('/'); const globstar = patternParts.indexOf('**');
      if (globstar < 0 && parts.length >= patternParts.length) return false;
      const fixed = Math.min(parts.length, globstar < 0 ? patternParts.length - 1 : globstar);
      return fixed === 0 || matchesGlob(parts.slice(0, fixed).join('/'), patternParts.slice(0, fixed).join('/'));
    });
  }
  private watchIgnored = (path: string, info?: { isSymbolicLink(): boolean; isFile(): boolean }): boolean =>
    this.excluded(resolve(path)) || !this.inObservationScope(resolve(path)) || Boolean(info?.isSymbolicLink()) ||
      (info?.isFile() ? !this.included(resolve(path)) : !this.directoryCanContainMatches(resolve(path)) && !(!info && this.included(resolve(path))));
  /** Shallow sentinels observe only target ancestors appearing/disappearing, never their content trees. */
  private refreshPresenceWatch(): Promise<void> {
    const refresh = this.presenceRefresh.then(async () => {
      if (this.stopped || !this.config.include?.length) return;
      const parents = new Set<string>();
      for (const observation of this.observationPlan) {
        let parent = dirname(observation.path);
        while (this.inside(parent)) {
          try {
            const info = await lstat(parent);
            if (info.isSymbolicLink() || !this.inside(await realpath(parent))) break;
            if (info.isDirectory()) parents.add(parent);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const next = dirname(parent); if (next === parent) break; parent = next;
          }
        }
      }
      const paths = [...parents].sort();
      if (this.stopped) return;
      if (paths.length === this.presencePaths.length && paths.every((path, index) => path === this.presencePaths[index])) return;
      const previous = this.presenceWatcher;
      const watcher = this.presenceWatcher = watch(paths, { persistent: true, depth: 0, ignoreInitial: true, followSymlinks: false, ignored: this.watchIgnored });
      watcher.on('all', () => {
        if (this.stopped) return;
        this.watcher?.add([...this.observationRoots]); this.schedule();
        void this.refreshPresenceWatch().catch(() => { this.lastError = 'Target parent monitoring failed; reconciliation is required'; });
      });
      watcher.on('error', () => { this.lastError = 'Target parent monitoring failed; reconciliation is required'; });
      await new Promise<void>((done, fail) => {
        const signal = this.presenceAbort.signal;
        const cleanup = (): void => { watcher.off('ready', ready); watcher.off('error', error); signal.removeEventListener('abort', ready); };
        const ready = (): void => { cleanup(); done(); };
        const error = (cause: unknown): void => { cleanup(); fail(cause); };
        watcher.once('ready', ready); watcher.once('error', error); signal.addEventListener('abort', ready, { once: true });
        if (signal.aborted || !paths.length) ready();
      });
      if (this.stopped) await watcher.close(); else this.presencePaths = paths;
      await previous?.close();
    });
    this.presenceRefresh = refresh.catch(() => undefined);
    return refresh;
  }
  private inside(path: string): boolean {
    const rel = relative(this.root, path);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  }
  private excluded(path: string): boolean {
    if (!this.inside(path)) return true;
    const parts = relative(this.root, path).split(/[\\/]/);
    return parts.some(part => IGNORED.has(part.toLowerCase())) || parts.some(part => part === '.env' || part.startsWith('.env.'));
  }
  private included(path: string): boolean {
    const rel = relative(this.root, path).split(sep).join('/');
    if (this.config.include?.length) return this.includePositive.some(pattern => matchesGlob(rel, pattern)) && !this.includeNegative.some(pattern => matchesGlob(rel, pattern));
    return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || ['README', 'LICENSE', 'LICENSE-MIT'].includes(basename(path));
  }
  private async authorizeRoot(): Promise<void> {
    this.authorized = false;
    const specified = resolve(this.config.root);
    const info = await lstat(specified);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The authorized root must be a real directory');
    this.root = await realpath(specified);
    const checkpoint = this.inbox.getCheckpoint<WorkspaceCheckpoint>(this.config.sourceId, null, this.config.sourceGeneration);
    if (checkpoint && checkpoint.root !== this.root) throw new Error('This sourceId is already bound to another directory');
    await this.planObservation();
    this.authorized = true;
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.watcher) return Promise.resolve();
    this.stopped = false;
    this.presenceAbort = new AbortController();
    const startupAbort = this.startupAbort = new AbortController();
    this.starting = (async () => {
      await this.authorizeRoot(); await this.reconcile();
      if (this.stopped) return;
      const watcher = this.watcher = watch([...this.observationRoots], {
        persistent: true, ignoreInitial: true, followSymlinks: false, atomic: true,
        ignored: this.watchIgnored,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });
      watcher.on('all', () => { this.schedule(); void this.refreshPresenceWatch().catch(() => { this.lastError = 'Target parent monitoring failed'; }); });
      watcher.on('error', () => { this.lastError = 'Directory watch failed; reconciliation is required'; });
      await new Promise<void>((done, fail) => {
        const cleanup = (): void => { watcher.off('ready', ready); watcher.off('error', error); startupAbort.signal.removeEventListener('abort', ready); };
        const ready = (): void => { cleanup(); done(); };
        const error = (cause: unknown): void => { cleanup(); fail(cause); };
        watcher.once('ready', ready); watcher.once('error', error);
        startupAbort.signal.addEventListener('abort', ready, { once: true });
        if (startupAbort.signal.aborted) ready();
      });
      if (!this.stopped) { await this.refreshPresenceWatch(); await this.reconcile(); }
    })().catch(async error => {
      await this.watcher?.close(); this.watcher = undefined;
      await this.presenceWatcher?.close(); this.presenceWatcher = undefined; this.presencePaths = [];
      throw error;
    }).finally(() => { this.starting = undefined; this.startupAbort = undefined; });
    return this.starting;
  }
  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.reconcile().catch(() => { this.lastError = 'Directory reconciliation failed'; });
    }, 80);
  }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.debounce); this.debounce = undefined;
    this.startupAbort?.abort();
    this.presenceAbort.abort();
    await this.watcher?.close(); this.watcher = undefined;
    await this.presenceWatcher?.close(); this.presenceWatcher = undefined; this.presencePaths = [];
    await this.presenceRefresh;
    await this.queue;
    await this.starting;
  }
  reconcile(): Promise<ReconcileResult> {
    const result = this.queue.then(async () => {
      try {
        if (!this.authorized) await this.authorizeRoot();
        return await this.scanAndCommit();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Directory scan is incomplete';
        throw error;
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async rootIdentity(): Promise<string> {
    try {
      const info = await lstat(this.root, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error();
      return `${info.dev}:${info.ino}`;
    } catch { throw new Error('Authorized root is unavailable; the previous directory snapshot is retained'); }
  }
  private async readText(path: string): Promise<FileSnapshot | 'unstable' | undefined> {
    const pathInfo = await lstat(path, { bigint: true });
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size > BigInt(MAX_TEXT_BYTES)) return undefined;
    if (!this.inside(await realpath(path))) return undefined;
    const file = await open(path, 'r');
    try {
      const before = await file.stat({ bigint: true });
      const currentPath = await lstat(path, { bigint: true });
      if (currentPath.isSymbolicLink() || before.ino !== currentPath.ino || before.dev !== currentPath.dev || !this.inside(await realpath(path))) return undefined;
      if (!before.isFile() || before.size > BigInt(MAX_TEXT_BYTES)) return undefined;
      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1); let length = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        length += bytesRead;
        if (bytesRead === 0 || length === buffer.length) break;
      }
      const after = await file.stat({ bigint: true });
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(length) !== after.size) return 'unstable';
      if (length > MAX_TEXT_BYTES) return undefined;
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); } catch { return undefined; }
      if (content.includes('\0')) return undefined;
      return { sha256: createHash('sha256').update(buffer.subarray(0, length)).digest('hex'), size: length, mtimeMs: Number(after.mtimeNs) / 1_000_000, content };
    } finally { await file.close(); }
  }
  private async scanAndCommit(): Promise<ReconcileResult> {
    const rootIdentity = await this.rootIdentity();
    const previous = this.inbox.getCheckpoint<WorkspaceCheckpoint>(this.config.sourceId, null, this.config.sourceGeneration)
      ?? { schema: 1 as const, root: this.root, generation: 0, files: {} };
    if (previous.schema !== 1 || previous.root !== this.root) throw new Error('Unsupported workspace checkpoint');
    const files: WorkspaceCheckpoint['files'] = Object.create(null) as WorkspaceCheckpoint['files'];
    const contents = new Map<string, FileSnapshot>();
    let visited = 0;
    const inspectFile = async (path: string): Promise<void> => {
      if (!this.included(path)) return;
      const rel = relative(this.root, path).split(sep).join('/');
      const file = await this.readText(path);
      if (file === 'unstable') { if (Object.hasOwn(previous.files, rel)) files[rel] = previous.files[rel]; return; }
      if (!file) return;
      const { content: _content, ...metadata } = file; files[rel] = metadata;
      if (!Object.hasOwn(previous.files, rel) || previous.files[rel].sha256 !== file.sha256) contents.set(rel, file);
    };
    const walk = async (directory: string): Promise<void> => {
      if (++visited > ROOT_FILE_LIMIT) throw new Error('Authorized directory exceeds the scan limit');
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !this.inside(await realpath(directory))) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (this.excluded(path) || entry.isSymbolicLink()) continue;
        if (++visited > ROOT_FILE_LIMIT) throw new Error('Authorized directory exceeds the scan limit');
        try {
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile()) await inspectFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Directory contents changed during scan; previous snapshot retained');
          throw error;
        }
      }
    };
    if (this.config.include?.length) {
      for (const observation of this.observationPlan) await this.validateObservationPath(observation.path);
      const ignore = [...IGNORED].flatMap(directory => [`**/${directory}/**`, `**/${directory}`]).concat(['**/.env', '**/.env.*']);
      const stream = fastGlob.stream(this.config.include, { cwd: this.root, onlyFiles: true, followSymbolicLinks: false, dot: true, unique: true, ignore, suppressErrors: false });
      for await (const entry of stream) {
        const path = resolve(this.root, String(entry));
        if (!this.inside(path) || this.excluded(path)) throw new Error('Glob result escaped the authorized source');
        if (++visited > ROOT_FILE_LIMIT) throw new Error('Authorized directory exceeds the scan limit');
        try { await inspectFile(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('File changed during scan; incomplete snapshot was not committed');
          throw error;
        }
      }
    } else await walk(this.root);
    if (await this.rootIdentity() !== rootIdentity) throw new Error('Authorized root changed during scan; previous snapshot retained');
    const result: ReconcileResult = { created: 0, updated: 0, deleted: 0 };
    const inputs: EventInput[] = []; let generation = previous.generation;
    for (const rel of Object.keys(files).sort()) {
      const file = contents.get(rel); if (!file) continue;
      const old = Object.hasOwn(previous.files, rel) ? previous.files[rel] : undefined; if (old?.sha256 === file.sha256) continue;
      const operation = old ? 'update' : 'create'; result[old ? 'updated' : 'created']++;
      inputs.push({ sourceId: this.config.sourceId, externalId: rel, kind: 'workspace.file', operation, actor: 'external',
        ...(this.config.sourceGeneration ? { sourceGeneration: this.config.sourceGeneration } : {}), ...(this.config.caseId ? { caseId: this.config.caseId } : {}),
        occurredAt: new Date(file.mtimeMs).toISOString(), version: `${++generation}:${file.sha256}`,
        payloadRef: `workspace:${this.config.sourceId}/${rel}`, payload: { relativePath: rel, ...file } });
    }
    for (const rel of Object.keys(previous.files).sort()) if (!(rel in files)) {
      result.deleted++;
      inputs.push({ sourceId: this.config.sourceId, externalId: rel, kind: 'workspace.file', operation: 'delete', actor: 'external',
        ...(this.config.sourceGeneration ? { sourceGeneration: this.config.sourceGeneration } : {}), ...(this.config.caseId ? { caseId: this.config.caseId } : {}),
        occurredAt: new Date().toISOString(), version: `${++generation}:deleted`,
        payloadRef: `workspace:${this.config.sourceId}/${rel}`, payload: { relativePath: rel, previousSha256: previous.files[rel].sha256 } });
    }
    this.inbox.ingestBatch(inputs, { sourceId: this.config.sourceId, sourceGeneration: this.config.sourceGeneration,
      value: { schema: 1, root: this.root, generation, files } satisfies WorkspaceCheckpoint });
    this.wakePending ||= inputs.length > 0;
    this.lastError = null;
    if (this.wakePending && !this.stopped) {
      try { this.config.onEvents?.(); this.wakePending = false; } catch { this.lastError = 'Events are durable, but the wake callback failed'; }
    }
    return result;
  }
}
