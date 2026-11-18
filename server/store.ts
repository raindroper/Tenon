import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Activity, Artifact, Feedback, Initiative, Memory, Message, Run, Settings, SettingsInput, Source, TokenUsage } from '../shared/types.js';
import type { ImageAttachment } from '../shared/chat-images.js';
import type { ChatFileAttachment } from '../shared/chat-files.js';
import type { RuntimeView, RuntimeViewScope, RuntimeHistoryPage } from '../shared/runtime-view.js';
import { feedbackVersion } from './feedback-version.js';
import { SecretStore } from './secrets.js';
import type { PreparedImage } from './v2/images.js';
import type { StoredMediaJob } from './media/jobs.js';
import { usageDayWindow } from './usage-day.js';
import type { ModelCall } from '../shared/model-usage.js';
import { ModelConnections } from './models/connections.js';

export interface Collections {
  messages: Message; sources: Source; memories: Memory; initiatives: Initiative;
  artifacts: Artifact; activities: Activity; feedback: Feedback; runs: Run;
  mediaJobs: StoredMediaJob;
  modelCalls: ModelCall;
}
export type CollectionName = keyof Collections;
export const COLLECTION_NAMES: CollectionName[] = ['messages', 'sources', 'memories', 'initiatives', 'artifacts', 'activities', 'feedback', 'runs', 'mediaJobs', 'modelCalls'];
const MESSAGE_PAGE_SIZE = 40;
const MEDIA_REFERENCE_LIMIT = 12;
/** Data compatibility, independent of the public RuntimeApi view version. */
export const KERNEL_SCHEMA_VERSION = 9 satisfies RuntimeView['schemaVersion'];
export class OwnerMessageRequestConflict extends Error {}
export interface PreparedChatFile { attachment: ChatFileAttachment; data: Buffer }

const apiUrl = z.string().trim().url().max(500).refine(value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}, '模型地址需为 HTTPS，或本机测试地址。');
export const SettingsInputSchema = z.object({
  agentName: z.string().trim().min(1).max(80).optional(), ownerName: z.string().trim().max(80).optional(),
  mission: z.string().trim().min(1).max(20_000).optional(), model: z.string().trim().min(1).max(120).optional(),
  apiBaseUrl: apiUrl.optional(), apiKey: z.string().trim().min(1).max(8192).optional(), clearApiKey: z.boolean().optional(),
  enabled: z.boolean().optional(),
  // Legacy settings configure only the original DeepSeek connection. New model bindings own provider-specific values.
  reasoningEffort: z.enum(['auto', 'none', 'low', 'high', 'max']).optional(),
  maxOutputTokens: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  maxOutputContinuations: z.number().int().min(0).max(1).optional(),
  maxStepsPerRun: z.number().int().min(1).max(50).optional(),
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, '时区无效。').optional(),
}).strict().refine(value => !(value.apiKey && value.clearApiKey), '不能同时保存并清除密钥。');

const LEGACY_MISSION = '持续了解我，独立思考什么值得为我做，主动发现需求、探索有价值的目标并付诸行动。根据真实资料和反馈更新理解；区分事实与假设，允许小步试错，不为显得忙碌而制造任务。';
const DEFAULT_SETTINGS: Omit<Settings, 'apiKeyConfigured'> = {
  agentName: '榫', ownerName: '',
  mission: '在已授权信息内持续理解我，同时积累可核查的知识和方法，改善自己的判断与相处方式。独立思考什么值得了解、学习或交流，自主规划和日常提醒；实际产出任务先取得我的明确允许。允许有证据且可纠正的假设，不以制造工作、交付物或消耗token证明成长。',
  model: 'deepseek-flash', apiBaseUrl: 'https://api.deepseek.com/v1', enabled: false,
  reasoningEffort: 'auto', maxOutputTokens: null, maxOutputContinuations: 1, maxStepsPerRun: 20, timezone: 'Asia/Shanghai',
};

export class Store {
  readonly models: ModelConnections;
  private readonly db: DatabaseSync;
  private readonly secrets: SecretStore;
  private transactionDepth = 0;
  private changedInTransaction = false;
  private readonly changeListeners = new Set<() => void>();
  private documents?: Pick<RuntimeView, 'sources' | 'artifacts'>;
  private usageWindow?: { timezone: string; from: number; until: number };
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.secrets = new SecretStore(dataDir);
    const path = join(dataDir, 'rae.sqlite');
    this.db = new DatabaseSync(path);
    const hasMetadata = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get();
    const kernelVersion = hasMetadata ? this.db.prepare("SELECT json FROM metadata WHERE key='kernel.schemaVersion'").get()?.json : undefined;
    if (kernelVersion !== undefined) {
      let version: unknown;
      try { version = JSON.parse(String(kernelVersion)); } catch { this.db.close(); throw new Error('内核数据版本无效，请从完整备份核对。'); }
      if (!Number.isInteger(version) || Number(version) < 1 || Number(version) > KERNEL_SCHEMA_VERSION) {
        this.db.close(); throw new Error('当前程序不支持此内核数据版本，请使用匹配版本；不能直接降级写入数据。');
      }
    }
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_order ON records(kind,created_at,id);
      CREATE INDEX IF NOT EXISTS records_history_order ON records(kind,created_at);
      CREATE INDEX IF NOT EXISTS records_run_case_order ON records(json_extract(json,'$.caseId'),created_at) WHERE kind='runs';
      CREATE INDEX IF NOT EXISTS records_run_event ON records(json_extract(json,'$.eventId')) WHERE kind='runs';
      CREATE INDEX IF NOT EXISTS records_run_status_case ON records(json_extract(json,'$.status'),json_extract(json,'$.caseId')) WHERE kind='runs';
      CREATE INDEX IF NOT EXISTS records_task_execution_order
        ON records(json_extract(json,'$.taskId'),json_extract(json,'$.taskExecution.requirementsRevision'),created_at)
        WHERE kind='runs' AND json_type(json,'$.taskExecution')='object';
      CREATE INDEX IF NOT EXISTS records_run_usage_day ON records(kind,julianday(created_at));
      CREATE INDEX IF NOT EXISTS records_message_order ON records(created_at) WHERE kind='messages';
      CREATE INDEX IF NOT EXISTS records_message_case_order ON records(json_extract(json,'$.caseId'),created_at) WHERE kind='messages';
      CREATE INDEX IF NOT EXISTS records_message_case_image_order ON records(json_extract(json,'$.caseId'),created_at)
        WHERE kind='messages' AND json_extract(json,'$.role')='user' AND json_array_length(json,'$.attachments') > 0;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_images (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS message_files (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_message_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, message_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS owner_message_requests_message ON owner_message_requests(message_id);`);
    this.models = new ModelConnections(this, dataDir);
  }
  private kind(name: CollectionName): void { if (!COLLECTION_NAMES.includes(name)) throw new Error('未知数据集合。'); }
  /** Notifications follow durable commits; readers never observe a rolled-back partial write. */
  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); };
  }
  private changed(): void {
    if (this.transactionDepth) { this.changedInTransaction = true; return; }
    for (const listener of this.changeListeners) { try { listener(); } catch {} }
  }
  list<K extends CollectionName>(name: K): Collections[K][] {
    this.kind(name);
    return this.db.prepare('SELECT json FROM records WHERE kind=? ORDER BY created_at,rowid').all(name)
      .map(row => JSON.parse(String(row.json)) as Collections[K]);
  }
  runHistory({ caseId, before }: { caseId?: string; before?: string } = {}): RuntimeHistoryPage<Run> | undefined {
    const scope = caseId === undefined ? '' : " AND json_extract(json,'$.caseId')=?";
    const values = caseId === undefined ? [] : [caseId];
    const anchor = before === undefined ? undefined : this.db.prepare(`SELECT rowid,created_at FROM records WHERE kind='runs' AND id=?${scope}`).get(before, ...values);
    if (before !== undefined && !anchor) return;
    const rows = this.db.prepare(`SELECT json FROM records WHERE kind='runs'${scope}${anchor ? ' AND (created_at,rowid)<(?,?)' : ''}
      ORDER BY created_at DESC,rowid DESC LIMIT 41`).all(...values, ...(anchor ? [String(anchor.created_at), Number(anchor.rowid)] : []));
    const items = rows.slice(0, 40).map(row => JSON.parse(String(row.json)) as Run);
    return { items: items.reverse(), nextBefore: rows.length > 40 ? items[0].id : null };
  }
  taskExecutionRuns(taskId: string): Run[] {
    return this.db.prepare(`SELECT json FROM records WHERE kind='runs' AND json_type(json,'$.taskExecution')='object'
      AND json_extract(json,'$.taskId')=? ORDER BY json_extract(json,'$.taskExecution.requirementsRevision'),created_at,rowid`)
      .all(taskId).map(row => JSON.parse(String(row.json)) as Run);
  }
  latestTaskExecutionRun(taskId: string): Run | undefined {
    const row = this.db.prepare(`SELECT json FROM records WHERE kind='runs' AND json_type(json,'$.taskExecution')='object'
      AND json_extract(json,'$.taskId')=? ORDER BY json_extract(json,'$.taskExecution.requirementsRevision') DESC,created_at DESC,rowid DESC LIMIT 1`)
      .get(taskId);
    return row ? JSON.parse(String(row.json)) as Run : undefined;
  }
  conversationRuns({ runIds, eventIds, caseId }: { runIds: readonly string[]; eventIds: readonly string[]; caseId?: string }): Run[] {
    if (runIds.length > MESSAGE_PAGE_SIZE || eventIds.length > MESSAGE_PAGE_SIZE) throw new Error('Run associations exceed the visible message page');
    // A quiet long-running request may be older than the recent-run page and
    // have no assistant text yet. Its owner event, or active case membership,
    // still anchors its saved progress without loading unrelated run history.
    const conditions: string[] = []; const values: string[] = [];
    if (runIds.length) { conditions.push(`id IN (${runIds.map(() => '?').join(',')})`); values.push(...runIds); }
    if (eventIds.length) { conditions.push(`json_extract(json,'$.eventId') IN (${eventIds.map(() => '?').join(',')})`); values.push(...eventIds); }
    conditions.push(`(json_extract(json,'$.status')='running'${caseId === undefined ? '' : " AND json_extract(json,'$.caseId')=?"})`);
    if (caseId !== undefined) values.push(caseId);
    return this.db.prepare(`SELECT json FROM records WHERE kind='runs' AND (${conditions.join(' OR ')}) ORDER BY created_at,rowid`)
      .all(...values).map(row => JSON.parse(String(row.json)) as Run);
  }
  /** Immutable view reused across reply checkpoints. SQLite remains the document authority. */
  publicDocuments(): Pick<RuntimeView, 'sources' | 'artifacts'> {
    if (!this.transactionDepth && this.documents) return this.documents;
    const view = Object.freeze({
      sources: Object.freeze(this.list('sources').map(source => Object.freeze(source))),
      artifacts: Object.freeze(this.list('artifacts').map(artifact => Object.freeze({ ...artifact,
        status: artifact.status ?? 'prepared' as const, feedbackVersion: feedbackVersion(artifact.content) }))),
    });
    if (!this.transactionDepth) this.documents = view;
    return view;
  }
  get<K extends CollectionName>(name: K, id: string): Collections[K] | undefined {
    this.kind(name);
    const row = this.db.prepare('SELECT json FROM records WHERE kind=? AND id=?').get(name, id);
    return row ? JSON.parse(String(row.json)) as Collections[K] : undefined;
  }
  messagePage({ caseId, before }: RuntimeViewScope) {
    const anchor = before === undefined ? undefined : this.db.prepare(`
      SELECT created_at, rowid AS sequence FROM records
      WHERE kind='messages' AND id=? AND json_extract(json,'$.caseId')=?`).get(before, caseId ?? null);
    if (before !== undefined && !anchor) return undefined;
    const rows = this.db.prepare(`
      SELECT message.json, substr(coalesce(nullif(json_extract(target.json,'$.content'), ''), json_extract(target.json,'$.files[0].name')),1,100) AS reply_preview,
        (SELECT request_id FROM owner_message_requests WHERE message_id=message.id LIMIT 1) AS request_id
      FROM (
        SELECT id, json, created_at, rowid AS sequence
        FROM records ${caseId === undefined ? 'INDEXED BY records_message_order' : ''}
        WHERE kind='messages'
        ${caseId === undefined ? '' : "AND json_extract(json,'$.caseId')=?"}
        ${anchor ? 'AND (created_at,rowid) < (?,?)' : ''}
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) AS message
      LEFT JOIN records AS target ON target.kind='messages' AND target.id=json_extract(message.json,'$.replyTo')
        AND json_extract(target.json,'$.caseId')=json_extract(message.json,'$.caseId')
      ORDER BY message.created_at DESC, message.sequence DESC`).all(
        ...(caseId === undefined ? [] : [caseId]),
        ...(anchor ? [String(anchor.created_at), Number(anchor.sequence)] : []),
        MESSAGE_PAGE_SIZE + 1);
    const messages = rows.slice(0, MESSAGE_PAGE_SIZE).reverse().map(row => ({
      ...(JSON.parse(String(row.json)) as Message),
      ...(typeof row.reply_preview === 'string' && row.reply_preview ? { replyPreview: row.reply_preview } : {}),
      ...(typeof row.request_id === 'string' ? { requestId: row.request_id } : {}),
    }));
    return { messages, beforeCreatedAt: anchor ? String(anchor.created_at) : null,
      nextBefore: caseId !== undefined && rows.length > MESSAGE_PAGE_SIZE ? messages[0].id : null };
  }
  messagePreviews(caseIds: string[]): Record<string, string> {
    const latest = this.db.prepare(`
      SELECT substr(coalesce(nullif(json_extract(json,'$.content'), ''), json_extract(json,'$.files[0].name'), ''),1,160) AS preview FROM records
      WHERE kind='messages' AND json_extract(json,'$.caseId')=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`);
    return Object.fromEntries(caseIds.flatMap(caseId => {
      const preview = latest.get(caseId)?.preview;
      return typeof preview === 'string' ? [[caseId, preview]] : [];
    }));
  }
  notificationMessages(): NonNullable<RuntimeView['notificationMessages']> {
    // Bound the scan before projecting: no whole-history hydration on stream checkpoints.
    return this.db.prepare(`SELECT id, created_at, json_extract(json,'$.caseId') AS case_id,
      CASE WHEN json_extract(json,'$.outputState')='streaming' THEN '' ELSE substr(json_extract(json,'$.content'),1,160) END AS preview,
      json_extract(json,'$.outputState') AS output_state
      FROM (SELECT id,json,created_at,rowid AS sequence FROM records INDEXED BY records_message_order
        WHERE kind='messages' ORDER BY created_at DESC,rowid DESC LIMIT 100)
      WHERE json_extract(json,'$.role')='assistant' ORDER BY created_at,sequence`).all().map(row => ({
      id: String(row.id), createdAt: String(row.created_at), preview: String(row.preview ?? ''),
      ...(typeof row.case_id === 'string' ? { caseId: row.case_id } : {}),
      ...(typeof row.output_state === 'string' ? { outputState: row.output_state as Message['outputState'] } : {}),
    }));
  }
  recentCaseImages(caseId: string): ImageAttachment[] {
    const rows = this.db.prepare(`
      SELECT json_extract(json,'$.attachments') AS attachments FROM records
      WHERE kind='messages' AND json_extract(json,'$.caseId')=? AND json_extract(json,'$.role')='user'
        AND json_array_length(json,'$.attachments') > 0
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(caseId, MEDIA_REFERENCE_LIMIT);
    return rows.reverse().flatMap(row => JSON.parse(String(row.attachments)) as ImageAttachment[]).slice(-MEDIA_REFERENCE_LIMIT);
  }
  hasCaseMessages(caseId: string, excludingMessageId?: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM records WHERE kind='messages' AND json_extract(json,'$.caseId')=? AND id IS NOT ? LIMIT 1
    `).get(caseId, excludingMessageId ?? null));
  }
  searchChatHistory(caseId: string, beforeMessageId: string, query: string, ownerCaseIds: readonly string[]) {
    const rows = this.db.prepare(`
      WITH matches AS (
        SELECT history.id, history.created_at, history.rowid AS sequence,
          json_extract(history.json,'$.caseId') AS case_id,
          json_extract(history.json,'$.content') AS content,
          instr(lower(json_extract(history.json,'$.content')), lower(?)) AS hit
        FROM records AS anchor JOIN records AS history
          ON (history.created_at, history.rowid) < (anchor.created_at, anchor.rowid)
        WHERE anchor.kind='messages' AND anchor.id=? AND json_extract(anchor.json,'$.caseId')=?
          AND json_extract(anchor.json,'$.role')='user'
          AND history.kind='messages' AND case_id IN (SELECT value FROM json_each(?))
          AND json_extract(history.json,'$.role')='user' AND hit > 0
        ORDER BY history.created_at DESC, history.rowid DESC LIMIT 20
      )
      SELECT id, case_id, created_at, max(hit-201,0) AS excerpt_offset,
        substr(content,max(hit-200,1),1000) AS excerpt, length(content) AS total_characters
      FROM matches ORDER BY created_at DESC, sequence DESC`).all(query, beforeMessageId, caseId, JSON.stringify(ownerCaseIds));
    return rows.map(row => ({ messageId: String(row.id), caseId: String(row.case_id), createdAt: String(row.created_at),
      excerpt: String(row.excerpt), offset: Number(row.excerpt_offset), totalCharacters: Number(row.total_characters) }));
  }
  readOwnerChatHistory(caseId: string, beforeMessageId: string, selection: { ids: readonly string[] } | { after: string }): Message[] {
    if ('ids' in selection && selection.ids.length === 0) return [];
    const after = 'after' in selection;
    const filter = after ? `EXISTS (
      SELECT 1 FROM records AS hit WHERE hit.kind='messages' AND hit.id=?
        AND json_extract(hit.json,'$.caseId')=json_extract(history.json,'$.caseId')
        AND (hit.created_at, hit.rowid) < (history.created_at, history.rowid)
    )` : 'history.id IN (SELECT value FROM json_each(?))';
    const rows = this.db.prepare(`
      SELECT history.json FROM records AS anchor JOIN records AS history
        ON (history.created_at, history.rowid) < (anchor.created_at, anchor.rowid)
      WHERE anchor.kind='messages' AND anchor.id=? AND json_extract(anchor.json,'$.caseId')=?
        AND json_extract(anchor.json,'$.role')='user'
        AND history.kind='messages' AND json_extract(history.json,'$.role')='user' AND ${filter}
      ORDER BY history.created_at DESC, history.rowid DESC LIMIT 20
    `).all(beforeMessageId, caseId, after ? selection.after : JSON.stringify(selection.ids));
    return rows.map(row => JSON.parse(String(row.json)) as Message);
  }
  private record<K extends CollectionName>(name: K, item: Collections[K], update: boolean): Collections[K] {
    this.kind(name);
    if (!item.id || item.id.length > 200) throw new Error('记录 ID 无效。');
    const timestamp = 'createdAt' in item ? item.createdAt : item.startedAt;
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error('记录时间无效。');
    const json = JSON.stringify(item);
    this.db.prepare(`INSERT INTO records(kind,id,json,created_at) VALUES(?,?,?,?)${update ? ' ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json' : ''}`)
      .run(name, item.id, json, timestamp);
    if (name === 'sources' || name === 'artifacts') this.documents = undefined;
    this.changed();
    return structuredClone(item);
  }
  put<K extends CollectionName>(name: K, item: Collections[K]): Collections[K] { return this.record(name, item, true); }
  insert<K extends CollectionName>(name: K, item: Collections[K]): Collections[K] { return this.record(name, item, false); }
  remove<K extends CollectionName>(name: K, id: string): void {
    this.kind(name); this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(name, id);
    if (name === 'sources' || name === 'artifacts') this.documents = undefined;
    this.changed();
  }
  ownerMessageRequest(requestId: string): { fingerprint: string; message: Message } | undefined {
    const row = this.db.prepare('SELECT fingerprint,message_id FROM owner_message_requests WHERE request_id=?').get(requestId);
    if (!row) return undefined;
    const message = this.get('messages', String(row.message_id));
    if (!message || message.role !== 'user') throw new Error('已接收消息的持久记录缺失，不能重新提交。');
    return { fingerprint: String(row.fingerprint), message };
  }
  insertOwnerMessage(message: Message, images: PreparedImage[], request?: { id: string; fingerprint: string }, files: PreparedChatFile[] = []): Message {
    return this.atomic(() => {
      const existing = request && this.ownerMessageRequest(request.id);
      if (existing) {
        if (existing.fingerprint !== request!.fingerprint) throw new OwnerMessageRequestConflict('消息提交编号已绑定其他内容或范围。');
        return existing.message;
      }
      this.insert('messages', message);
      for (const image of images) this.db.prepare('INSERT INTO message_images(id,message_id,data) VALUES(?,?,?)').run(image.attachment.id, message.id, image.data);
      for (const file of files) this.db.prepare('INSERT INTO message_files(id,message_id,data) VALUES(?,?,?)').run(file.attachment.id, message.id, file.data);
      if (request) this.db.prepare('INSERT INTO owner_message_requests(request_id,fingerprint,message_id) VALUES(?,?,?)').run(request.id, request.fingerprint, message.id);
      return message;
    });
  }
  readImage(id: string) {
    const row = this.db.prepare('SELECT message_id,data FROM message_images WHERE id=?').get(id);
    if (!row) return undefined;
    const message = this.get('messages', String(row.message_id));
    const attachment = message?.role === 'user' && message.attachments?.find(item => item.id === id);
    if (!message?.caseId || !attachment) return undefined;
    return { attachment, data: Buffer.from(row.data as Uint8Array), messageId: message.id, caseId: message.caseId };
  }
  readChatFile(id: string, expectedMessageId?: string) {
    const row = expectedMessageId === undefined
      ? this.db.prepare('SELECT message_id,data FROM message_files WHERE id=?').get(id)
      : this.db.prepare('SELECT message_id,data FROM message_files WHERE id=? AND message_id=?').get(id, expectedMessageId);
    if (!row) return undefined;
    const message = this.get('messages', String(row.message_id));
    const attachment = message?.role === 'user' && message.files?.find(file => file.id === id);
    if (!message?.caseId || !attachment || !(row.data instanceof Uint8Array) || row.data.byteLength !== attachment.size) return undefined;
    return { attachment, data: Buffer.from(row.data), messageId: message.id, caseId: message.caseId };
  }
  atomic<T>(work: () => T): T {
    if (this.transactionDepth) return work();
    this.db.exec('BEGIN IMMEDIATE'); this.transactionDepth++; this.changedInTransaction = false;
    let committed = false;
    try { const result = work(); this.db.exec('COMMIT'); committed = true; return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally {
      this.transactionDepth--; const changed = this.changedInTransaction; this.changedInTransaction = false;
      if (committed && changed) this.changed();
    }
  }
  getMeta<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT json FROM metadata WHERE key=?').get(key);
    return row ? JSON.parse(String(row.json)) as T : structuredClone(fallback);
  }
  setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO metadata(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, JSON.stringify(value));
    this.changed();
  }
  getApiKey(): string | undefined { return process.env.DEEPSEEK_API_KEY?.trim() || this.secrets.get(); }
  getSettings(): Settings {
    // Retired pricing configuration must not invalidate the owner's saved model/identity.
    const { dailyBudgetCny: _retiredBudget, ...saved } = this.getMeta<Record<string, unknown>>('settings', {});
    const parsed = SettingsInputSchema.safeParse(saved);
    const safe = parsed.success ? parsed.data : {};
    const { apiKey: _apiKey, clearApiKey: _clear, ...values } = safe;
    // Earlier saves materialized the old default even when only unrelated settings changed.
    if (values.agentName === 'Rae' && !this.getMeta('settings.agentNameExplicit', false)) values.agentName = DEFAULT_SETTINGS.agentName;
    const retiredGrowthMission = '在已授权信息与预算内持续理解我，同时积累可核查的知识和方法，改善自己的判断与相处方式。独立思考什么值得了解、学习或交流，自主规划和日常提醒；实际产出任务先取得我的明确允许。允许有证据且可纠正的假设，不以制造工作、交付物或消耗预算证明成长。';
    if (values.mission === LEGACY_MISSION || values.mission === retiredGrowthMission) values.mission = DEFAULT_SETTINGS.mission;
    return { ...DEFAULT_SETTINGS, ...values, enabledRevision: this.getMeta<number>('settings.enabledRevision', 0), apiKeyConfigured: Boolean(this.getApiKey()) };
  }
  async updateSettings(input: SettingsInput): Promise<Settings> {
    const { apiKey, clearApiKey, ...values } = SettingsInputSchema.parse(input);
    if (apiKey !== undefined || clearApiKey) this.secrets.set(clearApiKey ? undefined : apiKey);
    const { apiKeyConfigured: _configured, enabledRevision = 0, ...current } = this.getSettings();
    const connectionChanged = values.model !== undefined && values.model !== current.model
      || values.apiBaseUrl !== undefined && values.apiBaseUrl !== current.apiBaseUrl;
    const outputLimit = connectionChanged && values.maxOutputTokens === undefined ? { maxOutputTokens: null } : {};
    const reasoning = connectionChanged && values.reasoningEffort === undefined ? { reasoningEffort: 'auto' as const } : {};
    this.atomic(() => {
      // Every explicit enable/pause intent advances the version, including ABA and repeated pauses.
      if (values.enabled !== undefined) this.setMeta('settings.enabledRevision', enabledRevision + 1);
      if (values.agentName !== undefined) this.setMeta('settings.agentNameExplicit', true);
      this.setMeta('settings', { ...current, ...outputLimit, ...reasoning, ...values });
    });
    if (apiKey !== undefined || clearApiKey || values.model !== undefined || values.apiBaseUrl !== undefined ||
      values.reasoningEffort !== undefined || values.maxOutputTokens !== undefined) {
      this.models.syncLegacySettings(this.getSettings(), apiKey !== undefined || Boolean(clearApiKey));
    }
    return this.getSettings();
  }
  todayUsage(): TokenUsage {
    const timezone = this.getSettings().timezone;
    const timestamp = Date.now();
    if (!this.usageWindow || this.usageWindow.timezone !== timezone || timestamp < this.usageWindow.from || timestamp >= this.usageWindow.until) {
      this.usageWindow = { timezone, ...usageDayWindow(timestamp, timezone) };
    }
    const row = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN json_type(json,'$.inputTokens') IN ('integer','real') AND json_extract(json,'$.inputTokens')>0 THEN json_extract(json,'$.inputTokens') ELSE 0 END),0) AS input,
      COALESCE(SUM(CASE WHEN json_type(json,'$.outputTokens') IN ('integer','real') AND json_extract(json,'$.outputTokens')>0 THEN json_extract(json,'$.outputTokens') ELSE 0 END),0) AS output,
      COALESCE(MAX(CASE
        WHEN COALESCE(json_extract(json,'$.pendingModelCalls'),0)>0 THEN 2
        WHEN json_extract(json,'$.usageStatus')='not_used' AND COALESCE(json_extract(json,'$.inputTokens'),0)=0 AND COALESCE(json_extract(json,'$.outputTokens'),0)=0 THEN 0
        WHEN json_extract(json,'$.usageStatus')='reported' THEN 0
        WHEN json_extract(json,'$.usageStatus')='partial' THEN 1 ELSE 2 END),0) AS status
      FROM records WHERE kind='runs' AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)`)
      .get(new Date(this.usageWindow.from).toISOString(), new Date(this.usageWindow.until).toISOString())!;
    return { inputTokens: Number(row.input), outputTokens: Number(row.output), usageStatus: (['reported', 'partial', 'unknown'] as const)[Number(row.status)] };
  }
  close(): void { this.changeListeners.clear(); this.db.close(); }
}
