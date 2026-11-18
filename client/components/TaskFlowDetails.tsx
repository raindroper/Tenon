import { useState, type FormEvent } from 'react';
import type { TaskRecord } from '../../shared/task-consent';
import { latestStageReviews, projectStageDecision, projectStageApproved, projectStageRejected, taskFinalFiles, type TaskDependency } from '../../shared/task-flow';
import { api, type Perform } from '../api';
import { ProjectFileResults } from './ProjectFileResults';

function TaskInput({ dependency, perform, disabled }: { dependency: TaskDependency; perform: Perform; disabled: boolean }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const answered = new Map(dependency.answers.map(answer => [answer.questionKey, answer]));
  const unresolved = dependency.questions.filter(question => !answered.has(question.key));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving || disabled) return;
    const answers = Object.fromEntries(unresolved.flatMap(question => draft[question.key]?.trim() ? [[question.key, draft[question.key].trim()]] : []));
    if (!Object.keys(answers).length) return;
    setSaving(true);
    try {
      const saved = await perform('task-input:' + dependency.id, () => api(`/api/tasks/${dependency.taskId}/inputs/${dependency.id}`, 'POST', {
        revision: dependency.revision, answers,
      }), '回答已保存，任务会从原进度继续。');
      if (saved) setDraft({});
    } finally { setSaving(false); }
  }
  return <form className="form-stack task-scope" onSubmit={event => void submit(event)}>
    <p>{dependency.summary}</p>
    {dependency.questions.map(question => {
      const answer = answered.get(question.key);
      return answer ? <div key={question.key}><p>{question.question}</p><p className="field-note">已记录{answer.actor === 'owner' ? '你的回答' : '外部回复'}：{answer.content}</p></div>
        : <fieldset key={question.key} className="form-stack"><legend>{question.question}</legend><p className="field-note">影响：{question.blocks}</p>
          {dependency.unresolved?.[question.key] && <p className="field-note">仍需确认：{dependency.unresolved[question.key]}</p>}
          {question.options && <label>建议答案<select disabled={disabled || saving}
            value={question.options.some(option => option.label === draft[question.key]) ? draft[question.key] : ''}
            onChange={event => setDraft(current => ({ ...current, [question.key]: event.target.value }))}>
            <option value="">选择建议，或在下方填写答案</option>
            {question.options.map(option => <option key={option.label} value={option.label}>{option.label} · {option.description}</option>)}
          </select></label>}
          <label>你的回答<textarea rows={2} maxLength={20000} disabled={disabled || saving} value={draft[question.key] ?? ''}
            onChange={event => setDraft(current => ({ ...current, [question.key]: event.target.value }))} /></label></fieldset>;
    })}
    {dependency.state === 'reviewing' && <p role="status" className="field-note">已收到相关回复，正在核对哪些问题已解决。</p>}
    {unresolved.length > 0 && <button type="submit" className="button" disabled={disabled || saving || !unresolved.some(question => draft[question.key]?.trim())}>
      {saving ? '正在保存' : '补充已知答案'}</button>}
  </form>;
}

function StageReview({ dependency, current, perform, disabled }: {
  dependency: TaskDependency; current: boolean; perform: Perform; disabled: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const stage = dependency.stageReview!;
  const decision = projectStageDecision(dependency);
  const pending = current && decision === 'pending';
  const labels = { pending: '待本人审核', approved: '已通过', rejected: '已退回修改', cancelled: '已取消' };
  async function decide(answer: typeof projectStageApproved | typeof projectStageRejected) {
    if (!pending || disabled || saving) return;
    setSaving(true);
    try {
      await perform('task-input:' + dependency.id, () => api(`/api/tasks/${dependency.taskId}/inputs/${dependency.id}`, 'POST', {
        revision: dependency.revision, answers: { 'stage-decision': answer },
      }), answer === projectStageApproved ? '已批准这份阶段成果，原任务将继续。' : '已退回当前阶段，修改后的成果需要重新审核。');
    } finally { setSaving(false); }
  }
  return <section className="form-stack task-scope" aria-label={`第 ${stage.index} 阶段成果审核`}>
    <p><strong>第 {stage.index}/{stage.count} 阶段 · {stage.title}</strong> · {labels[decision]}{current ? '' : ' · 历史版本'}</p>
    <p className="field-note">要求版本 {dependency.requirementsRevision} · 审核快照 {stage.fingerprint.slice(0, 12)}</p>
    <details><summary>核对本次阶段文件</summary>
      <ul>{stage.files.map(file => <li key={file.path}><p className="resource-path">{file.path} · {file.size} 字节</p>
        <p className="field-note resource-path">SHA-256 <code>{file.sha256}</code></p></li>)}</ul>
    </details>
    <ProjectFileResults taskId={dependency.operationId} stage={dependency} />
    {pending && <div className="form-actions">
      <button type="button" className="button button-primary" disabled={disabled || saving} onClick={() => void decide(projectStageApproved)}>
        {saving ? '正在保存决定…' : projectStageApproved}</button>
      <button type="button" className="button button-quiet" disabled={disabled || saving} onClick={() => void decide(projectStageRejected)}>{projectStageRejected}</button>
    </div>}
  </section>;
}

export function TaskFlowDetails({ task, perform, busy, busyKeys }: { task: TaskRecord; perform: Perform; busy: boolean; busyKeys: readonly string[] }) {
  const flow = task.flow;
  const finalFiles = taskFinalFiles(task);
  const finalFileRequirements = finalFiles?.length ? <details className="task-scope" open={task.state === 'proposed' || flow?.phase === 'awaiting_acceptance' || undefined}>
    <summary>必需最终文件</summary>
    <ul>{finalFiles.map((file, index) => <li key={index}>{file.description}{file.filename ? ` · ${file.filename}` : file.format ? ` · .${file.format}` : ''}
      {(file.count ?? 1) > 1 ? ` · 至少 ${file.count} 件` : ''}</li>)}</ul>
  </details> : null;
  if (!flow || flow.operations.length === 1 && !flow.dependencies.length && flow.phase !== 'awaiting_acceptance') return finalFileRequirements;
  const stopped = ['revoked', 'rejected', 'failed'].includes(task.state);
  const currentStageIds = new Set(flow.operations.flatMap(operation =>
    latestStageReviews(flow.dependencies, operation.id, operation.requirementsRevision).map(dependency => dependency.id)));
  const labels = { proposed: '等待你确认', running: '继续执行', waiting_approval: '等待批准具体操作', waiting_input: '等待问题的答案',
    reviewing: '核对新回复', awaiting_acceptance: '等待你验收', completed: '已完成', stopped: '已停止' };
  return <section className="task-flow" aria-label="任务进度与待确认事项">
    <p className="consent-label" role="status">{labels[flow.phase]}</p>
    {finalFileRequirements}
    {flow.operations.filter(operation => operation.id !== task.id).map(operation => <details className="task-scope" key={operation.id} open={operation.state === 'proposed' || undefined}>
      <summary>{operation.spec.title} · {{ proposed: '待批准', approved: '已批准', running: '处理中', completed: '已结束', failed: '未完成', rejected: '已拒绝', revoked: '已撤回' }[operation.state]}</summary>
      <p>{operation.spec.objective}</p>
      {operation.spec.mail && <>
        <p>收件人：{operation.spec.mail.to.join('、')}</p>
        {operation.spec.mail.cc.length > 0 && <p>抄送：{operation.spec.mail.cc.join('、')}</p>}
        {operation.spec.mail.bcc.length > 0 && <p>密送：{operation.spec.mail.bcc.join('、')}</p>}
        <p>主题：{operation.spec.mail.subject}</p><pre className="command-output">{operation.spec.mail.body}</pre>
        <p className="field-note">{operation.spec.mail.attachments.length} 个附件 · 明文发送</p>
        {operation.spec.mail.allowProtectedSourcePlaintext && <p>本次将原受保护邮件或附件中的指定内容以明文发送，请核对收件人和具体内容。</p>}
      </>}
      {operation.error && <p className="field-error">{operation.error}</p>}
      {operation.mailReceipt?.state === 'submitted' && <p className="field-note">{operation.mailReceipt.replyTracking === false
        ? '邮件服务已接受提交，但尚未取得可靠的原信标识。收到回复后可在问题卡补充答案，系统不会仅凭主题自动继续。'
        : '邮件服务已接受提交，等待对方回复。'}</p>}
      {operation.state === 'proposed' && !stopped && <div className="form-actions">
        <button className="button button-primary" disabled={busy || busyKeys.includes('task-operation:' + operation.id)} onClick={() => void perform('task-operation:' + operation.id,
          () => api(`/api/tasks/${operation.id}/approve`, 'POST', { revision: operation.revision }), '操作已批准。')}>批准{operation.spec.mail ? '发送这一封' : '这次操作'}</button>
        <button className="button button-quiet" disabled={busy || busyKeys.includes('task-operation:' + operation.id)} onClick={() => void perform('task-operation:' + operation.id,
          () => api(`/api/tasks/${operation.id}/reject`, 'POST', { revision: operation.revision }), '这次操作已拒绝。')}>先不执行</button>
      </div>}
    </details>)}
    {flow.dependencies.map(dependency => dependency.stageReview
      ? <StageReview key={dependency.id} dependency={dependency} current={currentStageIds.has(dependency.id)} perform={perform}
        disabled={stopped || busy || busyKeys.includes('task-input:' + dependency.id)} />
      : dependency.state !== 'cancelled' && <TaskInput key={dependency.id} dependency={dependency} perform={perform} disabled={stopped || busy} />)}
    {flow.phase === 'awaiting_acceptance' && <div className="task-scope">
      <p>请根据交付结果和实际检查记录验收。</p>
      {flow.acceptance.criteria.length > 0 && <ul>{flow.acceptance.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>}
      <button className="button button-primary" disabled={busy || busyKeys.includes('task-accept:' + task.id)} onClick={() => void perform('task-accept:' + task.id,
        () => api(`/api/tasks/${task.id}/accept`, 'POST', { revision: task.revision }), '已记录验收通过。')}>我已验证，通过验收</button>
    </div>}
  </section>;
}
