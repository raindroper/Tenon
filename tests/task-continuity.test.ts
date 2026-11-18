import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { ConnectorProvider } from '../server/connectors/types.js';
import { MockLanguageModelV4 } from './support/model.js';
import { taskInConversation } from '../shared/task-consent.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(runtime: V2Coordinator, predicate: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined; let detach = () => {};
  try { await new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) resolve(); };
    detach = runtime.subscribe(check); timer = setTimeout(() => reject(new Error('Continuity fixture did not settle')), 10000); check();
  }); } finally { detach(); clearTimeout(timer); }
}

test('one task combines authorized upload and GitHub evidence, then its result is found from another conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-continuity-')); const store = new Store(directory); store.getApiKey = () => undefined;
  let sourceCase = ''; let repositoryCase = ''; let uploadEvent = ''; let repositoryEvent = ''; let taskId = ''; let foreground = 0; let execution = 0; let followup = false;
  const provider: ConnectorProvider = {
    validateScope: scope => scope,
    authorize: input => new URL('https://example.invalid/authorize?state=' + input.state),
    exchange: async () => ({ accessToken: 'offline-fixture-token' }), refresh: async () => { throw new Error('No refresh expected'); },
    scan: async input => input.cursor === undefined ? { cursor: 'baseline', changes: [] }
      : { cursor: 'seen', changes: [{ id: 'issue-1', revision: 'v1', title: 'Repository decision', content: 'REPOSITORY_CONTEXT: accept the current proposal.' }] },
  };
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const prompt = JSON.stringify(options.prompt);
    if (options.tools?.some(tool => tool.name === 'publish_artifact')) {
      execution++;
      if (execution === 1) return call('read_event', { eventId: uploadEvent });
      if (execution === 2) { assert.match(prompt, /DOCUMENT_CONTEXT/); return call('read_event', { eventId: repositoryEvent }); }
      if (execution === 3) {
        assert.match(prompt, /DOCUMENT_CONTEXT/); assert.match(prompt, /REPOSITORY_CONTEXT/);
        return call('publish_artifact', { title: 'Cross-source report', content: 'DOCUMENT_CONTEXT + REPOSITORY_CONTEXT', format: 'text' });
      }
      return answer('已依据两份关联资料保存结果。');
    }
    foreground++;
    if (followup) {
      if (foreground === 1) return call('list_tasks', { scope: 'all', query: 'Cross-source' });
      if (foreground === 2) { assert.match(prompt, new RegExp(taskId)); return call('read_task_result', { taskId }); }
      assert.match(prompt, /DOCUMENT_CONTEXT \+ REPOSITORY_CONTEXT/);
      return answer('原任务已保存两份资料的整理，仍待验收。');
    }
    if (foreground === 1) return call('inspect_product', { resource: 'scenes' });
    if (foreground === 2) return call('find_case_evidence', { sourceCaseId: sourceCase, query: 'DOCUMENT_CONTEXT' });
    if (foreground === 3) return call('find_case_evidence', { sourceCaseId: repositoryCase, query: 'REPOSITORY_CONTEXT' });
    return call('request_task', { title: 'Cross-source report', objective: 'Summarize the selected existing document and repository decision',
      expectedOutput: 'A saved report with both sources', capabilities: ['artifact'], evidenceEventIds: [uploadEvent, repositoryEvent] });
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model, connectorProviders: { github: provider } });
  try {
    const sources = await runtime.createCase({ title: 'Documents', objective: 'Authorized documents', domain: 'fixture' }); sourceCase = sources.id;
    const repository = await runtime.createCase({ title: 'Repository', objective: 'Authorized repository', domain: 'fixture' }); repositoryCase = repository.id;
    const work = await runtime.createCase({ title: 'Work', objective: 'The owner task', domain: 'fixture' });
    const other = await runtime.createCase({ title: 'Another conversation', objective: 'Continue the same relationship', domain: 'fixture' });
    await runtime.addSource({ title: 'Proposal', filename: 'proposal.md', content: 'DOCUMENT_CONTEXT: the proposal is ready.', caseId: sourceCase });
    const start = await runtime.connectorSettings.start('github', { caseId: repositoryCase, scope: 'owner/repository' }, 'http://127.0.0.1:4317');
    const connection = await runtime.connectorSettings.complete('github', start.state, 'fixture-code', 'http://127.0.0.1:4317');
    await runtime.connectorSettings.sync(connection.id);
    uploadEvent = runtime.inbox.list().find(event => event.kind === 'owner.source' && event.caseId === sourceCase)!.id;
    repositoryEvent = runtime.inbox.list().find(event => event.kind === 'connector.change' && event.caseId === repositoryCase)!.id;
    assert.ok(uploadEvent && repositoryEvent);
    await store.updateSettings({ enabled: true, maxStepsPerRun: 12 });
    const request = await runtime.ingestOwnerMessage('请把 Documents 和 Repository 的方案整理成一份报告。', work.id);
    runtime.start(); await waitFor(runtime, () => runtime.consent.list().some(task => task.state === 'completed'));
    const [task] = runtime.consent.list(); taskId = task.id;
    assert.equal(task.sourceEventId, request.id); assert.equal(task.spec.caseId, work.id);
    assert.equal(task.evidenceRefs?.length, 2); assert.deepEqual(task.spec.capabilities, ['artifact']);
    assert.equal(runtime.inbox.get(uploadEvent)?.caseId, sourceCase); assert.equal(runtime.inbox.get(repositoryEvent)?.caseId, repositoryCase);
    assert.equal(runtime.inbox.list().filter(event => event.kind === 'task.execute').length, 1);
    assert.equal(runtime.inbox.list().filter(event => event.kind === 'task.outcome').every(event => event.status === 'processed'), true);
    followup = true; foreground = 0;
    const question = await runtime.ingestOwnerMessage('之前的 Cross-source 报告做到哪里了？', other.id);
    await waitFor(runtime, () => runtime.inbox.get(question.id)?.status === 'processed');
    assert.ok(store.list('messages').some(message => message.replyTo === question.externalId && message.content.includes('仍待验收')));
    assert.equal(runtime.consent.list().length, 1, 'Finding a task does not create a replacement task');
    assert.equal(execution, 4); assert.equal(foreground, 3);
  } finally { await runtime.close(); store.close(); }
});

test('an active task continues from another conversation with a newly linked source and the same permission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-followup-')); const store = new Store(directory); store.getApiKey = () => undefined;
  const entered = gate(); const release = gate(); let runtime!: V2Coordinator; let taskId = ''; let evidenceId = ''; let sourceCase = ''; let initial = true; let foreground = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const prompt = JSON.stringify(options.prompt);
    if (options.tools?.some(tool => tool.name === 'publish_artifact')) {
      if (initial) { initial = false; entered.resolve(); await release.promise; return answer('Obsolete result must not complete the task'); }
      const recent = options.prompt.at(-1);
      if (recent?.role !== 'tool') return call('read_event', { eventId: evidenceId });
      if (recent.content.some(part => part.type === 'tool-result' && part.toolName === 'read_event')) {
        assert.match(prompt, /NEW_SOURCE_DETAIL/); return call('publish_artifact', { title: 'Current report', content: 'Continued with NEW_SOURCE_DETAIL', format: 'text' });
      }
      return answer('已在原任务中完成补充。');
    }
    foreground++;
    if (foreground === 1) return call('list_tasks', { scope: 'all', query: 'Original report' });
    if (foreground === 2) return call('find_case_evidence', { sourceCaseId: sourceCase, query: 'NEW_SOURCE_DETAIL' });
    if (foreground === 3) return call('revise_task', { taskId, revision: runtime.consent.get(taskId)!.revision, evidenceEventIds: [evidenceId] });
    return answer('已关联补充资料，原任务继续。');
  } });
  runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const home = await runtime.createCase({ title: 'Home', objective: 'Original work', domain: 'fixture' });
    const continued = await runtime.createCase({ title: 'Later conversation', objective: 'Continue original work', domain: 'fixture' });
    const materials = await runtime.createCase({ title: 'New materials', objective: 'Existing permitted source', domain: 'fixture' }); sourceCase = materials.id;
    await runtime.addSource({ title: 'More context', filename: 'context.md', content: 'NEW_SOURCE_DETAIL', caseId: sourceCase });
    evidenceId = runtime.inbox.list().find(event => event.kind === 'owner.source' && event.caseId === sourceCase)!.id;
    const task = await runtime.requestTask({ requestId: 'original-report', spec: { caseId: home.id, title: 'Original report',
      objective: 'Prepare the agreed report', expectedOutput: 'Saved report', capabilities: ['artifact'] } }); taskId = task.id;
    await store.updateSettings({ enabled: true, maxStepsPerRun: 10 }); runtime.start(); await entered.promise;
    const update = await runtime.ingestOwnerMessage('继续 Original report，请纳入 New materials 中的补充信息，原目标保持不变。', continued.id);
    await waitFor(runtime, () => runtime.consent.get(taskId)?.requirementsRevision === 2); release.resolve();
    await waitFor(runtime, () => runtime.consent.get(taskId)?.state === 'completed' && runtime.inbox.get(update.id)?.status === 'processed');
    const result = runtime.consent.get(taskId)!;
    assert.equal(runtime.consent.list().length, 1); assert.equal(result.spec.caseId, home.id);
    assert.equal(result.approvalRevision, task.approvalRevision); assert.equal(result.executionEventId, task.executionEventId);
    assert.equal(result.requirementUpdates?.[0].caseId, continued.id); assert.equal(result.requirementUpdates?.[0].sourceEventId, update.id);
    assert.equal(result.evidenceRefs?.[0].eventId, evidenceId); assert.equal(taskInConversation(result, continued.id), true);
    const artifacts = store.list('artifacts').filter(artifact => artifact.taskId === task.id);
    assert.equal(artifacts.length, 1); assert.equal(artifacts[0].requirementsRevision, 2);
    assert.equal(artifacts[0].content, 'Continued with NEW_SOURCE_DETAIL');
  } finally { release.resolve(); await runtime.close(); store.close(); }
});
