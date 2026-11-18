import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { projectDeliveryProblem } from '../../shared/project-contract.js';
import type { TaskCapability, TaskEvidenceRef, TaskRecord, TaskSpec, TaskState } from '../../shared/task-consent.js';
import { EventInbox, type EventInput, type InboxEvent } from './events.js';
import { mediaSpecSchema } from '../../shared/media.js';
import { commandFailureMessage, deviceCommandSpecSchema, type DeviceOperation } from '../../shared/local-device.js';
import { analysisPendingNote, finalDeviceReceipt, matchesDeviceTask } from './device-results.js';
import { MAX_TASK_EVIDENCE_REFS, TASK_SOURCE_KINDS } from './task-context.js';
import { mailTaskSpecSchema } from '../../shared/mail.js';
import { githubTaskSpecCanonicalJson, githubTaskSpecSchema, GITHUB_OPERATIONS_PREFIX, type GitHubOperation, type GitHubTaskReceipt } from '../../shared/github.js';
import type { Store } from '../store.js';
import type { ModelBinding } from '../../shared/model-connections.js';
import { matchingMailOperation, mailOperationReceipt, mailFailureMessage } from './mail-results.js';
import { localProjectSpecSchema, projectRequestSchema, projectOwnerQuestionSchema, type LocalProjectSpec, type ProjectOperation, type ProjectToolItem, type ServerProjectResources } from '../../shared/local-project.js';
import { projectSpecHash } from '../devices/projects.js';
import { projectFinalFileSnapshot } from '../devices/project-files.js';
import { requiresProjectFileDelivery } from '../../shared/project-files.js';
import { taskAcceptanceSchema, taskWaitInputSchema, latestStageReviews, projectStageDecision, projectStageReviewContent,
  projectStageApproved, projectStageRejected, taskStageReviewMode, taskFinalFiles, taskFinalFilesUpdateSchema,
  type TaskAnswer, type TaskDependency, type TaskFinalFilesUpdate, type TaskFlowView, type TaskWaitInput } from '../../shared/task-flow.js';

const nonempty = (maximum: number) => z.string().trim().min(1).max(maximum);
const identifier = nonempty(200).regex(/^[A-Za-z0-9_-]+$/);
const revisionSchema = z.number().int().min(1);
const workspaceFile = z.string().min(1).max(2000).refine(value => !value.startsWith('/') && !/[\\\0]/.test(value)
  && value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part)), '须指定精确的工作区相对文件路径。');
const taskScopeSchema = z.object({
  caseId: identifier,
  title: nonempty(200),
  objective: nonempty(8000),
  expectedOutput: nonempty(2000),
  capabilities: z.array(z.enum(['artifact', 'workspace', 'media', 'local-command', 'mail', 'github', 'project', 'review'])).max(8).refine(values => new Set(values).size === values.length),
  media: mediaSpecSchema.optional(),
  command: deviceCommandSpecSchema.optional(),
  mail: mailTaskSpecSchema.optional(),
  github: githubTaskSpecSchema.optional(),
  project: z.unknown().optional(), // Overridden below; preserve the key order of saved scopes.
  directoryAnalysis: z.literal(true).optional(),
  acceptance: taskAcceptanceSchema.optional(),
  projectSelection: z.object({ reason: nonempty(2000) }).strict().optional(),
  review: z.object({ dependencyId: identifier, dependencyRevision: revisionSchema, eventIds: z.array(nonempty(300)).min(1).max(60) }).strict().optional(),
  workspace: z.object({ revision: revisionSchema, files: z.array(workspaceFile).min(1).max(50)
    .refine(files => new Set(files).size === files.length, '工作区文件不能重复。') }).strict().optional(),
}).strict();
function validateTaskScope(spec: z.infer<typeof taskScopeSchema>, context: z.RefinementCtx): void {
  const rules: Array<[boolean, string]> = [
    [spec.projectSelection ? spec.capabilities.length === 0 && !spec.project && !spec.mail && !spec.github && !spec.media && !spec.command && !spec.workspace : spec.capabilities.length > 0, '项目提案待本人选择执行范围；未选择前不能附带执行能力。'],
    [spec.capabilities.includes('workspace') === Boolean(spec.workspace), '工作区任务必须绑定授权版本和精确文件范围，文本任务不附带工作区权限。'],
    [spec.capabilities.includes('project') === Boolean(spec.project) && (!spec.project || spec.capabilities.length === 1), '项目任务须绑定设备和工作区，由内置执行引擎完成交付。'],
    [spec.capabilities.includes('mail') === Boolean(spec.mail) && (!spec.mail || spec.capabilities.length === 1), '邮件任务须绑定精确邮箱和邮件范围，且独立执行。'],
    [spec.capabilities.includes('github') === Boolean(spec.github) && (!spec.github || spec.capabilities.every(value => value === 'github' || value === 'artifact')), 'GitHub 任务须绑定精确仓库与操作范围，只能组合文本交付。'],
    [spec.capabilities.includes('media') === Boolean(spec.media) && (!spec.media || spec.capabilities.length === 1), '当前媒体任务仅支持独立生成，不能与设备或文件步骤混合执行。'],
    [spec.capabilities.includes('local-command') === Boolean(spec.command), '本地操作须绑定设备、精确参数及本次可访问范围。'],
    [!spec.command || ('kind' in spec.command ? spec.capabilities.every(value => value === 'local-command' || value === 'artifact') : spec.capabilities.length === 1), '当前只读目录查询可组合文本交付；精确程序命令仍作为独立任务执行。'],
    [!spec.directoryAnalysis || Boolean(spec.command && 'kind' in spec.command), '文件分析须绑定本次只读目录查询。'],
    [spec.capabilities.includes('review') === Boolean(spec.review) && (!spec.review || spec.capabilities.length === 1), '输入回顾只接收原任务关联的资料。'],
    [spec.acceptance?.stageReview !== 'owner' || Boolean(spec.project || spec.projectSelection), '逐阶段人工审核需要项目执行器，请选择项目任务。'],
    [spec.acceptance?.finalFiles === undefined || Boolean(spec.project || spec.projectSelection), '最终文件要求只适用于项目任务。'],
  ];
  for (const [valid, message] of rules) if (!valid) context.addIssue({ code: 'custom', message });
}
export const taskSpecSchema = taskScopeSchema.extend({ project: localProjectSpecSchema.optional() }).superRefine(validateTaskScope);
export const taskRequestSpecSchema = taskScopeSchema.extend({ project: projectRequestSchema.optional() }).superRefine(validateTaskScope);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const activeStates = new Set<TaskState>(['approved', 'running']);
const evidenceRefSchema = z.object({ eventId: nonempty(300), sourceId: nonempty(300), sourceCaseId: nonempty(300),
  sourceGeneration: nonempty(300).optional() }).strict();
const evidenceIdentity = (reference: TaskEvidenceRef) => JSON.stringify([reference.eventId, reference.sourceId, reference.sourceCaseId, reference.sourceGeneration ?? null]);
const sameEvidence = (left: readonly TaskEvidenceRef[], right: readonly TaskEvidenceRef[]) =>
  JSON.stringify(left.map(evidenceIdentity).sort()) === JSON.stringify(right.map(evidenceIdentity).sort());
interface TaskRow { json: string }
interface OutboxRow { task_id: string; event_json: string; delivered_at: string | null }
export type ConsentErrorCode = 'not_found' | 'conflict' | 'not_approved' | 'invalid_scope';
export class TaskConsentError extends Error {
  constructor(readonly code: ConsentErrorCode, message: string) { super(message); this.name = 'TaskConsentError'; }
}
export interface TaskConsentOptions { file: string; inbox: EventInbox; modelBinding?: (caseId: string, sourceEventId?: string) => ModelBinding | null | undefined }

export function isOwnerChatEvent(event?: InboxEvent): boolean {
  return Boolean(event && event.actor === 'owner' && event.kind === 'owner.message' && event.sourceId === 'owner-chat'
    && typeof event.payload.messageId === 'string' && event.payload.messageId === event.externalId
    && typeof event.payload.content === 'string' && event.payload.content.trim());
}

/** Task permission is authoritative here. Workspace grants never create it. */
export class TaskConsent {
  private readonly db: DatabaseSync;
  private readonly inbox: EventInbox;
  private transactionDepth = 0;
  constructor(private readonly options: TaskConsentOptions) {
    const file = options.file === ':memory:' ? options.file : resolve(options.file);
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    if (file !== ':memory:' && options.inbox.file !== file) throw new Error('Task consent and inbox must share the same SQLite file');
    this.inbox = options.inbox;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS task_consents (
        id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, case_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('proposed','approved','running','completed','failed','rejected','revoked')),
        revision INTEGER NOT NULL, spec_json TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_consents_case ON task_consents(case_id,state);
      CREATE INDEX IF NOT EXISTS task_consents_running ON task_consents(state) WHERE state='running';
      CREATE INDEX IF NOT EXISTS task_consents_mail ON task_consents(state) WHERE json_type(spec_json,'$.mail')='object';
      CREATE TABLE IF NOT EXISTS task_execution_outbox (
        task_id TEXT PRIMARY KEY REFERENCES task_consents(id), event_json TEXT NOT NULL, delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS task_goals (
        task_id TEXT PRIMARY KEY REFERENCES task_consents(id), accepted_event_id TEXT, accepted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS task_dependencies (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_consents(id), operation_id TEXT NOT NULL REFERENCES task_consents(id),
        request_key TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(operation_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS task_dependencies_pending ON task_dependencies(state,task_id);
      CREATE INDEX IF NOT EXISTS task_dependencies_operation ON task_dependencies(operation_id,state);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS task_flow_migrations(version INTEGER PRIMARY KEY,json TEXT NOT NULL)');
    // The historical table stores exact operation consents. Every old task is a
    // one-operation goal, with unchanged IDs, immutable specs and outbox records.
    this.atomic(() => {
      const columns = this.db.prepare('PRAGMA table_info(task_consents)').all();
      if (!columns.some(column => column.name === 'root_task_id')) this.db.exec('ALTER TABLE task_consents ADD COLUMN root_task_id TEXT');
      this.db.exec(`UPDATE task_consents SET root_task_id=id WHERE root_task_id IS NULL;
        CREATE INDEX IF NOT EXISTS task_operations_goal ON task_consents(root_task_id);
        INSERT OR IGNORE INTO task_goals(task_id) SELECT id FROM task_consents WHERE id=root_task_id;
        CREATE TABLE IF NOT EXISTS task_mail_reply_cursors(dependency_id TEXT NOT NULL,mail_operation_id TEXT NOT NULL,cursor INTEGER NOT NULL,
          PRIMARY KEY(dependency_id,mail_operation_id));`);
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_flow_cursor'").get()) {
        const cursor = Number(this.db.prepare('SELECT cursor FROM task_flow_cursor WHERE id=1').get()?.cursor ?? 0);
        this.db.prepare('INSERT OR IGNORE INTO task_flow_migrations(version,json) VALUES(2,?)').run(JSON.stringify({
          kind: 'mail-scoped-reply-cursors', retiredGlobalCursor: cursor, at: now() }));
        // Original evidence and review decisions remain authoritative. Scoped
        // cursors rebuild only active mail waits, so a late sent receipt cannot
        // lose an earlier reply or reactivate a terminal historical task.
        this.db.exec('DROP TABLE task_flow_cursor');
      }
    });
  }
  private atomic<T>(work: () => T): T {
    if (this.transactionDepth) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth--; }
  }
  private normalize(input: TaskSpec): TaskSpec {
    const spec = taskSpecSchema.parse(input);
    return { caseId: spec.caseId, title: spec.title, objective: spec.objective, expectedOutput: spec.expectedOutput,
      capabilities: [...spec.capabilities].sort(),
      ...(spec.media ? { media: spec.media } : {}),
      ...(spec.command ? { command: spec.command } : {}),
      ...(spec.mail ? { mail: spec.mail } : {}),
      ...(spec.github ? { github: spec.github } : {}),
      ...(spec.project ? { project: spec.project } : {}),
      ...(spec.projectSelection ? { projectSelection: spec.projectSelection } : {}),
      ...(spec.acceptance ? { acceptance: spec.acceptance } : {}),
      ...(spec.review ? { review: spec.review } : {}),
      ...(spec.directoryAnalysis ? { directoryAnalysis: spec.directoryAnalysis } : {}),
      ...(spec.workspace ? { workspace: { revision: spec.workspace.revision, files: [...spec.workspace.files].sort() } } : {}) };
  }
  private normalizeEvidence(input: readonly TaskEvidenceRef[]): TaskEvidenceRef[] {
    const references = z.array(evidenceRefSchema).max(MAX_TASK_EVIDENCE_REFS).parse(input);
    const unique = new Map<string, TaskEvidenceRef>();
    for (const reference of references) {
      const event = this.inbox.get(reference.eventId);
      const sourceKind = event && TASK_SOURCE_KINDS.has(event.kind);
      const sourceActor = event && (event.kind === 'owner.source' ? event.actor === 'owner' : event.actor === 'external');
      if (!event || !sourceKind || !sourceActor || !event.caseId
        || !['owner.source', 'web.search'].includes(event.kind) && !event.sourceGeneration
        || event.kind === 'web.search' && (event.payload.status !== 'ok' || event.payload.basis !== 'gateway_summary')
        || event.sourceId !== reference.sourceId || event.caseId !== reference.sourceCaseId || event.sourceGeneration !== reference.sourceGeneration) {
        throw new TaskConsentError('invalid_scope', '资料引用与原始事件的来源、场景或代次不一致。');
      }
      unique.set(event.id, { eventId: event.id, sourceId: event.sourceId, sourceCaseId: event.caseId,
        ...(event.sourceGeneration ? { sourceGeneration: event.sourceGeneration } : {}) });
    }
    return [...unique.values()].sort((left, right) => left.eventId.localeCompare(right.eventId));
  }
  private initialEvidence(task: TaskRecord): TaskEvidenceRef[] {
    const additions = new Set(task.requirementUpdates?.flatMap(update => update.evidenceEventIds ?? []) ?? []);
    return (task.evidenceRefs ?? []).filter(reference => !additions.has(reference.eventId));
  }
  private mergeEvidence(current: readonly TaskEvidenceRef[], additions: readonly TaskEvidenceRef[]): TaskEvidenceRef[] {
    const references = new Map(current.map(reference => [reference.eventId, reference]));
    for (const reference of additions) {
      const previous = references.get(reference.eventId);
      if (previous && evidenceIdentity(previous) !== evidenceIdentity(reference)) throw new TaskConsentError('conflict', '已经关联的资料不能更换原始来源。');
      references.set(reference.eventId, reference);
    }
    if (references.size > MAX_TASK_EVIDENCE_REFS) throw new TaskConsentError('invalid_scope', `每项任务最多关联 ${MAX_TASK_EVIDENCE_REFS} 条资料。`);
    return [...references.values()].sort((left, right) => left.eventId.localeCompare(right.eventId));
  }
  private decode(row?: TaskRow): TaskRecord | undefined {
    if (!row) return undefined;
    const task = JSON.parse(row.json) as TaskRecord;
    // Preserve retired pricing in the immutable stored spec, never in runtime/API/model views.
    const { maxCostCny: _retired, ...spec } = task.spec as TaskSpec & { maxCostCny?: unknown };
    return { ...task, requirementsRevision: task.requirementsRevision ?? 1, spec: this.normalize(spec) };
  }
  get(id: string): TaskRecord | undefined {
    identifier.parse(id);
    return this.decode(this.db.prepare('SELECT json FROM task_consents WHERE id=?').get(id) as unknown as TaskRow | undefined);
  }
  list(caseId?: string): TaskRecord[] {
    if (caseId !== undefined) identifier.parse(caseId);
    const rows = caseId === undefined ? this.db.prepare('SELECT json FROM task_consents ORDER BY rowid').all()
      : this.db.prepare('SELECT json FROM task_consents WHERE case_id=? ORDER BY rowid').all(caseId);
    return (rows as unknown as TaskRow[]).map(row => this.decode(row)!);
  }
  operations(taskId: string): TaskRecord[] {
    const root = this.required(taskId).rootTaskId ?? taskId;
    return (this.db.prepare('SELECT json FROM task_consents WHERE root_task_id=? ORDER BY rowid').all(root) as unknown as TaskRow[]).map(row => this.decode(row)!);
  }
  /** Owner-visible tasks aggregate operations; execution always reads the exact operation via get(). */
  task(id: string): TaskRecord | undefined {
    const record = this.get(id); if (!record) return;
    const root = record.rootTaskId ? this.required(record.rootTaskId) : record;
    const operations = this.operations(root.id), dependencies = this.dependencies(root.id);
    const accepted = this.db.prepare('SELECT accepted_at FROM task_goals WHERE task_id=?').get(root.id)?.accepted_at;
    return this.taskView(root, operations, dependencies, typeof accepted === 'string' ? accepted : undefined);
  }
  private taskView(root: TaskRecord, operations: TaskRecord[], dependencies: TaskDependency[], accepted?: string): TaskRecord {
    const currentOperations = operations.filter(item => !item.parentScope || operations.some(parent => parent.id === item.parentScope!.operationId
      && (parent.requirementsRevision ?? 1) === item.parentScope!.requirementsRevision));
    const stopped = ['rejected', 'revoked', 'failed'].includes(root.state);
    const pending = dependencies.some(item => item.state !== 'resolved' && item.state !== 'cancelled');
    const complete = currentOperations.every(item => item.state === 'completed'
      || ['rejected', 'revoked', 'failed'].includes(item.state) && Boolean(item.dependencyId)
      && dependencies.some(dependency => dependency.id === item.dependencyId && dependency.state === 'resolved')) && !pending;
    const acceptance = root.spec.acceptance ?? { mode: 'delivery' as const, criteria: [] };
    const awaiting = complete && acceptance.mode === 'owner' && !accepted;
    const phase: TaskFlowView['phase'] = stopped ? 'stopped' : root.state === 'proposed' ? 'proposed'
      : awaiting ? 'awaiting_acceptance' : complete ? 'completed'
      : operations.some(item => item.state === 'proposed') ? 'waiting_approval'
      : dependencies.some(item => item.state === 'reviewing') ? 'reviewing' : pending ? 'waiting_input' : 'running';
    return { ...root, state: stopped || root.state === 'proposed' || root.state === 'approved' ? root.state : complete && !awaiting ? 'completed' : 'running',
      flow: { phase, acceptance, ...(typeof accepted === 'string' ? { acceptedAt: accepted } : {}), dependencies,
        operations: operations.map(item => ({ id: item.id, role: item.operationRole ?? 'execution', spec: item.spec, state: item.state,
          revision: item.revision, requirementsRevision: item.requirementsRevision ?? 1, createdAt: item.createdAt,
          ...(item.error ? { error: item.error } : {}), ...(item.mailReceipt ? { mailReceipt: item.mailReceipt } : {}) })) } };
  }
  tasks(caseId?: string): TaskRecord[] {
    const all = this.list(caseId), roots = all.filter(task => !task.rootTaskId);
    const operations = new Map<string, TaskRecord[]>(), dependencies = new Map<string, TaskDependency[]>();
    for (const operation of all) {
      const id = operation.rootTaskId ?? operation.id, entries = operations.get(id) ?? [];
      entries.push(operation); operations.set(id, entries);
    }
    for (const dependency of this.dependencies()) {
      const entries = dependencies.get(dependency.taskId) ?? []; entries.push(dependency); dependencies.set(dependency.taskId, entries);
    }
    const accepted = new Map(this.db.prepare('SELECT task_id,accepted_at FROM task_goals WHERE accepted_at IS NOT NULL').all()
      .map(row => [String(row.task_id), String(row.accepted_at)]));
    return roots.map(root => {
      const entries = operations.get(root.id)!, waits = dependencies.get(root.id) ?? [];
      return entries.length === 1 && !waits.length && !root.spec.acceptance ? root : this.taskView(root, entries, waits, accepted.get(root.id));
    });
  }
  exportFlow() {
    return { operations: (this.db.prepare('SELECT json FROM task_consents ORDER BY rowid').all()).map(row => JSON.parse(String(row.json))),
      goals: this.db.prepare('SELECT task_id AS taskId,accepted_event_id AS acceptedEventId,accepted_at AS acceptedAt FROM task_goals ORDER BY rowid').all(),
      dependencies: this.dependencies(), migrations: this.db.prepare('SELECT json FROM task_flow_migrations ORDER BY version').all().map(row => JSON.parse(String(row.json))) };
  }
  /** Retire native question continuations as execution paths. Historical receipts
   * remain byte-for-byte intact; only currently permitted unanswered questions migrate. */
  migrateNativeInputs(): void {
    if (this.db.prepare('SELECT version FROM task_flow_migrations WHERE version=1').get()) return;
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_project_operations'").get()) return;
    const converted: string[] = [];
    for (const row of this.db.prepare('SELECT json FROM local_project_operations ORDER BY rowid').all()) {
      const operation = JSON.parse(String(row.json)) as ProjectOperation;
      const task = this.get(operation.input.taskId);
      if (!task?.spec.project || !['approved', 'running'].includes(task.state) || !['running', 'waiting'].includes(operation.state)
        || task.approvalRevision !== operation.input.approvalRevision || (task.requirementsRevision ?? 1) !== operation.input.requirementsRevision
        || projectSpecHash(task.spec.project) !== operation.input.specHash) continue;
      for (const question of operation.interactions) {
        if (question.kind !== 'question' || question.state === 'answered') continue;
        const original = this.db.prepare("SELECT json FROM local_project_events WHERE operation_id=? AND json_extract(json,'$.event.kind')='interaction' AND json_extract(json,'$.event.id')=? ORDER BY sequence LIMIT 1")
          .get(operation.input.operationId, question.id);
        if (!original || JSON.parse(String(original.json)).requirementsRevision !== operation.input.requirementsRevision) continue;
        const requests = question.request.questions;
        const parsed = projectOwnerQuestionSchema.safeParse({ questions: Array.isArray(requests) ? requests.map(value => ({
          ...(value as Record<string, unknown>), header: (value as Record<string, unknown>).header ?? '补充信息',
        })) : requests });
        if (!parsed.success) continue;
        const migrated = this.waitForInput(task.id, { key: 'native-' + hash(JSON.stringify([operation.input.operationId, question.id])),
          summary: question.title, questions: parsed.data.questions.map(value => ({ key: value.id, question: value.question,
            blocks: '继续原项目步骤', ...(value.options ? { options: value.options } : {}) })) });
        converted.push(migrated.id);
      }
    }
    this.db.prepare('INSERT INTO task_flow_migrations(version,json) VALUES(1,?)').run(JSON.stringify({ version: 1, converted, completedAt: now() }));
  }
  proposeOperation(parentId: string, key: string, spec: TaskSpec, options: { role?: TaskRecord['operationRole']; dependencyId?: string; questionKeys?: string[] } = {}): TaskRecord {
    identifier.parse(key);
    const parent = this.required(parentId);
    this.assertApproved(parent.id, parent.spec.caseId, undefined, undefined, parent.requirementsRevision ?? 1);
    const normalized = this.normalize(spec);
    if (spec.caseId !== parent.spec.caseId || spec.projectSelection || spec.review) throw new TaskConsentError('invalid_scope', '操作须属于原任务场景，且提供可核对的具体范围。');
    const rootTaskId = parent.rootTaskId ?? parent.id;
    if (options.dependencyId) {
      const dependency = this.dependency(options.dependencyId);
      if (!dependency || dependency.operationId !== parent.id || dependency.requirementsRevision !== (parent.requirementsRevision ?? 1)
        || !['waiting', 'reviewing'].includes(dependency.state)) throw new TaskConsentError('invalid_scope', '原问题不属于当前操作，或已经得到回答。');
      if (options.questionKeys?.some(key => !dependency.questions.some(question => question.key === key))) throw new TaskConsentError('invalid_scope', '邮件问题不属于原澄清范围。');
    }
    return this.atomic(() => {
      const operationKey = `operation:${parent.id}:${parent.requirementsRevision ?? 1}:${key}`;
      const existing = this.findOperation(operationKey, normalized, parent.evidenceRefs ?? []); if (existing) return existing;
      const timestamp = now();
      const operation: TaskRecord = { id: randomUUID(), rootTaskId, operationRole: options.role ?? 'execution',
        parentScope: { operationId: parent.id, approvalRevision: parent.approvalRevision!, requirementsRevision: parent.requirementsRevision ?? 1 },
        ...(options.dependencyId ? { dependencyId: options.dependencyId } : {}),
        ...(options.questionKeys ? { dependencyQuestionKeys: [...new Set(options.questionKeys)] } : {}),
        revision: 1, requirementsRevision: 1, state: 'proposed', spec: normalized, sourceEventId: parent.executionEventId,
        modelBinding: parent.modelBinding, evidenceRefs: parent.evidenceRefs, createdAt: timestamp, updatedAt: timestamp };
      this.insert(operation, operationKey);
      if (options.dependencyId && spec.mail) {
        const dependency = this.dependency(options.dependencyId)!;
        this.saveDependency({ ...dependency, mailOperationIds: [...dependency.mailOperationIds, operation.id] });
      }
      return operation;
    });
  }
  dependencies(taskId?: string): TaskDependency[] {
    const rows = taskId === undefined ? this.db.prepare('SELECT json FROM task_dependencies ORDER BY rowid').all()
      : this.db.prepare('SELECT json FROM task_dependencies WHERE task_id=? ORDER BY rowid').all(taskId);
    return rows.map(row => JSON.parse(String(row.json)) as TaskDependency);
  }
  proposeClarification(parentId: string, input: TaskWaitInput, requests: Array<{ key: string; spec: TaskSpec; questionKeys: string[] }>, ownerQuestionKeys: string[] = []) {
    return this.atomic(() => {
      const dependency = this.waitForInput(parentId, input);
      const assigned = new Set([...ownerQuestionKeys, ...requests.flatMap(request => request.questionKeys)]);
      if (input.questions.some(question => !assigned.has(question.key)) || [...assigned].some(key => !input.questions.some(question => question.key === key))) {
        throw new TaskConsentError('invalid_scope', '每个问题须安排给具体邮件或本人回答，不能遗漏或增加条目。');
      }
      const operations = requests.map(request => this.proposeOperation(parentId, request.key, request.spec,
        { role: 'clarification', dependencyId: dependency.id, questionKeys: request.questionKeys }));
      return { dependency: this.dependency(dependency.id)!, operations };
    });
  }
  pendingDependencies(): TaskDependency[] {
    return this.db.prepare(`SELECT d.json FROM task_dependencies d JOIN task_consents operation ON operation.id=d.operation_id
      JOIN task_consents goal ON goal.id=operation.root_task_id WHERE d.state IN ('waiting','reviewing')
      AND operation.state IN ('approved','running') AND goal.state NOT IN ('failed','revoked','rejected')
      AND json_extract(d.json,'$.requirementsRevision')=COALESCE(json_extract(operation.json,'$.requirementsRevision'),1) ORDER BY d.rowid`).all()
      .map(row => JSON.parse(String(row.json)) as TaskDependency);
  }
  dependency(id: string): TaskDependency | undefined {
    const row = this.db.prepare('SELECT json FROM task_dependencies WHERE id=?').get(id);
    return row ? JSON.parse(String(row.json)) as TaskDependency : undefined;
  }
  private saveDependency(value: TaskDependency): TaskDependency {
    const updated = { ...value, revision: value.revision + 1, updatedAt: now() };
    this.db.prepare('UPDATE task_dependencies SET state=?,json=? WHERE id=?').run(updated.state, JSON.stringify(updated), updated.id);
    return updated;
  }
  waitForInput(operationId: string, raw: TaskWaitInput): TaskDependency {
    const input = taskWaitInputSchema.parse(raw), operation = this.required(operationId);
    this.assertApproved(operationId, operation.spec.caseId, undefined, undefined, operation.requirementsRevision ?? 1);
    return this.atomic(() => {
      this.assertApproved(operationId, operation.spec.caseId, undefined, undefined, operation.requirementsRevision ?? 1);
      const requestKey = `${operation.requirementsRevision ?? 1}:${input.key}`;
      const found = this.db.prepare('SELECT json FROM task_dependencies WHERE operation_id=? AND request_key=?').get(operationId, requestKey);
      if (found) {
        const value = JSON.parse(String(found.json)) as TaskDependency;
        if (value.summary !== input.summary || !isDeepStrictEqual(value.questions, input.questions) || !isDeepStrictEqual(value.stageReview, input.stageReview)
          || value.requirementsRevision !== (operation.requirementsRevision ?? 1)) throw new TaskConsentError('conflict', '同一等待标识不能更换问题或要求版本。');
        return value;
      }
      const dependencies = this.dependencies(operation.rootTaskId ?? operation.id);
      if (input.stageReview) {
        const stage = input.stageReview;
        if (!operation.spec.project || taskStageReviewMode(operation) !== 'owner'
          || input.questions.length !== 1 || input.questions[0].key !== 'stage-decision'
          || hash(projectStageReviewContent(stage)) !== stage.fingerprint) throw new TaskConsentError('invalid_scope', '阶段审核须绑定本项目的实际成果指纹和本人决定。');
        const history = dependencies.filter(value => value.operationId === operation.id && value.requirementsRevision === (operation.requirementsRevision ?? 1) && value.stageReview);
        if (history.some(value => value.stageReview!.count !== stage.count
          || value.stageReview!.index === stage.index && value.stageReview!.stageId !== stage.stageId
          || value.stageReview!.stageId === stage.stageId && value.stageReview!.index !== stage.index)) {
          throw new TaskConsentError('conflict', '阶段总数或顺序与已登记流程不同，请通过本人补充要求处理变更。');
        }
        const previous = latestStageReviews(history, operation.id, operation.requirementsRevision ?? 1).filter(value => value.stageReview!.index < stage.index);
        if (previous.length !== stage.index - 1 || previous.some(value => projectStageDecision(value) !== 'approved')) {
          throw new TaskConsentError('not_approved', '前面的阶段尚未由本人批准，不能提交下一阶段。');
        }
      }
      const timestamp = now();
      const value: TaskDependency = { ...input, id: randomUUID(), taskId: operation.rootTaskId ?? operation.id, operationId,
        requirementsRevision: operation.requirementsRevision ?? 1, revision: 1, state: 'waiting', answers: [],
        candidateEventIds: [], reviewedEventIds: [], mailOperationIds: [], createdAt: timestamp, updatedAt: timestamp };
      this.db.prepare('INSERT INTO task_dependencies(id,task_id,operation_id,request_key,state,json) VALUES(?,?,?,?,?,?)')
        .run(value.id, value.taskId, operationId, requestKey, value.state, JSON.stringify(value));
      if (input.stageReview) for (const previous of dependencies) {
        if (previous.operationId === operation.id && previous.requirementsRevision === (operation.requirementsRevision ?? 1)
          && previous.stageReview && previous.stageReview.index >= input.stageReview.index && ['waiting', 'reviewing'].includes(previous.state)) {
          this.saveDependency({ ...previous, state: 'cancelled' });
        }
      }
      return value;
    });
  }
  pendingInputs(operationId: string): TaskDependency[] {
    const operation = this.required(operationId);
    return this.db.prepare("SELECT json FROM task_dependencies WHERE operation_id=? AND state IN ('waiting','reviewing') AND json_extract(json,'$.requirementsRevision')=? ORDER BY rowid")
      .all(operationId, operation.requirementsRevision ?? 1).map(row => JSON.parse(String(row.json)) as TaskDependency);
  }
  addReplyCandidate(dependencyId: string, eventId: string, mailOperationId?: string): TaskDependency {
    return this.atomic(() => {
      const value = this.dependency(dependencyId); if (!value) throw new TaskConsentError('not_found', '待确认问题不存在。');
      if (value.stageReview) throw new TaskConsentError('invalid_scope', '阶段审核只接受本人的决定，外部回信不能参与批准。');
      const operation = this.required(value.operationId);
      this.assertApproved(operation.id, operation.spec.caseId, undefined, undefined, value.requirementsRevision);
      if (!['waiting', 'reviewing'].includes(value.state) || value.candidateEventIds.includes(eventId)) return value;
      const event = this.inbox.get(eventId);
      if (!event || event.kind !== 'connector.change' || event.actor !== 'external' || event.caseId !== operation.spec.caseId) throw new TaskConsentError('invalid_scope', '回复须来自原授权场景的连接器证据。');
      const mail = mailOperationId ? this.required(mailOperationId) : undefined;
      if (mail && (!mail.spec.mail || mail.dependencyId !== value.id || !value.mailOperationIds.includes(mail.id))) throw new TaskConsentError('invalid_scope', '回信未绑定本组问题的原邮件。');
      return this.saveDependency({ ...value, state: 'reviewing', candidateEventIds: [...value.candidateEventIds, eventId],
        ...(mail ? { replyBindings: [...value.replyBindings ?? [], { eventId, mailOperationId: mail.id,
          questionKeys: mail.dependencyQuestionKeys ?? value.questions.map(question => question.key) }] } : {}) });
    });
  }
  cancelInputs(taskId: string): void {
    this.atomic(() => {
      for (const dependency of this.dependencies(taskId)) if (['waiting', 'reviewing'].includes(dependency.state)) {
        this.saveDependency({ ...dependency, state: 'cancelled' });
      }
    });
  }
  replyEvents(dependencyId: string, mailOperationId: string, limit = 100): { through: number; events: Array<{ cursor: number; event: InboxEvent }> } {
    const dependency = this.dependency(dependencyId), mail = this.get(mailOperationId);
    if (!dependency || !mail?.spec.mail || mail.dependencyId !== dependencyId || !dependency.mailOperationIds.includes(mailOperationId)) {
      throw new TaskConsentError('invalid_scope', '回信处理位置须绑定原问题及其邮件操作。');
    }
    const cursor = Number(this.db.prepare('SELECT cursor FROM task_mail_reply_cursors WHERE dependency_id=? AND mail_operation_id=?').get(dependencyId, mailOperationId)?.cursor ?? 0);
    return this.inbox.changesAfter('connector:' + mail.spec.mail.connectionId, dependency.createdAt, cursor, limit);
  }
  acknowledgeReplyEvent(dependencyId: string, mailOperationId: string, cursor: number): void {
    this.db.prepare(`INSERT INTO task_mail_reply_cursors(dependency_id,mail_operation_id,cursor) VALUES(?,?,?)
      ON CONFLICT(dependency_id,mail_operation_id) DO UPDATE SET cursor=excluded.cursor WHERE cursor<excluded.cursor`).run(dependencyId, mailOperationId, cursor);
  }
  authorizeInputReview(dependencyId: string): TaskRecord | undefined {
    const value = this.dependency(dependencyId);
    if (!value || value.stageReview || value.state !== 'reviewing') return;
    const parent = this.required(value.operationId);
    this.assertApproved(parent.id, parent.spec.caseId, undefined, undefined, value.requirementsRevision);
    const ids = value.candidateEventIds.filter(id => !value.reviewedEventIds.includes(id)).slice(0, 60);
    if (!ids.length) return;
    const pending = this.operations(value.taskId).find(operation => operation.spec.review?.dependencyId === value.id
      && ['approved', 'running'].includes(operation.state));
    if (pending) return pending;
    const key = `input-review:${value.id}:${hash(JSON.stringify(ids))}`;
    const spec = this.normalize({ caseId: parent.spec.caseId, title: '核对待确认问题的回复', objective: value.summary,
      expectedOutput: '逐项记录有证据的回答，保留未回答、冲突或超出原委托的问题。', capabilities: ['review'],
      review: { dependencyId: value.id, dependencyRevision: value.revision, eventIds: ids } });
    const operation = this.atomic(() => {
      const existing = this.findOperation(key, spec, parent.evidenceRefs ?? []); if (existing) return existing;
      const timestamp = now(), id = randomUUID();
      const operation: TaskRecord = { id, rootTaskId: parent.rootTaskId ?? parent.id, operationRole: 'review', dependencyId: value.id,
        parentScope: { operationId: parent.id, approvalRevision: parent.approvalRevision!, requirementsRevision: value.requirementsRevision },
        revision: 1, requirementsRevision: 1, approvalRevision: 1, state: 'approved', spec, sourceEventId: parent.executionEventId,
        modelBinding: parent.modelBinding, evidenceRefs: parent.evidenceRefs, createdAt: timestamp, updatedAt: timestamp, approvedAt: timestamp, executionEventId: this.eventId(id) };
      this.insert(operation, key); this.enqueue(operation); return operation;
    });
    this.reconcile(); return operation;
  }
  answerDependency(id: string, revision: number, answers: TaskAnswer[], reviewedEventIds: string[] = [], unresolved: Array<{ questionKey: string; reason: string }> = []): TaskDependency {
    return this.atomic(() => {
      const value = this.dependency(id); if (!value || value.revision !== revision) throw new TaskConsentError('conflict', '待确认问题已更新。');
      const operation = this.required(value.operationId);
      this.assertApproved(operation.id, operation.spec.caseId, undefined, undefined, value.requirementsRevision);
      if (!['waiting', 'reviewing'].includes(value.state)) throw new TaskConsentError('conflict', '这项等待已经结束。');
      if (reviewedEventIds.some(eventId => !value.candidateEventIds.includes(eventId))) throw new TaskConsentError('invalid_scope', '不能处理未关联的回信。');
      for (const answer of answers) {
        if (!value.questions.some(question => question.key === answer.questionKey) || !answer.content.trim() || !answer.evidenceEventIds.length) throw new TaskConsentError('invalid_scope', '答案须绑定原问题及证据。');
        if (value.stageReview && (answer.actor !== 'owner' || answer.questionKey !== 'stage-decision'
          || ![projectStageApproved, projectStageRejected].includes(answer.content))) throw new TaskConsentError('invalid_scope', '阶段审核须由本人明确选择通过当前阶段或退回修改。');
        for (const eventId of answer.evidenceEventIds) {
          const event = this.inbox.get(eventId);
          if (!event || event.caseId !== operation.spec.caseId && !value.researchEventIds?.includes(eventId) || (answer.actor === 'owner' ? event.actor !== 'owner' || !['owner.message', 'owner.task_answer'].includes(event.kind)
            : event.actor !== 'external' || !value.candidateEventIds.includes(eventId) && !value.researchEventIds?.includes(eventId))) throw new TaskConsentError('invalid_scope', '答案来源身份不一致。');
          if (value.stageReview) {
            if (event.kind === 'owner.task_answer') {
              const recorded = event.payload.answers as Record<string, unknown> | undefined;
              if (event.payload.taskId !== value.taskId || event.payload.dependencyId !== value.id
                || event.payload.revision !== revision || recorded?.[answer.questionKey] !== answer.content) {
                throw new TaskConsentError('invalid_scope', '本人阶段决定与本次问题、版本或实际提交内容不一致。');
              }
            } else if (!isOwnerChatEvent(event) || !['pending', 'leased'].includes(event.status)) {
              throw new TaskConsentError('invalid_scope', '阶段决定须来自本人的当前消息或对应阶段审核卡。');
            }
          }
        }
      }
      const merged = new Map(value.answers.map(answer => [answer.questionKey, answer]));
      const reasons = { ...value.unresolved };
      for (const issue of unresolved) {
        if (!value.questions.some(question => question.key === issue.questionKey) || !issue.reason.trim()
          || answers.some(answer => answer.questionKey === issue.questionKey)) throw new TaskConsentError('invalid_scope', '未解决条目须绑定原问题，且不能同时标为已回答。');
        if (merged.get(issue.questionKey)?.actor === 'owner') continue;
        merged.delete(issue.questionKey); reasons[issue.questionKey] = issue.reason;
      }
      for (const answer of answers) {
        if (answer.actor === 'external' && merged.get(answer.questionKey)?.actor === 'owner') continue;
        merged.set(answer.questionKey, answer);
        delete reasons[answer.questionKey];
      }
      const reviewed = [...new Set([...value.reviewedEventIds, ...reviewedEventIds])];
      const allOwner = value.questions.every(question => merged.get(question.key)?.actor === 'owner');
      const resolved = value.questions.every(question => merged.has(question.key)) && (allOwner || value.candidateEventIds.every(id => reviewed.includes(id)));
      if (resolved) for (const child of this.operations(value.taskId)) if (child.dependencyId === value.id && child.state === 'proposed') {
        this.save({ ...child, state: 'rejected', revision: child.revision + 1, updatedAt: now(), finishedAt: now(), error: '问题已得到回答，未执行这项待批准操作。' });
      }
      if (resolved && answers.some(answer => answer.actor === 'owner')) {
        for (const child of this.operations(value.taskId)) if (child.spec.review?.dependencyId === value.id && activeStates.has(child.state)) {
          this.save({ ...child, state: 'revoked', revision: child.revision + 1, revokedAt: now(), updatedAt: now(), finishedAt: now(), error: '本人已回答，原回信评审不再继续。' });
        }
      }
      return this.saveDependency({ ...value, state: resolved ? 'resolved' : value.candidateEventIds.some(id => !reviewed.includes(id)) ? 'reviewing' : 'waiting',
        answers: [...merged.values()], reviewedEventIds: reviewed, unresolved: reasons });
    });
  }
  recordInputResearch(operationId: string, eventIds: string[]): TaskDependency {
    const operation = this.required(operationId);
    this.assertApproved(operationId, operation.spec.caseId, 'review', undefined, operation.requirementsRevision ?? 1);
    const review = operation.spec.review;
    if (!review) throw new TaskConsentError('invalid_scope', '当前操作没有输入评审范围。');
    return this.atomic(() => {
      const dependency = this.dependency(review.dependencyId);
      if (!dependency || !['waiting', 'reviewing'].includes(dependency.state)) throw new TaskConsentError('conflict', '原问题已结束。');
      for (const id of eventIds) {
        const event = this.inbox.get(id);
        if (!event || !TASK_SOURCE_KINDS.has(event.kind) || event.actor !== 'external' || event.caseId !== operation.spec.caseId
          && !operation.evidenceRefs?.some(ref => ref.eventId === event.id && ref.sourceCaseId === event.caseId && ref.sourceGeneration === event.sourceGeneration && ref.sourceId === event.sourceId)) {
          throw new TaskConsentError('invalid_scope', '调研资料不属于原场景的实际来源。');
        }
      }
      const ids = [...new Set([...dependency.researchEventIds ?? [], ...eventIds])];
      if (ids.length > 120) throw new TaskConsentError('invalid_scope', '本组问题已关联较多资料，请先明确当前需要解决的条目。');
      return ids.length === (dependency.researchEventIds?.length ?? 0) ? dependency : this.saveDependency({ ...dependency, researchEventIds: ids });
    });
  }
  acceptDelivery(id: string, revision: number, ownerEventId: string): TaskRecord {
    return this.atomic(() => {
      const current = this.required(id, revision), event = this.inbox.get(ownerEventId);
      if (!event || event.actor !== 'owner' || event.kind !== 'owner.task_acceptance' || event.caseId !== current.spec.caseId
        || event.payload.taskId !== id) throw new TaskConsentError('invalid_scope', '验收须来自本人的当前决定。');
      const previous = this.db.prepare('SELECT accepted_event_id FROM task_goals WHERE task_id=?').get(id);
      if (previous?.accepted_event_id === ownerEventId) return this.task(id)!;
      if (this.task(id)?.flow?.phase !== 'awaiting_acceptance') throw new TaskConsentError('conflict', '任务尚未交付待验收结果。');
      this.db.prepare('UPDATE task_goals SET accepted_event_id=?,accepted_at=? WHERE task_id=?').run(ownerEventId, now(), id);
      return this.task(id)!;
    });
  }
  runningTasks(): TaskRecord[] {
    return (this.db.prepare("SELECT json FROM task_consents INDEXED BY task_consents_running WHERE state='running' ORDER BY rowid").all() as unknown as TaskRow[])
      .map(row => this.decode(row)!);
  }
  mailTasks(): TaskRecord[] {
    return (this.db.prepare("SELECT json FROM task_consents INDEXED BY task_consents_mail WHERE json_type(spec_json,'$.mail')='object' ORDER BY rowid").all() as unknown as TaskRow[])
      .map(row => this.decode(row)!);
  }
  private required(id: string, expectedRevision?: number): TaskRecord {
    const task = this.get(id);
    if (!task) throw new TaskConsentError('not_found', '任务提案不存在。');
    if (expectedRevision !== undefined && task.revision !== revisionSchema.parse(expectedRevision)) throw new TaskConsentError('conflict', '任务版本已变化，请刷新后重试。');
    return task;
  }
  private insert(task: TaskRecord, key: string): void {
    this.db.prepare('INSERT INTO task_consents(id,operation_key,case_id,state,revision,spec_json,json,root_task_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(task.id, key, task.spec.caseId, task.state, task.revision, JSON.stringify(task.spec), JSON.stringify(task), task.rootTaskId ?? task.id);
    if (!task.rootTaskId) this.db.prepare('INSERT INTO task_goals(task_id) VALUES(?)').run(task.id);
  }
  private save(task: TaskRecord): TaskRecord {
    // State transitions cannot rewrite the original authorized scope, including archived fields.
    this.db.prepare("UPDATE task_consents SET state=?,revision=?,json=json_set(?, '$.spec', json(spec_json)) WHERE id=?")
      .run(task.state, task.revision, JSON.stringify(task), task.id);
    return task;
  }
  private findOperation(key: string, spec: TaskSpec, evidenceRefs: readonly TaskEvidenceRef[] = []): TaskRecord | undefined {
    const existing = this.decode(this.db.prepare('SELECT json FROM task_consents WHERE operation_key=?').get(key) as unknown as TaskRow | undefined);
    if (existing && JSON.stringify(existing.spec) !== JSON.stringify(spec)) throw new TaskConsentError('conflict', '同一委托标识不能更换任务范围。');
    if (existing && !sameEvidence(this.initialEvidence(existing), evidenceRefs)) throw new TaskConsentError('conflict', '同一委托标识不能更换关联资料，请通过当前本人消息补充要求。');
    return existing;
  }
  private findProposal(sourceEventId: string, spec: TaskSpec, evidenceRefs: readonly TaskEvidenceRef[] = []): TaskRecord | undefined {
    // Pre-token-only proposal keys included a monetary limit. Compare the surviving scope
    // instead of rewriting old keys or deleting historical proposals that now share a scope.
    const rows = this.db.prepare("SELECT json FROM task_consents WHERE case_id=? AND json_extract(json, '$.sourceEventId')=? ORDER BY rowid")
      .all(spec.caseId, sourceEventId) as unknown as TaskRow[];
    const existing = rows.map(row => this.decode(row)!).find(task => JSON.stringify(task.spec) === JSON.stringify(spec));
    if (existing && !sameEvidence(this.initialEvidence(existing), evidenceRefs)) throw new TaskConsentError('conflict', '同一提案不能更换关联资料，请使用新的本人消息。');
    return existing;
  }
  propose(input: TaskSpec, sourceEventId: string, references: TaskEvidenceRef[] = [], contextTaskIds: string[] = []): TaskRecord {
    const spec = this.normalize(input); nonempty(300).parse(sourceEventId);
    if (spec.review) throw new TaskConsentError('invalid_scope', '输入回顾只能由已获准任务的具体等待产生。');
    const evidenceRefs = this.normalizeEvidence(references);
    const source = this.inbox.get(sourceEventId);
    if (!source || source.caseId !== spec.caseId) throw new TaskConsentError('invalid_scope', '提案须引用当前事项的真实事件。');
    if (spec.command && (!('kind' in spec.command) || !isOwnerChatEvent(source))) {
      throw new TaskConsentError('invalid_scope', '对话本地提案只接受当前本人消息对应的原生只读查询。精确程序命令须由本人在明确委托入口指定。');
    }
    if (spec.command && typeof source.payload.deviceId === 'string' && spec.command.deviceId !== source.payload.deviceId) {
      throw new TaskConsentError('invalid_scope', '任务设备与本人当前选择不一致。');
    }
    if (spec.project && typeof source.payload.deviceId === 'string' && spec.project.deviceId !== source.payload.deviceId) {
      throw new TaskConsentError('invalid_scope', '项目设备与本人当前选择不一致。');
    }
    const related = [...new Set(z.array(identifier).max(10).parse(contextTaskIds))];
    if (related.some(id => !this.get(id))) throw new TaskConsentError('invalid_scope', '关联任务结果不存在。');
    const key = `proposal:${hash(JSON.stringify([sourceEventId, spec]))}`;
    return this.atomic(() => {
      const existing = this.findOperation(key, spec, evidenceRefs) ?? this.findProposal(sourceEventId, spec, evidenceRefs); if (existing) return existing;
      const timestamp = now();
      const task: TaskRecord = { id: randomUUID(), revision: 1, requirementsRevision: 1, state: 'proposed', spec, sourceEventId,
        ...(related.length ? { contextTaskIds: related } : {}),
        ...(evidenceRefs.length ? { evidenceRefs } : {}), createdAt: timestamp, updatedAt: timestamp };
      this.insert(task, key); return task;
    });
  }
  /** Explicit owner-task commands and source-bound conversation requests share this writer. */
  request(input: TaskSpec, ownerRequestId: string): TaskRecord {
    return this.authorize(input, ownerRequestId);
  }
  /** A lost HTTP response may be reconciled after a resource expires, without admitting or restarting work. */
  findOwnerRequest(input: TaskSpec, ownerRequestId: string): TaskRecord | undefined {
    nonempty(300).parse(ownerRequestId);
    return this.findOperation(`owner:${ownerRequestId}`, this.normalize(input));
  }
  /** The conversation model supplies intent; this boundary verifies its actual owner source and scope. */
  requestOwnerTask(input: TaskSpec, sourceEventId: string, references: TaskEvidenceRef[] = [], contextTaskIds: string[] = []): TaskRecord {
    const spec = this.normalize(input);
    const source = this.inbox.get(nonempty(300).parse(sourceEventId));
    if (!source || !isOwnerChatEvent(source) || source.caseId !== spec.caseId) {
      throw new TaskConsentError('invalid_scope', '任务委托必须来自当前本人真实消息，不能从资料、提醒或代理自己的想法取得授权。');
    }
    const evidenceRefs = this.normalizeEvidence(references);
    if (spec.command && !('kind' in spec.command)) {
      throw new TaskConsentError('invalid_scope', '对话只能登记原生只读目录操作；精确程序命令须由本人在明确委托入口指定。');
    }
    if (spec.command && typeof source.payload.deviceId === 'string' && spec.command.deviceId !== source.payload.deviceId) {
      throw new TaskConsentError('invalid_scope', '任务设备与本人当前选择不一致。');
    }
    if (spec.project && typeof source.payload.deviceId === 'string' && spec.project.deviceId !== source.payload.deviceId) {
      throw new TaskConsentError('invalid_scope', '项目设备与本人当前选择不一致。');
    }
    const ownerRequestId = `owner-task:${source.id}`;
    const existing = this.findOperation(`owner:${ownerRequestId}`, spec, evidenceRefs);
    if (existing) {
      if (JSON.stringify([...(existing.contextTaskIds ?? [])].sort()) !== JSON.stringify([...new Set(contextTaskIds)].sort())) throw new TaskConsentError('conflict', '同一委托的结果来源不能在重传时改写。');
      this.reconcile(); return existing;
    }
    // An already-authorized legacy media request keeps its identity and original scope.
    // Reading it does not authorize another operation under the new admission rule.
    if (spec.media) {
      const legacy = this.findOperation(`owner:owner-media:${source.id}:${spec.media.kind}`, spec, evidenceRefs);
      if (legacy) { this.reconcile(); return legacy; }
    }
    if (!['pending', 'leased'].includes(source.status)) {
      throw new TaskConsentError('invalid_scope', '历史消息不能重新解释为新的任务许可，请使用当前本人委托。');
    }
    return this.authorize(spec, ownerRequestId, source.id, evidenceRefs, contextTaskIds);
  }
  /** Append the current owner's exact words without changing the original access or operation grant. */
  reviseRequirements(id: string, expectedRevision: number, sourceEventId: string, references: TaskEvidenceRef[] = [], conversationCaseId?: string,
    stageReview?: 'auto' | 'owner', finalFiles?: TaskFinalFilesUpdate): TaskRecord {
    const source = this.inbox.get(nonempty(300).parse(sourceEventId));
    if (!source || !isOwnerChatEvent(source)) throw new TaskConsentError('invalid_scope', '补充要求必须来自当前本人真实消息。');
    const content = z.string().min(1).max(20000).parse(source.payload.content);
    const evidenceRefs = this.normalizeEvidence(references);
    if (stageReview !== undefined) z.enum(['auto', 'owner']).parse(stageReview);
    const finalFilesUpdate = finalFiles === undefined ? undefined : taskFinalFilesUpdateSchema.parse(finalFiles);
    if (finalFilesUpdate && !content.includes(finalFilesUpdate.quote)) {
      throw new TaskConsentError('invalid_scope', '修改最终文件要求须引用本条本人消息的原话。');
    }
    if (conversationCaseId !== undefined && nonempty(300).parse(conversationCaseId) !== source.caseId) {
      throw new TaskConsentError('invalid_scope', '接续场景与当前本人消息不一致。');
    }
    return this.atomic(() => {
      const current = this.required(id);
      if (finalFilesUpdate && (!current.spec.project || current.executionContractVersion !== 2)) {
        throw new TaskConsentError('invalid_scope', '修改最终文件要求需要当前项目交付协议。');
      }
      if (stageReview !== undefined && !current.spec.project) throw new TaskConsentError('invalid_scope', '逐阶段审核方式只适用于项目任务。');
      if (stageReview === 'owner' && current.executionContractVersion !== 2) {
        throw new TaskConsentError('invalid_scope', '原任务沿用旧版执行协议。新增程序强制的逐阶段审批需要本人明确新委托；原任务可继续原有 Skill 的人工问答。');
      }
      if (current.spec.mail) throw new TaskConsentError('invalid_scope', '邮件任务的收件人、正文要求和资源快照在接纳后不可更换；请先停止原任务，再明确委托新的邮件任务。');
      if (!source.caseId || source.caseId !== current.spec.caseId && conversationCaseId === undefined) throw new TaskConsentError('invalid_scope', '补充要求与任务不属于同一场景。');
      const previousUpdate = current.requirementUpdates?.find(update => update.sourceEventId === source.id);
      if (previousUpdate) {
        if (previousUpdate.stageReview !== stageReview) throw new TaskConsentError('conflict', '同一条补充要求不能更换阶段审核方式。');
        if (!isDeepStrictEqual(previousUpdate.finalFiles, finalFilesUpdate)) throw new TaskConsentError('conflict', '同一条补充要求不能更换最终文件要求。');
        const laterIds = new Set(current.requirementUpdates?.filter(update => update.revision >= previousUpdate.revision).flatMap(update => update.evidenceEventIds ?? []) ?? []);
        const previouslyLinked = new Set((current.evidenceRefs ?? []).filter(reference => !laterIds.has(reference.eventId)).map(reference => reference.eventId));
        const requestedAdditions = evidenceRefs.filter(reference => !previouslyLinked.has(reference.eventId)).map(reference => reference.eventId).sort();
        if (JSON.stringify(requestedAdditions) !== JSON.stringify([...(previousUpdate.evidenceEventIds ?? [])].sort())) {
          throw new TaskConsentError('conflict', '同一条补充要求不能更换新增资料。');
        }
        return current;
      }
      this.required(id, expectedRevision);
      const awaitingAcceptance = current.state === 'completed' && this.task(id)?.flow?.phase === 'awaiting_acceptance';
      if (!activeStates.has(current.state) && !awaitingAcceptance) throw new TaskConsentError('not_approved', '只能补充当前仍获准执行的任务。');
      if (!['pending', 'leased'].includes(source.status)) throw new TaskConsentError('invalid_scope', '历史消息不能重新解释为任务补充要求。');
      const requirementsRevision = (current.requirementsRevision ?? 1) + 1;
      const timestamp = now();
      const linkedIds = new Set((current.evidenceRefs ?? []).map(reference => reference.eventId));
      const newEvidenceIds = evidenceRefs.filter(reference => !linkedIds.has(reference.eventId)).map(reference => reference.eventId);
      const merged = this.mergeEvidence(current.evidenceRefs ?? [], evidenceRefs);
      for (const dependency of this.dependencies(current.rootTaskId ?? id)) if (dependency.operationId === id && ['waiting', 'reviewing'].includes(dependency.state)) {
        this.saveDependency({ ...dependency, state: 'cancelled' });
      }
      for (const child of this.operations(id)) if (child.parentScope?.operationId === id && ['proposed', 'approved', 'running'].includes(child.state)) {
        this.save({ ...child, state: child.state === 'proposed' ? 'rejected' : 'revoked', revision: child.revision + 1,
          revokedAt: timestamp, finishedAt: timestamp, updatedAt: timestamp, error: '原任务要求已更新，这项旧操作不再继续。' });
      }
      return this.save({ ...current, state: awaitingAcceptance ? 'running' : current.state, revision: current.revision + 1, requirementsRevision, updatedAt: timestamp,
        ...(awaitingAcceptance ? { finishedAt: undefined } : {}),
        ...(merged.length ? { evidenceRefs: merged } : {}),
        requirementUpdates: [...(current.requirementUpdates ?? []), { revision: requirementsRevision,
          sourceEventId: source.id, caseId: source.caseId, content, createdAt: source.occurredAt,
          ...(stageReview ? { stageReview } : {}),
          ...(finalFilesUpdate ? { finalFiles: finalFilesUpdate } : {}),
          ...(newEvidenceIds.length ? { evidenceEventIds: newEvidenceIds } : {}) }] });
    });
  }
  assertRequirements(id: string, expectedRequirementsRevision: number): TaskRecord {
    const current = this.required(id);
    if ((current.requirementsRevision ?? 1) !== revisionSchema.parse(expectedRequirementsRevision)) {
      throw new TaskConsentError('conflict', '任务要求已变化，旧执行结果不能完成当前版本。');
    }
    return current;
  }
  /** Retire unstarted implicit permits; reviewed consent and actual operations remain authoritative. */
  retireImplicitDirectoryPermits(hasDeviceOperation: (taskId: string) => boolean): void {
    const rows = this.db.prepare("SELECT json FROM task_consents WHERE state IN ('approved','running') AND operation_key LIKE 'owner:owner-local-lookup:%'").all() as unknown as TaskRow[];
    for (const row of rows) {
      const task = this.decode(row)!;
      if (!task.spec.command || !('kind' in task.spec.command) || hasDeviceOperation(task.id)) continue;
      this.revoke(task.id, task.revision, '旧版隐式目录许可已退役，原记录保留。请在原生查询卡中确认精确范围后重新委托。');
    }
  }
  private authorize(input: TaskSpec, ownerRequestId: string, sourceEventId?: string, references: TaskEvidenceRef[] = [], contextTaskIds: string[] = []): TaskRecord {
    const spec = this.normalize(input); nonempty(300).parse(ownerRequestId);
    if (spec.review) throw new TaskConsentError('invalid_scope', '输入回顾不能作为独立任务发起。');
    const evidenceRefs = this.normalizeEvidence(references);
    const related = [...new Set(z.array(identifier).max(10).parse(contextTaskIds))];
    if (related.some(id => !this.get(id))) throw new TaskConsentError('invalid_scope', '关联任务结果不存在。');
    const task = this.atomic(() => {
      const key = `owner:${ownerRequestId}`; const existing = this.findOperation(key, spec, evidenceRefs); if (existing) return existing;
      const timestamp = now();
      const id = randomUUID();
      const pendingConfirmation = Boolean(spec.project?.serverResources || spec.projectSelection);
      const modelBinding = this.options.modelBinding?.(spec.caseId, sourceEventId);
      if (spec.project && modelBinding?.protocol === 'openai-chat') {
        throw new TaskConsentError('invalid_scope', '当前连接仅声明聊天协议。项目执行需要支持 Responses 工具协议的连接，请选择后重新委托。');
      }
      const record: TaskRecord = { id, revision: 1, requirementsRevision: 1, state: pendingConfirmation ? 'proposed' : 'approved', spec, ownerRequestId,
        ...(spec.project || spec.projectSelection ? { executionContractVersion: 2 as const } : {}),
        ...(related.length ? { contextTaskIds: related } : {}),
        ...(modelBinding === undefined ? {} : { modelBinding }),
        createdAt: timestamp, updatedAt: timestamp, ...(sourceEventId ? { sourceEventId } : {}), ...(evidenceRefs.length ? { evidenceRefs } : {}),
        ...(!pendingConfirmation ? { approvalRevision: 1, executionEventId: this.eventId(id), approvedAt: timestamp } : {}) };
      this.insert(record, key);
      if (!pendingConfirmation) this.enqueue(record);
      return record;
    });
    this.reconcile(); return task;
  }
  private decisionSource(sourceEventId: string, action: 'approve' | 'reject'): NonNullable<TaskRecord['ownerDecision']> {
    const source = this.inbox.get(sourceEventId);
    if (!source?.caseId || !isOwnerChatEvent(source) || !['pending', 'leased'].includes(source.status)) {
      throw new TaskConsentError('invalid_scope', '提案决定须来自当前本人消息，历史、外部资料和代理输出不能批准或拒绝任务。');
    }
    return { action, eventId: source.id, messageId: source.externalId, caseId: source.caseId,
      contentHash: hash(String(source.payload.content)), at: source.occurredAt };
  }
  approve(id: string, expectedRevision: number, ownerEventId?: string, serverResources?: ServerProjectResources, boundProject?: LocalProjectSpec): TaskRecord {
    const task = this.atomic(() => {
      const saved = this.get(id);
      if (ownerEventId && saved?.ownerDecision?.eventId === ownerEventId && saved.ownerDecision.action === 'approve') return saved;
      const decision = ownerEventId ? this.decisionSource(ownerEventId, 'approve') : undefined;
      let current = this.required(id, expectedRevision);
      if (current.state !== 'proposed') throw new TaskConsentError('conflict', '只能批准尚未决定的提案。');
      if (current.spec.project || current.spec.projectSelection) current = { ...current, executionContractVersion: 2 };
      if (current.rootTaskId) this.assertRootLive(current);
      if (current.spec.projectSelection) {
        if (!boundProject) throw new TaskConsentError('invalid_scope', '请在任务卡选择设备、工作区和具体执行范围后确认。');
        const { projectSelection: _selection, ...description } = current.spec;
        const spec = this.normalize({ ...description, capabilities: ['project'], project: localProjectSpecSchema.parse(boundProject) });
        current = { ...current, proposalSpec: current.spec, spec };
        this.db.prepare('UPDATE task_consents SET spec_json=?,json=? WHERE id=?').run(JSON.stringify(spec), JSON.stringify(current), id);
      } else if (boundProject) throw new TaskConsentError('invalid_scope', '已有操作不能通过批准更换工作区。');
      if (current.spec.command && !('kind' in current.spec.command)) throw new TaskConsentError('invalid_scope',
        '旧版模型生成的命令提案已退役，历史保留但不能再批准。请重新提出原生查询，或由本人手工明确委托精确命令。');
      const project = current.spec.project;
      const serverScope = project?.serverResources;
      if (serverScope && (ownerEventId !== undefined || !isDeepStrictEqual(serverScope, serverResources))) {
        throw new TaskConsentError('invalid_scope', '请在任务卡查看服务器和资源范围后确认本次执行。');
      }
      if (!serverScope && serverResources) throw new TaskConsentError('invalid_scope', '服务器资源确认与任务范围不一致。');
      const timestamp = now();
      const modelBinding = current.modelBinding !== undefined ? current.modelBinding : this.options.modelBinding?.(current.spec.caseId, ownerEventId);
      if (current.spec.project && modelBinding?.protocol === 'openai-chat') {
        throw new TaskConsentError('invalid_scope', '原提案绑定的连接仅支持聊天协议，无法启动项目执行。请使用支持 Responses 的连接重新委托。');
      }
      const approved = this.save({ ...current, revision: current.revision + 1, state: 'approved', updatedAt: timestamp, approvedAt: timestamp,
        ...(modelBinding === undefined ? {} : { modelBinding }),
        approvalRevision: current.revision + 1, executionEventId: this.eventId(current.id), ...(decision ? { ownerDecision: decision } : {}),
        ...(project && serverScope ? { serverApproval: { projectSpecHash: projectSpecHash(project) } } : {}) });
      this.enqueue(approved); return approved;
    });
    this.reconcile(); return task;
  }
  reject(id: string, expectedRevision: number, ownerEventId?: string): TaskRecord {
    return this.atomic(() => {
      const saved = this.get(id);
      if (ownerEventId && saved?.ownerDecision?.eventId === ownerEventId && saved.ownerDecision.action === 'reject') return saved;
      const decision = ownerEventId ? this.decisionSource(ownerEventId, 'reject') : undefined;
      const current = this.required(id, expectedRevision);
      if (current.state !== 'proposed') throw new TaskConsentError('conflict', '只能拒绝尚未决定的提案。');
      const timestamp = now();
      return this.save({ ...current, revision: current.revision + 1, state: 'rejected', updatedAt: timestamp, finishedAt: timestamp,
        ...(decision ? { ownerDecision: decision } : {}) });
    });
  }
  revoke(id: string, expectedRevision: number, error?: string): TaskRecord {
    return this.atomic(() => {
      const current = this.required(id, expectedRevision);
      if (!activeStates.has(current.state) && !(current.state === 'completed' && this.task(id)?.state === 'running')) throw new TaskConsentError('conflict', '当前任务没有可以撤回的执行许可。');
      const timestamp = now();
      if (!current.rootTaskId) {
        for (const operation of this.operations(id)) if (operation.id !== id && ['proposed', 'approved', 'running'].includes(operation.state)) {
          this.save({ ...operation, state: operation.state === 'proposed' ? 'rejected' : 'revoked', revision: operation.revision + 1,
            revokedAt: timestamp, finishedAt: timestamp, updatedAt: timestamp, error: '原任务许可已撤回。' });
        }
        for (const dependency of this.dependencies(id)) if (['waiting', 'reviewing'].includes(dependency.state)) this.saveDependency({ ...dependency, state: 'cancelled' });
      }
      return this.save({ ...current, revision: current.revision + 1, state: 'revoked', updatedAt: timestamp, revokedAt: timestamp, finishedAt: timestamp,
        ...(error ? { error } : {}) });
    });
  }
  assertApproved(id: string, caseId: string, capability?: TaskCapability, expectedRevision?: number, expectedRequirementsRevision = 1): TaskRecord {
    const task = this.required(id, expectedRevision);
    this.assertRootLive(task);
    if (!activeStates.has(task.state) || task.approvalRevision === undefined || !task.executionEventId) throw new TaskConsentError('not_approved', '当前任务尚未获准执行，或许可已经失效。');
    if (!this.hasServerApproval(task)) throw new TaskConsentError('not_approved', '缺少与本次服务器资源范围一致的确认。');
    if (task.spec.caseId !== caseId || capability !== undefined && !task.spec.capabilities.includes(capability)) throw new TaskConsentError('invalid_scope', '任务许可不适用于当前事项或能力。');
    this.assertRequirements(id, expectedRequirementsRevision);
    return task;
  }
  private assertRootLive(operation: TaskRecord): void {
    if (!operation.rootTaskId) return;
    const root = this.required(operation.rootTaskId);
    if (['revoked', 'rejected', 'failed'].includes(root.state) || !root.approvalRevision) throw new TaskConsentError('not_approved', '原任务许可已经失效。');
    if (!operation.parentScope) throw new TaskConsentError('not_approved', '缺少原任务操作的授权来源。');
    const parent = this.required(operation.parentScope.operationId);
    if (parent.approvalRevision !== operation.parentScope.approvalRevision || (parent.requirementsRevision ?? 1) !== operation.parentScope.requirementsRevision
      || ['revoked', 'rejected', 'failed'].includes(parent.state)) throw new TaskConsentError('not_approved', '操作所依据的原任务要求或许可已变化。');
    if (operation.dependencyId && this.dependency(operation.dependencyId)?.state === 'cancelled') throw new TaskConsentError('not_approved', '原问题已经关闭。');
  }
  begin(id: string, approvalRevision: number, expectedRequirementsRevision = 1): TaskRecord {
    return this.atomic(() => {
      const current = this.required(id);
      this.assertRootLive(current);
      if (current.approvalRevision !== revisionSchema.parse(approvalRevision)) throw new TaskConsentError('conflict', '任务批准版本已变化。');
      if (!this.hasServerApproval(current)) throw new TaskConsentError('not_approved', '缺少与本次服务器资源范围一致的确认。');
      this.assertRequirements(id, expectedRequirementsRevision);
      if (current.state === 'running') return current;
      if (current.state !== 'approved') throw new TaskConsentError('not_approved', '任务未获准开始，或许可已经失效。');
      const timestamp = now();
      return this.save({ ...current, revision: current.revision + 1, state: 'running', startedAt: timestamp, updatedAt: timestamp });
    });
  }
  finish(id: string, expectedRevision: number, state: 'completed' | 'failed', error?: string, expectedRequirementsRevision = 1): TaskRecord {
    if (state !== 'completed' && state !== 'failed') throw new TaskConsentError('conflict', '执行结果状态无效。');
    return this.atomic(() => {
      const current = this.required(id, expectedRevision);
      if (current.state !== 'running') throw new TaskConsentError('not_approved', '当前执行已经停止，不能覆盖其状态。');
      this.assertRequirements(id, expectedRequirementsRevision);
      const timestamp = now();
      return this.save({ ...current, revision: current.revision + 1, state, updatedAt: timestamp, finishedAt: timestamp,
        ...(error ? { error: String(error).slice(0, 2000) } : {}) });
    });
  }
  /** Resolve an outcome from the durable device record, never reopen permission.
   * Ordinary finish() remains strict; this is the only evidence-based recovery
   * transition and cannot create/requeue an execution event. */
  resolveDeviceReceipt(id: string, operationId: string, expectedRequirementsRevision = 1): TaskRecord | undefined {
    return this.atomic(() => {
      const current = this.required(id);
      if (!['running', 'failed', 'completed'].includes(current.state)) return;
      if ((current.requirementsRevision ?? 1) !== revisionSchema.parse(expectedRequirementsRevision)) return;
      const row = this.db.prepare('SELECT json FROM local_device_operations WHERE id=? AND task_id=?').get(operationId, id);
      const operation = row ? JSON.parse(String(row.json)) as DeviceOperation : undefined;
      const event = current.executionEventId ? this.inbox.get(current.executionEventId) : undefined;
      if (!matchesDeviceTask(current, operation) || (operation.requirementsRevision ?? 1) !== expectedRequirementsRevision
        || !event || !this.isExecutionEvent(event) || !finalDeviceReceipt(operation.receipt)) return;
      const success = operation.receipt.state === 'completed' && operation.receipt.exitCode === 0;
      // An active compound task still owns its remaining delivery steps. A
      // native success cannot stop those steps or supply their completion.
      if (success && current.state === 'running' && current.spec.capabilities.some(capability => capability !== 'local-command')) return;
      const pendingDelivery = Boolean(current.spec.directoryAnalysis || current.requirementUpdates?.length
        || current.spec.capabilities.some(capability => capability !== 'local-command'));
      const state = success && (!pendingDelivery || current.state === 'completed') ? 'completed' : 'failed';
      const error = success ? state === 'failed' ? current.spec.directoryAnalysis ? analysisPendingNote
        : '设备操作结果已返回，原任务要求的后续交付尚未完成；没有自动重跑操作或调用模型。' : undefined : commandFailureMessage(operation.receipt);
      if (current.state === state && current.error === error) return current;
      const resolvedAt = operation.receiptReceivedAt ?? operation.receipt.finishedAt ?? operation.issuedAt;
      const { error: previousError, ...preserved } = current;
      return this.save({ ...preserved, state, revision: current.revision + 1, updatedAt: resolvedAt, finishedAt: resolvedAt,
        ...(error ? { error } : {}), deviceResolution: current.deviceResolution ?? { operationId, resolvedAt, previousState: current.state,
          ...(previousError ? { previousError } : {}) } });
    });
  }
  /** One delivery gate for normal completion and late receipt reconciliation.
   * It reads persisted facts only and never grants permission to run more work. */
  projectCompletionProblem(id: string, expectedRequirementsRevision: number): string | undefined {
    const current = this.required(id);
    if (!current.spec.project || !['running', 'failed', 'completed'].includes(current.state)
      || !current.approvalRevision) return '项目任务未获准交付，或许可已撤回。';
    if ((current.requirementsRevision ?? 1) !== expectedRequirementsRevision) return '项目结果属于先前的任务要求版本。';
    try { this.assertRootLive(current); }
    catch (error) { return error instanceof Error ? error.message : '原任务授权链已变化。'; }
    const event = current.executionEventId ? this.inbox.get(current.executionEventId) : undefined;
    if (!event || !this.isExecutionEvent(event)) return '项目缺少原始获准执行事件。';
    if (this.pendingInputs(id).length) return '本操作仍有未解决的依赖，不能作为完成交付。';
    const stages = latestStageReviews(this.dependencies(current.rootTaskId ?? current.id), current.id, expectedRequirementsRevision);
    if (taskStageReviewMode(current) === 'owner' && !stages.length) return '本任务要求逐阶段人工审核，尚无本人阶段批准记录。';
    if (stages.length && (stages.length !== stages[0].stageReview!.count || stages.some((stage, index) =>
      stage.stageReview!.index !== index + 1 || projectStageDecision(stage) !== 'approved'))) return '逐阶段人工审核尚未全部通过，不能完成交付。';
    const row = this.db.prepare('SELECT json FROM local_project_operations WHERE task_id=?').get(id);
    const operation = row ? JSON.parse(String(row.json)) as ProjectOperation : undefined;
    if (!operation || operation.state !== 'completed' || operation.input.taskId !== current.id
      || operation.input.approvalRevision !== current.approvalRevision
      || operation.input.requirementsRevision !== expectedRequirementsRevision
      || operation.input.specHash !== projectSpecHash(current.spec.project)) return '项目尚无当前要求和授权范围的完成回执。';
    if (operation.environment?.state === 'unknown') return '项目环境退出状态仍待核对。';
    if (operation.input.contract?.version === 2) {
      const retainedPreview = !operation.input.spec.serverResources && operation.input.spec.network
        && operation.environment?.state === 'active' && operation.environment.terminals.length > 0;
      if (operation.environment?.state !== 'closed' && !retainedPreview) return '项目尚未确认执行环境收尾，不能完成交付。';
      const running = this.db.prepare(`WITH latest AS (
        SELECT MAX(sequence) sequence FROM local_project_events WHERE operation_id=? AND json_extract(json,'$.event.kind')='tool'
        GROUP BY json_extract(json,'$.event.item.id'))
        SELECT e.json FROM local_project_events e JOIN latest l ON e.sequence=l.sequence
        WHERE e.operation_id=? AND json_extract(e.json,'$.event.item.state')='running'`).all(operation.input.operationId, operation.input.operationId);
      if (running.some(row => {
        const tool = (JSON.parse(String(row.json)) as { event: { item: ProjectToolItem } }).event.item;
        return !retainedPreview || tool.type !== 'commandExecution' || !tool.threadId || !tool.processId
          || !operation.environment!.terminals.some(terminal => terminal.threadId === tool.threadId && terminal.processId === tool.processId);
      })) return '项目仍有已受理的工具或检查等待结束。';
      const pendingModel = this.db.prepare(`SELECT 1 FROM local_project_model_calls WHERE operation_id=?
        AND json_extract(json,'$.state')='pending' LIMIT 1`).get(operation.input.operationId);
      if (pendingModel) return '项目仍有已经受理的模型请求等待收尾。';
    }
    let publishedFiles: Array<{ path: string; size: number; sha256: string }> | undefined;
    if (requiresProjectFileDelivery(operation)) {
      const finalSnapshot = projectFinalFileSnapshot(operation)?.snapshot;
      const saved = this.db.prepare(`SELECT json FROM project_file_deliveries WHERE operation_id=?
        AND requirements_revision=? AND checkpoint=? AND ready=1
        AND json_extract(json,'$.snapshot.stageFingerprint') IS NULL ORDER BY rowid DESC LIMIT 1`)
        .get(operation.input.operationId, expectedRequirementsRevision, finalSnapshot?.checkpoint ?? operation.checkpoint?.hash ?? '');
      if (!saved) return '文件成果尚未完整保存，原成果保留供继续领取。';
      publishedFiles = JSON.parse(String(saved.json)).files;
    }
    if (operation.input.contract) return projectDeliveryProblem(operation.delivery, expectedRequirementsRevision, publishedFiles, taskFinalFiles(current));
  }
  /** A late final project receipt can settle a failed delivery, without reopening execution. */
  resolveProjectReceipt(id: string, expectedRequirementsRevision: number): TaskRecord | undefined {
    return this.atomic(() => {
      const current = this.required(id);
      if (!current.spec.project || !['failed', 'completed'].includes(current.state)
        || (current.requirementsRevision ?? 1) !== expectedRequirementsRevision) return;
      const row = this.db.prepare('SELECT json FROM local_project_operations WHERE task_id=?').get(id);
      const operation = row ? JSON.parse(String(row.json)) as ProjectOperation : undefined;
      const event = current.executionEventId ? this.inbox.get(current.executionEventId) : undefined;
      if (!operation || !['completed', 'failed', 'cancelled'].includes(operation.state) || !event || !this.isExecutionEvent(event)
        || operation.input.taskId !== id || operation.input.approvalRevision !== current.approvalRevision
        || operation.input.requirementsRevision !== expectedRequirementsRevision
        || operation.input.specHash !== hash(JSON.stringify(localProjectSpecSchema.parse(current.spec.project)))) return;
      const state = operation.state === 'completed' ? 'completed' : 'failed';
      if (state === 'completed' && this.projectCompletionProblem(id, expectedRequirementsRevision)) return;
      const error = state === 'completed' ? undefined : operation.error ?? '项目执行未完整完成。';
      if (current.state === state && current.error === error) return current;
      const resolvedAt = operation.finishedAt ?? operation.updatedAt;
      const { error: previousError, ...preserved } = current;
      return this.save({ ...preserved, state, revision: current.revision + 1, updatedAt: resolvedAt, finishedAt: resolvedAt,
        ...(error ? { error } : {}), projectResolution: current.projectResolution ?? { operationId: operation.input.operationId,
          resolvedAt, previousState: current.state, ...(previousError ? { previousError } : {}) } });
    });
  }
  /** Only a trusted durable journal can settle transport facts, never model output.
   * Revoked tasks keep their state; their final transport receipt remains visible. */
  resolveMailReceipt(id: string, store: Pick<Store, 'getMeta'>, expectedRequirementsRevision = 1): TaskRecord | undefined {
    return this.atomic(() => {
      const current = this.required(id);
      if ((current.requirementsRevision ?? 1) !== revisionSchema.parse(expectedRequirementsRevision)) return;
      const operation = matchingMailOperation(current, store);
      const event = current.executionEventId ? this.inbox.get(current.executionEventId) : undefined;
      if (!operation || !['submitted', 'failed', 'unknown'].includes(operation.state) || !event || !this.isExecutionEvent(event)) return;
      const mailReceipt = mailOperationReceipt(operation);
      const success = operation.state === 'submitted';
      const canResolve = ['running', 'failed', 'completed'].includes(current.state);
      const pendingDelivery = Boolean(current.requirementUpdates?.length);
      const state = canResolve ? success && (!pendingDelivery || current.state === 'completed') ? 'completed' : 'failed' : current.state;
      const error = canResolve ? success ? state === 'failed' ? '邮件已由 Exchange 接受提交；后续补充要求尚未完成，没有再次发送。' : undefined : mailFailureMessage(operation) : current.error;
      if (current.state === state && current.error === error && JSON.stringify(current.mailReceipt) === JSON.stringify(mailReceipt)) return current;
      const { error: _previousError, ...preserved } = current;
      return this.save({ ...preserved, state, revision: current.revision + 1, updatedAt: operation.updatedAt,
        ...(canResolve ? { finishedAt: operation.updatedAt } : {}), mailReceipt, ...(error ? { error } : {}) });
    });
  }
  /** Public projection only. Completion still requires the executor's real delivery checks. */
  projectGitHubReceipts(id: string, store: Pick<Store, 'getMeta'>): TaskRecord | undefined {
    return this.atomic(() => {
      const current = this.required(id); if (!current.spec.github || !current.approvalRevision) return;
      const event = current.executionEventId ? this.inbox.get(current.executionEventId) : undefined;
      if (!event || !this.isExecutionEvent(event)) return;
      const specHash = hash(githubTaskSpecCanonicalJson(current.spec.github));
      const operations = store.getMeta<GitHubOperation[]>(GITHUB_OPERATIONS_PREFIX + id, []).filter(operation => operation.taskId === id
        && operation.caseId === current.spec.caseId && operation.approvalRevision === current.approvalRevision && operation.specHash === specHash
        && operation.requirementsRevision <= (current.requirementsRevision ?? 1));
      const receipts: GitHubTaskReceipt[] = operations.map(operation => ({ operationId: operation.id, tool: operation.tool, state: operation.state,
        updatedAt: operation.updatedAt, ...(operation.error ? { error: operation.error } : {}),
        ...(operation.receipt?.url ? { url: operation.receipt.url } : {}), ...(operation.receipt?.sha ? { sha: operation.receipt.sha } : {}),
        ...(operation.receipt?.number ? { number: operation.receipt.number } : {}) }));
      if (JSON.stringify(current.githubReceipts ?? []) === JSON.stringify(receipts)) return current;
      return this.save({ ...current, revision: current.revision + 1, githubReceipts: receipts });
    });
  }
  private eventId(taskId: string): string { return hash(`task.execute:${taskId}`); }
  private hasServerApproval(task: TaskRecord): boolean {
    const project = task.spec.project;
    if (!project?.serverResources) return !task.serverApproval;
    return task.serverApproval?.projectSpecHash === projectSpecHash(project);
  }
  private enqueue(task: TaskRecord): void {
    const event: EventInput = { id: task.executionEventId!, sourceId: 'task-consent', externalId: task.id, kind: 'task.execute',
      operation: 'create', actor: task.spec.review ? 'agent' : 'owner', caseId: task.spec.caseId, occurredAt: task.approvedAt!,
      ...(task.sourceEventId ? { causationId: task.sourceEventId } : {}), payload: { taskId: task.id, revision: task.approvalRevision,
        ...(task.serverApproval ? { serverProjectSpecHash: task.serverApproval.projectSpecHash } : {}) } };
    this.db.prepare('INSERT INTO task_execution_outbox(task_id,event_json) VALUES(?,?)').run(task.id, JSON.stringify(event));
  }
  /** Provenance check is separate from the live state/revision permission fence. */
  isExecutionEvent(event: InboxEvent): boolean {
    if (event.kind !== 'task.execute' || typeof event.payload.taskId !== 'string') return false;
    const taskId = event.payload.taskId;
    if (!identifier.safeParse(taskId).success) return false;
    const task = this.get(taskId);
    if (!task?.executionEventId || !task.approvalRevision || event.id !== task.executionEventId || !this.hasServerApproval(task)) return false;
    const row = this.db.prepare('SELECT event_json FROM task_execution_outbox WHERE task_id=?').get(taskId) as unknown as { event_json: string } | undefined;
    if (!row) return false;
    const expected = JSON.parse(row.event_json) as EventInput;
    const matches = (value: InboxEvent) => value.id === expected.id && value.sourceId === expected.sourceId && value.externalId === expected.externalId
      && value.kind === expected.kind && value.actor === expected.actor && value.operation === expected.operation && value.caseId === task.spec.caseId
      && value.causationId === expected.causationId && value.occurredAt === expected.occurredAt
      && JSON.stringify(value.payload) === JSON.stringify(expected.payload) && value.payload.revision === task.approvalRevision
      && value.payload.serverProjectSpecHash === task.serverApproval?.projectSpecHash;
    const persisted = this.inbox.get(event.id);
    return Boolean(persisted && matches(event) && matches(persisted));
  }
  /** Called after opening the inbox and on ordinary ticks. No model calls occur here. */
  reconcile(): { delivered: number; cancelled: number } {
    let delivered = 0; let cancelled = 0;
    const pending = this.db.prepare('SELECT task_id,event_json,delivered_at FROM task_execution_outbox WHERE delivered_at IS NULL ORDER BY rowid').all() as unknown as OutboxRow[];
    for (const row of pending) {
      const task = this.required(row.task_id);
      if (!activeStates.has(task.state)) {
        this.db.prepare('UPDATE task_execution_outbox SET delivered_at=? WHERE task_id=? AND delivered_at IS NULL').run(now(), task.id); cancelled++; continue;
      }
      // No consent write transaction is held while the independent inbox connection writes.
      this.inbox.ingest(JSON.parse(row.event_json) as EventInput);
      this.db.prepare('UPDATE task_execution_outbox SET delivered_at=? WHERE task_id=? AND delivered_at IS NULL').run(now(), task.id); delivered++;
    }
    return { delivered, cancelled };
  }
  close(): void { this.db.close(); }
}
