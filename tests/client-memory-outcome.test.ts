import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PersonalMemoryEntry, TaskOutcomeEvidence } from '../shared/personal-memory.js';
import type { PanelContext } from '../client/panels/types.js';

const assets = registerHooks({ load(url, context, nextLoad) {
  if (/\/client\/assets\/tenon-mark\.svg$/.test(url)) return { format: 'module', source: 'export default "fixture-brand.svg";', shortCircuit: true };
  return nextLoad(url, context);
} });
const { TaskOutcomeDetails, MemoryPanel, EditMemoryPanel } = await import('../client/panels/memory.js');
const { PanelContent } = await import('../client/panels/PanelContent.js');
assets.deregister();

function outcome(): TaskOutcomeEvidence {
  return { eventId: 'PRIVATE_EVENT', taskId: 'PRIVATE_TASK', runId: 'PRIVATE_RUN', caseId: 'PRIVATE_CASE',
    executionEventId: 'PRIVATE_EXECUTION', approvalRevision: 1, requirementsRevision: 3, status: 'completed',
    recordedAt: '2026-11-07T08:00:00.000Z', deliveries: [{ artifactId: 'PRIVATE_ARTIFACT', contentHash: 'a'.repeat(64), status: 'prepared' }],
    operations: [{ kind: 'device', id: 'PRIVATE_OPERATION', requirementsRevision: 3, receiptHash: 'b'.repeat(64), state: 'completed' }],
    checks: [
      { source: 'artifact', referenceId: 'PRIVATE_RUN', name: 'artifact.persisted', passed: true, detail: '说明已经保存，仍待本人验收。' },
      { source: 'workspace', referenceId: 'PRIVATE_RECEIPT', name: '指定 JSON 字段', passed: false,
        detail: '指定字段尚未匹配；仅适用于回执 PRIVATE_RECEIPT 中的授权文件版本。' },
    ], sourceEventIds: ['PRIVATE_SOURCE_EVENT'] };
}

test('method evidence shows the task requirement version and concrete passed and failed conditions without exposing internal records', () => {
  const value = { ...outcome(), privateToken: 'SECRET_RUNTIME_KEY' };
  const before = structuredClone(value);
  const html = renderToStaticMarkup(createElement(TaskOutcomeDetails, { outcome: value, taskTitle: '整理资料说明' }));
  assert.match(html, /任务：整理资料说明/); assert.match(html, /要求版本 3/);
  assert.match(html, /交付文本已保存<\/strong> · 通过/);
  assert.match(html, /指定 JSON 字段<\/strong> · 未通过/);
  assert.match(html, /说明已经保存，仍待本人验收/);
  assert.match(html, /指定字段尚未匹配/);
  assert.match(html, /只证明列出的条件，方法仍待验证/);
  assert.doesNotMatch(html, /PRIVATE_|SECRET_RUNTIME_KEY|contentHash|receiptHash/);
  assert.deepEqual(value, before, 'Displaying result checks does not promote or rewrite the stored evidence');
});

test('an all-passing result still leaves the method unvalidated and missing task metadata does not fall back to private IDs', () => {
  const value = outcome(); value.checks = value.checks.map(check => ({ ...check, passed: true }));
  const html = renderToStaticMarkup(createElement(TaskOutcomeDetails, { outcome: value }));
  assert.match(html, /要求版本 3/);
  assert.match(html, /方法仍待验证/);
  assert.doesNotMatch(html, /任务：|PRIVATE_|能力已验证|方法已验证|认证成功/);
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
});

test('a result without listed conditions states the evidence limit instead of inventing success', () => {
  const value = outcome(); value.checks = [];
  const html = renderToStaticMarkup(createElement(TaskOutcomeDetails, { outcome: value }));
  assert.match(html, /没有列出可核验条件/);
  assert.match(html, /只证明列出的条件，方法仍待验证/);
  assert.doesNotMatch(html, /<li>|PRIVATE_/);
});

test('memory provenance distinguishes owner commands and incomplete legacy sources without exposing private mutation payloads', () => {
  const entry: PersonalMemoryEntry = { key: 'fixture.identity', subject: 'owner', purpose: 'identity', value: '一个合成称呼',
    revision: 2, supersedes: 1, kind: 'fact', level: 'explicit', scope: 'global', domains: ['*'], caseIds: [], evidenceIds: [], evidence: [],
    status: 'active', origin: 'owner', effectiveStatus: 'active', createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
    validFrom: '2026-11-09T00:00:00Z', expiresAt: null, history: [],
    mutationSource: { kind: 'owner-command', commandId: 'PRIVATE_COMMAND_ID', acceptedAt: '2026-11-10T00:00:00Z' } };
  entry.history = [{ ...entry, revision: 1, mutationSource: undefined }];
  const runtime = { understanding: [entry], settings: { timezone: 'Asia/Shanghai' }, cases: [], tasks: [] } as unknown as PanelContext['runtime'];
  const context: PanelContext = { runtime, busy: [], perform: async () => true, onOpenPanel() {}, onClose() {}, onSelectCase() {}, onPanelSubmitted() {} };
  const html = renderToStaticMarkup(createElement(MemoryPanel, context));
  assert.match(html, /身份信息/); assert.match(html, /当前版本 2 · 来自你的记忆管理操作/);
  assert.match(html, /早期记录，变更来源未完整记录/);
  assert.doesNotMatch(html, /PRIVATE_COMMAND_ID|commandId|acceptedAt|mutationSource/);
  const oldEntry = { ...entry, key: 'older.paged.record', value: 'OLDER_PAGED_VALUE', revision: 1 };
  const outsideLive = { ...context, runtime: { ...runtime, understanding: [] } };
  const olderHtml = renderToStaticMarkup(createElement(PanelContent, { ...outsideLive, panel: { type: 'editMemory', key: oldEntry.key, entry: oldEntry } }));
  assert.match(olderHtml, /OLDER_PAGED_VALUE/); assert.doesNotMatch(olderHtml, /这份记录已不可用/);
  const staleHtml = renderToStaticMarkup(createElement(EditMemoryPanel, { ...context, entry: { ...oldEntry, value: 'NEWER_LIVE_VALUE', revision: 2 }, initialEntry: oldEntry }));
  assert.match(staleHtml, /OLDER_PAGED_VALUE/); assert.match(staleHtml, /已有新版本，当前草稿尚未保存/);
  assert.match(staleHtml, /type="submit"[^>]*disabled=""/);
});
