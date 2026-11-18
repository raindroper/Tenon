import { asSchema } from 'ai';
import { isValidationError } from '@mastra/core/tools';
import type { GitHubMCPTools } from './github-mcp.js';
import { ConnectorProviderError } from './types.js';

export interface GitHubToolDescription {
  name: string;
  description: string;
  inputSchema: Awaited<ReturnType<typeof asSchema>['jsonSchema']>;
}

/** Describe the discovered official schema, not a separately maintained parameter list. */
export async function describeGitHubTools(tools: GitHubMCPTools, allowedNames: Iterable<string>): Promise<GitHubToolDescription[]> {
  const allowed = new Set(allowedNames);
  try {
    return await Promise.all(Object.entries(tools).filter(([name, tool]) => allowed.has(name) && typeof tool.execute === 'function')
      .map(async ([name, tool]) => ({ name, description: tool.description, inputSchema: await asSchema(tool.inputSchema).jsonSchema })));
  } catch {
    throw new ConnectorProviderError('GitHub 官方工具参数定义暂不可读取，请稍后重新读取工具说明。');
  }
}

export class GitHubToolContractError extends ConnectorProviderError {
  readonly outcomeUnknown: boolean;
  constructor(readonly phase: 'input' | 'output' | 'unknown') {
    super(phase === 'input'
      ? 'GitHub 工具参数未通过官方 inputSchema 校验，尚未发送这次请求。请先调用 list_tools 读取该工具的 inputSchema，再按官方字段名、必填项和类型修正；不要直接使用 REST 参数。'
      : phase === 'output'
        ? 'GitHub 返回值未通过官方 outputSchema 校验，操作结果尚未确认。请核对原操作；写操作不得重复提交。'
        : 'GitHub 工具校验未完成，请先读取官方工具 schema 核对参数；若已提交写操作，先核对原结果，不要重复提交。',
    phase === 'input' ? 400 : 502);
    this.outcomeUnknown = phase !== 'input';
  }
}

/** SDK validation errors are root envelopes, not arbitrary error fields inside repository data. */
export function assertGitHubToolResult(value: unknown): void {
  if (!isValidationError(value) || !value || typeof value !== 'object') return;
  const result = value as { message?: unknown; validationErrors?: unknown };
  if (typeof result.message !== 'string' || !result.validationErrors || typeof result.validationErrors !== 'object' || Array.isArray(result.validationErrors)) return;
  const validation = result.validationErrors as { errors?: unknown; fields?: unknown };
  if (!Array.isArray(validation.errors) || !validation.errors.every(error => typeof error === 'string')
    || !validation.fields || typeof validation.fields !== 'object' || Array.isArray(validation.fields)) return;
  // The SDK message contains the original arguments. Use it only to determine
  // the SDK's validation phase; never expose that message, field text or values.
  const phase = result.message.startsWith('Tool input validation failed') ? 'input'
    : result.message.startsWith('Tool output validation failed') ? 'output' : 'unknown';
  throw new GitHubToolContractError(phase);
}
