import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RuntimeView, RuntimeCase, RuntimeFeedback } from '../shared/runtime-view.js';
import type { PersonalMemoryEntry } from '../shared/personal-memory.js';
import type { Feedback, ReasoningPolicy, Trigger } from '../shared/types.js';
import type { ImageUpload } from '../shared/chat-images.js';
import type { OwnerTaskRequest, TaskRecord } from '../shared/task-consent.js';
import { createApp } from '../server/index.js';
import { RuntimeInputError, type RuntimeApi, type RuntimeFeedbackInput, type RuntimeSourceInput, type PersonalMemoryCorrection } from '../server/runtime.js';
import { Store } from '../server/store.js';
import { taskSpecSchema } from '../server/v2/consent.js';

// Isolated test-file process: never read or inherit a real provider credential.
process.env.DEEPSEEK_API_KEY = '';
const now = () => new Date().toISOString();
class FakeRuntime implements RuntimeApi {
  async getMailOperation() { return null; }
  async listMediaModels() { return { enabled: false, models: [] }; }
  async cancelMediaJob(): Promise<never> { throw new RuntimeInputError(404, '媒体任务不存在。'); }
  async getMediaContent(): Promise<never> { throw new RuntimeInputError(404, '媒体产物不存在。'); }
  async stopChatRun(id: string) {
    if (id !== 'reply-run') throw new RuntimeInputError(404, '对话回复不存在。');
    this.stoppedChatRuns.push(id); return { stopped: true };
  }
  stoppedChatRuns: string[] = [];
  async retryEvent(id: string) { return { id, status: 'pending' }; }
  triggers: Trigger[] = []; started = false; cancelled = 0; chatWasStored = false;
  cases = new Map<string, RuntimeCase>(); facts = new Map<string, PersonalMemoryEntry>();
  tasks = new Map<string, TaskRecord>(); taskActions: { action: string; id: string; revision: number }[] = [];
  constructor(readonly store: Store) {}
  subscribe(listener: () => void) { return this.store.subscribe(listener); }
  start() { this.started = true; }
  stop() { this.started = false; }
  cancel() { this.cancelled++; this.started = false; }
  beginShutdown() { this.stop(); }
  close() { this.stop(); }
  request(trigger: Trigger) { if (trigger === 'chat') this.chatWasStored = this.store.list('messages').some(item => item.role === 'user'); this.triggers.push(trigger); }
  status() { return { state: this.started ? 'idle' as const : 'paused' as const, nextWakeAt: null, lastRunAt: null, lastError: null, todayUsage: this.store.todayUsage(), pending: false }; }
  async checkConnection() { return { ok: true, message: 'test double only' }; }
  async history(scope: Parameters<RuntimeApi['history']>[0]) {
    return scope.kind === 'runs' ? this.store.runHistory(scope)! : { items: [], nextBefore: null };
  }
  async snapshot({ caseId, before }: Parameters<RuntimeApi['snapshot']>[0] = {}): Promise<RuntimeView> {
    const page = this.store.messagePage({ caseId, before });
    if (!page) throw new RuntimeInputError(400, '历史游标无效。');
    return { runtime: 'mastra', schemaVersion: 3, settings: this.store.getSettings(), status: this.status(), messages: page.messages,
      conversation: { caseId: caseId ?? null, before: before ?? null, beforeCreatedAt: page.beforeCreatedAt, nextBefore: page.nextBefore },
      casePreviews: this.store.messagePreviews([...this.cases.keys()]),
      cases: [...this.cases.values()], understanding: [...this.facts.values()], tasks: [...this.tasks.values()], sources: this.store.list('sources'), workspaceSources: [],
      artifacts: this.store.list('artifacts').filter(item => !item.initiativeId).map(item => ({ ...item, status: 'prepared' as const })),
      feedback: this.store.list('feedback').filter(item => ['message', 'artifact', 'case'].includes(item.targetType)) as RuntimeFeedback[],
      runs: this.store.list('runs'), events: [], history: { runs: this.store.runHistory()!, events: { items: [], nextBefore: null } }, grants: [], archive: { readOnly: true, counts: { memories: this.store.list('memories').length, initiatives: this.store.list('initiatives').length, activities: this.store.list('activities').length } } };
  }
  async listTasks() { return [...this.tasks.values()]; }
  async reviseTask(): Promise<never> { throw new RuntimeInputError(404, '任务不存在。'); }
  async requestTask(input: OwnerTaskRequest) {
    const previous = [...this.tasks.values()].find(item => item.ownerRequestId === input.requestId);
    if (previous) { if (JSON.stringify(previous.spec) !== JSON.stringify(input.spec)) throw new RuntimeInputError(409, '委托编号已有不同范围。'); return previous; }
    const record: TaskRecord = { id: randomUUID(), revision: 1, state: 'approved', spec: taskSpecSchema.parse(input.spec), ownerRequestId: input.requestId, createdAt: now(), updatedAt: now(), approvedAt: now() };
    this.tasks.set(record.id, record); return record;
  }
  async taskAction(action: 'approve' | 'reject' | 'revoke', id: string, revision: number) {
    this.taskActions.push({ action, id, revision }); const record = this.tasks.get(id);
    if (!record) throw new RuntimeInputError(404, '任务不存在。');
    if (record.revision !== revision) throw new RuntimeInputError(409, '任务已更新，请刷新后确认。');
    const next: TaskRecord = { ...record, revision: revision + 1, state: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'revoked', updatedAt: now() };
    this.tasks.set(id, next); return next;
  }
  async approveTask(id: string, revision: number) { return this.taskAction('approve', id, revision); }
  async rejectTask(id: string, revision: number) { return this.taskAction('reject', id, revision); }
  async revokeTask(id: string, revision: number) { return this.taskAction('revoke', id, revision); }
  async ingestOwnerMessage(content: string, caseId?: string, replyTo?: string, _attachments?: ImageUpload[], reasoningEffort?: ReasoningPolicy) {
    const target = replyTo ? this.store.get('messages', replyTo) : undefined;
    const message = { id: randomUUID(), role: 'user' as const, content, createdAt: now(), ...(caseId || target?.caseId ? { caseId: caseId ?? target!.caseId } : {}), ...(replyTo ? { replyTo } : {}), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
    this.store.insert('messages', message); this.request('chat'); return { payload: { messageId: message.id } };
  }
  async addSource(input: RuntimeSourceInput) { const source = this.store.insert('sources', { ...input, id: randomUUID(), createdAt: now() }); this.request('source'); return source; }
  async addFeedback(input: RuntimeFeedbackInput): Promise<RuntimeFeedback> {
    const target = input.targetType === 'message' ? this.store.get('messages', input.targetId) : input.targetType === 'artifact' ? this.store.get('artifacts', input.targetId) : this.cases.get(input.targetId);
    if (!target) throw new RuntimeInputError(404, '反馈对象不存在。');
    const caseId = 'caseId' in target ? target.caseId : input.targetType === 'case' ? target.id : undefined;
    const targetContent = 'content' in target ? target.content : 'objective' in target ? target.objective : '';
    const result = { ...input, id: randomUUID(), caseId, targetContent, createdAt: now() };
    this.store.insert('feedback', result as Feedback); this.request('feedback'); return result;
  }
  async createCase(input: { title: string; objective: string; domain: string }) { const id = randomUUID(); const item: RuntimeCase = { ...input, id, threadId: id, status: 'active', createdAt: now(), updatedAt: now() }; this.cases.set(id, item); return item; }
  async listCases() { return [...this.cases.values()]; }
  async listCaseImages(id: string) { return this.store.recentCaseImages(id); }
  async getCase(id: string) { return this.cases.get(id); }
  async getCaseDetails(id: string) { const item = await this.getCase(id); if (!item) throw new RuntimeInputError(404, '事项不存在。'); return { case: item, working: null, history: [], shared: [] }; }
  async updateCase(id: string, patch: { title?: string; objective?: string; status?: 'active' | 'waiting' | 'cancelled' }) { const item = await this.getCase(id); if (!item) throw new RuntimeInputError(404, '事项不存在。'); const saved = { ...item, ...patch, updatedAt: now() }; this.cases.set(id, saved); return saved; }
  async cancelCase(id: string) { return this.updateCase(id, { status: 'cancelled' }); }
  async listPersonalMemory() { return [...this.facts.values()]; }
  async correctPersonalMemory(key: string, input: PersonalMemoryCorrection) {
    const old = this.facts.get(key); const date = now(); const scope = input.scope ?? old?.scope ?? 'global';
    const value: PersonalMemoryEntry = { key, value: input.value, subject: old?.subject ?? input.subject ?? 'owner', kind: input.kind ?? old?.kind ?? 'fact', level: 'explicit', scope,
      domains: scope === 'global' ? ['*'] : input.domains ?? old?.domains ?? ['test'], caseIds: input.caseIds ?? old?.caseIds ?? [], evidenceIds: [], evidence: [],
      status: 'active', effectiveStatus: 'active', origin: 'owner', revision: (old?.revision ?? 0) + 1, supersedes: old?.revision ?? null,
      validFrom: date, expiresAt: input.expiresAt ?? null, createdAt: old?.createdAt ?? date, updatedAt: date, history: old ? [...old.history, old] : [] };
    this.facts.set(key, value); return value;
  }
  async retractPersonalMemory(key: string) { const old = this.facts.get(key); if (!old) throw new RuntimeInputError(404, '理解不存在。'); const saved: PersonalMemoryEntry = { ...old, revision: old.revision + 1, supersedes: old.revision, status: 'retracted', effectiveStatus: 'retracted', updatedAt: now(), history: [...old.history, old] }; this.facts.set(key, saved); return saved; }
  async restorePersonalMemory(key: string, revision: number) { const old = this.facts.get(key); const version = old?.history.find(item => item.revision === revision); if (!old || !version) throw new RuntimeInputError(404, '版本不存在。'); return this.correctPersonalMemory(key, version); }
  async registerWorkspaceSource(input: unknown) { return input; }
  async removeWorkspaceSource() {}
  async prepareWorkspace(input: unknown) { return input; }
  async getWorkspaceHandoff() { throw new RuntimeInputError(409, '没有已验证交接。'); }
  async revokeWorkspace() { return { revoked: true }; }
}
interface Response { status: number; text: string; json: any; headers: Record<string, string | string[] | undefined> }
async function fixture() {
  const prefix = join(tmpdir(), 'rae-api-test-'); const directory = await mkdtemp(prefix); const dist = join(directory, 'dist'); await mkdir(dist); await writeFile(join(dist, 'index.html'), '<!doctype html><title>Test UI</title>');
  const store = new Store(directory); const runtime = new FakeRuntime(store); const app = createApp({ store, runtime, distDir: dist });
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done)); const address = app.address(); assert.ok(address && typeof address === 'object'); const port = address.port;
  return { store, runtime, directory, app,
    call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
      return new Promise((done, fail) => {
        const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
        const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers } }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json: unknown; try { json = JSON.parse(text); } catch {} done({ status: response.statusCode ?? 0, text, json, headers: response.headers }); });
        }); request.on('error', fail); request.end(payload);
      });
    },
    async close() { await new Promise<void>((done, fail) => app.close(error => error ? fail(error) : done())); await runtime.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }); },
  };
}

test('HTTP persists owner messages, supports case/reply context, and cannot inject assistant roles', async () => {
  const f = await fixture(); try {
    const initial = await f.call('/api/state'); assert.equal(initial.status, 200); assert.equal(initial.json.schemaVersion, 3); assert.equal(initial.json.runtime, 'mastra'); assert.deepEqual(initial.json.messages, []); assert.equal(initial.json.memories, undefined);
    const item = await f.runtime.createCase({ title: '项目', objective: '明确事项', domain: 'work' });
    const first = await f.call('/api/messages', 'POST', { content: '我的真实输入', caseId: item.id }); assert.equal(first.status, 202); assert.equal(first.json.caseId, item.id);
    const reply = await f.call('/api/messages', 'POST', { content: '接着这条', replyTo: first.json.id }); assert.equal(reply.status, 202); assert.equal(reply.json.replyTo, first.json.id); assert.equal(reply.json.caseId, item.id);
    assert.equal(f.runtime.chatWasStored, true); assert.deepEqual(f.runtime.triggers, ['chat', 'chat']);
    const other = await f.runtime.createCase({ title: '另一个', objective: '其他事项', domain: 'other' });
    assert.equal((await f.call('/api/messages', 'POST', { content: '错绑', caseId: other.id, replyTo: first.json.id })).status, 409);
    assert.equal((await f.call('/api/messages', 'POST', { content: '伪装', role: 'assistant' })).status, 400);
    assert.equal((await f.call('/api/messages', 'POST', { content: ' ' })).status, 400); assert.equal((await f.call('/api/messages', 'POST', { content: 'x', replyTo: 'missing' })).status, 404);
  } finally { await f.close(); }
});
test('stop reply routes an exact run ID without using global pause or accepting extra scope', async () => {
  const f = await fixture();
  try {
    f.runtime.start();
    assert.equal((await f.call('/api/runs/reply-run/stop', 'POST', { caseId: 'another-scene' })).status, 400);
    assert.equal((await f.call('/api/runs/reply.run/stop', 'POST', {})).status, 400);
    assert.equal((await f.call('/api/runs/unknown/stop', 'POST', {})).status, 404);
    const response = await f.call('/api/runs/reply-run/stop', 'POST', {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { stopped: true });
    assert.deepEqual(f.runtime.stoppedChatRuns, ['reply-run']);
    assert.equal(f.runtime.started, true);
    assert.equal(f.runtime.cancelled, 0);
  } finally { await f.close(); }
});

test('uploaded text uses runtime ingestion, persists on reopen, and enforces filename/text limits', async () => {
  const f = await fixture(); try {
    const response = await f.call('/api/sources', 'POST', { title: '真实材料', content: '今天完成了一次散步。', filename: 'journal.md' }); assert.equal(response.status, 201); assert.equal(response.json.content, '今天完成了一次散步。'); assert.deepEqual(f.runtime.triggers, ['source']);
    const reopened = new Store(f.directory); try { assert.equal(reopened.get('sources', response.json.id)?.filename, 'journal.md'); } finally { reopened.close(); }
    for (const input of [{ title: 'binary', content: 'data', filename: 'tool.exe' }, { title: 'path', content: 'data', filename: '../private.txt' }, { title: 'large', content: 'x'.repeat(200 * 1024 + 1) }]) assert.equal((await f.call('/api/sources', 'POST', input)).status, 400);
    assert.equal((await f.call('/api/sources/' + response.json.id, 'DELETE')).status, 409); assert.ok(f.store.get('sources', response.json.id));
  } finally { await f.close(); }
});
test('owner task requests are strict, versioned, separate from chat, and share canonical/V2 action handlers', async () => {
  const f = await fixture(); try {
    const item = await f.runtime.createCase({ title: '真实关注主题', objective: '来自本人的背景', domain: 'personal' });
    const input: OwnerTaskRequest = { requestId: randomUUID(), spec: { caseId: item.id, title: '本人的明确委托', objective: '本人给出的目标与缘由', expectedOutput: '仅准备一份指定范围内的文本', capabilities: ['artifact'] } };
    const chat = await f.call('/api/messages', 'POST', { content: '我只是聊聊这件事', caseId: item.id });
    assert.equal(chat.status, 202); assert.equal(f.runtime.tasks.size, 0);
    assert.equal((await f.call('/api/messages', 'POST', { content: '不能夹带许可', taskId: 'invented', capabilities: ['workspace'] })).status, 400);
    const requested = await f.call('/api/tasks', 'POST', input); assert.equal(requested.status, 201); assert.equal(requested.json.state, 'approved'); assert.deepEqual(requested.json.spec, input.spec);
    const retry = await f.call('/api/tasks', 'POST', input); assert.equal(retry.json.id, requested.json.id); assert.equal(f.runtime.tasks.size, 1);
    assert.equal((await f.call('/api/tasks', 'POST', { ...input, spec: { ...input.spec, expectedOutput: '偷偷扩大范围' } })).status, 409);
    for (const body of [{ ...input, approved: true }, { ...input, spec: { ...input.spec, capabilities: ['shell'] } }, { ...input, spec: { ...input.spec, capabilities: [] } }, { ...input, spec: { ...input.spec, capabilities: ['workspace'] } }, { ...input, spec: { ...input.spec, workspace: { revision: 1, files: ['not-authorized.txt'] } } }, { ...input, spec: { ...input.spec, maxCostCny: 0 } }, { ...input, spec: { ...input.spec, maxCostCny: 1001 } }, { ...input, spec: { ...input.spec, caseId: 'missing' } }]) {
      const response = await f.call('/api/tasks', 'POST', body); assert.ok([400, 404].includes(response.status), response.text);
    }
    const proposal: TaskRecord = { id: randomUUID(), revision: 7, state: 'proposed', spec: taskSpecSchema.parse(input.spec), sourceEventId: 'evidence-only', createdAt: now(), updatedAt: now() };
    f.runtime.tasks.set(proposal.id, proposal);
    assert.equal((await f.call(`/api/tasks/${proposal.id}/approve`, 'POST', { revision: 6 })).status, 409);
    assert.equal((await f.call(`/api/tasks/${proposal.id}/approve`, 'POST', { revision: 7, spec: input.spec })).status, 400);
    const approved = await f.call(`/api/v2/tasks/${proposal.id}/approve`, 'POST', { revision: 7 }); assert.equal(approved.status, 200); assert.equal(approved.json.revision, 8);
    const revoked = await f.call(`/api/tasks/${proposal.id}/revoke`, 'POST', { revision: 8 }); assert.equal(revoked.json.state, 'revoked');
    const rejectedId = randomUUID(); f.runtime.tasks.set(rejectedId, { ...proposal, id: rejectedId });
    assert.equal((await f.call(`/api/tasks/${rejectedId}/reject`, 'POST', { revision: 7 })).json.state, 'rejected');
    assert.deepEqual(f.runtime.taskActions.at(-1), { action: 'reject', id: rejectedId, revision: 7 });
    assert.equal((await f.call('/api/tasks')).json.length, 3); assert.equal((await f.call('/api/state')).json.tasks.length, 3);
    assert.equal((await f.call('/api/tasks/propose', 'POST', { spec: input.spec })).status, 404);
  } finally { await f.close(); }
});
test('feedback is delegated with real target content/case and caller cannot inject either', async () => {
  const f = await fixture(); try {
    assert.equal((await f.call('/api/feedback', 'POST', { targetType: 'message', targetId: 'missing', verdict: 'useful' })).status, 404);
    const item = await f.runtime.createCase({ title: '事项', objective: '目标正文', domain: 'work' }); const message = await f.call('/api/messages', 'POST', { content: '真实目标正文', caseId: item.id });
    const result = await f.call('/api/feedback', 'POST', { targetType: 'message', targetId: message.json.id, verdict: 'off_target', comment: '偏离了意思' });
    assert.equal(result.status, 201); assert.equal(result.json.caseId, item.id); assert.equal(result.json.targetContent, '真实目标正文'); assert.equal(f.runtime.triggers.at(-1), 'feedback');
    assert.equal((await f.call('/api/feedback', 'POST', { targetType: 'message', targetId: message.json.id, verdict: 'useful', targetContent: '伪造' })).status, 400);
    assert.equal((await f.call('/api/feedback', 'POST', { targetType: 'memory', targetId: 'old', verdict: 'useful' })).status, 410);
  } finally { await f.close(); }
});
test('personal memory correction, retract and restore share canonical/V2 handlers and old records are read-only', async () => {
  const f = await fixture(); try {
    const corrected = await f.call('/api/personal-memory/food.spice', 'PATCH', { value: '少辣', scope: 'global', kind: 'preference' }); assert.equal(corrected.status, 200); assert.equal(corrected.json.level, 'explicit');
    assert.equal((await f.call('/api/v2/personal-memory/food.spice', 'DELETE')).json.status, 'retracted');
    const restored = await f.call('/api/personal-memory/food.spice/restore', 'POST', { revision: 1 }); assert.equal(restored.status, 200); assert.equal(restored.json.status, 'active');
    assert.equal((await f.call('/api/state')).json.understanding[0].value, '少辣');
    const method = await f.call('/api/personal-memory/agent.check_scope', 'PATCH', { value: '交付前核对本人授权范围', subject: 'agent', kind: 'experience' });
    assert.equal(method.status, 200); assert.equal(method.json.subject, 'agent');
    const revisedMethod = await f.call('/api/personal-memory/agent.check_scope', 'PATCH', { value: '交付前先核对范围，再核验结果' });
    assert.equal(revisedMethod.status, 200); assert.equal(revisedMethod.json.subject, 'agent');
    f.store.insert('memories', { id: 'old-memory', content: '旧记录', kind: 'fact', status: 'confirmed', evidence: [], createdAt: now(), updatedAt: now() });
    assert.equal((await f.call('/api/memories/old-memory', 'DELETE')).status, 410); assert.ok(f.store.get('memories', 'old-memory'));
    assert.equal((await f.call('/api/initiatives/old', 'PATCH', { status: 'completed' })).status, 410);
    const exported = await f.call('/api/export'); assert.equal(exported.json.archive.records.memories[0].content, '旧记录'); assert.equal(exported.json.archive.readOnly, true); assert.equal(exported.json.version, 3);
  } finally { await f.close(); }
});
test('settings validate without mutation, saved credentials never return, and controls preserve paused semantics', async () => {
  const f = await fixture(); try {
    for (const input of [{ apiBaseUrl: 'javascript:alert(1)' }, { apiBaseUrl: 'http://remote.invalid' }, { apiBaseUrl: 'https://user:password@example.com' }, { dailyBudgetCny: 0 }, { maxStepsPerRun: 100 }, { enabled: 'true' }, { apiKeyConfigured: true }, { timezone: 'not-a-timezone' }]) assert.equal((await f.call('/api/settings', 'POST', input)).status, 400);
    assert.equal(f.store.getSettings().enabled, false); assert.equal(f.runtime.cancelled, 0);
    const key = 'api-test-key-never-returned'; assert.equal((await f.call('/api/settings', 'POST', { apiKey: key })).status, 400);
    assert.equal(f.store.getApiKey(), undefined, 'retired settings writes cannot change model credentials');
    await f.store.updateSettings({ apiKey: key }); // Isolated legacy fixture for export and response redaction.
    const state = await f.call('/api/state'); const exported = await f.call('/api/export'); assert.equal(state.json.settings.apiKeyConfigured, true); assert.equal(state.text.includes(key), false); assert.equal(exported.text.includes(key), false);
    assert.equal(state.headers['cache-control'], 'no-store'); assert.match(String(exported.headers['content-disposition']), /attachment/);
    assert.equal((await f.call('/api/settings/test', 'POST', {})).json.message, 'test double only');
    await f.call('/api/control', 'POST', { action: 'resume' }); assert.equal(f.runtime.started, true); assert.equal(f.store.getSettings().enabled, true);
    assert.equal(f.runtime.triggers.includes('manual'), false, 'resuming inference does not create a manual reflection');
    await f.call('/api/control', 'POST', { action: 'pause' }); assert.equal(f.runtime.started, false); assert.equal(f.store.getSettings().enabled, false);
  } finally { await f.close(); }
});
test('foreign origins/hosts and invalid JSON writes are rejected before runtime mutation', async () => {
  const f = await fixture(); try {
    const rejectedHeaders: Record<string, string>[] = [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }, { origin: 'null' }];
    for (const headers of rejectedHeaders) assert.equal((await f.call('/api/state', 'GET', undefined, headers)).status, 403);
    assert.equal((await f.call('/api/state', 'GET', undefined, { origin: 'http://127.0.0.1:5173' })).status, 200);
    assert.equal((await f.call('/api/messages', 'POST', { content: 'csrf' }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await f.call('/api/messages', 'POST', '{malformed')).status, 400);
    assert.equal((await f.call('/api/messages', 'POST', 'x'.repeat(2 * 1024 * 1024 + 1))).status, 400);
    assert.equal((await f.call('/api/sources', 'POST', 'x'.repeat(512 * 1024 + 1))).status, 400); assert.deepEqual(f.store.list('messages'), []);
  } finally { await f.close(); }
});
test('valid owner requests are not rejected by an HTTP envelope size cap', async () => {
  const f = await fixture();
  try {
    const response = await f.call('/api/messages', 'POST', JSON.stringify({ content: 'Large transport envelope' }) + ' '.repeat(2 * 1024 * 1024 + 1));
    assert.equal(response.status, 202, response.text);
    assert.equal(f.store.list('messages')[0].content, 'Large transport envelope');
  } finally { await f.close(); }
});

test('static serving still fences traversal and serves the built app with CSP', async () => {
  const f = await fixture(); try {
    for (const path of ['/%2e%2e/credentials.json', '/..%5ccredentials.json', '/%00']) assert.equal((await f.call(path)).status, 400);
    const home = await f.call('/'); assert.equal(home.status, 200); assert.match(home.text, /Test UI/); assert.match(String(home.headers['content-security-policy']), /script-src 'self'/);
    assert.equal((await f.call('/assets/missing.js')).status, 404); assert.equal((await f.call('/api/not-real')).status, 404);
  } finally { await f.close(); }
});
