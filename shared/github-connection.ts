import { z } from 'zod';

const token = z.string().trim().min(20).max(4096)
  .regex(/^(?:github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+)$/, '请输入你自己的 GitHub 个人访问令牌。');
const confirmation = {
  accessAllRepositories: z.literal(true),
  persistCredentials: z.literal(true),
};
export const githubConnectInputSchema = z.object({
  caseId: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  token,
  ...confirmation,
}).strict();
export const githubUpgradeInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  accessAllRepositories: z.literal(true),
}).strict();
export const githubUpdateInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  token,
  ...confirmation,
}).strict();
export type GitHubConnectInput = z.infer<typeof githubConnectInputSchema>;
export type GitHubUpdateInput = z.infer<typeof githubUpdateInputSchema>;
export type GitHubUpgradeInput = z.infer<typeof githubUpgradeInputSchema>;
