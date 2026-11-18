import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CaseMemory } from '../server/v2/memory.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };

async function runPages(nextPage: (call: number) => number | number[] | undefined, readPage: (page: number, call: number) => unknown = page => ({ page }),
  truncated = false) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-uncapped-memory-'));
  const memory = new CaseMemory(`file:${join(directory, 'memory.db').replaceAll('\\', '/')}`);
  let calls = 0;
  const modelToolCounts: number[] = [];
  const pages: number[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const call = ++calls;
    modelToolCounts.push(options.tools?.length ?? 0);
    const selection = nextPage(call);
    if (truncated) return { content: [{ type: 'text', text: `Part ${call}.` }],
      finishReason: { unified: 'length', raw: 'length' }, usage, warnings: [] };
    if (selection === undefined) return { content: [{ type: 'text', text: 'Fixture finished.' }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    const batch = Array.isArray(selection) ? selection : [selection];
    return { content: batch.map((page, index) => ({ type: 'tool-call', toolName: 'read_page', toolCallId: `fixture-${call}-${index}`,
      input: JSON.stringify({ page }) })), finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const read_page = createTool({ id: 'read_page', description: 'Read a fixture page.', inputSchema: z.object({ page: z.number() }),
    execute: async ({ page }) => { pages.push(page); return readPage(page, calls); } });
  try {
    const item = await memory.createCase({ title: 'Read pages', objective: 'Collect fixture evidence', domain: 'test' });
    const result = await memory.runCase({ caseId: item.id, instructions: 'Use the fixture tool as needed.', message: 'Collect the evidence.', model,
      tools: { read_page }, maxSteps: null, maxOutputContinuations: 1 });
    return { result, pages, calls, modelToolCounts };
  } finally { await memory.close(); }
}

test('an uncapped actor continues while collecting distinct evidence past the previous step ceiling', async () => {
  const { result, pages, calls } = await runPages(call => call <= 22 ? call : undefined);
  assert.equal(calls, 23);
  assert.deepEqual(pages, Array.from({ length: 22 }, (_, index) => index + 1));
  assert.equal(result.steps, calls);
  assert.equal(result.stalled, false);
  assert.equal(result.text, 'Fixture finished.');
});

test('an uncapped actor stops repeating a tool batch with no new result', async () => {
  const { result, pages, calls } = await runPages(call => call <= 12 ? 1 : undefined);
  assert.equal(calls, 3);
  assert.deepEqual(pages, [1, 1, 1]);
  assert.equal(result.stalled, true);
  assert.equal(result.text, '');
});

test('an uncapped actor stops alternating identical batches, but can repeat a read that returns changed evidence', async () => {
  const cycle = await runPages(call => call <= 12 ? call % 2 : undefined);
  assert.deepEqual(cycle.pages, [1, 0, 1, 0, 1, 0]);
  assert.equal(cycle.calls, 6);
  assert.equal(cycle.result.stalled, true);

  let revision = 0;
  const changing = await runPages(call => call <= 5 ? 1 : undefined, () => ({ revision: ++revision }));
  assert.equal(changing.calls, 6);
  assert.equal(changing.result.stalled, false);
  assert.equal(changing.result.text, 'Fixture finished.');
});

test('an uncapped actor still gets only one tool-free continuation for clipped public text', async () => {
  const { calls, result, modelToolCounts } = await runPages(() => undefined, undefined, true);
  assert.equal(calls, 2);
  assert.deepEqual(modelToolCounts, [1, 0]);
  assert.equal(result.text, 'Part 1.Part 2.');
  assert.equal(result.finishReason, 'length');
  assert.equal(result.continuations, 1);
});

test('parallel tool results stay associated with their own inputs when comparing batches', async () => {
  const { calls, result } = await runPages(call => call <= 4 ? [0, 1] : undefined, (page, call) => ({ value: (page + call) % 2 }));
  assert.equal(calls, 5);
  assert.equal(result.stalled, false);
  assert.equal(result.text, 'Fixture finished.');
});
