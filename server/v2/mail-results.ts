import { createHash } from 'node:crypto';
import { EWS_MAIL_OPERATION_PREFIX, mailTaskSpecSchema, type EwsMailOperation, type MailTaskReceipt, type MailTaskSpec } from '../../shared/mail.js';
import type { TaskRecord } from '../../shared/task-consent.js';
import type { Store } from '../store.js';
import { RuntimeInputError } from '../runtime.js';

export class MailOutcomeUnknownError extends RuntimeInputError {
  constructor(operation: EwsMailOperation) { super(409, mailFailureMessage(operation)); }
}

export const mailSpecHash = (mail: MailTaskSpec) => createHash('sha256').update(JSON.stringify(mailTaskSpecSchema.parse(mail))).digest('hex');
export const mailOperationId = (taskId: string) => createHash('sha256').update(`mail:${taskId}`).digest('hex');
export function matchesMailTask(task: TaskRecord, operation?: EwsMailOperation): operation is EwsMailOperation {
  return Boolean(task.spec.mail && operation && operation.id === mailOperationId(task.id) && operation.taskId === task.id
    && operation.caseId === task.spec.caseId && operation.connectionId === task.spec.mail.connectionId
    && operation.credentialRevision === task.spec.mail.credentialRevision && operation.approvalRevision === task.approvalRevision
    && operation.requirementsRevision === (task.requirementsRevision ?? 1) && operation.specHash === mailSpecHash(task.spec.mail));
}
export function matchingMailOperation(task: TaskRecord, store: Pick<Store, 'getMeta'>): EwsMailOperation | undefined {
  const operation = store.getMeta<EwsMailOperation | undefined>(EWS_MAIL_OPERATION_PREFIX + task.id, undefined);
  return matchesMailTask(task, operation) ? operation : undefined;
}
export function mailOperationReceipt(operation: EwsMailOperation): MailTaskReceipt {
  return { operationId: operation.id, state: operation.state, updatedAt: operation.updatedAt, ...(operation.error ? { error: operation.error } : {}),
    ...(operation.replyTracking === undefined ? {} : { replyTracking: operation.replyTracking }) };
}
export function mailFailureMessage(operation: EwsMailOperation): string {
  if (operation.state === 'unknown') return '邮件提交结果未知；已保存操作记录，不会自动重发。请先核对发件箱或联系 IT。';
  return operation.error ?? '邮件没有获得 Exchange 的提交确认，不能标记为发送成功。';
}
