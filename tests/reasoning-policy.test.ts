import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { Store } from '../server/store.js';
import { selectReasoning, reasoningProviderOptions } from '../server/v2/reasoning.js';
import { deepseekStreamResponse } from './support/deepseek-stream.js';

test('auto uses high for substantive and ambiguous questions; only a fresh standalone greeting qualifies for low', () => {
  const select = (content: string, extra: Partial<Parameters<typeof selectReasoning>[0]> = {}) => selectReasoning({
    policy: 'auto', execution: false, hasPriorConversation: false, ownerMessage: { content }, ...extra,
  });
  for (const content of ['能正确吗？', '为什么？', '继续', 'hi，帮我检查证明', '帮我分析方案', '你好，解释一下这个问题']) assert.equal(select(content).effort, 'high', content);
  assert.equal(select('你好！').effort, 'low'); assert.equal(select(' hello. ').effort, 'low');
  assert.equal(select('你好', { hasPriorConversation: true }).effort, 'high');
  assert.equal(select('你好', { ownerMessage: { content: '你好', replyTo: 'existing-message' } }).effort, 'high');
  assert.equal(select('你好', { ownerMessage: { content: '你好', attachments: [{ id: 'image' }] } }).effort, 'high');
  assert.equal(select('你好', { execution: true }).effort, 'high');
  assert.equal(select('你好', { ownerMessage: undefined }).effort, 'high', 'external material cannot qualify as an owner greeting');
});

test('saved effort is sent through the real SDK as canonical wire parameters, without leaking a literal auto value', async () => {
  for (const policy of ['auto', 'none', 'low', 'high', 'max'] as const) {
    let body: Record<string, any> | undefined;
    const model = createDeepSeek({ apiKey: 'offline-fixture', baseURL: 'http://127.0.0.1:1/v1', fetch: async (_url, options) => {
      body = JSON.parse(String(options?.body)); return deepseekStreamResponse('离线夹具正文。');
    } })('deepseek-flash');
    const decision = selectReasoning({ policy, execution: false, hasPriorConversation: true, ownerMessage: { content: '继续分析。' } });
    const output = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: '离线夹具。' }] }], providerOptions: reasoningProviderOptions(decision) });
    for await (const _part of output.stream) { /* Drain the SDK transport. */ }
    assert.equal(body?.stream, true);
    assert.deepEqual(body?.thinking, { type: policy === 'none' ? 'disabled' : 'enabled' });
    assert.equal(body?.reasoning_effort, policy === 'none' ? undefined : policy === 'auto' ? 'high' : policy);
  }
});

test('reasoning migration preserves owner settings and inference state; fixed choices survive reopen and reset on a new connection', async () => {
  const prefix = join(tmpdir(), 'rae-reasoning-settings-'); const directory = mkdtempSync(prefix);
  let store = new Store(directory);
  try {
    store.setMeta('settings', { model: 'existing-model', apiBaseUrl: 'https://saved.invalid/v1', enabled: true, ownerName: 'Owner', maxStepsPerRun: 3 });
    assert.equal(store.getSettings().reasoningEffort, 'auto'); assert.equal(store.getSettings().enabled, true);
    assert.equal(store.getSettings().model, 'existing-model'); assert.equal(store.getSettings().ownerName, 'Owner');
    await store.updateSettings({ reasoningEffort: 'max' }); store.close(); store = new Store(directory);
    assert.equal(store.getSettings().reasoningEffort, 'max'); assert.equal(store.getSettings().maxStepsPerRun, 3);
    await store.updateSettings({ ownerName: 'Renamed' }); assert.equal(store.getSettings().reasoningEffort, 'max');
    const before = store.getSettings();
    for (const reasoningEffort of ['medium', 'adaptive', 'invalid', 1, null]) {
      await assert.rejects(store.updateSettings({ model: 'must-not-save', reasoningEffort } as never));
      assert.deepEqual(store.getSettings(), before);
    }
    await store.updateSettings({ model: 'new-model' }); assert.equal(store.getSettings().reasoningEffort, 'auto');
    await store.updateSettings({ apiBaseUrl: 'https://next.invalid/v1', reasoningEffort: 'none' });
    assert.equal(store.getSettings().reasoningEffort, 'none'); assert.equal(store.getSettings().enabled, true);
  } finally {
    store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true });
  }
});
