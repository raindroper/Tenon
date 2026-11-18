import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SharedFact } from './memory.js';
import type { PersonalMemorySubject } from '../../shared/personal-memory.js';

export class PersonalMemoryConflictError extends Error {
  readonly code = 'PERSONAL_MEMORY_REVISION_CONFLICT';
  constructor() { super('个人记忆已更新，请重新核对当前版本。'); }
}

/** Application-owned records only; Mastra's tables and private clients are never accessed. */
export class PersonalMemoryStore {
  private readonly db: DatabaseSync;
  constructor(file: string, private readonly ownerId: string, private readonly validate: (fact: SharedFact) => SharedFact) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rae_personal_memory_versions (
        seq INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, memory_key TEXT NOT NULL, revision INTEGER NOT NULL,
        json TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS rae_personal_memory_versions_key ON rae_personal_memory_versions(owner_id,memory_key,seq);
      CREATE TABLE IF NOT EXISTS rae_personal_memory_heads (
        owner_id TEXT NOT NULL, memory_key TEXT NOT NULL, version_seq INTEGER NOT NULL,
        PRIMARY KEY(owner_id,memory_key));
      CREATE TABLE IF NOT EXISTS rae_personal_memory_cutovers (
        owner_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1),
        archive_json TEXT, archive_hash TEXT NOT NULL, imported_count INTEGER NOT NULL, committed_at TEXT NOT NULL);`);
  }
  get migrated(): boolean { return !!this.db.prepare('SELECT 1 FROM rae_personal_memory_cutovers WHERE owner_id=?').get(this.ownerId); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Archive, import and authoritative cutover marker commit together; no cross-database atomicity is claimed. */
  importLegacy(raw: string | null, facts: readonly SharedFact[]): void {
    this.transaction(() => {
      if (this.migrated) return;
      const unexpected = this.db.prepare('SELECT 1 FROM rae_personal_memory_heads WHERE owner_id=? LIMIT 1').get(this.ownerId);
      if (unexpected) throw new Error('个人记忆迁移标记缺失但已有账本，未覆盖现存记录。');
      for (const fact of facts) this.append(this.validate(fact));
      this.db.prepare(`INSERT INTO rae_personal_memory_cutovers
        (owner_id,schema_version,archive_json,archive_hash,imported_count,committed_at) VALUES (?,1,?,?,?,?)`)
        .run(this.ownerId, raw, createHash('sha256').update(raw ?? '').digest('hex'), facts.length, new Date().toISOString());
    });
  }
  archive() {
    const row = this.db.prepare('SELECT archive_json,archive_hash,imported_count,committed_at FROM rae_personal_memory_cutovers WHERE owner_id=?').get(this.ownerId);
    return row ? { content: row.archive_json === null ? null : String(row.archive_json), hash: String(row.archive_hash),
      importedCount: Number(row.imported_count), committedAt: String(row.committed_at) } : undefined;
  }
  list(): SharedFact[] {
    if (!this.migrated) throw new Error('个人记忆迁移尚未提交。');
    return this.db.prepare(`SELECT v.json FROM rae_personal_memory_heads h JOIN rae_personal_memory_versions v ON v.seq=h.version_seq AND v.owner_id=h.owner_id AND v.memory_key=h.memory_key
      WHERE h.owner_id=? ORDER BY v.seq`).all(this.ownerId).map(row => this.validate(JSON.parse(String(row.json))));
  }
  page(offset = 0, limit = 50, subject?: PersonalMemorySubject) {
    if (!this.migrated) throw new Error('个人记忆迁移尚未提交。');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('记忆分页范围无效。');
    if (subject !== undefined && subject !== 'owner' && subject !== 'agent') throw new Error('个人记忆主体无效。');
    // One read snapshot returns the count even beyond the last page. Only LIMIT rows cross into JS.
    const rows = this.db.prepare(`WITH eligible AS (
        SELECT v.seq,v.json FROM rae_personal_memory_heads h JOIN rae_personal_memory_versions v
          ON v.seq=h.version_seq AND v.owner_id=h.owner_id AND v.memory_key=h.memory_key
        WHERE h.owner_id=? ${subject ? "AND COALESCE(json_extract(v.json,'$.personal.subject'),'owner')=?" : ''}
      ), page AS (SELECT seq,json FROM eligible ORDER BY seq DESC LIMIT ? OFFSET ?)
      SELECT page.json,counts.total FROM (SELECT COUNT(*) AS total FROM eligible) counts
        LEFT JOIN page ON 1=1 ORDER BY page.seq DESC`).all(this.ownerId, ...(subject ? [subject] : []), limit, offset);
    const total = Number(rows[0]?.total ?? 0);
    const facts = rows.filter(row => row.json !== null).map(row => this.validate(JSON.parse(String(row.json))));
    return { facts, total, offset, nextOffset: offset + facts.length < total ? offset + facts.length : null };
  }
  exportLedger() {
    if (!this.migrated) throw new Error('个人记忆迁移尚未提交。');
    return { schemaVersion: 1, archive: this.archive(), versions: this.db.prepare(`SELECT seq,memory_key,revision,json,recorded_at
      FROM rae_personal_memory_versions WHERE owner_id=? ORDER BY seq`).all(this.ownerId).map(row => ({
      sequence: Number(row.seq), key: String(row.memory_key), revision: Number(row.revision), recordedAt: String(row.recorded_at),
      fact: this.validate(JSON.parse(String(row.json))),
    })) };
  }
  private append(fact: SharedFact): void {
    const record = this.db.prepare(`INSERT INTO rae_personal_memory_versions(owner_id,memory_key,revision,json,recorded_at) VALUES (?,?,?,?,?)`)
      .run(this.ownerId, fact.key, fact.personal?.revision ?? 1, JSON.stringify(fact), new Date().toISOString());
    this.db.prepare(`INSERT INTO rae_personal_memory_heads(owner_id,memory_key,version_seq) VALUES (?,?,?)
      ON CONFLICT(owner_id,memory_key) DO UPDATE SET version_seq=excluded.version_seq`).run(this.ownerId, fact.key, record.lastInsertRowid);
  }
  mutate<T>(key: string, change: (existing: SharedFact | undefined, facts: readonly SharedFact[]) => { fact: SharedFact; result: T }, expectedRevision?: number): T {
    return this.transaction(() => {
      const facts = this.list(); const existing = facts.find(fact => fact.key === key);
      if (expectedRevision !== undefined && expectedRevision !== (existing?.personal?.revision ?? (existing ? 1 : 0))) throw new PersonalMemoryConflictError();
      const next = change(existing ? structuredClone(existing) : undefined, facts);
      const fact = this.validate(next.fact);
      if (fact.key !== key) throw new Error('记忆键不可在写入时替换。');
      if (!isDeepStrictEqual(existing, fact)) this.append(fact);
      return next.result;
    });
  }
  close(): void { this.db.close(); }
}
