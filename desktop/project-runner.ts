import path from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { CodexDrainTimeoutError, CodexRpc, type CodexMessage } from './codex-rpc.js';
import { ProjectBridge } from './project-bridge.js';
import { captureProject, configureProject, inspectProjectShells, projectApprovalPolicy, trustProjectGuard, verifyProjectResources, type ProjectResources } from './project-configuration.js';
import { CODEX_RUNTIME } from '../shared/codex-runtime.js';
import { MAX_PROJECT_SCREENSHOT_BYTES } from '../shared/chat-images.js';
import { projectOwnerQuestionSchema, type ProjectEvent, type ProjectExecutionInput, type ProjectOperation, type ProjectToolItem } from '../shared/local-project.js';
import type { LocalProjectEntry, ProjectJournal } from './project-journal.js';
import type { deviceFetch } from './transport.js';
import type { ProjectWorkspaces } from './project-workspaces.js';
import { ProjectBrowser, projectPreviewTools, projectPreviewUrl } from './project-browser.js';
import { DesktopAutomation, desktopAutomationResources, desktopAutomationTool } from './desktop-automation.js';
import { projectExecutionCheckpoint } from './project-checkpoint.js';
import { archiveProject, restoreProjectArchive, pruneProjectArchives } from './project-archive.js';
import { captureProjectFinalFiles } from './project-files.js';
import { receiveProjectInputs } from './project-inputs.js';
import { projectContractTools, legacyProjectContractTools, planHash, verifyProjectDelivery, completedDeliveryProblem,
  executeProjectDelivery, projectFileEvidence } from './project-delivery.js';
import { projectPlanSchema, projectVerificationInputSchema, projectPlanProblem, projectDeliveryRequestSchema,
  projectDeliveryProblem, type ProjectDelivery, type ProjectCheckCommand } from '../shared/project-contract.js';
import { projectStageDecision, type TaskDependency } from '../shared/task-flow.js';

interface Options {
  baseUrl: string; credential: string; resources: ProjectResources; journal: ProjectJournal; entry: LocalProjectEntry;
  changed(): void;
  request?: typeof deviceFetch;
  workspaces: ProjectWorkspaces;
}
type Terminal = NonNullable<ProjectOperation['environment']>['terminals'][number];
type Turn = { id: string; status: string; error?: { message?: string }; items?: Array<Record<string, unknown>> };
type Outcome = 'completed' | 'failed' | 'cancelled';
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textOf = (value: unknown) => typeof value === 'string' ? value : '';
const previewTools = new Set(projectPreviewTools);

export function projectPrompt(input: ProjectExecutionInput, resumed: boolean, realPath = input.spec.root): string {
  return [
    resumed ? '接续原任务。先核对上次保存的状态，已有修改和真实结果保留，不要盲目重复未知操作。' : '执行本人的完整项目委托。',
    '项目：' + realPath, '任务：' + input.title, '目标：' + input.objective,
    '交付要求：' + input.expectedOutput, '本人原话：\n' + input.ownerRequest,
    ...(input.contract?.version === 1 ? ['交付方案先核对本人原话、原始附件和相关历史结果，再读取适用 Skill。本人明确要求优先，受理层摘要中的猜测需要核对。用 record_project_plan 留下实际规则依据、工具环境、原件路径、预期产物和必需/非阻断检查。方案属于执行记录，不授予权限。',
      '范围内可复用已有工具或等价实现完成同一目标，说明替代原因及验证覆盖。缺少必要资料或无法达到必需条件时用 ask_rae_owner 在原任务等待。交付前调用 verify_project_delivery 引用真实操作编号。检查通过后及时完成，成果变化才重验受影响条件。',
      '本人已明确的验收条件：' + JSON.stringify(input.contract.criteria)] : []),
    ...(input.contract?.version === 2 ? [
      '直接根据原话、原件、适用 Skill 和实际环境完成任务，选择满足原目标的等价方法。程序已保存任务来源和许可，普通步骤无需重填受理或执行方案。',
      '交付用 submit_project_delivery 指定实际成果和要执行的检查。requirementIds引用下列条件编号，无需逐字抄句或查工具编号。命令、文件和结果由程序实际核验，不能用目录查询或打印PASS代替业务检查。未验证项说明覆盖与限制；必需项通过后才能完成。',
      '所选Skill明确逐阶段人工审核时，每次仅生成当前阶段，用stage提交实际产物，等待本人批准后再继续。最终交付省略stage。',
      input.contract.reviewMode === 'owner' ? '本任务已明确要求逐阶段本人审核，必须提交完整阶段序列并逐阶段等待批准。' : '阶段审核方式按本人要求及适用Skill执行。',
      '当前登记条件及本人补充引用：' + JSON.stringify(input.contract.requirements),
      ...(input.deliverFiles ? ['提交最终成果清单及实际检查后，运行时按该清单保存文件，并提供单文件和 ZIP 下载。'] : []),
    ] : []),
    ...input.updates.map(update => '补充要求 v' + update.revision + '：\n' + update.content),
    '权限：' + (input.spec.access === 'read-write' ? '本项目可读写' : '本项目只读') + '；' + (input.spec.network ? '允许联网' : '禁止外部联网') + '。范围内常规步骤连续完成。',
    input.spec.readAccess === 'device' ? '允许为本任务读取本机文件与依赖，写入仍限本项目及任务临时空间。' : '只读取所选项目及必要的系统执行文件。',
    input.spec.desktop ? '通过 operate_windows 操作本次获准的 Windows 应用。使用后台动作。按实际结果核对并报告通过、失败或阻塞；需要取证时调用截图工具。' :
    input.spec.serverResources ? '从这台 Linux 执行设备运行命令。报告实际输出与文件差异，结束前完成进程内的测试。'
      : '需要运行网页时保留开发服务，并用内置浏览器实际验证，把可访问的本机 URL 告诉本人。最终报告依据实际操作，不要仅以目录列表代替验收。',
  ].join('\n\n');
}

/** One upstream app-server owns this task's tools, subagents, terminals and browser. */
export class ProjectRunner {
  readonly entry: LocalProjectEntry;
  private readonly controller = new AbortController();
  private readonly workspaceWait = new AbortController();
  private releaseWorkspace?: () => void;
  private readonly bridge: ProjectBridge;
  private readonly browser?: ProjectBrowser;
  private desktop?: DesktopAutomation;
  private readonly evidenceRequests = new Set<Promise<void>>();
  private readonly evidenceFailures = new Set<string>();
  private readonly directory: string;
  private readonly temporaryRoot: string;
  private rpc?: CodexRpc;
  private configuration?: Awaited<ReturnType<typeof configureProject>>;
  private serial: Promise<void> = Promise.resolve();
  private turnWaiter?: { resolve(turn: Turn): void; reject(error: Error): void };
  private turn?: Turn;
  private turnText = '';
  private readonly textItems = new Set<string>();
  private readonly tools = new Map<string, ProjectToolItem>();
  private readonly toolRevisions = new Map<string, number>();
  private readonly turnRevisions = new Map<string, number>();
  private readonly commandChecks = new Set<string>();
  private deliveryInFlight = false;
  private uncertainCheck = false;
  private ownedWorkChanged?: () => void;
  private readonly activeAgents = new Set<string>();
  private readonly agentRevisions = new Map<string, number>();
  private stageReviews: TaskDependency[] = [];
  private desktopResult?: { revision: number; value: Record<string, unknown> };
  private readonly threads = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly previews = new Set<string>();
  private stopping?: { mode: 'pause' | 'cancel'; reason: string };
  private stopPromise?: Promise<void>;
  private runPromise?: Promise<void>;
  private lateDrain?: Promise<void>;
  private reconciling?: Promise<void>;
  private fatal?: Error;
  private retained = false;
  private preserveArchive = false;
  private draining = false;
  private steering: Promise<void> = Promise.resolve();
  private revisionAtTurn = 1;
  private pendingImages: unknown[] = [];
  private textBuffer = '';
  private textBufferRevision = 1;
  private textTimer?: ReturnType<typeof setTimeout>;
  private lastDiff = '';
  private unclosedDelivery?: string;

  constructor(private readonly options: Options) {
    this.entry = options.entry;
    this.directory = options.resources.platform === 'linux' ? options.resources.sandbox.directory(this.entry.input.operationId)
      : options.journal.directory(this.entry.input.operationId);
    this.temporaryRoot = path.join(this.directory, 'workspace');
    if (options.resources.platform !== 'linux' && !this.entry.input.spec.desktop) this.browser = new ProjectBrowser(() => this.rpc?.running ? this.rpc.pid : undefined);
    this.bridge = new ProjectBridge({ baseUrl: options.baseUrl, credential: options.credential, request: options.request,
      ...(this.entry.input.contract ? { modelTransport: ({ requirementsRevision, ...event }) => this.emit({ kind: 'model_transport', ...event }, requirementsRevision) } : {}),
      input: () => this.entry.input, signal: this.controller.signal, assertLocal: async () => {
        await this.steering;
        if (this.stopping || this.entry.appliedRevision !== this.entry.input.requirementsRevision) throw new Error('项目正在同步新要求或停止。');
        await captureProject(this.entry.input, { realPath: this.entry.realPath!, identity: this.entry.identity! }, this.temporaryRoot);
      } });
  }

  get needsTracking(): boolean { return this.retained || Boolean(this.reconciling) || this.entry.environment === 'unknown' && Boolean(this.rpc); }
  get reconciliation(): Promise<void> | undefined { return this.reconciling; }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const pending = this.serial.then(work);
    this.serial = pending.catch(error => this.fail(error));
    return pending;
  }
  private emit(event: ProjectEvent['event'], revision = this.entry.input.requirementsRevision): Promise<void> {
    return this.enqueue(async () => { await this.options.journal.append(this.entry, event, revision); this.options.changed(); });
  }
  private flushText(): void {
    clearTimeout(this.textTimer); this.textTimer = undefined;
    while (this.textBuffer) {
      const text = this.textBuffer.slice(0, 100000); this.textBuffer = this.textBuffer.slice(text.length);
      void this.emit({ kind: 'text', text }, this.textBufferRevision);
    }
  }
  private receiveText(text: string, revision = this.revisionAtTurn): void {
    if (this.textBufferRevision !== revision) this.flushText();
    this.textBufferRevision = revision;
    if (revision === this.entry.input.requirementsRevision && (this.entry.input.contract?.version !== 2 || revision === this.revisionAtTurn)) {
      this.turnText += text; this.entry.output += text;
    }
    this.textBuffer += text;
    this.textTimer ??= setTimeout(() => this.flushText(), 100);
  }
  private fail(error: unknown): void {
    this.fatal ??= error instanceof Error ? error : new Error('本地项目执行未完成。');
    this.bridge.fence();
    this.turnWaiter?.reject(this.fatal);
    this.ownedWorkChanged?.();
  }
  run(): Promise<void> { return this.runPromise ??= this.execute(); }

  private async execute(): Promise<void> {
    let state: Outcome = 'failed';
    let failure: string | undefined;
    let output = '';
    try {
      await verifyProjectResources(this.options.resources);
      await this.bridge.guard();
      const previousAppliedRevision = this.entry.appliedRevision;
      let restored: { hash: string; previousIdentity: string } | undefined;
      if (this.options.resources.platform === 'linux' && this.entry.workspaceArchive
        && this.entry.input.spec.serverResources?.workspaceStorage === 'persistent' && await this.options.resources.sandbox.discarded(this.directory)) {
        await this.options.resources.sandbox.verify();
        await restoreProjectArchive(this.directory, this.options.journal.directory(this.entry.input.operationId), this.entry);
        restored = { hash: this.entry.workspaceArchive.hash, previousIdentity: this.entry.workspaceArchive.identity };
      }
      const captured = await captureProject(this.entry.input, !restored && this.entry.realPath && this.entry.identity
        ? { realPath: this.entry.realPath, identity: this.entry.identity } : undefined, this.temporaryRoot);
      this.releaseWorkspace = await this.options.workspaces.acquire(this.entry.input.operationId,
        { root: captured.realPath, writable: this.entry.input.spec.access === 'read-write' }, this.workspaceWait.signal);
      this.workspaceWait.signal.throwIfAborted();
      await this.bridge.guard();
      await captureProject(this.entry.input, captured, this.temporaryRoot);
      Object.assign(this.entry, captured);
      if (restored) await this.emit({ kind: 'workspace_restored', ...restored, ...captured });
      if (this.entry.checkpoint && !this.entry.input.spec.desktop) {
        const fingerprint = await projectExecutionCheckpoint(captured.realPath, this.directory);
        if (fingerprint !== this.entry.checkpoint) {
          const context = asRecord(await this.bridge.context({ action: 'catalog' }));
          const resolved = asRecord(context.taskFlow).resolvedInputs;
          const authorized = this.entry.checkpointConflict?.fingerprint === fingerprint && Array.isArray(resolved)
            && resolved.some(value => asRecord(value).id === this.entry.checkpointConflict?.dependencyId
              && Array.isArray(asRecord(value).answers) && (asRecord(value).answers as unknown[]).some(answer => asRecord(answer).actor === 'owner'));
          if (!authorized) {
            const saved = asRecord(await this.bridge.context({ action: 'call', name: 'ask_rae_owner', arguments: { questions: [{
              id: 'workspace-' + fingerprint, header: '文件变化', question: '等待期间项目文件或 Git 状态发生了变化。请核对后说明是否基于现在的文件继续，以及需要保留的改动。',
            }] } }));
            const dependencyId = textOf(asRecord(saved.dependency).id);
            if (!dependencyId || saved.taskSuspended !== true) throw new Error('工作区冲突未能保存，未恢复执行。');
            this.entry.checkpointConflict = { fingerprint, dependencyId };
            this.stopping = { mode: 'pause', reason: '等待本人核对工作区变化。' };
            await this.options.journal.save(this.entry);
            throw new Error(this.stopping.reason);
          }
          this.entry.checkpoint = fingerprint; delete this.entry.checkpointConflict;
        }
      }
      this.entry.appliedRevision = this.entry.input.requirementsRevision;
      const desktop = this.entry.input.spec.desktop;
      if (desktop) {
        const { spec } = this.entry.input;
        if (this.options.resources.platform === 'linux' || spec.root !== 'task-temporary' || spec.network || spec.readAccess !== 'project' || spec.create) {
          throw new Error('Windows 应用工具与当前设备或任务许可不一致。');
        }
        this.desktop = new DesktopAutomation({ resources: desktopAutomationResources(path.dirname(path.dirname(this.options.resources.node))),
          directory: this.directory, workspace: captured.realPath, applications: desktop.applications, guard: async () => {
            const revision = this.entry.input.requirementsRevision;
            await this.bridge.guard();
            if (this.stopping || this.draining || this.fatal || revision !== this.entry.appliedRevision || revision !== this.entry.input.requirementsRevision) {
              throw new Error('Windows 应用任务已停止或要求已更新。');
            }
            await captureProject(this.entry.input, captured, this.temporaryRoot);
          } });
      }
      const address = await this.bridge.start();
      const browserProxy = this.entry.input.spec.network ? await this.browser?.start() : undefined;
      this.configuration = await configureProject(this.entry, this.directory,
        this.options.resources, address, this.bridge.token, browserProxy);
      this.workspaceWait.signal.throwIfAborted();
      this.entry.state = 'running';
      await this.options.journal.save(this.entry);
      this.workspaceWait.signal.throwIfAborted();
      const resources = this.options.resources;
      if (resources.platform === 'linux') await resources.sandbox.verify();
      const command = resources.platform === 'linux' ? resources.sandbox.command(this.directory, this.configuration.args)
        : { executable: resources.engine, args: this.configuration.args };
      this.rpc = new CodexRpc({ ...command,
        cwd: captured.realPath, env: this.configuration.environment, onNotification: message => this.notification(message),
        onRequest: message => this.request(message), onFailure: error => this.fail(error) });
      this.entry.processId = this.rpc.pid;
      await this.options.journal.save(this.entry);
      await this.rpc.request('initialize', { clientInfo: { name: 'another_rae', version: CODEX_RUNTIME.version },
        capabilities: { experimentalApi: true } });
      this.rpc.notify('initialized');
      await trustProjectGuard(this.rpc, captured.realPath, this.configuration.hookFile, this.configuration.hookCommand);
      const shells = this.options.resources.platform !== 'linux' && !this.entry.input.spec.desktop
        ? await inspectProjectShells(this.rpc, captured.realPath, this.configuration.permissions, () => this.bridge.guard()) : undefined;
      const resumed = Boolean(this.entry.threadId);
      const context = asRecord(await this.bridge.context({ action: 'catalog', sinceRevision: resumed ? previousAppliedRevision : 0 }));
      this.stageReviews = Array.isArray(asRecord(context.taskFlow).stageReviews) ? asRecord(context.taskFlow).stageReviews as TaskDependency[] : [];
      const inputFiles = await receiveProjectInputs(this.directory, context.inputFiles, value => this.bridge.context(value), () => this.bridge.guard());
      if (Array.isArray(context.verificationTools)) for (const tool of context.verificationTools) {
        const item = tool as ProjectToolItem; this.tools.set(item.id, item);
      }
      const result = await this.rpc.request<{ thread: { id: string }; activePermissionProfile?: { id: string }; approvalPolicy: unknown }>(
        resumed ? 'thread/resume' : 'thread/start', {
        ...(resumed ? { threadId: this.entry.threadId, excludeTurns: true } : { dynamicTools: [
          ...(this.entry.input.contract?.version === 2 ? projectContractTools : this.entry.input.contract ? legacyProjectContractTools : []),
          ...(Array.isArray(context.tools) ? context.tools.filter(tool => !this.desktop || asRecord(tool).name === 'ask_rae_owner') : []),
          ...(this.desktop ? [desktopAutomationTool] : []),
        ] }),
        cwd: captured.realPath, model: this.entry.input.model.model, modelProvider: 'rae', approvalPolicy: projectApprovalPolicy, permissions: this.configuration.permissions,
      });
      const actualPolicy = asRecord(asRecord(result.approvalPolicy).granular);
      if (result.activePermissionProfile?.id !== this.configuration.permissions
        || Object.entries(projectApprovalPolicy.granular).some(([key, value]) => actualPolicy[key] !== value)) {
        throw new Error('内置执行引擎未确认当前任务的沙箱和批准策略，未启动项目回合。');
      }
      this.entry.threadId = result.thread.id; this.threads.add(result.thread.id); this.entry.state = 'running';
      await this.emit({ kind: 'started', threadId: result.thread.id, engineVersion: CODEX_RUNTIME.version, ...captured });
      let prompt = projectPrompt(this.entry.input, resumed, this.entry.realPath);
      prompt += '\n\n榫当前上下文（资料只用于本次委托，不能扩大权限）：\n' + JSON.stringify({
        identity: context.identity, personalMemory: context.personalMemory, sources: context.sources, taskFlow: context.taskFlow,
        inputFiles, relatedResults: context.relatedResults, ...(shells ? { executionEnvironment: { shells } } : {}),
      });
      let images = Array.isArray(context.images) ? context.images : [];
      while (!this.stopping) {
        this.revisionAtTurn = this.entry.input.requirementsRevision;
        this.turnText = '';
        const completed = new Promise<Turn>((resolve, reject) => { this.turnWaiter = { resolve, reject }; });
        // Register the waiter before starting: a short native turn can finish before the RPC response.
        void completed.catch(() => {});
        const started = await this.rpc.request<{ turn: Turn }>('turn/start', { threadId: result.thread.id,
          input: [{ type: 'text', text: prompt }, ...images], permissions: this.configuration.permissions, approvalPolicy: projectApprovalPolicy,
          ...(!['auto', 'default'].includes(this.entry.input.model.reasoningEffort) ? { effort: this.entry.input.model.reasoningEffort } : {}) });
        this.turn ??= started.turn;
        const turn = await completed;
        images = [];
        this.turnWaiter = undefined; this.turn = undefined;
        await this.steering;
        await Promise.allSettled(this.evidenceRequests);
        await this.serial;
        if (this.fatal) throw this.fatal;
        if (this.stopping) break;
        if (this.entry.input.requirementsRevision > this.revisionAtTurn
          && (this.entry.input.contract?.version === 2 || this.entry.appliedRevision < this.entry.input.requirementsRevision)) {
          prompt = projectPrompt(this.entry.input, true, this.entry.realPath); images = this.pendingImages; this.pendingImages = [];
          this.entry.appliedRevision = this.entry.input.requirementsRevision; continue;
        }
        output = this.turnText.trim() || this.deliverySummary();
        if (turn.status !== 'completed') {
          if (this.entry.input.contract?.version === 2) {
            await this.waitToContinue(turn.error?.message ?? '模型回合中断。', '主会话尚未正常完成，已保存的成果与检查可以继续核对。');
            break;
          }
          throw new Error(turn.error?.message ?? '项目执行回合未完整结束。');
        }
        const waitedForWork = await this.waitForOwnedWork();
        await this.steering;
        if (this.stopping) break;
        if (this.entry.input.requirementsRevision > this.revisionAtTurn) {
          prompt = projectPrompt(this.entry.input, true, this.entry.realPath); images = this.pendingImages; this.pendingImages = [];
          this.entry.appliedRevision = this.entry.input.requirementsRevision; continue;
        }
        if (waitedForWork) {
          prompt = '分工会话和已接受的操作现已结束。请读取它们的实际结果，核对完整委托与当前成果，完成汇总和交付。';
          continue;
        }
        if (this.entry.input.contract) {
          const problem = await this.deliveryProblem();
          if (problem) {
            if (this.unclosedDelivery === problem) {
              if (this.entry.input.contract.version === 2) { await this.waitToContinue('执行仍有未完成项。', problem); break; }
              throw new Error('执行已结束，必需交付条件仍未满足：' + problem);
            }
            this.unclosedDelivery = problem;
            prompt = '本次仍有未闭合的交付条件：' + problem + '\n保留已完成的工作，核对当前方案和产物。能够补齐时继续；需要本人信息或无法满足必需条件时用 ask_rae_owner 保存问题并等待。';
            continue;
          }
        }
        await this.captureFinalFiles();
        const terminals = this.canRetainPreview() ? await this.terminals() : [];
        if (terminals.length) {
          this.retained = true; this.entry.environment = 'active';
          await this.emit({ kind: 'environment', state: 'active', terminals });
        }
        state = 'completed'; break;
      }
      if (this.stopping) state = 'cancelled';
    } catch (error) {
      failure = error instanceof Error ? error.message : '本地项目执行未完成。';
      this.preserveArchive = Boolean(this.entry.workspaceArchive && !this.rpc && this.stopping?.mode !== 'cancel');
      if (this.entry.input.contract?.version === 2 && this.uncertainCheck && !this.stopping) {
        try { await this.waitToContinue(failure, '检查操作的结果尚待核对。保留现场，先核对原操作，避免重复执行。'); }
        catch (waitError) { failure += '\n' + (waitError instanceof Error ? waitError.message : '当前许可无法保存续做位置。'); }
      }
    }
    finally {
      if (this.stopping?.mode === 'cancel') state = 'cancelled';
      this.draining = true;
      this.bridge.fence();
      const errors: string[] = [];
      await this.desktop?.drain().catch(error => { errors.push(String(error)); });
      await Promise.allSettled(this.evidenceRequests);
      await this.browser?.close().catch(error => { errors.push(String(error)); });
      if (!this.retained || this.stopping || state !== 'completed' || errors.length) {
        try { await this.drainNative(); }
        catch (error) { errors.push(error instanceof Error ? error.message : '本机进程退出状态未知。'); }
      }
      await this.bridge.close().catch(error => { errors.push(String(error)); });
      this.flushText();
      await this.serial;
      if (this.stopping?.mode === 'cancel') state = 'cancelled';
      if (state === 'completed' && this.entry.input.contract && this.entry.realPath) {
        const problem = await this.deliveryProblem();
        if (problem) { state = 'failed'; failure = problem; }
        else if (!errors.length) {
          try { await this.captureFinalFiles(); }
          catch (error) { state = 'failed'; failure = error instanceof Error ? error.message : '最终成果快照未能完整保存。'; }
        }
      }
      if (this.retained && state !== 'completed') {
        try { await this.drainNative(); }
        catch (error) { errors.push(error instanceof Error ? error.message : '本机进程退出状态未知。'); }
      }
      if (errors.length) {
        await this.reportUnknown();
        await this.finish('unknown', output, [failure, ...errors].filter(Boolean).join('\n'));
        if (errors.length === 1 && this.lateDrain) this.reconcileDrain(() => this.stopping?.mode === 'pause'
          ? this.finishPause() : this.finish(state, output, failure), async () => {
            if (state === 'completed' && this.entry.input.contract && this.entry.realPath) {
              const problem = await this.deliveryProblem();
              if (problem) { state = 'failed'; failure = problem; }
              else {
                try { await this.captureFinalFiles(); }
                catch (error) { state = 'failed'; failure = error instanceof Error ? error.message : '最终成果快照未能完整保存。'; }
              }
            }
          }, () => state === 'completed' && this.entry.input.retainWorkspace === true);
      } else {
        if (!this.retained) {
          try {
            if ((this.stopping?.mode === 'pause' || state === 'completed' && this.entry.input.retainWorkspace) && this.entry.realPath && !this.entry.input.spec.desktop && !this.entry.checkpointConflict) {
              await this.captureCheckpoint();
            }
            await this.closeWorkspace(undefined, state === 'completed' && this.entry.input.retainWorkspace === true);
          }
          catch (error) {
            await this.reportUnknown();
            await this.finish('unknown', output, [failure, String(error)].filter(Boolean).join('\n'));
            return;
          }
        }
        if (this.stopping?.mode === 'pause') {
          await this.finishPause();
        } else await this.finish(this.preserveArchive ? 'unknown' : state, output, failure);
      }
    }
  }

  private async finish(state: Outcome | 'unknown', output: string, failure?: string): Promise<void> {
    if (state !== 'unknown' && this.stopping?.mode === 'cancel') state = 'cancelled';
    this.entry.state = state; this.entry.error = failure;
    const report = [output || this.turnText, ...this.evidenceFailures].filter(Boolean).join('\n\n');
    await this.emit({ kind: 'finished', state, output: report.slice(0, 1_000_000), ...(failure ? { error: failure.slice(0, 4000) } : {}) });
  }

  private async finishPause(): Promise<void> {
    this.entry.state = 'paused'; this.entry.error = this.stopping!.reason;
    await this.emit({ kind: 'paused', reason: this.stopping!.reason });
  }

  private async captureCheckpoint(): Promise<void> {
    this.entry.checkpoint = await projectExecutionCheckpoint(this.entry.realPath!, this.directory);
    await this.options.journal.save(this.entry);
    if (this.entry.input.contract?.version === 2 && this.options.resources.platform !== 'linux') {
      await this.emit({ kind: 'workspace_saved', hash: this.entry.checkpoint, identity: this.entry.identity! });
    }
  }

  private async captureFinalFiles(): Promise<void> {
    if (this.options.resources.platform === 'linux' || !this.entry.input.deliverFiles) return;
    const revision = this.entry.input.requirementsRevision;
    const guard = async () => {
      await this.bridge.guard();
      if (this.stopping || this.fatal || revision !== this.entry.input.requirementsRevision) throw new Error('任务许可或要求已变化，最终文件未发布。');
    };
    this.entry.finalFilesSnapshot = await captureProjectFinalFiles(this.entry, this.directory, guard);
    await this.options.journal.save(this.entry);
  }

  private async saveEvidence(file: string, name: string, revision: number): Promise<string> {
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_PROJECT_SCREENSHOT_BYTES) throw new Error('截图文件无效或超过 1 MiB。');
      const bytes = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(bytes);
      if (bytesRead !== info.size) throw new Error('截图文件不完整。');
      const attachment = await this.bridge.evidence(revision, name, bytes);
      if (typeof attachment?.id !== 'string') throw new Error('服务端未返回截图回执。');
      return attachment.id;
    } finally { await handle.close(); }
  }

  private browserEvidence(item: Record<string, unknown>, result: Record<string, unknown>): void {
    if (!this.entry.input.spec.returnScreenshots || item.server !== 'playwright' || item.tool !== 'browser_take_screenshot'
      || item.status !== 'completed' || result.isError || item.error || !this.browser) return;
    const revision = this.entry.appliedRevision;
    const args = asRecord(item.arguments);
    const pending = (async () => {
      try {
        const blocks = Array.isArray(result.content) ? result.content.map(asRecord) : [];
        const link = blocks.map(block => textOf(block.text)).join('\n').match(/^\s*- \[Screenshot of [^\r\n]+?\]\(([^\r\n()]+\.png)\)\s*$/m)?.[1];
        const proposed = typeof args.filename === 'string' ? args.filename : link;
        const name = path.basename(proposed ?? '');
        if (!/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,99}\.png$/iu.test(name)) throw new Error('缺少受控 PNG 截图文件名。');
        const root = path.join(await realpath(this.directory), 'browser-output');
        const file = path.join(root, name);
        if ((await realpath(file)).toLowerCase() !== file.toLowerCase()) throw new Error('截图文件不在原任务浏览器输出目录。');
        await this.saveEvidence(file, name, revision);
      } catch (error) {
        if (revision === this.entry.input.requirementsRevision) this.evidenceFailures.add('网页截图未能回传：' + (error instanceof Error ? error.message : '请查看本机截图。'));
      }
    })().finally(() => { this.evidenceRequests.delete(pending); this.ownedWorkChanged?.(); });
    this.evidenceRequests.add(pending);
  }

  private async callDesktop(args: unknown, revision: number): Promise<unknown> {
    try {
      if (!this.desktop) throw new Error('当前任务没有 Windows 应用操作许可。');
      const value = await this.desktop.call(args);
      const observed = asRecord(JSON.parse(value.text));
      if (observed.verified === true) this.desktopResult = { revision, value: observed };
      let text = value.text;
      if (value.screenshot && this.entry.input.spec.returnScreenshots) {
        try {
          const id = await this.saveEvidence(value.screenshot.file, value.screenshot.name, revision);
          text += '\n截图已保存并回传原对话。证据编号：' + id;
        } catch (error) {
          const issue = 'Windows 截图已在本机保存，未能回传：' + (error instanceof Error ? error.message : '连接中断。');
          if (revision === this.entry.input.requirementsRevision) this.evidenceFailures.add(issue);
          text += '\n' + issue;
        }
      } else if (value.screenshot) text += '\n截图已保存在本机任务记录中。';
      return { success: true, contentItems: [{ type: 'inputText', text }] };
    } catch (error) {
      return { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : 'Windows 应用操作失败。' }] };
    }
  }

  private notification(message: CodexMessage): void {
    if (message.method !== 'item/agentMessage/delta') this.flushText();
    const params = message.params ?? {};
    const threadId = textOf(params.threadId);
    if (threadId) this.threads.add(threadId);
    const item = asRecord(params.item);
    const itemId = textOf(item.id || params.itemId);
    if (message.method === 'turn/started' && threadId) {
      const turn = asRecord(params.turn);
      const turnId = textOf(turn.id);
      const rootTurnId = textOf(turn.rootTurnId);
      const rootRevisions = new Set([...this.turnRevisions].filter(([key]) => key.startsWith(this.entry.threadId + ':')).map(([, value]) => value));
      const inherited = rootTurnId ? this.turnRevisions.get(this.entry.threadId + ':' + rootTurnId) : this.agentRevisions.get(threadId);
      const revision = threadId === this.entry.threadId || this.entry.input.contract?.version !== 2 ? this.revisionAtTurn
        : inherited ?? this.turnRevisions.get(threadId + ':' + turnId) ?? (rootRevisions.size === 1 ? [...rootRevisions][0] : undefined);
      if (revision === undefined) { this.fail(new Error('分工会话的来源要求版本无法核对。')); return; }
      this.activeTurns.set(threadId, turnId); this.turnRevisions.set(threadId + ':' + turnId, revision);
    }
    const completedTurnId = textOf(asRecord(params.turn).id);
    if (message.method === 'turn/completed' && threadId && this.activeTurns.get(threadId) === completedTurnId) {
      this.activeTurns.delete(threadId); this.activeAgents.delete(threadId);
      this.ownedWorkChanged?.();
    }
    if (message.method === 'turn/started' && threadId === this.entry.threadId) {
      this.turn = asRecord(params.turn) as unknown as Turn;
      this.entry.turnId = this.turn.id;
      void this.emit({ kind: 'turn', turnId: this.turn.id });
    }
    if (message.method === 'turn/completed' && threadId === this.entry.threadId && this.turn?.id === completedTurnId) this.turnWaiter?.resolve(params.turn as Turn);
    const revision = this.notificationRevision(threadId, textOf(params.turnId), itemId);
    if (message.method === 'item/agentMessage/delta' && threadId === this.entry.threadId) {
      if (revision === undefined) return;
      const delta = textOf(params.delta); this.textItems.add(itemId);
      if (delta) this.receiveText(delta, revision);
    }
    if (message.method === 'turn/diff/updated' && this.lastDiff !== textOf(params.diff)) {
      if (revision === undefined) return;
      this.lastDiff = textOf(params.diff);
      const diff = this.lastDiff.length > 990000 ? this.lastDiff.slice(0, 990000) + '\n[此处差异显示已截断，完整差异保留在本机原生会话中。]' : this.lastDiff;
      void this.emit({ kind: 'diff', diff }, revision);
    }
    if (message.method === 'item/commandExecution/outputDelta') {
      const tool = this.tools.get(itemId);
      if (tool) { tool.output = (tool.output ?? '') + textOf(params.delta); tool.output = tool.output.slice(-500000); }
      this.findPreviews(textOf(params.delta));
    }
    if (message.method === 'item/completed' && item.type === 'agentMessage' && threadId === this.entry.threadId) {
      if (revision === undefined) return;
      const text = textOf(item.text);
      if (!this.textItems.has(itemId) && text) {
        this.receiveText(text, revision); this.flushText();
      }
      this.findPreviews(text);
    }
    if (['item/started', 'item/completed'].includes(message.method ?? '') && itemId
      && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity'].includes(textOf(item.type))) {
      if (revision === undefined) {
        this.fail(new Error('原生工具回执的要求版本无法核对，原生记录已保留，请先核对执行状态。')); return;
      }
      if (!this.toolRevisions.has(itemId)) this.toolRevisions.set(itemId, revision);
      const finished = message.method === 'item/completed';
      const tool: ProjectToolItem = { ...this.tools.get(itemId), id: itemId, type: textOf(item.type),
        label: textOf(item.command) || textOf(item.tool) || (item.type === 'fileChange' ? '修改项目文件' : '项目工具'),
        state: !finished ? 'running' : ['failed', 'declined'].includes(textOf(item.status)) || Number(item.exitCode ?? 0) !== 0 ? 'failed' : 'succeeded',
        ...(typeof item.command === 'string' ? { command: item.command } : {}),
        ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput.slice(-500000) } : {}),
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
        ...(threadId ? { threadId } : {}),
        ...(typeof item.processId === 'string' && item.processId ? { processId: item.processId } : {}),
        ...(finished ? { endedAt: new Date().toISOString() } : { startedAt: new Date().toISOString() }) };
      tool.label = tool.label.slice(0, 500);
      if (item.type === 'mcpToolCall' && finished) {
        const result = asRecord(item.result);
        this.browserEvidence(item, result);
        tool.output = Array.isArray(result.content) ? result.content.flatMap(value => {
          const content = asRecord(value); return content.type === 'text' ? [textOf(content.text)] : content.type === 'image' ? ['[已返回实际浏览器截图]'] : [];
        }).join('\n').slice(-500000) : JSON.stringify(item.error ?? result).slice(-500000);
        if (result.isError === true || item.error) tool.state = 'failed';
      }
      if (item.type === 'dynamicToolCall' && finished && item.tool === desktopAutomationTool.name) {
        tool.output = Array.isArray(item.contentItems) ? item.contentItems.map(value => textOf(asRecord(value).text)).join('\n').slice(0, 10000) : undefined;
        if (item.success !== true) tool.state = 'failed';
      }
      if (item.type === 'subAgentActivity') {
        const agentId = textOf(item.agentThreadId);
        if (agentId) {
          this.threads.add(agentId);
          if (item.kind === 'started') {
            this.activeAgents.add(agentId);
            if (!this.agentRevisions.has(agentId)) this.agentRevisions.set(agentId, revision);
          }
          if (item.kind === 'completed') this.activeAgents.delete(agentId);
        }
        tool.label = ('分工会话 ' + textOf(item.agentPath || item.agentThreadId) + ' · ' + textOf(item.kind)).slice(0, 500);
      }
      this.tools.set(itemId, tool); void this.emit({ kind: 'tool', item: { ...tool } }, this.toolRevisions.get(itemId));
      this.findPreviews(tool.output ?? '');
      this.ownedWorkChanged?.();
    }
    if (message.method === 'hook/completed' && asRecord(params.run).status === 'failed') {
      this.fail(new Error('任务许可核验未完成，已停止继续执行。'));
    }
  }

  private notificationRevision(threadId: string, turnId: string, itemId: string): number | undefined {
    if (itemId && this.toolRevisions.has(itemId)) return this.toolRevisions.get(itemId);
    if (this.entry.input.contract?.version !== 2) return this.entry.input.requirementsRevision;
    const resolvedTurn = turnId || this.activeTurns.get(threadId);
    const captured = resolvedTurn ? this.turnRevisions.get(threadId + ':' + resolvedTurn) : undefined;
    return captured;
  }

  private findPreviews(text: string): void {
    if (!this.browser) return;
    for (const match of stripVTControlCharacters(text).matchAll(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s"'<>)]\x60]*)?/g)) {
      if (this.previews.size >= 20) return;
      const url = match[0].replace(/[.,;]+$/, '');
      if (!projectPreviewUrl(url) || this.previews.has(url)) continue;
      this.previews.add(url);
      const owned = this.browser.owns(url);
      void this.enqueue(async () => {
        if (!await owned) return;
        await this.options.journal.append(this.entry, { kind: 'preview', url });
        this.options.changed();
      });
    }
  }

  private async request(message: CodexMessage): Promise<unknown> {
    const params = message.params ?? {};
    const controlsTask = message.method === 'item/tool/requestUserInput' || message.method === 'item/tool/call'
      && ['submit_project_delivery', 'record_project_plan', 'verify_project_delivery', 'ask_rae_owner', 'prepare_task_mail'].includes(textOf(params.tool));
    const scoped = message.method === 'item/tool/call' || message.method === 'item/tool/requestUserInput';
    let revision: number;
    try {
      if (this.stopping || this.draining || this.fatal) throw new Error('项目执行已停止接收操作。');
      revision = scoped ? this.nativeRequestRevision(params, controlsTask) : this.entry.input.requirementsRevision;
      await this.bridge.guard();
      if (revision !== this.entry.input.requirementsRevision || this.stopping || this.draining) throw new Error('本人要求已更新或任务已停止，原请求已关闭。');
      if (scoped && this.nativeRequestRevision(params, controlsTask) !== revision) throw new Error('请求已不属于当前有效会话回合。');
    } catch (error) {
      if (message.method === 'item/tool/call') return { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : '项目操作未获准执行。' }] };
      throw error;
    }
    // The native approval response can rerun a command outside its sandbox or
    // grant access for the whole turn. Neither belongs to this project scope.
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      return { decision: 'decline' };
    }
    if (message.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (message.method === 'item/tool/call' && params.tool === desktopAutomationTool.name) {
      const run = this.callDesktop(params.arguments, revision);
      const pending = run.then(() => undefined).finally(() => { this.evidenceRequests.delete(pending); this.ownedWorkChanged?.(); });
      this.evidenceRequests.add(pending);
      return run;
    }
    if (message.method === 'item/tool/call') {
      try {
        const contractTools = this.entry.input.contract?.version === 2 ? projectContractTools : legacyProjectContractTools;
        if (this.entry.input.contract && contractTools.some(tool => tool.name === params.tool)) {
          const work = this.contractCall(textOf(params.tool), params.arguments, revision);
          const pending = work.then(() => undefined, () => undefined).finally(() => { this.evidenceRequests.delete(pending); this.ownedWorkChanged?.(); });
          this.evidenceRequests.add(pending);
          const value = await work;
          return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
        }
        if (this.desktop && params.tool !== 'ask_rae_owner') throw new Error('Windows 应用任务只使用本次批准的设备操作工具。');
        const value = await this.bridge.context({ action: 'call', name: params.tool, arguments: asRecord(params.arguments) });
        if (asRecord(value).taskSuspended === true) {
          // The dependency is already durable on the server. End this native
          // turn, drain accepted tools, and retain the workspace for a later turn.
          setImmediate(() => { void this.stop('等待任务所需的信息或批准。', 'pause').catch(error => this.fail(error)); });
        }
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
      } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : '资料读取失败。' }] }; }
    }
    if (message.method === 'mcpServer/elicitation/request') {
      const metadata = asRecord(params._meta);
      const url = asRecord(metadata.tool_params).url;
      if (this.browser && params.serverName === 'playwright' && this.entry.input.spec.network && params.mode === 'form' && metadata.codex_approval_kind === 'mcp_tool_call'
        && previewTools.has(textOf(metadata.tool_name)) && (url === undefined || projectPreviewUrl(url)?.protocol === 'http:')) {
        return { action: 'accept', content: {} };
      }
      return { action: 'cancel', content: null };
    }
    if (message.method !== 'item/tool/requestUserInput') throw new Error('客户端尚不支持这项原生请求。');
    const question = projectOwnerQuestionSchema.parse({ questions: params.questions });
    const saved = await this.bridge.context({ action: 'call', name: 'ask_rae_owner', arguments: question });
    if (asRecord(saved).taskSuspended !== true) throw new Error('问题未能持久保存。');
    setImmediate(() => { void this.stop('等待本人回答已保存的问题。', 'pause').catch(error => this.fail(error)); });
    return { answers: {} };
  }

  private nativeRequestRevision(params: Record<string, unknown>, primaryOnly: boolean): number {
    const threadId = textOf(params.threadId);
    const turnId = textOf(params.turnId);
    if (!threadId || !turnId || this.activeTurns.get(threadId) !== turnId) throw new Error('原生操作不属于已登记的活动会话回合。');
    if (primaryOnly && (threadId !== this.entry.threadId || turnId !== this.turn?.id)) {
      throw new Error('任务交付、验收和本人问题须由当前主会话汇总处理；分工会话请将结果返回主会话。');
    }
    const revision = this.entry.input.contract?.version === 2 ? this.turnRevisions.get(threadId + ':' + turnId) : this.entry.appliedRevision;
    if (revision !== this.entry.input.requirementsRevision || this.entry.appliedRevision !== revision) throw new Error('原生操作的要求版本已失效。');
    return revision;
  }

  private async contractCall(name: string, raw: unknown, revision: number): Promise<unknown> {
    if (name === 'read_project_task_result') {
      const value = asRecord(raw);
      return this.bridge.context({ action: 'task_result', id: value.taskId, offset: value.offset ?? 0 });
    }
    if (name === 'submit_project_delivery') {
      if (this.deliveryInFlight) throw new Error('已有一项交付检查正在运行，请等待它结束后再提交。');
      this.deliveryInFlight = true;
      try {
      const contract = this.entry.input.contract;
      if (contract?.version !== 2) throw new Error('当前任务使用先前捕获的交付协议。');
      const request = projectDeliveryRequestSchema.parse(raw);
      const previous = this.entry.delivery;
      const guard = async () => {
        await this.bridge.guard();
        await captureProject(this.entry.input, { realPath: this.entry.realPath!, identity: this.entry.identity! }, this.temporaryRoot);
        if (revision !== this.entry.input.requirementsRevision || this.stopping || this.draining) throw new Error('要求已变化或执行已停止。');
      };
      await this.refreshStageReviews();
      const stageProblem = await this.approvedStagesProblem(request.stage?.index);
      if (stageProblem) throw new Error(stageProblem);
      const delivery = await executeProjectDelivery(request, {
        revision, requirements: contract.requirements, objective: this.entry.input.objective,
        workspace: this.entry.realPath!, directory: this.directory, previous, guard,
        command: (command, id) => this.executeCheck(command, id, revision),
        desktop: async check => {
          await guard();
          return this.desktopResult?.revision === revision && this.desktopResult.value.verified === true
            && Object.hasOwn(this.desktopResult.value, check.key) && this.desktopResult.value[check.key] === check.equals;
        },
        recordTool: async tool => {
          this.tools.set(tool.id, tool); this.toolRevisions.set(tool.id, revision);
          await this.emit({ kind: 'tool', item: tool }, revision);
        },
        save: async current => {
          this.entry.delivery = current;
          await this.emit({ kind: 'delivery', delivery: current as Required<Pick<ProjectDelivery, 'version' | 'request' | 'evidence' | 'missing'>> & ProjectDelivery }, revision);
          await this.options.journal.save(this.entry);
        },
      });
      if (request.stage) {
        const copy = { ...delivery, request: { ...request, stage: undefined } };
        const problem = projectDeliveryProblem(copy, revision);
        if (problem) return { delivery, problem };
        const result = asRecord(await this.bridge.context({ action: 'stage_review', arguments: {
          stageId: request.stage.id, index: request.stage.index, count: request.stage.count, title: request.stage.title,
          files: delivery.verification!.files,
        } }));
        if (result.taskSuspended === true) {
          setImmediate(() => { void this.stop('等待本人审核当前阶段。', 'pause').catch(error => this.fail(error)); });
        }
        return result;
      }
      const problem = await this.deliveryProblem();
      return { delivery, problem };
      } finally { this.deliveryInFlight = false; }
    }
    if (name === 'project_execution_evidence') return { delivery: this.entry.delivery,
      tools: [...this.tools.values()].filter(tool => !['dynamicToolCall', 'subAgentActivity'].includes(tool.type)).map(tool => ({
        id: tool.id, type: tool.type, state: tool.state, label: tool.label, output: tool.output?.slice(-4000), exitCode: tool.exitCode,
      })) };
    if (name === 'record_project_plan') {
      const plan = projectPlanSchema.parse(raw);
      const problem = projectPlanProblem(plan, this.entry.input.contract?.version === 1 ? this.entry.input.contract.criteria : [], this.entry.input.updates);
      if (problem) throw new Error(problem);
      for (const source of plan.basis) {
        if (source.kind === 'skill' && !source.toolIds?.length) throw new Error('Skill 依据须引用实际读取规则的操作编号。');
        for (const id of source.toolIds ?? []) if (this.tools.get(id)?.state !== 'succeeded') throw new Error('方案依据引用了未成功的操作。');
      }
      for (const environment of plan.environment) for (const id of environment.toolIds) {
        if (!this.tools.has(id) || this.tools.get(id)?.state === 'running') throw new Error('环境依据须引用已结束的实际操作。');
      }
      await this.bridge.guard();
      if (revision !== this.entry.input.requirementsRevision || this.stopping) throw new Error('要求已变化或执行已停止。');
      const hash = planHash(plan);
      await this.emit({ kind: 'plan', plan, planHash: hash }, revision);
      this.entry.delivery = { plan, planHash: hash, requirementsRevision: revision };
      await this.options.journal.save(this.entry);
      return { recorded: true, planHash: hash, requirementsRevision: revision };
    }
    const input = projectVerificationInputSchema.parse(raw);
    const delivery = this.entry.delivery;
    if (!delivery || delivery.requirementsRevision !== revision) throw new Error('先核对并记录当前执行方案。');
    const proof = await verifyProjectDelivery(delivery, input, this.tools, this.entry.realPath!, this.directory);
    await this.bridge.guard();
    await captureProject(this.entry.input, { realPath: this.entry.realPath!, identity: this.entry.identity! }, this.temporaryRoot);
    if (revision !== this.entry.input.requirementsRevision || delivery !== this.entry.delivery || this.stopping) throw new Error('检查期间要求或方案发生变化。');
    await this.emit({ kind: 'verification', verification: proof }, revision);
    delivery.verification = proof; await this.options.journal.save(this.entry);
    return { verification: proof, problem: await completedDeliveryProblem(delivery, revision, this.entry.realPath!, this.directory) };
  }

  revise(input: Pick<ProjectExecutionInput, 'requirementsRevision' | 'runId' | 'updates' | 'contract'>): Promise<void> {
    if (input.requirementsRevision <= this.entry.input.requirementsRevision) return this.steering;
    this.flushText();
    this.entry.input = { ...this.entry.input, ...input };
    this.ownedWorkChanged?.();
    if (this.entry.input.contract?.version === 2) this.entry.output = '';
    this.steering = this.steering.catch(() => {}).then(async () => {
      const target = structuredClone(this.entry.input);
      if (target.requirementsRevision <= this.entry.appliedRevision) return;
      const context = asRecord(await this.bridge.context({ action: 'catalog', sinceRevision: this.entry.appliedRevision }));
      this.stageReviews = Array.isArray(asRecord(context.taskFlow).stageReviews) ? asRecord(context.taskFlow).stageReviews as TaskDependency[] : [];
      const inputFiles = await receiveProjectInputs(this.directory, context.inputFiles, value => this.bridge.context(value), () => this.bridge.guard());
      this.pendingImages = Array.isArray(context.images) ? context.images : [];
      const turn = this.turn;
      if (this.rpc && !this.stopping && (turn || target.contract?.version === 2 && this.activeTurns.size > 0)) {
        try {
          if (target.contract?.version === 2) {
            for (const [threadId, turnId] of this.activeTurns) await this.rpc.request('turn/interrupt', { threadId, turnId });
            for (const threadId of this.threads) await this.rpc.request('thread/backgroundTerminals/clean', { threadId });
          } else await this.rpc.request('turn/steer', { threadId: this.entry.threadId, expectedTurnId: turn!.id,
            input: [{ type: 'text', text: projectPrompt(target, true, this.entry.realPath) + '\n当前原件：' + JSON.stringify(inputFiles) }, ...this.pendingImages] });
          this.entry.appliedRevision = target.requirementsRevision;
          if (target.contract?.version !== 2) this.pendingImages = [];
        } catch { /* A finished turn receives the same requirements in a fresh native turn. */ }
      }
      await this.enqueue(() => this.options.journal.save(this.entry));
    });
    return this.steering;
  }

  private async executeCheck(command: ProjectCheckCommand, id: string, revision: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (!this.rpc || !this.configuration || this.desktop) throw new Error('当前执行环境不支持原生命令检查。');
    const cwd = await realpath(command.cwd ? path.resolve(this.entry.realPath!, command.cwd) : this.entry.realPath!);
    const roots = await Promise.all([this.entry.realPath!, path.join(this.directory, 'temporary'), path.join(this.directory, 'outputs')].map(root => realpath(root)));
    if (!roots.some(root => { const relative = path.relative(root, cwd); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); })) {
      throw new Error('检查命令的工作目录必须位于本次授权工作区。');
    }
    await this.bridge.guard();
    if (revision !== this.entry.input.requirementsRevision || this.stopping) throw new Error('检查命令所依据的要求或许可已变化。');
    const timeoutMs = command.timeoutMs ?? 300000;
    this.commandChecks.add(id);
    try {
      return await this.rpc.request('command/exec', { command: command.argv, cwd, permissions: this.configuration.permissions,
        timeoutMs, processId: id }, Math.min(2147483647, timeoutMs + 30000));
    } catch (error) {
      await this.rpc.request('command/exec/terminate', { processId: id }).catch(() => {});
      this.uncertainCheck = true;
      this.fail(new Error('检查命令尚无可确认的结束回执，正在排空并保留现场。'));
      throw error;
    } finally { this.commandChecks.delete(id); this.ownedWorkChanged?.(); }
  }

  private deliverySummary(): string {
    const delivery = this.entry.delivery;
    if (!delivery?.verification) return '项目回合已结束，请核对实际操作和已有文件。';
    return ['已保存成果', ...delivery.verification.files.map(file => '- ' + file.path), '', '实际检查',
      ...delivery.verification.checks.map(check => '- ' + check.id + ' · ' + check.status + ' · ' + check.detail)].join('\n');
  }

  private async deliveryProblem(): Promise<string | undefined> {
    try {
      await captureProject(this.entry.input, { realPath: this.entry.realPath!, identity: this.entry.identity! }, this.temporaryRoot);
      if (!this.draining) await this.refreshStageReviews();
      const problem = await completedDeliveryProblem(this.entry.delivery, this.entry.input.requirementsRevision, this.entry.realPath!, this.directory,
        this.entry.input.contract?.version === 2 ? this.entry.input.contract.finalFiles : undefined);
      if (problem) return problem;
      if (this.entry.input.contract?.version === 2 && this.entry.input.contract.reviewMode === 'owner' && !this.stageReviews.length) {
        return '本任务要求逐阶段本人审核，尚无阶段审核记录。';
      }
      return this.approvedStagesProblem();
    } catch (error) { return error instanceof Error ? error.message : '成果读取失败。'; }
  }

  private async waitForOwnedWork(): Promise<boolean> {
    let waited = false;
    const revision = this.entry.input.requirementsRevision;
    try {
      while (!this.stopping && !this.fatal && this.entry.input.requirementsRevision === revision) {
        const changed = new Promise<void>(resolve => { this.ownedWorkChanged = resolve; });
        const terminals = this.canRetainPreview() ? await this.terminals() : [];
        const retained = new Set(terminals.map(terminal => terminal.threadId + ':' + terminal.processId));
        const pending = this.activeAgents.size > 0 || [...this.activeTurns.keys()].some(id => id !== this.entry.threadId)
          || this.commandChecks.size > 0 || this.evidenceRequests.size > 0
          || [...this.tools.values()].some(tool => tool.state === 'running'
            && !(tool.type === 'commandExecution' && tool.threadId && tool.processId && retained.has(tool.threadId + ':' + tool.processId)));
        if (!pending) return waited;
        waited = true;
        await changed;
      }
      if (this.fatal) throw this.fatal;
      return waited;
    } finally { this.ownedWorkChanged = undefined; }
  }

  private canRetainPreview(): boolean {
    return Boolean(this.browser && this.entry.input.spec.network && !this.entry.input.spec.serverResources);
  }

  private async refreshStageReviews(): Promise<void> {
    if (this.entry.input.contract?.version !== 2) return;
    const context = asRecord(await this.bridge.context({ action: 'stage_reviews' }));
    if (Array.isArray(context.stageReviews)) this.stageReviews = context.stageReviews as TaskDependency[];
  }

  private async approvedStagesProblem(beforeIndex?: number): Promise<string | undefined> {
    const stages = beforeIndex === undefined ? this.stageReviews : this.stageReviews.filter(value => value.stageReview!.index < beforeIndex);
    if (beforeIndex === undefined && stages.length && (stages.length !== stages[0].stageReview!.count
      || stages.some((value, index) => value.stageReview?.index !== index + 1))) return '阶段审核序列尚未完成。';
    for (const dependency of stages) {
      if (dependency.requirementsRevision !== this.entry.input.requirementsRevision) return '阶段审核属于先前的要求版本。';
      if (projectStageDecision(dependency) !== 'approved') return '阶段审核尚未通过：' + dependency.stageReview!.title;
      const stage = dependency.stageReview!;
      const plan = projectPlanSchema.parse({ objective: stage.title, basis: [{ kind: 'owner', reference: dependency.id, detail: stage.title }],
        method: '核对已批准的阶段产物', environment: [], outputs: stage.files.map(file => ({ path: file.path, format: file.format, description: stage.title })),
        checks: [{ id: 'snapshot', criterion: '阶段产物未改变', required: true, method: '内容指纹', basis: 'owner' }] });
      const current = await projectFileEvidence(plan, this.entry.realPath!, this.directory, stage.files.some(file => file.publishedPath !== undefined));
      if (JSON.stringify(current) !== JSON.stringify(stage.files)) return '已批准的阶段成果发生变化，请重新提交审核：' + stage.title;
    }
  }

  private async waitToContinue(reason: string, problem: string): Promise<void> {
    await this.bridge.guard();
    const result = asRecord(await this.bridge.context({ action: 'call', name: 'ask_rae_owner', arguments: { questions: [{
      id: 'resume-project-' + this.entry.input.requirementsRevision, header: '继续任务',
      question: [reason, problem, '已保存原任务的成果和检查。请补充缺少的信息，或选择继续核对现场并完成剩余工作。'].join('\n').slice(0, 5000),
      options: [{ label: '继续原任务', description: '核对已有现场，补齐剩余工作。' }, { label: '补充信息后继续', description: '填写仍缺少的信息，沿原任务继续。' }],
    }] } }));
    if (result.taskSuspended !== true) throw new Error('中断后的继续位置尚未持久保存。');
    this.stopping = { mode: 'pause', reason: [reason, problem].join('\n').slice(0, 4000) };
  }

  private async terminals(): Promise<Terminal[]> {
    if (!this.rpc?.running) return [];
    const loaded = await this.rpc.request<{ data: string[] }>('thread/loaded/list');
    for (const id of loaded.data) this.threads.add(id);
    const result: Terminal[] = [];
    for (const threadId of this.threads) {
      const list = await this.rpc.request<{ data: Array<{ processId: string; command: string; cwd: string }> }>('thread/backgroundTerminals/list', { threadId });
      result.push(...list.data.map(item => ({ threadId, processId: String(item.processId), command: item.command, cwd: item.cwd })));
    }
    return result;
  }

  private async drainNative(): Promise<void> {
    this.retained = false; this.bridge.fence();
    const rpc = this.rpc;
    if (!rpc) return;
    let cleaned = false;
    try {
      if (!rpc.running && rpc.pid !== undefined) {
        throw new Error('项目引擎意外退出，无法确认原生子进程状态；没有自动重放操作。');
      }
      if (rpc.pid !== undefined) {
        // Interrupt turns before cleaning every thread's terminal owner. EOF alone is not a stop receipt.
        const loaded = await rpc.request<{ data: string[] }>('thread/loaded/list');
        for (const id of loaded.data) this.threads.add(id);
        for (const [threadId, turnId] of this.activeTurns) await rpc.request('turn/interrupt', { threadId, turnId });
        for (const threadId of this.threads) await rpc.request('thread/backgroundTerminals/clean', { threadId });
      }
      cleaned = true;
    } finally {
      try { await rpc.close(); }
      catch (error) {
        if (cleaned && error instanceof CodexDrainTimeoutError) this.lateDrain = rpc.waitForDrain();
        throw error;
      }
    }
  }

  private reportUnknown(): Promise<void> {
    this.entry.environment = 'unknown';
    return this.emit({ kind: 'environment', state: 'unknown', terminals: [] });
  }

  private reconcileDrain(finish?: () => Promise<void>, beforeClose?: () => Promise<void>, retainWorkspace: () => boolean = () => false): void {
    const lateDrain = this.lateDrain;
    this.lateDrain = undefined;
    if (!lateDrain) return;
    this.reconciling = lateDrain.then(async () => {
      try {
        this.flushText();
        await this.serial;
        await beforeClose?.();
        const retain = retainWorkspace() && this.stopping?.mode !== 'cancel';
        if ((this.stopping?.mode === 'pause' || retain) && this.entry.realPath && !this.entry.input.spec.desktop && !this.entry.checkpointConflict) await this.captureCheckpoint();
        await this.closeWorkspace(finish, retain);
      } catch (error) {
        this.entry.environment = 'unknown';
        this.fail(error);
      }
    }, error => this.fail(error)).finally(() => { this.reconciling = undefined; });
  }

  private async closeWorkspace(finish?: () => Promise<void>, retain = false): Promise<void> {
    this.controller.abort(); delete this.entry.processId;
    if (this.options.resources.platform === 'linux') {
      const keeping = this.stopping?.mode !== 'cancel' && (this.stopping?.mode === 'pause' || retain || this.preserveArchive);
      const persistent = this.entry.input.spec.serverResources?.workspaceStorage === 'persistent';
      if (keeping && persistent && !this.preserveArchive) {
        this.entry.workspaceArchive = await archiveProject(this.directory, this.options.journal.directory(this.entry.input.operationId), this.entry);
        await this.options.journal.save(this.entry);
        await this.emit({ kind: 'workspace_saved', hash: this.entry.workspaceArchive.hash, identity: this.entry.workspaceArchive.identity });
        await pruneProjectArchives(this.options.journal.directory(this.entry.input.operationId), this.entry.workspaceArchive.id);
      }
      if ((!keeping || persistent) && !this.preserveArchive) await this.options.resources.sandbox.clean(this.directory);
      if (!keeping && persistent) { await pruneProjectArchives(this.options.journal.directory(this.entry.input.operationId)); delete this.entry.workspaceArchive; }
    }
    this.entry.environment = 'closed';
    await this.emit({ kind: 'environment', state: 'closed', terminals: [],
      ...(this.options.resources.platform === 'linux' && (this.stopping?.mode === 'pause' || retain || this.preserveArchive) ? { retainedWorkspace: true } : {}) });
    await finish?.();
    this.releaseWorkspace?.();
    this.releaseWorkspace = undefined;
  }

  stop(reason: string, mode: 'pause' | 'cancel' = 'cancel'): Promise<void> {
    if (this.stopping?.mode === 'pause' && mode === 'cancel') this.stopping = { mode, reason };
    if (this.stopPromise) return this.stopPromise;
    this.stopping = { mode, reason }; this.bridge.fence();
    this.ownedWorkChanged?.();
    this.browser?.fence();
    this.workspaceWait.abort(new Error(reason));
    return this.stopPromise = (async () => {
      if (this.rpc?.running) for (const processId of this.commandChecks) {
        await this.rpc.request('command/exec/terminate', { processId }).catch(() => {});
      }
      if (this.retained) {
        await this.runPromise;
        if (this.retained) {
          try { await this.drainNative(); }
          catch (error) { await this.reportUnknown(); this.reconcileDrain(); throw error; }
          this.flushText();
          await this.serial;
          await this.closeWorkspace();
          return;
        }
      }
      if (!this.draining && this.rpc?.running && this.entry.threadId && this.turn) {
        await this.rpc.request('turn/interrupt', { threadId: this.entry.threadId, turnId: this.turn.id })
          .catch(() => { /* The drain below still checks every loaded thread and actual process exit. */ });
      }
      this.turnWaiter?.reject(new Error(reason));
      await this.runPromise;
      if (this.options.resources.platform === 'linux' && this.stopping?.mode === 'cancel' && this.entry.state === 'paused') {
        await this.closeWorkspace();
        await this.finish('cancelled', this.entry.output, this.stopping.reason);
      } else if (this.stopping?.mode === 'cancel' && this.entry.state === 'paused') {
        await this.finish('cancelled', this.entry.output, this.stopping.reason);
      }
      if (this.entry.environment === 'unknown' || this.entry.state === 'unknown') throw new Error(this.entry.error ?? '项目停止状态未知。');
    })().finally(() => { this.stopPromise = undefined; });
  }
}
