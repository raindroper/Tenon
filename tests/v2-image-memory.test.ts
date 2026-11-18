import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { CaseMemory } from '../server/v2/memory.js';
import { caseImageContext, imageReference } from '../server/v2/image-context.js';
import type { Processor } from '@mastra/core/processors';
import { deepseekStreamResponse } from './support/deepseek-stream.js';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

test('native image references hydrate through the installed DeepSeek SDK and survive scoped follow-ups/reopening', async () => {
  const prefix = join(tmpdir(), 'rae-image-memory-'); const directory = mkdtempSync(prefix);
  const url = `file:${join(directory, 'memory.db').replaceAll('\\', '/')}`;
  const calls: Array<Record<string, unknown>> = []; const resolutions: Array<{ id: string; caseId: string }> = [];
  const model = createDeepSeek({ apiKey: 'offline-fixture-key', baseURL: 'http://127.0.0.1:1/v1', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; calls.push(body);
    assert.equal(body.stream, true);
    return deepseekStreamResponse('已阅读本轮提供的图片。');
  } })('fixture-vision');
  let caseId = '';
  const resolver = (id: string, scope: string) => {
    resolutions.push({ id, caseId: scope });
    assert.equal(id, 'image-1'); assert.equal(scope, caseId);
    return { data: image, mediaType: 'image/png' };
  };
  let memory = new CaseMemory(url, 'image-owner', resolver);
  try {
    const item = await memory.createCase({ title: '看图事项', objective: '理解一张本地图片', domain: 'images' }); caseId = item.id;
    const other = await memory.createCase({ title: '其他事项', objective: '不应看到其他事项图片', domain: 'other' });
    await memory.runCase({ caseId, model, instructions: '本地离线验证。', message: '这张图是什么？', attachments: [{ id: 'image-1', mediaType: 'image/png' }] });
    assert.equal(calls.length, 1);
    const first = JSON.stringify(calls[0]);
    assert.match(first, /image_url/); assert.ok(first.includes(`data:image/png;base64,${image.toString('base64')}`));
    assert.doesNotMatch(first, /rae-image:/);
    const history = JSON.stringify(await memory.history(caseId));
    assert.match(history, /rae-image:image-1/); assert.doesNotMatch(history, /base64|iVBORw0KGgo/);
    await memory.close(); memory = new CaseMemory(url, 'image-owner', resolver);
    await memory.runCase({ caseId, model, instructions: '本地离线验证。', message: '继续解释刚才的图。' });
    assert.match(JSON.stringify(calls[1]), /image_url/);
    assert.deepEqual(resolutions, [{ id: 'image-1', caseId }, { id: 'image-1', caseId }]);
    await memory.runCase({ caseId: other.id, model, instructions: '本地离线验证。', message: '只回答当前事项。' });
    assert.doesNotMatch(JSON.stringify(calls[2]), /image_url|iVBORw0KGgo|这张图是什么/);
    assert.equal(resolutions.length, 2);
  } finally {
    await memory.close();
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
});

test('provider-only hydration bounds images, prefers newest references and preserves tools/system parts', async () => {
  const large = (value: number) => Buffer.alloc(300 * 1024, value);
  const resolutions: string[] = [];
  const processor = caseImageContext('current-case', (id, caseId) => {
    assert.equal(caseId, 'current-case'); resolutions.push(id);
    return { data: large(Number(id.slice(-1))), mediaType: 'image/png' };
  });
  type Request = Parameters<NonNullable<Processor['processLLMRequest']>>[0];
  const prompt: Request['prompt'] = [
    { role: 'system', content: '系统指令不变。' },
    { role: 'user', content: [0, 1, 2, 3, 4].map(value => ({ type: 'file', data: imageReference(`image-${value}`), mediaType: 'image/png' })) },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read_evidence', input: { page: 1 } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read_evidence', output: { type: 'text', value: '原始证据' } }] },
    { role: 'user', content: [{ type: 'text', text: '重新看看第一张。' }, { type: 'file', data: imageReference('image-0'), mediaType: 'image/png' }] },
  ];
  const original = JSON.stringify(prompt);
  const result = await processor.processLLMRequest!({ prompt, retryCount: 0, stepNumber: 0, steps: [], state: {} } as unknown as Request);
  assert.ok(result?.prompt);
  assert.equal(result.prompt[0], prompt[0]); assert.equal(result.prompt[2], prompt[2]); assert.equal(result.prompt[3], prompt[3]);
  const imageParts = result.prompt.flatMap(message => message.role === 'user' ? message.content.filter(part => part.type === 'file') : []);
  assert.equal(imageParts.length, 3, '900 KiB fits; another 300 KiB must be omitted');
  assert.deepEqual(imageParts.map(part => (part.data as Uint8Array)[0]), [3, 4, 0]);
  assert.match(JSON.stringify(result.prompt), /历史图片未附入本轮/);
  assert.match(JSON.stringify(result.prompt), /同一图片已附在较近的消息/);
  assert.doesNotMatch(JSON.stringify(result.prompt), /rae-image:/);
  assert.equal(JSON.stringify(prompt), original, 'hydration must never mutate the native history');
  assert.deepEqual(resolutions, ['image-0', 'image-4', 'image-3', 'image-2', 'image-1']);
  const tiny = caseImageContext('current-case', () => ({ data: image, mediaType: 'image/png' }));
  const tinyResult = await tiny.processLLMRequest({ prompt, retryCount: 0, stepNumber: 0, steps: [], state: {} } as unknown as Request);
  assert.equal(tinyResult?.prompt?.flatMap(message => message.role === 'user' ? message.content.filter(part => part.type === 'file') : []).length, 4,
    'small images still obey the four-image context cap');
});

test('a provider that rejects vision does not trigger Mastra text-only attachment fallback', async () => {
  const prefix = join(tmpdir(), 'rae-rejected-image-'); const directory = mkdtempSync(prefix);
  let calls = 0;
  const model = createDeepSeek({ apiKey: 'offline-fixture-key', baseURL: 'http://127.0.0.1:1/v1', fetch: async (_url, init) => {
    calls++;
    assert.match(String(init?.body), /image_url/);
    return new Response(JSON.stringify({ error: { message: 'This model does not support image input', type: 'invalid_request_error' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  } })('fixture-text-only');
  const memory = new CaseMemory(`file:${join(directory, 'memory.db').replaceAll('\\', '/')}`, 'image-owner', () => ({ data: image, mediaType: 'image/png' }));
  try {
    const item = await memory.createCase({ title: '不支持看图', objective: '应明确失败而非丢图回复', domain: 'images' });
    await assert.rejects(memory.runCase({ caseId: item.id, model, instructions: '本地离线验证。', message: '这张图是什么？',
      attachments: [{ id: 'image-1', mediaType: 'image/png' }] }));
    assert.equal(calls, 1, 'there must be no second request with the image removed');
  } finally {
    await memory.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
});

test('missing or wrong-scope image resolution fails before a provider call instead of silently stripping the image', async () => {
  type Request = Parameters<NonNullable<Processor['processLLMRequest']>>[0];
  const prompt: Request['prompt'] = [{ role: 'user', content: [{ type: 'file', data: imageReference('private-image'), mediaType: 'image/png' }] }];
  const request = { prompt, retryCount: 0, stepNumber: 0, steps: [], state: {} } as unknown as Request;
  await assert.rejects(Promise.resolve(caseImageContext('other-case').processLLMRequest!(request)), /图片存储未连接/);
  await assert.rejects(Promise.resolve(caseImageContext('other-case', (_id, scope) => {
    assert.equal(scope, 'other-case'); throw new Error('图片不属于当前事项。');
  }).processLLMRequest!(request)), /不属于当前事项/);
});
