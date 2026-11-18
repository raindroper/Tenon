import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { RuntimeRun } from '../../shared/runtime-view';
import type { RuntimeConnectionHealth } from '../api';
import { dateTime } from '../lib/format';
import { progressForRun, progressOperationStatus, queuedProgressText } from '../lib/run-progress';

function useProgressClock(running: boolean, suppliedNow?: number) {
  const [now, setNow] = useState(() => suppliedNow ?? Date.now());
  useEffect(() => {
    if (!running || suppliedNow !== undefined) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, suppliedNow]);
  return suppliedNow ?? now;
}

export function RunProgress({ run, timezone, connection, expanded, onExpandedChange, now: suppliedNow, afterReply = false }: {
  run: RuntimeRun; timezone: string; connection?: RuntimeConnectionHealth;
  expanded?: boolean; onExpandedChange?(open: boolean): void; now?: number; afterReply?: boolean;
}) {
  const now = useProgressClock(run.status === 'running' && Boolean(run.progress), suppliedNow);
  const [internalExpanded, setInternalExpanded] = useState(false);
  const [visible, setVisible] = useState(6);
  const display = progressForRun(run, connection, now);
  if (!display) return null;
  const headlineRole = run.status === 'interrupted' && run.stopReason === 'owner_stopped' ? 'status' : undefined;
  if (!display.hasDetails) return <p className="run-progress-legacy" role={headlineRole}><span className="run-progress-dot" aria-hidden="true" />{display.headline}</p>;
  const remaining = Math.max(0, display.operations.length - visible);
  const receipt = afterReply && run.status === 'completed';
  return <details className="run-progress" data-state={display.reconnecting ? 'reconnecting' : run.status}
    open={(expanded ?? internalExpanded) || undefined}
    onToggle={event => { const open = event.currentTarget.open; setInternalExpanded(open); onExpandedChange?.(open); }}>
    <summary>
      <ChevronDown className="run-progress-chevron" size={13} aria-hidden="true" />
      <span className="run-progress-dot" aria-hidden="true" />
      <span className="run-progress-headline" role={headlineRole}>{receipt ? `查看 ${display.operations.length} 项操作` : display.headline}</span>
      {!receipt && display.elapsed && <span className="run-progress-elapsed" aria-hidden="true">{display.running ? '已用时' : '用时'} {display.elapsed}</span>}
    </summary>
    <div className="run-progress-body">
      <p className="run-progress-meta">{receipt && `${display.headline} · `}开始于 <time dateTime={run.startedAt}>{dateTime(run.startedAt, timezone, true)}</time>{receipt && display.elapsed && ` · 用时 ${display.elapsed}`}</p>
      {display.reconnecting ? <p className="run-progress-note">正在重新连接，下面是上次收到的记录。{display.lastState && `上次状态：${display.lastState}。`}</p>
        : display.waitingLonger && <p className="run-progress-note">已超过一分钟没有新的操作进度，正在等待响应。</p>}
      {remaining > 0 && <button type="button" className="text-link run-progress-more" onClick={() => setVisible(value => value + 12)}>
        显示更早的 {Math.min(12, remaining)} 项操作 · 还有 {remaining} 项
      </button>}
      {display.operations.length ? <ol className="run-progress-operations" aria-label="实际操作过程">
        {display.operations.slice(-visible).map(operation => <li key={operation.id} data-status={operation.status}>
          <span className="run-progress-operation-dot" aria-hidden="true" />
          <div className="run-progress-operation-content"><div className="run-progress-operation-heading">
            <span>{operation.label}</span><span className="run-progress-operation-status">{progressOperationStatus[operation.status]}</span>
            {operation.duration && <span className="run-progress-operation-time">{operation.duration}</span>}
          </div>{operation.summary && <p>{operation.summary}</p>}</div>
        </li>)}
      </ol> : <p className="run-progress-note">这轮没有工具操作记录。</p>}
    </div>
  </details>;
}

export function QueuedRunProgress({ enabled, connection }: { enabled: boolean; connection?: RuntimeConnectionHealth }) {
  return <p className="run-progress-queued"><span className="run-progress-dot" aria-hidden="true" />{queuedProgressText(enabled, connection)}</p>;
}
