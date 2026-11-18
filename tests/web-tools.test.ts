import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventInbox } from '../server/v2/events.js';
import { createWebTools, type WebExecutor } from '../server/v2/web-tools.js';
import type { WebToolResult } from '../server/web/hub-webtools.js';

interface Observation { status: string; content: string; sources: Array<{ title: string; url: string }>; evidenceId?: string;
  basis: string; untrusted: boolean; sourceNote?: string; truncated?: boolean; total?: number; nextOffset?: number | null; instructionMeaning?: string; readMore?: string }
const source = { title: 'Fixture source', url: 'https://example.com/source' };
const ok = (content = 'Hub依据联网结果生成的整理。'): WebToolResult => ({ status: 'ok', content, sources: [source] });
function fixture(run: WebExecutor['run'], file = ':memory:') {
  const inbox = new EventInbox(file); const controller = new AbortController();
  const origin = inbox.ingestProcessed({ sourceId: 'owner-chat', externalId: 'owner-query', actor: 'owner', caseId: 'case-a',
    kind: 'owner.message', operation: 'create', occurredAt: new Date().toISOString(), payload: { content: '查阅公开资料。' } });
  const context = { caseId: 'case-a', runId: 'run-a', originEventId: origin.id, inbox, web: { run }, signal: controller.signal, guard() {} };
  const tools = createWebTools(context);
  return { inbox, origin, controller, context, tools,
    async call(input: Record<string, unknown>): Promise<Observation> { return await tools.web_search.execute!(input as never, {} as never) as Observation; },
    close() { inbox.close(); } };
}

test('Hub search summaries retain validated citations and scoped tracing without claiming fetched original documents', async () => {
  const calls: Array<{ operation: string; args: Record<string, unknown>; signal: AbortSignal }> = [];
  const f = fixture(async (operation, args, signal) => { calls.push({ operation, args, signal }); return { ...ok(),
    sourceNote: 'Source: Wikipedia (not general web search)', sources: [source, { title: 'Bad URL', url: 'javascript:alert(1)' }] }; });
  try {
    assert.deepEqual(Object.keys(f.tools), ['web_search'], 'No fake original-page fetch capability is exposed');
    const result = await f.call({ query: '中文查询\n第二行', count: 4 });
    assert.equal(result.status, 'ok'); assert.equal(result.basis, 'gateway_summary'); assert.equal(result.untrusted, true);
    assert.deepEqual(result.sources, [source]); assert.match(result.sourceNote ?? '', /Wikipedia/);
    assert.match(result.instructionMeaning ?? '', /不是网页原文或独立验证证据/); assert.match(result.readMore ?? '', /不会取得.*原文/);
    assert.ok(result.evidenceId); const observation = f.inbox.get(result.evidenceId)!;
    assert.equal(observation.status, 'processed'); assert.equal(observation.actor, 'external'); assert.equal(observation.kind, 'web.search');
    assert.equal(observation.payload.basis, 'gateway_summary'); assert.equal(observation.payload.originEventId, f.origin.id);
    assert.equal(observation.caseId, 'case-a'); assert.equal(observation.causationId, f.origin.id); assert.equal(observation.sourceId, 'web:run-a');
    assert.deepEqual(calls[0].args, { query: '中文查询\n第二行', num_results: 4 }); assert.equal(calls[0].signal, f.controller.signal);
    assert.equal(f.inbox.hasPending(), false); assert.equal(f.inbox.captureObservations(() => true), 0); assert.equal(f.inbox.nextObservationAt(), null);
    assert.equal(f.inbox.findForCase('case-b', '', 10, () => true).length, 0);
    const repeated = await f.call({ query: '中文查询\n第二行', count: 4 });
    assert.equal(repeated.evidenceId, result.evidenceId); assert.equal(f.inbox.list().length, 2);
  } finally { f.close(); }
});

test('research exposes the durable public-search receipt to the current review once the search succeeds', async () => {
  const f = fixture(async () => ok('有关方案可行性的带来源摘要。'));
  try {
    const exposed: string[] = [];
    const tools = createWebTools({ ...f.context, onEvidence: ids => exposed.push(...ids) });
    const result = await tools.web_search.execute!({ query: '比较可行方案', count: 5 }, {} as never) as Observation;
    assert.deepEqual(exposed, [result.evidenceId]);
    assert.equal(f.inbox.get(exposed[0])?.status, 'processed');
    assert.equal(f.inbox.get(exposed[0])?.payload.basis, 'gateway_summary');
  } finally { f.close(); }
});

test('empty, failed and ungrounded summaries never become evidence', async () => {
  const results: WebToolResult[] = [
    { status: 'empty', content: 'No results found', sources: [] },
    { status: 'unavailable', content: 'Search temporarily unavailable', sources: [] },
    { status: 'error', content: 'Tool unavailable', sources: [] },
    { status: 'ok', content: 'Ungrounded answer', sources: [] },
    { status: 'ok', content: '', sources: [source] },
  ];
  const f = fixture(async () => results.shift()!);
  try {
    for (const status of ['empty', 'unavailable', 'error', 'error', 'empty']) {
      const result = await f.call({ query: 'query' });
      assert.equal(result.status, status); assert.equal(result.evidenceId, undefined); assert.equal(result.basis, 'gateway_summary');
      assert.equal(f.inbox.list().length, 1); assert.equal(f.inbox.hasPending(), false);
    }
  } finally { f.close(); }
});

test('large gateway summaries are retained for read_event pagination with honest content labeling', async () => {
  const text = '整理文本'.repeat(30000); const f = fixture(async () => ok(text));
  try {
    const result = await f.call({ query: 'query' }); assert.ok(result.evidenceId);
    assert.equal(result.content.length, 12000); assert.equal(result.total, 100000); assert.equal(result.nextOffset, 12000);
    assert.equal(result.truncated, true); assert.equal(f.inbox.get(result.evidenceId)?.payload.content, text.slice(0, 100000));
    assert.match(result.readMore ?? '', /更多整理文本/); assert.equal(result.basis, 'gateway_summary');
  } finally { f.close(); }
});

test('invalid inputs, mismatched cases and late results cannot trigger network use or persist another case observation', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return ok(); });
  try {
    for (const value of [{ query: 'a' }, { query: 'a'.repeat(501) }, { query: 'query', count: 11 }, { query: 'query', injected: true }]) {
      const result = await f.call(value).catch(() => undefined); assert.notEqual(result?.status, 'ok'); assert.equal(result?.evidenceId, undefined);
    }
    const other = createWebTools({ ...f.context, caseId: 'case-b' });
    await assert.rejects(other.web_search.execute!({ query: 'query', count: 5 }, {} as never), /当前真实事项事件/); assert.equal(calls, 0);
  } finally { f.close(); }
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const late = fixture(async () => { await gate; return ok(); });
  try {
    const pending = late.call({ query: 'query' }); const rejection = assert.rejects(pending); late.controller.abort(); release(); await rejection;
    assert.equal(late.inbox.list().length, 1); assert.equal(late.inbox.hasPending(), false);
  } finally { release(); late.close(); }
});

test('failed summary status persistence atomically rolls back its evidence insert', async () => {
  const prefix = join(tmpdir(), 'rae-web-summary-'); const directory = await mkdtemp(prefix); const file = join(directory, 'events.sqlite');
  const f = fixture(async () => ok(), file); const fault = new DatabaseSync(file);
  try {
    fault.exec(`CREATE TRIGGER reject_web_processed BEFORE UPDATE OF status ON events
      WHEN NEW.status='processed' AND json_extract(NEW.json,'$.kind')='web.search'
      BEGIN SELECT RAISE(ABORT, 'fixture summary failure'); END;`);
    await assert.rejects(f.call({ query: 'query' }), /fixture summary failure/);
    assert.equal(f.inbox.list().length, 1); assert.equal(f.inbox.hasPending(), false);
  } finally { fault.close(); f.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
});
