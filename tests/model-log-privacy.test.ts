import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { APICallError } from '@ai-sdk/provider';
import { CaseMemory } from '../server/v2/memory.js';
import { MockLanguageModelV4 } from './support/model.js';

test('provider failures keep a safe status diagnostic and omit raw provider fields from logs', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-model-log-'));
  const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`);
  const privateData = 'PRIVATE_PROVIDER_DETAILS_MARKER';
  const model = new MockLanguageModelV4({ doStream: async () => {
    throw new APICallError({ message: privateData, url: `http://127.0.0.1/${privateData}`, statusCode: 422,
      requestBodyValues: { prompt: privateData }, responseHeaders: { 'x-private': privateData }, responseBody: privateData });
  } });
  const logs = ['error', 'warn', 'info', 'log', 'debug'] as const;
  const capture = logs.map(level => context.mock.method(console, level, () => undefined));
  try {
    const item = await memory.createCase({ title: 'Diagnostics', objective: 'Retain only safe error metadata', domain: 'fixture' });
    await assert.rejects(memory.runCase({ caseId: item.id, model, instructions: 'Fixture instructions', message: 'Fixture request' }));
    const logged = inspect(capture.flatMap(method => method.mock.calls.map(call => call.arguments)), { depth: 8 });
    assert.doesNotMatch(logged, new RegExp(privateData));
    assert.equal(capture[0].mock.calls.length, 1);
    const [label, details] = capture[0].mock.calls[0].arguments as unknown as [string, Record<string, unknown>];
    assert.equal(label, '模型接口调用失败。');
    assert.deepEqual({ caseId: details.caseId, category: details.category, code: details.code, errorName: details.errorName, httpStatus: details.httpStatus },
      { caseId: item.id, category: 'model_api', code: 'MODEL_API_HTTP_ERROR', errorName: 'AI_APICallError', httpStatus: 422 });
    assert(Object.keys(details).every(key => ['caseId', 'category', 'code', 'errorName', 'httpStatus', 'location'].includes(key)));
  } finally { await memory.close(); }
});
