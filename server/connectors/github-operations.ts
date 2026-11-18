import { createHash } from 'node:crypto';
import type { ToolsInput } from '@mastra/core/agent';
import type { createTool } from '@mastra/core/tools';
import PQueue from 'p-queue';
import { githubCanonicalJson, githubTaskSpecCanonicalJson, githubFileSchema, githubRepositorySchema, githubTaskRequestSchema, githubTaskSpecSchema, GITHUB_OPERATIONS_PREFIX,
  type GitHubOperation, type GitHubOperationKind, type GitHubTaskReceipt, type GitHubTaskRequest, type GitHubTaskSpec } from '../../shared/github.js';
import type { TaskRecord } from '../../shared/task-consent.js';
import type { Store } from '../store.js';
import type { ConnectorToken } from './types.js';
import { GitHubMCPError, inspectGitHubRepository, inspectGitHubToolsRepository, withGitHubTools, type GitHubMCPTools } from './github-mcp.js';
import { describeGitHubTools, GitHubToolContractError } from './github-tool-contract.js';

interface GitHubSelectionBase { connectionId: string; caseId: string; credentialRevision: number; token: ConnectorToken }
export type GitHubOperationSelection = GitHubSelectionBase & ({ kind: 'account'; accountId: number; login: string }
  | { kind?: 'repository'; repository: string; repositoryId: number; access: 'read' | 'write' });
export interface GitHubOperationsOptions {
  store: Store;
  select(connectionId: string, caseId?: string): GitHubOperationSelection;
  run<T>(caseId: string, connectionId: string, work: (signal: AbortSignal) => Promise<T>, timeoutMs?: number | null): Promise<T>;
  assertOwner(caseId: string, eventId: string): void;
  assertReadSource(caseId: string, eventId: string): void;
  assertActive(): void;
  withTools?: typeof withGitHubTools;
  inspect?: typeof inspectGitHubRepository;
}
const hash = (value: unknown) => createHash('sha256').update(githubCanonicalJson(value)).digest('hex');
const specHash = (value: GitHubTaskSpec) => createHash('sha256').update(githubTaskSpecCanonicalJson(value)).digest('hex');
const now = () => new Date().toISOString();
export class GitHubOutcomeUnknownError extends Error {
  constructor() { super('GitHub 操作结果未知，请核对远端；不会自动重发。'); this.name = 'GitHubOutcomeUnknownError'; }
}
const READ_TOOLS = new Set(['get_file_contents', 'list_branches', 'list_commits', 'get_commit', 'issue_read', 'pull_request_read']);
const ACCOUNT_READ_TOOLS = new Set([...READ_TOOLS, 'get_me', 'search_repositories', 'search_code', 'search_issues', 'search_pull_requests']);
const WRITE_TOOLS = new Set(['create_branch', 'push_files', 'create_or_update_file', 'issue_write', 'add_issue_comment', 'create_pull_request', 'update_pull_request']);
const inputObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub 工具参数须为对象。');
  return value as Record<string, unknown>;
};
const allowedKeys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some(key => value[key] !== undefined && !allowed.includes(key))) throw new Error('GitHub 参数超出本次许可字段。');
};
function repository(input: Record<string, unknown>, scope: Pick<GitHubTaskSpec, 'repository'>) {
  if (typeof input.owner !== 'string' || typeof input.repo !== 'string'
    || `${input.owner}/${input.repo}`.toLowerCase() !== scope.repository) throw new Error('GitHub 工具目标不属于本次批准仓库。');
}
function requestedRepository(input: Record<string, unknown>): string {
  if (typeof input.owner !== 'string' || typeof input.repo !== 'string') throw new Error('须指定真实owner/repo。');
  return githubRepositorySchema.parse(`${input.owner}/${input.repo}`);
}
function sameSelection(left: GitHubOperationSelection, right: GitHubOperationSelection): boolean {
  return left.connectionId === right.connectionId && left.caseId === right.caseId && left.credentialRevision === right.credentialRevision
    && (left.kind === 'account' ? right.kind === 'account' && left.accountId === right.accountId
      : right.kind !== 'account' && left.repositoryId === right.repositoryId && left.repository === right.repository && left.access === right.access);
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('GitHub 编号无效。');
  return Number(value);
}
function readScope(name: string, input: Record<string, unknown>, scope: Pick<GitHubTaskSpec, 'repository' | 'branch' | 'baseBranch'>) {
  if (!READ_TOOLS.has(name)) throw new Error('此工具不是允许的仓库只读工具。');
  repository(input, scope);
  if (name === 'get_file_contents') {
    const path = input.path;
    if (path !== '' && path !== '/') githubFileSchema.parse(path);
    if (input.ref !== undefined && scope.branch && ![scope.branch, scope.baseBranch, `refs/heads/${scope.branch}`,
      scope.baseBranch ? `refs/heads/${scope.baseBranch}` : undefined].includes(String(input.ref))) throw new Error('GitHub 读取分支不在本次任务范围。');
  }
}
export function assertGitHubToolScope(name: string, input: unknown, spec: GitHubTaskSpec): {
  operation: GitHubOperationKind | 'branch'; paths?: string[]; targetNumber?: number; fields?: string[];
} {
  const value = inputObject(input); repository(value, spec);
  const requireOperation = (operation: GitHubOperationKind) => {
    if (!spec.operations.includes(operation)) throw new Error('GitHub 动作不在本次任务许可内。');
    return operation;
  };
  if (name === 'create_branch') {
    requireOperation('commit'); allowedKeys(value, ['owner', 'repo', 'branch', 'from_branch']);
    if (value.branch !== spec.branch || !spec.baseBranch || value.from_branch !== spec.baseBranch) throw new Error('创建分支必须匹配批准的来源和目标分支。');
    return { operation: 'branch' };
  }
  if (name === 'push_files' || name === 'create_or_update_file') {
    requireOperation('commit');
    if (value.branch !== spec.branch) throw new Error('提交分支与本次许可不一致。');
    let paths: string[];
    if (name === 'push_files') {
      allowedKeys(value, ['owner', 'repo', 'branch', 'files', 'message']);
      if (!Array.isArray(value.files) || !value.files.length) throw new Error('提交须包含任务批准的文件。');
      paths = value.files.map(file => { const record = inputObject(file); allowedKeys(record, ['path', 'content']);
        if (typeof record.content !== 'string') throw new Error('文件正文须为原始文本。');
        return githubFileSchema.parse(record.path); });
    } else {
      allowedKeys(value, ['owner', 'repo', 'branch', 'path', 'content', 'message', 'sha']);
      if (typeof value.content !== 'string') throw new Error('文件正文须为原始文本。');
      paths = [githubFileSchema.parse(value.path)];
    }
    const branchScope = spec.accountId !== undefined && spec.files.length === 0;
    if (new Set(paths).size !== paths.length || !branchScope && paths.some(path => !spec.files.includes(path))) throw new Error('提交文件超出本次精确文件许可。');
    return { operation: 'commit', paths };
  }
  if (name === 'issue_write') {
    const create = value.method === 'create';
    if (!create && value.method !== 'update') throw new Error('Issue 动作无效。');
    const operation = requireOperation(create ? 'issue-create' : 'issue-update');
    const fields = Object.keys(value).filter(key => !['owner', 'repo', 'method', 'issue_number'].includes(key) && value[key] !== undefined);
    allowedKeys(value, ['owner', 'repo', 'method', 'issue_number', ...(create ? ['title', 'body'] : spec.issueFields)]);
    if (!fields.length || create && value.issue_number !== undefined) throw new Error('Issue 范围无效。');
    const target = create ? undefined : number(value.issue_number);
    if (target !== undefined && !spec.issueNumbers.includes(target)) throw new Error('Issue 编号不在本次任务范围。');
    return { operation, fields, ...(target ? { targetNumber: target } : {}) };
  }
  if (name === 'add_issue_comment') {
    requireOperation('comment'); allowedKeys(value, ['owner', 'repo', 'issue_number', 'body']);
    const target = number(value.issue_number);
    if (![...spec.issueNumbers, ...spec.pullRequestNumbers].includes(target)) throw new Error('评论编号不在本次任务范围。');
    return { operation: 'comment', targetNumber: target };
  }
  if (name === 'create_pull_request') {
    requireOperation('pull-request-create'); allowedKeys(value, ['owner', 'repo', 'title', 'body', 'head', 'base', 'draft']);
    if (value.head !== spec.branch || value.base !== spec.baseBranch
      || (spec.draft !== undefined ? value.draft !== spec.draft : spec.accountId === undefined && value.draft !== true)) throw new Error('创建 PR 须匹配批准的分支和任务指定状态。');
    return { operation: 'pull-request-create' };
  }
  if (name === 'update_pull_request') {
    requireOperation('pull-request-update');
    allowedKeys(value, ['owner', 'repo', 'pullNumber', ...spec.pullRequestFields]);
    const target = number(value.pullNumber);
    if (!spec.pullRequestNumbers.includes(target)) throw new Error('PR 编号不在本次任务范围。');
    const fields = Object.keys(value).filter(key => !['owner', 'repo', 'pullNumber'].includes(key) && value[key] !== undefined);
    if (!fields.length) throw new Error('PR 修改须包含批准字段。');
    return { operation: 'pull-request-update', targetNumber: target, fields };
  }
  throw new Error('此 GitHub 写入工具未获允许。');
}

function unpackResult(value: unknown): Record<string, unknown> {
  const result = inputObject(value);
  if (result.isError) throw new Error('GitHub 未返回可确认的成功回执。');
  if (result.structuredContent) return inputObject(result.structuredContent);
  if (Array.isArray(result.content)) {
    const text = result.content.filter(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text')
      .map(part => String((part as { text?: unknown }).text ?? '')).join('\n');
    try { return inputObject(JSON.parse(text)); } catch { throw new Error('GitHub 回执无法核验；不会自动重发。'); }
  }
  return result;
}
function confirmedReceipt(tool: string, input: Record<string, unknown>, result: unknown, spec: GitHubTaskSpec): NonNullable<GitHubOperation['receipt']> {
  const body = unpackResult(result);
  const commit = body.commit && typeof body.commit === 'object' ? body.commit as Record<string, unknown> : body.object && typeof body.object === 'object'
    ? body.object as Record<string, unknown> : body;
  const sha = typeof commit.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(commit.sha) ? commit.sha : undefined;
  const rawUrl = typeof body.html_url === 'string' ? body.html_url : typeof body.url === 'string' ? body.url : undefined;
  let url: string | undefined; let targetNumber: number | undefined;
  if (rawUrl) {
    const parsed = new URL(rawUrl); const [owner, repo] = spec.repository.split('/');
    if (parsed.username || parsed.password || parsed.protocol !== 'https:') throw new Error('GitHub 回执地址不合法。');
    const prefix = parsed.hostname === 'github.com' ? `/${owner}/${repo}/` : parsed.hostname === 'api.github.com' ? `/repos/${owner}/${repo}/` : undefined;
    if (!prefix || !parsed.pathname.toLowerCase().startsWith(prefix)) throw new Error('GitHub 回执不属于批准仓库。');
    url = parsed.href;
    const match = /\/(?:issues|pull|pulls)\/(\d+)(?:\/|$)/.exec(parsed.pathname);
    if (match) targetNumber = number(Number(match[1]));
  }
  if (Number.isSafeInteger(body.number) && Number(body.number) > 0) targetNumber = number(body.number);
  const code = ['push_files', 'create_or_update_file', 'create_branch'].includes(tool);
  if (code ? !sha : !url || !targetNumber) throw new Error('GitHub 没有返回本次操作的真实提交或事项回执。');
  const requested = input.issue_number ?? input.pullNumber;
  if (requested !== undefined && targetNumber !== Number(requested)) throw new Error('GitHub 回执编号不匹配。');
  return { ...(url ? { url } : {}), ...(sha ? { sha } : {}), ...(targetNumber ? { number: targetNumber } : {}), result };
}

/** Application authorization/journal only. All GitHub actions and schemas come from the official MCP server. */
export class GitHubOperations {
  private readonly active = new Map<string, Promise<unknown>>();
  private readonly activeIds = new Set<string>();
  private readonly writeQueues = new Map<string, PQueue>();
  constructor(private readonly options: GitHubOperationsOptions) {}
  private get tools() { return this.options.withTools ?? withGitHubTools; }
  private get inspect() { return this.options.inspect ?? inspectGitHubRepository; }
  private inspectCurrent(tools: GitHubMCPTools, token: ConnectorToken, repository: string, signal: AbortSignal) {
    return this.options.inspect ? this.options.inspect(token, repository, signal) : inspectGitHubToolsRepository(tools, repository);
  }
  private records(taskId: string): GitHubOperation[] { return this.options.store.getMeta(GITHUB_OPERATIONS_PREFIX + taskId, []); }
  private save(value: GitHubOperation): void {
    this.options.assertActive(); const records = this.records(value.taskId); const index = records.findIndex(row => row.id === value.id);
    if (index >= 0) records[index] = value; else records.push(value);
    this.options.store.setMeta(GITHUB_OPERATIONS_PREFIX + value.taskId, records);
  }
  receipts(taskId: string): GitHubTaskReceipt[] {
    for (const value of this.records(taskId)) if (value.state === 'submitting' && !this.activeIds.has(value.id)) {
      this.save({ ...value, state: 'unknown', updatedAt: now(), error: '上次 GitHub 提交中断，结果未知；不会自动重发。' });
    }
    return this.records(taskId).map(value => ({ operationId: value.id, tool: value.tool, state: value.state,
    updatedAt: value.updatedAt, ...(value.error ? { error: value.error } : {}), ...(value.receipt?.url ? { url: value.receipt.url } : {}),
    ...(value.receipt?.sha ? { sha: value.receipt.sha } : {}), ...(value.receipt?.number ? { number: value.receipt.number } : {}) })); }
  async prepareScope(caseId: string, input: GitHubTaskRequest, ownerEventId?: string): Promise<GitHubTaskSpec> {
    this.options.assertActive(); if (ownerEventId) this.options.assertOwner(caseId, ownerEventId);
    const { repositoryId: _repositoryId, credentialRevision: _credentialRevision, accountId: _accountId, ...details } = input as GitHubTaskSpec;
    const request = githubTaskRequestSchema.parse(details); const selected = this.options.select(request.connectionId, caseId);
    if (selected.kind !== 'account' && (selected.access !== 'write' || selected.repository !== request.repository)) {
      throw new Error('旧仓库连接不能扩大到其他仓库或写入范围，请本人更新为GitHub账号连接。');
    }
    if (selected.kind !== 'account' && request.operations.includes('commit') && !request.files.length) {
      throw new Error('旧仓库任务须保留明确文件范围，不能扩大为整个分支。');
    }
    return this.options.run(caseId, request.connectionId, async signal => {
      const repo = await this.inspect(selected.token, request.repository, signal);
      this.options.assertActive(); if (ownerEventId) this.options.assertOwner(caseId, ownerEventId);
      const current = this.options.select(request.connectionId, caseId);
      if (!sameSelection(selected, current) || selected.kind !== 'account' && repo.id !== selected.repositoryId) throw new Error('GitHub账号或凭据范围已变化。');
      return githubTaskSpecSchema.parse({ ...request, repositoryId: repo.id, credentialRevision: selected.credentialRevision,
        ...(selected.kind === 'account' ? { accountId: selected.accountId } : {}) });
    });
  }
  assertTaskScope(task: TaskRecord): GitHubOperationSelection {
    this.options.assertActive(); const spec = githubTaskSpecSchema.parse(task.spec.github);
    if (!task.spec.capabilities.includes('github')) throw new Error('本任务没有 GitHub 操作许可。');
    const selected = this.options.select(spec.connectionId, task.spec.caseId);
    if (selected.credentialRevision !== spec.credentialRevision || (selected.kind === 'account' ? selected.accountId !== spec.accountId
      : selected.access !== 'write' || selected.repository !== spec.repository || selected.repositoryId !== spec.repositoryId || spec.accountId !== undefined)) {
      throw new Error('GitHub账号、仓库授权或凭据版本已变化。');
    }
    return selected;
  }
  async read(caseId: string, sourceEventId: string, input: { connectionId: string; tool: string; input: Record<string, unknown> }, signal: AbortSignal, guard: () => void) {
    guard(); this.options.assertReadSource(caseId, sourceEventId); const selected = this.options.select(input.connectionId, caseId);
    return this.options.run(caseId, input.connectionId, operationSignal => this.tools(selected.token, AbortSignal.any([signal, operationSignal]), 'read', async tools => {
      guard(); this.options.assertReadSource(caseId, sourceEventId); const current = this.options.select(input.connectionId, caseId);
      if (!sameSelection(current, selected)) throw new Error('GitHub连接已变化。');
      const allowedTools = selected.kind === 'account' ? ACCOUNT_READ_TOOLS : READ_TOOLS;
      if (input.tool === 'list_tools') return { result: { tools: await describeGitHubTools(tools, allowedTools) } };
      if (!allowedTools.has(input.tool)) throw new Error('此工具不是允许的GitHub只读工具。');
      const scope = READ_TOOLS.has(input.tool) ? requestedRepository(input.input) : undefined;
      if (scope) readScope(input.tool, input.input, { repository: selected.kind === 'account' ? scope : selected.repository });
      const repo = scope ? await this.inspectCurrent(tools, selected.token, scope, operationSignal) : undefined;
      if (selected.kind !== 'account' && repo?.id !== selected.repositoryId) throw new Error('仓库名称对应的实际仓库已改变，未读取。');
      guard(); this.options.assertReadSource(caseId, sourceEventId);
      const tool = tools[input.tool]; if (!tool?.execute) throw new Error('官方 GitHub 只读工具暂不可用。');
      const result = await tool.execute(input.input, { abortSignal: signal } as never);
      const afterRepository = scope ? await this.inspectCurrent(tools, selected.token, scope, operationSignal) : undefined;
      if (repo?.id !== afterRepository?.id) throw new Error('查询期间仓库身份已变化，结果未交给模型。');
      guard(); this.options.assertReadSource(caseId, sourceEventId); const after = this.options.select(input.connectionId, caseId);
      if (!sameSelection(after, selected)) throw new Error('查询期间GitHub连接已变化，结果未交给模型。');
      return { ...(repo ? { repositoryId: repo.id } : {}), result };
    }));
  }
  async withTaskTools<T>(task: TaskRecord, input: { signal: AbortSignal; guard(): void }, work: (tools: ToolsInput) => Promise<T>): Promise<T> {
    const selected = this.assertTaskScope(task); input.guard(); const spec = githubTaskSpecSchema.parse(task.spec.github);
    return this.options.run(task.spec.caseId, spec.connectionId, operationSignal => this.tools(selected.token, AbortSignal.any([input.signal, operationSignal]), 'write', async tools => {
      const scoped: ToolsInput = {};
      const pendingTools = new Set<Promise<unknown>>();
      const writeQueue = this.writeQueues.get(task.id) ?? new PQueue({ concurrency: 1 }); this.writeQueues.set(task.id, writeQueue);
      for (const [name, tool] of Object.entries(tools)) {
        if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) continue;
        const execute = tool.execute; if (!execute) continue;
        const dispatch = async (value: unknown, context: Parameters<NonNullable<typeof execute>>[1]) => {
          input.signal.throwIfAborted(); input.guard(); this.assertTaskScope(task); const args = inputObject(value);
          if (READ_TOOLS.has(name)) {
            readScope(name, args, spec); const repository = await this.inspectCurrent(tools, selected.token, spec.repository, operationSignal);
            if (repository.id !== spec.repositoryId) throw new Error('仓库名称对应的实际仓库已改变，未读取。');
            input.guard(); this.assertTaskScope(task); const result = await execute(value, context);
            const after = await this.inspectCurrent(tools, selected.token, spec.repository, operationSignal);
            if (after.id !== spec.repositoryId) throw new Error('查询期间仓库身份已变化，结果未交给模型。');
            input.guard(); this.assertTaskScope(task); return result;
          }
          const target = assertGitHubToolScope(name, args, spec);
          const records = this.records(task.id);
          if (records.some(record => record.state === 'unknown' || record.state === 'submitting')) throw new Error('原 GitHub 操作结果未知，已停止；不会自动重发。');
          if (records.some(record => record.requirementsRevision !== (task.requirementsRevision ?? 1) && record.state === 'submitted')) {
            throw new Error('旧要求下的GitHub操作已受理，回执保留；不能为补充要求自动再次提交，请登记新的精确任务。');
          }
          const scopeHash = specHash(spec); const inputHash = hash(args); const id = hash([task.id, task.requirementsRevision ?? 1, name, inputHash]);
          const previous = records.find(record => record.id === id);
          if (previous) {
            if (previous.state !== 'submitted' || !previous.receipt) throw new Error('原 GitHub 操作未成功，不能自动重发。');
            return previous.receipt.result;
          }
          const createLimit = target.operation === 'issue-create' ? spec.createIssueCount ?? 1 : spec.createPullRequestCount ?? 1;
          if (['issue-create', 'pull-request-create'].includes(target.operation)
            && records.filter(record => record.operation === target.operation && ['submitted', 'submitting', 'unknown'].includes(record.state)).length >= createLimit) {
            throw new Error('本任务批准的GitHub创建数量已用完，不能通过改变标题或正文重复创建。');
          }
          if (target.operation === 'comment' && records.some(record => record.operation === 'comment' && record.targetNumber === target.targetNumber
            && ['submitted', 'submitting', 'unknown'].includes(record.state))) throw new Error('本任务已为这个事项添加评论，不能自动重复评论。');
          const currentRepo = await this.inspectCurrent(tools, selected.token, spec.repository, operationSignal);
          input.signal.throwIfAborted(); input.guard(); this.assertTaskScope(task);
          if (currentRepo.id !== spec.repositoryId) throw new Error('仓库名称对应的实际仓库已改变，未执行。');
          const startedAt = now(); const operation: GitHubOperation = { id, taskId: task.id, caseId: task.spec.caseId, approvalRevision: task.approvalRevision!,
            requirementsRevision: task.requirementsRevision ?? 1, specHash: scopeHash, inputHash, tool: name, ...target, connectionId: spec.connectionId,
            credentialRevision: spec.credentialRevision, state: 'submitting', createdAt: startedAt, updatedAt: startedAt };
          this.activeIds.add(id);
          try { this.save(operation); } catch (error) { this.activeIds.delete(id); throw error; }
          const pending = (async () => {
            try {
              const result = await execute(value, context);
              const receipt = confirmedReceipt(name, args, result, spec);
              // Accepted remote facts survive later cancellation or credential revocation.
              this.save({ ...operation, state: 'submitted', receipt, updatedAt: now() });
              input.signal.throwIfAborted(); input.guard(); this.assertTaskScope(task); return result;
            } catch (error) {
              const current = this.records(task.id).find(record => record.id === id);
              const rejected = (error instanceof GitHubMCPError || error instanceof GitHubToolContractError)
                && !error.outcomeUnknown && [400, 401, 403, 404, 409, 410, 422, 429].includes(error.status);
              if (current?.state !== 'submitted') this.save({ ...operation, state: rejected ? 'failed' : 'unknown', updatedAt: now(),
                error: rejected ? 'GitHub明确拒绝了本次操作，没有成功提交；请检查账号权限与请求后重新明确委托。' : 'GitHub 操作结果未知，请核对远端；不会自动重发。' });
              if (rejected) throw new Error('GitHub明确拒绝了本次操作，没有成功提交。');
              throw error instanceof Error && this.records(task.id).find(record => record.id === id)?.state === 'submitted'
                ? error : new Error('GitHub 操作结果未知，请核对远端；不会自动重发。');
            }
          })().finally(() => { this.active.delete(id); this.activeIds.delete(id); });
          this.active.set(id, pending); return pending;
        };
        scoped[`github_${name}`] = { ...tool, id: `github_${name}`, execute: (value, context) => {
          // Abort queued work at dispatch, never race a running write promise: accepted work must drain.
          const pending = (READ_TOOLS.has(name) ? dispatch(value, context) : writeQueue.add(() => dispatch(value, context)))
            .finally(() => pendingTools.delete(pending));
          pendingTools.add(pending); return pending;
        } } as ReturnType<typeof createTool>;
      }
      try { return await work(scoped); }
      finally {
        while (pendingTools.size) await Promise.allSettled([...pendingTools]);
        await writeQueue.onIdle(); if (this.writeQueues.get(task.id) === writeQueue) this.writeQueues.delete(task.id);
      }
    }), null);
  }
  verifyDelivery(task: TaskRecord): void {
    const spec = githubTaskSpecSchema.parse(task.spec.github); const scopeHash = specHash(spec);
    const operations = this.records(task.id).filter(record => record.approvalRevision === task.approvalRevision && record.specHash === scopeHash);
    if (operations.some(record => ['unknown', 'submitting'].includes(record.state))) throw new GitHubOutcomeUnknownError();
    const submitted = operations.filter(record => record.state === 'submitted' && record.receipt && record.requirementsRevision === (task.requirementsRevision ?? 1));
    for (const expected of spec.operations) {
      const matching = submitted.filter(record => record.operation === expected);
      if (!matching.length) throw new Error('没有本任务所需 GitHub 动作的真实成功回执。');
      const createCount = expected === 'issue-create' ? spec.createIssueCount ?? 1 : expected === 'pull-request-create' ? spec.createPullRequestCount ?? 1 : undefined;
      if (createCount && new Set(matching.map(record => record.receipt?.number)).size < createCount) throw new Error('尚未取得本人指定数量的GitHub创建回执。');
      if (expected === 'commit' && spec.files.some(file => !matching.some(record => record.paths?.includes(file)))) throw new Error('批准文件尚未全部取得真实提交回执。');
      const targets = expected === 'issue-update' ? spec.issueNumbers : expected === 'pull-request-update' ? spec.pullRequestNumbers
        : expected === 'comment' ? [...spec.issueNumbers, ...spec.pullRequestNumbers] : [];
      if (targets.some(target => !matching.some(record => record.targetNumber === target))) throw new Error('批准事项尚未全部取得真实修改回执。');
    }
  }
}
