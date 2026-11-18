import { useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { OwnerTaskRequest, TaskCapability, TaskSpec, TaskRecord } from '../../shared/task-consent';
import type { RuntimeCase } from '../../shared/runtime-view';
import { localProjectSpecSchema, serverProjectResources } from '../../shared/local-project';
import { confirmedProjectLocations, defaultProjectLocation, projectDeviceUnavailable } from '../../shared/project-placement';
import { api } from '../api';
import type { PanelContext } from './types';
import { localProjectBridge } from '../lib/local-project';
import { initialSceneChoice, NEW_SCENE, openSceneChoices, sceneCreationRequest, type SceneCreationAttempt } from '../state/ui-state';

const capabilityLabels = { artifact: '准备文本交付', workspace: '操作已授权的文件工作区', project: '在执行设备上处理项目或文件' };

export function TaskRequestPanel({ runtime, perform, busy, onClose, onPanelSubmitted, initialCaseId, initialDeviceId, draft = '', windowsTask, proposalTask }: PanelContext & {
  initialCaseId?: string | null; initialDeviceId?: string; draft?: string; windowsTask?: TaskSpec; proposalTask?: TaskRecord;
}) {
  const original = proposalTask?.spec ?? windowsTask;
  const cases = openSceneChoices(runtime.cases);
  const devices = (runtime.devices ?? []).filter(device => !windowsTask || device.platform !== 'linux');
  function projectLocation(sceneId: string, selectedDeviceId?: string) {
    return defaultProjectLocation(devices, confirmedProjectLocations(runtime.tasks, sceneId), selectedDeviceId) ?? { deviceId: '' };
  }
  const [caseId, setCaseId] = useState(() => initialSceneChoice(cases, original?.caseId ?? initialCaseId));
  const [title, setTitle] = useState(original?.title ?? '');
  const [objective, setObjective] = useState(original?.objective ?? draft.slice(0, 8000));
  const [expectedOutput, setExpectedOutput] = useState(original?.expectedOutput ?? '');
  const [capabilities, setCapabilities] = useState<TaskCapability[]>(original ? ['project'] : ['artifact']);
  // Capture the offered scope when the form opens; live history must not retarget an owner draft.
  const [location, setLocation] = useState(() => projectLocation(caseId, initialDeviceId));
  const [temporary, setTemporary] = useState(false);
  const [readOnly, setReadOnly] = useState(windowsTask?.project?.access === 'read-only');
  const [deviceRead, setDeviceRead] = useState(!windowsTask);
  const [network, setNetwork] = useState(windowsTask?.project?.network ?? true);
  const [create, setCreate] = useState(false);
  const [deviceError, setDeviceError] = useState('');
  const local = capabilities.includes('project');
  const device = devices.find(value => value.id === location.deviceId);
  const directoryValue = location.root ?? '';
  const unavailable = device && projectDeviceUnavailable(device);
  const server = local && device?.platform === 'linux';
  const temporaryWorkspace = server || temporary;
  const createdCaseId = useRef<string | null>(null);
  const creationAttempt = useRef<SceneCreationAttempt | null>(null);
  const submission = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const grant = runtime.grants.find(item => item.caseId === caseId && item.status !== 'failed' && !item.revokedAt);
  const saving = busy.includes('task-request');
  const stoppedCase = Boolean(caseId && caseId !== NEW_SCENE && !cases.some(item => item.id === caseId));
  const invalid = !caseId || stoppedCase || !title.trim() || !objective.trim() || !expectedOutput.trim() || !capabilities.length
    || capabilities.includes('workspace') && !grant || local && (!device || !temporaryWorkspace && !directoryValue.trim());
  function toggle(capability: TaskCapability, checked: boolean) {
    setCapabilities(current => checked ? capability === 'project' ? [capability] : [...current.filter(item => item !== 'project'), capability] : current.filter(item => item !== capability));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid || saving) return;
    let targetCaseId = caseId === NEW_SCENE ? createdCaseId.current : caseId;
    const accepted = await perform('task-request', async () => {
      if (capabilities.includes('workspace') && !grant) throw new Error('当前场景没有有效文件许可，请先取消文件能力。');
      const project = local && device ? localProjectSpecSchema.parse({ deviceId: device.id, root: temporaryWorkspace ? 'task-temporary' : directoryValue.trim(),
        access: readOnly ? 'read-only' : 'read-write', readAccess: !server && deviceRead ? 'device' : 'project', network, create: !temporaryWorkspace && create }) : undefined;
      if (local && !project) throw new Error('请先确认项目所在的执行设备与工作区。');
      if (proposalTask) {
        await api(`/api/tasks/${proposalTask.id}/approve`, 'POST', { revision: proposalTask.revision, project,
          ...(server ? { serverResources: serverProjectResources(network) } : {}) });
        return;
      }
      if (!targetCaseId) {
        const item = await api<RuntimeCase>('/api/cases', 'POST', sceneCreationRequest({ title: title.trim(), objective: objective.trim(), domain: 'personal' }, creationAttempt));
        targetCaseId = item.id; createdCaseId.current = item.id;
      }
      const spec = { caseId: targetCaseId, title: title.trim(), objective: objective.trim(), expectedOutput: expectedOutput.trim(), capabilities,
        ...(project ? { project } : {}),
        ...(capabilities.includes('workspace') && grant ? { workspace: { revision: grant.revision, files: [...grant.allowedFiles] } } : {}) };
      const fingerprint = JSON.stringify(spec);
      if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, requestId: crypto.randomUUID() };
      const input: OwnerTaskRequest = { requestId: submission.current.requestId, spec };
      await api('/api/tasks', 'POST', input);
    }, proposalTask ? '原任务已确认，将在所选范围执行。' : server ? '服务器任务已保存，请在对话中确认资源范围。' : '明确委托已保存。');
    if (accepted && targetCaseId) onPanelSubmitted(targetCaseId);
  }
  return <form className="form-stack task-request-form" onSubmit={event => void submit(event)}>
    <p className="field-note">{proposalTask ? '为这项任务确认具体设备和工作区，确认后开始执行。对外发送邮件仍按实际内容另行确认。' : server ? '提交后，请在对话中确认服务器资源范围。允许本次执行后才会启动任务。'
      : windowsTask ? '服务器提议已取消。请核对这次 Windows 委托的设备和工作区。'
        : '提交即委托这项任务，之后仍可撤销。也可以直接在对话中明确交代目标。'}</p>
    <fieldset disabled={saving} className="form-stack">
      <label>关联场景<select required disabled={Boolean(proposalTask)} value={caseId} onChange={event => { setCaseId(event.target.value); setLocation(projectLocation(event.target.value, initialDeviceId)); setTemporary(false); setCapabilities(current => current.filter(item => item !== 'workspace')); }}>
        <option value="" disabled>选择场景</option>
        {stoppedCase && <option value={caseId} disabled>当前场景已停止或不可用</option>}
        {cases.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        <option value={NEW_SCENE}>为这次委托新建场景</option>
      </select></label>
      <label>任务名称<input required readOnly={Boolean(proposalTask)} maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>目标与缘由<textarea required readOnly={Boolean(proposalTask)} rows={3} maxLength={8000} value={objective} onChange={event => setObjective(event.target.value)} /></label>
      <label>你希望收到什么，以及交付范围<textarea required readOnly={Boolean(proposalTask)} rows={3} maxLength={2000} value={expectedOutput} onChange={event => setExpectedOutput(event.target.value)} /></label>
      {!original && <fieldset className="form-stack"><legend>允许本任务使用的能力</legend>{(['artifact', 'workspace', 'project'] as const).map(capability => <label className="checkbox-label" key={capability}><input type="checkbox" checked={capabilities.includes(capability)} disabled={capability === 'workspace' && !grant && !capabilities.includes(capability)} onChange={event => toggle(capability, event.target.checked)} />{capabilityLabels[capability]}</label>)}</fieldset>}
      {local && <section className="task-scope form-stack">
        <p className="field-note">榫会在项目中读取和编辑代码、运行命令、调试并验证效果。请填写完整目标，过程中可以继续补充要求。</p>
        {deviceError && <p className="field-error" role="alert">{deviceError}</p>}
        <label>执行设备<select required value={device?.id ?? ''} onChange={event => { setLocation(event.target.value ? projectLocation(caseId, event.target.value) : { deviceId: '' }); setTemporary(false); }}>
          <option value="">{location.deviceId && !device ? '原设备未找到，请确认目标' : '请选择项目所在设备'}</option>
          {devices.map(value => <option key={value.id} value={value.id}>{value.platform === 'linux' ? '服务器 · ' : '客户端 · '}{value.name}{projectDeviceUnavailable(value) ? ` · ${projectDeviceUnavailable(value)}` : ''}</option>)}
        </select></label>
        {unavailable && <p role="status" className="field-note">{unavailable}。明确目标后可以先保存委托，等待该设备就绪；不会改选其他位置。</p>}
        {server && <p className="field-note">服务器使用独立临时目录，不能直接使用客户端的项目文件和开发环境。</p>}
        {!server && <label>本次工作区<select value={temporary ? 'temporary' : 'project'} onChange={event => setTemporary(event.target.value === 'temporary')}>
          <option value="project">指定项目文件夹</option><option value="temporary">独立临时任务 · 不代替已有项目</option>
        </select></label>}
        {!temporaryWorkspace && <><label>项目文件夹<input required value={directoryValue} list="project-workspaces" maxLength={4000} onChange={event => setLocation(current => ({ ...current, root: event.target.value }))} placeholder="例如 D:\project\my-app" /></label>
          <datalist id="project-workspaces">{(runtime.projectWorkspaces ?? []).filter(item => !item.temporary && item.deviceId === device?.id).map(item => <option key={item.id} value={item.root} />)}</datalist>
        </>}
        {!server && localProjectBridge()?.chooseProject && <button type="button" className="button button-quiet" onClick={() => {
          void localProjectBridge()!.chooseProject().then(value => { if (value) { setLocation(value); setTemporary(false); } })
            .catch(error => setDeviceError(error instanceof Error ? error.message : '选择文件夹失败。'));
        }}>选择本机文件夹</button>}
        <label className="checkbox-label"><input type="checkbox" checked={readOnly} onChange={event => setReadOnly(event.target.checked)} />仅允许读取项目（可在临时目录运行检查）</label>
        {!server && <label className="checkbox-label"><input type="checkbox" checked={deviceRead} onChange={event => setDeviceRead(event.target.checked)} />允许为本任务读取本机文件及依赖，修改仍限本项目</label>}
        <label className="checkbox-label"><input type="checkbox" checked={network} onChange={event => setNetwork(event.target.checked)} />{server ? '允许命令访问公网' : '允许命令联网，并启用本机项目预览'}</label>
        {!temporaryWorkspace && <label className="checkbox-label"><input type="checkbox" checked={create} onChange={event => setCreate(event.target.checked)} />这是新项目，允许创建上述文件夹</label>}
        <p className="field-note">本次工作区为{readOnly ? '只读' : '读写'}，使用{server ? '服务器独立临时目录' : temporaryWorkspace ? '客户端为本任务保存的独立工作区' : directoryValue.trim() || '所选项目文件夹'}。</p>
        {proposalTask && server && <p className="field-note">本次服务器资源上限：{serverProjectResources(network).cpuMillis / 1000} 核 CPU、{serverProjectResources(network).memoryMiB} MiB 内存、{serverProjectResources(network).diskMiB} MiB 临时空间、{serverProjectResources(network).checkpointMiB} MiB 持久检查点（含切换备份）、{serverProjectResources(network).maxProcesses} 个进程。文件保留至任务结束，等待时释放执行资源并保留继续所需的工作区。</p>}
      </section>}
      {capabilities.includes('workspace') && grant && <div className="task-scope"><p className="resource-path">{grant.repoRoot}</p><p className="field-note">交付工作区</p><p className="resource-path">{grant.worktreePath}</p><p className="field-note">文件许可版本 {grant.revision}，仅限以下文件：</p><ul className="scope-files">{grant.allowedFiles.map(file => <li key={file}>{file}</li>)}</ul></div>}
    </fieldset>
    {!runtime.settings.enabled && !server && <p className="field-note">推理已暂停，委托会先保存，恢复后才开始执行。</p>}
    <div className="form-actions"><button type="button" className="button button-quiet" disabled={saving} onClick={onClose}>先不委托</button><button type="submit" className="button button-primary" disabled={saving || Boolean(invalid)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{proposalTask ? '确认范围并开始任务' : server ? '保存并查看资源确认' : '明确委托并授权'}</button></div>
  </form>;
}
