import { createHash, randomUUID } from 'node:crypto';
import type { Run } from '../../shared/types.js';
import type { RunProgressOperation, RunProgressPhase } from '../../shared/run-progress.js';
import { summarizeFailure } from './failure-diagnostics.js';
import type { Store } from '../store.js';

export interface RunProgressSignal { phase: 'preparing' | 'model' | 'reply' }
/** Progress is a projection: its retry must never overwrite newer business facts. */
export function persistRunProgress(store: Pick<Store, 'get' | 'put'>, run: Run): void {
  const latest = store.get('runs', run.id);
  if (latest && run.progress) store.put('runs', { ...latest, progress: run.progress });
}
type Status = RunProgressOperation['status'];
const labels: Record<string, string> = {
  'native.files': '保存成果文件',
  web_search: '检索联网资料', read_event: '读取已授权资料', find_case_evidence: '查找场景资料', recall: '回查历史消息',
  read_connected_document: '读取腾讯文档', list_connected_documents: '核对文档连接',
  list_mailbox_messages: '查询邮件列表', read_mailbox_message: '读取邮件内容', get_mail_message_context: '核对原邮件',
  list_wechat_conversations: '核对微信会话', query_wechat_messages: '查询已同步消息',
  list_github_connections: '核对GitHub账号', read_github_repository: '查询GitHub资料',
  get_me: '查看GitHub账号', search_repositories: '搜索GitHub仓库', search_code: '搜索仓库代码',
  search_issues: '搜索Issue', search_pull_requests: '搜索PR', get_file_contents: '读取仓库文件',
  list_branches: '核对仓库分支', list_commits: '查看提交记录', get_commit: '查看代码提交',
  issue_read: '读取Issue资料', pull_request_read: '读取PR资料', create_branch: '处理仓库分支',
  push_files: '处理代码提交', create_or_update_file: '处理仓库文件提交', issue_write: '处理Issue修改',
  add_issue_comment: '处理事项评论', create_pull_request: '处理PR创建', update_pull_request: '处理PR修改',
  request_task: '登记后台任务', propose_task: '保存任务提议', list_tasks: '核对已有任务', read_task_result: '读取任务结果',
  decide_task: '记录提案决定', find_attention_items: '回查持续事项',
  revise_task: '记录补充要求', cancel_task: '停止指定任务', inspect_product: '查看产品状态', manage_product: '登记产品操作',
  notify_user: '保存本人通知', schedule_wake: '保存时间安排', list_wakes: '核对时间安排', cancel_wake: '取消时间安排',
  finish_review: '保存回顾结果', save_working_state: '更新内部工作状态', read_working_state: '读取内部工作状态',
  remember_personal_memory: '整理本人理解', learn_method: '整理方法经验',
  publish_artifact: '保存交付内容', read_workspace: '读取任务文件', write_workspace: '修改任务文件',
  verify_workspace: '核对任务文件', handoff_workspace: '读取文件交付回执',
  list_task_devices: '核对执行设备', read_local_file_result: '读取设备查询回执',
  submit_mail_body: '处理邮件提交', 'native.device': '等待设备执行结果', 'native.mail': '核对邮件提交回执', 'native.project': '处理本地项目',
  'native.media': '等待媒体生成与保存',
};
const writeTools = new Set(['push_files', 'create_or_update_file', 'issue_write', 'add_issue_comment', 'create_pull_request',
  'update_pull_request', 'create_branch', 'submit_mail_body', 'native.mail', 'native.device', 'native.media']);
const summaries: Record<Status, string> = { running: '操作正在进行', succeeded: '操作已返回结果', failed: '操作未完成',
  interrupted: '本次操作已中断', unknown: '结果待核对' };
export const nativeProgressSummary = {
  deviceWaiting: '等待设备接收或返回结果', deviceRunning: '设备正在执行',
  mediaQueued: '上游已排队', mediaRunning: '上游正在生成', mediaSaving: '正在保存媒体产物',
  mailSubmitted: 'Exchange已接受提交', artifactSaved: '内容已保存，待本人验收',
  taskRegistered: '任务已登记，执行结果另行核对', productRegistered: '操作已登记，等待实际处理结果',
  recovered: '上次运行中断，结果待同步', endedUnknown: '本轮已结束，操作结果待核对',
  sourceUnavailable: '资料来源当前不可读', timeout: '请求超时',
} as const;
const allowedSummaries = new Set<string>([...Object.values(summaries), ...Object.values(nativeProgressSummary)]);
const summaryText = (value: unknown, status: Status): string => typeof value === 'string'
  && (allowedSummaries.has(value) || /^接口返回HTTP [1-5][0-9]{2}$/.test(value)) ? value : summaries[status];
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const property = (value: unknown, name: string): unknown => { try { return record(value)?.[name]; } catch { return undefined; } };
const baseName = (name: string) => name.startsWith('github_') ? name.slice(7) : name;
export function progressToolCallId(context: unknown): string | undefined {
  const value = property(property(context, 'agent'), 'toolCallId'); return typeof value === 'string' ? value : undefined;
}
function kind(name: string, input?: unknown): string {
  if (name === 'read_github_repository') {
    const selected = property(input, 'tool');
    if (typeof selected === 'string' && Object.hasOwn(labels, selected)) return selected;
  }
  return baseName(name);
}

export function progressOutcome(name: string, result?: unknown, error?: unknown): { status: Exclude<Status, 'running'>; summary: string } {
  const state = property(result, 'state') ?? property(result, 'status');
  const validationErrors = property(result, 'validationErrors');
  let status: Exclude<Status, 'running'> = 'succeeded'; let summary: string | undefined;
  if (error !== undefined) {
    const errorName = property(error, 'name'); const hint = property(error, 'outcomeUnknown');
    const unknown = hint === true || typeof errorName === 'string' && ['GitHubOutcomeUnknownError', 'MailOutcomeUnknownError', 'DeviceOutcomeUnknownError'].includes(errorName);
    status = hint === false ? 'failed' : unknown || writeTools.has(baseName(name)) ? 'unknown'
      : errorName === 'AbortError' ? 'interrupted' : 'failed';
    if (status !== 'unknown') {
      const diagnostic = summarizeFailure(error);
      if (diagnostic.category === 'source_unavailable') summary = nativeProgressSummary.sourceUnavailable;
      else if (diagnostic.code === 'TIMEOUT') summary = nativeProgressSummary.timeout;
      else if (diagnostic.httpStatus !== undefined) summary = `接口返回HTTP ${diagnostic.httpStatus}`;
    }
  } else if (state === 'unknown') status = 'unknown';
  else if (state === 'failed' || state === 'error' || state === 'empty' || state === 'unavailable' || property(result, 'isError') === true
    || Array.isArray(validationErrors) && validationErrors.length > 0) status = 'failed';
  else if (state === 'cancelled' || state === 'interrupted') status = 'interrupted';
  else if (writeTools.has(baseName(name)) && typeof state === 'string' && ['prepared', 'submitting', 'queued', 'running', 'dispatched', 'cancel_requested'].includes(state)) status = 'unknown';
  if (status === 'succeeded' && name === 'publish_artifact') summary = nativeProgressSummary.artifactSaved;
  if (status === 'succeeded' && name === 'request_task') summary = nativeProgressSummary.taskRegistered;
  if (status === 'succeeded' && name === 'manage_product') summary = nativeProgressSummary.productRegistered;
  return { status, summary: summary ?? summaries[status] };
}

/** Settle stale display state only. This never resumes a model or changes receipts. */
export function interruptRunProgress(run: Run): void {
  if (!run.progress) return;
  const at = run.endedAt ?? new Date().toISOString();
  run.progress = { ...run.progress, phase: 'settling', phaseStartedAt: at,
    operations: run.progress.operations.map(operation => operation.status === 'running'
      ? { ...operation, status: 'unknown', endedAt: at, summary: nativeProgressSummary.recovered } : operation) };
}

/** One Run-owned display projection, populated only by actual runtime callbacks. */
export class RunProgressRecorder {
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private readonly names = new Map<string, string>();
  constructor(private readonly run: Run, private readonly save: () => void, private readonly clock: () => number = Date.now) {
    if (!run.progress) {
      const at = this.at(); run.progress = { phase: 'preparing', phaseStartedAt: at, lastActivityAt: at, operations: [] };
      this.persist();
    }
  }
  private at(): string { return new Date(this.clock()).toISOString(); }
  private id(sourceId: string): string { return createHash('sha256').update(`${this.run.id}:${sourceId}`).digest('hex'); }
  private persist(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.dirty && !this.run.progress) return;
    this.dirty = false;
    // A display failure must not replace a real tool failure or accepted receipt.
    try { this.save(); } catch { this.dirty = true; }
  }
  private changed(phase: RunProgressPhase, immediate = true): void {
    const progress = this.run.progress!; const at = this.at();
    const effective = progress.operations.some(operation => operation.status === 'running') ? 'tool' : phase;
    if (progress.phase !== effective) { progress.phase = effective; progress.phaseStartedAt = at; immediate = true; }
    progress.lastActivityAt = at; this.dirty = true;
    if (immediate) this.persist();
    else if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.persist(); }, 250); this.timer.unref(); }
  }
  activity(signal: RunProgressSignal): void { this.changed(signal.phase, signal.phase !== 'reply'); }
  startTool(name: string, toolCallId?: string, input?: unknown): string {
    const normalized = kind(name, input); const id = this.startOperation(toolCallId ?? randomUUID(), normalized);
    this.names.set(id, normalized); return id;
  }
  startOperation(sourceId: string, name: string, startedAt?: string): string {
    const id = this.id(sourceId); const progress = this.run.progress!;
    if (!progress.operations.some(operation => operation.id === id)) {
      progress.operations.push({ id, label: labels[name] ?? '调用已授权工具', status: 'running', startedAt: startedAt ?? this.at() });
      this.names.set(id, name); this.changed('tool');
    }
    return id;
  }
  endTool(id: string, result?: unknown, error?: unknown): void {
    const name = this.names.get(id) ?? '';
    const outcome = progressOutcome(name, result, error); this.endOperation(id, outcome.status, outcome.summary);
  }
  endOperation(id: string, status: Exclude<Status, 'running'>, summary = summaries[status], endedAt?: string): void {
    const operation = this.run.progress!.operations.find(value => value.id === id); if (!operation) return;
    const safeSummary = summaryText(summary, status);
    if (operation.status === status && operation.summary === safeSummary && operation.endedAt) return;
    operation.status = status; operation.endedAt = endedAt ?? this.at(); operation.summary = safeSummary; this.changed('settling');
  }
  observeOperation(sourceId: string, name: string, status: Status, summary?: string, startedAt?: string, endedAt?: string): void {
    const id = this.startOperation(sourceId, name, startedAt);
    if (status !== 'running') this.endOperation(id, status, summary ?? summaries[status], endedAt);
    else {
      const operation = this.run.progress!.operations.find(value => value.id === id)!;
      const safeSummary = summary === undefined ? undefined : summaryText(summary, status);
      if (operation.status !== 'running' || safeSummary && operation.summary !== safeSummary) {
        operation.status = 'running'; delete operation.endedAt; if (safeSummary) operation.summary = safeSummary; this.changed('tool');
      }
    }
  }
  finish(): void {
    let changed = false;
    for (const operation of this.run.progress!.operations) if (operation.status === 'running') {
      operation.status = 'unknown'; operation.endedAt = this.at(); operation.summary = nativeProgressSummary.endedUnknown;
      changed = true;
    }
    if (!changed && this.run.progress!.phase === 'settling') { if (this.dirty) this.persist(); return; }
    this.changed('settling');
  }
  dispose(): void { clearTimeout(this.timer); this.timer = undefined; if (this.dirty) this.persist(); }
}
