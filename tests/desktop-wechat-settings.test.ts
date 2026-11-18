import assert from 'node:assert/strict';
import test from 'node:test';
import { readSavedWeChatSettings, sameWeChatChat, type SavedWeChatSelection } from '../desktop/wechat-settings.js';
import { MAX_WECHAT_OBSERVATIONS_PER_DEVICE } from '../shared/wechat-observation.js';

function selection(index: number): Extract<SavedWeChatSelection, { chat: unknown }> {
  return { id: `saved-${index}`, topic: { id: 'case-1', title: '原有主题' }, chat: {
    title: ' 同名微信会话 ', accountId: 'a'.repeat(64), chatId: `${1000 + index}@chatroom`,
  } };
}

test('saved WeChat selections bind the account and chat, independent of labels', () => {
  const entries = [selection(1), selection(2)];
  assert.deepEqual(readSavedWeChatSettings({ autoStart: true, entries }), { autoStart: true, entries });
  assert.equal(sameWeChatChat(entries[0].chat, entries[1].chat), false);
  assert.equal(sameWeChatChat(entries[0].chat, { ...entries[0].chat, title: '改过名的会话' }), true);
  assert.equal(sameWeChatChat(entries[0].chat, { ...entries[0].chat, accountId: 'b'.repeat(64) }), false);
});

test('legacy and invalid WeChat settings cannot auto-start or exceed the device limit', () => {
  const empty = { autoStart: false, entries: [] };
  assert.deepEqual(readSavedWeChatSettings(undefined), empty);
  assert.deepEqual(readSavedWeChatSettings({}), empty);
  assert.deepEqual(readSavedWeChatSettings({ autoStart: 'true', entries: [selection(1)] }), empty);
  assert.deepEqual(readSavedWeChatSettings({ autoStart: true, entries: [] }), empty);
  assert.deepEqual(readSavedWeChatSettings({ autoStart: true,
    entries: Array.from({ length: MAX_WECHAT_OBSERVATIONS_PER_DEVICE + 1 }, (_, index) => selection(index)) }), empty);
  const { id, topic } = selection(1);
  assert.deepEqual(readSavedWeChatSettings({ autoStart: true, entries: [{ id, topic, window: { title: '原有窗口', handle: '1234' } }] }),
    { autoStart: false, entries: [{ id, topic, legacyTitle: '原有窗口' }] });
});

test('tampered WeChat selection entries are removed without exposing rows or credentials', () => {
  const good = selection(1);
  for (const tampered of [
    { ...selection(2), chat: { ...selection(2).chat, title: '  ' } },
    { ...selection(2), chat: { ...selection(2).chat, rows: [{ text: 'never loaded' }] } },
    { ...selection(2), token: 'never loaded' },
    { ...selection(2), topic: { ...selection(2).topic, id: 'https://bad.test/' } },
  ]) {
    assert.deepEqual(readSavedWeChatSettings({ autoStart: true, entries: [tampered, good] }), { autoStart: false, entries: [good] });
  }
});

test('duplicate WeChat entry IDs or chat bindings cannot select a different target', () => {
  const first = selection(1);
  const other = selection(2);
  const keep = selection(3);
  for (const duplicate of [
    { ...other, id: first.id },
    { ...other, chat: { ...first.chat, title: '另一条旧标题' } },
    { ...other, chat: first.chat, topic: { id: 'case-2', title: '另一个主题' } },
  ]) {
    assert.deepEqual(readSavedWeChatSettings({ autoStart: true, entries: [first, duplicate, keep] }), { autoStart: false, entries: [keep] });
  }
});
