import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomyText, dateTime, tokenUsageText } from '../client/lib/format.js';
import type { AgentStatus } from '../shared/types.js';

test('record details respect the owner timezone', () => {
  assert.equal(dateTime('2026-11-02T17:00:00Z', 'Asia/Shanghai'), '01:00');
  assert.equal(dateTime('2026-11-02T17:00:00Z', 'UTC'), '17:00');
  assert.equal(dateTime('invalid', 'Asia/Shanghai'), '');
});

test('unknown and partial token reports cannot appear as a complete zero usage or a bill', () => {
  assert.match(tokenUsageText({ inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' }), /未知/);
  assert.match(tokenUsageText({ inputTokens: 5, outputTokens: 0, usageStatus: 'partial' }), /已报告部分/);
  const complete = tokenUsageText({ inputTokens: 30, outputTokens: 10, usageStatus: 'reported' });
  assert.match(complete, /合计 40/); assert.doesNotMatch(complete, /¥|费用|未知|已报告部分/);
});

test('autonomy status distinguishes waiting, pending work and scheduled delivery without claiming continuous thinking', () => {
  const status: AgentStatus = { state: 'idle', pending: false, nextWakeAt: null, lastRunAt: null, lastError: null,
    todayUsage: { inputTokens: 0, outputTokens: 0, usageStatus: 'reported' } };
  assert.match(autonomyText(status, 'Asia/Shanghai'), /暂无定时安排/);
  const scheduled = { ...status, nextWakeAt: '2026-11-05T01:00:00Z' };
  assert.match(autonomyText(scheduled, 'Asia/Shanghai'), /下次计划唤醒/);
  assert.doesNotMatch(autonomyText(scheduled, 'Asia/Shanghai'), /下次思考/);
  assert.equal(autonomyText({ ...scheduled, pending: true }, 'Asia/Shanghai'), '有线索待处理。');
  assert.match(autonomyText({ ...scheduled, state: 'paused' }, 'Asia/Shanghai'), /已排提醒仍会投递/);
  assert.doesNotMatch(autonomyText({ ...scheduled, state: 'working' }, 'Asia/Shanghai'), /等待新消息/);
});
