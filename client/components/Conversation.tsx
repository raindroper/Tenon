import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';
import { ArrowUp, BookOpen, Check, ChevronDown, Clock3, FileText, ImagePlus, LoaderCircle, Paperclip, Pause, Plus, Reply, Settings2, Square, ThumbsUp, Video, X } from 'lucide-react';
import type { RuntimeMessage, RuntimeView } from '../../shared/runtime-view';
import { meetingReminderSchema } from '../../shared/reminders';
import { sceneTheme } from '../../shared/scene-theme';
import type { TaskRecord } from '../../shared/task-consent';
import { api, stopReply, type Perform, type RuntimeConnectionHealth } from '../api';
import { DEFAULT_SCENE_ID, deriveConversation, sceneName, taskConversationDate, type Panel } from '../state/ui-state';
import { dateTime } from '../lib/format';
import { Dialog, Markdown } from './primitives';
import { ActionMenu } from './ActionMenu';
import { DraftImages, MessageImages, PendingMessageImages } from './ChatImages';
import { DraftFiles, MessageFiles } from './ChatFiles';
import { imageUpload, type DraftImage } from '../lib/chat-images';
import { fileUpload, type DraftFile } from '../lib/chat-files';
import { createAttachmentDrafts } from '../state/attachment-drafts';
import { failedReplies, messageOutputText, replyStoppedText } from '../lib/run-state';
import { effectiveSelection, reasoningLabel, selectionAvailability } from '../lib/model-selection';
import { SceneModelSelector } from './SceneModelSelector';
import { MediaResult } from './MediaResult';
import { MailTaskResult } from './MailTaskResult';
import { GitHubTaskResult } from './GitHubTaskResult';
import { ProjectTaskResult } from './ProjectTaskResult';
import { TaskFlowDetails } from './TaskFlowDetails';
import { capabilityText } from '../lib/media';
import { commandAccessText } from '../lib/local-command';
import { createMessageSubmissions, messagesAwaitingProjection } from '../state/message-submissions';
import { useConversationHistory } from '../state/useConversationHistory';
import { assistantProgressRun, ownerProgressRuns, pendingOwnerEvent, progressReply, taskProgressRuns } from '../lib/run-progress';
import { QueuedRunProgress, RunProgress } from './RunProgress';
import { ReadingPanel } from './ReadingPanel';
import { MeetingReminder } from './MeetingReminder';
import type { ReadingContent } from '../lib/reading-content';

interface ConversationProps {
  runtime: RuntimeView; caseId: string | null; reply: RuntimeMessage | null; busy: string[]; perform: Perform;
  connection?: RuntimeConnectionHealth;
  onBrowse(caseId: string | null): void;
  onOpenPanel(panel: Panel): void; onReply(message: RuntimeMessage): void;
  onCancelReply(): void; onSent(replyId?: string): void;
}
type PendingAttachments = { images: readonly DraftImage[]; files: readonly DraftFile[] };
type ThreadEntry = { type: 'message'; id: string; createdAt: string; message: RuntimeMessage; pending?: PendingAttachments }
  | { type: 'task'; id: string; createdAt: string; task: TaskRecord };

function replySummary(message: RuntimeMessage | undefined, limit = 100): string | undefined {
  return (message?.content || message?.files?.[0]?.name || (message?.attachments?.length ? '图片消息' : undefined))?.slice(0, limit);
}

function TaskConsent({ task, runtime, conversationCaseId, busy, busyKeys, perform, onOpenPanel, onMediaLoad, connection, progressOpen, onProgressToggle }: {
  task: TaskRecord; runtime: RuntimeView; conversationCaseId: string | null; busy: boolean; busyKeys: readonly string[]; perform: Perform; onOpenPanel(panel: Panel): void; onMediaLoad(): void;
  connection?: RuntimeConnectionHealth; progressOpen: Readonly<Record<string, boolean>>; onProgressToggle(id: string, open: boolean): void;
}) {
  const { spec } = task;
  const requirementsRevision = task.requirementsRevision ?? 1;
  const updates = task.requirementUpdates ?? [];
  const evidenceCount = task.evidenceRefs?.length ?? 0;
  const grant = spec.workspace && runtime.grants.find(item => item.caseId === spec.caseId && item.revision === spec.workspace!.revision);
  const artifact = runtime.artifacts.find(item => item.taskId === task.id && (item.requirementsRevision ?? 1) === requirementsRevision);
  const media = runtime.mediaJobs?.find(item => item.taskId === task.id && item.caseId === spec.caseId);
  const latestRun = runtime.runs.reduce<RuntimeView['runs'][number] | undefined>((latest, run) =>
    run.taskId === task.id && (run.taskExecution?.requirementsRevision ?? 1) === requirementsRevision
      && (!latest || run.startedAt > latest.startedAt) ? run : latest, undefined);
  const progressRuns = taskProgressRuns(runtime.runs, task).filter(run => run.progress || run.status === 'running');
  const projectDeviceId = spec.project?.deviceId;
  const projectDevice = runtime.devices?.find(device => device.id === projectDeviceId);
  const serverResources = spec.project?.serverResources;
  const serverProject = Boolean(serverResources || projectDevice?.platform === 'linux');
  const retiredCommandProposal = task.state === 'proposed' && spec.command && !('kind' in spec.command);
  const proposed = task.state === 'proposed' && !retiredCommandProposal; const active = task.state === 'approved' || task.state === 'running';
  const label = retiredCommandProposal ? '旧版命令提案 · 已停用' : { proposed: serverProject ? '待确认服务器资源' : '待确认', approved: '已允许 · 等待执行', running: '正在执行', completed: spec.mail ? '邮件发送流程已结束' : '本次执行结束 · 成果待验收',
    rejected: '这次先不用', revoked: '执行许可已撤回', failed: '本次执行未完成' }[task.state];
  const act = (action: 'approve' | 'reject' | 'revoke') => perform(`task:${task.id}`,
    () => api(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, 'POST', { revision: task.revision,
      ...(action === 'approve' && serverResources ? { serverResources } : {}) }),
    action === 'approve' ? '已允许这项任务。' : action === 'reject' ? '已取消这项提议。' : '已撤回这项任务的执行许可。');
  async function switchToWindows() {
    if (await act('reject')) onOpenPanel({ type: 'taskRequest', windowsTask: spec });
  }
  const outputText = updates.length > 0 ? `原始交付要求：${spec.expectedOutput}` : spec.expectedOutput;
  const objectiveText = spec.objective?.trim() || '';
  const expectedRaw = spec.expectedOutput?.trim() || '';
  const sameObjectiveOutput = Boolean(objectiveText && expectedRaw && objectiveText === expectedRaw);
  const readFacts: string[] = [];
  if (evidenceCount > 0) {
    const titles = new Set((task.evidenceRefs ?? []).flatMap(ref => {
      const source = runtime.sources.find(item => item.id === ref.sourceId && item.caseId === ref.sourceCaseId);
      return source?.title ? [source.title] : [];
    }));
    readFacts.push(`来源资料 ${evidenceCount} 条 · 按原授权范围读取${titles.size ? `（${[...titles].join('、')}）` : ''}`);
  }
  if (spec.workspace?.files.length) readFacts.push(spec.workspace.files.join('、'));
  const showFacts = Boolean(objectiveText || expectedRaw || readFacts.length);
  const card = <section className={`consent consent-${task.state}${proposed ? ' consent-enter' : ''}`} aria-label={`${label}：${spec.title}`}>
    <div className="consent-heading"><span className="consent-label">{proposed && <Clock3 size={14} aria-hidden="true" />}{label}</span><h2>{spec.title}</h2></div>
    {conversationCaseId !== spec.caseId && <p className="field-note">任务归属：{sceneName(spec.caseId, runtime.cases.find(item => item.id === spec.caseId)?.title)}</p>}
    {proposed && showFacts ? <dl className="consent-facts">
      {expectedRaw ? <><dt>交付</dt><dd>{outputText}</dd></> : null}
      {objectiveText && !sameObjectiveOutput && objectiveText !== spec.title && <><dt>目标</dt><dd>{objectiveText}</dd></>}
      {readFacts.length > 0 ? <><dt>读取范围</dt><dd>{readFacts.join(' · ')}</dd></> : null}
    </dl> : <>
      {evidenceCount > 0 && <p className="field-note">来源资料 {evidenceCount} 条 · 按原授权范围读取</p>}
      <p>{outputText}</p>
    </>}
    {active && <p className="field-note" role="status">{spec.mail ? (!runtime.settings.enabled
      ? '榫当前已暂停，发送委托已保存，恢复运行后才会执行。' : '按已授权的邮件范围处理，请以下方真实发送回执为准。') : latestRun?.status === 'running'
      ? '后台执行，可继续交流。' : !runtime.settings.enabled ? '推理已暂停，任务和已有结果已保留。' : '任务已登记，可继续交流。'}{!spec.mail && '补充要求可以直接在对话中说明。'}</p>}
    {!spec.project && progressRuns.length > 0 && <div className="task-run-progress">{progressRuns.map(run => <RunProgress key={run.id} run={run}
      timezone={runtime.settings.timezone} connection={connection} expanded={progressOpen[run.id] ?? false}
      onExpandedChange={open => onProgressToggle(run.id, open)} />)}</div>}
    {updates.length > 0 && <details className="task-scope" open={active || undefined}>
      <summary>你的补充要求 · {updates.length} 条 <ChevronDown size={14} /></summary>
      <ol>{updates.map(update => <li key={update.sourceEventId}>
        <p className="field-note"><time dateTime={update.createdAt}>{dateTime(update.createdAt, runtime.settings.timezone, true)}</time> · 第 {update.revision} 版要求</p>
        <Markdown>{update.content}</Markdown>
      </li>)}</ol>
    </details>}
    {retiredCommandProposal && <p>历史范围保留。文件和文件夹查询请重新提出，榫将使用原生查询能力。</p>}
    {(proposed || active || spec.command) && <details className="task-scope" open={proposed && Boolean(spec.command || serverProject) || undefined}><summary>查看目标与授权范围 <ChevronDown size={14} /></summary>
      {!proposed && objectiveText && !sameObjectiveOutput && <p>{objectiveText}</p>}<p>允许能力：{spec.capabilities.map(capability => capability === 'project' && serverProject ? '处理服务器临时工作区' : capabilityText[capability]).join('、')}</p>
      {spec.acceptance && <><p>{spec.acceptance.mode === 'owner' ? '交付后由你验证并确认完成。' : '按约定交付结果与验证记录。'}</p>
        <ul>{spec.acceptance.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></>}
      {spec.media && <><p>生成模型：{spec.media.model}</p><p className="media-prompt">描述：{spec.media.prompt}</p>
        {spec.media.referenceImageIds?.length ? <p>使用已选择的 {spec.media.referenceImageIds.length} 张参考图。</p> : null}
        {spec.media.size && <p>尺寸：{spec.media.size}</p>}{spec.media.seconds && <p>时长：{spec.media.seconds} 秒</p>}
        {spec.media.resolution && <p>分辨率：{spec.media.resolution}</p>}{spec.media.aspectRatio && <p>画面比例：{spec.media.aspectRatio}</p>}</>}
      {spec.workspace && <><p>文件许可版本 {spec.workspace.revision}</p><ul className="scope-files">{spec.workspace.files.map(file => <li key={file}>{file}</li>)}</ul>
        {grant ? <><p>原仓库：{grant.repoRoot}</p><p>交付工作区：{grant.worktreePath}</p></> : <p>原文件许可已变化，请先核对许可；本次批准不会授予新文件权限。</p>}</>}
      {spec.command && <><p>执行设备：{runtime.devices?.find(device => device.id === spec.command?.deviceId)?.name ?? spec.command.deviceId}</p>
        <p className="resource-path">本次范围：{commandAccessText(spec.command)}</p>
        {'kind' in spec.command ? <><p>查询{spec.command.entryType === 'directory' ? '直接子文件夹' : '文件'}{spec.command.extension ? ` · .${spec.command.extension}` : ''}{spec.command.nameContains ? ` · 名称包含「${spec.command.nameContains}」` : ''} · 最多 {spec.command.limit} 项</p>
          <p>{spec.directoryAnalysis ? '允许榫根据查询返回的列表继续分析。' : spec.command.entryType === 'directory' ? '返回文件夹完整路径，不进入子目录或读取文件内容。' : '返回文件列表。'}</p></>
          : <><p className="resource-path">程序：{spec.command.executable}</p><pre className="command-output">{JSON.stringify(spec.command.args, null, 2)}</pre></>}
        <p>最长执行 {spec.command.timeoutMs / 1000} 秒</p></>}
    </details>}
    {proposed && serverResources && <p>允许后，本次任务会占用下列服务器资源。</p>}
    {spec.project?.desktop && <p>Windows 应用：{spec.project.desktop.applications.map(app => app === 'notepad' ? '记事本' : 'Clash Verge').join('、')} · 后台操作{spec.project.returnScreenshots ? ' · 回传截图' : ''}</p>}
    {spec.project && serverResources && <dl className="server-task-resources" aria-label="本次服务器执行范围与资源上限">
      <div><dt>执行位置</dt><dd>{projectDevice?.name ?? spec.project.deviceId}</dd></div>
      <div><dt>文件范围</dt><dd>任务独立临时目录 · {spec.project.access === 'read-write' ? '读写' : '项目只读'}</dd></div>
      <div><dt>联网范围</dt><dd>{serverResources.network === 'public' ? '允许访问公网' : '关闭命令联网'}</dd></div>
      <div><dt>CPU 上限</dt><dd>{serverResources.cpuMillis / 1000} 核</dd></div>
      <div><dt>内存上限</dt><dd>{serverResources.memoryMiB} MiB</dd></div>
      <div><dt>临时空间上限</dt><dd>{serverResources.diskMiB} MiB</dd></div>
      {serverResources.workspaceStorage === 'persistent' && <div><dt>持久检查点上限</dt><dd>{serverResources.checkpointMiB} MiB，含保存切换时的备份；保留至任务结束</dd></div>}
      <div><dt>进程上限</dt><dd>{serverResources.maxProcesses}</dd></div>
      <div><dt>保留期限</dt><dd>临时目录保留至任务结束，执行结果和回执保存在对话中。</dd></div>
    </dl>}
    {proposed && serverProject && (!serverResources || !projectDevice?.online) && <p className="field-error" role="status">
      {serverResources ? '服务器执行设备目前离线。上线后可以确认本次任务。' : '这张卡未包含服务器资源范围，请重新发起任务。'}
    </p>}
    {task.error && <p className="field-error">{task.error}</p>}
    <TaskFlowDetails task={task} perform={perform} busy={busy} busyKeys={busyKeys} />
    {spec.mail && <MailTaskResult task={task} timezone={runtime.settings.timezone} />}
    {spec.github && <GitHubTaskResult task={task} timezone={runtime.settings.timezone} />}
    {spec.project && (!serverProject || task.approvalRevision !== undefined) && <ProjectTaskResult task={task} runtime={runtime} perform={perform} server={serverProject}
      connection={connection} expanded={progressOpen[`project:${task.id}`] ?? false} onExpandedChange={open => onProgressToggle(`project:${task.id}`, open)} />}
    <div className="consent-actions">
      {proposed && <>
        <button className="button button-quiet" disabled={busy} onClick={() => void act('reject')}>{serverProject ? '取消' : '这次先不用'}</button>
        {serverProject && <button className="button" disabled={busy} onClick={() => void switchToWindows()}>取消并改用 Windows</button>}
        <button className="button button-primary" disabled={busy || serverProject && (!serverResources || !projectDevice?.online)} onClick={() =>
          spec.projectSelection ? onOpenPanel({ type: 'taskRequest', proposalTask: task }) : void act('approve')}>
          {busy && <LoaderCircle size={14} className="spin" />}{spec.projectSelection ? '选择工作区并确认' : serverProject ? '允许本次服务器执行' : '允许这项任务'}
        </button>
      </>}
      {active && !media && <button className="text-link" disabled={busy} onClick={() => void act('revoke')}><Pause size={14} />撤回许可</button>}
      {artifact && <button className="text-link" onClick={() => onOpenPanel({ type: 'artifact', id: artifact.id })}><FileText size={14} />查看交付内容</button>}
      {spec.command && <button className="text-link" onClick={() => onOpenPanel({ type: 'devices' })}>查看设备与实际执行回执</button>}
    </div>
    {media && <MediaResult job={media} busy={busyKeys} perform={perform} onLoad={onMediaLoad} />}
    {proposed && !runtime.settings.enabled && <p className="field-note">推理已暂停，允许后先保存，恢复推理后再执行。</p>}
  </section>;
  const verifiedArtifact = task.state === 'completed' && artifact?.status === 'verified';
  if (task.state === 'rejected' || task.state === 'revoked' || verifiedArtifact) return <details className="past-task">
    <summary><span>{verifiedArtifact ? '已验证成果' : label}</span>{spec.title}<ChevronDown size={14} aria-hidden="true" /></summary>{card}
  </details>;
  return card;
}

export function Conversation({ runtime, caseId, reply, busy, perform, onBrowse, onOpenPanel, onReply, onCancelReply, onSent, connection }: ConversationProps) {
  const draftKey = caseId ?? DEFAULT_SCENE_ID;
  const context = useMemo(() => deriveConversation(runtime, caseId), [runtime, caseId]);
  const history = useConversationHistory(draftKey, runtime, context.messages, onBrowse);
  const { messages: projectedMessages, runs, events } = history.view;
  const [pendingMessage, setPendingMessage] = useState<{ message: RuntimeMessage } & PendingAttachments>();
  const [receipts, setReceipts] = useState<RuntimeMessage[]>([]);
  const { conversation, messages: liveMessages } = runtime;
  const awaitingProjection = useMemo(() => receipts.length ? messagesAwaitingProjection(receipts, { conversation, messages: liveMessages }) : receipts,
    [receipts, conversation, liveMessages]);
  useEffect(() => {
    if (awaitingProjection.length !== receipts.length) setReceipts(current => messagesAwaitingProjection(current, { conversation, messages: liveMessages }));
  }, [awaitingProjection, receipts.length, conversation, liveMessages]);
  const messages = useMemo(() => {
    const current = history.browsing ? [] : awaitingProjection.filter(message => message.caseId === draftKey);
    return current.length ? [...projectedMessages, ...current] : projectedMessages;
  }, [awaitingProjection, draftKey, history.browsing, projectedMessages]);
  const visiblePending = !history.browsing && pendingMessage?.message.caseId === draftKey
    && !context.messages.some(message => message.requestId && message.requestId === pendingMessage.message.requestId) ? pendingMessage : undefined;
  const readingScope = draftKey;
  const [reading, setReading] = useState<{ scope: string; content: ReadingContent } | null>(null);
  const readingOpener = useRef<HTMLButtonElement>(null);
  const selectedReading = reading?.scope === readingScope ? reading.content : null;
  useEffect(() => { setReading(current => current && current.scope !== readingScope ? null : current); }, [readingScope]);
  const newest = !history.browsing;
  const currentContext = useRef(draftKey); currentContext.current = draftKey;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submissions] = useState(() => createMessageSubmissions());
  const [localDeviceId, setLocalDeviceId] = useState<string>();
  const [deviceChoices, setDeviceChoices] = useState<Record<string, string>>({});
  const devices = runtime.devices ?? [];
  const deviceId = deviceChoices[draftKey];
  const target = devices.find(device => device.id === deviceId);
  const [optionsScene, setOptionsScene] = useState<string | null>(null);
  const directory = runtime.modelConnections;
  const preference = directory?.scenes.find(scene => scene.caseId === draftKey)?.preference ?? { mode: 'inherit-global' };
  const modelIssue = directory && selectionAvailability(effectiveSelection(preference, directory.defaults.global), directory.connections);
  useEffect(() => {
    const bridge = (window as Window & { raeLocalDevice?: {
      currentId(): Promise<string | undefined>;
      onId(listener: (id: string | undefined) => void): () => void;
    } }).raeLocalDevice;
    if (!bridge) return;
    let active = true;
    let changed = false;
    const unsubscribe = bridge.onId(id => { changed = true; if (active) setLocalDeviceId(id); });
    void bridge.currentId().then(id => { if (active && !changed) setLocalDeviceId(id); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  const [attachmentDrafts] = useState(() => createAttachmentDrafts());
  useSyncExternalStore(attachmentDrafts.subscribe, attachmentDrafts.getSnapshot, attachmentDrafts.getSnapshot);
  useEffect(() => attachmentDrafts.activate(), [attachmentDrafts]);
  const attachments = attachmentDrafts.get(draftKey);
  const [dragging, setDragging] = useState(false);
  const text = drafts[draftKey] ?? '';
  const input = useRef<HTMLTextAreaElement>(null); const scroll = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nearBottom = useRef(true); const inputId = useId();
  const openReading = useCallback((content: ReadingContent, opener: HTMLButtonElement) => {
    readingOpener.current = opener; nearBottom.current = false;
    setReading({ scope: readingScope, content });
  }, [readingScope]);
  const closeReading = useCallback(() => setReading(null), []);
  const [progressOpen, setProgressOpen] = useState<Record<string, boolean>>({});
  const onProgressToggle = (id: string, open: boolean) => {
    setProgressOpen(previous => previous[id] === open ? previous : { ...previous, [id]: open });
    if (open) nearBottom.current = false;
  };
  const previousScrollTop = useRef(0);
  const shownScene = useRef<string>(null);
  const scrollAnchor = useRef<{ row: Element; offset: number }>(null);
  const sending = busy.includes('message');
  const stopped = context.item?.status === 'cancelled' || context.item?.status === 'completed';
  const sendDisabled = (!text.trim() && !attachments.images.length && !attachments.files.length) || attachments.pendingImages > 0
    || sending || stopped || busy.includes(`model-scene:${draftKey}`);
  const activeReply = runtime.runs.find(run => run.caseId === draftKey && run.status === 'running'
    && run.trigger === 'chat' && run.mode === 'growth' && run.eventId && !run.taskId);
  const stopKey = activeReply ? `stop-reply:${activeReply.id}` : '';
  const stoppingReply = activeReply?.stopReason === 'owner_stopped' || busy.includes(stopKey);
  const stopLabel = stoppingReply ? '正在停止回复' : '停止回复';
  const mainConversation = !caseId || context.caseId === DEFAULT_SCENE_ID;
  const progressView = useMemo(() => ({ messages, events, runs }), [messages, events, runs]);
  const replyFailures = useMemo(() => failedReplies(events, messages), [events, messages]);
  const runsById = useMemo(() => new Map(runs.map(run => [run.id, run])), [runs]);
  const lastReplyByRun = useMemo(() => new Map(messages.flatMap(message =>
    message.role === 'assistant' && message.runId ? [[message.runId, message.id] as const] : [])), [messages]);
  const ownerRuns = useMemo(() => new Map(messages.filter(message => message.role === 'user')
    .map(message => [message.id, ownerProgressRuns(progressView, message)])), [messages, progressView]);
  const replyProgress = useMemo(() => new Map(messages.flatMap(message => {
    const run = assistantProgressRun(progressView, message);
    return run && (run.progress || run.status === 'running') ? [[message.id, run] as const] : [];
  })), [messages, progressView]);
  const messagesById = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages]);
  const entries = useMemo<ThreadEntry[]>(() => {
    const firstVisibleDate = history.nextBefore ? messages[0]?.createdAt : undefined;
    const tasks = (history.ready ? context.tasks : []).map(task => ({ type: 'task' as const, id: task.id,
      createdAt: taskConversationDate(task, context.caseId), task })).filter(({ task, createdAt }) => {
      return !firstVisibleDate || createdAt >= firstVisibleDate || ['proposed', 'approved', 'running'].includes(task.state);
    });
    const rows: ThreadEntry[] = [
      ...messages.map(message => ({ type: 'message' as const, id: message.id, createdAt: message.createdAt, message })),
      ...tasks,
    ];
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (visiblePending) {
      const { message } = visiblePending;
      rows.push({ type: 'message', id: message.id, createdAt: message.createdAt, message, pending: visiblePending });
    }
    return rows;
  }, [context.caseId, context.tasks, messages, visiblePending, history.ready, history.nextBefore]);
  const lastEntry = entries.at(-1)?.id;
  const lastMessage = messages.at(-1);
  const mediaVersion = useMemo(() => runtime.mediaJobs?.filter(job => job.caseId === context.caseId)
    .map(job => `${job.id}:${job.updatedAt}:${job.state}:${job.files.length}`).join('|'), [runtime.mediaJobs, context.caseId]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || !history.ready) return;
    const anchor = scrollAnchor.current;
    scrollAnchor.current = null;
    if (shownScene.current !== draftKey) {
      shownScene.current = draftKey;
      nearBottom.current = true;
    }
    if (anchor && element.contains(anchor.row)) {
      element.scrollTop += anchor.row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
    } else if (newest && nearBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
    previousScrollTop.current = element.scrollTop;
  }, [draftKey, history.ready, history.nextBefore, newest, lastEntry, lastMessage?.content, lastMessage?.outputState, lastMessage?.outputNote, mediaVersion, runtime.status.state]);
  useEffect(() => { if (reply) input.current?.focus(); }, [reply?.id]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    const height = element.scrollHeight;
    element.style.height = `${Math.min(height + 2, 160)}px`;
    element.style.overflowY = height > 160 ? 'auto' : 'hidden';
  }, [text]);
  async function send(event: FormEvent) {
    event.preventDefault(); const content = text.trim();
    if (sendDisabled) return;
    const replyId = reply?.id;
    const replyPreview = replySummary(reply ?? undefined);
    const submitted = { images: attachments.images, files: attachments.files };
    let localId: string | undefined;
    let receipt: RuntimeMessage | undefined;
    const accepted = await perform('message', async () => {
      const fields = deviceId ? { deviceId } : {};
      localId = crypto.randomUUID();
      const message: RuntimeMessage = { id: localId, role: 'user', content, createdAt: new Date().toISOString(),
        caseId: draftKey, replyTo: replyId, replyPreview, ...fields };
      setPendingMessage({ message, ...submitted });
      goLatest();
      const [imageUploads, fileUploads] = await Promise.all([
        Promise.all(submitted.images.map(imageUpload)), Promise.all(submitted.files.map(fileUpload)),
      ]);
      const submission = submissions.prepare(draftKey, { content, ...fields,
        ...(imageUploads.length ? { attachments: imageUploads } : {}), ...(fileUploads.length ? { files: fileUploads } : {}),
        ...(caseId ? { caseId } : {}), ...(replyId ? { replyTo: replyId } : {}) });
      setPendingMessage({ message: { ...message, requestId: submission.requestId }, ...submitted });
      receipt = { ...await api<RuntimeMessage>('/api/messages', 'POST', submission), requestId: submission.requestId, replyPreview };
    }, undefined, { refreshInBackground: true });
    if (localId) setPendingMessage(current => current?.message.id === localId ? undefined : current);
    if (accepted && receipt) {
      const confirmed = receipt;
      if (confirmed.requestId) submissions.accepted(draftKey, confirmed.requestId);
      setReceipts(previous => [...previous, confirmed]);
      setDrafts(previous => previous[draftKey]?.trim() === content ? { ...previous, [draftKey]: '' } : previous);
      attachmentDrafts.remove(draftKey, [...submitted.images, ...submitted.files].map(item => item.id));
      onSent(replyId);
      if (currentContext.current === draftKey) input.current?.focus();
    }
  }
  const zone = runtime.settings.timezone;
  const keepBottom = () => { if (history.ready && newest && nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; };
  const canGoOlder = !history.loading && Boolean(history.nextBefore);
  const loadOlder = () => {
    if (!canGoOlder) return;
    nearBottom.current = false;
    void history.loadOlder(() => {
      const element = scroll.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top;
      const row = Array.from(element.querySelectorAll('.thread-item')).find(item => item.getBoundingClientRect().bottom > top);
      if (row) scrollAnchor.current = { row, offset: row.getBoundingClientRect().top - top };
    });
  };
  function goLatest() {
    scrollAnchor.current = null;
    nearBottom.current = true;
    closeReading();
    history.latest();
    keepBottom();
  }
  const showPagination = Boolean(history.nextBefore || history.browsing);
  return <main className="conversation" aria-label="与榫的对话"
    style={{ '--scene-ink': sceneTheme(draftKey, context.item?.themeId).accent } as CSSProperties}>
    <div className="conversation-heading">
      <h1 className="sr-only">{!mainConversation && context.item ? context.item.title : runtime.settings.agentName}</h1>
      {context.caseId && (!mainConversation || stopped) && <button className="text-link context-info" onClick={() => onOpenPanel({ type: 'caseDetail', caseId: context.caseId! })}>场景详情</button>}
      {showPagination && <nav className="conversation-pages" aria-label="对话历史">
        <button type="button" className="text-link" aria-disabled={!canGoOlder} onClick={loadOlder}>更早消息</button>
        <button type="button" className="text-link" aria-disabled={!history.browsing} onClick={() => { if (history.browsing) goLatest(); }}>回到最新</button>
        <span className="conversation-history-status" role="status">{history.loading ? '正在读取…' : history.failed ? '读取更早消息失败' : ''}</span>
      </nav>}
    </div>
    <div className="conversation-scroll" ref={scroll} aria-busy={!history.ready || history.loading} onScroll={event => {
      const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
      const reachedTop = previousScrollTop.current > 1 && scrollTop <= 1 && scrollHeight > clientHeight;
      previousScrollTop.current = scrollTop;
      nearBottom.current = newest && scrollHeight - scrollTop - clientHeight < 100;
      if (reachedTop && !history.failed) loadOlder();
    }}>
      <div key={draftKey}>
      {!history.ready && <p className="thinking" role="status"><LoaderCircle size={14} className="spin" />正在读取消息…</p>}
      {!entries.length ? history.ready && <section className="conversation-empty">
        <p>这个场景还没有消息</p>
        {!runtime.settings.apiKeyConfigured && <button className="text-link" onClick={() => onOpenPanel({ type: 'settings' })}>连接模型</button>}
      </section> : <div className="thread">{entries.map((entry, index) => {
        const previous = entries[index - 1];
        const failure = entry.type === 'message' ? replyFailures.get(entry.message.id) : undefined;
        const ownerReplyRuns = entry.type === 'message' && entry.message.role === 'user' ? ownerRuns.get(entry.message.id) ?? [] : [];
        const latestOwnerReply = ownerReplyRuns.at(-1);
        const replyDraining = latestOwnerReply?.status === 'running' && latestOwnerReply.stopReason === 'owner_stopped';
        const stopStatusShown = latestOwnerReply?.stopReason === 'owner_stopped' && failure?.lastError === replyStoppedText;
        const output = entry.type === 'message' ? messageOutputText(entry.message, entry.message.runId ? runsById.get(entry.message.runId) : undefined) : '';
        const reminder = entry.type === 'message' && entry.message.role === 'assistant' && entry.message.outputState !== 'streaming' && entry.message.reminder
          ? meetingReminderSchema.safeParse(entry.message.reminder) : undefined;
        const sourceRun = entry.type === 'message' && entry.message.runId && lastReplyByRun.get(entry.message.runId) === entry.id
          ? runsById.get(entry.message.runId) : undefined;
        const responseProgress = sourceRun ? replyProgress.get(entry.id) : undefined;
        const evidenceIds = sourceRun?.caseId === draftKey ? sourceRun.evidenceEventIds : undefined;
        const outputShownByProgress = responseProgress && entry.type === 'message' && (entry.message.outputState === 'streaming'
          || responseProgress.status === 'interrupted' && responseProgress.stopReason === 'owner_stopped' && output === replyStoppedText);
        const awaitingRuns = ownerReplyRuns.filter(run => (run.progress || run.status === 'running' || run.stopReason === 'owner_stopped')
          && !progressReply(progressView, run));
        const queued = entry.type === 'message' && entry.message.role === 'user' ? pendingOwnerEvent(progressView, entry.message) : undefined;
        return <div key={`${entry.type}:${entry.id}`} data-entry={entry.type === 'message' ? entry.message.role : 'task'}>
          {entry.type === 'task' ? <article className="thread-item thread-assistant">
            <div className="message-content"><TaskConsent task={entry.task} runtime={runtime} conversationCaseId={context.caseId} busy={busy.includes(`task:${entry.task.id}`)} busyKeys={busy} perform={perform} onOpenPanel={onOpenPanel} onMediaLoad={keepBottom}
              connection={connection} progressOpen={progressOpen} onProgressToggle={onProgressToggle} /></div>
          </article> : <article className={`thread-item thread-${entry.message.role}`} data-message-id={entry.id}
            aria-label={entry.message.role === 'user' ? '你的消息' : entry.message.role === 'assistant' ? '助手回复' : '系统消息'}>
            <div className="message-content" data-streaming={entry.message.role === 'assistant' && entry.message.outputState === 'streaming' || undefined}>
              {entry.message.replyTo && !(entry.message.role === 'assistant' && previous?.type === 'message'
                && (previous.id === entry.message.replyTo || previous.message.role === 'assistant' && previous.message.replyTo === entry.message.replyTo))
                && <div className="quoted-message"><Reply size={13} /><span>{replySummary(messagesById.get(entry.message.replyTo)) || entry.message.replyPreview || '回复较早的消息'}</span></div>}
              {entry.pending ? <PendingMessageImages images={entry.pending.images} onLoad={keepBottom} />
                : <MessageImages images={entry.message.attachments} onLoad={keepBottom} />}
              <MessageFiles files={entry.message.files} pending={entry.pending?.files} />
              {reminder?.success ? <MeetingReminder reminder={reminder.data} timezone={zone} original={entry.message.content} />
                : entry.message.content && <Markdown reading={entry.message.role === 'assistant' && entry.message.outputState !== 'streaming'
                ? { messageId: entry.message.id, activeId: selectedReading?.id, onOpen: openReading } : undefined}>{entry.message.content}</Markdown>}
              {output && !outputShownByProgress && <p className="message-output-note" role="status">{output}</p>}
              {evidenceIds && evidenceIds.length > 0 && <button type="button" className="text-link evidence-link"
                aria-expanded={selectedReading?.id === `${entry.id}:sources`}
                onClick={event => {
                  const records = evidenceIds.map(id => {
                    const sourceEvent = runtime.events.find(item => item.id === id) ?? events.find(item => item.id === id);
                    if (!sourceEvent) return `事件 ${id}（本页未载入来源摘要）`;
                    const source = runtime.sources.find(item => item.id === sourceEvent.sourceId && item.caseId === sourceEvent.caseId);
                    return `${source?.title || sourceEvent.sourceId}\n${dateTime(sourceEvent.occurredAt, zone, true)} · ${sourceEvent.kind}\n事件 ${id}`;
                  });
                  openReading({ id: `${entry.id}:sources`, kind: 'sources', title: '本轮来源记录', description: '', content: records.join('\n\n') }, event.currentTarget);
                }}><BookOpen size={15} />查看 {evidenceIds.length} 条来源记录</button>}
              {responseProgress && (responseProgress.status !== 'completed' || Boolean(responseProgress.progress?.operations.length)) &&
                <RunProgress afterReply key={responseProgress.id} run={responseProgress} timezone={zone} connection={connection}
                  expanded={progressOpen[responseProgress.id] ?? false} onExpandedChange={open => onProgressToggle(responseProgress.id, open)} />}
              {entry.message.role === 'user' && (entry.message.reasoningEffort || entry.message.deviceId) && <div className="message-context">
                {entry.message.reasoningEffort && <span>思考：{reasoningLabel(entry.message.reasoningEffort)}</span>}
                {entry.message.deviceId && <span>{devices.find(device => device.id === entry.message.deviceId)?.name ?? '已指定设备'}</span>}
              </div>}
              {entry.pending && <p className="message-output-note" role="status">发送中…</p>}
              {failure && !replyDraining && <div className="message-failure" role="status">
                {!stopStatusShown && <p>{failure.lastError || '这条消息尚未得到答复。'}</p>}
                <button className="text-link" disabled={stopped || busy.includes(`retry:${failure.id}`)} onClick={() => void perform(`retry:${failure.id}`,
                  () => api(`/api/events/${encodeURIComponent(failure.id)}/retry`, 'POST', {}),
                  runtime.settings.enabled ? '已重新排队处理这条消息。' : '已重新排队，恢复推理后处理。')
                  .then(accepted => { if (accepted && currentContext.current === draftKey && !newest) goLatest(); })}>
                  {busy.includes(`retry:${failure.id}`) ? <><LoaderCircle size={13} className="spin" />正在提交…</> : '重试这条'}
                </button>
                {stopped && <span>恢复这个场景后可重试。</span>}
              </div>}
              {!entry.pending && entry.message.role !== 'system' && <div className="message-tools">
                <button type="button" className="icon-button" aria-label="回复这条消息" title="引用回复" onClick={() => onReply(entry.message)}><Reply size={15} /></button>
                {entry.message.role === 'assistant' && entry.message.feedbackVersion && <button type="button" className="icon-button" aria-label="评价这条回应" title="评价这条回应" onClick={() => onOpenPanel({ type: 'feedback',
                  target: { type: 'message', id: entry.message.id, label: entry.message.content, version: entry.message.feedbackVersion! } })}><ThumbsUp size={14} /></button>}
              </div>}
            </div>
          </article>}
          {(awaitingRuns.length > 0 || queued) && <article className="thread-item thread-assistant run-progress-entry">
            <div className="message-content">
              {awaitingRuns.map(run => <RunProgress key={run.id} run={run} timezone={zone} connection={connection}
                expanded={progressOpen[run.id] ?? false} onExpandedChange={open => onProgressToggle(run.id, open)} />)}
              {queued && <QueuedRunProgress enabled={runtime.settings.enabled} connection={connection} />}
            </div>
          </article>}
        </div>;
      })}</div>}
      </div>
    </div>
    <div className={`composer-area${dragging ? ' is-dragging' : ''}`}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (!stopped) setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!stopped) void attachmentDrafts.add(draftKey, Array.from(event.dataTransfer.files)); }}>
      {stopped && <p className="composer-note">这个场景已停止，历史仍可阅读。可以从场景详情恢复。</p>}
      {reply && <div className="reply-preview"><Reply size={15} /><span>{replySummary(reply, 140) || '回复这条消息'}</span><button className="icon-button" aria-label="取消引用回复" onClick={onCancelReply}><X size={15} /></button></div>}
      <DraftImages images={attachments.images} onRemove={id => attachmentDrafts.remove(draftKey, [id])} />
      <DraftFiles files={attachments.files} onRemove={id => attachmentDrafts.remove(draftKey, [id])} />
      {attachments.error && <p className="field-error composer-attachment-note" role="alert">{attachments.error}</p>}
      {(attachments.pendingImages > 0 || dragging) && <p className="composer-note" role="status">{attachments.pendingImages ? '正在处理附件…' : '松开添加附件'}</p>}
      {(deviceId || modelIssue) && <button className="composer-selection text-link" type="button" onClick={() => setOptionsScene(draftKey)}>
        <Settings2 size={14} />{[deviceId && (target?.name ?? '所选设备暂不可用'), modelIssue].filter(Boolean).join(' · ')}
      </button>}
      {optionsScene === draftKey && <Dialog title="对话选项" onClose={() => setOptionsScene(null)}>
        <div className="composer-options form-stack">
        {(devices.length > 0 || deviceId) && <label>执行设备
        <select aria-label="这段对话的执行设备" value={deviceId ?? ''} disabled={stopped || sending}
          onChange={event => { const selected = event.target.value; setDeviceChoices(previous => ({ ...previous, [draftKey]: selected })); }}>
          <option value="">由榫判断或在消息中指定</option>
          {deviceId && !target && <option value={deviceId}>所选设备暂不可用</option>}
          {devices.map(device => <option key={device.id} value={device.id}>{device.platform === 'linux' ? '' : device.id === localDeviceId ? '本机 · ' : 'Windows · '}{device.name}{device.online ? '' : ' · 离线'}</option>)}
        </select>
      </label>}
      <SceneModelSelector key={draftKey} directory={runtime.modelConnections} caseId={draftKey} perform={perform} busy={busy}
        disabled={stopped || sending} onManage={() => { setOptionsScene(null); onOpenPanel({ type: 'settings' }); }} />
        </div>
      </Dialog>}
      <form className="composer" onSubmit={event => void send(event)}>
        <input ref={fileInput} type="file" className="sr-only" multiple disabled={stopped} tabIndex={-1} aria-label="选择聊天附件"
          onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void attachmentDrafts.add(draftKey, files); }} />
        <ActionMenu label="添加资料或明确委托" className="composer-actions" above icon={<Plus size={25} strokeWidth={1.5} />} actions={[
          { label: '添加文件', icon: <Paperclip size={16} />, onSelect: () => { if (!stopped) fileInput.current?.click(); } },
          { label: '生成图片', icon: <ImagePlus size={16} />, onSelect: () => onOpenPanel({ type: 'taskRequest', mediaKind: 'image', draft: text }) },
          { label: '生成视频', icon: <Video size={16} />, onSelect: () => onOpenPanel({ type: 'taskRequest', mediaKind: 'video', draft: text }) },
          { label: '添加资料', icon: <Plus size={16} />, onSelect: () => onOpenPanel({ type: 'addSource' }) },
          { label: '明确委托', icon: <Check size={16} />, onSelect: () => onOpenPanel({ type: 'taskRequest', draft: text, deviceId }) },
          { label: '对话选项', icon: <Settings2 size={16} />, separatorBefore: true, onSelect: () => setOptionsScene(draftKey) },
        ]} />
        <div className="composer-body">
        <label htmlFor={inputId} className="sr-only">和{runtime.settings.agentName.trim() || '榫'}说点什么</label>
        <textarea ref={input} id={inputId} rows={1} maxLength={20000} value={text} disabled={stopped}
          onPaste={event => { if (event.clipboardData.files.length) void attachmentDrafts.add(draftKey, Array.from(event.clipboardData.files)); }}
          onChange={event => { const value = event.target.value; setDrafts(previous => ({ ...previous, [draftKey]: value })); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }}
          placeholder={reply ? '接着这条消息说…' : `和${runtime.settings.agentName.trim() || '榫'}说点什么…`} />
        </div>
        <div className="composer-buttons">
          {activeReply && <button type="button" className="icon-button stop-reply-button" aria-label={stopLabel} title={stopLabel} disabled={stoppingReply}
            onClick={() => void perform(stopKey, () => stopReply(activeReply.id))}>
            {stoppingReply ? <LoaderCircle size={18} className="spin" aria-hidden="true" /> : <Square size={15} fill="currentColor" aria-hidden="true" />}
          </button>}
          <button type="submit" className="send-button" aria-label="发送消息" disabled={sendDisabled}>{sending ? <LoaderCircle size={20} className="spin" /> : <ArrowUp size={23} strokeWidth={1.7} />}</button>
        </div>
      </form>
    </div>
    <ReadingPanel key={readingScope} content={selectedReading} onClose={closeReading} returnFocus={readingOpener} />
  </main>;
}
