import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';
import PQueue from 'p-queue';
import type { LocalDevice } from '../../shared/local-device.js';
import type { ProjectOperation } from '../../shared/local-project.js';
import { isProjectResultPath, projectFilesCapability, projectFinalFilesCapability, projectFilesManifestSchema, projectFilesUploadSchema,
  projectFileSelectionSchema, projectFinalFileIdentity, type ProjectFileDelivery, type ProjectFileSnapshot, type ProjectFilesRequest,
  type ProjectFilesUpload, type ProjectFileSelection, type ProjectFinalFileSelection } from '../../shared/project-files.js';
import { projectContractV2Capability, projectDeliveryProblem } from '../../shared/project-contract.js';
import { HttpError } from '../http.js';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function projectFileSnapshot(operation: ProjectOperation, stageFingerprint?: string): ProjectFileSnapshot {
  if (!operation.checkpoint) throw new HttpError(409, '任务尚未保存可领取的工作区。');
  const { operationId, taskId, specHash, approvalRevision, requirementsRevision } = operation.input;
  return { operationId, taskId, specHash, approvalRevision, requirementsRevision, checkpoint: operation.checkpoint.hash,
    ...(stageFingerprint ? { stageFingerprint } : {}) };
}
export function projectFinalFileSnapshot(operation: ProjectOperation) {
  const { operationId, taskId, specHash, approvalRevision, requirementsRevision, deliverFiles, spec, contract } = operation.input;
  if (!deliverFiles || spec.serverResources || contract?.version !== 2 || operation.state !== 'completed') return;
  const final = projectFinalFileIdentity(operation.delivery, requirementsRevision);
  if (!final) return;
  const finalFingerprint = hash(final.proofIdentity);
  const snapshot: ProjectFileSnapshot = { operationId, taskId, specHash, approvalRevision, requirementsRevision,
    checkpoint: finalFingerprint, finalFingerprint };
  return { snapshot, files: final.files };
}
function matchesFinalSelection(delivery: Pick<ProjectFileDelivery, 'files' | 'omittedLinks'>, files: ProjectFinalFileSelection): boolean {
  if (delivery.files.length !== files.length || delivery.omittedLinks !== 0) return false;
  const expected = new Map(files.map(file => [file.path, file]));
  return delivery.files.every(file => isDeepStrictEqual(file, expected.get(file.path)));
}
function finalEnvironment(operation: ProjectOperation): boolean {
  const environment = operation.environment;
  return environment?.state === 'closed' || Boolean(environment?.state === 'active' && operation.input.spec.network && environment.terminals.length);
}
function matchesSelection(delivery: Pick<ProjectFileDelivery, 'snapshot' | 'files'>, selection: ProjectFileSelection): boolean {
  return delivery.snapshot.stageFingerprint === selection.fingerprint && delivery.files.length === selection.files.length
    && new Set(delivery.files.map(file => file.sourcePath)).size === delivery.files.length
    && selection.files.every(expected => delivery.files.some(file => file.sourcePath === expected.path
      && file.size === expected.size && file.sha256 === expected.sha256));
}
interface Pending {
  deviceId: string; snapshot: ProjectFileSnapshot; guard(): void; deliveryId?: string;
  selection?: ProjectFileSelection;
  finalSelection?: ProjectFinalFileSelection;
  resolve(value: ProjectFileDelivery): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
}
interface Options {
  operation(id: string): ProjectOperation | undefined;
  device(id: string): LocalDevice;
  send(deviceId: string, request: ProjectFilesRequest): void;
  changed(taskId: string): void;
  assertActive(): void;
  timeoutMs?: number;
}

/** Durable published files have their own lifetime. Temporary workspace cleanup never deletes them. */
export class ProjectFiles {
  private readonly pending = new Map<string, Pending>();
  private readonly transfers = new Map<string, Promise<ProjectFileDelivery>>();
  private readonly bundles = new PQueue({ concurrency: 1 });
  private closed = false;
  private published(value: ProjectFileDelivery): ProjectFileDelivery {
    // Preserve historical receipts; exclude runtime metadata from their public read projection too.
    return { ...value, files: value.files.filter(file => isProjectResultPath(file.path)) };
  }
  constructor(private readonly db: DatabaseSync, private readonly options: Options) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_file_deliveries (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, requirements_revision INTEGER NOT NULL,
      checkpoint TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS project_file_delivery_snapshot ON project_file_deliveries(operation_id,requirements_revision,checkpoint,ready);
      CREATE TABLE IF NOT EXISTS project_file_chunks (
      delivery_id TEXT NOT NULL REFERENCES project_file_deliveries(id), path TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY(delivery_id,path,offset));`);
  }
  forOperation(operation: ProjectOperation): ProjectFileDelivery | undefined {
    const final = projectFinalFileSnapshot(operation);
    const snapshot = final?.snapshot ?? (operation.checkpoint && projectFileSnapshot(operation));
    if (!snapshot) return;
    const row = this.db.prepare("SELECT json FROM project_file_deliveries WHERE operation_id=? AND requirements_revision=? AND checkpoint=? AND ready=1 AND json_extract(json,'$.snapshot.stageFingerprint') IS NULL ORDER BY rowid DESC LIMIT 1")
      .get(snapshot.operationId, snapshot.requirementsRevision, snapshot.checkpoint);
    if (!row) return;
    const value = JSON.parse(String(row.json)) as ProjectFileDelivery;
    if (!isDeepStrictEqual(value.snapshot, snapshot) || final && !matchesFinalSelection(value, final.files)) return;
    return this.published(value);
  }
  forStage(operation: ProjectOperation, selection: ProjectFileSelection, requirementsRevision = operation.input.requirementsRevision): ProjectFileDelivery | undefined {
    const row = this.db.prepare("SELECT json FROM project_file_deliveries WHERE operation_id=? AND requirements_revision=? AND ready=1 AND json_extract(json,'$.snapshot.stageFingerprint')=? ORDER BY rowid DESC LIMIT 1")
      .get(operation.input.operationId, requirementsRevision, selection.fingerprint);
    if (!row) return;
    const value = JSON.parse(String(row.json)) as ProjectFileDelivery, input = operation.input;
    if (value.snapshot.taskId !== input.taskId || value.snapshot.specHash !== input.specHash
      || value.snapshot.approvalRevision !== input.approvalRevision || !matchesSelection(value, selection)) return;
    return this.published(value);
  }
  metadata(): ProjectFileDelivery[] {
    return this.db.prepare('SELECT json FROM project_file_deliveries WHERE ready=1 ORDER BY rowid').all().map(row => this.published(JSON.parse(String(row.json))));
  }
  get(id: string): ProjectFileDelivery | undefined {
    const row = this.db.prepare('SELECT json FROM project_file_deliveries WHERE id=? AND ready=1').get(id);
    return row ? this.published(JSON.parse(String(row.json))) : undefined;
  }
  async prepare(operation: ProjectOperation, guard: () => void, signal?: AbortSignal, selection?: ProjectFileSelection): Promise<ProjectFileDelivery> {
    guard(); this.options.assertActive(); signal?.throwIfAborted();
    if (selection) selection = projectFileSelectionSchema.parse(selection);
    const existing = selection ? this.forStage(operation, selection) : this.forOperation(operation); if (existing) return existing;
    if (this.closed) throw new HttpError(409, '成果传输正在停止。');
    const final = !selection ? projectFinalFileSnapshot(operation) : undefined;
    const device = this.options.device(operation.input.spec.deviceId);
    if (!device.capabilities.includes(projectFilesCapability) || selection && !device.capabilities.includes(projectContractV2Capability)
      || final && (device.platform !== 'win32' || !device.capabilities.includes(projectFinalFilesCapability))
      || device.platform !== 'linux' && !selection && !final) throw new HttpError(409, '执行端或当前操作尚未支持本次文件领取。');
    if (final) {
      const contract = operation.input.contract;
      const problem = projectDeliveryProblem(operation.delivery, operation.input.requirementsRevision, final.files,
        contract?.version === 2 ? contract.finalFiles : undefined);
      if (problem) throw new HttpError(409, problem);
    }
    const snapshot = final?.snapshot ?? projectFileSnapshot(operation, selection?.fingerprint);
    if (!device.online || device.revokedAt) throw new HttpError(409, '执行端离线或已撤销，已保存的工作不会重新执行。');
    const assertCurrent = () => {
      guard(); this.options.assertActive(); signal?.throwIfAborted();
      const current = this.options.operation(snapshot.operationId), liveDevice = this.options.device(device.id);
      if (this.closed || !liveDevice.online || liveDevice.revokedAt || !liveDevice.capabilities.includes(projectFilesCapability)
        || !current || current.input.spec.deviceId !== device.id) {
        throw new HttpError(409, '设备或任务状态已变化，已停止领取文件。');
      }
      if (final) {
        if (liveDevice.platform !== 'win32' || !liveDevice.capabilities.includes(projectFinalFilesCapability)
          || !finalEnvironment(current) || !isDeepStrictEqual(projectFinalFileSnapshot(current)?.snapshot, snapshot)) {
          throw new HttpError(409, '最终成果或任务要求已变化，已停止领取文件。');
        }
        return;
      }
      const retained = current?.input.spec.serverResources
        ? current.environment?.retainedWorkspace && current.input.spec.serverResources.workspaceStorage === 'persistent'
        : selection && current?.state === 'waiting';
      if (!isDeepStrictEqual(projectFileSnapshot(current, selection?.fingerprint), snapshot)
        || !['waiting', 'completed', 'failed'].includes(current.state) || current.environment?.state !== 'closed'
        || !retained) {
        throw new HttpError(409, '工作区状态或任务要求已变化，请刷新任务后重新领取。');
      }
    };
    assertCurrent();
    const transferKey = JSON.stringify(snapshot), active = this.transfers.get(transferKey);
    if (active) { const delivery = await active; guard(); signal?.throwIfAborted(); return delivery; }
    const requestId = randomUUID();
    let abort: (() => void) | undefined;
    const result = new Promise<ProjectFileDelivery>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(requestId, new HttpError(409, '文件传输未完成；保留原工作区，可再次领取，不会重新执行任务。')), this.options.timeoutMs ?? 120000);
      timer.unref();
      this.pending.set(requestId, { deviceId: device.id, snapshot, selection, finalSelection: final?.files, guard: assertCurrent, resolve, reject, timer });
      abort = () => this.fail(requestId, new HttpError(409, '文件领取已停止，原工作区仍按原许可保留。'));
      signal?.addEventListener('abort', abort, { once: true });
      try { this.options.send(device.id, { kind: 'project-files', operationId: snapshot.operationId, requestId, snapshot,
        ...(selection ? { selection } : {}), ...(final ? { finalSelection: final.files } : {}) }); }
      catch (error) { this.fail(requestId, error instanceof Error ? error : new Error('执行端连接中断。')); }
    });
    this.transfers.set(transferKey, result);
    try { const delivery = await result; guard(); return delivery; }
    finally { this.transfers.delete(transferKey); if (abort) signal?.removeEventListener('abort', abort); }
  }
  private fail(id: string, error: Error): void {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error);
  }
  disconnect(deviceId?: string): void {
    for (const [id, pending] of this.pending) if (!deviceId || pending.deviceId === deviceId) this.fail(id, new HttpError(409, '文件传输连接中断，原任务不会重新执行。'));
  }
  close(): void { this.closed = true; this.disconnect(); }
  private ready(requestId: string, value: ProjectFileDelivery): void {
    const pending = this.pending.get(requestId)!;
    this.pending.delete(requestId); clearTimeout(pending.timer);
    this.options.changed(value.snapshot.taskId); pending.resolve(this.published(value));
  }
  receive(deviceId: string, raw: ProjectFilesUpload): { deliveryId?: string; ready?: boolean } {
    this.options.assertActive();
    const input = projectFilesUploadSchema.parse(raw), pending = this.pending.get(input.requestId);
    if (!pending || pending.deviceId !== deviceId) throw new HttpError(403, '文件传输不属于本次获准请求。');
    try {
      pending.guard();
      if (input.action === 'error') throw new HttpError(409, input.error);
      if (input.action === 'begin') {
        let manifest = projectFilesManifestSchema.parse(input.manifest);
        if (!isDeepStrictEqual(manifest.snapshot, pending.snapshot)) throw new HttpError(409, '成果快照与原任务不一致。');
        const operation = this.options.operation(pending.snapshot.operationId)!;
        if (pending.selection && !matchesSelection(manifest, pending.selection)) throw new HttpError(409, '阶段文件与待审核的内容不一致。');
        if (pending.finalSelection) {
          if (!matchesFinalSelection(manifest, pending.finalSelection)) throw new HttpError(409, '上传的最终文件与验收快照不一致。');
          manifest = { ...manifest, files: pending.finalSelection };
        }
        if (!pending.selection && !pending.finalSelection) {
          const verificationOnly = new Set(operation.delivery?.verification?.dependencies?.map(file => file.publishedPath));
          if (manifest.files.some(file => verificationOnly.has(file.path))) throw new HttpError(409, '辅助验证文件不属于最终成果。');
        }
        const diskMiB = operation.input.spec.serverResources?.diskMiB;
        if (diskMiB !== undefined && manifest.files.reduce((n, file) => n + file.size, 0) > diskMiB * 1024 * 1024) throw new HttpError(413, '成果超过本任务批准的工作区容量。');
        const id = hash(JSON.stringify(manifest));
        const value: ProjectFileDelivery = { ...manifest, id, createdAt: new Date().toISOString() };
        this.db.prepare('INSERT OR IGNORE INTO project_file_deliveries(id,operation_id,requirements_revision,checkpoint,json) VALUES(?,?,?,?,?)')
          .run(id, pending.snapshot.operationId, pending.snapshot.requirementsRevision, pending.snapshot.checkpoint, JSON.stringify(value));
        const row = this.db.prepare('SELECT ready,json FROM project_file_deliveries WHERE id=?').get(id)!;
        pending.deliveryId = id;
        if (row.ready === 1) this.ready(input.requestId, JSON.parse(String(row.json)));
        return { deliveryId: id, ready: row.ready === 1 };
      }
      if (pending.deliveryId !== input.deliveryId) throw new HttpError(409, '尚未核对本批成果清单。');
      const delivery = JSON.parse(String(this.db.prepare('SELECT json FROM project_file_deliveries WHERE id=?').get(input.deliveryId)!.json)) as ProjectFileDelivery;
      if (input.action === 'chunk') {
        const file = delivery.files.find(value => value.path === input.path), bytes = Buffer.from(input.data, 'base64');
        if (!file || !bytes.length || input.offset + bytes.length > file.size || bytes.toString('base64') !== input.data) throw new HttpError(400, '文件分片范围无效。');
        const prior = this.db.prepare('SELECT data FROM project_file_chunks WHERE delivery_id=? AND path=? AND offset=?').get(delivery.id, input.path, input.offset);
        if (prior) {
          if (!Buffer.from(prior.data as Uint8Array).equals(bytes)) throw new HttpError(409, '已有文件分片不能改写。');
          return {};
        }
        const end = this.db.prepare('SELECT coalesce(max(offset+length(data)),0) AS n FROM project_file_chunks WHERE delivery_id=? AND path=?').get(delivery.id, input.path)!;
        if (Number(end.n) !== input.offset) throw new HttpError(409, '文件分片不连续。');
        this.db.prepare('INSERT INTO project_file_chunks VALUES(?,?,?,?)').run(delivery.id, input.path, input.offset, bytes);
        return {};
      }
      for (const file of delivery.files) {
        let size = 0; const digest = createHash('sha256');
        for (const row of this.db.prepare('SELECT offset,data FROM project_file_chunks WHERE delivery_id=? AND path=? ORDER BY offset').iterate(delivery.id, file.path)) {
          if (Number(row.offset) !== size) throw new HttpError(409, '文件分片不完整。');
          const bytes = Buffer.from(row.data as Uint8Array); size += bytes.length; digest.update(bytes);
        }
        if (size !== file.size || digest.digest('hex') !== file.sha256) throw new HttpError(409, '成果文件的实际内容校验失败。');
      }
      pending.guard();
      this.db.prepare('UPDATE project_file_deliveries SET ready=1 WHERE id=?').run(delivery.id);
      this.ready(input.requestId, delivery); return { deliveryId: delivery.id, ready: true };
    } catch (error) { this.fail(input.requestId, error instanceof Error ? error : new Error('文件传输失败。')); throw error; }
  }
  read(delivery: ProjectFileDelivery, path: string): Buffer {
    const file = delivery.files.find(value => value.path === path);
    if (!file) throw new HttpError(404, '此成果清单没有该文件。');
    const bytes = Buffer.concat(this.db.prepare('SELECT data FROM project_file_chunks WHERE delivery_id=? AND path=? ORDER BY offset')
      .all(delivery.id, path).map(row => Buffer.from(row.data as Uint8Array)));
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new HttpError(409, '已保存的成果文件校验失败。');
    return bytes;
  }
  async bundle(delivery: ProjectFileDelivery): Promise<Buffer> {
    return this.bundles.add(async () => {
      const zip = new AdmZip();
      for (const file of delivery.files) zip.addFile(file.path, this.read(delivery, file.path));
      return zip.toBufferPromise();
    }) as Promise<Buffer>;
  }
}
