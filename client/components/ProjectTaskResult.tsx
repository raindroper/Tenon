import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TaskRecord } from '../../shared/task-consent';
import { isLocalPreviewUrl, type ProjectOperation } from '../../shared/local-project';
import type { RuntimeView } from '../../shared/runtime-view';
import { api, type Perform, type RuntimeConnectionHealth } from '../api';
import { Markdown } from './primitives';
import { localProjectBridge, projectProgressText } from '../lib/local-project';
import { ProjectFileResults } from './ProjectFileResults';

const toolLabels = { running: '运行中', succeeded: '已结束', failed: '失败', interrupted: '已中断' };
type ProjectReceipt = ProjectOperation & { receivedModelText?: string };

/** Refreshes only when durable device facts change; no timer or model polling. */
export function ProjectTaskResult({ task, runtime, perform, connection, expanded, onExpandedChange, server = false }: {
  task: TaskRecord; runtime: RuntimeView; perform: Perform; connection?: RuntimeConnectionHealth;
  expanded: boolean; onExpandedChange(open: boolean): void; server?: boolean;
}) {
  const [operation, setOperation] = useState<ProjectReceipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const channel = useRef<{ taskId: string; controller: AbortController; version: number; pending: boolean } | null>(null);
  const progress = runtime.projectOperations?.find(value => value.taskId === task.id);
  useEffect(() => {
    if (channel.current?.taskId !== task.id || channel.current.controller.signal.aborted) {
      channel.current?.controller.abort(); channel.current = { taskId: task.id, controller: new AbortController(), version: 0, pending: false };
    }
    const current = channel.current; current.version++;
    if (current.pending) return;
    current.pending = true;
    void (async () => {
      let received = -1;
      while (!current.controller.signal.aborted && received !== current.version) {
        const version = current.version;
        const value = await api<{ operation: ProjectReceipt | null }>('/api/tasks/' + encodeURIComponent(task.id) + '/project', 'GET', undefined, current.controller.signal);
        if (!current.controller.signal.aborted) { setOperation(value.operation); setError(''); }
        received = version;
        if (received !== current.version) await new Promise(resolve => setTimeout(resolve, 250));
      }
    })().catch(cause => { if (!current.controller.signal.aborted) setError(cause instanceof Error ? cause.message : '项目进度暂未读取成功。'); })
      .finally(() => { current.pending = false; });
  }, [task.id, task.revision, progress?.sequence, progress?.updatedAt, refresh]);
  useEffect(() => () => channel.current?.controller.abort(), []);
  const project = task.spec.project;
  if (!project) return null;
  const device = runtime.devices?.find(value => value.id === project.deviceId);
  const bridge = server ? undefined : localProjectBridge();
  const scope = !server && <>
    <p className="resource-path">{project.root === 'task-temporary' ? operation?.workspace?.realPath ?? '客户端管理的任务临时工作区' : project.root}</p>
    {operation?.workspace && bridge?.openProjectFolder && <button type="button" className="text-link" onClick={() =>
      void perform('project-folder:' + task.id, () => bridge.openProjectFolder(project.deviceId, operation.input.operationId))}>打开本机工作区</button>}
    <p className="field-note">{device?.name ?? '项目电脑'} · {project.access === 'read-write' ? '项目内读写' : '项目只读'} · {project.network ? '允许联网' : '禁止外部联网'}</p>
    <p className="field-note">读取范围：{project.readAccess === 'device' ? '本机文件与依赖（仅用于本任务）' : '所选项目与系统执行文件'}</p>
  </>;
  const process = operation?.output || operation?.receivedModelText;
  const headline = projectProgressText(operation, process, connection, server);
  return <section className="project-task-result" aria-label="项目工作区与执行结果">
    {operation?.delivery?.version === 2 && operation.delivery.requirementsRevision === operation.input.requirementsRevision
      && Boolean(operation.delivery.missing?.length) && <div className="task-scope" role="status">
        <p>已保存当前工作，仍需补齐以下成果。</p>
        <ul>{operation.delivery.missing!.map(value => <li key={value}>{value}</li>)}</ul>
      </div>}
    {server && operation && <ProjectFileResults key={task.id + ':' + operation.input.requirementsRevision + ':' + (operation.checkpoint?.hash ?? '')}
      taskId={task.id} operation={operation} />}
    {task.state === 'proposed' ? <div className="task-scope">{scope}</div> :
      <details className="run-progress project-progress" data-state={operation?.state} open={expanded || undefined}
        onToggle={event => { if (event.target === event.currentTarget) onExpandedChange(event.currentTarget.open); }}>
        <summary>
          <ChevronDown className="run-progress-chevron" size={13} aria-hidden="true" />
          <span className="run-progress-dot" aria-hidden="true" />
          <span className="run-progress-headline" title={headline}>{headline}</span>
        </summary>
        {expanded && <div className="run-progress-body task-scope project-progress-body">
          {scope}
          {operation?.activity && <p className="field-note">最近进展 {new Date(operation.activity.at).toLocaleTimeString()}</p>}
          {operation?.delivery && <details className="project-fold">
            <summary>{operation.delivery.version === 2 ? '成果与实际检查' : '执行方案与成果检查'}</summary>
            <div className="project-fold-body">
            <p className="field-note">要求版本 {operation.delivery.requirementsRevision}{operation.delivery.requirementsRevision !== operation.input.requirementsRevision ? ' · 当前要求已更新，待重新核对' : ''}</p>
            <p>{operation.delivery.plan.method}</p>
            {operation.delivery.plan.alternativeReason && <p>替代原因 · {operation.delivery.plan.alternativeReason}</p>}
            <ul>{operation.delivery.plan.basis.map((source, index) => <li key={index}>{source.reference} · {source.detail}</li>)}</ul>
            {operation.delivery.verification ? <>
              <ul>{operation.delivery.verification.files.map(file => <li key={file.path}>{file.path} · {file.size} 字节</li>)}</ul>
              <ul>{operation.delivery.verification.checks.map(check => {
                const evidence = operation.delivery!.evidence?.find(value => value.id === check.id);
                const criterion = operation.delivery!.plan.checks.find(value => value.id === check.id)?.criterion ?? check.id;
                return <li key={check.id}>
                  <p>{{ passed: '通过', warning: '告警', failed: '未通过', unverified: '未验证' }[check.status]} · {criterion}</p>
                  <p>{check.detail} · {check.validator}</p>
                  {evidence?.command && <details><summary>实际检查命令</summary>
                    <pre className="command-output">{JSON.stringify(evidence.command.argv)}</pre>
                  </details>}
                </li>;
              })}</ul>
            </> : <p>成果检查尚未记录。</p>}
            </div>
          </details>}
          {operation && operation.tools.length > 0 && <details className="project-fold">
            <summary>实际操作 · {operation.toolCounts?.total ?? operation.tools.length} 项</summary>
            <div className="project-fold-body">
            {operation.toolCounts && operation.toolCounts.total > operation.tools.length && <p className="field-note">下列为最近 {operation.tools.length} 项，完整回执保存在任务记录中。</p>}
            <ol className="project-tools">{operation.tools.map(tool => <li key={tool.id}><details>
              <summary>{toolLabels[tool.state]} · {tool.label}</summary>
              {tool.command && <pre className="command-output">{tool.command}</pre>}
              {tool.output && <pre className="command-output">{tool.output}</pre>}
              {tool.exitCode !== undefined && <p className="field-note">退出码 {tool.exitCode}</p>}
            </details></li>)}</ol>
            </div>
          </details>}
          {process && <details className="project-fold"><summary>执行过程</summary><div className="project-fold-body"><Markdown>{process}</Markdown></div></details>}
          {operation?.receivedModelText && operation.receivedModelText !== process && <details className="project-fold"><summary>模型已返回的正文</summary><div className="project-fold-body"><Markdown>{operation.receivedModelText}</Markdown></div></details>}
          {operation?.diff && <details className="project-fold"><summary>文件改动</summary><div className="project-fold-body"><pre className="command-output project-diff">{operation.diff}</pre></div></details>}
          {operation?.finalOutput && operation.finalOutput !== process && <details className="project-fold"><summary>查看最终结果</summary><div className="project-fold-body"><Markdown>{operation.finalOutput}</Markdown></div></details>}
        </div>}
      </details>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {operation?.error && <p className="field-error">{operation.error}</p>}
    {operation && operation.interactions.length > 0 && <details className="task-scope project-fold"><summary>历史执行询问</summary>
      <div className="project-fold-body">{operation.interactions.map(interaction => <div key={interaction.id}><p>{interaction.title}</p><pre className="command-output">{interaction.detail}</pre></div>)}</div>
    </details>}
    {!server && operation?.previews.filter(preview => isLocalPreviewUrl(preview.url)).map(preview => <div key={preview.url} className="project-preview">
      <code>{preview.url}</code>
      {operation.environment?.state === 'active' || operation.state === 'running' ? bridge?.openProjectPreview
        ? <button type="button" className="text-link" onClick={() => void perform('preview:' + task.id, () => bridge.openProjectPreview(project.deviceId, preview.url))}>打开项目预览</button>
        : <a className="text-link" href={preview.url} target="_blank" rel="noreferrer">在项目所在电脑打开预览</a>
        : <span className="field-note">预览环境已停止，地址保留供回查。</span>}
    </div>)}
    {(operation?.environment?.state === 'active' || operation?.environment?.retainedWorkspace) && <div className="form-actions">
      <span className="field-note">{operation.environment?.retainedWorkspace ? '保留了继续任务所需的工作区检查点。' : `保留 ${operation.environment?.terminals.length ?? 0} 个项目进程以供预览`}</span>
      <button className="button button-quiet" disabled={busy} onClick={() => {
        setBusy(true);
        void perform('project-stop:' + task.id, () => api('/api/tasks/' + encodeURIComponent(task.id) + '/project-stop', 'POST', {}))
          .finally(() => { setBusy(false); setRefresh(current => current + 1); });
      }}>{operation.environment?.retainedWorkspace ? '释放工作区并停止任务' : '停止项目环境'}</button>
    </div>}
    {operation?.environment?.state === 'unknown' && <p className="field-error">{server ? '服务器' : '本机'}进程退出状态尚未确认。</p>}
  </section>;
}
