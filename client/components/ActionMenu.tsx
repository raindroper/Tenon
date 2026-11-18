import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

type MenuAction = { label: string; icon?: ReactNode; quiet?: boolean; separatorBefore?: boolean } & (
  { onSelect(): void; href?: never; download?: never } | { href: string; download?: string; onSelect?: never }
);

/** Header and composer share the same keyboard, outside-click and focus behavior. */
export function ActionMenu({ label, icon, actions, above = false, className = '', triggerClassName = 'icon-button', text }: {
  label: string; icon?: ReactNode; actions: MenuAction[]; above?: boolean; className?: string; triggerClassName?: string; text?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null); const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const close = () => { trigger.current?.focus(); setOpen(false); };
  return <div ref={root} className={`action-menu ${className}`} data-above={above || undefined}>
    <button ref={trigger} type="button" className={`${triggerClassName}${open ? ' open' : ''}`} aria-label={label} aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>{text ?? icon}</button>
    {open && <nav id={id} className="menu-surface" aria-label={label}>{actions.map(action => {
      const item = action.href !== undefined
        ? <a href={action.href} download={action.download} key={action.label} className={action.quiet ? 'menu-quiet' : undefined} onClick={close}>{action.icon}{action.label}</a>
        : <button type="button" key={action.label} className={action.quiet ? 'menu-quiet' : undefined} onClick={() => { close(); action.onSelect(); }}>{action.icon}{action.label}</button>;
      return action.separatorBefore ? <span key={action.label + '-group'} className="menu-group"><span className="menu-sep" aria-hidden="true" />{item}</span> : item;
    })}</nav>}
  </div>;
}
