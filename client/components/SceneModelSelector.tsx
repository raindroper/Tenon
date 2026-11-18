import { useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, Settings2, X } from 'lucide-react';
import type { ModelDirectory, ModelPreference, ModelSelection } from '../../shared/model-connections';
import { api, type Perform } from '../api';
import { effectiveSelection, selectionAvailability, selectionIssue, selectionLabel } from '../lib/model-selection';
import { ModelSelectionPicker } from './ModelSelectionPicker';

export function SceneModelSelector({ directory, caseId, perform, busy, disabled, onManage }: {
  directory?: ModelDirectory; caseId: string; perform: Perform; busy: readonly string[]; disabled?: boolean; onManage(): void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ explicit: boolean; selection: ModelSelection | null; revision: number }>();
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const scene = directory?.scenes.find(item => item.caseId === caseId);
  const preference: ModelPreference = scene?.preference ?? { mode: 'inherit-global' };
  const selection = directory ? effectiveSelection(preference, directory.defaults.global) : null;
  const unavailable = directory ? selectionAvailability(selection, directory.connections) : null;
  const source = preference.mode === 'explicit' ? '场景配置' : '跟随全局';
  const saving = busy.includes(`model-scene:${caseId}`);
  function close() { if (saving) return; setOpen(false); setError(''); trigger.current?.focus(); }
  function toggle() {
    if (open) { close(); return; }
    if (!directory) { onManage(); return; }
    setDraft({ explicit: preference.mode === 'explicit', selection: selection ? { ...selection } : null, revision: scene?.revision ?? 0 });
    setError(''); setOpen(true);
  }
  async function save() {
    if (!directory || !draft || saving) return;
    if (draft.explicit) {
      const issue = selectionIssue(draft.selection, directory.connections);
      if (issue) { setError(issue); return; }
    }
    const preference: ModelPreference = draft.explicit ? { mode: 'explicit', selection: draft.selection! } : { mode: 'inherit-global' };
    setError('');
    const accepted = await perform(`model-scene:${caseId}`, async () => {
      try { await api(`/api/models/scenes/${encodeURIComponent(caseId)}`, 'PATCH', { preference, expectedRevision: draft.revision }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '模型配置未保存，请重试。'); throw cause; }
    }, '当前场景的模型配置已保存。');
    if (accepted) { setOpen(false); trigger.current?.focus(); }
  }
  return <div className="scene-model-selector">
    <button ref={trigger} type="button" className={`scene-model-trigger${unavailable ? ' is-unavailable' : ''}`} disabled={disabled || saving}
      aria-expanded={open} aria-label="选择当前场景的模型和思考强度" onClick={toggle}>
      <Settings2 size={13} aria-hidden="true" />
      <span>{directory ? `${source} · ${selectionLabel(selection, directory.connections)}` : '配置模型连接'}</span>
      {saving ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
    </button>
    {unavailable && !open && <span className="scene-model-status" role="status">{unavailable} · 选择与历史已保留</span>}
    {open && draft && directory && <div className="scene-model-editor form-stack" role="region" aria-label="当前场景的模型配置"
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <div className="model-section-heading"><h3>当前场景的模型</h3><button type="button" className="icon-button" aria-label="关闭模型选择" disabled={saving} onClick={close}><X size={16} /></button></div>
      <fieldset disabled={disabled || saving} className="form-stack">
        <label className="checkbox-label"><input type="checkbox" checked={!draft.explicit}
          onChange={event => setDraft(current => current && { ...current, explicit: !event.target.checked })} />跟随全局默认</label>
        {draft.explicit ? <ModelSelectionPicker connections={directory.connections} value={draft.selection}
          onChange={value => setDraft(current => current && { ...current, selection: value })} />
          : <p className="field-note">{selectionLabel(directory.defaults.global, directory.connections)}。以后全局默认变化时，这个场景会一起跟随。</p>}
        <p className="field-note">保存后用于当前场景的新回合；已开始的回合和任务保持原配置。</p>
        {error && <p className="field-error" role="alert">{error}</p>}
      </fieldset>
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={disabled || saving} onClick={() => void save()}>{saving && <LoaderCircle size={14} className="spin" />}保存场景配置</button>
        <button type="button" className="text-link" disabled={saving} onClick={() => { close(); onManage(); }}>管理模型连接</button>
      </div>
    </div>}
  </div>;
}
