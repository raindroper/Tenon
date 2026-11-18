import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositories = [
  'openclaw/openclaw', 'NousResearch/hermes-agent', 'HKUDS/nanobot', 'nanocoai/nanoclaw', 'earendil-works/pi',
  'letta-ai/letta-code', 'iOfficeAI/AionUi', 'mastra-ai/mastra', 'langchain-ai/langgraph', 'langchain-ai/langgraphjs',
  'langchain-ai/deepagents', 'mem0ai/mem0', 'getzep/graphiti', 'vectorize-io/hindsight', 'topoteretes/cognee', 'MemTensor/MemOS',
  'plastic-labs/honcho', 'memodb-io/memobase', 'NousResearch/hermes-plugin-honcho',
  'ActivityWatch/activitywatch', 'ActivityWatch/aw-watcher-web', 'screenpipe/screenpipe', 'openrecall/openrecall',
  'n8n-io/n8n', 'activepieces/activepieces', 'ComposioHQ/composio', 'NangoHQ/nango',
  'temporalio/temporal', 'triggerdotdev/trigger.dev', 'OpenHands/OpenHands', 'OpenHands/software-agent-sdk',
  'browserbase/stagehand', 'browser-use/browser-use', 'microsoft/playwright', 'modelcontextprotocol/servers',
  'vercel/ai', 'deepseek-ai/dsh-superagent-prototype',
];
const core = new Set(['openclaw/openclaw', 'NousResearch/hermes-agent', 'letta-ai/letta-code', 'mastra-ai/mastra',
  'langchain-ai/langgraphjs', 'plastic-labs/honcho', 'NangoHQ/nango', 'ActivityWatch/activitywatch',
  'screenpipe/screenpipe', 'OpenHands/software-agent-sdk']);
const results = new Array(repositories.length);
let cursor = 0;
const get = async url => {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Tenon-public-architecture-research' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return { status: response.status };
  return { status: response.status, body: await response.json() };
};
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < repositories.length) {
    const index = cursor++; const requested = repositories[index];
    try {
      const result = await get(`https://api.github.com/repos/${requested}`);
      const repo = result.body;
      if (!repo) { results[index] = { requested, status: result.status, verification: 'metadata unavailable; not inferred' }; continue; }
      let head;
      if (core.has(requested)) {
        const commit = await get(`https://api.github.com/repos/${repo.full_name}/commits?per_page=1`);
        const latest = commit.body?.[0];
        head = latest ? { sha: latest.sha, committedAt: latest.commit?.committer?.date, url: latest.html_url } : { status: commit.status };
      }
      results[index] = { requested, repository: repo.full_name, url: repo.html_url, description: repo.description,
        defaultBranch: repo.default_branch, archived: repo.archived, disabled: repo.disabled, pushedAt: repo.pushed_at,
        licenseIdentifier: repo.license?.spdx_id ?? 'unknown', licenseApiUrl: repo.license?.url, language: repo.language,
        openIssuesIncludingPRs: repo.open_issues_count, head,
        note: 'Metadata and optional HEAD only; availability/activity/license identifiers do not prove production maturity.' };
    } catch (error) { results[index] = { requested, verification: 'request failed; not inferred', errorType: error?.name ?? 'Error' }; }
  }
}));
await mkdir(resolve('research'), { recursive: true });
await writeFile(resolve('research/repository-snapshot.json'), JSON.stringify({ checkedAt: new Date().toISOString(), authentication: 'anonymous public GitHub API', count: repositories.length, results }, null, 2));
console.log(JSON.stringify({ repositories: repositories.length, metadataRetrieved: results.filter(row => row.repository).length, headsPinned: results.filter(row => row.head?.sha).length, unavailable: results.filter(row => !row.repository).map(row => ({ repository: row.requested, status: row.status ?? row.errorType })) }));
