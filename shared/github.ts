import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const githubRepositorySchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/)
  .refine(value => !['.', '..'].includes(value.split('/')[1]!));
export const githubBranchSchema = z.string().trim().min(1).max(200).refine(value =>
  !value.startsWith('/') && !value.startsWith('refs/') && !value.endsWith('/') && !value.endsWith('.')
  && !value.includes('..') && !value.includes('@{') && !/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value)
  && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')), '须使用一个精确 Git 分支名。');
export const githubFileSchema = z.string().min(1).max(2000).refine(value => !value.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(value)
  && value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'), '须指定精确仓库相对文件路径。');
const unique = <T>(items: T[]) => new Set(items).size === items.length;
export const githubOperationSchema = z.enum(['commit', 'issue-create', 'issue-update', 'comment', 'pull-request-create', 'pull-request-update']);
export type GitHubOperationKind = z.infer<typeof githubOperationSchema>;
/** Object key order cannot create a second logical submission. Array order remains explicit. */
export function githubCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
}

/** Requested targets only. Admission supplies the connection's immutable identity snapshot. */
export const githubTaskRequestSchema = z.object({
  connectionId: identifier,
  repository: githubRepositorySchema,
  operations: z.array(githubOperationSchema).min(1).max(6).refine(unique, '操作不能重复。'),
  branch: githubBranchSchema.optional(), baseBranch: githubBranchSchema.optional(),
  files: z.array(githubFileSchema).refine(unique, '文件路径不能重复。').default([]),
  issueNumbers: z.array(z.number().int().positive()).refine(unique).default([]),
  pullRequestNumbers: z.array(z.number().int().positive()).refine(unique).default([]),
  draft: z.boolean().optional(),
  createIssueCount: z.number().int().positive().optional(),
  createPullRequestCount: z.number().int().positive().optional(),
  issueFields: z.array(z.enum(['title', 'body', 'state', 'labels', 'assignees'])).max(5).refine(unique).default([]),
  pullRequestFields: z.array(z.enum(['title', 'body', 'state'])).max(3).refine(unique).default([]),
}).strict().refine(value => !value.operations.includes('commit') || Boolean(value.branch), '提交代码须指定本次任务分支。')
  .refine(value => !value.operations.includes('pull-request-create') || Boolean(value.branch && value.baseBranch && value.branch !== value.baseBranch), '创建 PR 须指定不同的来源和目标分支。')
  .refine(value => !value.operations.includes('issue-update') || Boolean(value.issueNumbers.length && value.issueFields.length), '修改 Issue 须指定编号与字段。')
  .refine(value => !value.operations.includes('pull-request-update') || Boolean(value.pullRequestNumbers.length && value.pullRequestFields.length), '修改 PR 须指定编号与字段。')
  .refine(value => !value.operations.includes('comment') || Boolean(value.issueNumbers.length || value.pullRequestNumbers.length), '评论须绑定 Issue 或 PR 编号。');
export const githubTaskSpecSchema = githubTaskRequestSchema.safeExtend({
  repositoryId: z.number().int().positive(), credentialRevision: z.number().int().positive(),
  accountId: z.number().int().positive().optional(),
}).refine(value => !value.operations.includes('commit') || value.accountId !== undefined || value.files.length > 0,
  '旧仓库任务仍须保留原来的精确文件范围，不能扩大为整个分支。');
export type GitHubTaskRequest = z.infer<typeof githubTaskRequestSchema>;
export type GitHubTaskSpec = z.infer<typeof githubTaskSpecSchema>;
/** Defaults do not change the identity of a previously authorized scope or its real receipts. */
export function githubTaskSpecCanonicalJson(input: GitHubTaskSpec): string {
  const spec = { ...githubTaskSpecSchema.parse(input) };
  if (spec.createIssueCount === 1) delete spec.createIssueCount;
  if (spec.createPullRequestCount === 1) delete spec.createPullRequestCount;
  return githubCanonicalJson(spec);
}
export interface GitHubRepositoryConnectionDetails {
  kind?: 'repository';
  repositoryId: number; credentialRevision: number; access: 'read' | 'write'; defaultBranch?: string;
}
export interface GitHubAccountConnectionDetails { kind: 'account'; accountId: number; login: string; credentialRevision: number; grantEventId?: string }
export type GitHubConnectionDetails = GitHubRepositoryConnectionDetails | GitHubAccountConnectionDetails;
export type GitHubOperationState = 'submitting' | 'submitted' | 'failed' | 'unknown';
/** Durable submission journal; never inferred from model text or prepared arguments. */
export interface GitHubOperation {
  id: string; taskId: string; caseId: string; approvalRevision: number; requirementsRevision: number;
  specHash: string; inputHash: string; tool: string; operation: GitHubOperationKind | 'branch';
  connectionId: string; credentialRevision: number; state: GitHubOperationState;
  createdAt: string; updatedAt: string; error?: string;
  paths?: string[]; targetNumber?: number; fields?: string[];
  receipt?: { url?: string; sha?: string; number?: number; result: unknown };
}
export interface GitHubTaskReceipt {
  operationId: string; tool: string; state: GitHubOperationState; updatedAt: string;
  url?: string; sha?: string; number?: number; error?: string;
}
export const GITHUB_OPERATIONS_PREFIX = 'connectors.github.operations.';
