import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { RunResponse } from '../server/v2/run-response.js';

test('cold task recovery changes the outcome without overwriting already persisted public text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-response-recover-')); let store = new Store(directory);
  const options = { runId: 'task-run', caseId: 'scene', replyTo: 'owner-request', automatic: true, assertOwned() {} };
  const original = new RunResponse(store, options);
  original.append('真实目录列表。\n\n已经收到的部分分析。'); original.checkpoint(); original.dispose();
  const createdAt = store.get('messages', original.id)!.createdAt;
  store.close(); store = new Store(directory);
  const recovered = new RunResponse(store, { ...options, replyTo: undefined, resume: true });
  try {
    recovered.finish('incomplete', '原模型交付中断，未重新执行。', true);
    assert.equal(store.get('messages', original.id)?.content, '真实目录列表。\n\n已经收到的部分分析。');
    assert.equal(store.get('messages', original.id)?.createdAt, createdAt);
    assert.equal(store.get('messages', original.id)?.replyTo, 'owner-request');
    assert.equal(store.get('messages', original.id)?.outputState, 'incomplete');
    assert.equal(store.list('messages').length, 1);
  } finally { recovered.dispose(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('explicit retry of a failed observation updates its durable notification without repeating it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-observation-response-'));
  const store = new Store(directory);
  const first = new RunResponse(store, { runId: 'first', notificationKey: 'same-observation', caseId: 'topic', automatic: false, assertOwned() {} });
  const second = () => new RunResponse(store, { runId: 'retry', notificationKey: 'same-observation', caseId: 'topic', automatic: false, assertOwned() {} });
  try {
    first.notify('已经确认的群内决定。'); first.freeze();
    const retry = second();
    assert.equal(retry.notify('已经确认的群内决定。'), first.id);
    retry.notify('补充的执行时间。'); retry.finish('complete'); retry.dispose();
    assert.equal(store.list('messages').length, 1);
    assert.equal(store.get('messages', first.id)?.content, '已经确认的群内决定。\n\n补充的执行时间。');
  } finally { first.dispose(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('notification and streaming text share one durable record, deduplicate identical content and retain new content', async () => {
  const prefix = join(tmpdir(), 'rae-run-response-'); const directory = await mkdtemp(prefix); const store = new Store(directory);
  const reply = new RunResponse(store, { runId: 'test-run', caseId: 'test-case', automatic: true, assertOwned() {} });
  try {
    const id = reply.notify('这条提醒已经保存。');
    reply.append('这条提醒'); reply.append('已经保存。'); reply.append('另外还有一段新的解释。');
    reply.finish('complete');
    assert.equal(store.list('messages').length, 1);
    assert.equal(store.get('messages', id)?.content, '这条提醒已经保存。另外还有一段新的解释。');
    assert.equal(store.get('messages', id)?.outputState, 'complete');
    assert.equal(store.get('messages', id)?.outputNote, undefined);
  } finally { reply.dispose(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
});

test('stopping a response flushes already accepted text, preserves it on reopen, and rejects later text without writing', async () => {
  const prefix = join(tmpdir(), 'rae-response-stop-'); const directory = await mkdtemp(prefix); let store = new Store(directory);
  const reply = new RunResponse(store, { runId: 'test-run', caseId: 'test-case', automatic: true, assertOwned() {} });
  try {
    reply.append('已经收到的开头。'); reply.append('尚未定时刷盘的尾部。'); reply.freeze(); reply.append('停止后来的内容不能写入。');
    store.close(); store = new Store(directory);
    const restored = store.get('messages', reply.id);
    assert.equal(restored?.content, '已经收到的开头。尚未定时刷盘的尾部。');
    assert.equal(restored?.outputState, 'incomplete'); assert.match(restored?.outputNote ?? '', /已保留/);
  } finally { reply.dispose(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
});

test('a short distinct answer is not hidden merely because its text occurs inside a prior notification', async () => {
  const prefix = join(tmpdir(), 'rae-response-distinct-'); const directory = await mkdtemp(prefix); const store = new Store(directory);
  const reply = new RunResponse(store, { runId: 'test-run', caseId: 'test-case', automatic: true, assertOwned() {} });
  try {
    reply.notify('我认为不是。'); reply.append('是。'); reply.finish('complete');
    assert.equal(store.get('messages', reply.id)?.content, '是。\n\n我认为不是。');
  } finally { reply.dispose(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); }
});
