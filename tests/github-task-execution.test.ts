import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { ConnectorService } from '../server/connectors/service.js';
import { GitHubOperations } from '../server/connectors/github-operations.js';
import type { GitHubMCPTools } from '../server/connectors/github-mcp.js';
import { githubTaskSpecSchema } from '../shared/github.js';
import { taskOutcomeEvidenceSchema } from '../shared/personal-memory.js';
import type { TaskSpec } from '../shared/task-consent.js';
import { MockLanguageModelV4 } from './support/model.js';

const sha = 'b'.repeat(40);
const commit = { owner: 'owner', repo: 'repo', branch: 'rae/change', files: [{ path: 'src/app.ts', content: 'export const value = 1;' }], message: 'Owner requested change' };
const usage = { inputTokens: { total: 9, noCache: 9, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const call = () => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: 'github_push_files', input: JSON.stringify(commit) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('GitHub execution fixture missed its gate')), 15_000); })]); }
  finally { clearTimeout(timer); }
}
function until(runtime: V2Coordinator, check: () => boolean): Promise<void> { return bounded(new Promise<void>(done => {
  const run = () => { if (check()) { detach(); done(); } }; const detach = runtime.subscribe(run); run();
})); }
async function fixture(options: { proseOnly?: boolean; entered?: ReturnType<typeof gate>; release?: ReturnType<typeof gate>; unknown?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-github-execution-')); const store = new Store(directory); store.getApiKey = () => undefined;
  let modelCalls = 0; let writes = 0;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: async () => {
    modelCalls++; return options.proseOnly || modelCalls > 1 ? answer('The requested operation is complete.') : call();
  } }) });
  const scene = await runtime.createCase({ title: 'GitHub task fixture', objective: 'One scoped GitHub submission', domain: 'fixture' });
  const connectors = (runtime as unknown as { connectors: ConnectorService }).connectors;
  const selection = { kind: 'account' as const, connectionId: 'github-one', caseId: scene.id, accountId: 42, login: 'owner', credentialRevision: 1,
    token: { accessToken: 'FIXTURE_NOT_A_REAL_SECRET' } };
  const tools = { push_files: createTool({ id: 'push_files', description: 'Official GitHub submission fixture', inputSchema: z.record(z.string(), z.unknown()), execute: async () => {
    writes++; options.entered?.resolve(); if (options.release) await options.release.promise;
    if (options.unknown) throw new Error('Transport failed after dispatch');
    return { object: { sha } };
  } }) } as GitHubMCPTools;
  const operations = new GitHubOperations({ store, select: () => selection, assertActive: () => undefined, assertOwner: () => undefined,
    assertReadSource: () => undefined,
    run: (_case, _connection, work) => work(new AbortController().signal),
    inspect: async () => ({ id: 7, fullName: 'owner/repo', defaultBranch: 'main' }),
    withTools: async (_token, _signal, _access, work) => work(tools) });
  connectors.prepareGitHubTaskScope = async (_case, input) => githubTaskSpecSchema.parse(input);
  connectors.assertGitHubTaskScope = task => operations.assertTaskScope(task);
  connectors.withGitHubTaskTools = (task, input, work) => operations.withTaskTools(task, input, work);
  connectors.verifyGitHubTaskDelivery = task => operations.verifyDelivery(task);
  connectors.githubTaskReceipts = taskId => operations.receipts(taskId);
  await store.updateSettings({ enabled: true, maxStepsPerRun: 5 });
  const spec: TaskSpec = { caseId: scene.id, title: 'Submit the requested code', objective: 'Make the requested change in src/app.ts and commit it on the approved branch',
    expectedOutput: 'A real GitHub commit receipt', capabilities: ['github'], github: githubTaskSpecSchema.parse({ connectionId: selection.connectionId,
      repository: 'owner/repo', repositoryId: 7, accountId: selection.accountId, credentialRevision: selection.credentialRevision,
      operations: ['commit'], branch: 'rae/change', baseBranch: 'main', files: ['src/app.ts'] }) };
  const executor = (runtime as unknown as { taskExecutor: { hasTask(id: string): boolean; recover(): Promise<void> } }).taskExecutor;
  return { store, runtime, spec, operations, executor, modelCalls: () => modelCalls, writes: () => writes,
    async close() { await runtime.close(); store.close(); if (process.platform !== 'win32') await rm(directory, { recursive: true, force: true }); } };
}

test('the single task executor uses official GitHub tools and completes only with a durable remote receipt', async () => {
  const f = await fixture();
  try {
    const task = await f.runtime.requestTask({ requestId: 'owner-github-commit', spec: f.spec }); f.runtime.start();
    await until(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'completed' && !f.executor.hasTask(task.id));
    assert.equal(f.writes(), 1); const receipt = f.runtime.consent.get(task.id)?.githubReceipts?.[0];
    assert.equal(receipt?.state, 'submitted'); assert.equal(receipt?.sha, sha); assert.equal(f.modelCalls(), 2);
    const run = f.store.list('runs').find(item => item.taskId === task.id)!;
    const outcome = taskOutcomeEvidenceSchema.parse(f.runtime.inbox.get(run.taskOutcomeEventId!)?.payload.outcome);
    assert.equal(outcome.operations[0]?.id, receipt.operationId);
    assert.equal(outcome.checks.find(check => check.name === 'github.submission')?.passed, true);
    assert.doesNotMatch(JSON.stringify(outcome), /export const value/);
  } finally { await f.close(); }
});

test('model text cannot certify GitHub submission without a real tool receipt', async () => {
  const f = await fixture({ proseOnly: true });
  try {
    const task = await f.runtime.requestTask({ requestId: 'owner-no-fake-commit', spec: f.spec }); f.runtime.start();
    await until(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed' && !f.executor.hasTask(task.id));
    assert.equal(f.writes(), 0); assert.equal(f.runtime.consent.get(task.id)?.githubReceipts?.length ?? 0, 0);
  } finally { await f.close(); }
});

test('task cancellation waits for the accepted GitHub call and preserves its success on a revoked task', async () => {
  const entered = gate(); const release = gate(); const f = await fixture({ entered, release }); let ended = false;
  try {
    const task = await f.runtime.requestTask({ requestId: 'owner-cancel-github', spec: f.spec }); f.runtime.start(); await bounded(entered.promise);
    const cancel = f.runtime.revokeTask(task.id, f.runtime.consent.get(task.id)!.revision).then(result => { ended = true; return result; });
    await Promise.resolve(); assert.equal(ended, false); release.resolve(); await bounded(cancel);
    assert.equal(f.writes(), 1); const current = f.runtime.consent.get(task.id)!;
    assert.equal(current.state, 'revoked'); assert.equal(current.githubReceipts?.[0].state, 'submitted'); assert.equal(current.githubReceipts?.[0].sha, sha);
  } finally { release.resolve(); await f.close(); }
});

test('unknown GitHub outcome stays visible and recovery does not re-run a tool or a model', async () => {
  const f = await fixture({ unknown: true });
  try {
    const task = await f.runtime.requestTask({ requestId: 'owner-unknown-github', spec: f.spec }); f.runtime.start();
    await until(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed' && !f.executor.hasTask(task.id));
    assert.equal(f.writes(), 1); assert.equal(f.runtime.consent.get(task.id)?.githubReceipts?.[0].state, 'unknown');
    const modelCalls = f.modelCalls(); await f.executor.recover(); assert.equal(f.writes(), 1); assert.equal(f.modelCalls(), modelCalls);
  } finally { await f.close(); }
});
