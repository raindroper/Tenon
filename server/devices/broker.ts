import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProjectBroker } from './projects.js';
import { localProjectCapability, projectContextWindowCapability } from '../../shared/local-project.js';
import { projectFilesCapability, projectFinalFilesCapability } from '../../shared/project-files.js';
import { projectContractCapability, projectContractV2Capability } from '../../shared/project-contract.js';
import { deviceCommandSpecSchema, deviceDirectoryEntriesCapability, deviceDirectoryLookupCapability, deviceDirectoryLookupResultSchema, taskCommandCapability, type DeviceCommandSpec, type DeviceEnrollment, type DeviceGrant, type DeviceOperation,
  type DeviceOperationReceipt, type DevicePairing, type DeviceServerMessage, type DeviceStatusUpdate, type LocalDevice } from '../../shared/local-device.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');
const terminal = new Set(['completed', 'failed', 'cancelled']);
const pathInput = z.string().min(3).max(4000).refine(value => /^[A-Za-z]:[\\/]/.test(value) && !/[\0\r\n]/.test(value));
const grantSchema = z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive(), root: pathInput,
  executable: pathInput, readOnly: z.boolean(), available: z.boolean().optional(), reason: z.string().max(2000).optional() }).strict();
const statusSchema = z.object({ grants: z.array(grantSchema).max(30), capabilities: z.array(z.string().min(1).max(100)).max(30).optional(),
  // Older clients may send this retired hint; it creates no capability or authority.
  commandShell: z.unknown().optional(), version: z.string().max(100).optional() }).strict();
export const deviceEnrollmentSchema = z.object({ pairingToken: z.string().min(20).max(200), name: z.string().trim().min(1).max(120), platform: z.literal('win32') }).strict();
export const deviceRenameSchema = z.object({ name: deviceEnrollmentSchema.shape.name.refine(name => !/[\u0000-\u001f\u007f]/u.test(name)) }).strict();
export const deviceReceiptSchema = z.object({ operationId: z.string().min(1).max(200), state: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']),
  exitCode: z.number().int().optional(), stdout: z.string().max(512000).optional(), stderr: z.string().max(512000).optional(), error: z.string().max(4000).optional(),
  startedAt: z.string().datetime().optional(), finishedAt: z.string().datetime().optional() }).strict()
  .refine(value => value.state !== 'completed' || value.exitCode === 0, '完成回执必须包含真实的零退出码。');
const serverWorkerRegistrationSchema = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120),
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ServerWorkerRegistration = z.infer<typeof serverWorkerRegistrationSchema>;
export function readServerWorkerRegistration(env: NodeJS.ProcessEnv): ServerWorkerRegistration | undefined {
  const { RAE_SERVER_WORKER_ID: id, RAE_SERVER_WORKER_NAME: name, RAE_SERVER_WORKER_CREDENTIAL_HASH: credentialHash } = env;
  if (id === undefined && name === undefined && credentialHash === undefined) return;
  return serverWorkerRegistrationSchema.parse({ id, name, credentialHash });
}
interface BrokerOptions { file: string; now?: () => number; settlementTimeoutMs?: number; assertActive?: () => void; onChange?: () => void;
  onResult?: (operation: DeviceOperation) => void; onProjectResult?: (taskId: string) => void; serverWorker?: ServerWorkerRegistration }
export interface DeviceRunContext { taskId: string; taskRevision: number; runId: string; deadline: number; signal: AbortSignal; guard(): void; operationId?: string; requirementsRevision?: number }
interface Connection { deliver(message: DeviceServerMessage): void; close?(): void }
interface Pending { deviceId: string; promise: Promise<DeviceOperationReceipt>; resolve(receipt: DeviceOperationReceipt): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; settlement?: ReturnType<typeof setTimeout>; signal: AbortSignal; guard(): void; abort(): void }
interface DeviceRow { json: string; credential_hash: string }
interface OperationRow { json: string }
export class DeviceBrokerError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export class DeviceOutcomeUnknownError extends DeviceBrokerError {
  constructor(readonly receipt: DeviceOperationReceipt) { super(409, receipt.error ?? '设备操作结果未知；不会自动重发。'); }
}
/** The server owns tasks and operation intent. Device connections only transport the already approved call. */
export class DeviceBroker {
  readonly projects: ProjectBroker;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly serverWorker?: ServerWorkerRegistration;
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Pending>();
  private closing = false;
  private closed = false;
  private shutdown?: Promise<void>;
  private closeOperation?: Promise<void>;
  constructor(private readonly options: BrokerOptions) {
    this.now = options.now ?? Date.now;
    this.serverWorker = options.serverWorker && serverWorkerRegistrationSchema.parse(options.serverWorker);
    const file = options.file === ':memory:' ? options.file : resolve(options.file);
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:' && process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_device_pairings (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS local_devices (id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_device_grant_versions (device_id TEXT NOT NULL, grant_id TEXT NOT NULL, revision INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(device_id,grant_id,revision));
      CREATE TABLE IF NOT EXISTS local_device_operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, device_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_device_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS local_device_operations_device ON local_device_operations(device_id);`);
    this.active();
    if (this.serverWorker) this.registerServerWorker(this.serverWorker);
    this.projects = new ProjectBroker(this.db, {
      device: id => this.device(id), assertActive: () => this.active(),
      send: (id, message) => {
        const connection = this.connections.get(id);
        if (!connection) throw new DeviceBrokerError(409, '项目设备当前离线。');
        connection.deliver(message);
      }, changed: () => this.changed(), result: taskId => this.options.onProjectResult?.(taskId),
    });
    this.migrateOperations();
    for (const row of this.db.prepare('SELECT id,json FROM local_devices').all()) {
      const device = JSON.parse(String(row.json)) as LocalDevice;
      for (const grant of device.grants) this.db.prepare('INSERT OR IGNORE INTO local_device_grant_versions(device_id,grant_id,revision,fingerprint) VALUES(?,?,?,?)')
        .run(device.id, grant.id, grant.revision, this.grantFingerprint(grant));
    }
    for (const row of this.db.prepare(`SELECT json FROM local_device_operations
      WHERE json_extract(json,'$.receipt.state') IN ('dispatched','running','cancel_requested')`).all() as unknown as OperationRow[]) {
      const operation = JSON.parse(row.json) as DeviceOperation;
      operation.receipt = { ...operation.receipt, state: 'unknown', error: '服务重启时无法确认设备操作结果；只核对原操作，不会自动重新执行。' };
      this.saveOperation(operation);
    }
  }
  private active(): void { if (this.closed) throw new DeviceBrokerError(503, '设备连接已关闭。'); this.options.assertActive?.(); }
  private accepting(): void { this.active(); if (this.closing) throw new DeviceBrokerError(503, '设备连接正在关闭。'); }
  private changed(): void { this.options.onChange?.(); }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private transaction<T>(work: () => T): T {
    this.active(); this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private migrateOperations(): void {
    this.transaction(() => {
      const version = this.db.prepare('SELECT version FROM local_device_schema WHERE id=1').get()?.version;
      if (version !== undefined && Number(version) > 2) throw new DeviceBrokerError(503, '设备操作数据版本较新，当前程序不能写入。');
      const taskUnique = this.db.prepare("PRAGMA index_list('local_device_operations')").all().some(index => {
        if (!index.unique) return false;
        const columns = this.db.prepare(`PRAGMA index_info("${String(index.name).replaceAll('"', '""')}")`).all();
        return columns.length === 1 && columns[0].name === 'task_id';
      });
      if (taskUnique) {
        this.db.exec(`CREATE TABLE local_device_operations_migration (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, device_id TEXT NOT NULL, json TEXT NOT NULL);
          INSERT INTO local_device_operations_migration(rowid,id,task_id,device_id,json) SELECT rowid,id,task_id,device_id,json FROM local_device_operations;
          DROP TABLE local_device_operations;
          ALTER TABLE local_device_operations_migration RENAME TO local_device_operations;`);
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS local_device_operations_device ON local_device_operations(device_id);
        CREATE INDEX IF NOT EXISTS local_device_operations_task ON local_device_operations(task_id);
        INSERT INTO local_device_schema(id,version) VALUES(1,2) ON CONFLICT(id) DO UPDATE SET version=excluded.version;`);
    });
  }
  private device(id: string): LocalDevice {
    const row = this.db.prepare('SELECT json FROM local_devices WHERE id=?').get(id) as unknown as { json: string } | undefined;
    if (!row) throw new DeviceBrokerError(404, '本地设备不存在。');
    const { commandShell: _retiredShellHint, ...device } = JSON.parse(row.json) as LocalDevice & { commandShell?: unknown };
    if (device.platform === 'linux' && this.serverWorker?.id !== id) return { ...device, online: false, capabilities: [] };
    return { ...device, online: this.connections.has(id) };
  }
  private registerServerWorker(registration: ServerWorkerRegistration): void {
    const { id, name } = registration;
    const row = this.db.prepare('SELECT json FROM local_devices WHERE id=?').get(id);
    if (row) {
      const device = JSON.parse(String(row.json)) as LocalDevice;
      if (device.platform !== 'linux') throw new DeviceBrokerError(409, '服务端执行设备标识已被使用。');
      this.db.prepare('UPDATE local_devices SET json=? WHERE id=?').run(JSON.stringify({ ...device, name, online: false, capabilities: [] }), id);
      return;
    }
    const device: LocalDevice = { id, name, platform: 'linux', createdAt: this.timestamp(), grants: [], capabilities: [], online: false };
    // The Linux credential is configured outside the database. Older binaries cannot authenticate this worker.
    this.db.prepare('INSERT INTO local_devices(id,credential_hash,json) VALUES(?,?,?)').run(id, hash(secret()), JSON.stringify(device));
  }
  private saveDevice(device: LocalDevice): void {
    this.active(); this.db.prepare('UPDATE local_devices SET json=? WHERE id=?').run(JSON.stringify({ ...device, online: false }), device.id); this.changed();
  }
  listDevices(): LocalDevice[] {
    this.active(); return this.db.prepare('SELECT id FROM local_devices ORDER BY rowid').all().map(row => this.device(String(row.id)));
  }
  isDeviceActive(id: string): boolean {
    this.active();
    return Boolean(this.db.prepare(`SELECT 1 FROM local_devices WHERE id=? AND json_extract(json,'$.revokedAt') IS NULL
      AND (json_extract(json,'$.platform')<>'linux' OR id=?)`).get(id, this.serverWorker?.id ?? ''));
  }
  createPairing(): DevicePairing {
    this.accepting(); const token = secret(); const expires = this.now() + 10 * 60000;
    this.db.prepare('DELETE FROM local_device_pairings WHERE expires_at<=? OR used_at IS NOT NULL').run(this.now());
    this.db.prepare('INSERT INTO local_device_pairings(token_hash,expires_at) VALUES(?,?)').run(hash(token), expires);
    return { token, expiresAt: new Date(expires).toISOString() };
  }
  enroll(input: z.infer<typeof deviceEnrollmentSchema>): DeviceEnrollment {
    this.accepting(); const value = deviceEnrollmentSchema.parse(input); const credential = secret();
    const device = this.transaction(() => {
      const used = this.db.prepare('UPDATE local_device_pairings SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?').run(this.now(), hash(value.pairingToken), this.now());
      if (!used.changes) throw new DeviceBrokerError(403, '配对码无效、已使用或已过期。');
      const record: LocalDevice = { id: randomUUID(), name: value.name, platform: 'win32', createdAt: this.timestamp(), grants: [], capabilities: [], online: false };
      this.db.prepare('INSERT INTO local_devices(id,credential_hash,json) VALUES(?,?,?)').run(record.id, hash(credential), JSON.stringify(record)); return record;
    });
    this.changed(); return { device, credential };
  }
  authenticate(token: string, options: { allowRevoked?: boolean } = {}): LocalDevice | undefined {
    this.active(); if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return undefined;
    const digest = hash(token);
    if (this.serverWorker && timingSafeEqual(Buffer.from(digest), Buffer.from(this.serverWorker.credentialHash))) {
      const device = this.device(this.serverWorker.id);
      return device.revokedAt && !options.allowRevoked ? undefined : device;
    }
    const row = this.db.prepare('SELECT json,credential_hash FROM local_devices WHERE credential_hash=?').get(digest) as unknown as DeviceRow | undefined;
    if (!row || !timingSafeEqual(Buffer.from(digest), Buffer.from(row.credential_hash))) return undefined;
    const device = JSON.parse(row.json) as LocalDevice;
    return device.platform === 'linux' || device.revokedAt && !options.allowRevoked ? undefined : { ...device, online: this.connections.has(device.id) };
  }
  updateDevice(id: string, input: DeviceStatusUpdate): LocalDevice {
    this.accepting(); const update = statusSchema.parse(input);
    const beforeCapabilities = this.device(id).capabilities;
    if (new Set(update.grants.map(grant => grant.id)).size !== update.grants.length) throw new DeviceBrokerError(400, '设备授权标识重复。');
    const device = this.transaction(() => {
      const device = this.device(id); if (device.revokedAt) throw new DeviceBrokerError(403, '设备已撤销。');
      if (device.platform === 'linux' && (this.serverWorker?.id !== id || update.grants.length || update.commandShell !== undefined
        || update.capabilities?.some(capability => ![localProjectCapability, projectContextWindowCapability, projectFilesCapability, projectFinalFilesCapability, projectContractCapability, projectContractV2Capability].includes(capability)))) {
      throw new DeviceBrokerError(403, '服务端设备只提供隔离的项目执行能力。');
    }
      for (const grant of update.grants) {
        const latest = this.db.prepare('SELECT revision,fingerprint,retired FROM local_device_grant_versions WHERE device_id=? AND grant_id=? ORDER BY revision DESC LIMIT 1').get(id, grant.id);
        if (latest && (grant.revision < Number(latest.revision) || grant.revision === Number(latest.revision)
          && (Boolean(latest.retired) || this.grantFingerprint(grant) !== String(latest.fingerprint)))) throw new DeviceBrokerError(409, '设备授权范围变化或恢复已移除授权必须增加版本。');
      }
      for (const previous of device.grants) if (!update.grants.some(grant => grant.id === previous.id && grant.revision === previous.revision)) {
        this.db.prepare('UPDATE local_device_grant_versions SET retired=1 WHERE device_id=? AND grant_id=? AND revision=?').run(id, previous.id, previous.revision);
      }
      for (const grant of update.grants) this.db.prepare('INSERT OR IGNORE INTO local_device_grant_versions(device_id,grant_id,revision,fingerprint) VALUES(?,?,?,?)').run(id, grant.id, grant.revision, this.grantFingerprint(grant));
      device.grants = update.grants; device.capabilities = update.capabilities ?? device.capabilities; device.version = update.version ?? device.version; device.lastSeenAt = this.timestamp();
      this.db.prepare('UPDATE local_devices SET json=? WHERE id=?').run(JSON.stringify({ ...device, online: false }), device.id); return device;
    });
    this.changed();
    for (const operation of this.pendingOperations(id)) {
      try { this.validate(operation.spec); } catch { this.cancelOperation(operation.operationId, '设备授权范围或可用状态发生变化。'); }
    }
    if (JSON.stringify([...beforeCapabilities].sort()) !== JSON.stringify([...device.capabilities].sort())) this.projects.connected(id);
    return device;
  }
  private grantFingerprint(grant: DeviceGrant): string { return JSON.stringify([grant.id, grant.revision, grant.root, grant.executable, grant.readOnly]); }
  renameDevice(id: string, input: z.infer<typeof deviceRenameSchema>): LocalDevice {
    this.accepting();
    const { name } = deviceRenameSchema.parse(input);
    const device = this.device(id);
    if (device.revokedAt) throw new DeviceBrokerError(409, '设备连接已撤销。');
    if (device.platform !== 'win32') throw new DeviceBrokerError(409, '服务器名称由部署配置管理。');
    if (device.name === name) return device;
    const label = name.toLowerCase();
    if (this.listDevices().some(other => other.id !== id && !other.revokedAt && other.name.toLowerCase() === label)) {
      throw new DeviceBrokerError(409, '已有设备使用这个名称，请换一个名称。');
    }
    const renamed = { ...device, name };
    this.saveDevice(renamed);
    return renamed;
  }
  async revokeDevice(id: string): Promise<void> {
    this.accepting(); const device = this.device(id);
    if (!device.revokedAt) { device.revokedAt = this.timestamp(); this.saveDevice(device); }
    const work: Promise<unknown>[] = [];
    const reserved = new Set([...this.projects.reservedWorkspaces(), ...this.projects.retainedWorkspaces()].map(operation => operation.input.operationId));
    for (const operation of this.projects.list()) if (operation.input.spec.deviceId === id
      && (reserved.has(operation.input.operationId) || !['completed','failed','cancelled','unknown'].includes(operation.state))) {
      work.push(this.projects.stop(operation.input.operationId, '本人撤销了设备连接。'));
    }
    for (const operation of this.pendingOperations(id)) {
      work.push(this.pending.get(operation.operationId)!.promise); this.cancelOperation(operation.operationId, '本人撤销了设备连接。');
    }
    const results = await Promise.allSettled(work);
    this.connections.get(id)?.close?.();
    if (results.some(result => result.status === 'rejected') || this.db.prepare(`SELECT 1 FROM local_device_operations
      WHERE device_id=? AND json_extract(json,'$.receipt.state')='unknown' LIMIT 1`).get(id)) {
      throw new DeviceBrokerError(409, '设备许可已撤销，但部分操作结果未知，不能确认已经全部停止。');
    }
  }
  validate(input: DeviceCommandSpec): void {
    this.accepting(); const spec = deviceCommandSpecSchema.parse(input); const device = this.device(spec.deviceId);
    if (device.revokedAt) throw new DeviceBrokerError(403, '设备连接已撤销。');
    if (device.platform === 'linux') throw new DeviceBrokerError(403, '服务端设备只接受已获准的隔离项目任务。');
    if ('access' in spec || 'kind' in spec) {
      const capability = 'kind' in spec ? spec.entryType !== undefined ? deviceDirectoryEntriesCapability : deviceDirectoryLookupCapability : taskCommandCapability;
      if (!device.capabilities.includes(capability)) throw new DeviceBrokerError(409, capability === deviceDirectoryEntriesCapability
        ? '这台设备尚未提供原生文件夹查询，请更新 Windows 客户端后再试。' : '设备尚未提供本次任务所需的执行能力。');
      return;
    }
    const grant = device.grants.find(value => value.id === spec.grantId);
    if (!grant || grant.revision !== spec.grantRevision || grant.executable !== spec.executable) throw new DeviceBrokerError(409, '命令与当前设备授权版本或执行程序不一致。');
    if (grant.available === false) throw new DeviceBrokerError(409, grant.reason || '设备执行环境尚不可用。');
    const root = win32.resolve(grant.root); const cwd = win32.resolve(spec.cwd); const rel = win32.relative(root, cwd);
    if (rel === '..' || rel.startsWith('..\\') || win32.isAbsolute(rel)) throw new DeviceBrokerError(403, '命令工作目录不在设备授权目录内。');
  }
  attach(id: string, deliver: (message: DeviceServerMessage) => void, close?: () => void): () => void {
    this.accepting(); const device = this.device(id); if (device.revokedAt) throw new DeviceBrokerError(403, '设备已撤销。');
    if (this.connections.has(id)) throw new DeviceBrokerError(409, '设备已有活动连接。');
    const connection = { deliver, close }; this.connections.set(id, connection); device.lastSeenAt = this.timestamp(); this.saveDevice(device);
    this.projects.connected(id);
    // Reconnect never replays execute. Only pending cancellation can be repeated safely.
    for (const operation of this.pendingOperations(id)) if (operation.receipt.state === 'cancel_requested') deliver({ kind: 'cancel', operationId: operation.operationId, reason: operation.receipt.error ?? '原操作需要停止。' });
    return () => {
      if (this.closed) return;
      if (this.connections.get(id) !== connection) return;
      this.connections.delete(id); this.changed();
      this.projects.disconnected(id);
      for (const operation of this.pendingOperations(id)) this.cancelOperation(operation.operationId, '设备已断开，操作是否停止仍待回执核对。');
    };
  }
  getOperation(id: string): DeviceOperation | undefined {
    this.active(); const row = this.db.prepare('SELECT json FROM local_device_operations WHERE id=?').get(id) as unknown as OperationRow | undefined;
    return row ? JSON.parse(row.json) as DeviceOperation : undefined;
  }
  listOperations(taskId?: string): DeviceOperation[] {
    this.active(); const rows = taskId === undefined ? this.db.prepare('SELECT json FROM local_device_operations ORDER BY rowid').all()
      : this.db.prepare('SELECT json FROM local_device_operations WHERE task_id=? ORDER BY rowid').all(taskId);
    return (rows as unknown as OperationRow[]).map(row => JSON.parse(row.json) as DeviceOperation);
  }
  private pendingOperations(deviceId: string): DeviceOperation[] {
    const operations: DeviceOperation[] = [];
    for (const [operationId, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue;
      const operation = this.getOperation(operationId);
      if (operation) operations.push(operation);
    }
    return operations;
  }
  /** New execution paths must supply operationId; the first result is retained for legacy history readers. */
  operationForTask(taskId: string, operationId?: string): DeviceOperation | undefined {
    if (operationId === undefined) {
      this.active();
      const row = this.db.prepare('SELECT json FROM local_device_operations WHERE task_id=? ORDER BY rowid LIMIT 1').get(taskId) as unknown as OperationRow | undefined;
      return row ? JSON.parse(row.json) as DeviceOperation : undefined;
    }
    const operation = this.getOperation(operationId);
    return operation?.taskId === taskId ? operation : undefined;
  }
  private saveOperation(operation: DeviceOperation): void {
    this.active(); this.db.prepare('UPDATE local_device_operations SET json=? WHERE id=?').run(JSON.stringify(operation), operation.operationId); this.changed();
  }
  run(input: DeviceCommandSpec, context: DeviceRunContext): Promise<DeviceOperationReceipt> {
    this.accepting(); context.guard(); context.signal.throwIfAborted(); this.validate(input);
    const spec = deviceCommandSpecSchema.parse(input); const specHash = hash(JSON.stringify(spec)); const operationId = context.operationId ?? hash(`local-command:${context.taskId}`);
    const existing = this.getOperation(operationId);
    if (existing) {
      if (existing.specHash !== specHash || existing.taskId !== context.taskId || existing.taskRevision !== context.taskRevision
        || (existing.requirementsRevision ?? 1) !== (context.requirementsRevision ?? 1)) throw new DeviceBrokerError(409, '同一设备操作不能改变已登记的任务、要求版本或命令。');
      const pending = this.pending.get(operationId); if (pending) return pending.promise;
      if (terminal.has(existing.receipt.state)) return Promise.resolve(existing.receipt);
      return Promise.reject(new DeviceOutcomeUnknownError(existing.receipt));
    }
    const connection = this.connections.get(spec.deviceId); if (!connection) throw new DeviceBrokerError(409, '设备离线；未发送命令，也不会离线排队执行。');
    const remaining = Math.min(context.deadline - this.now(), spec.timeoutMs);
    if (!Number.isFinite(remaining) || remaining < 1) throw new DeviceBrokerError(409, '原回合执行期限已到，未发送设备命令。');
    const operation: DeviceOperation = { operationId, taskId: context.taskId, taskRevision: context.taskRevision, runId: context.runId, specHash, spec,
      requirementsRevision: context.requirementsRevision ?? 1,
      issuedAt: this.timestamp(), deadline: this.now() + remaining, receipt: { operationId, state: 'dispatched' } };
    context.guard(); this.active();
    this.db.prepare('INSERT INTO local_device_operations(id,task_id,device_id,json) VALUES(?,?,?,?)').run(operationId, context.taskId, spec.deviceId, JSON.stringify(operation));
    let accept!: (receipt: DeviceOperationReceipt) => void; let reject!: (error: Error) => void;
    const promise = new Promise<DeviceOperationReceipt>((done, fail) => { accept = done; reject = fail; });
    const pending: Pending = { deviceId: spec.deviceId, promise, resolve: accept, reject, signal: context.signal, guard: context.guard, abort: () => this.cancelOperation(operationId, '原回合已取消或超时；正在等待设备停止回执。') };
    this.pending.set(operationId, pending); context.signal.addEventListener('abort', pending.abort, { once: true });
    pending.timer = setTimeout(() => this.cancelOperation(operationId, '原回合设备执行期限已到；正在等待真实停止回执。'), remaining); pending.timer.unref();
    try {
      context.guard(); context.signal.throwIfAborted(); this.validate(spec);
      connection.deliver({ kind: 'execute', operationId, taskId: context.taskId, taskRevision: context.taskRevision, runId: context.runId, specHash, spec, issuedAt: operation.issuedAt, deadline: operation.deadline });
    } catch { this.markUnknown(operationId, '发送前后连接或许可变化，无法确认设备是否受理；不会重发。'); }
    this.changed(); return promise;
  }
  /** A queued device must obtain this one-use live admission immediately before its native call. */
  admit(deviceId: string, input: { operationId: string; specHash: string }): { accepted: true; deadline: number } {
    this.accepting();
    const value = z.object({ operationId: z.string().min(1).max(200), specHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
    const operation = this.getOperation(value.operationId); const pending = this.pending.get(value.operationId);
    if (!operation || operation.spec.deviceId !== deviceId || operation.specHash !== value.specHash) throw new DeviceBrokerError(403, '设备命令准入与原操作不一致。');
    if (!pending || operation.admittedAt || !['dispatched'].includes(operation.receipt.state)) throw new DeviceBrokerError(409, '设备操作已准入、停止或结果未知；不能再次启动。');
    try {
      pending.guard(); pending.signal.throwIfAborted(); this.validate(operation.spec);
      if (operation.deadline <= this.now()) throw new Error('deadline');
    } catch {
      this.cancelOperation(operation.operationId, '原任务许可、设备授权或运行期限已失效，拒绝启动。');
      throw new DeviceBrokerError(409, '原任务许可、设备授权或运行期限已失效，未授予启动准入。');
    }
    operation.admittedAt = this.timestamp(); this.saveOperation(operation); return { accepted: true, deadline: operation.deadline };
  }
  private cancelOperation(id: string, reason: string): void {
    const pending = this.pending.get(id); const operation = this.getOperation(id);
    if (!pending || !operation || terminal.has(operation.receipt.state)) return;
    operation.receipt = { ...operation.receipt, state: 'cancel_requested', error: reason }; this.saveOperation(operation);
    try { this.connections.get(operation.spec.deviceId)?.deliver({ kind: 'cancel', operationId: id, reason }); } catch { /* Unknown until an authenticated terminal receipt arrives. */ }
    if (!pending.settlement) {
      pending.settlement = setTimeout(() => this.markUnknown(id, `${reason} 尚未收到设备最终回执，操作结果未知；不能确认已停止，不会重做。`), this.options.settlementTimeoutMs ?? 5000);
      pending.settlement.unref();
    }
  }
  private markUnknown(id: string, reason: string): void {
    const operation = this.getOperation(id); if (!operation || terminal.has(operation.receipt.state)) return;
    operation.receipt = { ...operation.receipt, state: 'unknown', error: reason }; this.saveOperation(operation);
    this.settle(operation, new DeviceOutcomeUnknownError(operation.receipt));
  }
  recordResult(deviceId: string, input: DeviceOperationReceipt): DeviceOperationReceipt {
    this.active(); const receipt = deviceReceiptSchema.parse(input); const operation = this.getOperation(receipt.operationId);
    if (!operation || operation.spec.deviceId !== deviceId) throw new DeviceBrokerError(404, '设备操作不存在或不属于当前设备。');
    if (['running', 'completed'].includes(receipt.state) && !operation.admittedAt) throw new DeviceBrokerError(409, '设备操作未取得启动准入，不能报告已运行或完成。');
    const storedReceipt = operation.receipt;
    const storedTerminal = terminal.has(storedReceipt.state);
    if ((storedTerminal || operation.receiptReceivedAt) && storedReceipt.state === receipt.state
      && JSON.stringify(storedReceipt) === JSON.stringify(receipt)) return storedReceipt;
    if (receipt.state === 'running' && ['unknown', 'cancel_requested'].includes(operation.receipt.state)) return operation.receipt;
    const spec = operation.spec;
    if ('kind' in spec && receipt.state === 'completed') {
      try {
        const result = deviceDirectoryLookupResultSchema.parse(JSON.parse(receipt.stdout ?? 'null'));
        if ((result.entryType ?? 'file') !== (spec.entryType ?? 'file') || result.files.length > spec.limit
          || (spec.root !== 'windows-downloads' && win32.relative(spec.root, result.directory) !== '')
          || result.files.some(file => (spec.extension && !file.name.toLowerCase().endsWith(`.${spec.extension}`))
            || (spec.nameContains && !file.name.toLowerCase().includes(spec.nameContains.toLowerCase())))) throw new Error('scope');
      } catch { throw new DeviceBrokerError(400, '设备文件列表回执不符合任务批准范围。'); }
    }
    if (storedTerminal) throw new DeviceBrokerError(409, '最终操作回执已经保存，不能改写。');
    operation.receipt = receipt; operation.receiptReceivedAt = this.timestamp(); this.saveOperation(operation);
    if (receipt.state === 'unknown') this.settle(operation, new DeviceOutcomeUnknownError(receipt));
    else if (terminal.has(receipt.state)) this.settle(operation);
    this.options.onResult?.(operation);
    return receipt;
  }
  private settle(operation: DeviceOperation, error?: Error): void {
    const pending = this.pending.get(operation.operationId); if (!pending) return;
    clearTimeout(pending.timer); clearTimeout(pending.settlement); pending.signal.removeEventListener('abort', pending.abort); this.pending.delete(operation.operationId);
    if (error) pending.reject(error); else pending.resolve(operation.receipt);
  }
  beginShutdown(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    const work: Promise<unknown>[] = [...this.pending.values()].map(pending => pending.promise);
    work.push(this.projects.drain());
    for (const id of this.pending.keys()) this.cancelOperation(id, '服务正在关闭，等待设备实际停止。');
    this.shutdown = Promise.allSettled(work).then(results => {
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, '部分设备操作结果未知，不能确认全部停止。');
    }).finally(() => { for (const connection of this.connections.values()) connection.close?.(); }); return this.shutdown;
  }
  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.closeOperation = (async () => { try { await this.beginShutdown(); } finally { this.connections.clear(); this.db.close(); this.closed = true; } })(); return this.closeOperation;
  }
}
