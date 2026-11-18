import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { taskOutcomeEvidenceSchema, taskOutcomeReferenceSchema, type TaskOutcomeEvidence, type TaskOutcomeReference } from '../../shared/personal-memory.js';
import { githubTaskSpecCanonicalJson, GITHUB_OPERATIONS_PREFIX, type GitHubOperation } from '../../shared/github.js';
import type { Feedback, Run } from '../../shared/types.js';
import type { TaskRecord } from '../../shared/task-consent.js';
import type { Store } from '../store.js';
import type { DeviceBroker } from '../devices/broker.js';
import { projectSpecHash } from '../devices/projects.js';
import type { MediaJobs } from '../media/jobs.js';
import { isOwnerChatEvent, type TaskConsent } from './consent.js';
import type { EventInbox, InboxEvent, StoredEvent } from './events.js';
import type { SourceRegistry } from './sources.js';
import type { WorkspaceExecutor } from './workspace.js';
import { finalDeviceReceipt, matchesDeviceTask } from './device-results.js';
import { matchingMailOperation } from './mail-results.js';
import { projectInputContext } from './project-inputs.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const kind = 'task.outcome';
const sourceId = 'task-outcome';
type Snapshot = Omit<TaskOutcomeEvidence, 'eventId'>;
const snapshotSchema = taskOutcomeEvidenceSchema.omit({ eventId: true });
type NativeEvidence = { reference: Snapshot['operations'][number]; checks: Snapshot['checks'] };
export interface TaskFeedbackTarget {
  targetType: Feedback['targetType']; targetId: string; caseId?: string; targetContent: string;
}
export interface TaskLearningOptions {
  store: Store; consent: TaskConsent; inbox: EventInbox;
  sources: Pick<SourceRegistry, 'isEventAllowed' | 'resolveEventCase'>;
  devices: Pick<DeviceBroker, 'getOperation' | 'projects'>;
  workspace: Pick<WorkspaceExecutor, 'getGrant'>;
  media?: Pick<MediaJobs, 'operationForTask'>;
}

/** Historical evidence in the existing inbox, not another task/memory truth.
 * Recording is local and idempotent; only an already-triggered bounded learning
 * turn may choose to derive a method from these concrete result facts. */
export class TaskLearning {
  private readonly resolving = new Set<string>();
  constructor(private readonly options: TaskLearningOptions) {}

  private nativeEvidence(task: TaskRecord, requirementsRevision: number): NativeEvidence[] {
    const { store, devices } = this.options;
    if (task.spec.project) {
      const operation = devices.projects.forTask(task.id);
      if (!operation || operation.input.approvalRevision !== task.approvalRevision
        || operation.input.specHash !== projectSpecHash(task.spec.project)) return [];
      const id = operation.input.operationId;
      const receipt = devices.projects.deliveryReceipt(id, requirementsRevision);
      if (!receipt) return [];
      const checks: Snapshot['checks'] = [{ source: 'project', referenceId: id, name: 'project.native_receipt',
        passed: receipt.state === 'completed', detail: `设备回合状态为 ${receipt.state}。回合结束只证明执行器已返回。` }];
      if (!receipt.tools.length) checks.push({ source: 'project', referenceId: id, name: 'project.tool_receipt',
        passed: false, detail: '当前要求版本没有本机工具完成回执，无法从设备记录核对实际操作。' });
      if (receipt.delivery) {
        for (const check of receipt.delivery.checks) checks.push({ source: 'project', referenceId: `${id}:${receipt.delivery.sequence}:${hash(check.id)}`,
          name: 'project.delivery_check', passed: check.status === 'passed',
          detail: `原交付检查 ${check.id} 为 ${check.status}，${check.required ? '必需' : '非阻断'}项，关联 ${check.requirements} 项要求和 ${check.files} 份文件；实际包含 ${check.assertions} 项断言${check.command ? '及原生命令检查' : ''}${check.desktop ? '及应用状态核对' : ''}。结论限于记录的检查范围，不能认证通用能力。` });
        if (receipt.delivery.total > receipt.delivery.checks.length) checks.push({ source: 'project', referenceId: `${id}:${receipt.delivery.sequence}`,
          name: 'project.check_coverage', passed: false, detail: `本条证据列出 ${receipt.delivery.checks.length} 项实际检查，共 ${receipt.delivery.total} 项。完整记录保留在原任务。` });
      }
      for (const tool of receipt.delivery ? receipt.tools.slice(-8) : receipt.tools) {
        if (tool.type !== 'commandExecution' || tool.exitCode === undefined) continue;
        checks.push({ source: 'project', referenceId: `${id}:${tool.sequence}`, name: 'project.command_exit',
          passed: tool.state === 'succeeded' && tool.exitCode === 0,
          detail: `设备命令回执 #${tool.sequence} 的退出码为 ${tool.exitCode}。退出码只说明该命令的运行结果。` });
      }
      return [{ reference: { kind: 'project', id, requirementsRevision, state: receipt.state,
        receiptHash: hash(JSON.stringify(receipt)) }, checks }];
    }
    if (task.spec.mail) {
      const operation = matchingMailOperation(task, store);
      if (!operation || operation.requirementsRevision !== requirementsRevision || !['submitted', 'failed', 'unknown'].includes(operation.state)) return [];
      const { id, state, payloadHash, updatedAt, submittedAt } = operation;
      return [{ reference: { kind: 'mail', id, requirementsRevision, state,
        receiptHash: hash(JSON.stringify({ state, payloadHash, updatedAt, submittedAt })) },
      checks: [{ source: 'mail', referenceId: id, name: 'mail.submission', passed: state === 'submitted',
        detail: state === 'submitted' ? 'Exchange 已接受本次邮件提交。收件人的实际收取情况仍需另行核对。'
          : `本次邮件提交状态为 ${state}，没有 Exchange 接受提交的确认。` }] }];
    }
    if (!task.spec.github) return [];
    const scopeHash = hash(githubTaskSpecCanonicalJson(task.spec.github));
    return store.getMeta<GitHubOperation[]>(GITHUB_OPERATIONS_PREFIX + task.id, []).filter(operation => operation.taskId === task.id
      && operation.caseId === task.spec.caseId && operation.approvalRevision === task.approvalRevision
      && operation.requirementsRevision === requirementsRevision && operation.specHash === scopeHash
      && ['submitted', 'failed', 'unknown'].includes(operation.state)).map(operation => {
      const { id, state, inputHash, updatedAt, receipt } = operation;
      const passed = state === 'submitted' && Boolean(receipt);
      return { reference: { kind: 'github', id, requirementsRevision, state,
        receiptHash: hash(JSON.stringify({ state, inputHash, updatedAt, receipt })) },
      checks: [{ source: 'github', referenceId: id, name: 'github.submission', passed,
        detail: passed ? `GitHub 已返回 ${operation.operation} 的操作回执。回执适用于该次操作。`
          : `GitHub ${operation.operation} 的操作状态为 ${state}，缺少成功回执。` }] };
    });
  }

  private binding(runId: string, historical = false): { run: Run; task: TaskRecord; sourceEventIds: string[] } | undefined {
    const run = this.options.store.get('runs', runId);
    if (!run?.taskId || !run.caseId || !run.eventId || !run.endedAt || !['completed', 'failed', 'interrupted'].includes(run.status)) return;
    const task = this.options.consent.get(run.taskId);
    const event = this.options.inbox.get(run.eventId);
    if (!task?.approvalRevision || task.executionEventId !== run.eventId || task.spec.caseId !== run.caseId
      || !event || !this.options.consent.isExecutionEvent(event)) return;
    const revision = run.taskExecution?.requirementsRevision ?? 1;
    if (revision > (task.requirementsRevision ?? 1)) return;
    const laterReferences = new Set((task.requirementUpdates ?? []).filter(update => update.revision > revision).flatMap(update => update.evidenceEventIds ?? []));
    const evidenceRefs = (task.evidenceRefs ?? []).filter(reference => !laterReferences.has(reference.eventId));
    const actualEvidence = run.evidenceEventIds ?? [];
    const ownerInputs = task.spec.project && task.executionContractVersion === 2 ? projectInputContext({ ...task,
      requirementUpdates: task.requirementUpdates?.filter(update => update.revision <= revision) },
    this.options.store, this.options.inbox, this.options.sources) : undefined;
    if (ownerInputs && !historical && !ownerInputs.available) return;
    const ownerInputEventIds = [...new Set([...(ownerInputs?.sourceEventIds ?? []), ...(run.taskExecution?.ownerInputEventIds ?? [])])];
    if (ownerInputEventIds.some(id => {
      const source = this.options.inbox.get(id);
      return !source || !isOwnerChatEvent(source) || !historical && !this.options.sources.isEventAllowed(source);
    })) return;
    for (const id of actualEvidence) {
      const source = this.options.inbox.get(id);
      if (!source || !historical && !this.options.sources.isEventAllowed(source)) return;
      const sourceCaseId = historical ? source.caseId : this.options.sources.resolveEventCase(source);
      const linked = evidenceRefs.find(reference => reference.eventId === id && reference.sourceCaseId === sourceCaseId
        && reference.sourceId === source.sourceId && reference.sourceGeneration === source.sourceGeneration);
      if (sourceCaseId !== task.spec.caseId && !linked) return;
    }
    const sourceEventIds = [...new Set([...(task.sourceEventId ? [task.sourceEventId] : []),
      ...(task.requirementUpdates ?? []).filter(update => update.revision <= revision).map(update => update.sourceEventId),
      ...evidenceRefs.map(reference => reference.eventId), ...actualEvidence, ...ownerInputEventIds])];
    if (sourceEventIds.length > 128 || sourceEventIds.some(id => {
      const source = this.options.inbox.get(id);
      return !source || !historical && !this.options.sources.isEventAllowed(source);
    })) return;
    for (const reference of evidenceRefs) {
      const source = this.options.inbox.get(reference.eventId);
      if (!source || source.sourceId !== reference.sourceId || source.sourceGeneration !== reference.sourceGeneration
        || (historical ? source.caseId : this.options.sources.resolveEventCase(source)) !== reference.sourceCaseId) return;
    }
    return { run, task, sourceEventIds };
  }

  private snapshot(runId: string): Snapshot | undefined {
    const binding = this.binding(runId); if (!binding) return;
    const { run, task, sourceEventIds } = binding;
    const requirementsRevision = run.taskExecution?.requirementsRevision ?? 1;
    const artifacts = this.options.store.list('artifacts').filter(artifact => artifact.taskId === task.id && artifact.caseId === task.spec.caseId
      && (artifact.requirementsRevision ?? 1) === requirementsRevision
      && Date.parse(artifact.createdAt) >= Date.parse(run.startedAt) && Date.parse(artifact.createdAt) <= Date.parse(run.endedAt!));
    const deliveries: TaskOutcomeEvidence['deliveries'] = artifacts.slice(0, 8).map(artifact => ({ artifactId: artifact.id,
      contentHash: hash(artifact.content), status: artifact.status === 'verified' ? 'verified' : 'prepared' }));
    const checks: TaskOutcomeEvidence['checks'] = [];
    const operations: TaskOutcomeEvidence['operations'] = [];
    if (deliveries.length) checks.push({ source: 'artifact', referenceId: run.id, name: 'artifact.persisted', passed: true,
      detail: `本结果列出 ${deliveries.length} 份可回读文本${artifacts.length > deliveries.length ? `（本次共保存 ${artifacts.length} 份，其余未列入本条证据）` : ''}；只证明这些内容已保存，prepared 或状态标签本身不证明质量。` });
    if (task.spec.command) {
      const operation = this.options.devices.getOperation(hash(`local-command:${task.id}`));
      if (operation && matchesDeviceTask(task, operation) && operation.receiptReceivedAt && finalDeviceReceipt(operation.receipt)
        && Date.parse(operation.receiptReceivedAt) <= Date.parse(run.endedAt!)
        && (operation.receipt.state !== 'completed' || operation.admittedAt)
        && (operation.requirementsRevision ?? 1) <= requirementsRevision) {
        operations.push({ kind: 'device', id: operation.operationId, requirementsRevision: operation.requirementsRevision ?? 1,
          receiptHash: hash(JSON.stringify(operation.receipt)), state: operation.receipt.state });
        checks.push({ source: 'device', referenceId: operation.operationId, name: 'device.authenticated_receipt',
          passed: operation.receipt.state === 'completed' && operation.receipt.exitCode === 0,
          detail: `原指定设备操作的认证回执为 ${operation.receipt.state}${operation.receipt.exitCode === undefined ? '' : `，退出码 ${operation.receipt.exitCode}`}；只证明该操作结果，不证明后续分析或文本质量。` });
      }
    }
    if (task.spec.media) {
      const job = this.options.media?.operationForTask(task.id);
      if (job && job.caseId === task.spec.caseId && job.kind === task.spec.media.kind && job.model === task.spec.media.model
        && job.prompt === task.spec.media.prompt && ['completed', 'failed', 'cancelled', 'unknown'].includes(job.state)) {
        operations.push({ kind: 'media', id: job.id, requirementsRevision: job.requirementsRevision ?? 1,
          receiptHash: hash(JSON.stringify({ state: job.state, files: job.files, upstreamId: job.upstreamId ?? null })), state: job.state });
        checks.push({ source: 'media', referenceId: job.id, name: 'media.private_copy', passed: job.state === 'completed' && job.files.length > 0,
          detail: job.state === 'completed' && job.files.length ? '媒体接口已保存可交付的私有文件；不证明画面质量或符合全部审美要求。' : `媒体结果为 ${job.state}，没有可据此认证质量的成功回执。` });
      }
    }
    if (task.spec.workspace) {
      const grant = this.options.workspace.getGrant(task.spec.caseId); const receipt = grant?.latestReceipt;
      if (grant && !grant.revokedAt && receipt && grant.revision === task.spec.workspace.revision
        && receipt.authorizationRevision === task.spec.workspace.revision && receipt.caseId === task.spec.caseId
        && isDeepStrictEqual([...grant.allowedFiles].sort(), [...task.spec.workspace.files].sort())
        && Date.parse(receipt.createdAt) >= Date.parse(run.startedAt) && Date.parse(receipt.createdAt) <= Date.parse(run.endedAt!)) {
        for (const check of receipt.checks.slice(0, 16)) checks.push({ source: 'workspace', referenceId: receipt.id, name: check.name,
          passed: check.passed && check.exitCode === 0, detail: `${check.detail.slice(0, 450)}；仅适用于回执 ${receipt.id} 中的授权文件版本与该项条件。` });
      }
    }
    const native = this.nativeEvidence(task, requirementsRevision);
    const included = native.slice(0, 4 - operations.length);
    for (const item of included) { operations.push(item.reference); checks.push(...item.checks); }
    if (included.length < native.length) checks.push({ source: 'github', referenceId: run.id, name: 'github.receipt_coverage',
      passed: false, detail: `本条证据列出 ${included.length} 条 GitHub 操作，共记录 ${native.length} 条。完整回执仍可在原任务查看。` });
    checks.push({ source: 'runtime', referenceId: run.id, name: 'runtime.delivery_state', passed: run.status === 'completed',
      detail: run.status === 'completed' ? (task.spec.project ? '执行器已收到本机回合结束回执。请结合实际工具记录和本人反馈核对交付。'
        : '执行器完成了该要求版本的交付检查；这不是独立内容质量评估，也不是方法能力认证。')
        : `该要求版本的运行结果为 ${run.status}${run.stopReason ? `，停止原因 ${run.stopReason}` : ''}；保存部分结果不等于任务完成。` });
    return { taskId: task.id, runId: run.id, caseId: task.spec.caseId, executionEventId: run.eventId!, approvalRevision: task.approvalRevision!,
      requirementsRevision, status: run.status as Snapshot['status'], recordedAt: run.endedAt!, deliveries, operations, checks: checks.slice(0, 20), sourceEventIds };
  }
  private outcomeId(snapshot: Snapshot): string { return hash(`${kind}:${JSON.stringify(snapshotSchema.parse(snapshot))}`); }
  private matchesOutcomeId(eventId: string, snapshot: Snapshot): boolean {
    if (eventId === this.outcomeId(snapshot)) return true;
    // Earlier native builders placed state before receiptHash, whereas schema
    // parsing reverses those keys. Preserve their durable journal IDs on read;
    // new IDs always hash the schema-normalized snapshot above.
    if (!snapshot.operations.some(reference => ['project', 'mail', 'github'].includes(reference.kind))) return false;
    const legacy = { ...snapshot, operations: snapshot.operations.map(reference => ['project', 'mail', 'github'].includes(reference.kind)
      ? { kind: reference.kind, id: reference.id, requirementsRevision: reference.requirementsRevision,
        state: reference.state, receiptHash: reference.receiptHash } : reference) };
    return eventId === hash(`${kind}:${JSON.stringify(legacy)}`);
  }
  private content(outcome: TaskOutcomeEvidence): string {
    return [`任务 ${outcome.taskId}，要求版本 ${outcome.requirementsRevision}，运行 ${outcome.runId}。`,
      `实际运行状态：${outcome.status}。这些结果不是方法成功认证。`,
      ...outcome.checks.map(check => `${check.passed ? '通过' : '未通过'} ${check.name}：${check.detail}`)].join('\n');
  }
  recordOutcome(runId: string): StoredEvent | undefined {
    const previous = this.getOutcome(runId);
    if (previous) {
      this.options.inbox.consumeLocal([kind], candidate => candidate.id === previous.eventId);
      return this.options.inbox.get(previous.eventId);
    }
    const snapshot = this.snapshot(runId); if (!snapshot) return;
    const outcome = taskOutcomeEvidenceSchema.parse({ ...snapshot, eventId: this.outcomeId(snapshot) });
    // This independent run journal is written only from the real-record builder.
    // A forged inbox payload, even with a matching self-computed digest, cannot
    // promote itself into a trusted result. A crash here is repaired locally.
    const run = this.options.store.get('runs', runId)!;
    this.options.store.put('runs', { ...run, taskOutcomeEventId: outcome.eventId });
    const event = this.options.inbox.ingest({ id: outcome.eventId, sourceId, externalId: runId, version: outcome.eventId,
      kind, actor: 'system', operation: 'create', caseId: outcome.caseId, occurredAt: outcome.recordedAt,
      causationId: outcome.executionEventId, payload: { content: this.content(outcome), outcome } }).event;
    // Even a crash between ingest and acknowledgement is harmless: callers must
    // exclude task.outcome from inference dispatch and recordOutcome repairs it.
    this.options.inbox.consumeLocal([kind], candidate => candidate.id === event.id);
    return this.options.inbox.get(event.id);
  }
  private eventOutcome(event: InboxEvent, historical = false): TaskOutcomeEvidence | undefined {
    if (event.kind !== kind || event.sourceId !== sourceId || event.actor !== 'system') return;
    const parsed = taskOutcomeEvidenceSchema.safeParse(event.payload.outcome); if (!parsed.success) return;
    const outcome = parsed.data; const { eventId, ...snapshot } = outcome;
    if (event.id !== eventId || !this.matchesOutcomeId(eventId, snapshot) || event.caseId !== outcome.caseId || event.externalId !== outcome.runId
      || event.causationId !== outcome.executionEventId || event.payload.content !== this.content(outcome)) return;
    const persisted = this.options.inbox.get(event.id);
    if (!persisted || !isDeepStrictEqual(persisted.payload, event.payload)) return;
    const binding = this.binding(outcome.runId, historical);
    if (!binding || binding.run.taskOutcomeEventId !== event.id || !historical && (binding.run.status !== outcome.status || binding.run.endedAt !== outcome.recordedAt)
      || binding.task.id !== outcome.taskId || binding.task.approvalRevision !== outcome.approvalRevision
      || (binding.run.taskExecution?.requirementsRevision ?? 1) !== outcome.requirementsRevision
      || !isDeepStrictEqual(binding.sourceEventIds, outcome.sourceEventIds)) return;
    for (const delivery of outcome.deliveries) {
      const artifact = this.options.store.get('artifacts', delivery.artifactId);
      if (!artifact || artifact.taskId !== outcome.taskId || artifact.caseId !== outcome.caseId
        || (artifact.requirementsRevision ?? 1) !== outcome.requirementsRevision || hash(artifact.content) !== delivery.contentHash) return;
    }
    const native = !historical && outcome.operations.some(reference => ['project', 'mail', 'github'].includes(reference.kind))
      ? this.nativeEvidence(binding.task, outcome.requirementsRevision) : [];
    for (const reference of historical ? [] : outcome.operations) {
      if (reference.kind === 'device') {
        const operation = this.options.devices.getOperation(reference.id);
        if (!operation || !matchesDeviceTask(binding.task, operation) || !operation.receiptReceivedAt || !finalDeviceReceipt(operation.receipt)
          || (operation.receipt.state === 'completed' && !operation.admittedAt)
          || (operation.requirementsRevision ?? 1) !== reference.requirementsRevision || operation.receipt.state !== reference.state
          || hash(JSON.stringify(operation.receipt)) !== reference.receiptHash) return;
      } else if (reference.kind === 'media') {
        const job = this.options.media?.operationForTask(outcome.taskId);
        if (!job || job.id !== reference.id || job.caseId !== outcome.caseId || (job.requirementsRevision ?? 1) !== reference.requirementsRevision
          || job.state !== reference.state || hash(JSON.stringify({ state: job.state, files: job.files, upstreamId: job.upstreamId ?? null })) !== reference.receiptHash) return;
      } else if (!native.some(item => isDeepStrictEqual(item.reference, reference))) return;
    }
    return outcome;
  }
  getOutcome(runId: string): TaskOutcomeEvidence | undefined {
    const binding = this.binding(runId); if (!binding) return;
    const event = binding.run.taskOutcomeEventId ? this.options.inbox.get(binding.run.taskOutcomeEventId) : undefined;
    return event ? this.eventOutcome(event) : undefined;
  }
  feedbackOutcome(target: TaskFeedbackTarget): TaskOutcomeReference | undefined {
    if (target.targetType !== 'artifact' && target.targetType !== 'message') return;
    const item = this.options.store.get(target.targetType === 'artifact' ? 'artifacts' : 'messages', target.targetId);
    if (!item || !item.caseId || item.caseId !== target.caseId || item.content.slice(0, 8000) !== target.targetContent) return;
    let run: Run | undefined;
    if ('taskId' in item && item.taskId) run = this.options.store.list('runs').filter(candidate => candidate.taskId === item.taskId
      && candidate.caseId === target.caseId && (candidate.taskExecution?.requirementsRevision ?? 1) === (item.requirementsRevision ?? 1)
      && Date.parse(candidate.startedAt) <= Date.parse(item.createdAt) && (!candidate.endedAt || Date.parse(candidate.endedAt) >= Date.parse(item.createdAt)))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    else if ('runId' in item && item.runId && 'role' in item && item.role === 'assistant') run = this.options.store.get('runs', item.runId);
    const taskId = run?.taskId ?? ('taskId' in item ? item.taskId : undefined);
    if (!taskId) return;
    const requirementsRevision = 'requirementsRevision' in item ? item.requirementsRevision ?? 1 : run?.taskExecution?.requirementsRevision ?? 1;
    const unavailable = (): TaskOutcomeReference => ({ taskId, requirementsRevision,
      outcomeEventId: hash(`unavailable-task-outcome:${run?.id ?? taskId}:${requirementsRevision}:${target.targetId}`),
      targetContentHash: hash(target.targetContent), unavailable: true });
    if (!run?.taskId || run.caseId !== target.caseId) return unavailable();
    const event = this.recordOutcome(run.id);
    const journaled = run.taskOutcomeEventId ? this.options.inbox.get(run.taskOutcomeEventId) : undefined;
    const outcome = event ? this.eventOutcome(event) : journaled ? this.eventOutcome(journaled, true) : undefined;
    if (!outcome || outcome.caseId !== target.caseId || outcome.requirementsRevision !== requirementsRevision) return unavailable();
    if (target.targetType === 'artifact' && !outcome.deliveries.some(delivery => delivery.artifactId === item.id && delivery.contentHash === hash(item.content))) return unavailable();
    return { taskId: outcome.taskId, requirementsRevision: outcome.requirementsRevision,
      outcomeEventId: outcome.eventId, targetContentHash: hash(target.targetContent) };
  }
  resolveEvidence(event: InboxEvent): TaskOutcomeEvidence | undefined {
    if (this.resolving.has(event.id)) return;
    this.resolving.add(event.id);
    try { return this.resolveEvidenceInner(event); }
    finally { this.resolving.delete(event.id); }
  }
  private resolveEvidenceInner(event: InboxEvent): TaskOutcomeEvidence | undefined {
    if (event.kind === kind) return this.eventOutcome(event);
    if (event.kind !== 'owner.feedback' || event.actor !== 'owner' || event.sourceId !== 'owner-feedback') return;
    const parsed = taskOutcomeReferenceSchema.safeParse(event.payload.taskOutcome); if (!parsed.success) return;
    const reference = parsed.data; const targetContent = event.payload.targetContent;
    if (reference.unavailable) return;
    const feedback = this.options.store.get('feedback', event.externalId);
    if (!feedback || feedback.id !== event.payload.id || feedback.caseId !== event.caseId || feedback.targetId !== event.payload.targetId
      || feedback.targetType !== event.payload.targetType || feedback.verdict !== event.payload.verdict || feedback.comment !== event.payload.comment
      || feedback.targetContent !== targetContent || !isDeepStrictEqual(feedback.taskOutcome, reference)
      || typeof targetContent !== 'string' || hash(targetContent) !== reference.targetContentHash) return;
    const original = this.options.inbox.get(reference.outcomeEventId); const outcome = original ? this.eventOutcome(original) : undefined;
    return outcome && outcome.caseId === event.caseId && outcome.taskId === reference.taskId && outcome.requirementsRevision === reference.requirementsRevision ? outcome : undefined;
  }
}
