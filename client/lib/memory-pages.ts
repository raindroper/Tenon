import type { PersonalMemoryEntry, PersonalMemoryPage, PersonalMemorySubject } from '../../shared/personal-memory';
import { api } from '../api';

export interface MemoryPageState {
  subject: PersonalMemorySubject;
  entries: PersonalMemoryEntry[];
  total: number | null;
  nextOffset: number | null;
  loaded: boolean;
  loading: boolean;
  error: string;
}
type PageReader = (subject: PersonalMemorySubject, offset: number, limit: number, signal: AbortSignal) => Promise<PersonalMemoryPage | PersonalMemoryEntry[]>;
const readPage: PageReader = (subject, offset, limit, signal) => api(`/api/personal-memory?${new URLSearchParams({ subject, offset: String(offset), limit: String(limit) })}`, 'GET', undefined, signal);

/** Panel-owned pages only. Browsing older memories never enlarges the live RuntimeView. */
export function createMemoryPager(initial: readonly PersonalMemoryEntry[] = [], read: PageReader = readPage) {
  let live = initial;
  let state: MemoryPageState = { subject: 'owner', entries: initial.filter(entry => entry.subject === 'owner'),
    total: null, nextOffset: null, loaded: false, loading: false, error: '' };
  let active = false, epoch = 0, liveRevision = 0;
  let request: AbortController | undefined;
  let failed: { offset: number; replace: boolean } | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<MemoryPageState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const latest = (entry: PersonalMemoryEntry, values: readonly PersonalMemoryEntry[], preferSameRevision = false) => {
    const current = values.find(value => value.key === entry.key);
    return current && (current.revision > entry.revision || preferSameRevision && current.revision === entry.revision) ? current : entry;
  };
  const normalize = (result: PersonalMemoryPage | PersonalMemoryEntry[], subject: PersonalMemorySubject, offset: number): PersonalMemoryPage => {
    // The previous kernel's finite full-list endpoint ignored pagination query parameters.
    if (Array.isArray(result)) {
      const entries = result.filter(entry => entry.subject === subject);
      return { entries, total: entries.length, offset, nextOffset: null };
    }
    if (!result || !Array.isArray(result.entries) || result.offset !== offset || !Number.isSafeInteger(result.total) || result.total < 0
      || result.nextOffset !== null && (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset)
      || result.entries.some(entry => entry.subject !== subject)) throw new Error('记忆列表分页数据不匹配，请重试。');
    return result;
  };
  const load = async (offset: number, replace: boolean): Promise<boolean> => {
    if (!active || state.loading) return false;
    const token = ++epoch, subject = state.subject, liveAtStart = liveRevision;
    const controller = new AbortController(); request = controller;
    update({ loading: true, error: '' });
    try {
      const page = normalize(await read(subject, offset, 50, controller.signal), subject, offset);
      if (!active || token !== epoch || controller.signal.aborted) return false;
      const entries = new Map((replace ? [] : state.entries).map(entry => [entry.key, entry]));
      for (const original of page.entries) {
        const entry = latest(latest(original, state.entries), live, liveRevision > liveAtStart);
        if (entry.subject === subject) entries.set(entry.key, entry);
      }
      failed = undefined;
      update({ entries: [...entries.values()], total: page.total, nextOffset: page.nextOffset, loaded: true });
      return true;
    } catch (error) {
      if (!active || token !== epoch || controller.signal.aborted) return false;
      failed = { offset, replace };
      update({ error: error instanceof Error ? error.message : '记忆列表未读取完成，请重试。' });
      return false;
    } finally {
      if (active && token === epoch) { request = undefined; update({ loading: false }); }
    }
  };
  const stop = () => { active = false; epoch++; request?.abort(); request = undefined; if (state.loading) update({ loading: false }); };
  const reconcile = (values: readonly PersonalMemoryEntry[]) => {
    if (values === live) return;
    live = values; liveRevision++;
    let changed = false;
    const entries = state.entries.flatMap(entry => {
      const current = latest(entry, values, true);
      if (current.subject !== state.subject) { changed = true; return []; }
      if (current.revision !== entry.revision || current.effectiveStatus !== entry.effectiveStatus) { changed = true; return [current]; }
      return [entry];
    });
    if (changed) update({ entries });
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { active = true; if (!state.loaded) void load(0, true); return stop; }, stop,
    setSubject(subject: PersonalMemorySubject) {
      if (subject === state.subject) return;
      epoch++; request?.abort(); request = undefined; failed = undefined;
      update({ subject, entries: live.filter(entry => entry.subject === subject), total: null, nextOffset: null, loaded: false, loading: false, error: '' });
      if (active) void load(0, true);
    },
    loadMore: () => state.loaded && state.nextOffset !== null ? load(state.nextOffset, false) : Promise.resolve(false),
    refresh: () => load(0, true),
    retry: () => failed ? load(failed.offset, failed.replace) : load(0, true),
    reconcile,
    updateEntry(entry: PersonalMemoryEntry) { reconcile([entry, ...live.filter(value => value.key !== entry.key)]); },
  };
}
