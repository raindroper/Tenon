import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeChatTools } from '../server/v2/wechat-tools.js';

test('WeChat tool reports exact match semantics, local calendar range, temporal provenance and exposed IDs', async () => {
  let queried: Record<string, unknown> | undefined;
  const exposed: string[][] = [];
  const row = { id: 'event', messageId: 'message', content: `${'正文'.repeat(310)}OwnerHandle`, title: 'Work',
    sentAt: '2026-11-10T07:47:05.000Z', receivedAt: '2026-11-10T07:47:32.593Z', senderName: 'Colleague', isSelf: false,
    messageType: 'text', partIndex: null, partCount: null };
  const access = { listWeChatConversations: () => [{ conversationId: 'conversation', title: 'Work', previousTitles: [], totalRows: 1 }],
    listWeChatTopicHints: () => [], queryWeChatMessages: (_caseId: string, _conversation: string, options: Record<string, unknown>) => {
      queried = options; return { events: [row], nextBefore: null, unknownTimeCount: 0 };
    } };
  const tools = createWeChatTools(access as never, 'scene', () => {}, undefined, () => 'Asia/Shanghai', { onEvidence: ids => exposed.push(ids) });
  const result = await tools.query_wechat_messages.execute!({ conversation: 'Work', query: 'OwnerHandle', sender: 'Colleague', localDate: '2026-11-10', limit: 10 }, {} as never) as any;
  assert.equal(queried?.from, '2026-11-09T16:00:00.000Z'); assert.equal(queried?.until, '2026-11-10T16:00:00.000Z');
  assert.equal(result.matchScope.query, 'content_substring'); assert.equal(result.matchScope.sender, 'sender_name_substring');
  assert.equal(result.matchScope.untilExclusive, queried?.until); assert.equal(result.matchScope.completeConversationHistory, false);
  assert.equal(result.events[0].temporal.sent.localTime, '15:47:05');
  assert.equal(result.events[0].truncated, true); assert.doesNotMatch(result.events[0].content, /OwnerHandle/);
  assert.deepEqual(result.events[0].readWith, { tool: 'read_event', eventId: 'event', offset: 0 });
  assert.deepEqual(exposed, [['event']]);
  assert.match(result.meaning, /零命中不能说明发送人没有发言/);
});

test('unknown send time stays null in the queried temporal projection', async () => {
  const access = { listWeChatConversations: () => [{ conversationId: 'conversation', title: 'Work', previousTitles: [] }], listWeChatTopicHints: () => [],
    queryWeChatMessages: () => ({ events: [{ id: 'legacy', messageId: 'legacy', content: 'Unknown send time', title: 'Work', sentAt: null,
      receivedAt: '2026-11-10T00:30:00Z', senderName: null, isSelf: null, messageType: 'text', partIndex: null, partCount: null }], nextBefore: null, unknownTimeCount: 1 }) };
  const tools = createWeChatTools(access as never, 'scene', () => {});
  const result = await tools.query_wechat_messages.execute!({ conversation: 'Work', limit: 10 }, {} as never) as any;
  assert.equal(result.events[0].temporal.sent, null); assert.equal(result.events[0].temporal.received.localTime, '08:30:00');
  assert.equal(result.events[0].temporal.referenceTimezone, null);
});
