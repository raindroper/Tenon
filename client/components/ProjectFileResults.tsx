import { useState } from 'react';
import type { ProjectOperation } from '../../shared/local-project';
import { requiresProjectFileDelivery, type ProjectFileDelivery } from '../../shared/project-files';
import type { TaskDependency } from '../../shared/task-flow';
import { api } from '../api';

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function ProjectFileResults({ taskId, operation, stage }: { taskId: string; operation?: ProjectOperation; stage?: TaskDependency }) {
  const [saved, setSaved] = useState<ProjectFileDelivery>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(50);
  const candidate = stage ? saved : operation?.files ?? saved;
  const delivery = candidate && candidate.snapshot.taskId === taskId
    && candidate.snapshot.stageFingerprint === stage?.stageReview?.fingerprint
    && candidate.snapshot.requirementsRevision === (stage?.requirementsRevision ?? operation?.input.requirementsRevision)
    ? candidate : undefined;
  const endpoint = '/api/tasks/' + encodeURIComponent(taskId) + '/files';
  if (!delivery) {
    const finalFiles = operation && !operation.input.spec.serverResources && operation.state === 'completed'
      && requiresProjectFileDelivery(operation) && ['closed', 'active'].includes(operation.environment?.state ?? '');
    if (!stage && !finalFiles && (!operation?.environment?.retainedWorkspace || !['waiting', 'completed', 'failed'].includes(operation.state))) return null;
    return <section className="task-scope" aria-label="任务文件">
      <p>{stage ? '查看这次阶段审核对应的文件副本。' : finalFiles ? '最终成果已在执行端保存，可继续领取。' : '工作区已保存，可领取当前文件。领取过程不会重新执行任务。'}</p>
      <button className="button button-quiet" disabled={busy} onClick={() => {
        setBusy(true); setError('');
        void api<{ delivery: ProjectFileDelivery }>(endpoint, 'POST', stage ? { dependencyId: stage.id, revision: stage.revision } : {}).then(value => {
          if (value.delivery.snapshot.stageFingerprint !== stage?.stageReview?.fingerprint) throw new Error('领取结果不属于当前阶段版本，请刷新后重试。');
          setSaved(value.delivery);
        })
          .catch(cause => setError(cause instanceof Error ? cause.message : '文件领取失败，请稍后重试。')).finally(() => setBusy(false));
      }}>{busy ? '正在保存文件…' : stage ? '查看阶段文件' : '领取文件'}</button>
      {error && <p role="alert" className="field-error">{error}</p>}
    </section>;
  }
  const url = endpoint + '/content?delivery=' + encodeURIComponent(delivery.id);
  return <section className="task-scope project-file-results" aria-label="任务文件">
    <div className="form-actions">
      <strong>{delivery.files.length ? `已保存 ${delivery.files.length} 个文件` : '本次没有可领取的文件'}</strong>
      {delivery.files.length > 0 && <a className="button button-quiet" href={url} download={'task-' + taskId + '.zip'}>全部下载（ZIP）</a>}
    </div>
    {delivery.files.length > 0 && <details><summary>查看文件</summary>
      <ul className="project-file-list">{delivery.files.slice(0, visible).map(file => <li key={file.path}>
        <a href={url + '&file=' + encodeURIComponent(file.path)} download={file.path.split('/').at(-1)} title={'SHA-256: ' + file.sha256}>{file.sourcePath ?? file.path}</a>
        <span className="field-note">{size(file.size)}</span>
      </li>)}</ul>
      {visible < delivery.files.length && <button className="text-link" onClick={() => setVisible(value => value + 50)}>显示更多文件</button>}
    </details>}
    <p className="field-note">{stage ? '本批文件与阶段审核的大小和 SHA-256 一致，后续修改另存版本。' : '文件已独立保存，验收并释放运行工作区后仍可下载。'}{delivery.omittedLinks > 0 ? `未包含 ${delivery.omittedLinks} 个链接。` : ''}</p>
    {delivery.recovery && <p className="field-note">{delivery.recovery.note}</p>}
  </section>;
}
