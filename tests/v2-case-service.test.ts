import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CaseMemory } from '../server/v2/memory.js';
import { CaseService } from '../server/v2/case-service.js';
import { RuntimeInputError } from '../server/runtime.js';
import { MockLanguageModelV4 } from './support/model.js';

test('case status has one native authority; external mutations fence while in-run writes do not self-cancel', async context => {
  const prefix = join(tmpdir(), 'rae-case-service-'); const directory = mkdtempSync(prefix);
  const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`);
  const fenced: string[] = [];
  let service = new CaseService(memory, { withMutation: async (id, work) => { fenced.push(id); return work(); } });
  try {
    const item = await service.create({ title: 'case', objective: 'native authority', domain: 'test' });
    await service.cancel(item.id); assert.equal(service.isCancelled(item.id), true); assert.equal((await memory.getCase(item.id))?.status, 'cancelled');
    await service.activate(item.id); assert.equal(service.isCancelled(item.id), false);
    await service.update(item.id, { status: 'waiting' }, { fromRun: true }); await service.setWorking(item.id, 'working state');
    assert.deepEqual(fenced, [item.id, item.id]); assert.equal(await service.getWorking(item.id), 'working state');
    service = new CaseService(memory); await service.init(); assert.equal((await service.get(item.id))?.status, 'waiting'); assert.equal(service.isCancelled(item.id), false);
    await service.migrateLegacyCancelled([item.id]); assert.equal(service.isCancelled(item.id), true); assert.equal((await memory.getCase(item.id))?.status, 'cancelled');
    await service.activate(item.id); assert.equal((await memory.getCase(item.id))?.status, 'active');
  } finally {
    await memory.close(); const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true }); }
    catch (error) { if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; context.diagnostic(`cleanupDeferred=${target}`); }
  }
});

test('ensureCase rejects owner/type/intent collisions and preserves later user edits', async context => {
  const prefix = join(tmpdir(), 'rae-case-ensure-'); const directory = mkdtempSync(prefix);
  const url = `file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`;
  const memory = new CaseMemory(url, 'first-owner'); const other = new CaseMemory(url, 'other-owner');
  try {
    const input = { title: 'original', objective: 'first intent', domain: 'test' };
    const item = await memory.ensureCase('fixed-case-id', input); await memory.setWorking(item.id, 'KEEP_WORKING');
    await memory.updateCase(item.id, { title: 'user-edited', status: 'waiting' });
    assert.equal((await memory.ensureCase(item.id, input)).title, 'user-edited');
    assert.equal(await memory.getWorking(item.id), 'KEEP_WORKING');
    await assert.rejects(memory.ensureCase(item.id, { ...input, objective: 'different intent' }),
      (error: unknown) => error instanceof RuntimeInputError && error.status === 409);
    await assert.rejects(other.ensureCase(item.id, input));
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'Offline collision fixture' }],
      warnings: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }) });
    const task = await memory.runCase({ caseId: item.id, model, message: 'Offline task history', instructions: 'Offline fixture only',
      maxSteps: 1, execution: { taskId: 'type-collision', requirementsRevision: 1 } });
    await assert.rejects(memory.ensureCase(task.threadId, input), /其他类型/);
    assert.equal((await memory.getCase(item.id))?.status, 'waiting');
  } finally {
    await memory.close(); await other.close(); const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true }); }
    catch (error) { if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; context.diagnostic(`cleanupDeferred=${target}`); }
  }
});

test('a delayed pre-cancellation get or list cannot roll the status projection back to active', async context => {
  const prefix = join(tmpdir(), 'rae-case-projection-'); const directory = mkdtempSync(prefix);
  const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`);
  const cases = new CaseService(memory);
  try {
    const item = await cases.create({ title: 'projection', objective: 'native status wins', domain: 'test' });
    for (const read of ['get', 'list'] as const) {
      await cases.activate(item.id);
      let release!: () => void; let entered!: () => void; let once = true;
      const gate = new Promise<void>(resolveGate => { release = resolveGate; });
      const reached = new Promise<void>(resolveReached => { entered = resolveReached; });
      const get = memory.getCase.bind(memory); const list = memory.listCases.bind(memory);
      if (read === 'get') memory.getCase = async id => { const value = await get(id); if (once) { once = false; entered(); await gate; } return value; };
      else memory.listCases = async () => { const value = await list(); if (once) { once = false; entered(); await gate; } return value; };
      const pendingRead = read === 'get' ? cases.get(item.id) : cases.list();
      await reached; await cases.cancel(item.id); assert.equal(cases.isCancelled(item.id), true);
      release(); await pendingRead;
      assert.equal(cases.isCancelled(item.id), true, `${read} must not replace a newer committed status`);
      memory.getCase = get; memory.listCases = list;
      assert.equal((await memory.getCase(item.id))?.status, 'cancelled');
    }
  } finally {
    await memory.close(); const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true }); }
    catch (error) { if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; context.diagnostic(`cleanupDeferred=${target}`); }
  }
});
