import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CaseMemory } from '../server/v2/memory.js';
import { EventInbox, type EventInput, type InboxEvent } from '../server/v2/events.js';
import { PersonalMemory } from '../server/v2/personal-memory.js';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { MockLanguageModelV4 } from 'ai/test';
import { MockLanguageModelV4 as ScriptedMemoryModel } from './support/model.js';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { EmbeddingModelV4 } from '@ai-sdk/provider';

function fixture(embedder?: EmbeddingModelV4) {
  const prefix = join(tmpdir(), 'rae-personal-memory-test-'); const directory = mkdtempSync(prefix);
  const inbox = new EventInbox(join(directory, 'events.sqlite'));
  const openMemory = () => new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`, 'fixture-owner', undefined, { embedder });
  let memory = openMemory();
  const revoked = new Set<string>();
  const sources = { resolveEventCase: (event: InboxEvent) => event.caseId, isEventAllowed: (event: InboxEvent) => !revoked.has(event.id) };
  let personal = new PersonalMemory({ memory, inbox, sources });
  return { inbox, revoked, sources, get memory() { return memory; }, get personal() { return personal; },
    async seedLegacy(value: unknown) {
      const storage = new LibSQLStore({ id: 'legacy-fixture', url: `file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}` });
      await storage.init();
      try {
        const native = new Memory({ storage });
        const threadId = `core-${createHash('sha256').update('fixture-owner').digest('hex').slice(0, 32)}`;
        await native.createThread({ threadId, resourceId: 'fixture-owner', title: 'Legacy fixture', metadata: { kind: 'shared-core' } });
        await native.updateWorkingMemory({ threadId, resourceId: 'fixture-owner', workingMemory: JSON.stringify(value),
          memoryConfig: { workingMemory: { enabled: true, scope: 'resource', agentManaged: false } } });
      } finally { await storage.close(); }
    },
    owner(caseId: string, content: string, overrides: Partial<EventInput> = {}) {
      return inbox.ingest({ sourceId: 'owner-chat', externalId: randomUUID(), kind: 'owner.message', actor: 'owner', caseId,
        operation: 'create', occurredAt: new Date().toISOString(), payload: { content }, ...overrides }).event;
    },
    async reopen() { await memory.close(); memory = openMemory(); personal = new PersonalMemory({ memory, inbox, sources }); },
    async close(context: { diagnostic(message: string): void }) {
      await memory.close(); inbox.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; context.diagnostic(`cleanupDeferred=${directory}`); }
    } };
}

test('source-bound owner assertions remain explicit without arbitrary expiry while inferred understanding stays provisional', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: '本人身份', objective: '记住本人', domain: 'personal' });
    const event = f.owner(a.id, '我的微信名是青鹭。本次先简短一些。');
    const learned = await f.personal.learn(a.id, event.id, { key: 'owner.wechat', value: '本人微信名：青鹭',
      evidenceExcerpt: '我的微信名是青鹭。', interpretation: 'assertion', purpose: 'identity', identity: { kind: 'alias', platform: 'wechat', value: '青鹭' } });
    assert.equal(learned.entry.level, 'explicit'); assert.equal(learned.entry.expiresAt, null);
    assert.equal(learned.entry.mutationSource?.kind, 'owner-message');
    const inferred = await f.personal.learn(a.id, event.id, { key: 'owner.style', value: '可能偏好简短', evidenceExcerpt: '本次先简短一些。' });
    assert.equal(inferred.entry.level, 'hypothesis'); assert.ok(inferred.entry.expiresAt);
    await assert.rejects(f.personal.learn(a.id, event.id, { key: 'wrong.alias', value: '本人微信名：白鹭', evidenceExcerpt: '我的微信名是青鹭。',
      interpretation: 'assertion', purpose: 'identity', identity: { kind: 'alias', value: '白鹭' } }), /逐字/);
    const external = f.owner(a.id, '我的微信名是青鹭。', { actor: 'external', kind: 'connector.change', sourceId: 'connector:fixture', sourceGeneration: 'fixture' });
    await assert.rejects(f.personal.learn(a.id, external.id, { key: 'external.assertion', value: '青鹭', evidenceExcerpt: '我的微信名是青鹭。', interpretation: 'assertion' }), /本人消息/);
    await f.reopen();
    assert.equal((await f.personal.list()).find(item => item.key === learned.entry.key)!.expiresAt, null);
  } finally { await f.close(context); }
});

test('owner identity and interaction requirements survive method flooding in the actual source-review request', async context => {
  const f = fixture();
  try {
    const scene = await f.memory.createCase({ title: '工作', objective: '查阅相关消息', domain: 'personal' });
    await f.personal.correct('old.identity', { value: '本人别名：青鹭', purpose: 'identity', identity: { kind: 'alias', platform: 'wechat', value: '青鹭' } });
    await f.personal.correct('old.policy', { value: '没有需要本人处理的增量时保持安静', purpose: 'interaction' });
    for (let index = 0; index < 70; index++) await f.personal.correct(`method.${index}`, { subject: 'agent', value: `方法${index}：` + '核对资料。'.repeat(150) });
    await f.memory.setWorking(scene.id, 'LEGACY_UNVERIFIED_OWNER_NAME');
    await f.reopen();
    const calls: Array<Parameters<MockLanguageModelV4['doGenerate']>[0]> = [];
    const model = new MockLanguageModelV4({ doStream: async options => {
      calls.push(options);
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } }); controller.close();
      } }) };
    } });
    const manifests: Array<Awaited<ReturnType<PersonalMemory['contextFor']>>> = [];
    await f.memory.runCase({ caseId: scene.id, model, message: '本批资料', instructions: '只读分析', isolatedSourceReview: true, maxSteps: 1,
      onMemoryContext: value => { manifests.push(value); } });
    assert.match(JSON.stringify(calls[0].prompt), /本人别名：青鹭/);
    assert.match(JSON.stringify(calls[0].prompt), /没有需要本人处理的增量时保持安静/);
    assert.doesNotMatch(JSON.stringify(calls[0].prompt), /LEGACY_UNVERIFIED_OWNER_NAME/);
    assert.equal(manifests[0].identities.length, 1); assert.equal(manifests[0].interactionPolicies.length, 1);
    assert.equal(manifests[0].completeness.complete, false); assert.ok(manifests[0].completeness.omittedCount > 0);
    const omitted = manifests[0].completeness.omitted[0];
    const loaded = await f.personal.readForCase(scene.id, omitted.key);
    assert.ok(loaded); assert.equal(loaded.revision, omitted.revision); assert.ok(loaded.value.length > 500);
    assert.deepEqual(loaded.history, []); assert.deepEqual(loaded.evidence, []);
    assert.equal((await f.personal.list()).length, 72);
  } finally { await f.close(context); }
});

test('current Chinese focus retrieves older applicable owner facts and methods under prompt pressure', async context => {
  const f = fixture();
  try {
    const scene = await f.memory.createCase({ title: '工作', objective: '', domain: 'work' });
    const padding = '进一步核实对应安排。'.repeat(170);
    const preference = '交互评审先核对键盘导航和焦点状态。' + padding;
    const method = '键盘导航方案必须标注焦点顺序。' + padding;
    await f.personal.correct('older.design.preference', { value: preference, scope: 'domain', domains: ['work'] });
    await f.personal.correct('older.design.method', { value: method, subject: 'agent', scope: 'domain', domains: ['work'] });
    await f.personal.correct('other.domain', { value: '键盘导航和交互评审：其他领域', scope: 'domain', domains: ['home'] });
    await f.personal.correct('owner.identity', { value: '本人称呼青鹭', purpose: 'identity', identity: { kind: 'name', value: '青鹭' } });
    for (let index = 0; index < 14; index++) {
      await f.personal.correct(`newer.fact.${index}`, { value: `近期饮食记录 ${index}：` + '米饭和蔬菜。'.repeat(240) });
      if (index < 7) await f.personal.correct(`newer.method.${index}`, { subject: 'agent', value: `近期收纳做法 ${index}：` + '书籍先分类。'.repeat(240) });
    }
    const withoutFocus = await f.personal.contextFor(scene.id);
    assert.ok(withoutFocus.completeness.omitted.some(entry => entry.key === 'older.design.preference'));
    assert.ok(withoutFocus.completeness.omitted.some(entry => entry.key === 'older.design.method'));

    const prompts: string[] = [];
    const model = new ScriptedMemoryModel({ doGenerate: async input => {
      const personal = input.prompt.find(entry => entry.role === 'system' && entry.content.startsWith('本次请求的现行个人记忆'));
      assert.ok(personal?.role === 'system');
      prompts.push(personal.content);
      return { content: [{ type: 'text', text: '已核对。' }], finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } };
    } });
    const request = () => f.memory.runCase({ caseId: scene.id, model, message: '本批资料', instructions: '只读分析',
      memoryFocus: ['交互评审请检查键盘导航'], isolatedSourceReview: true, maxSteps: 1 });
    await request();
    assert.ok(prompts[0].includes(preference));
    assert.ok(prompts[0].includes(method));
    assert.match(prompts[0], /本人称呼青鹭/);
    assert.doesNotMatch(prompts[0], /其他领域/);

    await f.personal.retract('older.design.preference');
    await request();
    assert.ok(!prompts[1].includes(preference));
    assert.ok(prompts[1].includes(method));
  } finally { await f.close(context); }
});

test('semantic synonyms reach the actual prompt while a correction during local embedding stays authoritative', async context => {
  let embeddingStarted!: () => void;
  let finishEmbedding!: () => void;
  const started = new Promise<void>(resolve => { embeddingStarted = resolve; });
  const release = new Promise<void>(resolve => { finishEmbedding = resolve; });
  const batches: string[][] = [];
  const embedder: EmbeddingModelV4 = { specificationVersion: 'v4', provider: 'fixture', modelId: 'fixture',
    maxEmbeddingsPerCall: 64, supportsParallelCalls: false, async doEmbed({ values }) {
      batches.push(values); embeddingStarted(); await release;
      return { embeddings: values.map(value => /代步车|汽车共享|撤回候选/u.test(value) ? [1, 0] : [0, 1]), warnings: [] };
    } };
  const f = fixture(embedder);
  try {
    const scene = await f.memory.createCase({ title: '工作', objective: '', domain: 'work' });
    const detail = '出行安排优先使用汽车共享服务。' + '详细规则留待核对。'.repeat(180);
    const revoked = '撤回候选。' + '详细规则留待核对。'.repeat(180);
    await f.personal.correct('older.travel.preference', { value: detail });
    await f.personal.correct('older.revoked.preference', { value: revoked });
    await f.personal.correct('other.domain', { value: '汽车共享的异域记录', scope: 'domain', domains: ['home'] });
    for (let index = 0; index < 18; index++) {
      await f.personal.correct(`newer.${index}`, { value: `近期饮食记录 ${index}：` + '米饭和蔬菜。'.repeat(240) });
    }
    const withoutFocus = await f.personal.contextFor(scene.id);
    assert.ok(withoutFocus.completeness.omitted.some(entry => entry.key === 'older.travel.preference'));
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const prompts: string[] = [];
    const model = new ScriptedMemoryModel({ doGenerate: async input => {
      const personal = input.prompt.find(entry => entry.role === 'system' && entry.content.startsWith('本次请求的现行个人记忆'));
      assert.ok(personal?.role === 'system');
      prompts.push(personal.content);
      return prompts.length === 1
        ? { content: [{ type: 'tool-call', toolCallId: 'lookup', toolName: 'lookup', input: '{}' }],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, warnings: [], usage }
        : { content: [{ type: 'text', text: '已核对。' }], finishReason: { unified: 'stop', raw: 'stop' }, warnings: [], usage };
    } });
    const lookup = createTool({ id: 'lookup', description: 'Fixture read', inputSchema: z.object({}).strict(), execute: async () => 'OK' });
    const request = f.memory.runCase({ caseId: scene.id, model, tools: { lookup }, message: '本批资料', instructions: '只读分析',
      memoryFocus: ['下周去哪儿租个短途旅行的代步车'], isolatedSourceReview: true, maxSteps: 2 });
    await Promise.race([started, request.then(() => { throw new Error('预期先调用本地嵌入。'); })]);
    try { await f.personal.retract('older.revoked.preference'); }
    finally { finishEmbedding(); }
    await request;
    assert.equal(batches.length, 1);
    assert.ok(batches[0].length <= 17);
    assert.ok(batches[0].some(text => text.includes('撤回候选')));
    assert.ok(!batches[0].some(text => text.includes('异域记录')));
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.ok(prompt.includes(detail));
      assert.ok(!prompt.includes(revoked));
      assert.ok(!prompt.includes('异域记录'));
    }
  } finally { finishEmbedding(); await f.close(context); }
});

test('owner operation provenance cannot be replayed for a different target or action', async context => {
  const f = fixture();
  try {
    const event = f.inbox.ingest({ sourceId: 'owner-memory', externalId: randomUUID(), kind: 'owner.memory', actor: 'owner',
      operation: 'create', occurredAt: new Date().toISOString(), payload: { action: 'correct', key: 'identity', input: { value: '本人明确保存' } } }).event;
    const source = { source: { kind: 'owner-command' as const, commandId: event.id, acceptedAt: event.receivedAt } };
    const entry = await f.personal.correct('identity', { value: '本人明确保存' }, source);
    assert.equal(entry.mutationSource?.kind, 'owner-command');
    await assert.rejects(f.personal.correct('another-target', { value: '不能复用旧操作来源' }, source), /匹配目标/);
    await assert.rejects(f.personal.retract('identity', source), /匹配目标/);
    assert.equal((await f.personal.list()).length, 1);
  } finally { await f.close(context); }
});

test('only a new source-bound explicit identity can become global without broadening an existing memory', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: '个人', objective: '本人自报', domain: 'personal' });
    const b = await f.memory.createCase({ title: '新工作', objective: '另一个领域', domain: 'engineering' });
    const event = f.owner(a.id, '我的微信名是青鹭。');
    const identity = { key: 'identity.global', value: '本人微信名是青鹭', evidenceExcerpt: '我的微信名是青鹭。',
      scope: 'global' as const, purpose: 'identity' as const, identity: { kind: 'alias' as const, platform: 'wechat', value: '青鹭' } };
    await assert.rejects(f.personal.learn(a.id, event.id, identity), /全局自动理解/);
    await f.personal.learn(a.id, event.id, { ...identity, interpretation: 'assertion' });
    assert.equal((await f.personal.contextFor(b.id)).identities[0].value, identity.value);
    await assert.rejects(f.personal.learn(a.id, event.id, { ...identity, key: 'global.policy', purpose: 'interaction', interpretation: 'assertion' }), /全局自动理解/);
    await f.personal.learn(a.id, event.id, { ...identity, key: 'identity.case', scope: 'case', interpretation: 'assertion' });
    const correction = f.owner(a.id, '我的微信名是青鹭。');
    const blocked = await f.personal.learn(a.id, correction.id, { ...identity, key: 'identity.case', interpretation: 'assertion', mode: 'correction' });
    assert.equal(blocked.applied, false); assert.equal(blocked.reason, 'scope_conflict');
    await f.reopen();
    const saved = (await f.personal.list()).find(item => item.key === 'identity.case')!;
    assert.equal(saved.scope, 'case'); assert.deepEqual(saved.caseIds, [a.id]); assert.deepEqual(saved.domains, ['personal']);
    assert.ok(!(await f.personal.forCase(b.id)).some(item => item.key === saved.key));
  } finally { await f.close(context); }
});

test('generic owner correction cannot retain a stale typed alias from the previous value', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: '本人身份', objective: '纠正显示名', domain: 'personal' });
    await f.personal.correct('identity', { value: '微信名为青鹭', purpose: 'identity', identity: { kind: 'alias', platform: 'wechat', value: '青鹭' } });
    const changed = await f.personal.correct('identity', { value: '此前身份理解不准确，等待核对' });
    assert.equal(changed.identity, undefined); assert.equal(changed.purpose, 'context');
    assert.equal((await f.personal.contextFor(a.id)).identities.length, 0);
    const restored = await f.personal.restore('identity', 1);
    assert.equal(restored.identity?.value, '青鹭');
  } finally { await f.close(context); }
});

test('each model dispatch sees the latest correction rather than a frozen pre-run correction notice', async context => {
  const f = fixture();
  try {
    const scene = await f.memory.createCase({ title: '纠正一致性', objective: '核对真实模型输入', domain: 'personal' });
    await f.personal.correct('current-policy', { value: 'POLICY_ORIGINAL' });
    await f.personal.correct('current-policy', { value: 'POLICY_BEFORE_RUN' });
    const stale = await f.personal.correctionsForCase(scene.id);
    const prompts: string[] = [];
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new ScriptedMemoryModel({ doGenerate: async input => {
      prompts.push(JSON.stringify(input.prompt));
      return prompts.length === 1 ? { content: [{ type: 'tool-call', toolCallId: 'change-policy', toolName: 'change_policy', input: '{}' }],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, warnings: [], usage }
        : { content: [{ type: 'text', text: '已按当前更正回答' }], finishReason: { unified: 'stop', raw: 'stop' }, warnings: [], usage };
    } });
    await f.memory.runCase({ caseId: scene.id, model, message: '核对当前口径', instructions: '离线回归', maxSteps: 2, memoryCorrections: stale,
      tools: { change_policy: createTool({ id: 'change_policy', description: 'Offline fixture', inputSchema: z.object({}), execute: async () => {
        await f.personal.correct('current-policy', { value: 'POLICY_CURRENT' }); return { saved: true };
      } }) } });
    assert.equal(prompts.length, 2); assert.match(prompts[0], /POLICY_BEFORE_RUN/);
    assert.match(prompts[1], /POLICY_CURRENT/); assert.doesNotMatch(prompts[1], /POLICY_BEFORE_RUN/);
  } finally { await f.close(context); }
});

test('personal memory pages filter in SQL, preserve old owner identity, and return current revisions beyond 150 methods', async context => {
  const f = fixture();
  try {
    const at = new Date().toISOString();
    await f.seedLegacy({ version: 1, facts: [{ key: 'legacy.owner', value: '旧本人理解', domains: ['*'], evidenceIds: [], createdAt: at, updatedAt: at }] });
    await f.personal.correct('old.identity', { value: '本人微信名为青鹭', purpose: 'identity', identity: { kind: 'alias', value: '青鹭', platform: 'wechat' } });
    for (let index = 0; index < 155; index++) await f.personal.correct(`page.method.${index}`, { subject: 'agent', value: `方法 ${index}` });
    const all = await f.personal.page({ offset: 0, limit: 100 });
    assert.equal(all.total, 157); assert.equal(all.entries.length, 100); assert.equal(all.nextOffset, 100);
    const owners = await f.personal.page({ subject: 'owner', limit: 1 });
    assert.equal(owners.total, 2); assert.equal(owners.entries[0].key, 'old.identity'); assert.equal(owners.nextOffset, 1);
    const legacy = await f.personal.page({ subject: 'owner', offset: 1, limit: 1 });
    assert.equal(legacy.entries[0].key, 'legacy.owner'); assert.equal(legacy.entries[0].subject, 'owner'); assert.equal(legacy.nextOffset, null);
    const methods = await f.personal.page({ subject: 'agent', offset: 150, limit: 100 });
    assert.equal(methods.total, 155); assert.equal(methods.entries.length, 5); assert.equal(methods.nextOffset, null);
    assert.ok(methods.entries.every(entry => entry.subject === 'agent'));
    const beyond = await f.personal.page({ subject: 'owner', offset: 999, limit: 2 });
    assert.equal(beyond.total, 2); assert.equal(beyond.offset, 999); assert.deepEqual(beyond.entries, []); assert.equal(beyond.nextOffset, null);
    const revised = await f.personal.correct('old.identity', { value: '本人微信名为青鹭', expectedRevision: owners.entries[0].revision });
    await f.reopen();
    const reads = f.memory.listSharedFacts.bind(f.memory);
    f.memory.listSharedFacts = async () => { throw new Error('paged reads must not load every entry'); };
    const current = await f.personal.page({ subject: 'owner', limit: 1 });
    assert.equal(current.entries[0].key, revised.key); assert.equal(current.entries[0].revision, revised.revision);
    const keys = new Set<string>();
    for (let offset: number | null = 0; offset !== null;) {
      const page = await f.personal.page({ subject: 'agent', offset, limit: 17 });
      assert.equal(page.total, 155);
      for (const entry of page.entries) { assert.ok(!keys.has(entry.key)); keys.add(entry.key); }
      offset = page.nextOffset;
    }
    assert.equal(keys.size, 155);
    f.memory.listSharedFacts = reads;
    await assert.rejects(f.personal.page({ limit: 201 }), /分页范围/);
  } finally { await f.close(context); }
});

test('owner context publication stamps ignore method learning but reject changed owner versions and source validity', async context => {
  const f = fixture();
  try {
    const scene = await f.memory.createCase({ title: '工作', objective: '后台决定', domain: 'personal' });
    const event = f.owner(scene.id, '请仅汇报需要我处理的事情。');
    const first = await f.personal.learn(scene.id, event.id, { key: 'policy', value: '仅汇报需要本人处理的事情', evidenceExcerpt: '请仅汇报需要我处理的事情。',
      purpose: 'interaction', interpretation: 'assertion' });
    const stamp = await f.personal.ownerDependenciesForCase(scene.id);
    await f.personal.learnMethod(scene.id, event.id, { key: 'method', value: '通知前核对本人关联', evidenceExcerpt: '请仅汇报需要我处理的事情。' });
    assert.doesNotThrow(() => f.personal.assertOwnerDependencies(stamp));
    await assert.rejects(f.personal.correct(first.entry.key, { value: 'stale writer', expectedRevision: 0 }), /当前版本/);
    assert.doesNotThrow(() => f.personal.assertOwnerDependencies(stamp));
    f.revoked.add(event.id);
    assert.throws(() => f.personal.assertOwnerDependencies(stamp), /旧回顾决定/);
    f.revoked.clear();
    await f.personal.correct(first.entry.key, { value: '仅重要的新变化通知', expectedRevision: first.entry.revision });
    assert.throws(() => f.personal.assertOwnerDependencies(stamp), /旧回顾决定/);
  } finally { await f.close(context); }
});

test('authorized connector evidence supports method hypotheses while owner facts and corrections remain protected', async context => {
  const f = fixture();
  try {
    const item = await f.memory.createCase({ title: 'Connector learning', objective: 'Learn a method from permitted evidence', domain: 'work' });
    const other = await f.memory.createCase({ title: 'Other', objective: 'Separate evidence', domain: 'other' });
    const evidence = f.owner(item.id, '先确认范围，再核对负责人。', {
      sourceId: 'connector:grant', sourceGeneration: 'grant', kind: 'connector.change', actor: 'external',
    });
    const input = { key: 'method.verify-scope', value: '查证前先确认范围和负责人。', evidenceExcerpt: '先确认范围，再核对负责人。',
      scope: 'case' as const, mode: 'observe' as const };
    const learned = await f.personal.learnMethod(item.id, evidence.id, input);
    assert.equal(learned.applied, true);
    assert.equal(learned.entry.subject, 'agent');
    assert.equal(learned.entry.level, 'hypothesis');
    await assert.rejects(f.personal.learn(item.id, evidence.id, { ...input, key: 'owner.preference' }), /本人消息/);
    await assert.rejects(f.personal.learnMethod(item.id, evidence.id, { ...input, mode: 'correction' }), /明确方法纠正/);
    await assert.rejects(f.personal.learnMethod(other.id, evidence.id, { ...input, key: 'other' }), /不属于/);
    f.revoked.add(evidence.id);
    assert.equal((await f.memory.sharedForCase(item.id)).length, 0);
    await assert.rejects(f.personal.learnMethod(item.id, evidence.id, { ...input, key: 'after-revoke' }), /来源已失效/);
  } finally { await f.close(context); }
});

test('ordinary low-risk understanding is learned and used without an approval queue, inside its domain', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' });
    const same = await f.memory.createCase({ title: 'Fixture A2', objective: 'Software test', domain: 'design' });
    const other = await f.memory.createCase({ title: 'Fixture B', objective: 'Software test', domain: 'food' });
    const event = f.owner(a.id, '软件测试夹具：答复请先给完整推理。');
    const learned = await f.personal.learn(a.id, event.id, { key: 'fixture.response-depth', value: '夹具偏好：完整推理', kind: 'preference', evidenceExcerpt: '答复请先给完整推理。' });
    assert.equal(learned.applied, true); assert.equal(learned.entry.level, 'hypothesis'); assert.equal(learned.entry.status, 'active'); assert.equal(learned.entry.effectiveStatus, 'active');
    assert.equal((await f.personal.forCase(same.id)).length, 1); assert.equal((await f.personal.forCase(other.id)).length, 0);
    assert.equal((await f.memory.sharedForCase(other.id)).length, 0); assert.equal((await f.memory.sharedForCase(same.id)).length, 1);
    const again = await f.personal.learn(a.id, event.id, { key: learned.entry.key, value: learned.entry.value, evidenceExcerpt: '答复请先给完整推理。' });
    assert.equal(again.applied, false); assert.equal(again.reason, 'duplicate'); assert.equal(again.entry.revision, 1);
  } finally { await f.close(context); }
});

test('explicit owner correction dominates ordinary inference and a new natural-language correction can update it', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' });
    await f.personal.correct('fixture.depth', { value: '夹具明确偏好：详细', scope: 'domain', domains: ['design'] });
    const observed = f.owner(a.id, '软件夹具：这次短一点。');
    const blocked = await f.personal.learn(a.id, observed.id, { key: 'fixture.depth', value: '总是简短', evidenceExcerpt: '这次短一点。' });
    assert.equal(blocked.applied, false); assert.equal(blocked.reason, 'protected_explicit'); assert.equal(blocked.entry.value, '夹具明确偏好：详细');
    const corrected = f.owner(a.id, '软件夹具纠正：以后先简短回答，需要时再展开。');
    const changed = await f.personal.learn(a.id, corrected.id, { key: 'fixture.depth', value: '先简短，需要时展开', mode: 'correction', evidenceExcerpt: '以后先简短回答，需要时再展开。' });
    assert.equal(changed.applied, true); assert.equal(changed.entry.level, 'explicit'); assert.equal(changed.entry.revision, 2);
    assert.equal(changed.entry.evidenceIds[0], corrected.id);
    const replay = await f.personal.learn(a.id, observed.id, { key: 'fixture.depth', value: '旧纠正不可回滚', mode: 'correction', evidenceExcerpt: '这次短一点。' });
    assert.equal(replay.applied, false); assert.equal(replay.reason, 'stale_evidence');
  } finally { await f.close(context); }
});

test('correction and withdrawal prevent exact retired evidence resurfacing under new keys', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: '场景甲', objective: '测试证据重放', domain: 'design' });
    const b = await f.memory.createCase({ title: '场景乙', objective: '测试范围', domain: 'design' });
    const colorExcerpt = '这个场景先用蓝色。';
    const layoutExcerpt = '版面留空一行。';
    const color = f.owner(a.id, `${colorExcerpt}${layoutExcerpt}`);
    const learned = { key: 'fixture.color', value: '蓝色', evidenceExcerpt: colorExcerpt, scope: 'case' as const };
    await f.personal.learn(a.id, color.id, learned);
    const corrected = await f.personal.correct(learned.key, { value: '绿色' });
    const reverted = { ...learned, key: 'fixture.color.alias', value: '用蓝色方案' };
    await assert.rejects(f.personal.learn(a.id, color.id, reverted), /证据关联的记忆已被本人纠正或撤回/);
    const layout = await f.personal.learn(a.id, color.id, { ...learned, key: 'fixture.layout', value: '留一行', evidenceExcerpt: layoutExcerpt });
    assert.equal(layout.applied, true);
    const method = await f.personal.learnMethod(a.id, color.id, { ...learned, key: 'fixture.method.color' });
    assert.equal(method.applied, true, 'the same evidence in another subject has its own lifecycle');
    const otherEvent = f.owner(b.id, colorExcerpt);
    assert.equal((await f.personal.learn(b.id, otherEvent.id, reverted)).applied, true);

    const oldExcerpt = '这个场景先用圆形标签。';
    const old = f.owner(a.id, oldExcerpt);
    const withdrawnInput = { ...learned, key: 'fixture.badge', value: '圆形标签', evidenceExcerpt: oldExcerpt };
    await f.personal.learn(a.id, old.id, withdrawnInput);
    const withdrawn = await f.personal.retract(withdrawnInput.key);
    await f.reopen();
    await assert.rejects(f.personal.learn(a.id, old.id, { ...withdrawnInput, key: 'fixture.badge.alias' }), /证据关联的记忆已被本人纠正或撤回/);
    assert.equal((await f.personal.learn(a.id, f.owner(a.id, oldExcerpt).id, { ...withdrawnInput, key: 'fixture.badge.reaffirmed' })).applied, true);

    const notices = await f.personal.correctionsForCase(a.id);
    assert.deepEqual(notices.find(notice => notice.key === corrected.key), { key: corrected.key, subject: 'owner',
      revision: corrected.revision, updatedAt: corrected.updatedAt, status: 'active', value: '绿色' });
    assert.deepEqual(notices.find(notice => notice.key === withdrawn.key), { key: withdrawn.key, subject: 'owner',
      revision: withdrawn.revision, updatedAt: withdrawn.updatedAt, status: 'retracted' });
    assert.deepEqual(await f.personal.correctionsForCase(b.id), []);
  } finally { await f.close(context); }
});

test('retired evidence stays retired beyond the eight restorable versions and after restart', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: '原场景', objective: '记忆退役', domain: 'design' });
    const b = await f.memory.createCase({ title: '无关场景', objective: '相同领域不同来源', domain: 'design' });
    const evidence = f.owner(a.id, '先用旧方案。另外把日期写在顶部。');
    const linked = { key: 'fixture.durable-linked', value: '旧方案', evidenceExcerpt: '先用旧方案。' };
    await f.personal.learn(a.id, evidence.id, linked);
    await f.personal.correct('fixture.durable-literal', { value: '仅原场景的旧通行码', scope: 'case', caseIds: [a.id] });
    await f.personal.correct(linked.key, { value: '只适用于原场景的新方案', scope: 'case', caseIds: [a.id] });
    await f.personal.correct('fixture.durable-literal', { value: '更新后的通行码' });
    for (const key of [linked.key, 'fixture.durable-literal']) await f.memory.updateSharedFact(key, saved => {
      assert.ok(saved?.personal);
      const { retirements: _retirements, ...personal } = saved.personal;
      return { fact: { ...saved, personal }, result: undefined };
    });
    await f.reopen();
    assert.ok((await f.personal.retiredOwnerEvidence(a.id)).eventIds.has(evidence.id));
    assert.ok((await f.memory.listSharedFacts()).every(fact => !fact.personal?.retirements), 'legacy reads do not rewrite the resource core');
    for (let version = 0; version < 11; version++) {
      await f.personal.correct(linked.key, { value: `更新后的方案 ${version}` });
      await f.personal.correct('fixture.durable-literal', { value: `更新后的通行码 ${version}` });
    }
    await f.reopen();
    const entries = await f.personal.list();
    assert.ok(entries.every(entry => entry.history.length === 8));
    assert.ok(entries.every(entry => entry.history.every(version => version.revision !== 1)));
    const retired = await f.personal.retiredOwnerEvidence(a.id);
    assert.ok(retired.eventIds.has(evidence.id));
    assert.ok(retired.values.includes('仅原场景的旧通行码'));
    assert.deepEqual(await f.personal.retiredOwnerEvidence(b.id), { eventIds: new Set(), values: [] });
    await assert.rejects(f.personal.learn(a.id, evidence.id, { ...linked, key: 'fixture.durable-alias' }), /证据关联的记忆已被本人纠正或撤回/);
    assert.equal((await f.personal.learn(a.id, evidence.id, { key: 'fixture.other-excerpt', value: '日期写在顶部', evidenceExcerpt: '另外把日期写在顶部。' })).applied, true);
  } finally { await f.close(context); }
});

test('restoring an old value makes it current without teaching again from its retired event', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: '原场景', objective: '核对恢复后语义', domain: 'design' });
    const b = await f.memory.createCase({ title: '另一个场景', objective: '不能误伤其他场景', domain: 'design' });
    const event = f.owner(a.id, '先用蓝色。');
    const input = { key: 'fixture.restore-source', value: '蓝色', evidenceExcerpt: '先用蓝色。' };
    await f.personal.learn(a.id, event.id, input);
    await f.personal.correct('fixture.restore-value', { value: '原来用圆形标签', scope: 'case', caseIds: [a.id] });
    await f.personal.retract(input.key);
    await f.personal.retract('fixture.restore-value');
    assert.deepEqual(await f.personal.retiredOwnerEvidence(b.id), { eventIds: new Set(), values: [] });
    await f.personal.restore(input.key, 1);
    await f.personal.restore('fixture.restore-value', 1);
    assert.ok((await f.personal.forCase(a.id)).some(entry => entry.key === input.key && entry.value === input.value));
    assert.ok(!(await f.personal.retiredOwnerEvidence(a.id)).values.includes('原来用圆形标签'));
    assert.ok((await f.personal.retiredOwnerEvidence(a.id)).eventIds.has(event.id));
    await assert.rejects(f.personal.learn(a.id, event.id, { ...input, key: 'fixture.restored-alias' }), /证据关联的记忆已被本人纠正或撤回/);
  } finally { await f.close(context); }
});

test('queued learning sees a preceding correction when evaluating retired evidence', async context => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const a = await f.memory.createCase({ title: '测试场景', objective: '测试个人记忆写入顺序', domain: 'design' });
    const event = f.owner(a.id, '这个场景先用蓝色。');
    const input = { key: 'fixture.race-color', value: '蓝色', evidenceExcerpt: '先用蓝色。' };
    await f.personal.learn(a.id, event.id, input);
    let correctionReading!: () => void;
    const reading = new Promise<void>(resolve => { correctionReading = resolve; });
    const queue = (f.memory as unknown as { sharedWrites: { add(work: () => Promise<void>): Promise<void> } }).sharedWrites;
    const held = queue.add(async () => { correctionReading(); await gate; });
    await reading;
    const correction = f.personal.correct(input.key, { value: '绿色' });
    let aliasSubmitted!: () => void;
    const submitted = new Promise<void>(resolve => { aliasSubmitted = resolve; });
    const update = f.memory.updateSharedFact.bind(f.memory);
    f.memory.updateSharedFact = (key, change) => {
      const pending = update(key, change);
      if (key === 'fixture.race-alias') aliasSubmitted();
      return pending;
    };
    const learned = assert.rejects(f.personal.learn(a.id, event.id, { ...input, key: 'fixture.race-alias' }), /证据关联的记忆已被本人纠正或撤回/);
    await submitted;
    release();
    await held;
    await correction;
    await learned;
    assert.deepEqual((await f.personal.forCase(a.id)).map(entry => entry.value), ['绿色']);
  } finally { release(); await f.close(context); }
});

test('a narrowed memory notifies its former scope without exposing the remaining scope value', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: '场景甲', objective: '原范围', domain: 'design' });
    const b = await f.memory.createCase({ title: '场景乙', objective: '保留范围', domain: 'engineering' });
    const c = await f.memory.createCase({ title: '场景丙', objective: '从未包含', domain: 'design' });
    const key = 'fixture.narrowed';
    await f.personal.correct(key, { value: '原来两边都用蓝色', scope: 'case', caseIds: [a.id, b.id] });
    const narrowed = await f.personal.correct(key, { value: '原来两边都用蓝色', scope: 'case', caseIds: [b.id] });
    assert.deepEqual(await f.personal.correctionsForCase(a.id), [{ key, subject: 'owner', revision: narrowed.revision,
      updatedAt: narrowed.updatedAt, status: 'out_of_scope' }]);
    assert.deepEqual(await f.personal.correctionsForCase(b.id), []);

    const updated = await f.personal.correct(key, { value: '只给乙看的绿色' });
    const header = { key, subject: 'owner', revision: updated.revision, updatedAt: updated.updatedAt };
    assert.deepEqual(await f.personal.correctionsForCase(a.id), [{ ...header, status: 'out_of_scope' }]);
    assert.deepEqual(await f.personal.correctionsForCase(b.id), [{ ...header, status: 'active', value: updated.value }]);
    assert.deepEqual(await f.personal.correctionsForCase(c.id), []);
  } finally { await f.close(context); }
});

test('learning validates real actor, event kind, exact evidence, case ownership and current source validity', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' });
    const b = await f.memory.createCase({ title: 'Fixture B', objective: 'Software test', domain: 'food' });
    const input = { key: 'fixture.habit', value: '测试假设', evidenceExcerpt: '精确夹具证据' };
    const external = f.owner(a.id, '精确夹具证据', { actor: 'external', kind: 'workspace.file' });
    const agent = f.owner(a.id, '精确夹具证据', { actor: 'agent', kind: 'case.wake' });
    const owner = f.owner(a.id, '精确夹具证据');
    await assert.rejects(f.personal.learn(a.id, external.id, input)); await assert.rejects(f.personal.learn(a.id, agent.id, input));
    await assert.rejects(f.personal.learn(b.id, owner.id, input)); await assert.rejects(f.personal.learn(a.id, owner.id, { ...input, evidenceExcerpt: '不存在的引用' }));
    f.revoked.add(owner.id); await assert.rejects(f.personal.learn(a.id, owner.id, input)); assert.deepEqual(await f.personal.list(), []);
  } finally { await f.close(context); }
});

test('case-private understanding stays out of director and other cases; inference cannot expand its scope', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' });
    const b = await f.memory.createCase({ title: 'Fixture B', objective: 'Software test', domain: 'design' });
    const event = f.owner(a.id, '夹具：只对这个事项适用。');
    await f.personal.learn(a.id, event.id, { key: 'fixture.private', value: 'CASE_PRIVATE_SENTINEL', scope: 'case', evidenceExcerpt: '只对这个事项适用。' });
    assert.equal((await f.personal.forCase(a.id)).length, 1); assert.equal((await f.personal.forCase(b.id)).length, 0); assert.equal((await f.personal.forDirector()).length, 0);
    const blocked = await f.personal.learn(a.id, event.id, { key: 'fixture.private', value: '不得扩大范围', scope: 'domain', mode: 'correction', evidenceExcerpt: '只对这个事项适用。' });
    assert.equal(blocked.applied, false); assert.equal(blocked.reason, 'scope_conflict');
    const foreign = f.owner(b.id, '夹具：只对这个事项适用。'); await assert.rejects(f.personal.learn(b.id, foreign.id, { key: 'fixture.private', value: '不能读取其他case版本', evidenceExcerpt: '只对这个事项适用。' }));
  } finally { await f.close(context); }
});

test('source evidence withdrawal removes an insight from actor context including the native shared-fact path', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' }); const event = f.owner(a.id, '夹具证据：先给结论。');
    await f.personal.learn(a.id, event.id, { key: 'fixture.conclusion-first', value: '先结论', evidenceExcerpt: '先给结论。' });
    assert.equal((await f.memory.sharedForCase(a.id)).length, 1); f.revoked.add(event.id);
    assert.equal((await f.personal.list())[0].effectiveStatus, 'evidence_unavailable'); assert.deepEqual(await f.personal.forCase(a.id), []); assert.deepEqual(await f.memory.sharedForCase(a.id), []);
  } finally { await f.close(context); }
});

test('correction, retraction, restoration and version history survive reopening the native resource core', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' }); const event = f.owner(a.id, '夹具证据：尝试详细方案。');
    await f.personal.learn(a.id, event.id, { key: 'fixture.versioned', value: 'first fixture value', evidenceExcerpt: '尝试详细方案。' });
    const corrected = await f.personal.correct('fixture.versioned', { value: 'owner correction' }); assert.equal(corrected.revision, 2);
    const retracted = await f.personal.retract('fixture.versioned'); assert.equal(retracted.revision, 3); assert.equal(retracted.effectiveStatus, 'retracted'); assert.deepEqual(await f.personal.forCase(a.id), []);
    await f.reopen(); const saved = (await f.personal.list())[0]; assert.equal(saved.status, 'retracted'); assert.equal(saved.history.length, 2);
    const restored = await f.personal.restore('fixture.versioned', 1); assert.equal(restored.revision, 4); assert.equal(restored.value, 'first fixture value'); assert.equal(restored.supersedes, 3);
    assert.equal((await f.personal.forCase(a.id))[0].value, restored.value); assert.deepEqual((await f.personal.forCase(a.id))[0].history, []);
    await assert.rejects(f.personal.restore('fixture.versioned', 999));
  } finally { await f.close(context); }
});

test('owner writes remain explicit while expired entries stay outside model context', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' });
    await f.personal.correct('fixture.legacy', { value: 'LEGACY_EXPLICIT_SENTINEL', scope: 'global' });
    const migrated = (await f.personal.list())[0]; assert.equal(migrated.origin, 'owner'); assert.equal(migrated.level, 'explicit'); assert.equal(migrated.revision, 1);
    await f.personal.correct('fixture.expired', { value: 'must not be injected', scope: 'global', expiresAt: '2020-01-01T00:00:00.000Z' });
    assert.equal((await f.personal.list()).find(item => item.key === 'fixture.expired')?.effectiveStatus, 'expired');
    assert.deepEqual((await f.personal.forDirector()).map(item => item.key), ['fixture.legacy']); assert.equal((await f.memory.sharedForCase(a.id)).length, 1);
    await f.personal.correct('fixture.legacy', { value: 'updated legacy owner entry', scope: 'domain', domains: ['design'] });
    assert.equal((await f.personal.list()).find(item => item.key === 'fixture.legacy')?.value, 'updated legacy owner entry');
    const renewed = await f.personal.correct('fixture.expired', { value: 'owner explicitly renews the statement now' });
    assert.equal(renewed.effectiveStatus, 'active'); assert.equal(renewed.expiresAt, null);
  } finally { await f.close(context); }
});

test('structured owner correction feedback is authoritative while ordinary positive feedback is not a correction', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' });
    await f.personal.correct('fixture.feedback', { value: 'before', scope: 'domain', domains: ['design'] });
    const feedback = f.owner(a.id, '', { kind: 'owner.feedback', payload: { verdict: 'off_target', comment: '夹具纠正：先解释依据。' } });
    const result = await f.personal.learn(a.id, feedback.id, { key: 'fixture.feedback', value: '先解释依据', mode: 'correction', evidenceExcerpt: '先解释依据。' });
    assert.equal(result.entry.level, 'explicit'); assert.equal(result.entry.value, '先解释依据');
    const positive = f.owner(a.id, '', { kind: 'owner.feedback', payload: { verdict: 'useful', comment: '夹具：这次挺好。' } });
    await assert.rejects(f.personal.learn(a.id, positive.id, { key: 'fixture.feedback', value: '不应冒充纠正', mode: 'correction', evidenceExcerpt: '这次挺好。' }));
  } finally { await f.close(context); }
});

test('legacy version-one resource content migrates on correction and retains a restorable owner version', async context => {
  const f = fixture();
  try {
    const timestamp = new Date().toISOString();
    await f.seedLegacy({ version: 1, facts: [{ key: 'fixture.old-format', value: 'old owner fixture', domains: ['*'], evidenceIds: ['old-owner-entry'], createdAt: timestamp, updatedAt: timestamp }] });
    assert.equal((await f.personal.list())[0].origin, 'legacy');
    const changed = await f.personal.correct('fixture.old-format', { value: 'new owner fixture' });
    assert.equal(changed.revision, 2); assert.equal(changed.history[0].value, 'old owner fixture');
    await f.reopen(); assert.equal((await f.personal.restore('fixture.old-format', 1)).value, 'old owner fixture');
  } finally { await f.close(context); }
});

test('concurrent automatic observations cannot overwrite an explicit owner correction or revive a retraction', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' }); const event = f.owner(a.id, '夹具观察：这次短一点。');
    await Promise.all([f.personal.learn(a.id, event.id, { key: 'fixture.concurrent', value: 'automatic guess', evidenceExcerpt: '这次短一点。' }),
      f.personal.correct('fixture.concurrent', { value: 'owner decision', scope: 'domain', domains: ['design'] })]);
    assert.equal((await f.personal.list())[0].value, 'owner decision');
    await f.personal.retract('fixture.concurrent');
    const observed = await f.personal.learn(a.id, event.id, { key: 'fixture.concurrent', value: 'automatic revival is forbidden', evidenceExcerpt: '这次短一点。' });
    assert.equal(observed.applied, false); assert.equal(observed.reason, 'retracted'); assert.deepEqual(await f.personal.forCase(a.id), []);
    await f.personal.correct('fixture.only-case', { value: 'owner-scoped fixture', scope: 'case', caseIds: [a.id] });
    assert.equal((await f.personal.forCase(a.id)).length, 1); assert.deepEqual(await f.personal.forDirector(), []);
  } finally { await f.close(context); }
});

test('a model-created wildcard case domain cannot turn an automatic hypothesis into global memory', async context => {
  const f = fixture();
  try {
    const wildcard = await f.memory.createCase({ title: 'Fixture wildcard', objective: 'Software test', domain: '*' });
    const other = await f.memory.createCase({ title: 'Fixture other', objective: 'Software test', domain: 'unrelated' });
    const event = f.owner(wildcard.id, '夹具：仅属当前事项。');
    await assert.rejects(f.personal.learn(wildcard.id, event.id, { key: 'fixture.not-global', value: 'must not become global', evidenceExcerpt: '仅属当前事项。' }), /通配符/);
    await f.personal.learn(wildcard.id, event.id, { key: 'fixture.case-only', value: 'case bounded fixture', scope: 'case', evidenceExcerpt: '仅属当前事项。' });
    assert.deepEqual(await f.personal.forCase(other.id), []); assert.deepEqual(await f.personal.forDirector(), []);
  } finally { await f.close(context); }
});

test('large retained content remains writable while retraction and bounded version history stay available', async context => {
  const f = fixture();
  try {
    const domains = Array.from({ length: 20 }, (_, index) => `fixture-domain-${index}-` + 'd'.repeat(75));
    let created = 0;
    for (let index = 0; index < 64; index++) {
      await f.personal.correct(`fixture.capacity-${index}`, { value: `software fixture ${index}:` + 'v'.repeat(1970), scope: 'domain', domains }); created++;
    }
    assert.equal(created, 64);
    const before = (await f.personal.list()).find(item => item.key === 'fixture.capacity-0')!;
    const withdrawn = await f.personal.retract(before.key);
    assert.equal(withdrawn.status, 'retracted'); assert.equal(withdrawn.history[0].value, before.value);
    assert.equal((await f.personal.list()).length, created, 'Withdrawing is not silent deletion of a retained key');
    const restored = await f.personal.restore(before.key, 1);
    assert.equal(restored.status, 'active'); assert.equal(restored.value, before.value); assert.equal(restored.revision, 3);
    assert.equal(restored.history.length, 2);
    let latest = restored;
    for (let index = 0; index < 10; index++) latest = await f.personal.correct(before.key, { value: before.value });
    assert.equal(latest.history.length, 8);
    assert.deepEqual(latest.history.map(version => version.revision), Array.from({ length: 8 }, (_, index) => latest.revision - 8 + index));
  } finally { await f.close(context); }
});

test('natural correction preserves all original case IDs instead of silently narrowing a multi-case memory', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'design' });
    const b = await f.memory.createCase({ title: 'Fixture B', objective: 'Software test', domain: 'engineering' });
    await f.personal.correct('fixture.multi-case', { value: 'original multi-case fixture', scope: 'case', caseIds: [a.id, b.id] });
    const event = f.owner(a.id, '夹具纠正：两个事项都先核对依据。');
    const updated = await f.personal.learn(a.id, event.id, { key: 'fixture.multi-case', value: '两个事项都先核对依据', mode: 'correction', evidenceExcerpt: '两个事项都先核对依据。' });
    assert.deepEqual(updated.entry.caseIds, [a.id, b.id]);
    assert.equal((await f.personal.forCase(b.id))[0]?.value, '两个事项都先核对依据');
    assert.equal((await f.memory.sharedForCase(b.id))[0]?.value, '两个事项都先核对依据');
  } finally { await f.close(context); }
});

test('owner value correction accepts wildcard-domain case memory while case IDs still form a hard boundary', async context => {
  const f = fixture();
  try {
    const wildcard = await f.memory.createCase({ title: 'Fixture wildcard', objective: 'Software test', domain: '*' });
    const other = await f.memory.createCase({ title: 'Fixture other', objective: 'Software test', domain: 'unrelated' });
    const event = f.owner(wildcard.id, '夹具：仅对本事项。');
    await f.personal.learn(wildcard.id, event.id, { key: 'fixture.wildcard-correction', value: 'first case-only fixture', scope: 'case', evidenceExcerpt: '仅对本事项。' });
    const corrected = await f.personal.correct('fixture.wildcard-correction', { value: 'owner updated case-only fixture' });
    assert.equal(corrected.scope, 'case'); assert.deepEqual(corrected.caseIds, [wildcard.id]);
    assert.equal((await f.personal.forCase(wildcard.id))[0]?.value, corrected.value);
    assert.deepEqual(await f.personal.forCase(other.id), []); assert.deepEqual(await f.memory.sharedForCase(other.id), []); assert.deepEqual(await f.personal.forDirector(), []);
  } finally { await f.close(context); }
});

test('retired keys remain restorable without blocking learning beyond sixty-four keys', async context => {
  const f = fixture();
  try {
    for (let index = 0; index < 64; index++) await f.personal.correct(`fixture.retained-${index}`, { value: `small software fixture ${index}` });
    await f.personal.retract('fixture.retained-0');
    assert.equal((await f.personal.list()).length, 64);
    await f.personal.correct('fixture.retained-65', { value: 'new understanding without silently deleting an older key' });
    const restored = await f.personal.restore('fixture.retained-0', 1);
    assert.equal(restored.status, 'active'); assert.equal((await f.personal.list()).length, 65);
  } finally { await f.close(context); }
});

test('agent method learning is distinct from owner understanding and cannot overwrite the other subject', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    const event = f.owner(a.id, '夹具教学：先核对官方版本，再考虑调整配置。');
    const method = await f.personal.learnMethod(a.id, event.id, { key: 'fixture.method.version-check', value: '先核对官方版本，再考虑调整配置', evidenceExcerpt: '先核对官方版本，再考虑调整配置。' });
    assert.equal(method.entry.subject, 'agent'); assert.equal(method.entry.kind, 'experience'); assert.equal(method.entry.level, 'hypothesis');
    assert.equal((await f.personal.forCase(a.id))[0].subject, 'agent'); assert.equal((await f.personal.forDirector())[0].subject, 'agent');
    await assert.rejects(f.personal.learn(a.id, event.id, { key: method.entry.key, value: '不能变成人格', evidenceExcerpt: '先核对官方版本，再考虑调整配置。' }), /主体|subject|混用/);
    await f.personal.correct('fixture.owner.preference', { value: 'owner fixture', subject: 'owner', scope: 'domain', domains: ['engineering'] });
    await assert.rejects(f.personal.learnMethod(a.id, event.id, { key: 'fixture.owner.preference', value: '不能覆盖本人条目', evidenceExcerpt: '先核对官方版本，再考虑调整配置。' }), /主体|subject|混用/);
    await assert.rejects(f.personal.correct(method.entry.key, { value: '禁止同key换主体', subject: 'owner' }), /主体|subject/);
  } finally { await f.close(context); }
});

test('authorized document snippets teach only hypothetical agent methods and lose eligibility after source revocation', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    const source = f.owner(a.id, '夹具资料：增量同步应保存游标并定期补账。', { kind: 'workspace.file', actor: 'external', sourceGeneration: 'fixture-source-generation' });
    const learned = await f.personal.learnMethod(a.id, source.id, { key: 'fixture.method.cursor', value: '保存游标并定期补账', evidenceExcerpt: '增量同步应保存游标并定期补账。' });
    assert.equal(learned.entry.subject, 'agent'); assert.equal(learned.entry.level, 'hypothesis'); assert.equal(learned.entry.status, 'active');
    await assert.rejects(f.personal.learn(a.id, source.id, { key: 'fixture.owner.from-doc', value: '文档不能代表用户偏好', evidenceExcerpt: '增量同步应保存游标并定期补账。' }));
    await assert.rejects(f.personal.learnMethod(a.id, source.id, { key: learned.entry.key, value: '资料不能冒充明确纠正', mode: 'correction', evidenceExcerpt: '增量同步应保存游标并定期补账。' }));
    f.revoked.add(source.id); assert.equal((await f.personal.list())[0].effectiveStatus, 'evidence_unavailable');
    assert.deepEqual(await f.personal.forCase(a.id), []); assert.deepEqual(await f.memory.sharedForCase(a.id), []);
  } finally { await f.close(context); }
});

test('owner method correction is authoritative teaching, not verified success, and subject survives history operations', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    const first = f.owner(a.id, '夹具教学：先看变更范围。');
    await f.personal.learnMethod(a.id, first.id, { key: 'fixture.method.order', value: '先看变更范围', scope: 'case', evidenceExcerpt: '先看变更范围。' });
    const correction = f.owner(a.id, '', { kind: 'owner.feedback', payload: { verdict: 'correction', comment: '夹具纠正：先读约束，再看变更范围。' } });
    const updated = await f.personal.learnMethod(a.id, correction.id, { key: 'fixture.method.order', value: '先读约束，再看变更范围', mode: 'correction', evidenceExcerpt: '先读约束，再看变更范围。' });
    assert.equal(updated.entry.level, 'explicit'); assert.equal(updated.entry.subject, 'agent'); assert.equal(updated.entry.status, 'active');
    const document = f.owner(a.id, '夹具资料：直接改配置。', { actor: 'external', kind: 'workspace.file' });
    const blocked = await f.personal.learnMethod(a.id, document.id, { key: updated.entry.key, value: '直接改配置', evidenceExcerpt: '直接改配置。' });
    assert.equal(blocked.reason, 'protected_explicit'); assert.equal(blocked.applied, false);
    await f.personal.retract(updated.entry.key); await f.reopen();
    const restored = await f.personal.restore(updated.entry.key, 1); assert.equal(restored.subject, 'agent'); assert.equal(restored.level, 'hypothesis');
    assert.ok(restored.history.every(version => version.subject === 'agent')); assert.deepEqual(await f.personal.forDirector(), []);
  } finally { await f.close(context); }
});

test('agent outputs and tool-result assertions cannot be learned as independently verified capability growth', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    for (const kind of ['case.initiative', 'case.result', 'tool.result']) {
      const ownOutput = f.owner(a.id, '夹具模型自述：已经验证成功。', { actor: 'agent', kind });
      await assert.rejects(f.personal.learnMethod(a.id, ownOutput.id, { key: `fixture.method.${kind}`, value: '不能自证成功', evidenceExcerpt: '已经验证成功。' }));
    }
    await f.personal.correct('fixture.legacy-subject', { value: 'legacy owner fixture', scope: 'global' });
    assert.equal((await f.personal.list())[0].subject, 'owner');
  } finally { await f.close(context); }
});

test('uploaded source knowledge keeps exact-case provenance and cannot claim owner correction authority', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    const b = await f.memory.createCase({ title: 'Fixture B', objective: 'Software test', domain: 'engineering' });
    const source = f.owner(a.id, '夹具上传资料：读取前先验证文件范围。', { kind: 'owner.source', payload: { content: '夹具上传资料：读取前先验证文件范围。', sourceId: 'fixture-upload' } });
    const input = { key: 'fixture.method.boundary', value: '读取前验证文件范围', scope: 'case' as const, evidenceExcerpt: '读取前先验证文件范围。' };
    await assert.rejects(f.personal.learnMethod(b.id, source.id, input));
    await assert.rejects(f.personal.learnMethod(a.id, source.id, { ...input, evidenceExcerpt: '资料里没有这个片段' }));
    const result = await f.personal.learnMethod(a.id, source.id, input); assert.equal(result.entry.level, 'hypothesis');
    await assert.rejects(f.personal.learnMethod(a.id, source.id, { ...input, value: '上传动作不是本人教学纠正', mode: 'correction' }));
    assert.deepEqual(await f.personal.forCase(b.id), []); assert.deepEqual(await f.personal.forDirector(), []);
  } finally { await f.close(context); }
});

test('old version-two metadata defaults both current and historical subjects to owner', async context => {
  const f = fixture();
  try {
    await f.personal.correct('fixture.old-v2-subject', { value: 'original owner fixture' });
    await f.personal.correct('fixture.old-v2-subject', { value: 'updated owner fixture' });
    await f.memory.updateSharedFact('fixture.old-v2-subject', fact => {
      const old = JSON.parse(JSON.stringify(fact));
      delete old.personal.subject;
      for (const version of old.personal.history) delete version.subject;
      return { fact: old, result: undefined };
    });
    const entry = (await f.personal.list())[0]; assert.equal(entry.subject, 'owner'); assert.ok(entry.history.every(version => version.subject === 'owner'));
    assert.equal((await f.personal.restore(entry.key, 1)).subject, 'owner');
  } finally { await f.close(context); }
});

test('owner method correction can preserve an existing global teaching when scope is omitted', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    await f.personal.correct('fixture.method.global', { subject: 'agent', value: 'existing global owner teaching', scope: 'global' });
    const event = f.owner(a.id, '夹具教学纠正：先验证边界，再选择方法。');
    const result = await f.personal.learnMethod(a.id, event.id, { key: 'fixture.method.global', value: '先验证边界，再选择方法', mode: 'correction', evidenceExcerpt: '先验证边界，再选择方法。' });
    assert.equal(result.entry.subject, 'agent'); assert.equal(result.entry.scope, 'global'); assert.equal(result.entry.level, 'explicit');
    assert.equal((await f.personal.forDirector())[0].subject, 'agent');
  } finally { await f.close(context); }
});

test('empty-comment owner ratings can teach hypothetical agent methods without becoming owner features', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    const feedback = f.owner(a.id, '', { kind: 'owner.feedback', payload: { verdict: 'useful', comment: '', targetType: 'message', targetId: 'fixture-reply', targetContent: '夹具回应：先明确假设，再核对证据。' } });
    const input = { key: 'fixture.method.from-rating', value: '类似交流可先明确假设，再核对证据；尚非成功验证', evidenceExcerpt: '先明确假设，再核对证据。' };
    const learned = await f.personal.learnMethod(a.id, feedback.id, input);
    assert.equal(learned.entry.subject, 'agent'); assert.equal(learned.entry.level, 'hypothesis');
    const evidence = (await f.personal.list())[0].evidence[0];
    assert.equal(evidence.eventId, feedback.id); assert.equal(evidence.rating?.verdict, 'useful'); assert.equal(evidence.rating?.targetId, 'fixture-reply');
    assert.match(evidence.rating?.targetContentHash ?? '', /^[a-f0-9]{64}$/);
    await assert.rejects(f.personal.learn(a.id, feedback.id, { ...input, key: 'fixture.owner.must-not-infer' }));
    await f.reopen(); assert.equal((await f.personal.list())[0].evidence[0].rating?.verdict, 'useful');
    f.revoked.add(feedback.id); assert.equal((await f.personal.list())[0].effectiveStatus, 'evidence_unavailable'); assert.deepEqual(await f.personal.forCase(a.id), []);
  } finally { await f.close(context); }
});

test('rated target text never supplies explicit correction authority even for a correction verdict', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    const teaching = f.owner(a.id, '夹具教学：先读约束。');
    await f.personal.learnMethod(a.id, teaching.id, { key: 'fixture.method.rating-no-upgrade', value: '先读约束', evidenceExcerpt: '先读约束。' });
    const feedback = f.owner(a.id, '', { kind: 'owner.feedback', payload: { verdict: 'correction', comment: '', targetType: 'artifact', targetId: 'fixture-artifact', targetContent: '夹具产物：直接改配置。' } });
    await assert.rejects(f.personal.learnMethod(a.id, feedback.id, { key: 'fixture.method.rating-no-upgrade', value: '不得把被评价产物当本人明确教导', mode: 'correction', evidenceExcerpt: '直接改配置。' }), /评价|评分|rating|hypothesis|假设/);
    assert.equal((await f.personal.list())[0].level, 'hypothesis'); assert.equal((await f.personal.list())[0].revision, 1);
    const ordinary = await f.personal.learnMethod(a.id, feedback.id, { key: 'fixture.method.rating-no-upgrade', value: '需重新评估是否先核对配置依据', evidenceExcerpt: '直接改配置。' });
    assert.equal(ordinary.entry.level, 'hypothesis'); assert.equal((await f.personal.list())[0].evidence[0].rating?.verdict, 'correction');
  } finally { await f.close(context); }
});

test('rating evidence requires valid server target metadata and remains bound to the exact snapshot', async context => {
  const f = fixture();
  try {
    const a = await f.memory.createCase({ title: 'Fixture A', objective: 'Software test', domain: 'engineering' });
    const input = { key: 'fixture.method.rating-metadata', value: '待验证方法', evidenceExcerpt: '先核对版本。' };
    for (const metadata of [{ verdict: 'made_up', targetType: 'message', targetId: 'fixture' }, { verdict: 'useful', targetType: 'memory', targetId: 'fixture' }, { verdict: 'useful', targetType: 'artifact', targetId: '' }]) {
      const invalid = f.owner(a.id, '', { kind: 'owner.feedback', payload: { ...metadata, comment: '', targetContent: '上下文A：先核对版本。' } });
      await assert.rejects(f.personal.learnMethod(a.id, invalid.id, input));
    }
    const valid = f.owner(a.id, '', { kind: 'owner.feedback', payload: { verdict: 'off_target', targetType: 'case', targetId: a.id, comment: '', targetContent: '上下文A：先核对版本。' } });
    await f.personal.learnMethod(a.id, valid.id, input);
    const get = f.inbox.get.bind(f.inbox);
    f.inbox.get = id => { const event = get(id); return event && id === valid.id ? { ...event, payload: { ...event.payload, targetContent: '被替换的上下文B：先核对版本。' } } : event; };
    assert.equal((await f.personal.list())[0].effectiveStatus, 'evidence_unavailable');
    f.inbox.get = get; assert.equal((await f.personal.list())[0].effectiveStatus, 'active');
  } finally { await f.close(context); }
});
