import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { compareMethod } from '../scripts/compare-method.js';
import { feedbackVersion } from '../server/feedback-version.js';
import { exportRuntimeData } from '../server/index.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { caseEventPrefix } from '../server/v2/source-context.js';
import { MockLanguageModelV4 } from './support/model.js';

type Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
const usage = { inputTokens: { total: 18, noCache: 18, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 6, text: 6, reasoning: 0 } };
const answer = (text = 'The offline fixture turn is complete.') => ({ content: [{ type: 'text' as const, text }], usage, warnings: [],
  finishReason: { unified: 'stop' as const, raw: 'stop' } });
const tool = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
function currentEvent(options: Options): { id: string; kind: string; payload: Record<string, unknown> } {
  for (const message of [...options.prompt].reverse()) if (message.role === 'user') {
    const part = message.content.find(part => part.type === 'text' && part.text.startsWith(caseEventPrefix));
    if (part?.type === 'text') return JSON.parse(part.text.slice(caseEventPrefix.length)).event;
  }
  throw new Error('Fixture expected an attributed runtime event');
}
function lastTool(options: Options): string | undefined {
  const last = options.prompt.at(-1);
  return last?.role === 'tool' ? last.content.find(part => part.type === 'tool-result')?.toolName : undefined;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { assert.ok(Date.now() < deadline, 'The actual runtime flow did not reach its saved outcome'); await delay(10); }
}
async function fixture(respond: MockLanguageModelV4['doGenerate']) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-feedback-flow-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) });
  return { directory, store, get runtime() { return runtime; },
    async reopen() { await runtime.close(); runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) }); },
    async close() { await runtime.close(); store.close(); } };
}

test('RuntimeApi closes the real task/result/feedback/method loop without idle inference or self-certified competence', async () => {
  const oldMethod = 'OLD_METHOD_SENTINEL: give every detail before the decision.';
  const correctedMethod = 'CURRENT_METHOD_SENTINEL：先给结论，再解释影响决定的依据。';
  let calls = 0; let laterPrompt = '';
  const f = await fixture(async options => {
    calls++;
    if (options.tools?.some(value => value.name === 'publish_artifact')) {
      if (lastTool(options)) return answer('The assigned text is saved for owner review.');
      return tool('publish_artifact', { title: 'Prepared answer', content: oldMethod, format: 'text' });
    }
    if (lastTool(options)) return answer();
    const event = currentEvent(options);
    if (event.kind === 'owner.feedback') return tool('learn_method', { key: 'fixture.task-answer-order',
      value: event.payload.verdict === 'useful' ? oldMethod : correctedMethod,
      evidenceExcerpt: event.payload.verdict === 'useful' ? 'give every detail before the decision.' : correctedMethod });
    if (String(event.payload.content).includes('CLEAR_TASK_REQUEST')) return tool('request_task', {
      title: 'One prepared answer', objective: 'Save the requested decision explanation', expectedOutput: 'One text for owner review', capabilities: ['artifact'] });
    laterPrompt = JSON.stringify(options.prompt);
    assert.match(laterPrompt, /CURRENT_METHOD_SENTINEL/);
    assert.doesNotMatch(laterPrompt, /OLD_METHOD_SENTINEL/);
    return answer('A fixture response that uses the stored method; not a claim of measured model improvement.');
  });
  try {
    const scene = await f.runtime.createCase({ title: 'Writing work', objective: 'Discuss and deliver the requested explanation', domain: 'writing' });
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 5 });
    const request = await f.runtime.ingestOwnerMessage('CLEAR_TASK_REQUEST 请为我写并保存一份决策说明。', scene.id);
    f.runtime.start();
    await until(() => f.runtime.inbox.get(request.id)?.status === 'processed' && f.runtime.consent.list(scene.id)[0]?.state === 'completed');
    const [task] = await f.runtime.listTasks(); const [artifact] = f.store.list('artifacts');
    assert.equal(task.sourceEventId, request.id); assert.equal(artifact.taskId, task.id); assert.equal(artifact.status, 'prepared');
    const run = f.store.list('runs').find(run => run.taskId === task.id)!;
    assert.ok(run.taskOutcomeEventId);
    const outcome = f.runtime.inbox.get(run.taskOutcomeEventId)!;
    assert.equal(outcome.kind, 'task.outcome'); assert.equal(outcome.status, 'processed');
    assert.equal(f.runtime.sources.isEventAllowed(outcome), true);
    assert.equal(f.store.list('runs').some(value => value.eventId === outcome.id), false);
    const callsAfterTask = calls;
    f.runtime.request('recovery'); await delay(1100);
    assert.equal(calls, callsAfterTask, 'A finished task and local result evidence cannot start an idle learning/model loop');
    const positive = await f.runtime.addFeedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'useful', comment: '' });
    await until(() => f.runtime.inbox.list().some(event => event.externalId === positive.id && event.status === 'processed'));
    const savedPositive = f.store.get('feedback', positive.id)!;
    assert.equal(savedPositive.taskOutcome?.taskId, task.id); assert.equal(savedPositive.taskOutcome?.requirementsRevision, 1);
    assert.equal(savedPositive.taskOutcome?.outcomeEventId, outcome.id);
    let method = (await f.runtime.listPersonalMemory())[0];
    assert.equal(method.level, 'hypothesis'); assert.equal(method.evidence[0].rating?.verdict, 'useful');
    assert.equal(method.evidence[0].taskOutcome?.deliveries[0].status, 'prepared');
    assert.deepEqual(method.evidence[0].taskOutcome?.checks.map(check => check.name), ['artifact.persisted', 'runtime.delivery_state']);
    const correction = await f.runtime.addFeedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'off_target', comment: correctedMethod });
    await until(() => f.runtime.inbox.list().some(event => event.externalId === correction.id && event.status === 'processed'));
    method = (await f.runtime.listPersonalMemory())[0];
    assert.equal(method.revision, 2); assert.equal(method.value, correctedMethod); assert.equal(method.level, 'hypothesis');
    assert.equal(method.history[0].value, oldMethod); assert.equal(method.evidence[0].taskOutcome?.runId, run.id);
    const beforeReopen = calls; await f.reopen(); assert.equal(calls, beforeReopen);
    const later = await f.runtime.createCase({ title: 'Another writing discussion', objective: '', domain: 'writing' });
    const next = await f.runtime.ingestOwnerMessage('请用适合我的方式回答一个新的相关问题。', later.id);
    f.runtime.start(); await until(() => f.runtime.inbox.get(next.id)?.status === 'processed');
    assert.ok(laterPrompt); assert.equal(calls, beforeReopen + 1);
    assert.equal(f.store.list('feedback').filter(value => value.comment === correctedMethod).length, 1, 'The owner correction was provided only once');
    assert.equal((await f.runtime.listTasks()).length, 1); assert.equal(f.store.list('artifacts').length, 1);
    assert.equal(f.runtime.inbox.list().filter(event => event.kind === 'task.outcome').length, 1);
    assert.equal((await f.runtime.listPersonalMemory())[0].revision, 2, 'A later agent reply cannot certify or promote its own method');
    await delay(1100); assert.equal(calls, beforeReopen + 1);
  } finally { await f.close(); }
});

test('two separately approved tasks can be compared by one independent criterion and exact delivered method revisions', async () => {
  const key = 'decision-summary.order', method = '决策说明先在第一行给出结论，再说明影响决定的依据。';
  let calls = 0;
  const f = await fixture(async options => {
    calls++;
    const event = currentEvent(options);
    if (lastTool(options)) return answer();
    if (event.kind === 'owner.feedback') {
      return event.payload.verdict === 'off_target' ? tool('learn_method', { key, value: method, evidenceExcerpt: method }) : answer();
    }
    if (event.kind === 'task.execute') {
      const withMethod = JSON.stringify(options.prompt).includes(method);
      return tool('publish_artifact', { title: '决策说明', format: 'text',
        content: withMethod ? '结论：批准第二项。\n理由：资料齐备。' : '背景：资料齐备。\n结论：批准第一项。' });
    }
    return tool('request_task', { title: '写决策说明', objective: '写一份短决策说明', expectedOutput: '一份决策说明',
      capabilities: ['artifact'] });
  });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 5 });
    const evaluate = async (request: string) => {
      const scene = await f.runtime.createCase({ title: request, objective: '练习同一类决策说明', domain: 'writing' });
      const event = await f.runtime.ingestOwnerMessage(request, scene.id);
      f.runtime.start();
      await until(() => f.runtime.consent.list(scene.id).some(task => task.sourceEventId === event.id && task.state === 'completed'));
      const artifact = f.store.list('artifacts').find(result => result.caseId === scene.id)!;
      assert.ok(artifact);
      assert.equal(artifact.status, 'prepared');
      const firstLineIsConclusion = artifact.content.trimStart().startsWith('结论：');
      const feedback = await f.runtime.addFeedback({ targetType: 'artifact', targetId: artifact.id, targetVersion: feedbackVersion(artifact.content),
        verdict: firstLineIsConclusion ? 'useful' : 'off_target', comment: firstLineIsConclusion ? '' : method });
      await until(() => f.runtime.inbox.list().some(row => row.kind === 'owner.feedback' && row.externalId === feedback.id && row.status === 'processed'));
      return feedback;
    };
    const before = await evaluate('请根据资料齐备的条件，写并保存第一项的简短决策说明。');
    assert.equal(before.verdict, 'off_target');
    assert.equal((await f.runtime.listPersonalMemory())[0].revision, 1);
    const after = await evaluate('请根据同样资料齐备的条件，写并保存第二项的简短决策说明。');
    assert.equal(after.verdict, 'useful');
    const beforeComparison = calls;
    const data = await exportRuntimeData(f.store, f.runtime);
    const result = compareMethod(data, key, before.id, after.id);
    assert.equal(result.verdictChange, 'better');
    assert.notEqual(result.baseline.taskId, result.followUp.taskId);
    assert.deepEqual(result.baseline.method.revisions, []);
    assert.deepEqual(result.followUp.method.revisions, [1]);
    assert.deepEqual(result.taskChecks.checks.map(check => [check.name, check.baseline.passed, check.followUp.passed]),
      [['artifact.persisted', true, true], ['runtime.delivery_state', true, true]], 'save checks stay distinct from the externally graded response criterion');
    assert.equal(result.baseline.usage.status, 'reported');
    assert.doesNotMatch(JSON.stringify(result), /资料齐备|批准第二项/);
    assert.throws(() => compareMethod(data, key, before.id, before.id), /不同运行/);
    assert.throws(() => compareMethod(data, key, after.id, before.id), /后一次/);
    assert.throws(() => compareMethod(data, 'missing.method', before.id, after.id), /新方法版本/);
    const missing = structuredClone(data) as typeof data & { contextState: Awaited<ReturnType<V2Coordinator['exportContextState']>> };
    const { taskOutcomes, ...legacyContext } = missing.contextState;
    assert.equal(taskOutcomes.length, 2, 'the export uses both original outcome journals even though the later rating taught no memory');
    assert.equal(compareMethod({ ...data, contextState: legacyContext }, key, before.id, after.id).taskChecks.status, 'unavailable');
    missing.contextState.taskOutcomes = [];
    assert.equal(compareMethod(missing, key, before.id, after.id).taskChecks.status, 'unavailable');
    missing.contextState.dispatchContexts = [];
    assert.throws(() => compareMethod(missing, key, before.id, after.id), /上下文清单/);
    const methodEntry = (await f.runtime.listPersonalMemory())[0];
    assert.equal(methodEntry.revision, 1); assert.equal(methodEntry.level, 'hypothesis');
    assert.equal(calls, beforeComparison, 'the comparison itself performs no model call');
  } finally { await f.close(); }
});

test('the comparator binds ordinary replies to their owner turns and treats a timing-only rating as inconclusive', async () => {
  const key = 'fixture.reply-order', method = '回答写作问题时把决定放第一行。';
  const f = await fixture(async options => {
    if (lastTool(options)) return answer();
    const event = currentEvent(options);
    if (event.kind === 'owner.feedback' && event.payload.verdict === 'off_target') {
      return tool('learn_method', { key, value: method, evidenceExcerpt: method });
    }
    return answer(JSON.stringify(options.prompt).includes(method) ? '决定在第一行。' : '先说一段背景。');
  });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 4 });
    const evaluate = async (question: string, verdict: 'off_target' | 'not_now') => {
      const scene = await f.runtime.createCase({ title: question, objective: '', domain: 'writing' });
      const event = await f.runtime.ingestOwnerMessage(question, scene.id);
      f.runtime.start();
      await until(() => f.runtime.inbox.get(event.id)?.status === 'processed');
      const reply = f.store.list('messages').find(message => message.role === 'assistant' && message.replyTo === event.externalId)!;
      assert.equal(reply.content, verdict === 'off_target' ? '先说一段背景。' : '决定在第一行。');
      const feedback = await f.runtime.addFeedback({ targetType: 'message', targetId: reply.id, targetVersion: feedbackVersion(reply.content),
        verdict, comment: verdict === 'off_target' ? method : '' });
      await until(() => f.runtime.inbox.list().some(row => row.externalId === feedback.id && row.status === 'processed'));
      return feedback;
    };
    const before = await evaluate('对于第一份写作材料，该做什么决定？', 'off_target');
    const after = await evaluate('对于另一份写作材料，该做什么决定？', 'not_now');
    const data = await exportRuntimeData(f.store, f.runtime);
    const result = compareMethod(data, key, before.id, after.id);
    assert.equal(result.verdictChange, 'inconclusive');
    assert.deepEqual(result.followUp.method.revisions, [1]);
    assert.equal(result.followUp.taskId, undefined);
    assert.equal(result.taskChecks.status, 'unavailable');
    const edited = structuredClone(data);
    edited.messages.find(message => message.id === after.targetId)!.content += ' 变化。';
    assert.throws(() => compareMethod(edited, key, before.id, after.id), /评价对象已变化/);
  } finally { await f.close(); }
});

test('RuntimeApi source withdrawal excludes its task outcome and method from later model context while preserving export history', async () => {
  let sourceEventId = ''; let taskId = ''; let outcomeId = ''; let calls = 0; let afterWithdrawal = '';
  const f = await fixture(async options => {
    calls++;
    const last = lastTool(options);
    if (options.tools?.some(value => value.name === 'publish_artifact')) {
      if (!last) return tool('find_case_evidence', { query: 'SOURCE_PRIVATE_SENTINEL', limit: 5 });
      if (last === 'find_case_evidence') return tool('read_event', { eventId: sourceEventId });
      if (last === 'read_event') {
        assert.match(JSON.stringify(options.prompt), /SOURCE_PRIVATE_SENTINEL/);
        return tool('publish_artifact', { title: 'Source-based output', content: 'OUTPUT_FROM_SOURCE_SENTINEL', format: 'text' });
      }
      return answer('Prepared output is saved.');
    }
    if (last === 'read_event') {
      assert.match(JSON.stringify(options.prompt), /artifact\.persisted/);
      return answer('RESULT_PUBLIC_SENTINEL');
    }
    if (last) return answer();
    const event = currentEvent(options);
    if (event.kind === 'owner.feedback') return tool('learn_method', { key: 'fixture.source-derived-method', value: 'SOURCE_DERIVED_METHOD_SENTINEL',
      evidenceExcerpt: 'OUTPUT_FROM_SOURCE_SENTINEL' });
    const content = String(event.payload.content);
    if (content.includes('SOURCE_TASK_REQUEST')) return tool('request_task', { title: 'Use the authorized source',
      objective: 'Prepare the explicitly requested source-based text', expectedOutput: 'One saved text', capabilities: ['artifact'] });
    if (content.includes('READ_OUTCOME_BEFORE_REVOKE')) return tool('read_event', { eventId: outcomeId });
    afterWithdrawal = JSON.stringify(options.prompt);
    return answer('The withdrawn evidence is no longer used.');
  });
  try {
    const scene = await f.runtime.createCase({ title: 'Source-bound learning', objective: '', domain: 'work' });
    const watched = join(f.directory, 'observed'); await mkdir(watched); await writeFile(join(watched, 'source.md'), 'SOURCE_PRIVATE_SENTINEL');
    await f.runtime.registerWorkspaceSource({ sourceId: 'feedback-source', root: watched, caseId: scene.id, include: ['source.md'] });
    sourceEventId = f.runtime.inbox.list().find(event => event.kind === 'workspace.file')!.id;
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 6 });
    const request = await f.runtime.ingestOwnerMessage('SOURCE_TASK_REQUEST 请用已授权的资料写并保存一份说明。', scene.id);
    f.runtime.start(); await until(() => f.runtime.inbox.get(request.id)?.status === 'processed' && f.runtime.consent.list(scene.id)[0]?.state === 'completed');
    const [task] = await f.runtime.listTasks(); taskId = task.id;
    assert.equal(task.evidenceRefs?.length ?? 0, 0, 'The original request did not predeclare its later same-scene reads');
    const [artifact] = f.store.list('artifacts'); const run = f.store.list('runs').find(run => run.taskId === taskId)!;
    assert.ok(run.evidenceEventIds?.includes(sourceEventId), 'The execution tool result must record the source it actually used');
    outcomeId = run.taskOutcomeEventId!; assert.ok(outcomeId);
    const feedback = await f.runtime.addFeedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'useful', comment: '' });
    await until(() => f.runtime.inbox.list().some(event => event.externalId === feedback.id && event.status === 'processed'));
    assert.equal((await f.runtime.listPersonalMemory())[0].effectiveStatus, 'active');
    const read = await f.runtime.ingestOwnerMessage('READ_OUTCOME_BEFORE_REVOKE 请核对这次任务的真实结果。', scene.id);
    await until(() => f.runtime.inbox.get(read.id)?.status === 'processed');
    assert.ok(f.store.list('messages').some(message => message.content.includes('RESULT_PUBLIC_SENTINEL')));
    await f.runtime.removeWorkspaceSource('feedback-source');
    assert.equal(f.runtime.sources.isEventAllowed(f.runtime.inbox.get(outcomeId)!), false);
    assert.equal((await f.runtime.exportContextState()).taskOutcomes.some(outcome => outcome.eventId === outcomeId), false);
    assert.equal((await f.runtime.listPersonalMemory())[0].effectiveStatus, 'evidence_unavailable');
    const callsBefore = calls;
    const followUp = await f.runtime.ingestOwnerMessage('AFTER_SOURCE_WITHDRAWAL 现在回答独立的新问题。', scene.id);
    await until(() => ['processed', 'failed'].includes(f.runtime.inbox.get(followUp.id)?.status ?? ''));
    assert.equal(f.runtime.inbox.get(followUp.id)?.status, 'processed'); assert.ok(afterWithdrawal);
    assert.deepEqual(['SOURCE_PRIVATE_SENTINEL', 'OUTPUT_FROM_SOURCE_SENTINEL', 'SOURCE_DERIVED_METHOD_SENTINEL', 'RESULT_PUBLIC_SENTINEL']
      .filter(marker => afterWithdrawal.includes(marker)), [], 'Neither outcome-linked feedback nor its method/tool history may reintroduce a withdrawn source');
    assert.equal(calls, callsBefore + 1);
    assert.ok(f.runtime.inbox.get(outcomeId), 'The historical outcome remains available for owner export');
    assert.match(JSON.stringify(await f.runtime.memory.history(scene.id)), /RESULT_PUBLIC_SENTINEL/);
    assert.equal((await f.runtime.listTasks()).length, 1); assert.equal(f.store.list('artifacts').length, 1);
    await delay(1100); assert.equal(calls, callsBefore + 1, 'Withdrawal and outcome repair must not trigger a learning/model loop');
    const late = await f.runtime.addFeedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'useful', comment: 'This rating must not resend a withdrawn target.' });
    const lateSaved = f.store.get('feedback', late.id)!;
    assert.equal(lateSaved.taskOutcome?.outcomeEventId, outcomeId, 'A new rating after withdrawal retains the old journal reference, not an unscoped target copy');
    assert.equal(lateSaved.targetContent, artifact.content);
    const lateEvent = f.runtime.inbox.list().find(event => event.externalId === late.id)!;
    await until(() => f.runtime.inbox.get(lateEvent.id)?.status === 'processed'
      || f.store.list('runs').some(run => run.eventId === lateEvent.id && run.status !== 'running'));
    assert.equal(calls, callsBefore + 1, 'The newly rated withdrawn target must be fenced before any provider call');
    assert.equal((await f.runtime.listPersonalMemory())[0].effectiveStatus, 'evidence_unavailable');
  } finally { await f.close(); }
});
