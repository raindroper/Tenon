import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { ObservationContext } from '../server/v2/observation-context.js';
import { createRecallSession } from '../server/v2/recall.js';
import { MockLanguageModelV4 } from './support/model.js';

type ModelOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type ModelResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const query = '%_校准号';
const toolName = 'recall';
const date = '2024-05-01T08:00:00.000Z';
const answer: ModelResult = { content: [{ type: 'text', text: '这次只讨论对话内容。' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };

async function assertProcessed(runtime: V2Coordinator, eventId: string) {
  const deadline = Date.now() + 8000;
  let event = runtime.inbox.get(eventId);
  while (event && !['processed', 'failed'].includes(event.status) && Date.now() < deadline) {
    await delay(10);
    event = runtime.inbox.get(eventId);
  }
  assert.equal(event?.status, 'processed', event?.lastError ?? 'The fixture conversation did not settle');
}

test('owner history is available on demand and explicit same-scene assistant quotes still work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-chat-history-'));
  const store = new Store(directory);
  store.getApiKey = () => undefined;
  const calls: ModelOptions[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    calls.push(options);
    if (calls.length !== 1) return answer;
    return { content: [{ type: 'tool-call', toolCallId: 'search-history-fixture', toolName, input: JSON.stringify({ query }) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const current = await runtime.createCase({ title: '历史检索', objective: '继续交流', domain: 'test' });
    const caseId = current.id;
    const other = await runtime.createCase({ title: '其他主题', objective: '独立背景', domain: 'test' });
    const oldUser = `${'前'.repeat(4500)}旧用户消息${query}命中之后${'后'.repeat(4500)}`;
    const oldAssistant = `只应在明确引用时带入的助手正文。${'长'.repeat(9000)}${query} 旧助手消息`;
    store.insert('messages', { id: 'old-user', caseId, role: 'user', content: oldUser, createdAt: date });
    store.insert('messages', { id: 'old-assistant', caseId, role: 'assistant', content: oldAssistant, createdAt: date, outputState: 'incomplete' });
    store.insert('messages', { id: 'streaming-message', caseId, role: 'assistant', content: `${query} 尚在生成的消息`, createdAt: date, outputState: 'streaming' });
    store.insert('messages', { id: 'system-message', caseId, role: 'system', content: `${query} 系统消息`, createdAt: date });
    store.insert('messages', { id: 'other-message', caseId: other.id, role: 'user', content: `${query} 别的主题`, createdAt: date });
    store.insert('messages', { id: 'wildcard-message', caseId, role: 'user', content: '这句话的X校准号没有百分号和下划线。', createdAt: date });

    await store.updateSettings({ enabled: true });
    const search = await runtime.ingestOwnerMessage(`你还记得 ${query} 的那段对话吗？`, caseId);
    const anchor = store.get('messages', String(search.payload.messageId));
    assert.ok(anchor);
    store.insert('messages', { id: 'later-message', caseId, role: 'user', content: `${query} 后来的消息`, createdAt: anchor.createdAt });
    runtime.start();
    await assertProcessed(runtime, search.id);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].tools?.some(item => item.name === toolName));
    assert.doesNotMatch(JSON.stringify(calls[0].prompt), /旧用户消息|旧助手消息|只应在明确引用时带入的助手正文/);
    const result = calls[1].prompt.flatMap(message => message.role === 'tool' ? message.content : [])
      .find(part => part.type === 'tool-result' && part.toolName === toolName);
    assert.ok(result?.type === 'tool-result' && result.output.type === 'json');
    const output = result.output.value as { messages: { messageId: string; role: string; createdAt: string; excerpt: string;
      offset: number; totalCharacters: number }[] };
    assert.deepEqual(output.messages.map(message => message.messageId), ['old-user']);
    const userHit = output.messages.find(message => message.messageId === 'old-user')!;
    assert.equal(userHit.role, 'user');
    assert.equal(userHit.createdAt, date);
    assert.ok(userHit.excerpt.includes(`旧用户消息${query}命中之后`));
    assert.ok(userHit.excerpt.length < oldUser.length);
    assert.equal(userHit.totalCharacters, oldUser.length);
    assert.ok(userHit.offset > 0);
    assert.equal(userHit.excerpt, oldUser.slice(userHit.offset, userHit.offset + userHit.excerpt.length));
    const quoted = await runtime.ingestOwnerMessage('请继续解释这条。', caseId, 'old-assistant');
    await assertProcessed(runtime, quoted.id);
    assert.equal(calls.length, 3);
    const context = calls[2].prompt.flatMap(message => message.role === 'user' ? message.content : [])
      .find(part => part.type === 'text' && part.text.includes('请继续解释这条。'));
    assert.ok(context?.type === 'text');
    const { quotedMessage } = JSON.parse(context.text.slice(context.text.indexOf('\n') + 1));
    assert.equal(quotedMessage.messageId, 'old-assistant');
    assert.equal(quotedMessage.role, 'assistant');
    assert.equal(quotedMessage.createdAt, date);
    assert.equal(quotedMessage.truncated, true);
    assert.match(quotedMessage.content, /^只应在明确引用时带入的助手正文/);
    assert.ok(quotedMessage.content.length < oldAssistant.length);
    await assert.rejects(runtime.ingestOwnerMessage('试图跨主题引用。', other.id, 'old-assistant'), /不一致/);

    const feedback = await runtime.addFeedback({ targetType: 'message', targetId: 'old-assistant', verdict: 'useful', comment: '' });
    const feedbackEvent = runtime.inbox.list().find(event => event.kind === 'owner.feedback' && event.externalId === feedback.id);
    assert.ok(feedbackEvent);
    await assertProcessed(runtime, feedbackEvent.id);
    assert.equal(calls.length, 4);
    assert.ok(!calls[3].tools?.some(item => item.name === toolName));
    assert.deepEqual(await runtime.listTasks(), []);
    assert.deepEqual(store.list('artifacts'), []);
  } finally {
    try { await runtime.close(); } finally { store.close(); }
  }
});

test('semantic recall rechecks owner evidence, includes later corrections, and fences source reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-recall-scope-'));
  const store = new Store(directory);
  const runtime = await V2Coordinator.create(store, { dataDir: directory });
  try {
    const project = await runtime.createCase({ title: '项目', objective: '', domain: 'work' });
    const travel = await runtime.createCase({ title: '行程', objective: '', domain: 'travel' });
    const retired = new Set(['event-retired']);
    const personal = { retiredOwnerEvidence: async () => ({ eventIds: retired, values: ['旧隐私值'] }) };
    const observations = new ObservationContext({ store, inbox: runtime.inbox, sourceAllowed: () => true,
      retiredEvidence: personal.retiredOwnerEvidence });
    function owner(id: string, caseId: string, content: string, eventContent = content, payloadId = id) {
      store.insert('messages', { id, caseId, role: 'user', content, createdAt: date });
      runtime.inbox.ingest({ id: 'event-' + id, actor: 'owner', kind: 'owner.message', sourceId: 'owner-chat', externalId: id,
        operation: 'create', occurredAt: date, caseId, payload: { messageId: payloadId, content: eventContent } });
    }
    owner('old', project.id, '展演原定十三号。');
    owner('retired', project.id, '已撤回的本人原话。');
    owner('mismatch', project.id, '损坏的公开副本。', '原事件正文不同。');
    owner('invalid-provenance', project.id, '早年文字出现于损坏事件。', '早年文字出现于损坏事件。', 'wrong-payload-id');
    owner('corrected', project.id, '新确认安排是十六号上午。');
    store.insert('messages', { id: 'legacy', caseId: project.id, role: 'user', content: '旧隐私值和检索代号', createdAt: date });
    store.insert('messages', { id: 'legacy-allowed', caseId: project.id, role: 'user', content: '早年文字只可字面回查。', createdAt: date });
    store.insert('messages', { id: 'assistant-only', caseId: project.id, role: 'assistant', content: '助手推测', createdAt: date });
    owner('anchor', travel.id, '那次展示最终什么时候？');
    owner('same-ms-later', project.id, '与锚点同一毫秒但写入在后。');
    owner('foreign', 'not-an-owner-scene', '不存在的场景。');
    const signal = new AbortController().signal;
    const setup = () => createRecallSession({ store, cases: runtime.cases, inbox: runtime.inbox, personal, observations,
      caseId: travel.id, ownerMessageId: 'anchor', guard: () => {}, signal,
      async semanticSearch(_query, caseIds, receivedSignal) {
        assert.equal(receivedSignal, signal);
        assert.deepEqual(new Set(caseIds), new Set([project.id, travel.id]));
        return ['old', 'retired', 'mismatch', 'invalid-provenance', 'legacy', 'legacy-allowed', 'assistant-only', 'same-ms-later', 'foreign']
          .map(messageId => ({ messageId, caseId: project.id, score: 0.5 }));
      },
    }).tool;
    type RecallTool = ReturnType<typeof setup>;
    const call = async (tool: RecallTool, input: Parameters<NonNullable<RecallTool['execute']>>[0]) =>
      await tool.execute!(input, {} as never) as { reason?: string; messages: { messageId: string; match: string; excerpt: string }[] };
    const tool = setup();
    const hidden = await call(tool, { mode: 'messages', messageId: 'old' });
    assert.deepEqual(hidden.messages, []);
    const result = await call(tool, { mode: 'search', query: '那次展示', scope: 'all' });
    assert.deepEqual(result.messages.map(({ messageId, match }) => [messageId, match]), [
      ['old', 'semantic'], ['corrected', 'follow_up'],
    ]);
    assert.match(JSON.stringify(result.messages), /十六号上午/);
    retired.add('event-old');
    const revoked = await call(tool, { mode: 'messages', messageId: 'old' });
    assert.deepEqual(revoked.messages, []);
    const limited = await call(tool, { mode: 'search', query: '那次展示', scope: 'all' });
    assert.match(limited.reason ?? '', /上限/);

    const exact = setup();
    const lexical = await call(exact, { mode: 'search', query: '早年文字', scope: 'all' });
    assert.ok(lexical.messages.some(message => message.messageId === 'legacy-allowed' && message.match === 'literal'));
    assert.ok(lexical.messages.every(message => message.messageId !== 'invalid-provenance'));
    const original = await call(exact, { mode: 'messages', messageId: 'legacy-allowed' });
    assert.equal(original.messages[0]?.excerpt, '早年文字只可字面回查。');
    const withdrawn = await call(exact, { mode: 'search', query: '旧隐私值', scope: 'all' });
    assert.deepEqual(withdrawn.messages, []);
  } finally {
    try { await runtime.close(); } finally { store.close(); }
  }
});

test('a full literal result page still includes verified cross-scene semantic updates and later owner confirmations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-recall-merge-'));
  const store = new Store(directory);
  const runtime = await V2Coordinator.create(store, { dataDir: directory });
  try {
    const work = await runtime.createCase({ title: '项目', objective: '', domain: 'work' });
    const travel = await runtime.createCase({ title: '出差', objective: '', domain: 'travel' });
    function owner(id: string, caseId: string, content: string) {
      store.insert('messages', { id, caseId, role: 'user', content, createdAt: date });
      runtime.inbox.ingest({ id: 'event-' + id, actor: 'owner', kind: 'owner.message', sourceId: 'owner-chat', externalId: id,
        operation: 'create', occurredAt: date, caseId, payload: { messageId: id, content } });
    }
    for (let index = 0; index < 5; index++) owner('literal-' + index, work.id, `展示原计划十三日下午，第${index}次讨论。`);
    owner('semantic-update', travel.id, '客户说明会已改为十六日上午十点，请按新通知安排。');
    owner('first-anchor', work.id, '查一下展示安排。');
    const observations = new ObservationContext({ store, inbox: runtime.inbox, sourceAllowed: () => true,
      retiredEvidence: caseId => runtime.personal.retiredOwnerEvidence(caseId) });
    let semanticCalls = 0;
    const setup = (ownerMessageId: string) => createRecallSession({ store, cases: runtime.cases, inbox: runtime.inbox,
      personal: runtime.personal, observations, caseId: work.id, ownerMessageId, guard: () => {}, signal: new AbortController().signal,
      async semanticSearch() {
        semanticCalls++;
        return [
          { messageId: 'literal-4', caseId: work.id, score: 1 },
          { messageId: 'semantic-update', caseId: travel.id, score: 0.9 },
          { messageId: 'semantic-update', caseId: travel.id, score: 0.9 },
        ];
      },
    }).tool;
    type RecallResult = { messages: { messageId: string; match: string; excerpt: string }[] };
    const first = await setup('first-anchor').execute!({ mode: 'search', query: '展示', scope: 'all' }, {} as never) as RecallResult;
    assert.equal(semanticCalls, 1);
    assert.equal(first.messages.length, 5);
    assert.equal(new Set(first.messages.map(message => message.messageId)).size, 5);
    assert.ok(first.messages.some(message => message.messageId === 'semantic-update' && message.match === 'semantic'));
    assert.ok(first.messages.some(message => message.match === 'literal'));

    owner('later-confirmation', work.id, '我最后确认是十七日上午，前面的通知再次作了调整。');
    owner('second-anchor', work.id, '再确认一次展示安排。');
    const second = await setup('second-anchor').execute!({ mode: 'search', query: '展示', scope: 'all' }, {} as never) as RecallResult;
    assert.equal(semanticCalls, 2);
    assert.ok(second.messages.length <= 5);
    assert.ok(second.messages.some(message => message.messageId === 'semantic-update'));
    assert.ok(second.messages.some(message => message.messageId === 'later-confirmation' && message.match === 'follow_up'));
    assert.ok(second.messages.every(message => message.messageId !== 'second-anchor'));
  } finally {
    try { await runtime.close(); } finally { store.close(); }
  }
});

for (const scenario of [
  { name: 'a semantic notice overlapping an older literal hit retains its semantic position', query: '海棠', dominantScene: false },
  { name: 'one expanded scene cannot fill the semantic candidate window before another scene is considered', query: '那次客户活动', dominantScene: true },
]) test(scenario.name, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-recall-overlap-'));
  const store = new Store(directory);
  const runtime = await V2Coordinator.create(store, { dataDir: directory });
  try {
    const work = await runtime.createCase({ title: '项目', objective: '', domain: 'work' });
    const travel = await runtime.createCase({ title: '出差', objective: '', domain: 'travel' });
    function owner(id: string, caseId: string, content: string) {
      store.insert('messages', { id, caseId, role: 'user', content, createdAt: date });
      runtime.inbox.ingest({ id: 'event-' + id, actor: 'owner', kind: 'owner.message', sourceId: 'owner-chat', externalId: id,
        operation: 'create', occurredAt: date, caseId, payload: { messageId: id, content } });
    }
    const expanded = Array.from({ length: 25 }, (_, index) => {
      const id = 'expanded-' + index;
      owner(id, work.id, `早期准备记录${index}：尚未收到具体通知。`);
      return { messageId: id, caseId: work.id, score: 0.99 };
    });
    owner('latest-notice', travel.id, '海棠客户说明会已改为十六日上午十点，本人确认九点四十五到。');
    for (let index = 0; index < 7; index++) owner('recent-question-' + index, work.id, `海棠安排再核对一下，第${index}次提问。`);
    owner('anchor', work.id, '请核对当前安排。');
    const observations = new ObservationContext({ store, inbox: runtime.inbox, sourceAllowed: () => true,
      retiredEvidence: caseId => runtime.personal.retiredOwnerEvidence(caseId) });
    const notice = { messageId: 'latest-notice', caseId: travel.id, score: scenario.dominantScene ? 0.9 : 1 };
    const tool = createRecallSession({ store, cases: runtime.cases, inbox: runtime.inbox, personal: runtime.personal, observations,
      caseId: work.id, ownerMessageId: 'anchor', guard: () => {}, signal: new AbortController().signal,
      semanticSearch: async () => scenario.dominantScene ? [...expanded, ...expanded, notice] : [notice, ...expanded],
    }).tool;
    const result = await tool.execute!({ mode: 'search', query: scenario.query, scope: 'all' }, {} as never) as {
      messages: { messageId: string; match: string; readWith: { tool: string; arguments: { messageId: string } } }[];
    };
    const matched = result.messages.find(message => message.messageId === 'latest-notice');
    assert.ok(matched, 'The strongly matching notice must survive literal overlap and scene expansion');
    assert.equal(matched.match, 'semantic');
    assert.equal(matched.readWith.tool, 'recall');
    assert.equal(matched.readWith.arguments.messageId, 'latest-notice');
    assert.ok(result.messages.length <= 5);
    assert.equal(new Set(result.messages.map(message => message.messageId)).size, result.messages.length);
  } finally {
    try { await runtime.close(); } finally { store.close(); }
  }
});

test('owner chat can recall other scenes with provenance and current corrections without importing assistant-derived data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-scene-recall-'));
  const store = new Store(directory);
  store.getApiKey = () => undefined;
  const calls: ModelOptions[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    calls.push(options);
    return options.prompt.at(-1)?.role === 'user' ? {
      content: [{ type: 'tool-call', toolCallId: `scene-recall-${calls.length}`, toolName,
        input: JSON.stringify({ query, scope: 'all' }) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
    } : answer;
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const a = await runtime.createCase({ title: '项目背景', objective: '', domain: 'work' });
    const b = await runtime.createCase({ title: '出差准备', objective: '', domain: 'travel' });
    store.insert('messages', { id: 'scene-old-date', caseId: a.id, role: 'user', content: `${query} 演示原定13日。`, createdAt: date });
    store.insert('messages', { id: 'scene-corrected-date', caseId: a.id, role: 'user', content: `${query} 演示改为16日。`, createdAt: date });
    // These newer matches must be excluded before the five-hit limit, not filtered afterwards.
    for (let index = 0; index < 8; index++) {
      store.insert('messages', { id: `scene-derived-${index}`, caseId: a.id, role: 'assistant',
        content: `${query} WITHDRAWN_SOURCE_DERIVATION_${index}`, createdAt: date });
      store.insert('messages', { id: `scene-orphan-${index}`, caseId: 'not-an-owned-scene', role: 'user',
        content: `${query} OUTSIDE_OWNER_SCENES`, createdAt: date });
    }
    store.insert('messages', { id: 'scene-system', caseId: a.id, role: 'system', content: `${query} SYSTEM_ONLY`, createdAt: date });
    await runtime.updateCase(a.id, { title: '项目协作' });
    await runtime.correctPersonalMemory('scene.demo-date', { value: 'CURRENT_DATE_13', scope: 'global' });
    await runtime.correctPersonalMemory('scene.demo-date', { value: 'CURRENT_DATE_16' });
    const event = await runtime.ingestOwnerMessage(`接着 ${query} 的那件事。`, b.id);
    const anchor = store.get('messages', event.externalId)!;
    store.insert('messages', { id: 'scene-future', caseId: a.id, role: 'user', content: `${query} LATER_THAN_CURRENT_MESSAGE`, createdAt: anchor.createdAt });
    await store.updateSettings({ enabled: true });
    runtime.start();
    await assertProcessed(runtime, event.id);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(JSON.stringify(calls[0].prompt), /演示原定13日|演示改为16日/);
    assert.match(JSON.stringify(calls[0].prompt), /CURRENT_DATE_16/);
    assert.doesNotMatch(JSON.stringify(calls[0].prompt), /CURRENT_DATE_13/);
    const result = calls[1].prompt.flatMap(message => message.role === 'tool' ? message.content : [])
      .find(part => part.type === 'tool-result' && part.toolName === toolName);
    assert.ok(result?.type === 'tool-result' && result.output.type === 'json');
    const output = result.output.value as { scope: string; messages: { messageId: string; caseId: string; sceneTitle: string; role: string }[] };
    assert.equal(output.scope, 'all');
    assert.deepEqual(output.messages.map(message => message.messageId).sort(), ['scene-corrected-date', 'scene-old-date']);
    assert.ok(output.messages.every(message => message.caseId === a.id && message.sceneTitle === '项目协作' && message.role === 'user'));
    assert.doesNotMatch(JSON.stringify(calls[1].prompt), /WITHDRAWN_SOURCE_DERIVATION|OUTSIDE_OWNER_SCENES|SYSTEM_ONLY|LATER_THAN_CURRENT_MESSAGE/);

    await runtime.retractPersonalMemory('scene.demo-date');
    const next = await runtime.ingestOwnerMessage('再核对一次当前理解。', b.id);
    await assertProcessed(runtime, next.id);
    const system = calls[2].prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.match(system, /scene.demo-date/);
    assert.match(system, /retracted/);
    assert.doesNotMatch(system, /CURRENT_DATE_13|CURRENT_DATE_16/);
    assert.deepEqual(await runtime.listTasks(), []);
    assert.deepEqual(store.list('artifacts'), []);
  } finally {
    try { await runtime.close(); } finally { store.close(); }
  }
});
