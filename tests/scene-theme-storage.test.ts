import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LibSQLStore } from '@mastra/libsql';
import { CaseMemory } from '../server/v2/memory.js';
import { isSceneThemeId, legacySceneTheme, SCENE_THEME_IDS } from '../shared/scene-theme.js';

async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-scene-themes-'));
  return `file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`;
}

test('scene colors are allocated once across concurrent creation, retries, edits and reopen', async () => {
  const url = await database();
  let memory = new CaseMemory(url);
  try {
    const input = { title: 'Stable scene', objective: 'Keep my color', domain: 'test' };
    // General may not exist until the owner's first conversation there.
    const custom = await Promise.all(SCENE_THEME_IDS.slice(1).map((_, index) => memory.ensureCase(`scene-${index}`, input)));
    const general = await memory.ensureCase('personal-growth', { ...input, title: '通用' });
    assert.equal(general.themeId, 'sage');
    assert.equal(new Set([general, ...custom].map(item => item.themeId)).size, SCENE_THEME_IDS.length);
    for (const scene of custom) assert.ok(isSceneThemeId(scene.themeId));
    const original = custom[0];
    await memory.updateCase(original.id, { title: 'Renamed', status: 'waiting' });
    const [retryA, retryB] = await Promise.all([memory.ensureCase(original.id, input), memory.ensureCase(original.id, input)]);
    assert.equal(retryA.themeId, original.themeId);
    assert.equal(retryB.themeId, original.themeId);
    assert.equal(retryA.title, 'Renamed');
    const expected = new Map((await memory.listCases()).map(item => [item.id, item.themeId]));
    await memory.close();
    memory = new CaseMemory(url);
    assert.deepEqual(new Map((await memory.listCases()).map(item => [item.id, item.themeId])), expected);
    assert.equal((await memory.getCase(original.id))?.status, 'waiting');
    const overflow = await memory.createCase({ ...input, title: 'All colors in use' });
    assert.ok(isSceneThemeId(overflow.themeId));
  } finally { await memory.close(); }
});

test('legacy theme migration preserves native history, timestamps, metadata and ownership', async () => {
  const url = await database();
  const storage = new LibSQLStore({ id: 'scene-theme-migration-fixture', url });
  let memory = new CaseMemory(url);
  try {
    await storage.init();
    const native = await storage.getStore('memory');
    assert.ok(native);
    const createdAt = new Date('2026-10-01T08:00:00.000Z');
    const updatedAt = new Date('2026-10-09T09:30:00.000Z');
    const base = { resourceId: 'owner', title: 'Existing scene', createdAt, updatedAt,
      metadata: { kind: 'case', objective: 'Keep existing background', domain: 'test', status: 'waiting',
        workingMemory: 'KEEP_WORKING_MEMORY', creationIntentHash: 'KEEP_INTENT_HASH', custom: { value: 'KEEP_METADATA' } } };
    const rows = [
      { ...base, id: 'personal-growth' },
      { ...base, id: 'legacy-scene' },
      { ...base, id: 'invalid-theme', metadata: { ...base.metadata, themeId: 'unknown-retired-theme' } },
      { ...base, id: 'saved-theme', metadata: { ...base.metadata, themeId: 'rose' } },
      { ...base, id: 'foreign-scene', resourceId: 'other-owner' },
    ];
    for (const thread of rows) await native.saveThread({ thread });
    await native.saveMessages({ messages: [{ id: 'legacy-message', threadId: 'legacy-scene', resourceId: 'owner',
      role: 'user', createdAt, content: { format: 2, parts: [{ type: 'text', text: 'KEEP_HISTORY' }] } }] });
    // Message insertion may bump the scene timestamp; restore the historical fixture.
    await native.saveThread({ thread: rows[1] });
    await memory.init();
    for (const original of rows) {
      const saved = await native.getThreadById({ threadId: original.id });
      assert.ok(saved);
      const expectedTheme = original.resourceId !== 'owner' ? {} : {
        themeId: original.id === 'saved-theme' ? 'rose' : legacySceneTheme(original.id),
      };
      assert.deepEqual(saved, { ...original, metadata: { ...original.metadata, ...expectedTheme } });
    }
    assert.equal((await memory.getCase('personal-growth'))?.themeId, 'sage');
    assert.equal(await memory.getWorking('legacy-scene'), 'KEEP_WORKING_MEMORY');
    assert.match(JSON.stringify(await memory.history('legacy-scene')), /KEEP_HISTORY/);
    assert.equal((await memory.listCases()).length, 4);
    const migrated = await native.getThreadById({ threadId: 'legacy-scene' });
    await memory.close();
    memory = new CaseMemory(url);
    await memory.init();
    assert.deepEqual(await native.getThreadById({ threadId: 'legacy-scene' }), migrated);
  } finally { await memory.close(); await storage.close(); }
});
