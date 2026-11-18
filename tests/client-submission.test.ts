import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSubmissions } from '../client/state/message-submissions.js';
import { settingsPatch } from '../client/lib/settings-patch.js';
import type { Settings } from '../shared/types.js';

test('a failed draft keeps its request identity across topic changes and an acknowledged draft may be sent again', () => {
  let sequence = 0; const drafts = createMessageSubmissions(() => `request-${++sequence}`);
  const input = { content: 'same text', caseId: 'project', attachments: [{ name: 'one.png', data: 'AAAA' }] };
  const first = drafts.prepare('project', input);
  drafts.prepare('other', { content: 'another topic', caseId: 'other' });
  assert.equal(drafts.prepare('project', structuredClone(input)).requestId, first.requestId);
  drafts.accepted('other', first.requestId);
  assert.equal(drafts.prepare('project', input).requestId, first.requestId);
  drafts.accepted('project', first.requestId);
  assert.notEqual(drafts.prepare('project', input).requestId, first.requestId);
});

test('changing any submitted scope gets a new identity and a late acknowledgement cannot erase its replacement', () => {
  let sequence = 0; const drafts = createMessageSubmissions(() => `request-${++sequence}`);
  const original = { content: 'original', caseId: 'project', attachments: [{ name: 'one.png', data: 'AAAA' }] };
  for (const change of [{ content: 'changed' }, { caseId: 'other' }, { replyTo: 'quoted' }, { reasoningEffort: 'high' as const },
    { deviceId: 'device' }, { attachments: [{ name: 'renamed.png', data: 'AAAA' }] }, { attachments: [{ name: 'one.png', data: 'BBBB' }] }]) {
    const first = drafts.prepare('project', original);
    const changed = drafts.prepare('project', { ...original, ...change });
    assert.notEqual(changed.requestId, first.requestId);
    drafts.accepted('project', first.requestId);
    assert.equal(drafts.prepare('project', { ...original, ...change }).requestId, changed.requestId);
  }
});

test('attachment-only submissions retry with the same identity and changes to file bytes or metadata create a new submission', () => {
  let sequence = 0;
  const drafts = createMessageSubmissions(() => `request-${++sequence}`);
  const file = { name: '账单.xlsx', mediaType: 'application/octet-stream', data: 'AAAA' };
  const original = { content: '', caseId: 'scene', files: [file] };
  const first = drafts.prepare('scene', original);
  assert.deepEqual(first.files, [file]);
  assert.equal(drafts.prepare('scene', structuredClone(original)).requestId, first.requestId);
  for (const change of [{ name: '改名.xlsx' }, { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { data: 'BBBB' }]) {
    assert.notEqual(drafts.prepare('scene', { ...original, files: [{ ...file, ...change }] }).requestId, first.requestId);
  }
});

const settings: Settings = { agentName: 'Rae', ownerName: 'owner', mission: 'fixture', model: 'fixture', apiBaseUrl: 'https://example.invalid/v1',
  apiKeyConfigured: true, enabled: true, enabledRevision: 7, reasoningEffort: 'auto', maxOutputTokens: null, maxOutputContinuations: 1, maxStepsPerRun: 20, timezone: 'UTC' };
const form = () => { const { apiKeyConfigured: _key, enabledRevision: _revision, ...values } = settings; return { ...values, apiKey: '' }; };

test('nickname-only saves omit the stale enabled snapshot and explicit toggles carry their original revision', () => {
  assert.deepEqual(settingsPatch(settings, { ...form(), ownerName: 'new name' }), { ownerName: 'new name' });
  assert.deepEqual(settingsPatch(settings, form()), {});
  assert.deepEqual(settingsPatch(settings, { ...form(), enabled: false }), { enabled: false, expectedEnabledRevision: 7 });
});

test('general settings never submit retired model fields or credentials from an old form snapshot', () => {
  assert.deepEqual(settingsPatch(settings, { ...form(), ownerName: 'new name', apiKey: '  new private key  ', clearApiKey: true,
    model: 'another-model', apiBaseUrl: 'https://different.invalid/v1', reasoningEffort: 'max', maxOutputTokens: 100 }), { ownerName: 'new name' });
  assert.deepEqual(settingsPatch(settings, { ...form(), clearApiKey: true }), {});
  assert.deepEqual(settingsPatch(settings, { ...form(), maxOutputContinuations: 0 }), { maxOutputContinuations: 0 });
});
