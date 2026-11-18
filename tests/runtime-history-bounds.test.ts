import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { exportRuntimeData } from '../server/index.js';
import { routeRuntime } from '../server/v2/http.js';
import { usageDayWindow } from '../server/usage-day.js';
import type { RuntimeEventSummary, RuntimeHistoryPage, RuntimeRun } from '../shared/runtime-view.js';

test('chat snapshots stay bounded with 50k archived events and 5k historical runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-history-bounds-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory });
  try {
    const item = await runtime.createCase({ title: 'History fixture', objective: 'Bound current views, retain history', domain: 'test' });
    const db = new DatabaseSync(join(directory, 'v2-events.sqlite'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare('INSERT INTO events(id,source_id,external_id,version,operation,json,status) VALUES(?,?,?,?,?,?,?)');
      for (let index = 0; index < 50_000; index++) {
        const event = { id: `old-event-${index}`, sourceId: 'fixture', externalId: `external-${index}`, kind: 'connector.change',
          operation: 'create', occurredAt: '2020-01-01T00:00:00.000Z', receivedAt: '2020-01-01T00:00:00.000Z',
          payload: { content: 'A short historical observation.' }, actor: 'external', caseId: item.id };
        insert.run(event.id, event.sourceId, event.externalId, '', 'create', JSON.stringify(event), 'processed');
      }
      db.exec('COMMIT');
    } finally { db.close(); }
    store.atomic(() => {
      for (let index = 0; index < 5_000; index++) store.insert('runs', { id: `old-run-${index}`, trigger: 'chat', mode: 'growth',
        status: 'completed', startedAt: '2020-01-01T00:00:00.000Z', steps: 2, inputTokens: 200, outputTokens: 50,
        usageStatus: 'reported', caseId: item.id });
    });
    const originalList = store.list.bind(store);
    const reads: Array<{ sql: string; parameters: unknown[]; rows: number }> = [];
    const originalPrepare = DatabaseSync.prototype.prepare;
    let snapshot;
    try {
      store.list = ((name: Parameters<Store['list']>[0]) => {
        assert.notEqual(name, 'runs', 'live state must not load every historical run');
        return originalList(name);
      }) as Store['list'];
      DatabaseSync.prototype.prepare = function (sql: string) {
        const statement = originalPrepare.call(this, sql);
        return new Proxy(statement, { get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'all' || property === 'get') return (...parameters: unknown[]) => {
            const result = Reflect.apply(value, target, parameters);
            reads.push({ sql, parameters, rows: Array.isArray(result) ? result.length : result ? 1 : 0 }); return result;
          };
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      snapshot = await runtime.snapshot({ caseId: item.id });
    } finally { store.list = originalList; DatabaseSync.prototype.prepare = originalPrepare; }
    assert.ok(snapshot.events.length <= 80, 'events are a bounded recent page plus visible-message associations');
    assert.ok(snapshot.runs.length <= 80, 'runs are a bounded recent page plus visible-message associations');
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 100_000, 'short historical metadata cannot inflate current state');
    assert.deepEqual(snapshot.status.todayUsage, { inputTokens: 0, outputTokens: 0, usageStatus: 'reported' });
    assert.ok(snapshot.history.runs.nextBefore); assert.ok(snapshot.history.events.nextBefore);
    assert.ok(reads.every(read => read.rows <= 41), 'no SQL read may materialize an entire historical table');
    const usageRead = reads.find(read => /SUM\(/.test(read.sql) && /kind='runs'/.test(read.sql));
    assert.ok(usageRead);
    const records = new DatabaseSync(join(directory, 'rae.sqlite'));
    try {
      const plan = records.prepare(`EXPLAIN QUERY PLAN ${usageRead.sql}`).all(...usageRead.parameters as string[]);
      assert.match(JSON.stringify(plan), /SEARCH records USING INDEX records_run_usage_day/);
      const historyRead = reads.find(read => /kind='runs'/.test(read.sql) && /LIMIT 41/.test(read.sql));
      assert.ok(historyRead);
      const historyPlan = JSON.stringify(records.prepare(`EXPLAIN QUERY PLAN ${historyRead.sql}`).all(...historyRead.parameters as string[]));
      assert.match(historyPlan, /records_history_order/);
      assert.doesNotMatch(historyPlan, /TEMP B-TREE/, 'same-time runs must use the index order instead of sorting all history');
    } finally { records.close(); }
    const exported = await exportRuntimeData(store, runtime);
    assert.equal(exported.events.length, 50_000); assert.equal(exported.runs.length, 5_000);
    assert.equal(new Set(exported.events.map(event => event.id)).size, 50_000);
    assert.equal(exported.events[0].id, 'old-event-0'); assert.equal(exported.events.at(-1)?.id, 'old-event-49999');
    assert.equal(exported.runs[0].id, 'old-run-0'); assert.equal(exported.runs.at(-1)?.id, 'old-run-4999');
  } finally { await runtime.close(); store.close(); }
});

test('history pagination preserves same-time records and current-page old failures and run links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-history-associations-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory });
  try {
    const item = await runtime.createCase({ title: 'Current conversation', objective: 'Keep exact old reply state', domain: 'test' });
    const other = await runtime.createCase({ title: 'Other conversation', objective: 'Independent activity', domain: 'test' });
    const owner = await runtime.ingestOwnerMessage('Original question', item.id);
    const claim = runtime.inbox.claim(1, 60_000, [owner.id])[0]; runtime.inbox.fail(owner.id, 'Original failure', claim.leaseToken!);
    const timestamp = '2020-01-01T00:00:00.000Z';
    store.insert('runs', { id: 'old-run', caseId: item.id, eventId: owner.id, trigger: 'chat', status: 'failed', startedAt: timestamp, steps: 1, inputTokens: 1, outputTokens: 1 });
    store.insert('messages', { id: 'old-response', caseId: item.id, runId: 'old-run', role: 'assistant', createdAt: timestamp, content: 'Preserved text', outputState: 'incomplete' });
    for (let index = 0; index < 90; index++) {
      runtime.inbox.ingestProcessed({ id: `later-${index}`, sourceId: 'fixture', externalId: `later-${index}`, kind: 'fixture',
        actor: 'system', caseId: other.id, operation: 'create', occurredAt: timestamp, payload: {} });
      store.insert('runs', { id: `later-run-${index}`, caseId: other.id, trigger: 'timer', status: 'completed', startedAt: timestamp, steps: 1, inputTokens: 1, outputTokens: 1 });
    }
    const snapshot = await runtime.snapshot({ caseId: item.id });
    assert.ok(snapshot.runs.some(run => run.id === 'old-run'));
    assert.ok(snapshot.events.some(event => event.id === owner.id && event.status === 'failed'));
    assert.ok(!snapshot.history.runs.items.some(run => run.id === 'old-run'));
    const first = await routeRuntime(runtime, '/api/history/runs', 'GET');
    const page = first.body as RuntimeHistoryPage<RuntimeRun>;
    assert.equal(page.items.length, 40); assert.equal(page.items[0].id, 'later-run-50');
    const older = await runtime.history({ kind: 'runs', before: page.nextBefore! });
    assert.equal(older.items.at(-1)?.id, 'later-run-49');
    const scoped = await runtime.history({ kind: 'events', caseId: item.id }) as RuntimeHistoryPage<RuntimeEventSummary>;
    assert.deepEqual(scoped.items.map(event => event.id), [owner.id]); assert.equal(scoped.nextBefore, null);
    await assert.rejects(runtime.history({ kind: 'runs', caseId: item.id, before: page.nextBefore! }), /游标无效/);
    await assert.rejects(runtime.history({ kind: 'events', before: 'missing-event' }), /游标无效/);
    await assert.rejects(routeRuntime(runtime, '/api/history/runs', 'GET', undefined, new URLSearchParams('limit=50000')));
  } finally { await runtime.close(); store.close(); }
});

test('task execution looks up one task in revision order without scanning unrelated runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-run-index-'));
  const store = new Store(directory);
  const start = '2026-11-07T00:00:00.000Z';
  const run = { status: 'failed' as const, trigger: 'manual' as const, startedAt: start, steps: 2, inputTokens: 0, outputTokens: 0 };
  try {
    store.atomic(() => {
      for (let index = 0; index < 1_000; index++) store.insert('runs', { ...run, id: `unrelated-${index}`,
        taskId: `other-${index}`, taskExecution: { requirementsRevision: 1, deadline: null, stepLimit: null } });
      store.insert('runs', { ...run, id: 'older-legacy', taskId: 'selected' });
      store.insert('runs', { ...run, id: 'revision-two', taskId: 'selected', taskExecution: { requirementsRevision: 2, deadline: null, stepLimit: null } });
      store.insert('runs', { ...run, id: 'revision-one', taskId: 'selected', taskExecution: { requirementsRevision: 1, deadline: null, stepLimit: 8 } });
      store.insert('runs', { ...run, id: 'revision-two-later', taskId: 'selected', taskExecution: { requirementsRevision: 2, deadline: null, stepLimit: null } });
    });
    const statements: string[] = [];
    const originalPrepare = DatabaseSync.prototype.prepare;
    try {
      DatabaseSync.prototype.prepare = function (sql: string) {
        statements.push(sql);
        return originalPrepare.call(this, sql);
      };
      const history = store.taskExecutionRuns('selected');
      assert.deepEqual(history.map(item => item.id), ['revision-one', 'revision-two', 'revision-two-later']);
      assert.equal(history[0].taskExecution?.stepLimit, 8);
      assert.equal(store.latestTaskExecutionRun('selected')?.id, 'revision-two-later');
      assert.equal(store.latestTaskExecutionRun('missing'), undefined);
    } finally { DatabaseSync.prototype.prepare = originalPrepare; }
    const db = new DatabaseSync(join(directory, 'rae.sqlite'), { readOnly: true });
    try {
      for (const sql of statements) {
        const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('selected'));
        assert.match(plan, /SEARCH records USING INDEX records_task_execution_order/);
        assert.doesNotMatch(plan, /TEMP B-TREE/);
      }
    } finally { db.close(); }
  } finally { store.close(); }
});

test('daily usage boundaries include owner timezone offsets and DST without scanning old runs', async () => {
  for (const [date, timezone, from, until] of [
    ['2026-11-06T12:00:00Z', 'Asia/Shanghai', '2026-11-05T16:00:00.000Z', '2026-11-06T16:00:00.000Z'],
    ['2026-03-08T12:00:00Z', 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01T12:00:00Z', 'America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
  ]) {
    const window = usageDayWindow(Date.parse(date), timezone);
    assert.equal(new Date(window.from).toISOString(), from); assert.equal(new Date(window.until).toISOString(), until);
  }
  const directory = await mkdtemp(join(tmpdir(), 'rae-history-usage-')); const store = new Store(directory); store.getApiKey = () => undefined;
  try {
    await store.updateSettings({ timezone: 'Asia/Shanghai' });
    const window = usageDayWindow(Date.now(), 'Asia/Shanghai');
    const run = (id: string, at: number, usageStatus?: 'reported' | 'partial') => store.insert('runs', { id, trigger: 'chat',
      status: 'completed', startedAt: new Date(at).toISOString(), steps: 1, inputTokens: 5, outputTokens: 2, ...(usageStatus ? { usageStatus } : {}) });
    run('previous-day', window.from - 1); run('tomorrow', window.until); run('today-start', window.from, 'reported');
    assert.deepEqual(store.todayUsage(), { inputTokens: 5, outputTokens: 2, usageStatus: 'reported' });
    run('partial', window.from + 1, 'partial'); assert.equal(store.todayUsage().usageStatus, 'partial');
    run('unknown', window.from + 2); assert.equal(store.todayUsage().usageStatus, 'unknown');
  } finally { store.close(); }
});
