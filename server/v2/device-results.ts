import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { commandFailureMessage, deviceDirectoryLookupResultSchema, type DeviceDirectoryLookupResult, type DeviceOperation, type DeviceOperationReceipt } from '../../shared/local-device.js';
import type { TaskRecord } from '../../shared/task-consent.js';
import type { Message, Run } from '../../shared/types.js';
import type { DeviceBroker } from '../devices/broker.js';
import type { Store } from '../store.js';
import type { TaskConsent } from './consent.js';
import type { EventInbox } from './events.js';
import { runResponseId } from './run-response.js';

export function matchesDeviceTask(task: TaskRecord, operation?: DeviceOperation): operation is DeviceOperation {
  return Boolean(operation && task.spec.command && task.startedAt && task.approvalRevision !== undefined
    && operation.taskId === task.id && operation.taskRevision === task.approvalRevision + 1
    && isDeepStrictEqual(operation.spec, task.spec.command));
}
export function finalDeviceReceipt(receipt: DeviceOperationReceipt): boolean {
  return ['completed', 'failed', 'cancelled'].includes(receipt.state);
}
const escapeMarkdown = (value: string) => value.replace(/[\\`*_\[\]{}()<>#+.!|~-]/g, '\\$&');
export function directoryLookupReply(result: DeviceDirectoryLookupResult, timezone: string): string {
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const directories = result.entryType === 'directory';
  const label = directories ? '文件夹' : '文件';
  const lines = result.files.map(file => directories
    ? `- ${escapeMarkdown(win32.join(result.directory, file.name))}（文件夹，${date.format(new Date(file.modifiedAt))}）`
    : `- ${escapeMarkdown(file.name)}（${file.size.toLocaleString('zh-CN')} B，${date.format(new Date(file.modifiedAt))}）`);
  const heading = `${escapeMarkdown(result.directory)} 中${lines.length ? `找到 ${lines.length} 个匹配${label}` : result.truncated ? `已检查的项目中未找到匹配${label}` : `未找到匹配${label}`}。`;
  return `${heading}${lines.length ? `\n\n${lines.join('\n')}` : ''}${result.truncated ? `\n\n本次检查了 ${result.scanned} 项，列表已截断。` : ''}`;
}
export function localCommandReply(receipt: DeviceOperationReceipt): string {
  const codeBlock = (content: string) => {
    let length = 3;
    for (const match of content.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
    const fence = '`'.repeat(length);
    return `${fence}text\n${content}\n${fence}`;
  };
  return [`设备命令已结束，退出码 ${receipt.exitCode}。`,
    receipt.stdout ? `标准输出：\n${codeBlock(receipt.stdout)}` : '设备未返回标准输出。',
    receipt.stderr ? `标准错误：\n${codeBlock(receipt.stderr)}` : ''].filter(Boolean).join('\n\n');
}
export const analysisPendingNote = '设备查询结果已返回，原任务要求的分析尚未完成；没有自动重跑查询或调用模型。';
export const deliveryPendingNote = '设备操作结果已返回，原任务要求的后续交付尚未完成；没有自动重跑操作或调用模型。';
export const deviceReceiptProjectionError = '设备回执已保存，结果投影暂未完成，将只重试补齐记录。';

export interface DeviceReceiptProjection {
  store: Store; consent: TaskConsent; inbox: EventInbox; caseStopped(caseId: string): boolean;
}

/** Project one verified terminal receipt. The caller owns scheduling: legacy
 * history omits the requirement version, while TaskExecutor supplies its run's
 * version. This never dispatches, resumes a workflow, or invokes a model. */
export function projectDeviceReceipt(context: DeviceReceiptProjection, operation: DeviceOperation, expectedRequirementsRevision?: number): boolean {
  const { store, consent, inbox, caseStopped } = context;
  const task = consent.get(operation.taskId); const run = store.get('runs', operation.runId);
  const expected = expectedRequirementsRevision ?? 1;
  if (!task || !run || run.taskExecution && expectedRequirementsRevision === undefined
    || !matchesDeviceTask(task, operation) || !finalDeviceReceipt(operation.receipt)
    || (task.requirementsRevision ?? 1) !== expected || (operation.requirementsRevision ?? 1) !== expected
    || (run.taskExecution?.requirementsRevision ?? 1) !== expected
    || !['running', 'failed', 'completed'].includes(task.state) || caseStopped(task.spec.caseId)
    || run.taskId !== task.id || run.caseId !== task.spec.caseId || run.eventId !== task.executionEventId) return false;
  const event = task.executionEventId ? inbox.get(task.executionEventId) : undefined;
  if (!event || !consent.isExecutionEvent(event)) return false;
  const success = operation.receipt.state === 'completed' && operation.receipt.exitCode === 0;
  const original = store.get('messages', runResponseId(run.id));
  let result: DeviceDirectoryLookupResult | undefined;
  if (success && task.spec.command && 'kind' in task.spec.command) {
    try { result = deviceDirectoryLookupResultSchema.parse(JSON.parse(operation.receipt.stdout ?? 'null')); } catch { return false; }
  }
  const pendingDelivery = Boolean(task.spec.directoryAnalysis || task.requirementUpdates?.length
    || task.spec.capabilities.some(capability => capability !== 'local-command'));
  const error = success ? pendingDelivery && task.state !== 'completed'
    ? task.spec.directoryAnalysis ? analysisPendingNote : deliveryPendingNote : undefined : commandFailureMessage(operation.receipt);
  if (success && pendingDelivery && task.state === 'completed') return true;
  if (success && pendingDelivery && result && original?.content.includes(directoryLookupReply(result, store.getSettings().timezone))) return true;
  if (!pendingDelivery && original && run.status === (success ? 'completed' : 'failed')
    && task.state === run.status && (success ? original.outputState === 'complete' : original.outputNote === error)) return true;
  const resolved = consent.resolveDeviceReceipt(task.id, operation.operationId, expected)
    ?? (success && pendingDelivery && task.state === 'running' ? task : undefined);
  if (!resolved) return false;
  inbox.acknowledgeRecoveredTask(task.executionEventId!);
  const resolvedAt = operation.receiptReceivedAt ?? operation.receipt.finishedAt ?? operation.issuedAt;
  const id = createHash('sha256').update(`device-result:${operation.operationId}`).digest('hex');
  const content = success ? (result ? directoryLookupReply(result, store.getSettings().timezone) : localCommandReply(operation.receipt)) : commandFailureMessage(operation.receipt);
  const note = error ?? '已按设备最终回执补齐结果；没有重新执行。';
  const message: Message = { id, role: 'assistant', caseId: task.spec.caseId, runId: run.id, createdAt: resolvedAt,
    content: `设备最终回执已补回。\n\n${content}`, outputState: resolved.state === 'completed' ? 'complete' : 'incomplete', outputNote: note,
    ...(original ? { replyTo: original.id } : {}) };
  const { error: priorError, ...previousRun } = run;
  const updated: Run = { ...previousRun, status: resolved.state === 'completed' ? 'completed' : 'failed', endedAt: resolvedAt,
    ...(error ? { error } : {}), deviceResolution: run.deviceResolution ?? { operationId: operation.operationId, resolvedAt,
      previousStatus: run.status, ...(priorError ? { previousError: priorError } : {}), ...(run.endedAt ? { previousEndedAt: run.endedAt } : {}) } };
  store.atomic(() => {
    if (!isDeepStrictEqual(store.get('messages', id), message)) store.put('messages', message);
    if (!isDeepStrictEqual(run, updated)) store.put('runs', updated);
    const lastError = store.getMeta<string | null>('v2.lastError', null);
    if (resolved.state === 'completed' && (priorError && lastError === priorError || lastError === deviceReceiptProjectionError)) store.setMeta('v2.lastError', null);
  });
  return true;
}

/** Receipt storage is the device fact. This owner reconciles its existing task,
 * run and public-message projections. No queue entry, new consent or model call
 * is created by recovery, and partial cross-database writes are repairable. */
export class DeviceTaskResults {
  constructor(private readonly store: Store, private readonly consent: TaskConsent,
    private readonly devices: Pick<DeviceBroker, 'operationForTask' | 'listOperations'>,
    private readonly active: (run: Run) => boolean, private readonly caseStopped: (caseId: string) => boolean,
    private readonly inbox: EventInbox) {}

  directoryResult(task: TaskRecord, selectedDeviceId?: string) {
    const command = task.spec.command;
    if (!command || !('kind' in command) || task.state === 'revoked' || selectedDeviceId && command.deviceId !== selectedDeviceId) return;
    const operationId = createHash('sha256').update(`local-command:${task.id}`).digest('hex');
    let operation = this.devices.operationForTask(task.id, operationId);
    if (operation?.operationId !== operationId) operation = undefined;
    if (!operation) {
      if (this.store.latestTaskExecutionRun(task.id)) return;
      operation = this.devices.listOperations(task.id).filter(value => {
        if (!matchesDeviceTask(task, value) || value.receipt.state !== 'completed' || value.receipt.exitCode !== 0) return false;
        const run = this.store.get('runs', value.runId);
        return run?.taskId === task.id && run.caseId === task.spec.caseId && run.eventId === task.executionEventId;
      })
        .sort((a, b) => (b.receiptReceivedAt ?? b.receipt.finishedAt ?? b.issuedAt).localeCompare(a.receiptReceivedAt ?? a.receipt.finishedAt ?? a.issuedAt))[0];
    }
    if (!matchesDeviceTask(task, operation) || operation.receipt.state !== 'completed' || operation.receipt.exitCode !== 0 || !operation.receipt.stdout) return;
    try {
      const result = deviceDirectoryLookupResultSchema.parse(JSON.parse(operation.receipt.stdout));
      return { taskId: task.id, finishedAt: operation.receipt.finishedAt ?? task.finishedAt ?? operation.issuedAt, ...result };
    } catch { return; }
  }
  previousDirectoryResult(tasks: TaskRecord[], selectedDeviceId?: string, quotedTaskId?: string) {
    // A quoted task is exact: never substitute another receipt for it.
    const results = tasks.filter(task => !quotedTaskId || task.id === quotedTaskId)
      .map(task => this.directoryResult(task, selectedDeviceId)).filter(value => value !== undefined);
    return results.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.taskId.localeCompare(a.taskId))[0];
  }
  reconcileOperation(operation: DeviceOperation): void {
    if (!finalDeviceReceipt(operation.receipt)) return;
    const run = this.store.get('runs', operation.runId);
    // Pre-upgrade records retain receipt-only reconciliation. New task runs have
    // one result owner in TaskExecutor; this archive repair must not finish them.
    if (!run || run.taskExecution || this.active(run)) return;
    projectDeviceReceipt({ store: this.store, consent: this.consent, inbox: this.inbox, caseStopped: this.caseStopped }, operation);
  }
}
