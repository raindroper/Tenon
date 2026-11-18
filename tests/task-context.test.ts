import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventInbox, type InboxEvent } from '../server/v2/events.js';
import { SourceRegistry } from '../server/v2/sources.js';
import { MAX_TASK_EVIDENCE_REFS, TaskContext, TaskContextError } from '../server/v2/task-context.js';
import type { TaskRecord } from '../shared/task-consent.js';

const occurredAt = '2026-11-07T08:00:00.000Z';
function task(caseId = 'case-a'): TaskRecord {
  return { id: 'fixture-task', revision: 1, requirementsRevision: 1, state: 'approved', approvalRevision: 1,
    spec: { caseId, title: '关联已有资料', objective: '按本人委托使用相关资料', expectedOutput: '有来源的整理', capabilities: ['artifact'] },
    createdAt: occurredAt, updatedAt: occurredAt };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-context-'));
  const inbox = new EventInbox(join(directory, 'events.sqlite'));
  const connections = new Map<string, { sourceId: string; caseId: string }>();
  const sources = new SourceRegistry(inbox, { resolveConnectorCase: event => {
    const connection = event.sourceGeneration ? connections.get(event.sourceGeneration) : undefined;
    return connection?.sourceId === event.sourceId && connection.caseId === event.caseId ? connection.caseId : undefined;
  } });
  await sources.init();
  const context = new TaskContext({ inbox, sources });
  const source = (id: string, caseId: string, content: string, payload: Record<string, unknown> = {}) => inbox.ingestProcessed({
    sourceId: `store-source:${id}`, externalId: id, caseId, kind: 'owner.source', actor: 'owner', operation: 'create', occurredAt,
    payload: { title: `资料 ${id}`, content, ...payload },
  });
  const connector = (id: string, generation: string, caseId: string, content: string) => {
    const sourceId = `connector:${generation}`; connections.set(generation, { sourceId, caseId });
    return inbox.ingestProcessed({ sourceId, sourceGeneration: generation, externalId: id, caseId,
      kind: 'connector.change', actor: 'external', operation: 'create', occurredAt, payload: { provider: 'github', title: `变更 ${id}`, content } });
  };
  return { directory, inbox, sources, context, connections, source, connector, async close() { await sources.close(); inbox.close(); } };
}

test('search reads only the explicitly selected scene and source, with bounded source excerpts', async () => {
  const f = await fixture();
  try {
    const own = f.source('own', 'case-a', 'MATCH own material');
    f.source('foreign', 'case-b', 'MATCH PRIVATE_FOREIGN_MATERIAL');
    const last = f.source('latest', 'case-a', 'MATCH ' + '正文'.repeat(500));
    f.inbox.ingestProcessed({ sourceId: 'owner-chat', externalId: 'private-chat', caseId: 'case-a', kind: 'owner.message', actor: 'owner',
      operation: 'create', occurredAt, payload: { messageId: 'private-chat', content: 'MATCH personal conversation' } });
    f.inbox.ingestProcessed({ sourceId: 'task-consent', externalId: 'fake-deliverable', caseId: 'case-a', kind: 'task.execute', actor: 'owner',
      operation: 'create', occurredAt, payload: { content: 'MATCH assistant output' } });
    const result = f.context.search({ sourceCaseId: 'case-a', query: 'MATCH', limit: 1 });
    assert.equal(result.events.length, 1); assert.equal(result.events[0].id, last.id);
    assert.equal(result.events[0].sourceCaseId, 'case-a'); assert.equal(result.events[0].excerpt.length, 500);
    assert.equal(result.events[0].occurredAt, occurredAt); assert.equal(result.events[0].title, '资料 latest');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FOREIGN|personal conversation|assistant output/);
    assert.deepEqual(f.context.search({ sourceCaseId: 'case-a', sourceId: own.sourceId, query: 'MATCH' }).events.map(event => event.id), [own.id]);
    assert.throws(() => f.context.search({ sourceCaseId: '', query: 'MATCH' }));
    assert.throws(() => f.context.search({ sourceCaseId: 'case-a', query: 'MATCH', limit: 11 }));
    assert.throws(() => f.context.search({ sourceCaseId: 'case-a', query: 'x'.repeat(201) }));
    assert.deepEqual(f.context.search({ sourceCaseId: 'unknown-scene', query: 'MATCH' }).events, []);
  } finally { await f.close(); }
});

test('task research retains public search attribution and does not turn a gateway summary into original evidence', async () => {
  const f = await fixture();
  try {
    const result = f.inbox.ingestProcessed({ sourceId: 'web:research-run', externalId: 'summary', caseId: 'case-a', kind: 'web.search', actor: 'external',
      operation: 'create', occurredAt, payload: { content: '公开资料摘要', status: 'ok', basis: 'gateway_summary', untrusted: true,
        sources: [{ title: '公开文档', url: 'https://example.test/reference' }] } });
    const references = f.context.capture([result.id], ['case-a']);
    const read = f.context.read({ ...task(), evidenceRefs: references }, result.id);
    assert.equal(read.content, '公开资料摘要'); assert.equal(read.basis, 'gateway_summary'); assert.equal(read.untrusted, true);
    assert.deepEqual(read.sources, result.payload.sources);
    assert.equal(f.context.canRead(task('other-scene'), result.id), false);
  } finally { await f.close(); }
});

test('capture reconstructs exact provenance and a linked event does not open its neighboring source records', async () => {
  const f = await fixture();
  try {
    const linked = f.connector('linked', 'connection-b', 'case-b', 'Only the explicitly linked body');
    const neighbor = f.connector('neighbor', 'connection-b', 'case-b', 'PRIVATE_UNLINKED_NEIGHBOR');
    const original = f.inbox.get(linked.id);
    const active = task();
    assert.equal(f.context.canRead(active, linked.id), false);
    assert.throws(() => f.context.read(active, linked.id), TaskContextError);
    assert.throws(() => f.context.capture([linked.id], ['case-a']), (error: unknown) => error instanceof TaskContextError && error.code === 'invalid_scope');
    active.evidenceRefs = f.context.capture([linked.id, linked.id], ['case-b']);
    assert.deepEqual(active.evidenceRefs, [{ eventId: linked.id, sourceId: linked.sourceId, sourceCaseId: 'case-b', sourceGeneration: 'connection-b' }]);
    assert.equal(f.context.canRead(active, linked.id), true);
    const read = f.context.read(active, linked.id);
    assert.equal(read.content, linked.payload.content); assert.equal(read.actor, 'external'); assert.equal(read.kind, 'connector.change');
    assert.equal(read.sourceCaseId, 'case-b'); assert.equal(read.sourceGeneration, 'connection-b');
    assert.equal(f.context.canRead(active, neighbor.id), false);
    assert.throws(() => f.context.read(active, neighbor.id), TaskContextError);
    assert.deepEqual(f.inbox.get(linked.id), original, 'Linking and reading never rebind or rewrite original evidence');
    assert.equal(f.inbox.list().filter(event => event.kind === 'task.execute').length, 0, 'Evidence is never execution consent');
  } finally { await f.close(); }
});

test('a source reference must match every origin field and cannot smuggle another scene or generation', async () => {
  const f = await fixture();
  try {
    const event = f.connector('reference', 'generation-b', 'case-b', 'Authorized snapshot');
    const [reference] = f.context.capture([event.id], ['case-b']);
    for (const changed of [{ eventId: 'missing-id' }, { sourceId: 'forged-source' }, { sourceCaseId: 'case-a' },
      { sourceGeneration: 'different-generation' }, { sourceGeneration: undefined }]) {
      const target = { ...task(), evidenceRefs: [{ ...reference, ...changed }] };
      assert.equal(f.context.canRead(target, event.id), false);
      assert.throws(() => f.context.read(target, event.id), TaskContextError);
    }
    assert.throws(() => f.context.capture(['missing'], ['case-b']), TaskContextError);
    assert.throws(() => f.context.capture(Array(MAX_TASK_EVIDENCE_REFS + 1).fill(event.id), ['case-b']));
    const forged = f.inbox.ingestProcessed({ sourceId: 'agent-generated', externalId: 'fake-source', caseId: 'case-b', kind: 'owner.source', actor: 'agent',
      operation: 'create', occurredAt, payload: { content: 'Agent output posing as owner material' } });
    assert.throws(() => f.context.capture([forged.id], ['case-b']), TaskContextError);
  } finally { await f.close(); }
});

test('connector removal or generation replacement invalidates both a captured reference and a previous search result', async () => {
  const f = await fixture();
  try {
    const event = f.connector('document', 'connection-old', 'case-b', 'OLD_PRIVATE_BODY');
    const active = { ...task(), evidenceRefs: f.context.capture([event.id], ['case-b']) };
    assert.equal(f.context.search({ sourceCaseId: 'case-b', query: 'OLD_PRIVATE' }).events.length, 1);
    assert.equal(f.context.read(active, event.id).content, 'OLD_PRIVATE_BODY');
    f.connections.delete('connection-old');
    const replacement = f.connector('document', 'connection-new', 'case-b', 'NEW_BODY');
    assert.equal(f.context.canRead(active, event.id), false);
    assert.throws(() => f.context.read(active, event.id), TaskContextError);
    assert.throws(() => f.context.capture([event.id], ['case-b']), TaskContextError);
    assert.deepEqual(f.context.search({ sourceCaseId: 'case-b', query: 'OLD_PRIVATE' }).events, []);
    assert.equal(f.context.canRead(active, replacement.id), false, 'A replacement connection needs its own explicit evidence link');
    assert.equal(f.inbox.get(event.id)?.payload.content, 'OLD_PRIVATE_BODY', 'Revocation filters access while retaining the archive');
  } finally { await f.close(); }
});

test('real workspace source retirement and rebinding cannot transfer linked history to a new scene', async () => {
  const f = await fixture();
  try {
    const root = join(f.directory, 'workspace'); await mkdir(root); await writeFile(join(root, 'context.md'), 'ORIGINAL_WORKSPACE_BODY');
    const source = await f.sources.register({ sourceId: 'workspace-alias', root, caseId: 'case-b', include: ['context.md'] });
    const original = f.inbox.list().find(event => event.sourceGeneration === source.generation)!; assert.ok(original);
    const active = { ...task(), evidenceRefs: f.context.capture([original.id], ['case-b']) };
    assert.equal(f.context.read(active, original.id).content, 'ORIGINAL_WORKSPACE_BODY');
    await f.sources.remove('workspace-alias');
    assert.equal(f.context.canRead(active, original.id), false);
    assert.throws(() => f.context.read(active, original.id), TaskContextError);
    await writeFile(join(root, 'context.md'), 'REPLACEMENT_WORKSPACE_BODY');
    const replacement = await f.sources.register({ sourceId: 'workspace-alias', root, caseId: 'case-c', include: ['context.md'] });
    assert.notEqual(replacement.generation, source.generation);
    assert.deepEqual(f.context.search({ sourceCaseId: 'case-b' }).events, []);
    const fresh = f.context.search({ sourceCaseId: 'case-c' }).events[0]; assert.ok(fresh);
    assert.equal(f.context.canRead(active, fresh.id), false);
    assert.equal(f.inbox.get(original.id)?.caseId, 'case-b');
    assert.equal(f.inbox.get(original.id)?.sourceGeneration, source.generation);
    assert.equal(f.inbox.get(original.id)?.payload.content, 'ORIGINAL_WORKSPACE_BODY');
  } finally { await f.close(); }
});

test('source reads are paginated and never serialize a structured envelope as document text', async () => {
  const f = await fixture();
  try {
    const content = '甲乙丙丁'.repeat(2500);
    const source = f.source('long-source', 'case-a', content, { privateTransportField: 'NOT_SOURCE_TEXT' });
    const active = task();
    assert.equal(f.context.canRead(active, source.id), true);
    const first = f.context.read(active, source.id); assert.equal(first.content.length, 4000); assert.equal(first.nextOffset, 4000);
    const middle = f.context.read(active, source.id, first.nextOffset!); assert.equal(middle.content.length, 4000); assert.equal(middle.nextOffset, 8000);
    const last = f.context.read(active, source.id, middle.nextOffset!); assert.equal(last.content.length, 2000); assert.equal(last.nextOffset, null);
    assert.equal(first.content + middle.content + last.content, content); assert.equal(last.total, content.length);
    assert.doesNotMatch(JSON.stringify(first), /NOT_SOURCE_TEXT|privateTransportField/);
    assert.equal(f.context.read(active, source.id, content.length).content, '');
    assert.throws(() => f.context.read(active, source.id, -1));
    assert.throws(() => f.context.read(active, source.id, 0, 4001));
    assert.throws(() => f.context.read(active, source.id, 0.5));
    const missingBody: InboxEvent = f.inbox.ingestProcessed({ sourceId: 'store-source:deleted', externalId: 'deleted', caseId: 'case-a',
      kind: 'owner.source', actor: 'owner', operation: 'delete', occurredAt, payload: { privateTransportField: 'DO_NOT_SERIALIZE' } });
    assert.equal(f.context.read(active, missingBody.id).content, '');
    assert.equal(f.context.read(active, missingBody.id).operation, 'delete');
  } finally { await f.close(); }
});
