import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeView } from '../../shared/runtime-view';
import { api, runtimeViewUrl } from '../api';

export type ConversationPage = Pick<RuntimeView, 'conversation' | 'messages' | 'events' | 'runs'>;

function conversationPage(view: ConversationPage, caseId: string): ConversationPage {
  const messages = view.messages.filter(message => message.caseId === caseId);
  const messageIds = new Set(messages.map(message => message.id));
  const events = view.events.filter(event => event.caseId === caseId && event.messageId && messageIds.has(event.messageId));
  const eventIds = new Set(events.map(event => event.id));
  const runIds = new Set(messages.map(message => message.runId));
  const runs = view.runs.filter(run => runIds.has(run.id) || run.eventId && eventIds.has(run.eventId));
  return { conversation: view.conversation, messages, events, runs };
}

function mergeById<T extends { id: string }>(previous: T[], current: readonly T[]): T[] {
  const merged = new Map(previous.map(item => [item.id, item]));
  let changed = false;
  for (const item of current) {
    if (merged.get(item.id) !== item) { changed = true; merged.set(item.id, item); }
  }
  return changed ? [...merged.values()] : previous;
}

/** Retain observed updates when the server's latest page later rolls past this window. */
export function reconcileConversationPage(previous: ConversationPage, live: ConversationPage): ConversationPage {
  const caseId = previous.conversation.caseId;
  if (!caseId || live.conversation.caseId !== caseId) return previous;
  const currentMessages = new Map(live.messages.map(message => [message.id, message]));
  const updated = previous.messages.map(message => currentMessages.get(message.id) ?? message);
  const messages = updated.some((message, index) => message !== previous.messages[index]) ? updated : previous.messages;
  // New messages belong to the latest page, not to the fixed browsing window.
  const related = conversationPage({ ...live, messages, events: mergeById(previous.events, live.events) }, caseId);
  const events = mergeById(previous.events, related.events);
  const runs = mergeById(previous.runs, related.runs);
  return messages === previous.messages && events === previous.events && runs === previous.runs
    ? previous : { conversation: previous.conversation, messages, events, runs };
}

/** A late older-page response cannot overwrite newer receipts already in the window. */
export function prependConversationPage(older: ConversationPage, current: ConversationPage): ConversationPage {
  return { conversation: older.conversation,
    messages: mergeById(older.messages, current.messages),
    events: mergeById(older.events, current.events),
    runs: mergeById(older.runs, current.runs) };
}

export function useConversationHistory(caseId: string, runtime: RuntimeView, messages: RuntimeView['messages'], onBrowse: (caseId: string | null) => void) {
  const live = runtime.conversation.caseId === caseId ? runtime : null;
  const [history, setHistory] = useState<{ caseId: string; window: ConversationPage; loading: boolean; failed: boolean } | null>(null);
  const request = useRef<AbortController>(null);
  useLayoutEffect(() => {
    setHistory(null);
    onBrowse(null);
    return () => { request.current?.abort(); request.current = null; };
  }, [caseId, onBrowse]);

  const active = history?.caseId === caseId ? history : null;
  const loaded = active?.window;
  const nextBefore = (loaded ?? live)?.conversation.nextBefore ?? null;
  useLayoutEffect(() => {
    if (!live) return;
    setHistory(current => {
      if (!current || current.caseId !== caseId) return current;
      const window = reconcileConversationPage(current.window, live);
      return window === current.window ? current : { ...current, window };
    });
  }, [caseId, live, loaded]);
  const view = useMemo(() => {
    if (!loaded || !live) return { messages: live ? messages : [], events: runtime.events, runs: runtime.runs };
    // Keep the browsed window contiguous as live messages roll out of the server's latest page.
    const window = reconcileConversationPage(loaded, live);
    return {
      messages: window.messages,
      events: mergeById(window.events, live.events),
      runs: mergeById(window.runs, live.runs),
    };
  }, [loaded, live, messages, runtime.events, runtime.runs]);

  async function loadOlder(beforePrepend: () => void) {
    if (!live || !nextBefore || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const window = loaded ?? conversationPage(live, caseId);
    setHistory({ caseId, window, loading: true, failed: false });
    onBrowse(caseId);
    try {
      const response = await api<ConversationPage>(runtimeViewUrl('/api/state', { caseId, before: nextBefore }), 'GET', undefined, controller.signal);
      if (controller.signal.aborted) return;
      if (response.conversation?.caseId !== caseId || response.conversation.before !== nextBefore || response.conversation.nextBefore === nextBefore) {
        throw new Error('历史分页无效。');
      }
      const older = conversationPage(response, caseId);
      beforePrepend();
      setHistory(current => current?.caseId === caseId
        ? { caseId, loading: false, failed: false, window: prependConversationPage(older, current.window) } : current);
    } catch {
      if (!controller.signal.aborted) setHistory(current => current?.caseId === caseId ? { ...current, loading: false, failed: true } : current);
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  function latest() {
    request.current?.abort(); request.current = null;
    setHistory(null);
    onBrowse(null);
  }

  return { view, ready: Boolean(live), nextBefore, loading: active?.loading ?? false, failed: active?.failed ?? false,
    browsing: Boolean(active), loadOlder, latest };
}
