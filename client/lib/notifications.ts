import type { RuntimeView } from '../../shared/runtime-view';
import type { DesktopNotice, NotificationBridge } from '../../shared/desktop-notifications';

export interface NoticeCandidate extends DesktopNotice { priority: number }
export interface NotificationPreferences { enabled: boolean; preview: boolean }
export const notificationPreferenceKey = 'rae.notifications.v1';
const deliveredKey = 'rae.notifications.delivered.v1';
const changedEvent = 'rae-notifications-changed';
export function notificationBridge(): NotificationBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { raeNotifications?: NotificationBridge }).raeNotifications;
}
export function notificationPermission(): NotificationPermission | 'unsupported' | 'upgrade' {
  if (notificationBridge()) return 'granted';
  if (typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent)) return 'upgrade';
  if (typeof window === 'undefined' || !window.isSecureContext || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}
export function notificationPreferences(): NotificationPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(notificationPreferenceKey) ?? '{}');
    return { enabled: value?.enabled === true, preview: value?.preview === true };
  } catch { return { enabled: false, preview: false }; }
}
export function saveNotificationPreferences(value: NotificationPreferences): void {
  localStorage.setItem(notificationPreferenceKey, JSON.stringify(value));
  window.dispatchEvent(new Event(changedEvent));
}
export function subscribeNotificationPreferences(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === notificationPreferenceKey) listener(); };
  window.addEventListener(changedEvent, listener); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(changedEvent, listener); window.removeEventListener('storage', storage); };
}

/** Only public, durable outcomes; prepared artifacts and stream fragments never mean completion. */
export function notificationCandidates(view: RuntimeView, preview: boolean): NoticeCandidate[] {
  const agent = view.settings.agentName || '榫';
  const result: NoticeCandidate[] = [];
  for (const message of view.notificationMessages ?? []) {
    if (message.outputState === 'streaming' || !message.preview.trim()) continue;
    result.push({ key: `message:${message.id}:${message.outputState ?? 'complete'}`, caseId: message.caseId ?? 'personal-growth',
      title: `${agent} · ${message.outputState === 'incomplete' ? '回复未完成' : '新消息'}`.slice(0, 120),
      body: preview ? message.preview.slice(0, 160) : '有新的回复或提醒，点击查看。', priority: message.outputState === 'incomplete' ? 2 : 1 });
  }
  const titles = { proposed: '有事项待你确认', completed: '任务已完成', failed: '任务未完成' };
  for (const task of view.tasks) {
    if (!(task.state in titles)) continue;
    const label = titles[task.state as keyof typeof titles];
    result.push({ key: `task:${task.id}:${task.requirementsRevision ?? 1}:${task.state}`, caseId: task.spec.caseId,
      title: `${agent} · ${label}`.slice(0, 120), body: preview ? task.spec.title.slice(0, 160) : `${label}，点击查看详情。`, priority: 3 });
  }
  for (const run of view.history.runs.items) {
    if (run.trigger !== 'chat' || !['failed', 'interrupted'].includes(run.status)) continue;
    result.push({ key: `run:${run.id}:${run.status}`, caseId: run.caseId ?? 'personal-growth',
      title: `${agent} · 回复需要关注`.slice(0, 120), body: '本次处理未完成，点击查看详情。', priority: 2 });
  }
  return result;
}

/** First authenticated snapshot is a baseline, never a backlog of popups. */
export function createNotificationTracker() {
  let previous: Set<string> | undefined;
  return {
    accept(candidates: NoticeCandidate[]): NoticeCandidate[] {
      const next = new Set(candidates.map(item => item.key));
      const fresh = previous ? candidates.filter(item => !previous!.has(item.key)) : [];
      previous = next; return fresh;
    },
    reset() { previous = undefined; },
  };
}

export function updateUnreadScenes(unread: ReadonlySet<string>, fresh: readonly Pick<NoticeCandidate, 'caseId'>[],
  readingCaseId: string | null): ReadonlySet<string> {
  let next: Set<string> | undefined;
  if (readingCaseId !== null && unread.has(readingCaseId)) {
    next = new Set(unread);
    next.delete(readingCaseId);
  }
  for (const { caseId } of fresh) {
    if (caseId === readingCaseId || (next ?? unread).has(caseId)) continue;
    next ??= new Set(unread);
    next.add(caseId);
  }
  return next ?? unread;
}

export function groupNotifications(candidates: NoticeCandidate[]): DesktopNotice[] {
  const groups = new Map<string, NoticeCandidate>();
  for (const candidate of candidates) {
    const previous = groups.get(candidate.caseId);
    if (!previous || candidate.priority >= previous.priority) groups.set(candidate.caseId, candidate);
  }
  return [...groups.values()].map(({ priority: _priority, ...notice }) => notice);
}

/** Origin-local receipt IDs only. A Web Lock prevents two tabs claiming the same event. */
export async function claimNotifications(candidates: NoticeCandidate[], current: () => boolean,
  deliver: (items: NoticeCandidate[]) => Promise<void>, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  locks: Pick<LockManager, 'request'> | undefined = navigator.locks): Promise<void> {
  const claim = async () => {
    if (!current()) return;
    let saved: unknown;
    try { saved = JSON.parse(storage.getItem(deliveredKey) ?? '[]'); } catch { saved = []; }
    const ids = new Set<string>(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string').slice(-2000) : []);
    const fresh = candidates.filter(item => !ids.has(item.key));
    if (!fresh.length) return;
    for (const item of fresh) ids.add(item.key);
    // Persist claims before any OS side effect. No retry storm for OS-suppressed notifications.
    storage.setItem(deliveredKey, JSON.stringify([...ids].slice(-2000)));
    if (current()) await deliver(fresh);
  };
  if (locks) await locks.request('rae-notifications', claim); else await claim();
}
