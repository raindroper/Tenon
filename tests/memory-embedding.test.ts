import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createLocalMemoryEmbedder, hasLocalMemoryModel, MEMORY_EMBEDDING_DIMENSION, resolveMemoryModelDirectory } from '../server/v2/embedding.js';

const nativeVector = new Float32Array(MEMORY_EMBEDDING_DIMENSION).fill(0.5);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('an absent local model requires preparation and never triggers runtime downloads', async () => {
  const dataDir = join(tmpdir(), randomUUID());
  const directory = resolveMemoryModelDirectory(dataDir, '');
  assert.equal(directory, join(dataDir, 'models', 'bge-small-zh-v1.5'));
  assert.equal(resolveMemoryModelDirectory(dataDir, 'prepared-model'), resolve('prepared-model'));
  assert.equal(hasLocalMemoryModel(directory), false);
  await assert.rejects(async () => createLocalMemoryEmbedder(directory).doEmbed({ values: ['场景事实'] }), /prepare:memory-model/);
});

test('local embeddings are lazy, reject truncation, and return number arrays without invented usage', async () => {
  let loads = 0; let inferences = 0;
  const model = createLocalMemoryEmbedder('fixture', async () => {
    loads++;
    return {
      async countTruncated(values) { return { count: values.includes('超长') ? 1 : 0 }; },
      async *embed(values) { inferences++; yield values.map(() => nativeVector); },
    };
  });
  assert.equal(loads, 0);
  await assert.rejects(async () => model.doEmbed({ values: ['超长'] }), /超出模型窗口/);
  assert.equal(inferences, 0);
  const result = await model.doEmbed({ values: ['一', '二'] });
  assert.equal(loads, 1);
  assert.equal(inferences, 1);
  assert.equal(result.usage, undefined);
  assert.deepEqual(result.embeddings, [Array.from(nativeVector), Array.from(nativeVector)]);
});

test('native embeddings drain before abort rejection and the next request waits', async () => {
  const started = gate(); const release = gate();
  const events: string[] = [];
  const model = createLocalMemoryEmbedder('fixture', async () => ({
    async countTruncated() { return { count: 0 }; },
    async *embed(values) {
      events.push('start:' + values[0]);
      if (values[0] === 'first') { started.resolve(); await release.promise; }
      events.push('finish:' + values[0]);
      yield [nativeVector];
    },
  }));
  const abort = new AbortController();
  const first = Promise.resolve(model.doEmbed({ values: ['first'], abortSignal: abort.signal }));
  const checked = assert.rejects(first, { name: 'AbortError' });
  await started.promise;
  abort.abort();
  const next = model.doEmbed({ values: ['next'] });
  await Promise.resolve();
  assert.deepEqual(events, ['start:first']);
  release.resolve();
  await checked;
  await next;
  assert.deepEqual(events, ['start:first', 'finish:first', 'start:next', 'finish:next']);
});
