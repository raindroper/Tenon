import { useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { RuntimeFeedback } from '../../shared/runtime-view';
import type { FeedbackTarget } from '../state/ui-state';
import { api } from '../api';
import type { PanelContext } from './types';

export function FeedbackPanel({ target, perform, busy, onClose }: PanelContext & { target: FeedbackTarget }) {
  const [verdict, setVerdict] = useState<RuntimeFeedback['verdict']>('useful');
  const [comment, setComment] = useState('');
  const saving = busy.includes('feedback');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await perform('feedback', () => api('/api/feedback', 'POST', { targetType: target.type, targetId: target.id,
      targetVersion: target.version, verdict, comment: comment.trim() }), '反馈已保存。')) onClose();
  }
  return <form className="form-stack" onSubmit={event => void submit(event)}>
    <blockquote className="feedback-quote">{target.label.slice(0, 1000)}{target.label.length > 1000 ? '…' : ''}</blockquote>
    <fieldset disabled={saving} className="feedback-options"><legend>这次怎么样？</legend>{([{ id: 'useful', label: '有帮助' }, { id: 'off_target', label: '理解偏了' }, { id: 'not_now', label: '暂时不用' }] as const).map(option => <label className="checkbox-label" key={option.id}><input type="radio" name="feedback" value={option.id} checked={verdict === option.id} onChange={() => setVerdict(option.id)} />{option.label}</label>)}</fieldset>
    <label>再说一点（可选）<textarea rows={4} maxLength={3000} value={comment} onChange={event => setComment(event.target.value)} placeholder="更希望怎样理解，或下次怎么做？" /></label>
    <div className="form-actions"><button type="button" className="button button-quiet" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={saving}>{saving && <LoaderCircle size={15} className="spin" />}保存反馈</button></div>
  </form>;
}
