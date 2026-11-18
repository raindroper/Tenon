import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { MCPClient, type MCPClientOptions } from '@mastra/mcp';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { ConnectorProviderError, type ConnectorToken } from './types.js';
import { assertGitHubToolResult, GitHubToolContractError } from './github-tool-contract.js';

const endpoint = 'https://api.githubcopilot.com/mcp/';
const timeout = 20_000;
export const githubReadToolNames = ['get_me', 'search_repositories', 'get_file_contents', 'get_commit', 'list_commits', 'list_branches',
  'search_code', 'search_issues', 'search_pull_requests', 'issue_read', 'pull_request_read'] as const;
export const githubWriteToolNames = ['create_branch', 'push_files', 'create_or_update_file', 'issue_write', 'add_issue_comment',
  'create_pull_request', 'update_pull_request'] as const;
const writeNames = new Set<string>(githubWriteToolNames);
export type GitHubMCPTools = Awaited<ReturnType<MCPClient['listTools']>>;
export interface GitHubMCPClient {
  listToolsWithErrors(): Promise<{ tools: GitHubMCPTools; errors: Record<string, string>;
    errorDetails: Record<string, { message: string; httpStatus?: number; code?: string | number }> }>;
  disconnect(): Promise<void>;
}
export interface GitHubMCPOptions {
  clientFactory?: (configuration: MCPClientOptions) => GitHubMCPClient;
  fetch?: typeof fetch;
}
export class GitHubMCPError extends ConnectorProviderError {
  constructor(message: string, status = 502, readonly outcomeUnknown = false, retryAt?: number) {
    super(message, status, { needsAttention: [401, 403, 409].includes(status), ...(retryAt ? { retryAt } : {}) });
  }
}
export function normalizeGitHubRepository(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(normalized)
    || ['.', '..'].includes(normalized.split('/')[1])) throw new GitHubMCPError('请输入 GitHub 仓库名称，格式为 owner/repo。', 400);
  return normalized;
}
function accessToken(token: ConnectorToken): string {
  const value = token.accessToken?.trim();
  if (!value || value.length > 16_384 || !/^[\x21-\x7e]+$/.test(value) || value.startsWith('ghu_') || token.refreshToken) {
    throw new GitHubMCPError('请从 GitHub 连接表单更新个人访问令牌；旧应用授权仍保留为历史记录。', 401);
  }
  if (token.expiresAt !== undefined && token.expiresAt <= Date.now()) throw new GitHubMCPError('GitHub 令牌已过期，请从连接表单更新。', 401);
  return value;
}
function providerError(error: unknown, unknown = false): GitHubMCPError {
  if (error instanceof GitHubMCPError) return error;
  if (unknown) return new GitHubMCPError('GitHub 未返回确定回执，操作结果未知；不会自动重复提交，请先核对仓库或事项。', 409, true);
  let status: number | undefined;
  for (let value = error, depth = 0; depth < 5 && value && typeof value === 'object'; depth++) {
    const item = value as { status?: unknown; statusCode?: unknown; httpStatus?: unknown; message?: unknown; cause?: unknown };
    const candidate = item.status ?? item.statusCode ?? item.httpStatus;
    if (typeof candidate === 'number') status = candidate;
    if (typeof item.message === 'string') {
      const match = /(?:\bHTTP\s*|\bstatus\s*[:=]?\s*|:\s*)(401|403|404|429)\b/i.exec(item.message);
      if (match) status = Number(match[1]);
      if (/bad credentials|requires authentication|token (?:has )?expired/i.test(item.message)) status = 401;
    }
    value = item.cause;
  }
  if (status === 401) return new GitHubMCPError('GitHub 令牌已失效，请从连接表单更新。', 401);
  if (status === 403 || status === 404) return new GitHubMCPError('GitHub 拒绝访问已选仓库，请检查令牌权限、仓库选择及组织批准。', 403);
  if (status === 429) return new GitHubMCPError('GitHub 正在限制请求，请稍后重新同步。', 429);
  return new GitHubMCPError('GitHub 官方连接暂不可用，已保留原连接和同步位置。');
}
/** Standard MCP envelopes and structured output; tool errors never count as success. */
export function gitHubToolResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const result = value as { isError?: unknown; structuredContent?: unknown; content?: unknown };
  if (result.isError === true) throw toolResultError(result, false);
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content)) return value;
  const text = result.content.filter((block): block is { type: 'text'; text: string } =>
    Boolean(block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'))
    .map(block => block.text).join('\n');
  if (!text || Buffer.byteLength(text) > 2 * 1024 * 1024) throw providerError(undefined);
  try { return JSON.parse(text); } catch { throw providerError(undefined); }
}
function toolResultError(result: { content?: unknown }, write: boolean): GitHubMCPError {
  const message = Array.isArray(result.content) ? result.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.slice(0, 4096)).join('\n') : '';
  const classified = providerError({ message });
  // A protocol-level tool error need not mean an upstream write was rejected.
  return write && ![401, 403, 429].includes(classified.status) ? providerError(undefined, true) : classified;
}
/** The official SDK owns protocol/tool schemas. This adapter owns only lifecycle and transport policy. */
export async function withGitHubTools<T>(token: ConnectorToken, signal: AbortSignal, access: 'read' | 'write',
  work: (tools: GitHubMCPTools) => Promise<T>, options: GitHubMCPOptions = {}): Promise<T> {
  signal.throwIfAborted(); const secret = accessToken(token);
  const names = new Set<string>([...githubReadToolNames, ...(access === 'write' ? githubWriteToolNames : [])]);
  const invocation = new AsyncLocalStorage<{ name: string; write: boolean; sent: boolean }>();
  const active = new Set<Promise<unknown>>(); let closed = false;
  let discoveryTransportError: GitHubMCPError | undefined;
  const transportFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== endpoint) throw new GitHubMCPError('GitHub 连接目标不在允许范围内。', 403);
    const current = invocation.getStore();
    let call: { method?: unknown; params?: { name?: unknown } } | undefined;
    const body = init?.body ?? (input instanceof Request && !['GET', 'HEAD'].includes(input.method) ? await input.clone().text() : undefined);
    if (typeof body === 'string') {
      try { call = JSON.parse(body); } catch { throw new GitHubMCPError('GitHub 请求格式无效。', 400); }
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (current && method === 'POST' && (!call || typeof call.method !== 'string')) {
      throw new GitHubMCPError('GitHub 工具请求格式无法核验，未发送。', 400);
    }
    if (call?.method === 'tools/call') {
      const name = call.params?.name;
      if (typeof name !== 'string' || !names.has(name) || !current || current.name !== name) throw new GitHubMCPError('GitHub 工具调用不在当前执行范围内。', 403);
      // Mastra can reconnect and retry tools/call. Never submit the same WRITE
      // invocation twice, including failures after response headers arrived.
      if (current.write && current.sent) throw providerError(undefined, true);
      current.sent = true;
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', `Bearer ${secret}`); headers.set('X-MCP-Tools', [...names].join(','));
    if (access === 'read') headers.set('X-MCP-Readonly', 'true');
    try {
      const response = await (options.fetch ?? fetch)(input, { ...init, headers, redirect: 'error', signal: AbortSignal.any([
        ...(init?.signal ? [init.signal] : []), ...(!current?.write ? [signal] : []), AbortSignal.timeout(timeout),
      ]) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) {
          const retry = response.headers.get('retry-after');
          const seconds = retry === null ? NaN : Number(retry);
          const retryAt = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000
            : retry ? Date.parse(retry) : Number(response.headers.get('x-ratelimit-reset')) * 1000;
          throw new GitHubMCPError('GitHub 正在限制请求，请稍后重新同步。', 429, false, Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : undefined);
        }
        throw providerError({ status: response.status }, Boolean(current?.write && call?.method === 'tools/call'
          && ![400, 401, 403, 404, 422, 429].includes(response.status)));
      }
      return response;
    } catch (error) {
      const mapped = providerError(error, Boolean(current?.write && current.sent && !(error instanceof GitHubMCPError)));
      if (!current) discoveryTransportError = mapped;
      throw mapped;
    }
  };
  const configuration: MCPClientOptions = {
    id: `anotherrae-github-${randomUUID()}`, registerProcessHooks: false, timeout,
    servers: { github: { url: new URL(endpoint), protocolVersion: 'legacy', allowedHosts: ['api.githubcopilot.com'],
      fetch: transportFetch, forwardInstructions: false, enableServerLogs: false, logger: () => undefined,
      capabilities: {}, tasks: false, onToolError: 'return' } },
  };
  const create = options.clientFactory ?? (configuration => { const client = new MCPClient(configuration); client.__setLogger(noopLogger); return client; });
  let client: GitHubMCPClient;
  try { client = create(configuration); } catch (error) { throw providerError(error); }
  let failed = false;
  try {
    let discovered: GitHubMCPTools;
    try {
      const result = await client.listToolsWithErrors(); signal.throwIfAborted();
      if (result.errorDetails.github || result.errors.github) {
        throw discoveryTransportError ?? providerError(result.errorDetails.github ?? { message: result.errors.github });
      }
      discovered = result.tools;
    }
    catch (error) { if (signal.aborted) throw signal.reason; throw providerError(error); }
    const tools: GitHubMCPTools = {};
    for (const [key, tool] of Object.entries(discovered)) {
      const name = key.startsWith('github_') ? key.slice('github_'.length) : key;
      if (!names.has(name) || typeof tool.execute !== 'function') continue;
      const execute = tool.execute;
      const guarded = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as typeof tool;
      guarded.execute = (input, context) => {
        if (closed) return Promise.reject(new GitHubMCPError('GitHub 连接已关闭。', 409));
        signal.throwIfAborted(); const write = writeNames.has(name);
        const run = invocation.run({ name, write, sent: false }, async () => {
          try {
            // Accepted writes drain to a bounded receipt even after owner cancellation.
            const result = await execute(input, { ...context, abortSignal: write ? undefined : signal });
            if (!write) signal.throwIfAborted();
            assertGitHubToolResult(result);
            if (result && typeof result === 'object' && 'isError' in result && result.isError === true) throw toolResultError(result, write);
            return result;
          } catch (error) {
            if (!write && signal.aborted) throw signal.reason;
            if (error instanceof GitHubToolContractError) throw error;
            throw providerError(error, Boolean(write && invocation.getStore()?.sent && !(error instanceof GitHubMCPError)));
          }
        });
        active.add(run); void run.finally(() => active.delete(run)).catch(() => undefined); return run;
      };
      tools[name] = guarded;
    }
    return await work(tools);
  } catch (error) { failed = true; throw error; }
  finally {
    closed = true; while (active.size) await Promise.allSettled([...active]);
    try { await client.disconnect(); } catch (error) { if (!failed) throw providerError(error); }
  }
}

export interface GitHubRepository { id: number; fullName: string; defaultBranch: string }
export interface GitHubAccount { id: number; login: string; name?: string }
const accountResult = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), login: z.string().min(1).max(100),
  name: z.string().max(500).nullish(), details: z.object({ name: z.string().max(500).nullish() }).optional(),
});
/** Identity comes from GitHub's official get_me, never the supplied token's text or a model label. */
export async function inspectGitHubToolsAccount(tools: GitHubMCPTools): Promise<GitHubAccount> {
  if (!tools.get_me?.execute) throw new GitHubMCPError('GitHub 官方账号查询工具暂不可用。', 409);
  const result = accountResult.safeParse(gitHubToolResult(await tools.get_me.execute({}, {})));
  if (!result.success) throw new GitHubMCPError('GitHub 未返回可核对的账号身份，未建立连接。');
  const name = (result.data.name ?? result.data.details?.name)?.trim();
  return { id: result.data.id, login: result.data.login, ...(name ? { name } : {}) };
}
export function inspectGitHubAccount(token: ConnectorToken, signal: AbortSignal, options: GitHubMCPOptions = {}): Promise<GitHubAccount> {
  return withGitHubTools(token, signal, 'read', inspectGitHubToolsAccount, options);
}
const repositoryResult = z.object({ incomplete_results: z.boolean().optional(), items: z.array(z.object({
  id: z.number().int().positive(), full_name: z.string(), default_branch: z.string().min(1),
})).max(10) });
export async function inspectGitHubToolsRepository(tools: GitHubMCPTools, repository: string): Promise<GitHubRepository> {
  const scope = normalizeGitHubRepository(repository);
  if (!tools.search_repositories?.execute) throw new GitHubMCPError('GitHub 官方仓库查询工具暂不可用。', 409);
  const result = repositoryResult.safeParse(gitHubToolResult(await tools.search_repositories.execute({
    query: `repo:${scope}`, perPage: 10, page: 1, minimal_output: false,
  }, {})));
  if (!result.success || result.data.incomplete_results) throw new GitHubMCPError('GitHub 仓库查询不完整，未建立连接。');
  const matches = result.data.items.filter(item => item.full_name.toLowerCase() === scope);
  if (matches.length !== 1) throw new GitHubMCPError('GitHub 令牌无法读取指定仓库，请检查仓库名称、权限及组织批准。', 403);
  return { id: matches[0].id, fullName: matches[0].full_name, defaultBranch: matches[0].default_branch };
}
export function inspectGitHubRepository(token: ConnectorToken, repository: string, signal: AbortSignal, options: GitHubMCPOptions = {}): Promise<GitHubRepository> {
  return withGitHubTools(token, signal, 'read', tools => inspectGitHubToolsRepository(tools, repository), options);
}
