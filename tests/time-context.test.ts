import test from 'node:test';
import assert from 'node:assert/strict';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evidenceTime, localDayRange, messageTime, temporalContext, zonedInstant, type TemporalContext } from '../shared/time.js';
import { createTimeContextProcessor } from '../server/v2/time-context.js';
import { usageDayWindow } from '../server/usage-day.js';
import { CaseMemory } from '../server/v2/memory.js';
import { EventInbox } from '../server/v2/events.js';
import { TaskContext } from '../server/v2/task-context.js';

test('instant projections compute local dates, weekdays, midnight and fractional offsets without host timezone', () => {
  assert.deepEqual(zonedInstant('2026-11-09T16:00:00.123Z', 'Asia/Shanghai'), {
    utc: '2026-11-09T16:00:00.123Z', timezone: 'Asia/Shanghai', localDate: '2026-11-10', localTime: '00:00:00', weekday: 2, offsetSeconds: 28800,
  });
  assert.equal(zonedInstant('2026-11-09T16:00:00Z', 'UTC').localDate, '2026-11-09');
  assert.equal(zonedInstant('2026-11-09T16:00:00Z', 'UTC').weekday, 1);
  const kathmandu = zonedInstant('2026-11-10T00:00:00Z', 'Asia/Kathmandu');
  assert.equal(kathmandu.localTime, '05:45:00'); assert.equal(kathmandu.offsetSeconds, 20700);
  const negative = zonedInstant('2026-11-10T00:00:00Z', 'America/St_Johns');
  assert.equal(negative.offsetSeconds, -12600); assert.equal(negative.localDate, '2026-11-09');
  assert.throws(() => zonedInstant('2026-11-10T09:00:00', 'Asia/Shanghai'), /offset/);
  assert.throws(() => zonedInstant('invalid', 'Asia/Shanghai'));
  assert.throws(() => zonedInstant(Date.now(), 'made-up/zone'));
});

test('each historical instant has its own DST offset through gaps and repeated local clock times', () => {
  const before = zonedInstant('2026-03-08T06:59:59Z', 'America/New_York');
  const after = zonedInstant('2026-03-08T07:00:00Z', 'America/New_York');
  assert.equal(before.localTime, '01:59:59'); assert.equal(before.offsetSeconds, -18000);
  assert.equal(after.localTime, '03:00:00'); assert.equal(after.offsetSeconds, -14400);
  assert.equal(before.weekday, 7); assert.equal(after.weekday, 7);
  const early = zonedInstant('2026-11-01T05:30:00Z', 'America/New_York');
  const late = zonedInstant('2026-11-01T06:30:00Z', 'America/New_York');
  assert.equal(early.localTime, '01:30:00'); assert.equal(late.localTime, '01:30:00');
  assert.equal(early.offsetSeconds, -14400); assert.equal(late.offsetSeconds, -18000);
  assert.notEqual(early.utc, late.utc);
});

test('local day ranges are half-open across DST and reject invalid or skipped calendar dates', () => {
  const shanghai = localDayRange('2026-11-10', 'Asia/Shanghai');
  assert.deepEqual(shanghai, { from: '2026-11-09T16:00:00.000Z', until: '2026-11-10T16:00:00.000Z' });
  for (const [day, from, until, hours] of [
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25],
  ] as const) {
    const range = localDayRange(day, 'America/New_York');
    assert.deepEqual(range, { from, until }); assert.equal((Date.parse(until) - Date.parse(from)) / 3600000, hours);
    assert.equal(zonedInstant(Date.parse(from) - 1, 'America/New_York').localDate < day, true);
    assert.equal(zonedInstant(from, 'America/New_York').localDate, day);
    assert.equal(zonedInstant(Date.parse(until) - 1, 'America/New_York').localDate, day);
    assert.equal(zonedInstant(until, 'America/New_York').localDate > day, true);
    assert.deepEqual(usageDayWindow(Date.parse(from) + 1000, 'America/New_York'), { from: Date.parse(from), until: Date.parse(until) });
  }
  assert.throws(() => localDayRange('2026-02-30', 'Asia/Shanghai'), /无效/);
  assert.throws(() => localDayRange('2026-1-1', 'Asia/Shanghai'), /YYYY/);
  assert.throws(() => localDayRange('2011-12-30', 'Pacific/Apia'), /不存在/);
});

test('message send times stay distinct from collection times and unknown speaker timezone is explicit', () => {
  const row = { sentAt: '2026-11-09T00:00:00Z', receivedAt: '2026-11-10T00:00:00Z' };
  const projected = messageTime(row, 'Asia/Shanghai');
  assert.equal(projected.sent?.localDate, '2026-11-09'); assert.equal(projected.received.localDate, '2026-11-10');
  assert.equal(projected.referenceTimezone, null);
  assert.equal(messageTime({ receivedAt: row.receivedAt }, 'Asia/Shanghai').sent, null);
  const wechat = evidenceTime({ kind: 'connector.change', sourceId: 'connector:group', occurredAt: row.receivedAt,
    receivedAt: row.receivedAt, payload: { provider: 'wechat-desktop', sentAt: row.sentAt, timezone: 'UTC' } }, 'Asia/Shanghai');
  assert.equal(wechat.occurredMeaning, 'collection'); assert.equal(wechat.sent?.utc, '2026-11-09T00:00:00.000Z');
  assert.equal(wechat.referenceTimezone, null, 'external timezone text cannot become a captured owner timezone');
  const owner = evidenceTime({ actor: 'owner', kind: 'owner.message', sourceId: 'owner-chat', occurredAt: row.sentAt,
    receivedAt: row.receivedAt, payload: { timezone: 'America/New_York' } }, 'Asia/Shanghai');
  assert.equal(owner.occurredMeaning, 'message_sent'); assert.equal(owner.referenceTimezone, 'America/New_York');
  assert.equal(evidenceTime({ kind: 'owner.source', occurredAt: row.sentAt, receivedAt: row.receivedAt }, 'UTC').sent, null);
  assert.equal(evidenceTime({ kind: 'owner.source', occurredAt: row.sentAt, receivedAt: row.receivedAt,
    payload: { sentAt: row.sentAt, timezone: 'UTC' } }, 'UTC').sent, null, 'arbitrary document fields do not turn a source into a sent message');
  const context = temporalContext(row.receivedAt, 'Asia/Shanghai', { at: row.sentAt, timezone: 'America/New_York' });
  assert.equal(context.reference?.at.localDate, '2026-11-08'); assert.equal(context.reference?.at.timezone, 'America/New_York');
  assert.equal(context.asOf.timezone, 'Asia/Shanghai');
});

test('request clock injection is fresh and immutable without changing execution clocks or inbox times', async () => {
  const realBefore = Date.now(); let now = Date.parse('2026-11-09T15:59:59Z'); const seen: TemporalContext[] = [];
  const processor = createTimeContextProcessor({ timezone: () => 'Asia/Shanghai', clock: () => now,
    reference: () => ({ at: '2026-11-08T16:00:00Z' }), onContext: value => seen.push(value) });
  type Args = Parameters<typeof processor.processLLMRequest>[0];
  const original = [{ role: 'system' as const, content: 'Stable runtime instructions.' },
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'Read saved evidence.' }] }];
  const before = JSON.stringify(original);
  const first = await processor.processLLMRequest({ prompt: original } as Args);
  now += 1000;
  const second = await processor.processLLMRequest({ prompt: first!.prompt! } as Args);
  assert.equal(JSON.stringify(original), before);
  assert.equal(seen[0].asOf.localDate, '2026-11-09'); assert.equal(seen[1].asOf.localDate, '2026-11-10');
  assert.equal(seen[1].reference?.at.localDate, '2026-11-09'); assert.equal(seen[1].reference?.originalTimezone, null);
  assert.equal(second!.prompt!.filter(message => message.role === 'system').length, 2);
  assert.deepEqual(second!.prompt![0], original[0], 'the dynamic clock must preserve the stable provider instruction prefix');
  assert.equal(second!.prompt!.at(-1)?.role, 'user');
  const inbox = new EventInbox(':memory:');
  try {
    const event = inbox.ingest({ sourceId: 'clock-test', externalId: 'clock-test', kind: 'fixture', actor: 'system',
      operation: 'create', occurredAt: new Date().toISOString(), payload: {} }).event;
    assert.ok(Date.parse(event.receivedAt) >= realBefore, 'context-only replay must not alter durable execution timestamps');
    assert.ok(Date.now() >= realBefore);
  } finally { inbox.close(); }
});

test('native multi-step model dispatch refreshes time without storing the prompt clock in history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-time-dispatch-'));
  const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`);
  type Options = Parameters<MockLanguageModelV4['doStream']>[0];
  type Part = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
  const prompts: Options[] = []; let now = Date.parse('2026-11-09T15:59:59Z');
  const model = new MockLanguageModelV4({ doStream: async options => {
    prompts.push(options);
    const parts: Part[] = [{ type: 'stream-start', warnings: [] }, ...(prompts.length === 1 ? [{ type: 'tool-call' as const,
      toolCallId: 'clock-turn', toolName: 'advance_fixture', input: '{}' }] : [
      { type: 'text-start' as const, id: 'text' }, { type: 'text-delta' as const, id: 'text', delta: '已核对。' }, { type: 'text-end' as const, id: 'text' }]),
      { type: 'finish', finishReason: { unified: prompts.length === 1 ? 'tool-calls' : 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }];
    return { stream: new ReadableStream({ start(controller) { parts.forEach(part => controller.enqueue(part)); controller.close(); } }) };
  } });
  try {
    const item = await memory.createCase({ title: '时间', objective: '核对模型请求时间', domain: 'fixture' });
    await memory.runCase({ caseId: item.id, model, instructions: '测试', message: '保留原话。', maxSteps: 2,
      temporal: { timezone: () => 'Asia/Shanghai', clock: () => now },
      tools: { advance_fixture: createTool({ id: 'advance_fixture', description: 'Advance isolated context clock', inputSchema: z.object({}),
        execute: async () => { now += 1000; return { advanced: true }; } }) } });
    assert.equal(prompts.length, 2);
    assert.match(JSON.stringify(prompts[0].prompt), /2026-11-09.*23:59:59/);
    assert.match(JSON.stringify(prompts[1].prompt), /2026-11-10.*00:00:00/);
    assert.doesNotMatch(JSON.stringify(await memory.history(item.id)), /本次请求的时间事实|offsetSeconds|asOf/);
  } finally { await memory.close(); }
});

test('task source reads and searches preserve send/receive provenance without rebinding the original event', () => {
  const inbox = new EventInbox(':memory:');
  try {
    const event = inbox.ingestProcessed({ sourceId: 'connector:group', sourceGeneration: 'group', externalId: 'row', kind: 'connector.change',
      caseId: 'scene', actor: 'external', operation: 'create', occurredAt: '2026-11-10T00:00:00Z', receivedAt: '2026-11-10T00:00:00Z',
      payload: { provider: 'wechat-desktop', content: '查找原话', sentAt: '2026-11-09T00:00:00Z' } });
    const before = JSON.stringify(inbox.get(event.id));
    const context = new TaskContext({ inbox, sources: { resolveEventCase: value => value.caseId, isEventAllowed: () => true }, timezone: () => 'Asia/Shanghai' });
    const search = context.search({ sourceCaseId: 'scene', query: '查找' }).events[0];
    const read = context.read({ spec: { caseId: 'scene' } as never }, event.id);
    assert.deepEqual(search.temporal, read.temporal);
    assert.equal(read.temporal.sent?.localDate, '2026-11-09'); assert.equal(read.temporal.received.localDate, '2026-11-10');
    assert.equal(read.temporal.occurredMeaning, 'collection'); assert.equal(read.temporal.referenceTimezone, null);
    assert.equal(JSON.stringify(inbox.get(event.id)), before);
  } finally { inbox.close(); }
});
