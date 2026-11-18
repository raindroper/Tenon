import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { createTool } from '@mastra/core/tools';
import type { ConnectorConnection } from '../shared/connectors.js';
import { createConnectedGitHubTools } from '../server/v2/connected-github.js';

const account = (): ConnectorConnection => ({ id: 'github-account', kind: 'github', caseId: 'original-scene', scope: 'owner',
  connectedAt: new Date().toISOString(), lastSyncedAt: null, status: 'watching',
  github: { kind: 'account', accountId: 42, login: 'owner', credentialRevision: 1, grantEventId: 'owner-account-grant' } });
function fixture(initial = [account()]) {
  let connections = initial; let reads = 0; const inputs: unknown[] = [];
  const access = { list: () => ({ providers: [], connections, tencentDocsCredentials: [] }),
    readGitHubTool: async (caseId: string, ownerEventId: string, input: unknown) => {
      assert.equal(ownerEventId, 'current-owner-event'); reads++; inputs.push(input);
      return { connectionId: 'github-account', accountId: 42, credentialRevision: 1, evidenceId: `evidence-${reads}`, result: { caseId, input } };
    } } as Parameters<typeof createConnectedGitHubTools>[0];
  const result = createConnectedGitHubTools(access, 'another-active-scene', 'current-owner-event', new AbortController().signal, () => undefined);
  return { result, reads: () => reads, inputs, set: (next: ConnectorConnection[]) => { connections = next; } };
}
const execute = (tool: unknown, input: unknown) => (tool as ReturnType<typeof createTool>).execute!(input, {});

test('an account connection is available across owner scenes and emits account provenance without a fictitious repository', async () => {
  const f = fixture(); assert(f.result);
  const listed = await execute(f.result.tools.list_github_connections, {}) as { githubSources: unknown[]; connections: unknown[] };
  assert.deepEqual(listed.githubSources, [{ version: 2, caseId: 'another-active-scene', connectionId: 'github-account', accountId: 42, credentialRevision: 1 }]);
  assert.equal((listed.connections[0] as { repository?: unknown }).repository, undefined);
  const query = { connectionId: 'github-account', tool: 'search_code', input: { query: 'language:TypeScript TODO', page: 1 } };
  const response = await execute(f.result.tools.read_github_repository, query) as { githubSource: unknown; evidenceId: string; result: unknown };
  assert.deepEqual(response.githubSource, listed.githubSources[0]); assert.equal(response.evidenceId, 'evidence-1');
  assert.deepEqual((f.inputs[0] as typeof query).input, query.input);
});

test('account discovery has no artificial eight-call quota and repeated queries reuse their result', async () => {
  const f = fixture(); assert(f.result);
  for (let page = 1; page <= 12; page++) await execute(f.result.tools.read_github_repository,
    { connectionId: 'github-account', tool: 'search_repositories', input: { query: 'language:TypeScript', page } });
  assert.equal(f.reads(), 12);
  await execute(f.result.tools.read_github_repository, { connectionId: 'github-account', tool: 'search_repositories', input: { page: 12, query: 'language:TypeScript' } });
  assert.equal(f.reads(), 12);
});

test('removing or replacing an account invalidates the current owner tool snapshot', async () => {
  for (const change of ['removed', 'revision', 'account'] as const) {
    const f = fixture(); assert(f.result); const changed = account();
    if (changed.github?.kind === 'account') changed.github = { ...changed.github,
      ...(change === 'revision' ? { credentialRevision: 2 } : change === 'account' ? { accountId: 99 } : {}) };
    f.set(change === 'removed' ? [] : [changed]);
    await assert.rejects(execute(f.result.tools.read_github_repository, { connectionId: 'github-account', tool: 'get_me', input: {} }), /撤销或替换/);
    assert.equal(f.reads(), 0);
  }
});

test('legacy repository grants remain unavailable to another scene instead of silently becoming account-wide', () => {
  const previous = account(); previous.scope = 'owner/repo';
  previous.github = { repositoryId: 7, credentialRevision: 1, access: 'read', defaultBranch: 'main' };
  assert.equal(fixture([previous]).result, undefined);
});
