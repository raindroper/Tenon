import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { ConnectorDirectory } from '../shared/connectors.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { ConnectorService } from '../server/connectors/service.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const answer = () => ({ content: [{ type: 'text' as const, text: 'The verified answer.' }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const action = (tool: string) => ({ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: 'read_github_repository',
  input: JSON.stringify({ connectionId: 'github-account', tool, input: tool === 'get_me' ? {} : { query: 'PRIVATE_QUERY', perPage: 10 } }) });
const actions = (...tools: string[]) => ({ content: tools.map(action), usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { const start = performance.now(); while (!check()) { assert(performance.now() - start < 20_000, 'Progress fixture did not settle'); await delay(5); } }
async function fixture(respond: MockLanguageModelV4['doGenerate'], read: (tool: string) => Promise<unknown> = async () => ({ private: 'PRIVATE_RESULT' })) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-progress-runtime-')); const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) });
  const scene = await runtime.createCase({ title: 'Progress fixture', objective: 'Show only verified lifecycle activity', domain: 'fixture' });
  const connectors = (runtime as unknown as { connectors: ConnectorService }).connectors;
  const directoryView: ConnectorDirectory = { providers: [], tencentDocsCredentials: [], connections: [{ id: 'github-account', kind: 'github', caseId: scene.id,
    scope: 'owner', connectedAt: new Date().toISOString(), lastSyncedAt: null, status: 'watching', github: { kind: 'account', accountId: 42, login: 'owner', credentialRevision: 1 } }] };
  connectors.list = () => directoryView; connectors.canReadGitHubConnection = () => true;
  runtime.sources.isEventAllowed = () => true;
  runtime.sources.resolveEventCase = event => event.caseId;
  connectors.readGitHubTool = async (caseId, _owner, input) => {
    const result = await read(input.tool);
    const evidence = runtime.inbox.ingestProcessed({ sourceId: 'connector:github-account', sourceGeneration: 'github-account', externalId: randomUUID(),
      caseId, kind: 'connector.github_read', actor: 'external', operation: 'create', occurredAt: new Date().toISOString(), payload: { content: 'PRIVATE_EVIDENCE' } });
    return { connectionId: 'github-account', accountId: 42, credentialRevision: 1, evidenceId: evidence.id, result };
  };
  await store.updateSettings({ enabled: true, maxStepsPerRun: 8 });
  return { store, runtime, scene, async start() { const event = await runtime.ingestOwnerMessage('Inspect GitHub and answer.', scene.id); runtime.start(); return event; },
    async close() { await runtime.close(); store.close(); } };
}

test('real owner tool execution records get_me/search completion and returns to actual model phase', async () => {
  const secondModel = gate(); const release = gate(); let calls = 0;
  const f = await fixture(async () => { calls++; if (calls === 1) return actions('get_me'); if (calls === 2) { secondModel.resolve(); await release.promise; return actions('search_repositories'); } return answer(); });
  try {
    const event = await f.start(); await until(() => calls === 2);
    const active = f.store.list('runs').find(run => run.eventId === event.id)!;
    assert.equal(active.progress?.phase, 'model'); assert.equal(active.progress?.operations[0].status, 'succeeded');
    assert.equal(active.progress?.operations[0].label, '查看GitHub账号');
    release.resolve(); await until(() => f.runtime.inbox.get(event.id)?.status === 'processed');
    const done = f.store.get('runs', active.id)!; assert.equal(done.progress?.phase, 'settling');
    assert.deepEqual(done.progress?.operations.map(operation => [operation.label, operation.status]), [['查看GitHub账号', 'succeeded'], ['搜索GitHub仓库', 'succeeded']]);
    assert.doesNotMatch(JSON.stringify(done.progress), /PRIVATE/);
  } finally { release.resolve(); await f.close(); }
});

test('stopping waits for an accepted read before finalizing progress', async () => {
  const releases = { get_me: gate(), search_repositories: gate() }; const started = new Set<string>(); let modelCalls = 0;
  const f = await fixture(async () => { modelCalls++; return modelCalls === 1 ? actions('get_me') : answer(); }, async tool => {
    started.add(tool); await releases[tool as keyof typeof releases].promise; return { private: 'PRIVATE_RESULT' };
  });
  let stopped = false;
  try {
    const event = await f.start(); await until(() => started.size === 1);
    const active = f.store.list('runs').find(run => run.eventId === event.id)!;
    assert.equal(active.progress?.operations.length, 1); assert(active.progress?.operations.every(operation => operation.status === 'running'));
    const stopping = f.runtime.stop().then(() => { stopped = true; }); await delay(10); assert.equal(stopped, false);
    releases.get_me.resolve(); await stopping;
    const saved = f.store.get('runs', active.id)!; assert.equal(saved.status, 'interrupted');
    assert(saved.progress?.operations.every(operation => operation.status !== 'running')); assert.equal(saved.progress?.phase, 'settling');
    assert.equal(modelCalls, 1); assert.doesNotMatch(JSON.stringify(saved.progress), /PRIVATE/);
  } finally { releases.get_me.resolve(); releases.search_repositories.resolve(); await f.close(); }
});
