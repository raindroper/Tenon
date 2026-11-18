import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { ConnectorService } from '../server/connectors/service.js';
import { GitHubOperations } from '../server/connectors/github-operations.js';
import type { GitHubMCPTools } from '../server/connectors/github-mcp.js';
import { githubTaskSpecSchema } from '../shared/github.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const input = { owner: 'owner', repo: 'repo', branch: 'change', files: [{ path: 'src/app.ts', content: 'PRIVATE_CODE' }], message: 'PRIVATE_COMMIT_MESSAGE' };
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { const start = performance.now(); while (!check()) { assert(performance.now() - start < 20000); await delay(5); } }
async function fixture(unknown: boolean, entered?: ReturnType<typeof gate>, release?: ReturnType<typeof gate>) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-progress-task-')); const store = new Store(directory); store.getApiKey = () => undefined; let calls = 0;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: async () => ++calls === 1
    ? { content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'github_push_files', input: JSON.stringify(input) }], usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool-calls' } }
    : { content: [{ type: 'text', text: 'The confirmed result is recorded.' }], usage, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } } }) });
  const scene = await runtime.createCase({ title: 'Native progress', objective: 'Record only real operation states', domain: 'fixture' });
  const connectors = (runtime as unknown as { connectors: ConnectorService }).connectors;
  const tools = { push_files: createTool({ id: 'push_files', description: 'Official native fixture', inputSchema: z.record(z.string(), z.unknown()), execute: async () => {
    entered?.resolve(); if (release) await release.promise; if (unknown) throw new Error('PRIVATE_NATIVE_FAILURE'); return { object: { sha: 'c'.repeat(40) } };
  } }) } as GitHubMCPTools;
  const operations = new GitHubOperations({ store, select: (_id, caseId) => ({ kind: 'account', connectionId: 'github-one', caseId: caseId ?? scene.id,
    accountId: 42, login: 'owner', credentialRevision: 1, token: { accessToken: 'PRIVATE_TOKEN' } }), assertActive: () => undefined, assertOwner: () => undefined,
    assertReadSource: () => undefined,
    inspect: async () => ({ id: 7, fullName: 'owner/repo', defaultBranch: 'main' }), run: (_case, _id, work) => work(new AbortController().signal),
    withTools: async (_token, _signal, _access, work) => work(tools) });
  connectors.prepareGitHubTaskScope = async (_case, value) => githubTaskSpecSchema.parse(value); connectors.assertGitHubTaskScope = task => operations.assertTaskScope(task);
  connectors.withGitHubTaskTools = (task, execution, work) => operations.withTaskTools(task, execution, work);
  connectors.verifyGitHubTaskDelivery = task => operations.verifyDelivery(task); connectors.githubTaskReceipts = id => operations.receipts(id);
  await store.updateSettings({ enabled: true, maxStepsPerRun: 5 });
  const task = await runtime.requestTask({ requestId: 'progress-native-task', spec: { caseId: scene.id, title: 'Requested commit', objective: 'Submit the requested change',
    expectedOutput: 'Real commit receipt', capabilities: ['github'], github: githubTaskSpecSchema.parse({ connectionId: 'github-one', repository: 'owner/repo',
      repositoryId: 7, accountId: 42, credentialRevision: 1, operations: ['commit'], branch: 'change' }) } });
  return { store, runtime, task, async close() { await runtime.close(); store.close(); } };
}

test('unknown accepted write is never projected as successful progress', async () => {
  const f = await fixture(true);
  try {
    f.runtime.start(); await until(() => f.runtime.consent.get(f.task.id)?.state === 'failed');
    const run = f.store.list('runs').find(value => value.taskId === f.task.id)!;
    assert.equal(run.progress?.operations.find(operation => operation.label === '处理代码提交')?.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(run.progress), /PRIVATE/);
  } finally { await f.close(); }
});

test('late confirmed native receipt stays successful progress while cancellation still waits for settlement', async () => {
  const entered = gate(); const release = gate(); const f = await fixture(false, entered, release); let cancelled = false;
  try {
    f.runtime.start(); await entered.promise;
    const cancellation = f.runtime.revokeTask(f.task.id, f.runtime.consent.get(f.task.id)!.revision).then(() => { cancelled = true; });
    await delay(10); assert.equal(cancelled, false); release.resolve(); await cancellation;
    const run = f.store.list('runs').find(value => value.taskId === f.task.id)!;
    assert.equal(f.runtime.consent.get(f.task.id)?.state, 'revoked');
    assert.equal(run.progress?.operations.find(operation => operation.label === '处理代码提交')?.status, 'succeeded');
    assert(run.progress?.operations.every(operation => operation.status !== 'running')); assert.doesNotMatch(JSON.stringify(run.progress), /PRIVATE/);
  } finally { release.resolve(); await f.close(); }
});
