import { useEffect, useRef, useState } from 'react';
import type { RuntimeView } from '../../shared/runtime-view';
import type { DesktopNotice } from '../../shared/desktop-notifications';
import { onSessionExpired } from '../api';
import { claimNotifications, createNotificationTracker, groupNotifications, notificationBridge, notificationCandidates,
  notificationPermission, notificationPreferences, subscribeNotificationPreferences, updateUnreadScenes, type NoticeCandidate } from '../lib/notifications';
import { DEFAULT_SCENE_ID } from './ui-state';
import icon from '../assets/tenon-mark.svg';

const emptyUnread: ReadonlySet<string> = new Set();
const windowActive = () => document.visibilityState === 'visible' && document.hasFocus();

function webNotice(notice: DesktopNotice, open: (caseId: string) => void): Notification {
  const notification = new Notification(notice.title, { body: notice.body, tag: notice.key, icon });
  notification.onclick = event => { event.preventDefault(); notification.close(); window.focus(); open(notice.caseId); };
  return notification;
}
export async function sendTestNotification(caseId: string): Promise<void> {
  const notice = { key: `test:${Date.now()}`, title: '榫 · 桌面通知测试', body: '通知已接通。点击可以返回对话。', caseId };
  const bridge = notificationBridge();
  if (bridge) await bridge.show(notice);
  else if (notificationPermission() === 'granted') webNotice(notice, () => {});
  else throw new Error('请先开启桌面通知。');
}

export function useNotifications(runtime: RuntimeView | null, readingCaseId: string | null, openCase: (caseId: string) => void) {
  const [unreadScenes, setUnreadScenes] = useState(emptyUnread);
  const open = useRef(openCase); open.current = openCase;
  const reading = useRef(readingCaseId); reading.current = readingCaseId;
  const receive = useRef<(view: RuntimeView) => void>(() => {});
  const acknowledgeReading = useRef(() => {});
  useEffect(() => {
    const tracker = createNotificationTracker();
    const bridge = notificationBridge();
    const visible = new Set<Notification>();
    let active = true;
    let version = 0;
    let pending: NoticeCandidate[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unread = emptyUnread;
    const syncBadge = (count: number) => { void bridge?.setBadge?.(count).catch(() => {}); };
    const readScene = () => windowActive() ? reading.current : null;
    const publishUnread = (next: ReadonlySet<string>) => {
      if (next === unread) return;
      const previousCount = unread.size;
      unread = next;
      setUnreadScenes(unread);
      if (unread.size !== previousCount) syncBadge(unread.size);
    };
    const acknowledge = () => {
      if (active) publishUnread(updateUnreadScenes(unread, [], readScene()));
    };
    acknowledgeReading.current = acknowledge;
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    const clear = () => {
      version++; clearTimeout(timer); timer = undefined; pending = [];
      for (const notification of visible) notification.close(); visible.clear();
      void bridge?.clear().catch(() => {});
    };
    const flush = () => {
      timer = undefined;
      const batch = pending; pending = [];
      const owner = version;
      const current = () => active && owner === version && (!bridge || !windowActive()) &&
        notificationPreferences().enabled && notificationPermission() === 'granted';
      void claimNotifications(batch, current, async items => {
        for (const notice of groupNotifications(items)) {
          if (!current()) break;
          if (bridge) {
            if (unread.has(notice.caseId)) await bridge.show(notice);
          } else {
            const notification = webNotice(notice, caseId => { if (active) open.current(caseId); });
            visible.add(notification); notification.onclose = () => visible.delete(notification);
            // Bound retained native objects even when a browser omits the close event.
            if (visible.size > 20) { const oldest = visible.values().next().value!; oldest.close(); visible.delete(oldest); }
          }
        }
      }).catch(() => {}); // A denied notification never interrupts the conversation.
    };
    receive.current = view => {
      if (!active) return;
      const preferences = notificationPreferences();
      const fresh = tracker.accept(notificationCandidates(view, preferences.preview));
      const scenes = fresh.filter(item => item.caseId === DEFAULT_SCENE_ID || view.cases.some(scene => scene.id === item.caseId));
      publishUnread(updateUnreadScenes(unread, scenes, readScene()));
      if ((bridge && windowActive()) || !preferences.enabled || notificationPermission() !== 'granted') return;
      pending.push(...scenes);
      if (pending.length && !timer) timer = setTimeout(flush, 700);
    };
    const unsubscribe = subscribeNotificationPreferences(clear);
    const expire = onSessionExpired(() => { active = false; clear(); tracker.reset(); publishUnread(emptyUnread); });
    const detach = bridge?.onOpen(caseId => { if (active) open.current(caseId); });
    return () => {
      active = false;
      clear();
      syncBadge(0);
      receive.current = () => {};
      acknowledgeReading.current = () => {};
      window.removeEventListener('focus', acknowledge);
      document.removeEventListener('visibilitychange', acknowledge);
      unsubscribe(); expire(); detach?.();
    };
  }, []);
  useEffect(() => { if (runtime) receive.current(runtime); }, [runtime]);
  useEffect(() => { acknowledgeReading.current(); }, [readingCaseId]);
  return unreadScenes;
}
