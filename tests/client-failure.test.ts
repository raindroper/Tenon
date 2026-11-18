import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEventSummary, RuntimeMessage } from '../shared/runtime-view.js';
import { failedReplies, messageOutputText, runStateText } from '../client/lib/run-state.js';

const createdAt = '2026-11-04T08:00:00.000Z';
const message = (id: string, caseId = 'current', role: RuntimeMessage['role'] = 'user'): RuntimeMessage => ({ id, caseId, role, content: 'fixture', createdAt });
const event = (id: string, messageId: string, changes: Partial<RuntimeEventSummary> = {}): RuntimeEventSummary => ({
  id, messageId, sourceId: 'owner-chat', kind: 'owner.message', operation: 'create', status: 'failed', occurredAt: createdAt,
  caseId: 'current', attempts: 1, lastError: 'fixture failure', ...changes,
});

test('retry affordances attach only to failed owner messages in the matching conversation', () => {
  const messages = [message('owner'), message('assistant', 'current', 'assistant'), message('foreign', 'other')];
  const genuine = event('failed', 'owner');
  const failures = failedReplies([
    genuine,
    event('pending', 'owner', { status: 'pending' }),
    event('processed', 'owner', { status: 'processed' }),
    event('assistant-target', 'assistant'),
    event('wrong-case', 'owner', { caseId: 'other' }),
    event('wrong-kind', 'owner', { kind: 'workspace.file' }),
    event('foreign-target', 'foreign'),
    event('missing-target', 'missing'),
  ], messages);
  assert.deepEqual([...failures], [['owner', genuine]]);
  assert.deepEqual(failedReplies([genuine], [message('another-message')]).size, 0);
  assert.deepEqual(failedReplies([{ ...genuine, status: 'processed' }], messages).size, 0, 'a recovered event removes its failure affordance');
});

test('limited rounds remain distinguishable from finished work and failed transport', () => {
  assert.match(runStateText({ status: 'completed', mode: 'growth', stopReason: 'output_limit' }), /输出上限.*未完成/);
  assert.match(runStateText({ status: 'completed', mode: 'growth', stopReason: 'step_limit' }), /步数上限.*未完成/);
  assert.match(runStateText({ status: 'failed', mode: 'growth', stopReason: 'no_progress' }), /重复操作无进展/);
  assert.match(runStateText({ status: 'completed', mode: 'growth', reviewOutcome: 'needs_input' }), /待本人补充/);
  assert.equal(runStateText({ status: 'failed', mode: 'growth' }), '运行失败');
  assert.equal(runStateText({ status: 'interrupted' }), '已中断');
  assert.equal(runStateText({ status: 'completed', mode: 'growth' }), '本轮结束');
  assert.match(runStateText({ status: 'completed', mode: 'execution' }), /成果待验收/);
});

test('partial output remains distinguishable while streaming, after a failure and for legacy completed messages', () => {
  assert.equal(messageOutputText({}), '');
  assert.equal(messageOutputText({ outputState: 'complete' }), '');
  assert.equal(messageOutputText({ outputState: 'streaming' }, { status: 'running' }), '正在生成…');
  assert.match(messageOutputText({ outputState: 'streaming' }, { status: 'interrupted' }), /未完成.*已保留/);
  assert.match(messageOutputText({ outputState: 'streaming', outputNote: '正在补充剩余回复。' }, { status: 'failed' }), /未完成.*已保留/);
  assert.match(messageOutputText({ outputState: 'incomplete' }), /未完成.*已保留/);
  assert.equal(messageOutputText({ outputState: 'streaming', outputNote: '正在补充剩余回复。' }, { status: 'running' }), '正在补充剩余回复。');
  assert.equal(messageOutputText({ outputState: 'incomplete', outputNote: '模型连接中断，已生成部分保留。' }, { status: 'failed' }), '模型连接中断，已生成部分保留。');
});
