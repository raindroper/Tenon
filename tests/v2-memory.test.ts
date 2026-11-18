import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MockLanguageModelV4 } from 'ai/test';
import { CaseMemory } from '../server/v2/memory.js';
import { putSharedFact } from './support/shared-fact.js';

type MockPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type MockOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 8, text: 8, reasoning: 0 } };
function modelFixture() {
  const prompts: MockOptions[] = [];
  const model = new MockLanguageModelV4({ doStream: async options => {
    prompts.push(options);
    const parts: MockPart[] = [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: '本地无付费模型夹具回答。' }, { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }];
    return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
  } });
  return { model, prompts };
}
function directoryFixture() {
  const prefix = join(tmpdir(), 'rae-case-memory-'); const directory = mkdtempSync(prefix);
  const url = `file:${join(directory, 'memory.db').replaceAll('\\', '/')}`;
  return { url, async cleanup() {
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // npm test verifies removal after the native-client worker exits.
    }
  } };
}

test('native Mastra catalog, thread working state, domain sharing and history survive reopening', async () => {
  const f = directoryFixture(); let memory = new CaseMemory(f.url, 'test-owner'); const fixture = modelFixture();
  try {
    await memory.init();
    const ui = await memory.createCase({ title: 'UI优化', objective: '完善项目界面', domain: 'design' });
    const lunch = await memory.createCase({ title: '午餐', objective: '考虑今天的午餐', domain: 'food' });
    assert.equal((await memory.listCases()).length, 2);
    await memory.setWorking(ui.id, 'UI_WORKING_SENTINEL：继续比较字号。');
    await memory.setWorking(lunch.id, 'LUNCH_WORKING_SENTINEL：先核对营业时间。');
    await putSharedFact(memory, { key: 'language', value: 'GLOBAL_CHINESE：用中文', domains: ['*'], evidenceIds: ['user-explicit-language'] });
    await putSharedFact(memory, { key: 'food-allergy', value: 'FOOD_ONLY_PEANUT：忌花生', domains: ['food'], evidenceIds: ['user-explicit-allergy'] });
    await putSharedFact(memory, { key: 'design-style', value: 'DESIGN_ONLY_WHITESPACE：设计喜留白', domains: ['design'], evidenceIds: ['ui-feedback'] });
    assert.deepEqual((await memory.sharedForCase(ui.id)).map(fact => fact.key).sort(), ['design-style', 'language']);
    assert.deepEqual((await memory.sharedForCase(lunch.id)).map(fact => fact.key).sort(), ['food-allergy', 'language']);

    let finishedSteps = 0;
    const options = { model: fixture.model, instructions: '只处理当前事项，不混用其他事项。', maxSteps: 2,
      providerOptions: { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'low' } } as const,
      onStepFinish: () => { finishedSteps++; } };
    const uiRun = await memory.runCase({ ...options, caseId: ui.id, message: 'UI_HISTORY_SENTINEL：调整排版。' });
    await memory.runCase({ ...options, caseId: lunch.id, message: 'LUNCH_HISTORY_SENTINEL：安排午饭。' });
    await memory.runCase({ ...options, caseId: ui.id, message: '继续刚才UI工作。' });
    assert.equal(uiRun.steps, 1); assert.equal(uiRun.usage.inputTokens, 20); assert.equal(uiRun.usage.outputTokens, 8);
    assert.equal(finishedSteps, 3);
    assert.deepEqual(fixture.prompts[0].providerOptions, options.providerOptions);
    const uiPrompt = JSON.stringify(fixture.prompts[2].prompt); const lunchPrompt = JSON.stringify(fixture.prompts[1].prompt);
    assert.match(uiPrompt, /UI_HISTORY_SENTINEL|UI_WORKING_SENTINEL/); assert.match(uiPrompt, /GLOBAL_CHINESE|DESIGN_ONLY_WHITESPACE/);
    assert.doesNotMatch(uiPrompt, /LUNCH_HISTORY_SENTINEL|LUNCH_WORKING_SENTINEL|FOOD_ONLY_PEANUT/);
    assert.match(lunchPrompt, /LUNCH_WORKING_SENTINEL|FOOD_ONLY_PEANUT/); assert.doesNotMatch(lunchPrompt, /UI_HISTORY_SENTINEL|UI_WORKING_SENTINEL|DESIGN_ONLY_WHITESPACE/);
    await memory.updateCase(ui.id, { title: 'UI排版优化', status: 'waiting', objective: '等待实际使用反馈' });
    assert.match((await memory.getWorking(ui.id))!, /UI_WORKING_SENTINEL/);

    await memory.close(); memory = new CaseMemory(f.url, 'test-owner'); await memory.init();
    assert.equal((await memory.getCase(ui.id))?.status, 'waiting'); assert.equal((await memory.getCase(ui.id))?.title, 'UI排版优化');
    assert.equal((await memory.listCases()).length, 2);
    assert.match((await memory.getWorking(ui.id))!, /UI_WORKING_SENTINEL/); assert.match((await memory.getWorking(lunch.id))!, /LUNCH_WORKING_SENTINEL/);
    assert.match(JSON.stringify(await memory.history(ui.id)), /UI_HISTORY_SENTINEL/); assert.doesNotMatch(JSON.stringify(await memory.history(ui.id)), /LUNCH_HISTORY_SENTINEL/);
    assert.match(JSON.stringify(await memory.history(lunch.id)), /LUNCH_HISTORY_SENTINEL/);
    assert.deepEqual((await memory.sharedForCase(lunch.id)).map(fact => fact.key).sort(), ['food-allergy', 'language']);
  } finally { await memory.close(); await f.cleanup(); }
});

test('ownership is enforced and cancelled case cannot call a model', async () => {
  const f = directoryFixture(); const owner = new CaseMemory(f.url, 'owner-one'); const stranger = new CaseMemory(f.url, 'owner-two'); const fixture = modelFixture();
  try {
    const item = await owner.createCase({ title: '私有事项', objective: '只属于一个用户', domain: 'work' });
    await assert.rejects(stranger.history(item.id)); await assert.rejects(stranger.setWorking(item.id, '禁止写入'));
    assert.equal((await stranger.listCases()).length, 0);
    await owner.updateCase(item.id, { status: 'cancelled' });
    await assert.rejects(owner.runCase({ caseId: item.id, message: '不要运行', model: fixture.model, instructions: '本地测试' }), /已取消/);
    assert.equal(fixture.prompts.length, 0);
  } finally { await owner.close(); await stranger.close(); await f.cleanup(); }
});

test('concurrent shared writes do not lose other fields and updates retain creation time', async () => {
  const f = directoryFixture(); const memory = new CaseMemory(f.url, 'test-owner');
  try {
    const item = await memory.createCase({ title: '测试事项', objective: '检查共享写入', domain: 'food' });
    await Promise.all(Array.from({ length: 6 }, (_, i) => putSharedFact(memory, { key: `fact-${i}`, value: `value-${i}`, domains: ['food'], evidenceIds: [`real-event-${i}`] })));
    const facts = await memory.sharedForCase(item.id); assert.equal(facts.length, 6);
    const original = facts.find(fact => fact.key === 'fact-0')!;
    await putSharedFact(memory, { key: original.key, value: 'updated-value', domains: ['food'], evidenceIds: ['user-correction'] });
    const updated = (await memory.sharedForCase(item.id)).find(fact => fact.key === original.key)!;
    assert.equal(updated.value, 'updated-value'); assert.equal(updated.createdAt, original.createdAt); assert.deepEqual(updated.evidenceIds, ['user-correction']);
    await assert.rejects(putSharedFact(memory, { key: 'empty-scope', value: 'bad', domains: [], evidenceIds: ['event'] }));
  } finally { await memory.close(); await f.cleanup(); }
});

test('an already-upgraded runtime refuses a mixed backup missing the authoritative memory ledger', async () => {
  const f = directoryFixture();
  const ledgerFile = f.url.replace(/^file:/, '') + '.events.sqlite';
  let memory = new CaseMemory(f.url, 'test-owner', undefined, { personalMemoryFile: ledgerFile });
  try {
    await memory.init();
    await putSharedFact(memory, { key: 'current', value: 'current owner data', domains: ['*'], evidenceIds: [] });
    await memory.close();
    unlinkSync(ledgerFile);
    memory = new CaseMemory(f.url, 'test-owner', undefined, { personalMemoryFile: ledgerFile, personalMemoryRequireCutover: true });
    await assert.rejects(memory.init(), /不匹配的备份/);
  } finally { await memory.close(); await f.cleanup(); }
});
