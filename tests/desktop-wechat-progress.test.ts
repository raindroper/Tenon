import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WeChatProgressJournal, type WeChatProgress } from '../desktop/wechat-progress.js';

test('encrypted WeChat progress survives a new journal instance and rejects another account binding or corrupt ciphertext', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-wechat-progress-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encrypt = (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  };
  const decrypt = (value: string) => {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  };
  const progress: WeChatProgress = { cursor: 'private-cursor', coverageStartAt: '2026-11-06T10:00:00.000Z',
    pending: { cursor: 'private-next', rows: [{ id: 'message-one', text: 'private synthetic content' }] }, receivedRows: 0, recent: [] };
  await new WeChatProgressJournal(() => directory, encrypt, decrypt).save('selection-one', 'account-one/chat-one/topic-one', progress);
  const filename = path.join(directory, (await readdir(directory))[0]);
  const disk = await readFile(filename, 'utf8');
  assert.ok(!disk.includes('private') && !disk.includes('account-one'));
  const reopened = new WeChatProgressJournal(() => directory, encrypt, decrypt);
  assert.deepEqual(await reopened.load('selection-one', 'account-one/chat-one/topic-one'), progress);
  await assert.rejects(reopened.load('selection-one', 'account-two/chat-one/topic-one'), /断点/);
  await writeFile(filename, JSON.stringify({ encrypted: 'corrupt' }));
  await assert.rejects(reopened.load('selection-one', 'account-one/chat-one/topic-one'), /断点/);
  await reopened.remove('selection-one');
  assert.equal(await reopened.load('selection-one', 'account-one/chat-one/topic-one'), undefined);
});
