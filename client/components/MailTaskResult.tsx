import { useEffect, useState } from 'react';
import type { TaskRecord } from '../../shared/task-consent';
import type { MailTaskReceipt } from '../../shared/mail';
import { api } from '../api';
import { dateTime } from '../lib/format';

interface PublicOperation { id: string; taskId: string; state: MailTaskReceipt['state']; updatedAt: string; error?: string }
const receiptLabels: Record<MailTaskReceipt['state'], string> = {
  prepared: '草稿已准备，尚未提交发送', submitting: '正在向 Exchange 提交邮件', submitted: 'Exchange 已接受发送',
  failed: '邮件未能提交', unknown: '发送结果待核对',
};

export function MailTaskResult({ task, timezone }: { task: TaskRecord; timezone: string }) {
  const [loaded, setLoaded] = useState<MailTaskReceipt>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setError('');
    if (task.mailReceipt) { setLoaded(undefined); return () => controller.abort(); }
    void api<{ operation: PublicOperation | null }>(`/api/tasks/${encodeURIComponent(task.id)}/mail-operation`, 'GET', undefined, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        if (value.operation && value.operation.taskId !== task.id) throw new Error('邮件回执与当前任务不符。');
        setLoaded(value.operation ? { operationId: value.operation.id, state: value.operation.state, updatedAt: value.operation.updatedAt,
          ...(value.operation.error ? { error: value.operation.error } : {}) } : undefined);
      }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '真实发送回执暂时无法读取。'); });
    return () => controller.abort();
  }, [task.id, task.state, task.updatedAt, task.mailReceipt?.updatedAt]);
  const receipt = task.mailReceipt ?? loaded;
  const mail = task.spec.mail;
  if (!mail) return null;
  return <section className="task-scope form-stack" aria-label="邮件发送范围和回执">
    <dl className="connector-details"><dt>To</dt><dd>{mail.to.join('；') || '无'}</dd>
      <dt>Cc</dt><dd>{mail.cc.join('；') || '无'}</dd><dt>Bcc</dt><dd>{mail.bcc.join('；') || '无'}</dd>
      <dt>主题</dt><dd>{mail.subject}</dd><dt>附件</dt><dd>{mail.attachments.length} 个已固定的文件</dd>
      <dt>保护方式</dt><dd>明文邮件{mail.allowProtectedSourcePlaintext ? ' · 本人已明确允许分享受保护原信内容' : ''}</dd></dl>
    <details><summary>查看已授权正文</summary><div className="markdown" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{mail.body ?? '由本任务按明确要求准备正文。'}</div></details>
    {receipt ? <>
      <p className={`inline-result${receipt.state === 'submitted' ? ' success' : receipt.state === 'failed' || receipt.state === 'unknown' ? ' failure' : ''}`} role="status">
        {receiptLabels[receipt.state]} · {dateTime(receipt.updatedAt, timezone, true)}</p>
      {receipt.error && <p className="field-error">{receipt.error}</p>}
      {receipt.state === 'unknown' && <p className="field-note">目前无法确认服务器是否已接受这封邮件。此任务不会自动重发，请先核对已发送邮件或实际结果。</p>}
      {receipt.state === 'submitted' && <p className="field-note">此回执确认 Exchange 接受了提交，不代表所有收件人已实际送达或阅读。</p>}
    </> : <p className="field-note" role="status">任务已登记，尚未取得真实发送回执。</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
