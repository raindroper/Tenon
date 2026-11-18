import { isDeepStrictEqual } from 'node:util';
import type { DeviceServerMessage } from '../shared/local-device.js';
import { legacyLocalProjectCapability, localProjectCapability, previousLocalProjectCapability, projectContextWindowCapability,
  windowsDesktopCapability, type ProjectEvent, type ProjectServerMessage } from '../shared/local-project.js';
import { ProjectJournal, type LocalProjectEntry } from './project-journal.js';
import { ProjectRunner } from './project-runner.js';
import { verifyProjectResources, type ProjectResources } from './project-configuration.js';
import { ProjectWorkspaces } from './project-workspaces.js';
import { deviceFetch } from './transport.js';
import { desktopAutomationResources, verifyDesktopAutomationResources } from './desktop-automation.js';
import path from 'node:path';
import { pruneProjectArchives } from './project-archive.js';
import { sendProjectFiles } from './project-files.js';
import { projectFilesCapability, projectFinalFilesCapability, type ProjectFilesUpload } from '../shared/project-files.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';

interface Options {
  deviceId: string; baseUrl: string; credential: string; resources: ProjectResources; journal: ProjectJournal;
  post(events: ProjectEvent[]): Promise<{ sequence: number }>;
  status(message: string): void;
  request?: typeof deviceFetch;
}
export class ProjectHand {
  private readonly runners = new Map<string, ProjectRunner>();
  private readonly entries = new Map<string, LocalProjectEntry>();
  private readonly controls = new Map<string, Promise<void>>();
  private readonly workspaces: ProjectWorkspaces;
  private flushing?: Promise<void>;
  private pausing?: Promise<void>;
  private flushRequested = false;
  private stopped = false;
  constructor(private readonly options: Options) {
    this.workspaces = new ProjectWorkspaces(options.resources.platform === 'linux');
  }

  async capabilities(): Promise<string[]> {
    // The same executor accepts the previous wire versions during a server rollback.
    try {
      await verifyProjectResources(this.options.resources);
      if (this.options.resources.platform === 'linux') {
        await this.options.resources.sandbox.verify();
        return [localProjectCapability, projectContextWindowCapability, projectFilesCapability, projectContractCapability, projectContractV2Capability];
      }
      const desktopReady = await verifyDesktopAutomationResources(desktopAutomationResources(path.dirname(path.dirname(this.options.resources.node))))
        .then(() => true, () => false);
      return [localProjectCapability, previousLocalProjectCapability, legacyLocalProjectCapability, projectContextWindowCapability,
        projectFilesCapability, projectFinalFilesCapability,
        projectContractCapability,
        projectContractV2Capability,
        ...(desktopReady ? [windowsDesktopCapability] : [])];
    }
    catch { return []; }
  }

  async recover(): Promise<void> {
    for (const entry of await this.options.journal.list()) {
      this.entries.set(entry.input.operationId, entry); await this.options.journal.pending(entry);
      const durablePause = entry.state === 'paused' && entry.environment === 'closed' && entry.workspaceArchive
        && entry.input.spec.serverResources?.workspaceStorage === 'persistent';
      if (!durablePause && (entry.state === 'running' || entry.environment === 'active'
        || this.options.resources.platform === 'linux' && (['queued', 'paused'].includes(entry.state)
          || entry.state === 'unknown' && entry.environment !== 'closed'))) {
        const sandbox = this.options.resources.platform === 'linux' ? this.options.resources.sandbox : undefined;
        const discarded = sandbox ? await sandbox.discarded(sandbox.directory(entry.input.operationId)) : false;
        const unchanged = entry.state === 'unknown' && entry.environment === (discarded ? 'closed' : 'unknown');
        entry.state = 'unknown'; entry.environment = discarded ? 'closed' : 'unknown';
        if (!unchanged) {
          entry.error = discarded ? '执行设备重启，原隔离环境已销毁。上次执行结果未知，没有重新执行。'
            : '客户端意外退出，原生进程状态待核对；已保存修改保留，没有自动重新执行。';
          await this.options.journal.append(entry, { kind: 'environment', state: entry.environment, terminals: [] });
          await this.options.journal.append(entry, { kind: 'finished', state: 'unknown', output: entry.output, error: entry.error });
        }
      }
      if (entry.environment === 'unknown' && entry.realPath) this.workspaces.restore(entry.input.operationId,
        { root: entry.realPath, writable: entry.input.spec.access === 'read-write' });
    }
  }

  private retireRunner(runner: ProjectRunner): void {
    const id = runner.entry.input.operationId;
    if (!runner.needsTracking && this.runners.get(id) === runner) this.runners.delete(id);
    void this.flush();
    void runner.reconciliation?.then(() => {
      if (!runner.needsTracking && this.runners.get(id) === runner) this.runners.delete(id);
      void this.flush();
    });
  }

  accept(message: DeviceServerMessage): void {
    if (!message.kind.startsWith('project-')) return;
    const project = message as ProjectServerMessage;
    // Unacknowledged execution is redispatched on reconnect. Never admit new work during a drain.
    if (project.kind === 'project-execute' && (this.stopped || this.pausing)) return;
    const previous = this.controls.get(project.operationId) ?? Promise.resolve();
    const action = previous.then(() => this.control(project)).catch(error => this.options.status(error instanceof Error ? error.message : '项目控制失败。'));
    this.controls.set(project.operationId, action);
    void action.finally(() => { if (this.controls.get(project.operationId) === action) this.controls.delete(project.operationId); });
  }

  private async control(message: ProjectServerMessage): Promise<void> {
    const runner = this.runners.get(message.operationId);
    if (message.kind === 'project-files') {
      if (this.stopped || this.pausing) return;
      const post = async (input: ProjectFilesUpload) => {
        const response = await (this.options.request ?? deviceFetch)(this.options.baseUrl, '/api/device/projectfiles', this.options.credential,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
        return response.json() as Promise<{ deliveryId?: string; ready?: boolean }>;
      };
      try {
        const entry = this.entries.get(message.operationId);
        if (!entry || this.options.resources.platform !== 'linux' && !message.selection && !message.finalSelection) throw new Error('没有可领取的成果快照或服务器归档。');
        await sendProjectFiles(entry, this.options.journal.directory(message.operationId), message, post, () => {
          if (this.stopped || this.pausing) throw new Error('客户端正在暂停，已停止成果传输。');
        });
      } catch (error) {
        await post({ action: 'error', requestId: message.requestId, error: (error instanceof Error ? error.message : '文件领取失败。').slice(0, 2000) }).catch(() => {});
      }
      return;
    }
    if (message.kind === 'project-steer') { await runner?.revise(message); return; }
    if (message.kind === 'project-cancel') {
      if (runner) {
        try { await runner.stop(message.reason, message.mode); }
        finally { this.retireRunner(runner); }
      }
      else {
        const entry = this.entries.get(message.operationId);
        if (entry?.state === 'queued' || entry?.state === 'paused' || (entry?.input.retainWorkspace || entry?.workspaceArchive) && entry.environment === 'closed') {
          if (this.options.resources.platform === 'linux') {
            const sandbox = this.options.resources.sandbox;
            if (message.mode !== 'pause') await sandbox.clean(sandbox.directory(message.operationId));
            if (message.mode !== 'pause' && entry.input.spec.serverResources?.workspaceStorage === 'persistent') {
              await pruneProjectArchives(this.options.journal.directory(message.operationId)); delete entry.workspaceArchive;
            }
            entry.environment = 'closed';
            await this.options.journal.append(entry, { kind: 'environment', state: 'closed', terminals: [],
              ...(message.mode === 'pause' ? { retainedWorkspace: true } : {}) });
          }
          if (['completed', 'failed', 'unknown'].includes(entry.state)) { await this.flush(); return; }
          entry.state = message.mode === 'pause' ? 'paused' : 'cancelled';
          await this.options.journal.append(entry, message.mode === 'pause' ? { kind: 'paused', reason: message.reason }
            : { kind: 'finished', state: 'cancelled', output: entry.output });
        }
      }
      await this.flush(); return;
    }
    if (this.stopped) return;
    const input = message.input;
    if (input.operationId !== message.operationId || input.spec.deviceId !== this.options.deviceId) throw new Error('项目任务设备不匹配。');
    if ((this.options.resources.platform === 'linux') !== Boolean(input.spec.serverResources)) throw new Error('项目授权与执行设备的平台不匹配。');
    let entry = this.entries.get(input.operationId);
    if (entry && (entry.input.taskId !== input.taskId || entry.input.approvalRevision !== input.approvalRevision
      || entry.input.specHash !== input.specHash || !isDeepStrictEqual(entry.input.spec, input.spec))) throw new Error('原项目许可已改变，未重新执行。');
    if (runner && (runner.entry.state === 'queued' || runner.entry.state === 'running')) { await runner.revise(input); return; }
    if (entry && !['queued', 'paused'].includes(entry.state)) {
      if (this.options.resources.platform === 'linux' && !entry.input.retainWorkspace) { await this.flush(); return; }
      if (input.requirementsRevision <= entry.input.requirementsRevision || !['completed', 'failed'].includes(entry.state)) { await this.flush(); return; }
      await runner?.stop('正在接续新的本人要求。', 'pause');
    }
    entry ??= { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
    entry.input = input; entry.state = 'queued'; delete entry.error;
    this.entries.set(input.operationId, entry);
    await this.options.journal.save(entry);
    const next = new ProjectRunner({ ...this.options, entry, workspaces: this.workspaces, changed: () => { void this.flush(); } });
    this.runners.set(input.operationId, next);
    void next.run().catch(error => this.options.status(String(error))).finally(() => this.retireRunner(next));
  }

  flush(): Promise<void> {
    this.flushRequested = true;
    if (this.flushing) return this.flushing;
    return this.flushing = (async () => {
      do {
        this.flushRequested = false;
        for (const entry of this.entries.values()) {
          const events = await this.options.journal.pending(entry);
          for (let offset = 0; offset < events.length;) {
            const batch: ProjectEvent[] = []; let bytes = 0;
            while (offset < events.length && batch.length < 50) {
              const size = Buffer.byteLength(JSON.stringify(events[offset]));
              if (batch.length && bytes + size > 1024 * 1024) break;
              bytes += size; batch.push(events[offset++]);
            }
            const receipt = await this.options.post(batch);
            await this.options.journal.acknowledge(entry, Math.min(receipt.sequence, batch.at(-1)!.sequence));
          }
        }
      } while (this.flushRequested);
    })().catch(error => { this.options.status('项目进度保存在本机，等待同步：' + (error instanceof Error ? error.message : '连接中断')); })
      .finally(() => { this.flushing = undefined; });
  }

  pause(reason: string): Promise<void> {
    if (this.pausing) return this.pausing;
    return this.pausing = (async () => {
      // An accepted control may still be persisting its entry before registering a runner.
      await Promise.allSettled(this.controls.values());
      const results = await Promise.allSettled([...this.runners.values()].map(runner =>
        runner.stop(reason, 'pause').finally(() => this.retireRunner(runner))));
      await this.flush();
      // A late cancellation can strengthen pause to cancel while native work is draining.
      while (this.controls.size) await Promise.allSettled(this.controls.values());
      const failed = results.find(value => value.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    })().finally(() => { this.pausing = undefined; });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.controls.values());
    await this.pause('客户端已暂停，原任务和工作区状态已保存。');
  }
}
