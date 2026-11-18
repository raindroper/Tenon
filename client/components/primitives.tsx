import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import tenonMark from '../assets/tenon-mark.svg';

export { Markdown } from './Markdown';

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

/** The browser owns focus trapping, background inertness and Escape semantics. */
export function Dialog({ title, children, onClose, returnFocus }: { title: string; children: ReactNode; onClose: () => void; returnFocus?: RefObject<HTMLElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scroll = document.body.style.overflow;
    node.showModal(); document.body.style.overflow = 'hidden';
    return () => {
      node.close(); document.body.style.overflow = scroll;
      const target = returnFocus?.current ?? previous;
      if (target?.isConnected) target.focus();
    };
  }, []);
  return <dialog ref={dialog} className="detail-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="dialog-header"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭面板"><X size={20} /></button></header>
    <div className="dialog-body">{children}</div>
  </dialog>;
}

export { tenonMark };
