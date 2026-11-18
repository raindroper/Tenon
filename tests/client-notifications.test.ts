import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeView } from '../shared/runtime-view.js';
import type { TaskRecord } from '../shared/task-consent.js';
import { Store } from '../server/store.js';
import { claimNotifications, createNotificationTracker, groupNotifications, notificationCandidates, updateUnreadScenes } from '../client/lib/notifications.js';
import { DesktopNotifications, type NativeNotice } from '../desktop/notifications.js';
import { desktopNoticeSchema } from '../shared/desktop-notifications.js';

function view(): RuntimeView {
  return { settings: { agentName: 'Rae' }, tasks: [], notificationMessages: [], history: { runs: { items: [] } } } as unknown as RuntimeView;
}
const reply = (id: string, outputState: 'streaming' | 'complete' | 'incomplete' = 'complete') =>
  ({ id, caseId: 'other-scene', preview: 'Private reply', createdAt: '2026-11-08T01:00:00Z', outputState });
const task = (state: TaskRecord['state'], revision = 1): TaskRecord => ({ id: 'task', state, revision,
  spec: { caseId: 'other-scene', title: 'Private title', objective: '', expectedOutput: '', capabilities: ['artifact'] }, createdAt: '', updatedAt: '' });

test('old history and streaming fragments stay quiet; a completed reply in another scene notifies once', () => {
  const tracker = createNotificationTracker(); const runtime = view();
  runtime.notificationMessages = [reply('old'), reply('incoming', 'streaming')];
  assert.deepEqual(tracker.accept(notificationCandidates(runtime, false)), []);
  runtime.notificationMessages[1].preview += 'more';
  assert.deepEqual(tracker.accept(notificationCandidates(runtime, false)), []);
  runtime.notificationMessages[1].outputState = 'complete';
  const notices = tracker.accept(notificationCandidates(runtime, false));
  assert.equal(notices.length, 1); assert.equal(notices[0].caseId, 'other-scene');
  assert.doesNotMatch(JSON.stringify(notices), /Private/);
  assert.deepEqual(tracker.accept(notificationCandidates(structuredClone(runtime), false)), [], 'SSE reconnect is not a new outcome');
  runtime.conversation = { caseId: 'old-scene', before: 'old-page', beforeCreatedAt: '', nextBefore: null };
  runtime.messages = [{ id: 'historical', role: 'assistant', content: 'history', createdAt: '' }];
  assert.deepEqual(tracker.accept(notificationCandidates(runtime, false)), [], 'reading history cannot notify');
  tracker.reset(); assert.deepEqual(tracker.accept(notificationCandidates(runtime, false)), [], 'new login establishes a baseline');
});

test('proposals, actual task outcomes, reminders and chat failures notify; prepared outputs do not', () => {
  const runtime = view(); const tracker = createNotificationTracker(); tracker.accept(notificationCandidates(runtime, false));
  runtime.tasks = [task('running')]; runtime.artifacts = [{ id: 'draft', title: '', content: '', format: 'text', createdAt: '', status: 'prepared' }];
  assert.deepEqual(tracker.accept(notificationCandidates(runtime, false)), []);
  runtime.tasks = [task('completed', 3)]; runtime.notificationMessages = [reply('task-result')];
  const notices = tracker.accept(notificationCandidates(runtime, true));
  assert.equal(notices.length, 2); assert.equal(groupNotifications(notices).length, 1);
  assert.match(groupNotifications(notices)[0].title, /任务已完成/);
  runtime.tasks = [task('completed', 4)]; assert.deepEqual(tracker.accept(notificationCandidates(runtime, true)), []);
  runtime.tasks = [task('failed', 5)]; assert.match(tracker.accept(notificationCandidates(runtime, false))[0].title, /任务未完成/);
  runtime.tasks = [task('proposed', 6)]; assert.match(tracker.accept(notificationCandidates(runtime, false))[0].title, /确认/);
  runtime.notificationMessages.push(reply('reminder')); assert.equal(tracker.accept(notificationCandidates(runtime, false)).length, 1);
  runtime.history.runs.items = [{ id: 'run', trigger: 'chat', status: 'failed' } as RuntimeView['runs'][number]];
  assert.match(tracker.accept(notificationCandidates(runtime, false))[0].title, /关注/);
});

test('two tabs claim once under a lock; logout while waiting cancels native delivery', async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  let queue = Promise.resolve();
  const locks = { request: (_name: string, work: () => Promise<void>) => { const next = queue.then(work); queue = next; return next; } } as Pick<LockManager, 'request'>;
  const runtime = view(); runtime.notificationMessages = [reply('new')];
  const candidates = notificationCandidates(runtime, true); const delivered: string[] = [];
  const deliver = async (items: typeof candidates) => { delivered.push(...items.map(item => item.key)); };
  await Promise.all([claimNotifications(candidates, () => true, deliver, storage, locks), claimNotifications(candidates, () => true, deliver, storage, locks)]);
  assert.equal(delivered.length, 1); assert.doesNotMatch([...data.values()].join(''), /Private/);
  let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; });
  let active = true;
  const pending = claimNotifications([{ ...candidates[0], key: 'cancelled' }], () => active, deliver, storage, locks);
  active = false; release(); await pending; assert.equal(delivered.length, 1);
});

test('unread badges group by scene and clear only the latest conversation being read', () => {
  const empty = new Set<string>();
  const first = { caseId: 'first' }; const second = { caseId: 'second' };
  assert.equal(updateUnreadScenes(empty, [first], 'first'), empty, 'the visible scene is already read');
  const unread = updateUnreadScenes(empty, [first, first, second], null);
  assert.deepEqual([...unread], ['first', 'second'], 'background arrivals count once per scene');
  assert.equal(updateUnreadScenes(unread, [], null), unread, 'focus on a modal or a history page does not acknowledge');
  assert.equal(updateUnreadScenes(unread, [first], null), unread);
  const remaining = updateUnreadScenes(unread, [first], 'first');
  assert.deepEqual([...remaining], ['second'], 'returning to the latest page clears only that scene');
  assert.equal(updateUnreadScenes(remaining, [], 'second').size, 0);
});

test('notification projection is bounded, global, public-only and observes committed output states', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rae-notices-')); const store = new Store(directory);
  try {
    for (let index = 0; index < 120; index++) store.insert('messages', { id: `message-${index}`, caseId: index % 2 ? 'one' : 'two',
      role: index % 3 ? 'assistant' : 'user', content: 'x'.repeat(4000), createdAt: '2026-11-08T01:00:00Z', outputState: 'complete' });
    const notices = store.notificationMessages();
    assert.equal(notices[0].id, 'message-20'); assert.ok(notices.length <= 100);
    assert.equal(notices.at(-1)?.id, 'message-119'); assert.ok(notices.every(item => item.preview.length === 160));
    assert.deepEqual(new Set(notices.map(item => item.caseId)), new Set(['one', 'two']));
    store.put('messages', { id: 'pending', role: 'assistant', content: 'partial', caseId: 'two', createdAt: '2026-11-08T02:00:00Z', outputState: 'streaming' });
    assert.equal(store.notificationMessages().find(item => item.id === 'pending')?.outputState, 'streaming');
    store.put('messages', { id: 'emoji', role: 'assistant', content: '🙂'.repeat(200), createdAt: '2026-11-08T03:00:00Z', outputState: 'complete' });
    const runtime = view(); runtime.notificationMessages = store.notificationMessages();
    assert.equal(runtime.notificationMessages.at(-1)?.preview.length, 320, 'SQLite counts Unicode code points, the IPC limit counts UTF-16 units');
    for (const notice of groupNotifications(notificationCandidates(runtime, true))) assert.doesNotThrow(() => desktopNoticeSchema.parse(notice));
    assert.throws(() => store.atomic(() => { store.put('messages', { ...store.get('messages', 'pending')!, outputState: 'complete' }); throw new Error('rollback'); }));
    assert.equal(store.notificationMessages().find(item => item.id === 'pending')?.outputState, 'streaming');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

class FakeNotice implements NativeNotice {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  closed = false;
  on(event: string, callback: (...args: unknown[]) => void) { this.listeners.set(event, [...this.listeners.get(event) ?? [], callback]); }
  emit(event: string) { for (const listener of this.listeners.get(event) ?? []) listener(); }
  show() { this.emit('show'); }
  close() { this.closed = true; this.emit('close'); }
}
test('native notification clicks open the scene; logout invalidates old callbacks and closes native objects', async () => {
  const native: FakeNotice[] = []; const opened: string[] = [];
  const service = new DesktopNotifications(() => { const n = new FakeNotice(); native.push(n); return n; }, id => opened.push(id));
  const notice = { key: 'n', title: 'Rae', body: 'generic', caseId: 'scene' };
  await service.show(notice); native[0].emit('click'); assert.deepEqual(opened, ['scene']);
  service.clear(); assert.equal(native[0].closed, true); native[0].emit('click'); assert.deepEqual(opened, ['scene']);
  assert.throws(() => service.show({ ...notice, url: 'https://external.example' }));
  assert.throws(() => service.show({ ...notice, body: 'x'.repeat(241) }));
});
