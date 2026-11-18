import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CaseMemory } from '../server/v2/memory.js';

test('a concurrent case metadata update cannot overwrite the later working-state write', async context => {
  const prefix = join(tmpdir(), 'rae-case-race-'); const directory = mkdtempSync(prefix);
  const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`);
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  try {
    const item = await memory.createCase({ title: 'race', objective: 'preserve updates', domain: 'test' });
    await memory.setWorking(item.id, 'OLD_WORKING');
    type Update = (input: { id: string; title?: string; metadata?: Record<string, unknown> }) => Promise<unknown>;
    const native = (memory as unknown as { memory: { updateThread: Update } }).memory;
    const original = native.updateThread.bind(native); let entered!: () => void;
    const reached = new Promise<void>(resolveReached => { entered = resolveReached; });
    native.updateThread = async input => { entered(); await gate; return original(input); };
    const update = memory.updateCase(item.id, { status: 'waiting' });
    await reached;
    const working = memory.setWorking(item.id, 'NEW_WORKING');
    await delay(20); release(); await Promise.all([update, working]);
    assert.equal(await memory.getWorking(item.id), 'NEW_WORKING');
    assert.equal((await memory.getCase(item.id))?.status, 'waiting');
    native.updateThread = original;
  } finally {
    release(); await memory.close(); const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true }); }
    catch (error) { if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; context.diagnostic(`cleanupDeferred=${target}`); }
  }
});
