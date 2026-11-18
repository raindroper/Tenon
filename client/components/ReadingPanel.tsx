import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, Check, Columns3, Copy, FileText, Maximize2, Minimize2, X } from 'lucide-react';
import type { ReadingContent } from '../lib/reading-content';
import { Markdown } from './Markdown';

interface ReadingPanelProps {
  content: ReadingContent | null;
  onClose(): void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}

/** A nonmodal reading surface on roomy screens; native modal focus handling on smaller ones. */
export function ReadingPanel({ content, onClose, returnFocus }: ReadingPanelProps) {
  const [retained, setRetained] = useState(content);
  const [phase, setPhase] = useState<'opening' | 'open' | 'closing'>('opening');
  const [expanded, setExpanded] = useState(false);
  const [overlay, setOverlay] = useState(() => typeof window !== 'undefined' && !window.matchMedia('(min-width: 2440px)').matches);
  const modal = overlay || expanded;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const shown = content ?? retained;
  const shownId = shown?.id;
  const copyRequest = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 2440px)');
    const update = () => setOverlay(!media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let firstFrame = 0; let secondFrame = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    if (content) {
      setRetained(content); setPhase(reduced ? 'open' : 'opening');
      if (!reduced) firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => setPhase('open')); });
    } else if (retained) {
      setPhase('closing');
      const close = () => {
        const node = dialog.current;
        const active = document.activeElement;
        const restore = node?.contains(active) || active === document.body;
        node?.close();
        setRetained(null); setExpanded(false);
        if (restore && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
      };
      if (reduced) close(); else timer = setTimeout(close, 220);
    }
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); clearTimeout(timer); };
    // Retained content exists solely to finish the exit transition, not as a second content owner.
  }, [content, returnFocus]);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node || !shownId) return;
    if (modal) node.showModal(); else node.show();
    node.focus({ preventScroll: true });
    return () => { if (node.open) node.close(); };
  }, [Boolean(shownId), modal]);

  useEffect(() => {
    copyRequest.current++; clearTimeout(copiedTimer.current); setCopied(false); setCopyError('');
  }, [shownId]);
  useEffect(() => () => { copyRequest.current++; clearTimeout(copiedTimer.current); }, []);

  async function copy() {
    if (!shown) return;
    const request = ++copyRequest.current;
    try {
      await navigator.clipboard.writeText(shown.content);
      if (request !== copyRequest.current) return;
      setCopied(true); setCopyError(''); clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      if (request === copyRequest.current) setCopyError('未能复制，可以在阅读区选择文字后复制。');
    }
  }

  if (!shown) return null;
  return <div className="reading-panel-shell" data-state={phase} data-expanded={expanded || undefined}>
    <dialog ref={dialog} className="reading-panel" aria-labelledby={titleId} aria-modal={modal || undefined} tabIndex={-1}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}
      onClick={event => {
        if (event.target !== event.currentTarget || !modal) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <header className="reading-panel-header">
        <div className="reading-panel-identity">
          <strong id={titleId}>{shown.kind === 'table' ? <Columns3 size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}<span>{shown.kind === 'sources' ? '本轮来源记录' : shown.kind === 'table' ? '表格阅读' : '文档阅读'}</span>{shown.kind !== 'sources' && <span className="sr-only">：{shown.title}</span>}</strong>
          <p className="reading-panel-meta">{shown.kind === 'sources' ? '来自本轮读取的事件回执' : '来自当前回复'}</p>
        </div>
        <div className="reading-panel-tools">
          <button type="button" className="icon-button" onClick={() => setExpanded(value => !value)} aria-label={expanded ? '恢复阅读面板大小' : '放大阅读面板'} aria-pressed={expanded}>
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭阅读面板"><X size={20} /></button>
        </div>
      </header>
      <div className="reading-panel-body" key={shown.id}>{shown.kind === 'sources'
        ? <p className="source-receipts">{shown.content}</p> : <Markdown>{shown.content}</Markdown>}</div>
      {copyError && <p className="field-error" role="alert">{copyError}</p>}
      <footer className="reading-panel-footer">
        <button type="button" className="text-link" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制内容'}</button>
        <button type="button" className="text-link" onClick={onClose}><ArrowLeft size={15} />回到对话</button>
      </footer>
    </dialog>
  </div>;
}
