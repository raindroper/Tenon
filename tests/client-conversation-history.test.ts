import test from 'node:test';
import assert from 'node:assert/strict';
import { prependConversationPage, reconcileConversationPage, type ConversationPage } from '../client/state/useConversationHistory.js';
import type { RuntimeEventSummary, RuntimeMessage, RuntimeRun } from '../shared/runtime-view.js';

const timestamp = '2026-11-13T02:00:00.000Z';
const message = (id: string, changes: Partial<RuntimeMessage> = {}): RuntimeMessage => ({
  id, caseId: 'scene', role: 'assistant', content: 'Partial', createdAt: timestamp, runId: 'run', outputState: 'streaming', ...changes,
});
const event = (changes: Partial<RuntimeEventSummary> = {}): RuntimeEventSummary => ({
  id: 'event', caseId: 'scene', messageId: 'owner', kind: 'owner.message', sourceId: 'owner-chat', operation: 'create',
  status: 'leased', occurredAt: timestamp, attempts: 1, lastError: null, ...changes,
});
const run = (changes: Partial<RuntimeRun> = {}): RuntimeRun => ({
  id: 'run', caseId: 'scene', eventId: 'event', trigger: 'chat', mode: 'growth', status: 'running', startedAt: timestamp,
  steps: 1, inputTokens: 10, outputTokens: 5, usageStatus: 'reported', ...changes,
});
const page = (messages: RuntimeMessage[], changes: Partial<ConversationPage> = {}): ConversationPage => ({
  conversation: { caseId: 'scene', before: null, beforeCreatedAt: null, nextBefore: 'older-cursor' },
  messages, events: [], runs: [], ...changes,
});

test('browsed replies retain completion and run receipts after rolling out of the live page', () => {
  const partial = message('reply');
  const retained = page([partial], { runs: [run()] });
  const complete = message('reply', { content: 'Complete public answer', outputState: 'complete' });
  const completedRun = run({ status: 'completed', endedAt: timestamp });
  const observed = reconcileConversationPage(retained, page([complete, message('new-message')], { runs: [completedRun] }));
  const rolled = reconcileConversationPage(observed, page([message('new-message')], { runs: [] }));
  assert.deepEqual(rolled.messages, [complete], 'live messages must not extend the fixed browsing window');
  assert.deepEqual(rolled.runs, [completedRun]);
  assert.equal(rolled.conversation, retained.conversation, 'live cursors must not skip older history');
  assert.equal(rolled, observed, 'an unrelated live update requires no retained-window write');
  assert.equal(retained.messages[0], partial, 'reconciliation must not mutate the previous snapshot');
});

test('the retained owner message follows retries and processed events without retaining unrelated activity', () => {
  const owner = message('owner', { role: 'user', content: 'Owner request', runId: undefined, outputState: undefined });
  const retained = page([owner], { events: [event({ status: 'failed', lastError: 'Old failure' })], runs: [run({ status: 'failed' })] });
  const processed = event({ status: 'processed', attempts: 2 });
  const retry = run({ id: 'retry', status: 'completed', endedAt: timestamp });
  const updated = reconcileConversationPage(retained, page([message('new-message')], {
    events: [processed, event({ id: 'unrelated-event', messageId: 'new-message' })],
    runs: [retry, run({ id: 'unrelated-run', eventId: 'unrelated-event' })],
  }));
  assert.deepEqual(updated.events, [processed]);
  assert.deepEqual(updated.runs.map(item => item.id), ['run', 'retry']);
  assert.equal(updated.runs[1], retry);
  const laterReceipt = { ...retry, outputTokens: 20 };
  const withoutEvent = reconcileConversationPage(updated, page([], { runs: [laterReceipt] }));
  assert.equal(withoutEvent.runs[1], laterReceipt, 'retained provenance still links a run after its event leaves the live page');
});

test('an older page arriving after a live completion keeps the latest retained message and receipt', () => {
  const owner = message('owner', { role: 'user', runId: undefined });
  const initial = page([owner, message('reply')], { events: [event()], runs: [run()] });
  const complete = message('reply', { content: 'Final answer', outputState: 'complete' });
  const processed = event({ status: 'processed' });
  const finished = run({ status: 'completed', endedAt: timestamp });
  const current = reconcileConversationPage(initial, page([owner, complete], { events: [processed], runs: [finished] }));
  const older = page([message('older'), owner, message('reply')], {
    conversation: { ...initial.conversation, before: 'older-cursor', nextBefore: 'next-older-cursor' },
    events: [event()], runs: [run()],
  });
  const merged = prependConversationPage(older, current);
  assert.deepEqual(merged.messages.map(item => item.id), ['older', 'owner', 'reply']);
  assert.equal(merged.messages.at(-1), complete);
  assert.deepEqual(merged.events, [processed]);
  assert.deepEqual(merged.runs, [finished]);
  assert.equal(merged.conversation.nextBefore, 'next-older-cursor');
});

test('reconciliation ignores another scene and preserves references when there is no new evidence', () => {
  const retained = page([message('reply')]);
  const elsewhere = page([message('reply', { caseId: 'other', content: 'Other scene' })], {
    conversation: { ...retained.conversation, caseId: 'other' },
  });
  assert.equal(reconcileConversationPage(retained, elsewhere), retained);
  assert.equal(reconcileConversationPage(retained, retained), retained);
});
