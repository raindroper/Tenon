import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { COLLECTION_NAMES, Store } from '../server/store.js';
import type { Run } from '../shared/types.js';

function fixture(): { directory: string; cleanup(): void } {
  const prefix = join(tmpdir(), 'rae-store-test-');
  const directory = mkdtempSync(prefix);
  return { directory, cleanup() { assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); } };
}

test('a new store has only default configuration and no invented user data', () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory);
  try {
    for (const collection of COLLECTION_NAMES) assert.deepEqual(store.list(collection), []);
    assert.equal(store.getSettings().enabled, false);
    assert.equal(store.getSettings().agentName, '榫');
    assert.equal('dailyBudgetCny' in store.getSettings(), false);
    assert.equal(store.getSettings().maxStepsPerRun, 20);
    assert.equal(store.getSettings().model, 'deepseek-flash');
    assert.match(store.getSettings().mission, /独立思考/);
    assert.deepEqual(store.todayUsage(), { inputTokens: 0, outputTokens: 0, usageStatus: 'reported' });
  } finally { store.close(); cleanup(); }
});

test('live readers see one committed transaction and never receive rolled-back changes', () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory); const observed: string[][] = [];
  const detach = store.subscribe(() => observed.push(store.list('messages').map(message => message.id)));
  const message = (id: string) => ({ id, role: 'user' as const, content: id, createdAt: new Date().toISOString() });
  try {
    store.atomic(() => { store.insert('messages', message('first')); store.atomic(() => store.insert('messages', message('second'))); assert.deepEqual(observed, []); });
    assert.deepEqual(observed, [['first', 'second']]);
    assert.throws(() => store.atomic(() => { store.insert('messages', message('rolled-back')); throw new Error('fault after write'); }));
    assert.deepEqual(observed, [['first', 'second']]); assert.equal(store.get('messages', 'rolled-back'), undefined);
    detach(); store.insert('messages', message('detached')); assert.equal(observed.length, 1);
  } finally { detach(); store.close(); cleanup(); }
});

test('the document view is reused for message writes and never caches rolled-back documents', () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory);
  const createdAt = new Date().toISOString();
  const source = { id: 'source', title: 'fixture', content: 'original', createdAt };
  try {
    store.insert('sources', source); const first = store.publicDocuments();
    store.insert('messages', { id: 'reply', role: 'assistant', content: 'partial reply', createdAt });
    assert.equal(store.publicDocuments(), first); assert.equal(Object.isFrozen(first.sources[0]), true);
    assert.throws(() => store.atomic(() => {
      store.put('sources', { ...source, content: 'rolled back' });
      assert.equal(store.publicDocuments().sources[0].content, 'rolled back'); throw new Error('rollback');
    }), /rollback/);
    assert.equal(store.publicDocuments().sources[0].content, 'original');
    store.remove('sources', source.id); assert.deepEqual(store.publicDocuments().sources, []);
  } finally { store.close(); cleanup(); }
});

test('records survive reopening, explicit inserts reject collisions, and returned objects are detached', () => {
  const { directory, cleanup } = fixture(); let store = new Store(directory);
  try {
    const message = { id: 'message-1', role: 'user' as const, content: '真实输入', createdAt: '2026-01-01T00:00:00.000Z' };
    store.insert('messages', message);
    assert.throws(() => store.insert('messages', { ...message, content: '覆盖不应成功' }));
    const copy = store.get('messages', message.id)!; copy.content = '本地修改';
    assert.equal(store.get('messages', message.id)?.content, '真实输入');
    store.put('messages', { ...message, content: '明确更新' });
    store.setMeta('pendingTriggers', ['chat']);
    store.close(); store = new Store(directory);
    assert.equal(store.get('messages', message.id)?.content, '明确更新');
    assert.deepEqual(store.getMeta('pendingTriggers', []), ['chat']);
  } finally { store.close(); cleanup(); }
});

test('message pages retain insertion order at equal timestamps and scope old quotes and image references', () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory);
  const createdAt = '2026-01-01T00:00:00.000Z';
  const firstImage = { id: 'early-image', name: 'first.png', mediaType: 'image/png' as const, width: 1, height: 1, size: 8 };
  const ids = Array.from({ length: 42 }, (_, index) => `message-${100 - index}`);
  try {
    store.atomic(() => {
      store.insert('messages', { id: 'other', caseId: 'other-case', role: 'user', content: 'Other topic', createdAt,
        attachments: [{ ...firstImage, id: 'other-image' }] });
      for (const [index, id] of ids.entries()) {
        store.insert('messages', { id, caseId: 'case', role: index ? 'assistant' : 'user', content: index ? id : 'Old original', createdAt,
          ...(index === 0 ? { attachments: [firstImage] } : {}),
          ...(index === 40 ? { replyTo: ids[0] } : index === 41 ? { replyTo: 'other' } : {}) });
      }
    });
    const firstPage = store.messagePage({ caseId: 'case' })!;
    assert.deepEqual(firstPage.messages.map(message => message.id), ids.slice(2));
    assert.equal(firstPage.messages.at(-2)?.replyPreview, 'Old original');
    assert.equal(firstPage.messages.at(-1)?.replyPreview, undefined);
    assert.equal(firstPage.nextBefore, ids[2]);
    assert.equal(firstPage.beforeCreatedAt, null);
    assert.deepEqual(store.recentCaseImages('case'), [firstImage]);
    assert.deepEqual(store.messagePreviews(['case', 'other-case', 'missing']), { case: ids[41], 'other-case': 'Other topic' });
    assert.equal(store.hasCaseMessages('other-case', 'other'), false);
    assert.equal(store.hasCaseMessages('case', ids[0]), true);

    store.insert('messages', { id: 'newer', caseId: 'case', role: 'user', content: 'New message', createdAt });
    const secondPage = store.messagePage({ caseId: 'case', before: firstPage.nextBefore! })!;
    assert.deepEqual(secondPage.messages.map(message => message.id), ids.slice(0, 2));
    assert.equal(secondPage.beforeCreatedAt, createdAt);
    assert.equal(secondPage.nextBefore, null);
    assert.equal(store.messagePage({ caseId: 'case', before: 'other' }), undefined);
    assert.equal(store.messagePage({ caseId: 'case', before: 'missing' }), undefined);
    assert.equal(store.messagePage({})?.messages.length, 40);
    assert.equal(store.list('messages').length, ids.length + 2);
  } finally { store.close(); cleanup(); }
});

test('an atomic failure rolls back records and metadata together', () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory);
  try {
    store.setMeta('checkpoint', 'before');
    assert.throws(() => store.atomic(() => {
      store.setMeta('checkpoint', 'after');
      store.atomic(() => store.insert('sources', { id: 'source-1', title: 'test', content: 'real', createdAt: new Date().toISOString() }));
      throw new Error('simulated interruption');
    }));
    assert.equal(store.getMeta('checkpoint', ''), 'before');
    assert.deepEqual(store.list('sources'), []);
  } finally { store.close(); cleanup(); }
});

test('API keys persist separately, are absent from public settings, and environment wins', async () => {
  const { directory, cleanup } = fixture(); const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY; let store = new Store(directory);
  const secret = 'test-only-api-key-DO-NOT-USE-4b91';
  try {
    await store.updateSettings({ apiKey: secret, ownerName: '测试用户' });
    assert.equal(store.getApiKey(), secret);
    assert.equal(store.getSettings().apiKeyConfigured, true);
    assert.ok(!JSON.stringify(store.getSettings()).includes(secret));
    assert.ok(!JSON.stringify(store.getMeta('settings', {})).includes(secret));
    if (process.platform === 'win32') {
      const credentials = readFileSync(join(directory, 'credentials.json'), 'utf8');
      assert.match(credentials, /dpapi-current-user-v1/); assert.ok(!credentials.includes(secret));
    }
    store.close(); store = new Store(directory);
    assert.equal(store.getApiKey(), secret);
    process.env.DEEPSEEK_API_KEY = 'environment-test-key';
    assert.equal(store.getApiKey(), 'environment-test-key');
    await store.updateSettings({ clearApiKey: true });
    assert.equal(store.getApiKey(), 'environment-test-key');
    delete process.env.DEEPSEEK_API_KEY;
    assert.equal(store.getApiKey(), undefined);
    assert.equal(store.getSettings().apiKeyConfigured, false);
  } finally {
    store.close(); if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous;
    cleanup();
  }
});

test('settings reject retired cost fields and invalid input before changing saved configuration', async () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory);
  try {
    await assert.rejects(store.updateSettings({ dailyBudgetCny: 5 } as never));
    await assert.rejects(store.updateSettings({ maxStepsPerRun: 1.5 }));
    await assert.rejects(store.updateSettings({ timezone: 'unreal/timezone' }));
    await assert.rejects(store.updateSettings({ apiBaseUrl: 'http://remote.example' }));
    await assert.rejects(store.updateSettings({ apiKeyConfigured: true } as never));
    assert.equal('dailyBudgetCny' in store.getSettings(), false);
    await store.updateSettings({ mission: '从真实观察自主发现价值', maxStepsPerRun: 4 });
    assert.equal(store.getSettings().maxStepsPerRun, 4);
  } finally { store.close(); cleanup(); }
});

test('only the retired default mission is upgraded; custom owner instructions remain unchanged', async () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory);
  try {
    store.setMeta('settings', { mission: '持续了解我，独立思考什么值得为我做，主动发现需求、探索有价值的目标并付诸行动。根据真实资料和反馈更新理解；区分事实与假设，允许小步试错，不为显得忙碌而制造任务。' });
    assert.match(store.getSettings().mission, /实际产出任务先取得/);
    await store.updateSettings({ mission: '本人自定义的长期角色与表达方式。' });
    assert.equal(store.getSettings().mission, '本人自定义的长期角色与表达方式。');
  } finally { store.close(); cleanup(); }
});

test('the old saved default follows the new brand and a newly chosen name survives reopening', async () => {
  const { directory, cleanup } = fixture();
  let store = new Store(directory);
  try {
    store.setMeta('settings', { agentName: 'Rae', ownerName: '小林' });
    assert.equal(store.getSettings().agentName, '榫');
    assert.equal(store.getSettings().ownerName, '小林');
    assert.deepEqual(store.getMeta('settings', {}), { agentName: 'Rae', ownerName: '小林' });
    await store.updateSettings({ agentName: 'Rae' });
    store.close();
    store = new Store(directory);
    assert.equal(store.getSettings().agentName, 'Rae');
  } finally { store.close(); cleanup(); }
});

test('retired saved budgets never reset the owner settings or expose a price configuration', async () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory);
  try {
    store.setMeta('settings', { ownerName: '本人称呼', agentName: 'Mira', mission: '本人自定义目标', model: 'custom-model',
      apiBaseUrl: 'https://example.com/v1', enabled: false, maxStepsPerRun: 3, timezone: 'UTC', dailyBudgetCny: 0.5 });
    const settings = store.getSettings();
    assert.equal(settings.ownerName, '本人称呼'); assert.equal(settings.agentName, 'Mira');
    assert.equal(settings.model, 'custom-model'); assert.equal(settings.apiBaseUrl, 'https://example.com/v1');
    assert.equal(settings.timezone, 'UTC'); assert.equal(settings.maxStepsPerRun, 3);
    assert.equal(settings.mission, '本人自定义目标'); assert.equal(settings.enabled, false);
    assert.equal('dailyBudgetCny' in settings, false);
    await store.updateSettings({ ownerName: '新的称呼' });
    assert.equal(store.getSettings().model, 'custom-model');
  } finally { store.close(); cleanup(); }
});

test('daily usage counts persisted runs for the configured local calendar date', () => {
  const { directory, cleanup } = fixture(); const store = new Store(directory);
  try {
    const current: Run = { id: 'today', trigger: 'manual', status: 'completed', startedAt: new Date().toISOString(), steps: 1, inputTokens: 50, outputTokens: 25, usageStatus: 'reported' };
    store.insert('runs', current);
    store.insert('runs', { ...current, id: 'older', startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), inputTokens: 500 });
    assert.deepEqual(store.todayUsage(), { inputTokens: 50, outputTokens: 25, usageStatus: 'reported' });
    store.insert('runs', { ...current, id: 'partial', inputTokens: 20, outputTokens: 0, usageStatus: 'partial' });
    assert.deepEqual(store.todayUsage(), { inputTokens: 70, outputTokens: 25, usageStatus: 'partial' });
    store.insert('runs', { ...current, id: 'pending', inputTokens: 0, outputTokens: 0, pendingModelCalls: 1 });
    assert.deepEqual(store.todayUsage(), { inputTokens: 70, outputTokens: 25, usageStatus: 'unknown' });
  } finally { store.close(); cleanup(); }
});

test('unreadable credential files fail closed instead of becoming plaintext or disappearing', () => {
  const { directory, cleanup } = fixture();
  try {
    writeFileSync(join(directory, 'credentials.json'), '{"format":"unknown","value":"not-a-valid-secret"}');
    assert.throws(() => new Store(directory), /无法读取已保存的密钥/);
    assert.match(readFileSync(join(directory, 'credentials.json'), 'utf8'), /not-a-valid-secret/);
  } finally { cleanup(); }
});
