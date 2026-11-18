import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { localProjectCapability, previousLocalProjectCapability, projectContextWindowCapability, windowsDesktopCapability, localProjectSpecSchema, projectRequestSchema, projectEventSchema, projectGuardSchema,
  linuxProjectPathSchema, serverProjectResources, expectedServerProjectResources,
  type LocalProjectSpec, type ProjectEvent, type ProjectExecutionInput,
  type ProjectGuardInput, type ProjectOperation, type ProjectServerMessage, type ProjectWorkspace } from '../../shared/local-project.js';
import type { LocalDevice } from '../../shared/local-device.js';
import { projectRootsOverlap } from '../../shared/project-path.js';
import type { ProjectModelFailureCode } from '../../shared/project-model-stream.js';
import { MAX_PROJECT_SCREENSHOTS, type ImageAttachment, type ImageUpload } from '../../shared/chat-images.js';
import { prepareProjectScreenshot } from '../v2/images.js';
import { ProjectFiles } from './project-files.js';
import { projectFilePathSchema, projectFilesCapability, projectFinalFilesCapability, type ProjectFileDelivery, type ProjectFileSelection } from '../../shared/project-files.js';
import { projectCheckScope, projectContractCapability, projectContractV2Capability, projectDeliveryProblem, projectPlanProblem, projectRequirementProblem } from '../../shared/project-contract.js';

const terminal = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const workspaceWait = '同一设备上有其他任务占用相同或重叠的项目目录，正在等待其结束。';
const serverWorkspaceWait = '服务端当前已有一项任务占用执行环境，正在等待其退出。';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const projectSpecHash = (spec: LocalProjectSpec) => digest(JSON.stringify(localProjectSpecSchema.parse(spec)));

/** Older executors strictly parse the wire input. Keep the captured model window in the operation. */
export function projectInputForDevice(input: ProjectExecutionInput, device: LocalDevice): ProjectExecutionInput {
  const contractCapability = input.contract?.version === 2 ? projectContractV2Capability : projectContractCapability;
  if (input.contract && !device.capabilities.includes(contractCapability)) throw new ProjectError(409, '此任务需要支持当前原件交接与成果验证协议的执行端，正在等待客户端更新。');
  if (input.deliverFiles && !device.capabilities.includes(projectFilesCapability)) throw new ProjectError(409, '服务器执行端需要更新后才能保存文件成果。');
  if (input.deliverFiles && !input.spec.serverResources && !device.capabilities.includes(projectFinalFilesCapability)) {
    throw new ProjectError(409, '此任务需要支持最终文件交付的客户端，正在等待客户端更新。');
  }
  if (input.model.contextWindow === undefined || device.capabilities.includes(projectContextWindowCapability)) return input;
  const { contextWindow: _contextWindow, ...model } = input.model;
  return { ...input, model };
}
export class ProjectError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ProjectError'; }
}

export interface ProjectExecutionContext {
  signal: AbortSignal;
  guard(): void;
  onEvent(operation: ProjectOperation, event: ProjectEvent): void;
  model(operation: ProjectOperation, request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>, requestId: string): Promise<void>;
  context(operation: ProjectOperation, input: Record<string, unknown>): Promise<unknown>;
}
interface Pending {
  context: ProjectExecutionContext;
  promise: Promise<ProjectOperation>;
  resolve(operation: ProjectOperation): void;
  reject(error: Error): void;
  abort(): void;
  settlement?: ReturnType<typeof setTimeout>;
  stopMode?: 'pause' | 'cancel';
  waitingForWorkspace?: boolean;
}
interface Options {
  device(id: string): LocalDevice;
  send(id: string, message: ProjectServerMessage): void;
  assertActive(): void;
  changed(): void;
  result(taskId: string): void;
}

function occupiesWorkspace(operation: ProjectOperation): boolean {
  if (operation.environment?.state === 'closed' && operation.environment.retainedWorkspace && operation.checkpoint
    && operation.input.spec.serverResources?.workspaceStorage === 'persistent') return false;
  return operation.environment?.state === 'active' || operation.environment?.state === 'unknown'
    || (operation.workspaceReserved ?? (!terminal.has(operation.state) && Boolean(operation.startedAt) && operation.environment?.state !== 'closed'));
}

function pausedServerWorkspace(operation: ProjectOperation): boolean {
  return Boolean(operation.input.spec.serverResources && operation.workspaceReserved
    && operation.state === 'waiting' && operation.environment?.state === 'closed' && operation.environment.retainedWorkspace);
}

function projectRoots(operation: ProjectOperation): string[] {
  const { root } = operation.input.spec;
  return [...root === 'task-temporary' ? [] : [root], ...operation.workspace ? [operation.workspace.realPath] : []];
}

/** Native project facts share the device store. TaskConsent remains the only task authority. */
export class ProjectBroker {
  readonly fileResults: ProjectFiles;
  private readonly pending = new Map<string, Pending>();
  private readonly closingEnvironments = new Map<string, { promise: Promise<ProjectOperation>; resolve(value: ProjectOperation): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private draining = false;

  constructor(private readonly db: DatabaseSync, private readonly options: Options) {
    db.exec(`CREATE TABLE IF NOT EXISTS local_project_operations (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS local_project_retained ON local_project_operations(json_extract(json,'$.environment.retainedWorkspace'));
      CREATE TABLE IF NOT EXISTS local_project_events (
        operation_id TEXT NOT NULL, sequence INTEGER NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY(operation_id,sequence));
      CREATE INDEX IF NOT EXISTS local_project_tool_identity ON local_project_events (
        operation_id, json_extract(json,'$.event.item.id'), sequence)
        WHERE json_extract(json,'$.event.kind')='tool';
      CREATE TABLE IF NOT EXISTS local_project_workspaces (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_project_model_calls (
        operation_id TEXT NOT NULL, request_id TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY(operation_id,request_id));
      CREATE INDEX IF NOT EXISTS local_project_pending_models ON local_project_model_calls (operation_id)
        WHERE json_extract(json,'$.state')='pending';
      CREATE TABLE IF NOT EXISTS local_project_evidence (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, requirements_revision INTEGER NOT NULL,
        input_hash TEXT NOT NULL, json TEXT NOT NULL, data BLOB NOT NULL,
        UNIQUE(operation_id, requirements_revision, input_hash));`);
    this.fileResults = new ProjectFiles(db, { operation: id => this.get(id), device: options.device, send: options.send,
      assertActive: options.assertActive, changed: id => { options.changed(); options.result(id); } });
  }

  private withFiles(operation: ProjectOperation): ProjectOperation {
    const files = this.fileResults?.forOperation(operation);
    const toolCounts = operation.toolCounts ?? (operation.tools.length === 100 ? this.toolCounts(operation.input.operationId) : undefined);
    return { ...operation, ...(files ? { files } : {}), ...(toolCounts ? { toolCounts } : {}) };
  }
  async prepareFiles(taskId: string, guard: () => void, signal?: AbortSignal, selection?: ProjectFileSelection): Promise<ProjectFileDelivery> {
    const operation = this.forTask(taskId);
    if (!operation) throw new ProjectError(404, '项目操作不存在。');
    return this.fileResults.prepare(operation, guard, signal, selection);
  }

  get(id: string): ProjectOperation | undefined {
    const row = this.db.prepare('SELECT json FROM local_project_operations WHERE id=?').get(id);
    return row ? this.withFiles(JSON.parse(String(row.json))) : undefined;
  }

  toolsForRevision(id: string, revision?: number) {
    const tools = new Map<string, ProjectOperation['tools'][number]>();
    for (const row of this.db.prepare(`SELECT json FROM local_project_events WHERE operation_id=?
      AND (? IS NULL OR json_extract(json,'$.requirementsRevision')=?) AND json_extract(json,'$.event.kind')='tool' ORDER BY sequence`).all(id, revision ?? null, revision ?? null)) {
      const event = JSON.parse(String(row.json)) as ProjectEvent;
      if (event.event.kind === 'tool') tools.set(event.event.item.id, event.event.item);
    }
    return [...tools.values()].map(({ id, type, state, label, startedAt, endedAt, exitCode }) => ({ id, type, state, label, startedAt, endedAt, exitCode }));
  }

  private toolCounts(id: string): NonNullable<ProjectOperation['toolCounts']> {
    const row = this.db.prepare(`WITH latest AS (
      SELECT MAX(sequence) sequence FROM local_project_events WHERE operation_id=? AND json_extract(json,'$.event.kind')='tool'
      GROUP BY json_extract(json,'$.event.item.id'))
      SELECT COUNT(*) total, COALESCE(SUM(json_extract(e.json,'$.event.item.state')='failed'),0) failed,
      COALESCE(SUM(json_extract(e.json,'$.event.item.state')='running'),0) running
      FROM local_project_events e JOIN latest l ON e.sequence=l.sequence WHERE e.operation_id=?`).get(id, id)!;
    return { total: Number(row.total), failed: Number(row.failed), running: Number(row.running) };
  }

  forTask(taskId: string): ProjectOperation | undefined {
    const row = this.db.prepare('SELECT json FROM local_project_operations WHERE task_id=?').get(taskId);
    return row ? this.withFiles(JSON.parse(String(row.json))) : undefined;
  }

  list(): ProjectOperation[] {
    return this.db.prepare('SELECT json FROM local_project_operations ORDER BY rowid').all()
      .map(row => this.withFiles(JSON.parse(String(row.json))));
  }

  summaries(): Array<{ taskId: string; sequence: number; state: ProjectOperation['state']; updatedAt: string; environment?: NonNullable<ProjectOperation['environment']>['state'] }> {
    const rows = this.db.prepare(`SELECT task_id AS taskId, json_extract(json,'$.sequence') AS sequence,
      json_extract(json,'$.state') AS state, json_extract(json,'$.updatedAt') AS updatedAt,
      json_extract(json,'$.environment.state') AS environment FROM local_project_operations ORDER BY rowid`).all();
    return rows.map(row => ({ taskId: String(row.taskId), sequence: Number(row.sequence),
      state: row.state as ProjectOperation['state'], updatedAt: String(row.updatedAt),
      environment: row.environment as NonNullable<ProjectOperation['environment']>['state'] | null ?? undefined }));
  }

  reservedWorkspaces(): ProjectOperation[] {
    return this.list().filter(occupiesWorkspace);
  }
  retainedWorkspaces(): ProjectOperation[] {
    return this.db.prepare("SELECT json FROM local_project_operations WHERE json_extract(json,'$.environment.retainedWorkspace')=1 ORDER BY rowid").all()
      .map(row => JSON.parse(String(row.json)) as ProjectOperation);
  }

  operationsToDrain(): ProjectOperation[] {
    return this.list().filter(operation => {
      const id = operation.input.operationId;
      return this.pending.has(id) || this.closingEnvironments.has(id)
        || (occupiesWorkspace(operation) && !pausedServerWorkspace(operation) && (!terminal.has(operation.state) || operation.environment?.state === 'active'));
    });
  }

  workspaces(): ProjectWorkspace[] {
    return this.db.prepare('SELECT json FROM local_project_workspaces ORDER BY rowid').all()
      .map(row => JSON.parse(String(row.json)) as ProjectWorkspace);
  }

  evidence(operationId: string, revision: number): ImageAttachment[] {
    return this.db.prepare('SELECT json FROM local_project_evidence WHERE operation_id=? AND requirements_revision=? ORDER BY rowid')
      .all(operationId, revision).map(row => JSON.parse(String(row.json)) as ImageAttachment);
  }

  readEvidenceImage(id: string): { attachment: ImageAttachment; data: Buffer } | undefined {
    const row = this.db.prepare('SELECT json,data FROM local_project_evidence WHERE id=?').get(id);
    return row ? { attachment: JSON.parse(String(row.json)) as ImageAttachment, data: Buffer.from(row.data as Uint8Array) } : undefined;
  }

  async recordEvidence(deviceId: string, authorization: ProjectGuardInput, upload: ImageUpload): Promise<ImageAttachment> {
    const { operation } = this.authorize(deviceId, authorization);
    if (this.options.device(deviceId).platform !== 'win32' || operation.input.spec.serverResources || !operation.input.spec.returnScreenshots) {
      throw new ProjectError(403, '当前任务没有回传本机截图的许可。');
    }
    const inputHash = digest(upload.data);
    const stored = () => {
      const row = this.db.prepare('SELECT json FROM local_project_evidence WHERE operation_id=? AND requirements_revision=? AND input_hash=?')
        .get(authorization.operationId, authorization.requirementsRevision, inputHash);
      return row ? JSON.parse(String(row.json)) as ImageAttachment : undefined;
    };
    const existing = stored();
    if (existing) return existing;
    const assertCapacity = () => {
      const count = this.db.prepare('SELECT count(*) AS total FROM local_project_evidence WHERE operation_id=?')
        .get(authorization.operationId)!.total;
      if (Number(count) >= MAX_PROJECT_SCREENSHOTS) throw new ProjectError(409, '本任务已保存四张截图。');
    };
    assertCapacity();
    const { attachment, data } = await prepareProjectScreenshot(upload);
    // Decode is asynchronous. The same authorization must still hold at the durable write.
    this.authorize(deviceId, authorization);
    const raced = stored();
    if (raced) return raced;
    assertCapacity();
    this.db.prepare('INSERT INTO local_project_evidence(id,operation_id,requirements_revision,input_hash,json,data) VALUES(?,?,?,?,?,?)')
      .run(attachment.id, authorization.operationId, authorization.requirementsRevision, inputHash, JSON.stringify(attachment), data);
    return attachment;
  }
  export() {
    return { operations: this.list(), workspaces: this.workspaces(), fileDeliveries: this.fileResults.metadata(),
      events: this.db.prepare('SELECT json FROM local_project_events ORDER BY operation_id, sequence').all().map(row => JSON.parse(String(row.json))),
      modelCalls: this.db.prepare('SELECT operation_id, request_id, json FROM local_project_model_calls ORDER BY rowid').all()
        .map(row => ({ operationId: row.operation_id, requestId: row.request_id, ...JSON.parse(String(row.json)) })),
      evidence: this.db.prepare('SELECT operation_id, requirements_revision, json FROM local_project_evidence ORDER BY rowid').all()
        .map(row => ({ operationId: row.operation_id, requirementsRevision: row.requirements_revision, ...JSON.parse(String(row.json)) })) };
  }

  history(id: string, after = 0): { events: ProjectEvent[]; next: number } {
    const events = this.db.prepare('SELECT json FROM local_project_events WHERE operation_id=? AND sequence>? ORDER BY sequence LIMIT 50')
      .all(id, after).map(row => JSON.parse(String(row.json)) as ProjectEvent);
    return { events, next: events.at(-1)?.sequence ?? after };
  }

  deliveryReceipt(id: string, revision: number) {
    const result = this.db.prepare(`SELECT sequence, hash, json_extract(json,'$.event.state') AS state
      FROM local_project_events WHERE operation_id=?
      AND json_extract(json,'$.requirementsRevision')=? AND json_extract(json,'$.event.kind')='finished'
      ORDER BY json_extract(json,'$.event.state')='unknown', sequence LIMIT 1`).get(id, revision);
    if (!result) return;
    const tools = this.db.prepare(`SELECT sequence, json_extract(json,'$.event.item.type') AS type,
      json_extract(json,'$.event.item.state') AS state, json_extract(json,'$.event.item.exitCode') AS exit_code
      FROM local_project_events WHERE operation_id=? AND sequence IN (
      SELECT MAX(sequence) FROM local_project_events WHERE operation_id=? AND sequence<?
        AND json_extract(json,'$.requirementsRevision')=? AND json_extract(json,'$.event.kind')='tool'
      GROUP BY json_extract(json,'$.event.item.id')
    ) AND json_extract(json,'$.event.item.state')<>'running' ORDER BY sequence DESC LIMIT 16`).all(id, id, Number(result.sequence), revision)
      .reverse().map(row => ({ sequence: Number(row.sequence), type: String(row.type), state: String(row.state),
        exitCode: typeof row.exit_code === 'number' ? row.exit_code : undefined }));
    const recorded = this.db.prepare(`SELECT sequence, hash, json FROM local_project_events WHERE operation_id=?
      AND json_extract(json,'$.requirementsRevision')=? AND sequence<? AND json_extract(json,'$.event.kind')='delivery'
      ORDER BY sequence DESC LIMIT 1`).get(id, revision, Number(result.sequence));
    const event = recorded ? JSON.parse(String(recorded.json)) as ProjectEvent : undefined;
    const delivery = event?.event.kind === 'delivery' ? event.event.delivery : undefined;
    const checked = delivery ? { sequence: Number(recorded!.sequence), hash: String(recorded!.hash), total: delivery.request.checks.length,
      checks: delivery.request.checks.slice(0, 8).map(check => {
        const evidence = delivery.evidence.find(value => value.id === check.id);
        return { id: check.id, required: check.required, status: evidence?.status ?? 'unverified',
          requirements: check.requirementIds.length, files: evidence?.files.length ?? 0,
          assertions: evidence?.assertions.length ?? 0, command: Boolean(evidence?.command), desktop: Boolean(evidence?.desktop) };
      }) } : undefined;
    return { state: String(result.state), hash: String(result.hash), tools, ...(checked ? { delivery: checked } : {}) };
  }

  private save(operation: ProjectOperation): void {
    operation.updatedAt = new Date().toISOString();
    const { files: _files, ...record } = operation;
    this.db.prepare('INSERT INTO local_project_operations(id,task_id,device_id,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
      .run(operation.input.operationId, operation.input.taskId, operation.input.spec.deviceId, JSON.stringify(record));
  }

  prepare(input: unknown): LocalProjectSpec {
    const spec = projectRequestSchema.parse(input);
    const device = this.options.device(spec.deviceId);
    if (spec.desktop) {
      if (device.platform !== 'win32') throw new ProjectError(400, 'Windows 应用任务须选择 Windows 设备。');
      if (spec.root && spec.root !== 'task-temporary' || spec.create) throw new ProjectError(400, 'Windows 应用任务使用本次任务的临时工作区。');
      return localProjectSpecSchema.parse({ ...spec, root: 'task-temporary', readAccess: 'project', network: false });
    }
    if (device.platform !== 'linux') {
      if (!spec.root) throw new ProjectError(409, '请先确认本次项目的真实目录；独立任务可以明确选择临时工作区。');
      return localProjectSpecSchema.parse(spec);
    }
    if (spec.root && spec.root !== 'task-temporary' || spec.create) throw new ProjectError(400, '服务端当前只支持每项任务自己的临时工作区。');
    return localProjectSpecSchema.parse({ ...spec, root: 'task-temporary', readAccess: 'project', serverResources: serverProjectResources(spec.network) });
  }

  validateScope(spec: LocalProjectSpec): void {
    this.options.assertActive();
    localProjectSpecSchema.parse(spec);
    const device = this.options.device(spec.deviceId);
    if (device.revokedAt) throw new ProjectError(403, '项目设备连接已撤销。');
    if (spec.desktop && (device.platform !== 'win32'
      || spec.root !== 'task-temporary' || spec.create || spec.network || spec.readAccess !== 'project' || spec.serverResources)) {
      throw new ProjectError(409, 'Windows 应用任务需要支持 Cua Driver 的客户端及本次任务的临时工作区。');
    }
    if (device.platform === 'linux') {
      if (spec.root !== 'task-temporary' || spec.create || spec.readAccess !== 'project'
        || !spec.serverResources || !isDeepStrictEqual(spec.serverResources, expectedServerProjectResources(spec.network, spec.serverResources))) {
        throw new ProjectError(409, '服务端任务与当前执行资源范围不一致，请重新委托并确认。');
      }
      return;
    }
    if (spec.serverResources) throw new ProjectError(409, '服务端资源许可不适用于 Windows 设备。');
  }
  validate(spec: LocalProjectSpec, taskId?: string): void {
    this.validateScope(spec);
    const device = this.options.device(spec.deviceId);
    if (spec.desktop && !device.capabilities.includes(windowsDesktopCapability)) throw new ProjectError(409, '请更新客户端以启用本次 Windows 应用操作。');
    if (device.platform === 'linux') {
      if (!device.capabilities.includes(localProjectCapability)) throw new ProjectError(409, '服务端隔离执行环境当前不可用。');
      return;
    }
    if (!device.capabilities.includes(localProjectCapability)) {
      const existing = taskId && this.forTask(taskId);
      if (!existing || existing.input.specHash !== projectSpecHash(spec) || existing.input.stepLimit === null
        || !device.capabilities.includes(previousLocalProjectCapability)) {
        throw new ProjectError(409, '请更新这台电脑的榫客户端以使用本地项目执行。');
      }
    }
  }

  run(input: ProjectExecutionInput, context: ProjectExecutionContext): Promise<ProjectOperation> {
    context.guard(); context.signal.throwIfAborted(); this.validateScope(input.spec);
    const existing = this.get(input.operationId);
    if (existing && (existing.input.taskId !== input.taskId || existing.input.specHash !== input.specHash
      || existing.input.approvalRevision !== input.approvalRevision)) throw new ProjectError(409, '项目执行身份或授权范围已改变。');
    if (existing && terminal.has(existing.state) && input.requirementsRevision <= existing.input.requirementsRevision) return Promise.resolve(existing);
    if (existing && input.spec.serverResources && terminal.has(existing.state) && !existing.environment?.retainedWorkspace) throw new ProjectError(409, '服务端任务环境已经结束，请重新委托并确认。');
    if (existing?.state === 'unknown') throw new ProjectError(409, '原项目操作结果未知，需要先核对本机执行状态。');
    const active = this.pending.get(input.operationId);
    if (active) {
      active.context.signal.removeEventListener('abort', active.abort);
      active.context = context;
      context.signal.addEventListener('abort', active.abort, { once: true });
      this.revise(input);
      return active.promise;
    }
    const operation: ProjectOperation = existing ?? { input, state: 'queued', sequence: 0, modelCalls: 0, workspaceReserved: false,
      output: '', tools: [], previews: [], interactions: [], updatedAt: input.issuedAt };
    if (existing) {
      operation.input = { ...input, stepLimit: existing.input.stepLimit, deadline: existing.input.deadline };
      if (terminal.has(operation.state)) { operation.state = 'queued'; delete operation.finishedAt; delete operation.finalOutput; }
    }
    this.save(operation);
    let resolve!: (value: ProjectOperation) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ProjectOperation>((done, fail) => { resolve = done; reject = fail; });
    const pending: Pending = { context, promise, resolve, reject,
      abort: () => { void this.stop(input.operationId, '项目执行已停止。', pending.stopMode).catch(() => {}); } };
    this.pending.set(input.operationId, pending);
    context.signal.addEventListener('abort', pending.abort, { once: true });
    this.dispatch(input.operationId);
    this.options.changed();
    return promise;
  }

  private dispatch(id: string): void {
    const pending = this.pending.get(id);
    const operation = this.get(id);
    if (!operation || !pending || pending.stopMode || this.draining || terminal.has(operation.state)) return;
    const deviceId = operation.input.spec.deviceId;
    const roots = projectRoots(operation);
    const reserved = occupiesWorkspace(operation);
    let before = true;
    const server = Boolean(operation.input.spec.serverResources);
    if (!reserved && (server || roots.length) && this.list().some(other => {
      const otherId = other.input.operationId;
      if (otherId === id) { before = false; return false; }
      const otherPending = this.pending.get(otherId);
      const waitingAhead = before && otherPending?.waitingForWorkspace && !otherPending.stopMode;
      return other.input.spec.deviceId === deviceId && (occupiesWorkspace(other) || waitingAhead)
        && (server || ((operation.input.spec.access === 'read-write' || other.input.spec.access === 'read-write')
          && projectRoots(other).some(root => roots.some(candidate => projectRootsOverlap(candidate, root)))));
    })) {
      pending.waitingForWorkspace = true;
      const reason = server ? serverWorkspaceWait : workspaceWait;
      if (operation.error !== reason) { operation.state = 'waiting'; operation.error = reason; this.save(operation); }
      return;
    }
    pending.waitingForWorkspace = false;
    try {
      pending.context.guard();
      pending.context.signal.throwIfAborted();
      this.validate(operation.input.spec, operation.input.taskId);
      const device = this.options.device(deviceId);
      if (!device.online || device.revokedAt) throw new ProjectError(409, '项目设备当前不可用。');
      const wireInput = projectInputForDevice(operation.input, device);
      // Reserve before sending. A broken transport can leave delivery uncertain.
      if (pausedServerWorkspace(operation)) delete operation.environment;
      operation.workspaceReserved = true;
      if (!reserved) { operation.state = 'queued'; delete operation.error; }
      this.save(operation);
      this.options.send(deviceId, { kind: 'project-execute', operationId: id, input: wireInput });
    } catch (error) {
      operation.state = 'waiting'; operation.error = error instanceof Error ? error.message : '等待项目设备连接，尚未开始新的操作。'; this.save(operation);
    }
  }

  private dispatchWaiting(deviceId: string): void {
    for (const operation of this.list()) if (operation.input.spec.deviceId === deviceId && !occupiesWorkspace(operation)
      && operation.state === 'waiting') this.dispatch(operation.input.operationId);
  }

  connected(deviceId: string): void {
    for (const operation of this.list()) {
      if (operation.input.spec.deviceId === deviceId && (this.pending.get(operation.input.operationId)?.stopMode || this.closingEnvironments.has(operation.input.operationId))) {
        this.options.send(deviceId, { kind: 'project-cancel', operationId: operation.input.operationId,
          reason: '正在核对原项目停止状态。', mode: this.pending.get(operation.input.operationId)?.stopMode });
      }
    }
    for (const operation of this.list()) if (operation.input.spec.deviceId === deviceId && this.pending.has(operation.input.operationId) && !terminal.has(operation.state)) {
      if (this.pending.get(operation.input.operationId)?.stopMode) continue;
      this.dispatch(operation.input.operationId);
    }
  }

  disconnected(deviceId: string): void {
    this.fileResults.disconnect(deviceId);
    for (const operation of this.list()) if (operation.input.spec.deviceId === deviceId && !terminal.has(operation.state) && occupiesWorkspace(operation)) {
      operation.state = 'waiting'; operation.error = '设备连接中断，等待本机排空及原会话回执。'; this.save(operation);
    }
    this.options.changed();
  }

  revise(input: ProjectExecutionInput): void {
    const operation = this.get(input.operationId);
    if (!operation || input.requirementsRevision <= operation.input.requirementsRevision) return;
    if (operation.input.specHash !== input.specHash || terminal.has(operation.state)) throw new ProjectError(409, '已结束或变更范围的项目不能继续原操作。');
    operation.input = { ...input, stepLimit: operation.input.stepLimit, deadline: operation.input.deadline };
    if (input.contract?.version === 2) {
      operation.output = '';
      delete operation.finalOutput;
      delete operation.modelTransport;
      delete operation.diff;
      operation.previews = [];
    }
    for (const interaction of operation.interactions) if (interaction.state === 'pending') interaction.state = 'cancelled';
    this.save(operation);
    if (!occupiesWorkspace(operation)) return;
    try { this.options.send(input.spec.deviceId, { kind: 'project-steer', operationId: input.operationId,
      requirementsRevision: input.requirementsRevision, runId: input.runId, updates: input.updates,
      ...(input.contract?.version === 2 ? { contract: input.contract } : {}) }); }
    catch { operation.state = 'waiting'; operation.error = '补充要求已保存，等待设备连接后同步。'; this.save(operation); }
    this.options.changed();
  }

  authorize(deviceId: string, raw: ProjectGuardInput): { operation: ProjectOperation; context: ProjectExecutionContext } {
    this.options.assertActive();
    const input = projectGuardSchema.parse(raw);
    const operation = this.get(input.operationId);
    const pending = this.pending.get(input.operationId);
    if (!operation || operation.input.spec.deviceId !== deviceId || operation.input.specHash !== input.specHash) throw new ProjectError(403, '项目调用与设备或授权快照不一致。');
    if (!pending || pending.stopMode || this.draining || terminal.has(operation.state) || !occupiesWorkspace(operation)
      || operation.input.spec.serverResources && operation.environment?.state === 'closed') {
      throw new ProjectError(409, '项目当前没有有效执行会话。');
    }
    if (input.requirementsRevision !== operation.input.requirementsRevision) throw new ProjectError(409, '任务要求已更新，请同步当前要求后继续。');
    pending.context.guard(); pending.context.signal.throwIfAborted(); this.validate(operation.input.spec, operation.input.taskId);
    if (operation.input.deadline !== null && Date.now() >= operation.input.deadline) throw new ProjectError(409, '原项目运行期限已到。');
    return { operation, context: pending.context };
  }

  beginModel(operation: ProjectOperation, requestId: string, purpose?: 'compaction'): void {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) throw new ProjectError(400, '模型请求编号无效。');
    if (this.db.prepare('SELECT 1 FROM local_project_model_calls WHERE operation_id=? AND request_id=?').get(operation.input.operationId, requestId)) {
      throw new ProjectError(409, '这次模型请求已有记录，不能重新发送结果未知的调用。');
    }
    const latest = this.get(operation.input.operationId)!;
    if (latest.input.requirementsRevision !== operation.input.requirementsRevision || latest.input.runId !== operation.input.runId
      || latest.input.approvalRevision !== operation.input.approvalRevision || latest.input.specHash !== operation.input.specHash) {
      throw new ProjectError(409, '模型请求所依据的任务要求或授权已变化，未提交旧请求。');
    }
    if (latest.input.stepLimit !== null && latest.modelCalls >= latest.input.stepLimit) {
      throw new ProjectError(409, '本任务配置的执行步数已用完，已保存工作保留。');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      latest.modelCalls++;
      this.db.prepare('INSERT INTO local_project_model_calls(operation_id,request_id,json) VALUES(?,?,?)')
        .run(latest.input.operationId, requestId, JSON.stringify({ state: 'pending', purpose,
          runId: operation.input.runId, requirementsRevision: operation.input.requirementsRevision,
          approvalRevision: operation.input.approvalRevision, at: new Date().toISOString() }));
      this.save(latest); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  settleModel(id: string, requestId: string, usage: unknown, failureCode?: ProjectModelFailureCode): void {
    const row = this.db.prepare('SELECT json FROM local_project_model_calls WHERE operation_id=? AND request_id=?').get(id, requestId);
    const previous = row ? JSON.parse(String(row.json)) as Record<string, unknown> : {};
    this.db.prepare('UPDATE local_project_model_calls SET json=? WHERE operation_id=? AND request_id=?')
      .run(JSON.stringify({ ...previous, state: 'settled', usage, failureCode, settledAt: new Date().toISOString() }), id, requestId);
    const operation = this.get(id);
    if (operation) this.options.result(operation.input.taskId);
  }

  /** Startup recovery runs after acquiring the sole runtime lease. An old
   * transport is no longer owned here; its provider usage remains unknown. */
  recoverModelCalls(): void {
    this.options.assertActive();
    if (this.pending.size) throw new ProjectError(409, '项目模型恢复必须在重新派发执行前完成。');
    const pending = this.db.prepare(`SELECT operation_id, request_id, json FROM local_project_model_calls
      WHERE json_extract(json,'$.state')='pending'`).all();
    if (!pending.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const interruptedAt = new Date().toISOString();
      for (const row of pending) {
        const previous = JSON.parse(String(row.json));
        this.db.prepare('UPDATE local_project_model_calls SET json=? WHERE operation_id=? AND request_id=?')
          .run(JSON.stringify({ ...previous, state: 'unknown', usage: { usageStatus: 'unknown' },
            failureCode: 'transport_interrupted', interruptedAt, recoveryReason: 'runtime_restarted' }), row.operation_id, row.request_id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  modelTiming(id: string, requestId: string, timing: Record<string, unknown>): void {
    const row = this.db.prepare('SELECT json FROM local_project_model_calls WHERE operation_id=? AND request_id=?').get(id, requestId);
    if (!row) return;
    this.db.prepare('UPDATE local_project_model_calls SET json=? WHERE operation_id=? AND request_id=?')
      .run(JSON.stringify({ ...JSON.parse(String(row.json)), transport: timing }), id, requestId);
  }

  modelText(id: string, requestId: string, publicText: string): void {
    const row = this.db.prepare('SELECT json FROM local_project_model_calls WHERE operation_id=? AND request_id=?').get(id, requestId);
    if (!row) return;
    this.db.prepare('UPDATE local_project_model_calls SET json=? WHERE operation_id=? AND request_id=?')
      .run(JSON.stringify({ ...JSON.parse(String(row.json)), publicText }), id, requestId);
  }

  receivedModelText(id: string, requirementsRevision?: number): string {
    return this.db.prepare(`SELECT json FROM local_project_model_calls WHERE operation_id=?
      AND (? IS NULL OR json_extract(json,'$.requirementsRevision')=?) ORDER BY rowid`)
      .all(id, requirementsRevision ?? null, requirementsRevision ?? null)
      .map(row => (JSON.parse(String(row.json)) as { publicText?: string }).publicText ?? '').filter(Boolean).join('\n\n');
  }

  record(deviceId: string, raw: ProjectEvent): { sequence: number } {
    return this.recordBatch(deviceId, [raw]);
  }

  recordBatch(deviceId: string, events: readonly ProjectEvent[]): { sequence: number } {
    this.options.assertActive();
    let sequence: number | undefined;
    const changedTasks = new Set<string>();
    let owner: { operationId: string; sequence: number } | undefined;
    try {
      for (const raw of events) {
        const event = projectEventSchema.parse(raw);
        if (owner?.operationId !== event.operationId) {
          const row = this.db.prepare("SELECT json_extract(json,'$.sequence') AS sequence FROM local_project_operations WHERE id=? AND device_id=?")
            .get(event.operationId, deviceId);
          if (!row) throw new ProjectError(404, '项目操作不属于这台设备。');
          owner = { operationId: event.operationId, sequence: Number(row.sequence) };
        }
        const serialized = JSON.stringify(event);
        const hash = digest(serialized);
        const receipt = this.db.prepare('SELECT hash FROM local_project_events WHERE operation_id=? AND sequence=?').get(event.operationId, event.sequence);
        if (receipt) {
          if (receipt.hash !== hash) throw new ProjectError(409, '已接收的项目事件不能改写。');
          sequence = owner.sequence;
          continue;
        }
        const operation = this.get(event.operationId)!;
        this.recordEvent(operation, event, serialized, hash);
        sequence = operation.sequence;
        owner = undefined;
        changedTasks.add(operation.input.taskId);
      }
    } finally {
      // Each event commits independently. Reconcile new receipts once even if a later
      // event is rejected. The coordinator already retries dirty projections on its tick.
      if (changedTasks.size) this.options.changed();
      for (const taskId of changedTasks) this.options.result(taskId);
    }
    if (sequence === undefined) throw new ProjectError(400, '项目事件批次不能为空。');
    return { sequence };
  }

  private recordEvent(operation: ProjectOperation, event: ProjectEvent, serialized: string, hash: string): void {
    const { deviceId } = operation.input.spec;
    if (event.sequence !== operation.sequence + 1) throw new ProjectError(409, `项目事件应从 ${operation.sequence + 1} 继续上传。`);
    if (event.requirementsRevision > operation.input.requirementsRevision) throw new ProjectError(409, '项目事件使用了未知要求版本。');
    const value = event.event;
    if (value.kind === 'tool' && operation.input.contract?.version === 2) {
      const accepted = this.db.prepare(`SELECT json_extract(json,'$.requirementsRevision') AS revision FROM local_project_events
        WHERE operation_id=? AND json_extract(json,'$.event.kind')='tool' AND json_extract(json,'$.event.item.id')=?
        ORDER BY sequence LIMIT 1`).get(event.operationId, value.item.id);
      if (accepted && Number(accepted.revision) !== event.requirementsRevision) {
        throw new ProjectError(409, `操作 ${value.item.id} 属于要求版本 ${accepted.revision}，不能改记到版本 ${event.requirementsRevision}。`);
      }
    }
    if (value.kind === 'paused' && operation.environment?.state === 'closed') {
      const pending = this.pending.get(event.operationId);
      if (pending && !pending.stopMode) pending.stopMode = 'pause';
    }
    const ended = terminal.has(operation.state);
    const workspaceHeld = occupiesWorkspace(operation);
    const server = Boolean(operation.input.spec.serverResources);
    const finished = value.kind === 'finished' ? value : undefined;
    if ((value.kind === 'plan' || value.kind === 'verification' || value.kind === 'delivery') && ended && operation.state !== 'unknown') throw new ProjectError(409, '已结束操作的交付证据不能改写。');
    if (operation.input.contract?.version === 2 && (value.kind === 'plan' || value.kind === 'verification')) {
      throw new ProjectError(409, '当前项目使用实际执行的交付检查，不能提交旧版手填方案或检查回执。');
    }
    if (value.kind === 'plan' && digest(JSON.stringify(value.plan)) !== value.planHash) throw new ProjectError(409, '执行方案哈希不匹配。');
    if (value.kind === 'plan') {
      const problem = projectPlanProblem(value.plan, operation.input.contract?.version === 1 ? operation.input.contract.criteria : [], operation.input.updates);
      if (problem) throw new ProjectError(409, problem);
      const tools = this.toolsForRevision(event.operationId, event.requirementsRevision);
      for (const source of value.plan.basis) {
        if (source.kind === 'skill' && !source.toolIds?.length) throw new ProjectError(409, 'Skill 规则缺少实际读取回执。');
        for (const id of source.toolIds ?? []) if (!tools.some(tool => tool.id === id && tool.state === 'succeeded')) throw new ProjectError(409, '方案依据的读取回执不属于当前任务。');
      }
    }
    if (value.kind === 'verification') {
      if (value.verification.requirementsRevision !== event.requirementsRevision || !operation.delivery
        || operation.delivery.planHash !== value.verification.planHash) throw new ProjectError(409, '检查回执不属于当前执行方案。');
      const tools = this.toolsForRevision(event.operationId, event.requirementsRevision);
      for (const check of value.verification.checks) for (const id of check.toolIds) {
        const tool = tools.find(tool => tool.id === id);
        if (!tool || tool.type === 'dynamicToolCall' || tool.state === 'running' || check.status === 'passed' && tool.state !== 'succeeded') {
          throw new ProjectError(409, '检查证据引用了未知、未完成或失败的操作。');
        }
      }
    }
    if (value.kind === 'delivery') {
      const delivery = value.delivery;
      if (operation.input.contract?.version !== 2 || delivery.requirementsRevision !== event.requirementsRevision) {
        throw new ProjectError(409, '交付检查协议或要求版本与本任务不一致。');
      }
      const problem = projectRequirementProblem(delivery.request, operation.input.contract.requirements.filter(requirement => requirement.revision <= event.requirementsRevision));
      if (problem) throw new ProjectError(409, problem);
      if (digest(JSON.stringify(delivery.plan)) !== delivery.planHash || !isDeepStrictEqual(delivery.plan.outputs, delivery.request.outputs)
        || delivery.plan.checks.length !== delivery.request.checks.length || delivery.plan.checks.some(check =>
          !delivery.request.checks.some(requested => requested.id === check.id && requested.required === check.required))) {
        throw new ProjectError(409, '交付检查与实际请求或成果清单不一致。');
      }
      if (new Set(delivery.evidence.map(check => check.id)).size !== delivery.evidence.length) throw new ProjectError(409, '实际检查记录编号不能重复。');
      const tools = this.toolsForRevision(event.operationId, event.requirementsRevision);
      const dependencies = new Set<string>();
      const checkScopes = new Map(delivery.request.checks.map(check => {
        const scope = projectCheckScope(delivery.request, check);
        for (const path of scope.dependencyPaths) dependencies.add(path);
        return [check.id, { check, scope }] as const;
      }));
      const currentDependencies = delivery.verification?.dependencies ?? [];
      const outputNames = new Set(delivery.verification?.files.map(file => file.publishedPath));
      if (new Set(currentDependencies.map(file => file.path)).size !== currentDependencies.length
        || currentDependencies.some(file => !dependencies.has(file.path) || outputNames.has(file.publishedPath)
          || file.format !== 'file' || !projectFilePathSchema.safeParse(file.publishedPath).success)) {
        throw new ProjectError(409, '辅助验证文件未绑定本次检查范围。');
      }
      for (const evidence of delivery.evidence) {
        const { check, scope } = checkScopes.get(evidence.id) ?? {};
        const tool = tools.find(tool => tool.id === evidence.toolId);
        if (!check || evidence.requirementsRevision !== event.requirementsRevision
          || !isDeepStrictEqual(evidence.requirementIds, check.requirementIds)
          || !isDeepStrictEqual(evidence.command, check.command) || !isDeepStrictEqual(evidence.assertions, check.assertions)
          || !isDeepStrictEqual(evidence.desktop, check.desktop)
          || !isDeepStrictEqual(evidence.reportBindings, check.reportBindings)) {
          throw new ProjectError(409, '检查记录未绑定本次实际检查定义：' + evidence.id);
        }
        if (evidence.definitionVersion === 2 && scope) {
          const observed = new Set(evidence.files.map(file => file.path));
          const helpers = evidence.dependencies ?? [];
          const observedDependencies = new Set(helpers.map(file => file.path));
          if (evidence.definitionHash !== digest(scope.definition) || observedDependencies.size !== helpers.length
            || helpers.some(file => !scope.dependencyPaths.has(file.path) || file.format !== 'file'
              || !projectFilePathSchema.safeParse(file.publishedPath).success)
            || evidence.status === 'passed' && (evidence.files.length !== scope.paths.size || [...scope.paths].some(path => !observed.has(path))
              || helpers.length !== scope.dependencyPaths.size)) {
            throw new ProjectError(409, '检查记录未绑定本次实际检查定义：' + evidence.id);
          }
        } else if (evidence.dependencies?.length || evidence.status === 'passed' && scope?.dependencyPaths.size
          || evidence.definitionHash !== digest(JSON.stringify({ outputs: delivery.request.outputs, check }))) {
          throw new ProjectError(409, '检查记录未绑定本次实际检查定义：' + evidence.id);
        }
        if (!tool || tool.type !== 'projectCheck' || tool.state === 'running' || evidence.status === 'passed' && tool.state !== 'succeeded') {
          throw new ProjectError(409, '检查缺少本次真实执行的工具回执：' + evidence.id);
        }
      }
      if (delivery.verification && (delivery.verification.planHash !== delivery.planHash
        || delivery.verification.requirementsRevision !== event.requirementsRevision)) throw new ProjectError(409, '检查结果引用了其他方案或要求版本。');
    }
    if (finished?.state === 'completed' && operation.input.contract && event.requirementsRevision === operation.input.requirementsRevision) {
      const problem = projectDeliveryProblem(operation.delivery, event.requirementsRevision, undefined,
        operation.input.contract.version === 2 ? operation.input.contract.finalFiles : undefined);
      if (problem) throw new ProjectError(409, problem);
    }
    const staleServerFinish = server && finished && finished.state !== 'unknown'
      && event.requirementsRevision < operation.input.requirementsRevision;
    if (value.kind === 'workspace_saved' && ((server ? operation.input.spec.serverResources?.workspaceStorage !== 'persistent'
      : operation.input.contract?.version !== 2) || value.identity !== operation.workspace?.identity)) {
      throw new ProjectError(409, '检查点不属于当前已授权工作区。');
    }
    if (value.kind === 'workspace_restored' && (!server || operation.input.spec.serverResources?.workspaceStorage !== 'persistent'
      || operation.checkpoint?.hash !== value.hash || operation.checkpoint.identity !== value.previousIdentity
      || operation.workspace?.realPath !== value.realPath)) throw new ProjectError(409, '恢复工作区缺少与原操作匹配的检查点。');
    if (server && value.kind === 'preview') throw new ProjectError(409, '服务端任务不提供本机预览地址。');
    if (value.kind === 'environment' && value.retainedWorkspace && (!server || value.state !== 'closed')) {
      throw new ProjectError(409, '仅已排空的服务端任务可保留暂时暂停的工作区。');
    }
    if (finished && finished.state === 'completed' && operation.environment?.retainedWorkspace && !operation.input.retainWorkspace) {
      throw new ProjectError(409, '当前操作没有交付后保留工作区的范围。');
    }
    if (server && workspaceHeld && ((finished && finished.state !== 'unknown') || value.kind === 'paused')
      && (operation.environment?.state !== 'closed' || (value.kind === 'paused') !== Boolean(operation.environment.retainedWorkspace))) {
      throw new ProjectError(409, '服务端任务尚未保存与本次操作匹配的排空回执。');
    }
    if (value.kind === 'started' && linuxProjectPathSchema.safeParse(value.realPath).success !== server) {
      throw new ProjectError(409, '工作区路径与已获准的执行设备系统不一致。');
    }
    if (value.kind === 'started' && (server || win32.relative(operation.input.spec.root, value.realPath) !== '') && operation.workspace?.realPath !== value.realPath) {
      // The initial user-selected path is resolved by the local executor. Bind its actual identity once.
      if (operation.workspace) throw new ProjectError(409, '项目目录身份与已绑定工作区不一致。');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO local_project_events(operation_id,sequence,hash,json) VALUES(?,?,?,?)').run(event.operationId, event.sequence, hash, serialized);
      operation.sequence = event.sequence;
      if (event.requirementsRevision === operation.input.requirementsRevision) operation.activity = { kind: value.kind, at: event.at };
      if (value.kind === 'plan' && event.requirementsRevision === operation.input.requirementsRevision) {
        operation.delivery = { plan: value.plan, planHash: value.planHash, requirementsRevision: event.requirementsRevision };
      }
      if (value.kind === 'verification' && event.requirementsRevision === operation.input.requirementsRevision && operation.delivery) {
        operation.delivery.verification = value.verification;
      }
      if (value.kind === 'delivery' && event.requirementsRevision === operation.input.requirementsRevision) operation.delivery = value.delivery;
      if (value.kind === 'model_transport' && event.requirementsRevision === operation.input.requirementsRevision) operation.modelTransport = { requestId: value.requestId, state: value.state,
        responseId: value.responseId, bytes: value.bytes, at: event.at };
      if (value.kind === 'started') {
        if (operation.workspace && operation.workspace.identity !== value.identity) throw new ProjectError(409, '项目目录身份已经改变。');
        operation.threadId = value.threadId; operation.engineVersion = value.engineVersion; operation.startedAt ??= event.at;
        if (!ended) { operation.state = 'running'; delete operation.error; }
        operation.workspace = { id: digest(deviceId + ':' + (server ? value.realPath : value.realPath.toLowerCase())), deviceId,
          root: operation.input.spec.root, realPath: value.realPath, identity: value.identity, lastTaskId: operation.input.taskId, updatedAt: event.at,
          ...(operation.input.spec.root === 'task-temporary' ? { temporary: true } : {}) };
        this.db.prepare('INSERT INTO local_project_workspaces(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
          .run(operation.workspace.id, JSON.stringify(operation.workspace));
      } else if (value.kind === 'workspace_saved') operation.checkpoint = { hash: value.hash, identity: value.identity };
      else if (value.kind === 'workspace_restored') {
        operation.workspace = { ...operation.workspace!, identity: value.identity, updatedAt: event.at };
      } else if (value.kind === 'turn' && event.requirementsRevision === operation.input.requirementsRevision) operation.turnId = value.turnId;
      else if (value.kind === 'text' && (operation.input.contract?.version !== 2 || event.requirementsRevision === operation.input.requirementsRevision)) operation.output += value.text;
      else if (value.kind === 'tool') {
        const found = operation.tools.find(item => item.id === value.item.id);
        if (found) Object.assign(found, value.item); else operation.tools.push(value.item);
        operation.tools = operation.tools.slice(-100);
        operation.toolCounts = this.toolCounts(event.operationId);
      } else if (value.kind === 'diff' && (operation.input.contract?.version !== 2 || event.requirementsRevision === operation.input.requirementsRevision)) operation.diff = value.diff;
      else if (value.kind === 'preview' && (operation.input.contract?.version !== 2 || event.requirementsRevision === operation.input.requirementsRevision)) {
        if (!operation.previews.some(preview => preview.url === value.url)) operation.previews.push({ url: value.url, title: value.title });
      } else if (value.kind === 'interaction') {
        const question = value.type === 'question' && event.requirementsRevision === operation.input.requirementsRevision;
        if (!operation.interactions.some(item => item.id === value.id)) operation.interactions.push({ id: value.id, kind: value.type,
          method: value.method, title: value.title, detail: value.detail, request: value.request, state: question ? 'pending' : 'cancelled', createdAt: event.at });
        if (question && !ended) operation.state = 'waiting';
      } else if (value.kind === 'environment') {
        operation.environment = { state: value.state, terminals: value.terminals,
          ...(server && value.state === 'closed' && value.retainedWorkspace ? { retainedWorkspace: true } : {}) };
        if (value.state === 'closed' && !operation.environment.retainedWorkspace && (ended || this.closingEnvironments.has(event.operationId))) operation.workspaceReserved = false;
      } else if (value.kind === 'paused' && (!ended || operation.state === 'unknown')) {
        operation.state = !server && this.pending.get(event.operationId)?.stopMode === 'cancel' ? 'cancelled' : 'waiting';
        operation.error = value.reason;
        if (operation.input.contract?.version === 2 && operation.state === 'waiting') {
          delete operation.finishedAt;
          delete operation.finalOutput;
        }
        if (!server) operation.workspaceReserved = false;
        for (const interaction of operation.interactions) if (interaction.state === 'pending') interaction.state = 'cancelled';
      }
      else if (finished && (event.requirementsRevision === operation.input.requirementsRevision || finished.state === 'unknown' || staleServerFinish)) {
        // A late receipt can resolve unknown, but cannot rewrite an already confirmed outcome.
        if (!ended || operation.state === 'unknown') {
          operation.state = staleServerFinish && finished.state !== 'cancelled' ? 'failed' : finished.state;
          operation.finalOutput = finished.output;
          operation.error = staleServerFinish && finished.state !== 'cancelled'
            ? '原服务端环境在收到补充要求前已结束，请重新委托并确认。' : finished.error;
          operation.finishedAt = event.at;
          if (finished.state !== 'unknown' || (operation.environment?.state === 'closed' && !operation.environment.retainedWorkspace)) operation.workspaceReserved = false;
        }
        for (const interaction of operation.interactions) if (interaction.state === 'pending') interaction.state = 'cancelled';
      }
      this.save(operation); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try { this.pending.get(event.operationId)?.context.onEvent(operation, event); } catch { /* The durable receipt owns settlement, display projections retry on tick. */ }
    if (!server && finished && finished.state !== 'unknown' && event.requirementsRevision < operation.input.requirementsRevision && this.pending.has(event.operationId)) {
      // The prior turn may have finished while the new owner input was in transit.
      // Reattach the current explicitly updated task after its old native work drained.
      this.dispatch(operation.input.operationId);
    }
    if (value.kind === 'environment' && value.state !== 'active' && !operation.environment?.retainedWorkspace) {
      const closing = this.closingEnvironments.get(event.operationId);
      if (closing) {
        clearTimeout(closing.timer); this.closingEnvironments.delete(event.operationId);
        if (value.state === 'closed') closing.resolve(operation); else closing.reject(new ProjectError(409, '本机环境退出状态未知。'));
      }
    }
    const stopMode = this.pending.get(event.operationId)?.stopMode;
    if (terminal.has(operation.state) && (!stopMode || !occupiesWorkspace(operation) || operation.state === 'unknown')
      || value.kind === 'paused' && stopMode === 'pause') this.settle(operation);
    if (workspaceHeld && !occupiesWorkspace(operation)) this.dispatchWaiting(deviceId);
  }

  setStopMode(id: string, mode: 'pause' | 'cancel'): void {
    const pending = this.pending.get(id); if (pending) pending.stopMode = mode;
  }

  stop(id: string, reason: string, mode: 'pause' | 'cancel' = 'cancel'): Promise<ProjectOperation> {
    const operation = this.get(id);
    if (!operation) return Promise.reject(new ProjectError(404, '项目操作不存在。'));
    if (mode === 'pause' && pausedServerWorkspace(operation) && !this.pending.has(id)) return Promise.resolve(operation);
    if (!occupiesWorkspace(operation) && !operation.environment?.retainedWorkspace) {
      if (!terminal.has(operation.state)) {
        operation.state = mode === 'pause' ? 'waiting' : 'cancelled';
        operation.error = reason;
        this.save(operation);
        this.settle(operation);
        this.dispatchWaiting(operation.input.spec.deviceId);
        this.options.changed(); this.options.result(operation.input.taskId);
      }
      return Promise.resolve(operation);
    }
    const pending = this.pending.get(id);
    if (terminal.has(operation.state) || !pending) {
      const previous = this.closingEnvironments.get(id); if (previous) return previous.promise;
      let resolve!: (value: ProjectOperation) => void; let reject!: (error: Error) => void;
      const promise = new Promise<ProjectOperation>((done, fail) => { resolve = done; reject = fail; });
      const timer = setTimeout(() => {
        this.closingEnvironments.delete(id);
        const latest = this.get(id)!; latest.environment = { ...latest.environment, state: 'unknown', terminals: latest.environment?.terminals ?? [] }; this.save(latest);
        reject(new ProjectError(409, '尚未收到本机环境排空回执。')); this.options.changed();
      }, 30000); timer.unref();
      this.closingEnvironments.set(id, { promise, resolve, reject, timer });
      try { this.options.send(operation.input.spec.deviceId, { kind: 'project-cancel', operationId: id, reason, mode }); } catch {}
      return promise;
    }
    pending.stopMode = mode;
    try { this.options.send(operation.input.spec.deviceId, { kind: 'project-cancel', operationId: id, reason, mode }); } catch {}
    if (!pending.settlement) {
      pending.settlement = setTimeout(() => {
        const latest = this.get(id)!;
        const message = '尚未收到设备排空回执，不能确认项目执行已停止。';
        if (terminal.has(latest.state)) latest.environment = { state: 'unknown', terminals: latest.environment?.terminals ?? [] };
        else { latest.state = 'unknown'; latest.error = message; }
        this.save(latest);
        this.settle(latest, new ProjectError(409, message)); this.options.changed(); this.options.result(latest.input.taskId);
      }, 30000);
      pending.settlement.unref();
    }
    return pending.promise;
  }

  private settle(operation: ProjectOperation, error?: Error): void {
    const pending = this.pending.get(operation.input.operationId);
    if (!pending) return;
    clearTimeout(pending.settlement);
    pending.context.signal.removeEventListener('abort', pending.abort);
    this.pending.delete(operation.input.operationId);
    if (error) pending.reject(error);
    else if (operation.state === 'unknown') pending.reject(new ProjectError(409, operation.error ?? '项目操作结果未知。'));
    else pending.resolve(operation);
  }

  async drain(): Promise<void> {
    this.fileResults.close();
    this.draining = true;
    const results = await Promise.allSettled(this.operationsToDrain().map(operation =>
      this.stop(operation.input.operationId, '正在关闭项目执行，等待本机操作排空。', 'pause')));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
