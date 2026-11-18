import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MockEmbeddingModelV4 } from 'ai/test';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';

type ModelOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
const oldValue = 'OWNER_RETIRED_DATE_13';
const correctedValue = 'OWNER_CONFIRMED_VALUE_16';
const retained = 'OWNER_RETAINED_PROJECT_DETAIL';
const speculation = 'ASSISTANT_ONLY_TRAVEL_SPECULATION';
const semanticQuery = '上回说的客户行程怎么安排';
const oldMessage = '本人第一次确认演示定在十三日，' + oldValue + '。' + '现场准备需要留出充足时间。'.repeat(20);
const retainedMessage = '接着演示原安排的更新，现改到十六号上午；到场先核对备用稿，' + retained + '。' + '核对之前的准备顺序。'.repeat(20);
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const finish = { unified: 'stop', raw: 'fixture' } as const;
type RecallResult = { messages: { messageId: string; caseId: string; sceneTitle: string; role: string; match: string; excerpt: string }[] };

function recallOutput(calls: ModelOptions[]): RecallResult {
  const result = calls.flatMap(call => call.prompt.flatMap(message => message.role === 'tool' ? message.content : []))
    .find(part => part.type === 'tool-result' && part.toolName === 'recall');
  assert.ok(result?.type === 'tool-result' && result.output.type === 'json');
  return result.output.value as RecallResult;
}

test('native observations resolve to current owner originals across scenes and after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-scene-om-recall-'));
  const actors: ModelOptions[] = [];
  const observers: ModelOptions[] = [];
  const embedded: string[] = [];
  const embedder = new MockEmbeddingModelV4({ doEmbed: async ({ values }) => {
    embedded.push(...values);
    return { embeddings: values.map(() => Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0)), warnings: [] };
  } });
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const system = options.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
    if (system.includes('Your memory observation reflections')) throw new Error('The fixture never reaches reflection threshold.');
    if (system.includes('Your observations will be the ONLY information')) {
      observers.push(options);
      const text = JSON.stringify(options.prompt);
      const facts = [text.includes(oldValue) ? '原定十三号，' + oldValue + '。' : '', text.includes(retained) ? '更新到十六号上午，' + retained + '。' : '']
        .filter(Boolean).join(' ');
      return { content: [{ type: 'text', text: '<observations>\nDate: Nov 6, 2026\n* 🔴 (09:00) ' + (facts || '继续核对当前讨论。') + '\n</observations>' }],
        finishReason: finish, usage, warnings: [] };
    }
    actors.push(options);
    const last = options.prompt.at(-1);
    const current = JSON.stringify(last) ?? '';
    const literal = current.includes('SCENE_RECALL_LITERAL_CHECK');
    const tool = last?.role === 'user' && (literal || current.includes('SCENE_RECALL_CHECK')) ? {
      toolName: 'recall', input: { mode: 'search', scope: 'all', query: literal ? oldValue : semanticQuery },
    } : last?.role === 'user' && current.includes(oldValue) && current.includes('第一次确认演示') ? {
      toolName: 'remember_personal_memory', input: { key: 'fixture.schedule', value: oldValue, evidenceExcerpt: oldValue, scope: 'case' },
    } : undefined;
    if (tool) return { content: [{ type: 'tool-call', toolCallId: 'scene-tool-' + actors.length, toolName: tool.toolName, input: JSON.stringify(tool.input) }],
      finishReason: { unified: 'tool-calls', raw: 'fixture' }, usage, warnings: [] };
    return { content: [{ type: 'text', text: last?.role === 'tool' && current.includes(oldValue) ? speculation + ' ' + oldValue : '夹具回复。' }],
      finishReason: finish, usage, warnings: [] };
  } });
  async function open() {
    const store = new Store(directory);
    store.getApiKey = () => undefined;
    try {
      const runtime = await V2Coordinator.create(store, { dataDir: directory, model, connectorProviders: {},
        memory: { embedder, observationTokens: 48, reflectionTokens: 100_000 } });
      return { store, runtime, async close() { try { await runtime.close(); } finally { store.close(); } } };
    } catch (error) { store.close(); throw error; }
  }
  let f: Awaited<ReturnType<typeof open>> | undefined = await open();
  async function send(caseId: string, content: string) {
    const runtime = f!.runtime;
    const start = actors.length;
    const event = await runtime.ingestOwnerMessage(content, caseId);
    const deadline = Date.now() + 8000;
    let result = runtime.inbox.get(event.id);
    while (result && !['processed', 'failed'].includes(result.status) && Date.now() < deadline) {
      await delay(10); result = runtime.inbox.get(event.id);
    }
    assert.equal(result?.status, 'processed', result?.lastError ?? 'Owner turn did not settle');
    const calls = actors.slice(start);
    assert.ok(calls.length);
    return { id: event.externalId, calls };
  }
  try {
    const project = await f.runtime.createCase({ title: '项目协作', objective: '', domain: 'work' });
    const travel = await f.runtime.createCase({ title: '行程讨论', objective: '', domain: 'travel' });
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 5 });
    f.runtime.start();
    const original = await send(project.id, oldMessage);
    const update = await send(project.id, retainedMessage);
    assert.ok(observers.length > 0, 'Second owner turn should produce a native observation');
    assert.ok(JSON.stringify(observers[0].prompt).includes(original.id));
    assert.ok(!JSON.stringify(observers[0].prompt).includes(speculation));
    assert.ok(embedded.some(value => value.includes(oldValue)), 'The native observation was vector-indexed');
    const first = await send(travel.id, '想接着聊一下。SCENE_RECALL_CHECK');
    const privateHistory = new RegExp([oldValue, retained, speculation].join('|'));
    assert.doesNotMatch(JSON.stringify(first.calls[0].prompt), privateHistory);
    const firstOutput = recallOutput(first.calls);
    assert.deepEqual(firstOutput.messages.map(({ messageId, match }) => [messageId, match]), [
      [original.id, 'semantic'], [update.id, 'follow_up'],
    ]);
    assert.ok(firstOutput.messages.every(message => message.caseId === project.id && message.sceneTitle === '项目协作' && message.role === 'user'));
    assert.ok(!JSON.stringify(firstOutput).includes(speculation));
    assert.ok(embedded.includes(semanticQuery));

    await f.runtime.correctPersonalMemory('fixture.schedule', { value: correctedValue, scope: 'case', caseIds: [project.id, travel.id] });
    const afterCorrection = await send(travel.id, '请按现行理解继续。');
    assert.ok(JSON.stringify(afterCorrection.calls[0].prompt).includes(correctedValue));
    assert.doesNotMatch(JSON.stringify(afterCorrection.calls[0].prompt), new RegExp(oldValue + '|' + speculation));
    await f.runtime.correctPersonalMemory('fixture.schedule', { value: correctedValue, scope: 'case', caseIds: [project.id] });
    const narrowed = await send(travel.id, '再核对当前场景的理解。');
    assert.match(JSON.stringify(narrowed.calls[0].prompt), /out_of_scope/);
    const unavailable = new RegExp([oldValue, correctedValue, speculation].join('|'));
    assert.doesNotMatch(JSON.stringify(narrowed.calls[0].prompt), unavailable);
    await f.runtime.retractPersonalMemory('fixture.schedule');
    const beforeRebuild = await send(travel.id, '请检查旧安排还可否用。SCENE_RECALL_LITERAL_CHECK');
    assert.doesNotMatch(JSON.stringify(beforeRebuild.calls[0].prompt), unavailable);
    const blocked = recallOutput(beforeRebuild.calls);
    assert.ok(blocked.messages.every(message => message.messageId !== original.id));
    assert.doesNotMatch(JSON.stringify(blocked), unavailable);

    const observationStart = observers.length;
    const rebuilt = await send(project.id, '接着准备这次演示。');
    assert.doesNotMatch(JSON.stringify(rebuilt.calls[0].prompt), unavailable);
    assert.ok(observers.length > observationStart, 'The stale projection should be rebuilt on the next authorized owner turn');
    const rebuildPrompt = JSON.stringify(observers.slice(observationStart).map(call => call.prompt));
    assert.ok(rebuildPrompt.includes(retained));
    assert.doesNotMatch(rebuildPrompt, new RegExp(oldValue + '|' + speculation));
    assert.equal(f.store.get('messages', original.id)?.content, oldMessage);
    assert.ok(JSON.stringify(await f.runtime.memory.historyForObservation(project.id)).includes(oldValue));
    await f.close(); f = undefined;

    f = await open();
    f.runtime.start();
    const reopened = await send(travel.id, '重新打开后请回查原话。SCENE_RECALL_CHECK');
    assert.doesNotMatch(JSON.stringify(reopened.calls[0].prompt), new RegExp([oldValue, correctedValue, retained, speculation].join('|')));
    const finalOutput = recallOutput(reopened.calls);
    assert.ok(finalOutput.messages.some(message => message.messageId === update.id && message.match === 'semantic'));
    assert.doesNotMatch(JSON.stringify(finalOutput), unavailable);
    assert.equal(f.store.get('messages', original.id)?.content, oldMessage);
  } finally { await f?.close(); }
});
