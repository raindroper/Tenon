import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopNotifications, taskbarBadgeBitmap, taskbarBadgeSize, type NativeNotice } from '../desktop/notifications.js';
import { desktopBadgeCountSchema } from '../shared/desktop-notifications.js';

test('the native notifier suppresses ordinary foreground toasts and still supports explicit delivery tests', async () => {
  let foreground = true;
  const shown: string[] = [];
  const service = new DesktopNotifications(title => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    return {
      on(event, listener) { listeners.set(event, listener); },
      show() { shown.push(title); listeners.get('show')?.(); },
      close() { listeners.get('close')?.(); },
    } satisfies NativeNotice;
  }, () => {}, () => foreground);
  const notice = { key: 'message:new:complete', title: '新的场景消息', body: '有新回复', caseId: 'scene' };

  await service.show(notice);
  assert.deepEqual(shown, []);
  assert.throws(() => service.show({ ...notice, url: 'https://example.invalid' }));
  await service.show({ ...notice, key: 'test:1794544800000', title: '桌面通知测试' });
  assert.deepEqual(shown, ['桌面通知测试']);

  foreground = false;
  await service.show(notice);
  assert.deepEqual(shown, ['桌面通知测试', '新的场景消息']);
  service.clear();
});

test('taskbar badge IPC accepts safe counts and the icon has distinct, capped digits', () => {
  for (const count of [0, 1, 24, 99, 100, Number.MAX_SAFE_INTEGER]) {
    assert.equal(desktopBadgeCountSchema.parse(count), count);
  }
  for (const value of [-1, 0.5, '1', undefined, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(desktopBadgeCountSchema.safeParse(value).success, false);
  }

  const bitmap = taskbarBadgeBitmap(1);
  assert.equal(bitmap.length, taskbarBadgeSize * taskbarBadgeSize * 4);
  assert.deepEqual([...bitmap.subarray(0, 4)], [0, 0, 0, 0]);
  assert.notDeepEqual(bitmap, taskbarBadgeBitmap(2));
  assert.notDeepEqual(taskbarBadgeBitmap(9), taskbarBadgeBitmap(99));
  assert.deepEqual(taskbarBadgeBitmap(100), taskbarBadgeBitmap(99));
});
