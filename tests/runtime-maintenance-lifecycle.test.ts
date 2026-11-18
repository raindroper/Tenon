import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { TaskExecutor } from '../server/v2/task-execution.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(done => setImmediate(done));

test('shutdown drains a single source reconciliation while local reminders and lease heartbeats remain responsive', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const directory = await mkdtemp(join(tmpdir(), 'rae-maintenance-close-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory });
  const entered = gate(); const release = gate();
  let reconciliations = 0; let reminderTicks = 0; let leaseRenewals = 0;
  runtime.sources.reconcile = async () => { reconciliations++; entered.resolve(); await release.promise; };
  const executor = (runtime as unknown as { taskExecutor: TaskExecutor }).taskExecutor;
  executor.renewLeases = () => { leaseRenewals++; };
  const releaseWakes = runtime.inbox.releaseDueWakes.bind(runtime.inbox);
  runtime.inbox.releaseDueWakes = (...args) => { reminderTicks++; return releaseWakes(...args); };
  let closing: Promise<void> | undefined;
  try {
    context.mock.timers.tick(1000); await entered.promise;
    context.mock.timers.tick(60_000); await flush();
    assert.equal(reconciliations, 1);
    assert.equal(leaseRenewals, 2, 'Event heartbeats continue while source reconciliation is pending');
    assert.equal(reminderTicks, 61, 'Local reminders cannot wait behind a slow source scan');
    const ticksBeforeShutdown = reminderTicks;
    let acknowledged = false; closing = runtime.close().then(() => { acknowledged = true; });
    await flush(); assert.equal(acknowledged, false, 'Shutdown waits for already accepted maintenance');
    release.resolve(); await closing;
    assert.equal(reminderTicks, ticksBeforeShutdown, 'A resumed source scan cannot dispatch work after shutdown starts');
    context.mock.timers.tick(60_000); await flush();
    assert.equal(reconciliations, 1);
  } finally { release.resolve(); await closing; await runtime.close(); await flush(); store.close(); }
});
