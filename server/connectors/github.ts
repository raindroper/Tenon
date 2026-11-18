import { z } from 'zod';
import { ConnectorProviderError, type ConnectorProvider, type ScanInput } from './types.js';
import { inspectGitHubAccount, normalizeGitHubRepository, type GitHubMCPOptions } from './github-mcp.js';

const accountCursor = z.object({ version: z.literal(3), accountId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: z.string().min(1).max(100), at: z.number().int().nonnegative() });
const legacyCursor = z.object({ repositoryId: z.number().int().positive(), at: z.number().int().nonnegative(),
  numbers: z.array(z.number().int().positive()).nullable(), version: z.literal(2).optional() }).passthrough();
const reconnect = () => new ConnectorProviderError('请在 GitHub 连接表单明确连接账号；旧仓库资料和观察位置仍保留。', 409, { needsAttention: true });

/** Account access uses GitHub's native credential permissions. No background enumeration or model polling. */
export function createGitHubProvider(_env: NodeJS.ProcessEnv = {}, options: GitHubMCPOptions = {}): ConnectorProvider {
  const validateScope = (scope: string) => scope.trim().toLowerCase() === 'account' ? 'account' : normalizeGitHubRepository(scope);
  async function scan({ token, scope: rawScope, cursor, signal }: ScanInput) {
    signal.throwIfAborted(); const scope = validateScope(rawScope);
    if (scope !== 'account') {
      // Retired repository checkpoints remain byte-for-byte export/read data.
      // They never silently become account permission or continue a second scanner.
      try { if (cursor !== undefined) legacyCursor.parse(JSON.parse(cursor)); else throw reconnect(); }
      catch { throw reconnect(); }
      return { cursor: cursor!, changes: [], notice: '旧单仓库观察已保留为历史资料；请在连接表单连接 GitHub 账号。' };
    }
    let previous: z.infer<typeof accountCursor> | undefined;
    if (cursor !== undefined) {
      try { previous = accountCursor.parse(JSON.parse(cursor)); } catch { throw reconnect(); }
    }
    const account = await inspectGitHubAccount(token, signal, options);
    signal.throwIfAborted();
    if (previous && previous.accountId !== account.id) {
      throw new ConnectorProviderError('GitHub 账号身份已变化，请建立独立账号连接；原资料仍保留。', 409, { needsAttention: true });
    }
    return { cursor: JSON.stringify({ version: 3, accountId: account.id, login: account.login,
      at: previous?.at ?? Date.now() }), changes: [] };
  }
  return { tokenGrantUrl: 'https://github.com/settings/tokens', validateScope,
    authorize() { throw new ConnectorProviderError('请从 GitHub 连接表单保存账号访问令牌。', 409); },
    async exchange() { throw new ConnectorProviderError('请从 GitHub 连接表单保存账号访问令牌。', 409); },
    async refresh() { throw new ConnectorProviderError('请从 GitHub 连接表单更新账号访问令牌。', 401, { needsAttention: true }); }, scan };
}
