import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'fixture' } });
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolName, toolCallId: randomUUID(), input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'fixture' } });
type ModelOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
function lastResult(options: ModelOptions, toolName: string): unknown {
  for (const message of [...options.prompt].reverse()) {
    if (message.role !== 'tool') continue;
    const result = [...message.content].reverse().find(part => part.type === 'tool-result' && part.toolName === toolName);
    if (result?.type === 'tool-result' && result.output.type === 'json') return result.output.value;
  }
  assert.fail(`No ${toolName} JSON result reached the model.`);
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean, reason: string) {
  const deadline = performance.now() + 10_000;
  while (!check()) { assert.ok(performance.now() < deadline, reason); await delay(10); }
}

test('cross-scene task result pagination reads the complete current artifact and rejects foreign or old-generation pages', { timeout: 35_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-result-pages-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const oldReply = gate(), releaseOldReply = gate();
  const currentText = 'FIRST_PAGE_TEXT_'.repeat(300) + 'TAIL_AFTER_OFFSET_4000' + 'LAST_PAGE_TEXT_'.repeat(300) + 'END_OF_CURRENT_ARTIFACT';
  const pages: string[] = []; const offsets: number[] = [];
  let targetId = '', otherTaskId = '', currentArtifactId = '', oldArtifactId = '', otherArtifactId = '';
  let phase: 'list' | 'first' | 'page' | 'foreign-artifact' | 'old-artifact' | 'unknown-task' | 'done' = 'list';
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const prompt = JSON.stringify(options.prompt);
    if (options.tools?.some(tool => tool.name === 'publish_artifact')) {
      const other = prompt.includes('OTHER_TASK_TITLE');
      const current = prompt.includes('CURRENT_DELIVERY_VERSION');
      if (options.prompt.at(-1)?.role === 'tool') {
        if (!other && !current) { oldReply.release(); await releaseOldReply.promise; }
        return answer('The requested artifact has been saved.');
      }
      return call('publish_artifact', { title: other ? 'Other task text' : current ? 'Current long text' : 'Old text',
        content: other ? 'FOREIGN_TASK_PRIVATE_BODY' : current ? currentText : 'OLD_REQUIREMENTS_PRIVATE_BODY', format: 'text' });
    }
    if (phase === 'list') { phase = 'first'; return call('list_tasks', { scope: 'all', query: 'Pagination primary target' }); }
    if (phase === 'first') {
      const found = lastResult(options, 'list_tasks') as { tasks: { id: string; requirementsRevision: number }[] };
      assert.deepEqual(found.tasks.map(task => task.id), [targetId]); assert.equal(found.tasks[0].requirementsRevision, 2);
      phase = 'page'; return call('read_task_result', { taskId: targetId });
    }
    if (phase === 'page') {
      const result = lastResult(options, 'read_task_result') as { taskId: string; artifacts: { id: string; content: string; offset: number;
        total: number; nextOffset: number | null; readWith?: { tool: string; arguments: { taskId: string; artifactId: string; offset: number } } }[] };
      assert.equal(result.taskId, targetId); assert.equal(result.artifacts.length, 1);
      const page = result.artifacts[0]; assert.equal(page.id, currentArtifactId); assert.equal(page.total, currentText.length);
      assert.ok(page.content.length <= 4000); pages.push(page.content); offsets.push(page.offset);
      if (page.nextOffset !== null) {
        assert.equal(page.nextOffset, page.offset + 4000); assert.equal(page.readWith?.tool, 'read_task_result');
        assert.deepEqual(page.readWith?.arguments, { taskId: targetId, artifactId: currentArtifactId, offset: page.nextOffset });
        return call(page.readWith!.tool, page.readWith!.arguments);
      }
      assert.equal(page.readWith, undefined);
      phase = 'foreign-artifact'; return call('read_task_result', { taskId: targetId, artifactId: otherArtifactId, offset: 4000 });
    }
    assert.doesNotMatch(prompt, /FOREIGN_TASK_PRIVATE_BODY|OLD_REQUIREMENTS_PRIVATE_BODY/);
    if (phase === 'foreign-artifact') {
      assert.match(prompt, /不属于当前任务要求版本/);
      phase = 'old-artifact'; return call('read_task_result', { taskId: targetId, artifactId: oldArtifactId, offset: 0 });
    }
    if (phase === 'old-artifact') {
      assert.match(prompt, /不属于当前任务要求版本/);
      phase = 'unknown-task'; return call('read_task_result', { taskId: otherTaskId, artifactId: currentArtifactId, offset: 4000 });
    }
    assert.equal(phase, 'unknown-task'); assert.match(prompt, /请先用list_tasks找到这项任务/); phase = 'done';
    return answer('END_OF_CURRENT_ARTIFACT was read from the last authorized page.');
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const original = await runtime.createCase({ title: 'Original tasks', objective: '', domain: 'work' });
    const destination = await runtime.createCase({ title: 'Cross-scene inquiry', objective: '', domain: 'personal' });
    const target = await runtime.requestTask({ requestId: 'long-text-target', spec: { caseId: original.id, title: 'Pagination primary target',
      objective: 'Save the requested delivery.', expectedOutput: 'One saved artifact.', capabilities: ['artifact'] } });
    targetId = target.id; await store.updateSettings({ enabled: true, maxStepsPerRun: 12 }); runtime.start();
    await until(() => store.list('artifacts').some(artifact => artifact.taskId === targetId), 'The old delivery was not saved.');
    await oldReply.promise;
    oldArtifactId = store.list('artifacts').find(artifact => artifact.taskId === targetId)!.id;
    const sourceId = randomUUID();
    const source = runtime.inbox.ingest({ sourceId: 'owner-chat', externalId: sourceId, caseId: original.id, kind: 'owner.message', actor: 'owner',
      operation: 'create', occurredAt: new Date().toISOString(), payload: { messageId: sourceId, content: 'CURRENT_DELIVERY_VERSION Please save the long final text.' } }).event;
    const [leased] = runtime.inbox.claim(1, 60_000, [source.id]); assert.ok(leased?.leaseToken);
    const revising = runtime.reviseTask(targetId, runtime.consent.get(targetId)!.revision, source.id);
    await until(() => runtime.consent.get(targetId)?.requirementsRevision === 2, 'The current requirements were not saved.');
    releaseOldReply.release(); await revising; runtime.inbox.ack(source.id, leased.leaseToken);
    await until(() => runtime.consent.get(targetId)?.state === 'completed', 'The current long artifact did not complete.');
    currentArtifactId = store.list('artifacts').find(artifact => artifact.taskId === targetId && artifact.requirementsRevision === 2)!.id;
    const other = await runtime.requestTask({ requestId: 'other-text-target', spec: { caseId: original.id, title: 'OTHER_TASK_TITLE',
      objective: 'Save a separate task result.', expectedOutput: 'One separate artifact.', capabilities: ['artifact'] } });
    otherTaskId = other.id;
    await until(() => runtime.consent.get(other.id)?.state === 'completed', 'The independent task did not finish.');
    otherArtifactId = store.list('artifacts').find(artifact => artifact.taskId === other.id)!.id;
    const query = await runtime.ingestOwnerMessage('Find the Pagination primary target and read its complete current delivery.', destination.id);
    await until(() => ['processed', 'failed'].includes(runtime.inbox.get(query.id)?.status ?? ''), 'The cross-scene pagination did not finish.');
    assert.equal(runtime.inbox.get(query.id)?.status, 'processed', runtime.inbox.get(query.id)?.lastError ?? 'Conversation failed.');
    assert.equal(phase, 'done'); assert.deepEqual(offsets, [0, 4000, 8000]); assert.equal(pages.join(''), currentText);
    assert.match(pages[1], /TAIL_AFTER_OFFSET_4000/); assert.match(pages[2], /END_OF_CURRENT_ARTIFACT/);
    assert.equal(store.list('artifacts').filter(artifact => artifact.taskId === targetId).length, 2, 'Historical delivery remains retained.');
  } finally { releaseOldReply.release(); await runtime.close(); store.close(); }
});
