import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';

function fixture() {
  const prefix = join(tmpdir(), 'rae-output-settings-'); const directory = mkdtempSync(prefix);
  let store = new Store(directory);
  return { get store() { return store; }, reopen() { store.close(); store = new Store(directory); },
    close() { store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); } };
}

test('legacy model connections receive output defaults without resetting owner configuration or inference state', () => {
  const f = fixture();
  try {
    f.store.setMeta('settings', { ownerName: 'Existing owner', agentName: 'Existing agent', mission: 'Existing custom mission', model: 'saved-model',
      apiBaseUrl: 'https://saved-provider.invalid/v1', enabled: true, maxStepsPerRun: 6, timezone: 'UTC' });
    for (let index = 0; index < 2; index++) {
      const settings = f.store.getSettings();
      assert.equal(settings.model, 'saved-model'); assert.equal(settings.apiBaseUrl, 'https://saved-provider.invalid/v1');
      assert.equal(settings.ownerName, 'Existing owner'); assert.equal(settings.mission, 'Existing custom mission');
      assert.equal(settings.enabled, true); assert.equal(settings.maxStepsPerRun, 6); assert.equal(settings.timezone, 'UTC');
      assert.equal(settings.maxOutputTokens, null); assert.equal(settings.maxOutputContinuations, 1);
      if (index === 0) f.reopen();
    }
  } finally { f.close(); }
});

test('manual output limits belong to the current connection and survive unrelated saves and reopening', async () => {
  const f = fixture();
  try {
    await f.store.updateSettings({ model: 'first-model', maxOutputTokens: 100_000, maxOutputContinuations: 0 });
    await f.store.updateSettings({ ownerName: 'Owner rename' });
    await f.store.updateSettings({ model: 'first-model' });
    assert.equal(f.store.getSettings().maxOutputTokens, 100_000);
    f.reopen(); assert.equal(f.store.getSettings().maxOutputTokens, 100_000); assert.equal(f.store.getSettings().maxOutputContinuations, 0);
    await f.store.updateSettings({ apiBaseUrl: 'https://second-provider.invalid/v1' });
    assert.equal(f.store.getSettings().maxOutputTokens, null);
    await f.store.updateSettings({ maxOutputTokens: 32768 });
    await f.store.updateSettings({ model: 'second-model', maxOutputTokens: 16384 });
    assert.equal(f.store.getSettings().maxOutputTokens, 16384, 'an explicit replacement value is retained with the new connection');
    await f.store.updateSettings({ model: 'third-model' });
    assert.equal(f.store.getSettings().maxOutputTokens, null, 'an old model limit cannot silently follow a new model');
    await f.store.updateSettings({ maxOutputTokens: 8192 }); await f.store.updateSettings({ maxOutputTokens: null, maxOutputContinuations: 1 });
    f.reopen(); assert.equal(f.store.getSettings().maxOutputTokens, null); assert.equal(f.store.getSettings().maxOutputContinuations, 1);
  } finally { f.close(); }
});

test('invalid output settings cannot mutate the saved model connection or permit unbounded continuation', async () => {
  const f = fixture();
  try {
    await f.store.updateSettings({ model: 'retained-model', maxOutputTokens: 8192, maxOutputContinuations: 0 });
    const before = f.store.getSettings();
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      await assert.rejects(f.store.updateSettings({ model: 'must-not-save', maxOutputTokens: value }));
      assert.deepEqual(f.store.getSettings(), before);
    }
    for (const value of [-1, .5, 2, 100]) {
      await assert.rejects(f.store.updateSettings({ maxOutputContinuations: value }));
      assert.deepEqual(f.store.getSettings(), before);
    }
  } finally { f.close(); }
});
