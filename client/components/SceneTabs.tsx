import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { RuntimeCase, RuntimeView } from '../../shared/runtime-view';
import { taskNeedsAttention } from '../../shared/task-consent';
import { DEFAULT_SCENE_ID, sceneName } from '../state/ui-state';

export const sceneTabId = (id: string) => `scene-tab-${encodeURIComponent(id)}`;

function SceneNoticeDot({ unread, pending }: { unread: boolean; pending: boolean }) {
  return unread || pending ? <span className="scene-notice-dot" data-unread={unread || undefined} aria-hidden="true" /> : null;
}

function sceneNoticeLabel(unread: boolean, pending: boolean) {
  return `${unread ? '，有未读更新' : ''}${pending ? '，有任务待确认' : ''}`;
}

export function packSceneTabs(
  ids: string[],
  selectedId: string,
  widths: Record<string, number>,
  gap: number,
  moreWidth: number,
  available: number,
) {
  const size = (id: string, cap?: number) => {
    const width = widths[id] ?? 0;
    return cap != null && id === selectedId ? Math.min(width, cap) : width;
  };
  const usedBy = (list: string[], cap?: number) => {
    if (!list.length) return 0;
    return list.reduce((sum, id) => sum + size(id, cap), 0) + gap * (list.length - 1);
  };

  if (usedBy(ids) <= available) {
    return { visible: ids, overflow: [] as string[], selectedMax: undefined as number | undefined };
  }

  const tabBudget = Math.max(0, available - moreWidth - gap);
  const selectedMax = ids.includes(selectedId) && (widths[selectedId] ?? 0) > tabBudget
    ? Math.max(48, tabBudget)
    : undefined;

  const visible: string[] = [];
  for (const id of ids) {
    if (usedBy([...visible, id], selectedMax) <= tabBudget) visible.push(id);
    else break;
  }

  if (ids.includes(selectedId) && !visible.includes(selectedId)) {
    const selectedWidth = size(selectedId, selectedMax);
    while (visible.length && usedBy(visible, selectedMax) + gap + selectedWidth > tabBudget) {
      visible.pop();
    }
    visible.push(selectedId);
  }

  const visibleSet = new Set(visible);
  return { visible, overflow: ids.filter(id => !visibleSet.has(id)), selectedMax };
}

export function SceneTabs({ cases, tasks, selectedId, unreadScenes, onSelect, onCreate }: {
  cases: RuntimeCase[];
  tasks: RuntimeView['tasks'];
  selectedId: string;
  unreadScenes: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const pending = new Set(tasks.filter(taskNeedsAttention).map(task => task.spec.caseId));
  const hasNotice = (id: string) => unreadScenes.has(id) || pending.has(id);
  const scenes = cases.filter(item => item.id === DEFAULT_SCENE_ID || item.id === selectedId || item.status === 'active' || item.status === 'waiting' || unreadScenes.has(item.id))
    .sort((a, b) => a.id === DEFAULT_SCENE_ID ? -1 : b.id === DEFAULT_SCENE_ID ? 1 : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const tabs = scenes.map(item => ({ id: item.id, title: sceneName(item.id, item.title),
    stopped: item.status === 'cancelled' || item.status === 'completed' }));
  if (!tabs.some(item => item.id === DEFAULT_SCENE_ID)) {
    tabs.unshift({ id: DEFAULT_SCENE_ID, title: sceneName(DEFAULT_SCENE_ID), stopped: false });
  }
  const ids = tabs.map(item => item.id);
  const tabKey = JSON.stringify(tabs.map(item => [item.id, item.title, hasNotice(item.id)]));

  const navRef = useRef<HTMLElement>(null);
  const clusterRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const metricsRef = useRef<HTMLDivElement>(null);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const [visibleIds, setVisibleIds] = useState(ids);
  const [overflowIds, setOverflowIds] = useState<string[]>([]);
  const [selectedMax, setSelectedMax] = useState<number | undefined>();
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const create = createRef.current;
    const metrics = metricsRef.current;
    const cluster = clusterRef.current;
    if (!nav || !create || !metrics || !cluster) return;

    const layout = () => {
      const tabNodes = [...metrics.querySelectorAll<HTMLElement>('[data-metric="tab"]')];
      const moreNode = metrics.querySelector<HTMLElement>('[data-metric="more"]');
      const widths: Record<string, number> = {};
      for (const node of tabNodes) {
        const id = node.dataset.id;
        if (id) widths[id] = node.getBoundingClientRect().width;
      }
      const moreWidth = moreNode?.getBoundingClientRect().width ?? 0;
      const clusterGap = Number.parseFloat(getComputedStyle(cluster).columnGap || getComputedStyle(cluster).gap) || 10;
      const tabGap = Number.parseFloat(getComputedStyle(metrics).columnGap || getComputedStyle(metrics).gap) || 4;
      const available = nav.clientWidth - create.getBoundingClientRect().width - clusterGap;
      const packed = packSceneTabs(ids, selectedId, widths, tabGap, moreWidth, available);
      setVisibleIds(packed.visible);
      setOverflowIds(packed.overflow);
      setSelectedMax(packed.selectedMax);
      if (!packed.overflow.length) setMoreOpen(false);
    };

    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(nav);
    void document.fonts?.ready.then(layout);
    return () => observer.disconnect();
  }, [tabKey, selectedId]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!moreWrapRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const INSET = 11;
  const tabsRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  const visibleTabs = visibleIds.flatMap(id => tabs.filter(item => item.id === id));
  const overflowTabs = overflowIds.flatMap(id => tabs.filter(item => item.id === id));
  const overflowUnread = overflowTabs.some(item => unreadScenes.has(item.id));
  const overflowPending = overflowTabs.some(item => pending.has(item.id));

  const placeInk = (animate: boolean) => {
    const ink = inkRef.current;
    const selected = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!ink) return;
    ink.dataset.ready = animate ? 'true' : 'false';
    if (!selected) {
      ink.style.width = '0px';
      return;
    }
    ink.style.width = `${Math.max(0, selected.offsetWidth - INSET * 2)}px`;
    ink.style.transform = `translateX(${selected.offsetLeft + INSET}px)`;
  };

  useLayoutEffect(() => {
    placeInk(false);
    const frame = requestAnimationFrame(() => placeInk(true));
    const observer = new ResizeObserver(() => placeInk(true));
    if (tabsRef.current) observer.observe(tabsRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [selectedId, visibleIds.join('\0'), selectedMax]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, fromId: string) => {
    const index = visibleIds.indexOf(fromId);
    if (index < 0) return;
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % visibleIds.length;
    else if (event.key === 'ArrowLeft') next = (index + visibleIds.length - 1) % visibleIds.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visibleIds.length - 1;
    else return;
    event.preventDefault();
    document.getElementById(sceneTabId(visibleIds[next]))?.focus();
  };

  const openMore = () => {
    setMenuIndex(0);
    setMoreOpen(true);
  };

  const chooseOverflow = (id: string) => {
    onSelect(id);
    setMoreOpen(false);
  };

  const onMoreKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!moreOpen) openMore();
      else if (event.key === 'ArrowDown') setMenuIndex(0);
    }
  };

  const onMenuKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + overflowTabs.length) % overflowTabs.length;
      setMenuIndex(next);
      event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus();
    }
  };

  const sceneLabel = (item: (typeof tabs)[number]) =>
    `${item.title}${item.stopped ? '，已停止或结束' : ''}${sceneNoticeLabel(unreadScenes.has(item.id), pending.has(item.id))}`;

  const tabButton = (item: (typeof tabs)[number], metric?: boolean) => (
    <button
      key={item.id}
      {...(metric
        ? { type: 'button' as const, tabIndex: -1, 'data-metric': 'tab', 'data-id': item.id }
        : {
            id: sceneTabId(item.id),
            type: 'button' as const,
            role: 'tab' as const,
            'aria-selected': selectedId === item.id,
            'aria-controls': 'scene-conversation',
            tabIndex: selectedId === item.id ? 0 : -1,
            title: item.title,
            'aria-label': sceneLabel(item),
            onClick: () => onSelect(item.id),
            onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => move(event, item.id),
            style: selectedId === item.id && selectedMax != null ? { maxWidth: selectedMax } : undefined,
          })}
      className="scene-tab"
    >
      <span className="scene-tab-title">{item.title}</span>
      <SceneNoticeDot unread={unreadScenes.has(item.id)} pending={pending.has(item.id)} />
    </button>
  );

  return <nav className="scene-navigation" ref={navRef} aria-label="场景导航">
    <div className="scene-tabs-cluster" ref={clusterRef}>
      <div className="scene-tab-metrics" ref={metricsRef} aria-hidden="true">
        {tabs.map(item => tabButton(item, true))}
        <button type="button" className="scene-more" data-metric="more" tabIndex={-1}>
          更多<SceneNoticeDot unread={false} pending /><ChevronDown size={14} strokeWidth={1.8} />
        </button>
      </div>
      <div className="scene-tabs" ref={tabsRef} role="tablist" aria-label="场景">
        {visibleTabs.map(item => tabButton(item))}
        <span className="scene-tab-ink" ref={inkRef} aria-hidden="true" />
      </div>
      {overflowTabs.length > 0 && <div className="scene-more-wrap" ref={moreWrapRef}>
        <button
          type="button"
          className="scene-more"
          aria-label={`更多场景${sceneNoticeLabel(overflowUnread, overflowPending)}`}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => moreOpen ? setMoreOpen(false) : openMore()}
          onKeyDown={onMoreKey}
        >
          更多
          <SceneNoticeDot unread={overflowUnread} pending={overflowPending} />
          <ChevronDown size={14} strokeWidth={1.8} />
        </button>
        {moreOpen && <div className="menu-surface scene-more-menu" role="menu">
          {overflowTabs.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-label={sceneLabel(item)}
              className="scene-more-item"
              tabIndex={index === menuIndex ? 0 : -1}
              autoFocus={index === 0}
              onClick={() => chooseOverflow(item.id)}
              onKeyDown={event => onMenuKey(event, index)}
            >
              <span className="scene-tab-title">{item.title}</span>
              <SceneNoticeDot unread={unreadScenes.has(item.id)} pending={pending.has(item.id)} />
            </button>
          ))}
        </div>}
      </div>}
      <button ref={createRef} type="button" className="scene-create" onClick={onCreate} aria-label="新建场景" title="新建场景">
        <Plus size={17} aria-hidden="true" /><span>新建场景</span>
      </button>
    </div>
  </nav>;
}
