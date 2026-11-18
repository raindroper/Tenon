import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';

async function waitFor(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Expected another case to progress before the UI gate was released'); await delay(10); }
}

test('two events for a blocked UI case leave a worker free for a food case', async context => {
  const prefix = join(tmpdir(), 'rae-v2-fairness-'); const directory = mkdtempSync(prefix);
  const store = new Store(directory); store.getApiKey = () => undefined;
  let releaseUi!: () => void;
  const gate = new Promise<void>(resolveGate => { releaseUi = resolveGate; });
  let uiHeld = false; let firstUiFinished = false; let active = 0; let maximumActive = 0;
  const order: string[] = [];
  const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 8, text: 8, reasoning: 0 } };
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const prompt = JSON.stringify(options.prompt);
    const kind = prompt.includes('FOOD_FIRST_SENTINEL') ? 'food' : prompt.includes('UI_SECOND_SENTINEL') ? 'ui-second' : 'ui-first';
    order.push(kind); active++; maximumActive = Math.max(maximumActive, active);
    try {
      if (kind === 'ui-first' && !firstUiFinished) { uiHeld = true; await gate; firstUiFinished = true; }
      return { content: [{ type: 'text' as const, text: `已处理 ${kind}` }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
    } finally { active--; }
  } });
  const engine = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    await store.updateSettings({ enabled: true, maxStepsPerRun: 2 });
    const ui = await engine.memory.createCase({ title: 'UI事项', objective: '改善排版', domain: 'design' });
    const food = await engine.memory.createCase({ title: '午餐事项', objective: '考虑午饭', domain: 'food' });
    const first = await engine.ingestOwnerMessage('UI_FIRST_SENTINEL', ui.id);
    const second = await engine.ingestOwnerMessage('UI_SECOND_SENTINEL', ui.id);
    const meal = await engine.ingestOwnerMessage('FOOD_FIRST_SENTINEL', food.id);
    engine.start();
    await waitFor(() => uiHeld);
    await waitFor(() => engine.inbox.list().find(event => event.id === meal.id)?.status === 'processed');
    assert.equal(firstUiFinished, false, 'food must finish while the first UI event is still blocked');
    assert.equal(engine.inbox.list().find(event => event.id === first.id)?.status, 'leased');
    assert.equal(engine.inbox.list().find(event => event.id === second.id)?.status, 'pending');
    assert.deepEqual(order, ['ui-first', 'food']);
    releaseUi();
    await waitFor(() => [first.id, second.id, meal.id].every(id => engine.inbox.list().find(event => event.id === id)?.status === 'processed'));
    assert.deepEqual(order, ['ui-first', 'food', 'ui-second']); assert.equal(maximumActive, 2);
    assert.equal(store.list('runs').filter(run => run.status === 'completed').length, 3);
  } finally {
    releaseUi(); await engine.close(); store.close();
    const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true, maxRetries: 0 }); }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      context.diagnostic(JSON.stringify({ cleanupDeferred: true, directory: target, reason: 'Windows has not yet released the temporary libSQL handle' }));
    }
  }
});
