import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from 'ai/test';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('runtime shutdown waits for an owner correction already inside its native mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-owner-mutation-close-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('This fixture must not run a model'); } });
  const engine = await V2Coordinator.create(store, { dataDir: directory, model });
  const entered = deferred(); const release = deferred(); let written = false;
  const correct = engine.personal.correct.bind(engine.personal);
  engine.personal.correct = async (...args) => { entered.resolve(); await release.promise; const result = await correct(...args); written = true; return result; };
  const correction = engine.correctPersonalMemory('fixture.owner.preference', { value: 'Keep decisions maintainable', scope: 'global' });
  const outcome = correction.then(value => ({ value }), error => ({ error }));
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    let acknowledged = false;
    closing = engine.close().then(() => { acknowledged = true; });
    await delay(50);
    assert.equal(acknowledged, false, 'The runtime must not close native storage before owner writes drain');
    assert.equal(written, false);
    release.resolve(); const result = await outcome;
    assert.ok('value' in result, 'An accepted owner correction must finish before native storage closes');
    await closing; assert.equal(written, true); assert.equal(acknowledged, true);
  } finally { release.resolve(); await outcome; await (closing ?? engine.close()); store.close(); }
});
