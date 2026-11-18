import { useEffect, useId, useRef, useState } from 'react';
import type { RuntimeView } from '../../shared/runtime-view';
import { autonomyText } from '../lib/format';

const statusLabels: Record<RuntimeView['status']['state'], string> = {
  needs_setup: '等待连接模型', paused: '推理已暂停', idle: '安静待命', working: '正在处理', error: '有异常待查看',
};

const statusNotes: Record<RuntimeView['status']['state'], string> = {
  needs_setup: '还没有接好模型。打开设置后才能开始对话。',
  paused: '推理已暂停。恢复后我会继续处理。',
  idle: '这会儿没有需要你看的事。有新的确认或成果时，我会写在这里。',
  working: '我正在处理。有需要你确认的事会写在这里。',
  error: '有异常待查看。可以打开设置看看发生了什么。',
};

const alertStates = new Set<RuntimeView['status']['state']>(['needs_setup', 'error', 'paused']);

export function StatusNote({ status, timezone, onOpenSettings }: { status: RuntimeView['status']; timezone: string; onOpenSettings(): void }) {
  const { state } = status;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div ref={root} className="status-wrap">
    <button ref={trigger} type="button" className={`status-pill status-${state}${alertStates.has(state) ? ' is-alert' : ''}`}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {statusLabels[state]}
    </button>
    {open && <div id={id} className="status-note" role="note">
      <p>{statusNotes[state]}</p>
      <p>{autonomyText(status, timezone)}</p>
      <button type="button" className="status-note-link" onClick={() => { trigger.current?.focus(); setOpen(false); onOpenSettings(); }}>打开设置</button>
    </div>}
  </div>;
}
