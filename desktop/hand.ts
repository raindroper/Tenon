import path from 'node:path';
import { deviceDirectoryEntriesCapability, deviceDirectoryLookupCapability, taskCommandCapability, type DeviceExecuteMessage, type DeviceGrant, type DeviceOperationReceipt, type DeviceServerMessage } from '../shared/local-device.js';
import { listDirectory, prepareDirectoryLookup } from './directory.js';
import { OperationJournal, type JournalEntry } from './journal.js';
import { NativeDrainError, sandboxRequest, requireStrictProbe, runSandbox, type MxcAdapter } from './mxc.js';
import { captureGrant, prepareTaskGrant, specHash, taskScratchParent, validateExecution, type LocalGrant } from './security.js';

export class LocalHand {
  private queue: Promise<void> = Promise.resolve();
  private pending = new Map<string, AbortController>();
  private readonly undelivered = new Map<string, JournalEntry>();
  private readonly delivering = new Map<string, Promise<void>>();
  private receiptFlush?: Promise<void>;
  private stopped = false;
  private unconfirmedNative = false;
  private grants: LocalGrant[];
  constructor(private readonly deviceId: string, grants: LocalGrant[], private readonly journal: OperationJournal,
    private readonly adapter: MxcAdapter | undefined, private readonly privateDirectory: string,
    private readonly receipt: (value: DeviceOperationReceipt) => Promise<void>, private readonly changed: (text: string) => void = () => {},
    private readonly admit: (message: DeviceExecuteMessage, signal: AbortSignal) => Promise<void> = async () => { throw new Error('服务器未提供执行前授权核验。'); },
    private readonly downloadsDirectory?: string) { this.grants = grants; }
  async advertisedGrants(): Promise<DeviceGrant[]> {
    return this.grants.map(grant => {
      try {
        if (this.unconfirmedNative) throw new Error('存在结果未确认的原操作，本地执行已封存，需先核对。');
        if (!this.adapter) throw new Error('本地命令隔离组件不可用。');
        requireStrictProbe(this.adapter, sandboxRequest({ deviceId: this.deviceId, grantId: grant.id, grantRevision: grant.revision,
          executable: grant.executable, args: [], cwd: grant.root, timeoutMs: 1000 }, grant, this.privateDirectory));
        return { id: grant.id, revision: grant.revision, root: grant.root, executable: grant.executable, readOnly: grant.readOnly, available: true };
      } catch (error) { return { id: grant.id, revision: grant.revision, root: grant.root, executable: grant.executable, readOnly: grant.readOnly, available: false, reason: String((error as Error).message) }; }
    });
  }
  async advertisedCapabilities(grants: DeviceGrant[]): Promise<string[]> {
    if (this.stopped) return [];
    const capabilities: string[] = [deviceDirectoryLookupCapability, deviceDirectoryEntriesCapability];
    if (!this.adapter) return capabilities;
    if (grants.some(grant => grant.available)) capabilities.push('local_command_mxc');
    try {
      const scratch = await taskScratchParent(this.privateDirectory);
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!systemRoot) return capabilities;
      const executable = path.win32.join(systemRoot, 'System32', 'cmd.exe');
      const grant = await captureGrant({ id: 'capability-probe', revision: 1, root: scratch.realPath, executable, readOnly: false });
      requireStrictProbe(this.adapter, sandboxRequest({ deviceId: this.deviceId, grantId: grant.id, grantRevision: grant.revision,
        executable: grant.executable, args: [], cwd: grant.root, timeoutMs: 1000 }, { ...grant, executableOnly: true }, this.privateDirectory));
      if (!this.stopped) capabilities.push(taskCommandCapability);
    } catch { /* The server sees only capabilities whose local prerequisites passed. */ }
    return this.stopped ? [] : capabilities;
  }
  async recover(): Promise<void> {
    for (const entry of await this.journal.recover()) {
      if (entry.receipt.state === 'unknown') { this.unconfirmedNative = true; this.stopped = true; this.changed('存在结果未确认的原操作，本地执行已封存，需先核对。'); }
      if (!entry.delivered) this.rememberReceipt(entry);
    }
    await this.flushReceipts();
  }
  async flushReceipts({ whileRunning = false }: { whileRunning?: boolean } = {}): Promise<void> {
    if (!whileRunning) await this.queue;
    if (this.receiptFlush) return this.receiptFlush;
    // Retry only durable terminal results. Active calls can keep running.
    const operation = (async () => {
      for (const entry of [...this.undelivered.values()]) if (!entry.delivered) await this.deliver(entry);
    })().finally(() => { this.receiptFlush = undefined; });
    this.receiptFlush = operation;
    return operation;
  }
  accept(message: DeviceServerMessage): void {
    if (message.kind === 'cancel') { this.pending.get(message.operationId)?.abort(message.reason); return; }
    if (message.kind !== 'execute') return;
    if (this.stopped) return;
    if (this.pending.has(message.operationId)) return;
    if (this.pending.size >= 32) { this.changed('设备待执行队列已满，暂不接受新操作。'); return; }
    const controller = new AbortController();
    this.pending.set(message.operationId, controller);
    this.queue = this.queue.then(() => this.execute(message, controller)).catch(error => this.changed(`操作记录失败：${(error as Error).message}`))
      .finally(() => { this.pending.delete(message.operationId); });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelAll('本地执行已暂停。');
    await this.queue;
    await this.receiptFlush;
    await Promise.allSettled(this.delivering.values());
    if (this.unconfirmedNative) throw new Error('原生执行停止未确认，不能确认暂停或退出完成；请在系统中检查原操作。');
  }
  cancelAll(reason: string): void { for (const controller of this.pending.values()) controller.abort(reason); }
  private rememberReceipt(entry: JournalEntry): void {
    if (entry.message.spec && entry.message.spec.deviceId !== this.deviceId) return;
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(entry.receipt.state)) this.undelivered.set(entry.message.operationId, entry);
  }
  private deliver(entry: JournalEntry): Promise<void> {
    const id = entry.message.operationId;
    const pending = this.delivering.get(id);
    if (pending) return pending;
    const operation = (async () => {
      try { await this.receipt(entry.receipt); }
      catch { return; }
      await this.journal.save({ ...entry, delivered: true });
      entry.delivered = true; this.undelivered.delete(id);
    })().finally(() => { this.delivering.delete(id); });
    this.delivering.set(id, operation);
    return operation;
  }
  private async save(entry: JournalEntry): Promise<void> {
    entry.delivered = false;
    await this.journal.save(entry);
    this.rememberReceipt(entry);
    await this.deliver(entry);
  }
  private async admitRunning(entry: JournalEntry, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.admit(entry.message, signal);
    signal.throwIfAborted();
    entry.receipt = { operationId: entry.message.operationId, state: 'running', startedAt: new Date().toISOString() };
    await this.save(entry);
    signal.throwIfAborted();
  }
  private async execute(message: DeviceExecuteMessage, controller: AbortController): Promise<void> {
    const old = await this.journal.get(message.operationId);
    if (old) {
      if (old.message.specHash !== message.specHash || specHash(message.spec) !== message.specHash) { this.changed('拒绝同一操作编号下的不同命令。'); return; }
      await this.deliver(old); return;
    }
    const entry: JournalEntry = { message, receipt: { operationId: message.operationId, state: 'dispatched' } };
    await this.journal.save(entry);
    let nativeAttempted = false;
    let nativeDrained = false;
    let cleanup: (() => Promise<void>) | undefined;
    const signal = controller.signal;
    const deadline = setTimeout(() => controller.abort('任务执行期限已到。'), Math.max(1, Math.min(message.spec.timeoutMs, message.deadline - Date.now())));
    try {
      try {
        signal.throwIfAborted();
        if (this.stopped) throw new Error('本地执行已暂停。');
        if ('kind' in message.spec) {
          const scope = await prepareDirectoryLookup(message, this.deviceId, this.privateDirectory, this.downloadsDirectory);
          await this.admitRunning(entry, signal);
          const checked = await prepareDirectoryLookup(message, this.deviceId, this.privateDirectory, this.downloadsDirectory, scope);
          this.changed('正在读取获准的目录清单…');
          const result = await listDirectory(checked, signal);
          entry.receipt = { ...entry.receipt, state: 'completed', exitCode: 0, stdout: JSON.stringify(result), finishedAt: new Date().toISOString() };
        } else {
          if (!this.adapter) throw new Error('本地命令隔离组件不可用。');
          let grant: LocalGrant | undefined;
          if ('access' in message.spec) {
            const prepared = await prepareTaskGrant(message, this.deviceId, this.privateDirectory);
            grant = prepared.grant;
            cleanup = prepared.cleanup;
          } else {
            const grantId = message.spec.grantId;
            grant = this.grants.find(value => value.id === grantId);
          }
          if (!grant) throw new Error('本地未授权此工作区和程序。');
          const spec = await validateExecution(message, this.deviceId, grant);
          const request = sandboxRequest(spec, grant, this.privateDirectory);
          const result = await runSandbox(this.adapter, request, signal, async () => {
            await validateExecution(message, this.deviceId, grant);
            await this.admitRunning(entry, signal);
            const checked = await validateExecution(message, this.deviceId, grant);
            request.timeoutMs = checked.timeoutMs;
            if (signal.aborted || this.stopped) return;
            this.changed('正在隔离执行获准任务…');
            nativeAttempted = true;
          });
          nativeDrained = true;
          entry.receipt = { ...entry.receipt, state: result.cancelled ? 'cancelled' : result.exitCode === 0 && !result.timedOut && !result.outputLimited ? 'completed' : 'failed',
            exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
            error: result.outputLimited ? '命令输出超过 128KiB，已停止并截断。' : result.timedOut ? '隔离命令超时。' : undefined,
            finishedAt: new Date().toISOString() };
        }
      } catch (error) {
        const unknown = nativeAttempted || error instanceof NativeDrainError;
        if (unknown) { this.unconfirmedNative = true; this.stopped = true; }
        entry.receipt = { ...entry.receipt, state: unknown ? 'unknown' : signal.aborted ? 'cancelled' : 'failed',
          error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
      }
      await this.save(entry);
    } finally {
      clearTimeout(deadline);
      if (cleanup && (!nativeAttempted || nativeDrained)) {
        try { await cleanup(); }
        catch (error) { this.changed(`临时工作区未清理：${(error as Error).message}`); }
      }
    }
    this.changed(entry.receipt.state === 'unknown' ? '操作结果未确认，已保留记录且不会重做。' : '本地执行已结束。');
  }
}
