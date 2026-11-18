import { lazy, Suspense, useEffect, useReducer, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { Dialog, tenonMark } from './components/primitives';
import { Conversation } from './components/Conversation';
import { ActionMenu } from './components/ActionMenu';
import { StatusNote } from './components/StatusNote';
import { useRuntime } from './state/useRuntime';
import { useNotifications } from './state/useNotifications';
import { DEFAULT_SCENE_ID, initialUiState, sceneName, uiReducer, type Panel } from './state/ui-state';
import type { RuntimeView } from '../shared/runtime-view';
import { Login, LoginBrand } from './components/Login';
import { useSession } from './state/useSession';
import { PanelErrorBoundary } from './components/PanelErrorBoundary';
import { takeConnectorOAuthReturn, type ConnectorOAuthResult } from './lib/connector-oauth';
import { canShowWindowsDesktopDownload, windowsDesktopDownload, windowsDesktopFilename } from './lib/desktop-download';
import { SceneTabs, sceneTabId } from './components/SceneTabs';

const PanelContent = lazy(() => import('./panels/PanelContent').then(module => ({ default: module.PanelContent })));
const panelLabels = { history: '场景', memory: '记忆', sources: '资料', runs: '运行记录', settings: '设置与连接', devices: '我的设备', connectors: '连接器',
  addSource: '添加资料', taskRequest: '明确委托', source: '资料内容', artifact: '交付内容', editMemory: '纠正记忆',
  feedback: '给出反馈', caseDetail: '场景详情', caseEditor: '新建场景', ewsCompose: '发送邮件' };

function panelTitle(panel: Panel, runtime: RuntimeView): string {
  if (panel.type === 'source') return runtime.sources.find(item => item.id === panel.id)?.title ?? panelLabels.source;
  if (panel.type === 'artifact') return runtime.artifacts.find(item => item.id === panel.id)?.title ?? panelLabels.artifact;
  if (panel.type === 'caseDetail') return sceneName(panel.caseId, runtime.cases.find(item => item.id === panel.caseId)?.title ?? panelLabels.caseDetail);
  if (panel.type === 'caseEditor' && panel.caseId) return '编辑场景';
  if (panel.type === 'taskRequest') {
    if (panel.mediaKind === 'image') return '生成图片';
    if (panel.mediaKind === 'video') return '生成视频';
    return '委托任务';
  }
  if (panel.type === 'settings') return '设置';
  return panelLabels[panel.type];
}

export default function App() {
  const auth = useSession();
  if (auth.phase !== 'ready') return <main className="login-page login-status" aria-live="polite">
    <img className="login-ghost" src={tenonMark} alt="" />
    <div className="login-grain" aria-hidden="true" />
    <section className="login-content">
      <LoginBrand />
      <div className="login-rule" aria-hidden="true" />
      {auth.phase === 'checking' ? <><LoaderCircle size={22} className="spin" /><p>{auth.retry === 'logout' ? '正在退出…' : '正在打开你的空间…'}</p></>
        : <><p role="alert">{auth.error}</p><button className="button" onClick={() => void (auth.retry === 'logout' ? auth.logout() : auth.check())}>{auth.retry === 'logout' ? '重试退出' : '重新连接'}</button></>}
    </section>
  </main>;
  if (!auth.session || auth.session.required && !auth.session.authenticated) return <Login busy={auth.busy} error={auth.error} onLogin={auth.login} />;
  return <AuthenticatedApp onLogout={auth.session.required ? () => void auth.logout() : undefined} />;
}

function AuthenticatedApp({ onLogout }: { onLogout?: () => void }) {
  const [ui, dispatch] = useReducer(uiReducer, initialUiState);
  const [oauthResult, setOAuthResult] = useState<ConnectorOAuthResult>();
  useEffect(() => {
    // Claim and scrub the callback before any async work, including on Strict Mode replay.
    const complete = takeConnectorOAuthReturn();
    if (!complete) return;
    dispatch({ type: 'openPanel', panel: { type: 'connectors' } });
    setOAuthResult({ status: 'pending', message: '正在保存授权…' });
    void complete().then(
      () => setOAuthResult({ status: 'success', message: '连接已添加。' }),
      cause => setOAuthResult({ status: 'error', message: cause instanceof Error ? cause.message : '无法完成授权，请重新连接。' }),
    );
  }, []);
  const caseId = ui.caseId ?? DEFAULT_SCENE_ID;
  const state = useRuntime({ caseId });
  const [browsingCaseId, setBrowsingCaseId] = useState<string | null>(null);
  const panelOpener = useRef<HTMLElement | null>(null);
  const operationError = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.error && ui.panel) operationError.current?.focus();
  }, [state.error, ui.panel]);
  const openPanel = (panel: Panel) => {
    const focus = document.activeElement;
    if (focus instanceof HTMLElement && !focus.closest('dialog')) panelOpener.current = focus;
    dispatch({ type: 'openPanel', panel });
  };
  const closePanel = () => {
    if (ui.panel?.type === 'connectors' && oauthResult?.status !== 'pending') setOAuthResult(undefined);
    dispatch({ type: 'closePanel', expected: ui.panel });
  };
  const selectCase = (selected: string | null) => {
    dispatch({ type: 'selectCase', caseId: selected });
  };
  const { runtime } = state;
  const page = runtime?.conversation;
  const readingCaseId = !ui.panel && browsingCaseId !== caseId && page?.caseId === caseId ? caseId : null;
  const unreadScenes = useNotifications(runtime, readingCaseId, selected => {
    if (selected === DEFAULT_SCENE_ID || runtime?.cases.some(item => item.id === selected)) selectCase(selected);
  });
  return <div className="app">
    <img className="app-ghost" src={tenonMark} alt="" />
    <div className="app-shell">
    <header className="app-header">
      <button type="button" className="brand" onClick={() => selectCase(null)} aria-label="榫 Tenon，返回通用场景" title="返回通用场景">榫</button>
      <SceneTabs cases={runtime?.cases ?? []} tasks={runtime?.tasks ?? []} selectedId={caseId} unreadScenes={unreadScenes} onSelect={selectCase}
        onCreate={() => openPanel({ type: 'caseEditor' })} />
      <div className="header-actions">
        {runtime && <StatusNote status={runtime.status} timezone={runtime.settings.timezone} onOpenSettings={() => openPanel({ type: 'settings' })} />}
        <ActionMenu label="更多" text="更多" triggerClassName="more-btn" actions={[...([
          ['history', '管理场景'], ['memory', '记忆'], ['sources', '资料'], ['runs', '运行记录'], ['connectors', '连接器'], ['devices', '我的设备'], ['settings', '设置与连接'],
        ] as const).map(([type, label]) => ({ label, onSelect: () => openPanel({ type }) })),
          ...(canShowWindowsDesktopDownload() ? [{ label: '下载 Windows 客户端', quiet: true, separatorBefore: true,
            href: windowsDesktopDownload, download: windowsDesktopFilename }] : []),
          ...(onLogout ? [{ label: '退出登录', quiet: true, separatorBefore: !canShowWindowsDesktopDownload(), onSelect: onLogout }] : [])]} />
      </div>
    </header>
    {(state.connectionError || state.error && !ui.panel) && <div className="app-alert" role="alert"><span>{state.connectionError || state.error}</span>
      {state.connectionError ? <button className="text-link" onClick={state.reconnect}>重新连接</button> : <button className="icon-button" onClick={state.dismissError} aria-label="关闭提示"><X size={16} /></button>}
    </div>}
    <div id="scene-conversation" className="scene-panel" role="tabpanel" aria-labelledby={sceneTabId(caseId)} tabIndex={0}>
    {runtime ? <Conversation runtime={runtime} connection={state.connection} caseId={ui.caseId} reply={ui.reply} busy={state.busy} perform={state.perform} onBrowse={setBrowsingCaseId}
      onOpenPanel={openPanel} onCancelReply={() => dispatch({ type: 'cancelReply' })}
      onReply={message => dispatch({ type: 'replyTo', message })} onSent={replyId => dispatch({ type: 'messageSent', replyId })} />
      : <main className="loading-state" aria-live="polite"><LoaderCircle size={22} className="spin" /><p>{state.connectionError ? '等待服务恢复' : '正在连接你的空间…'}</p></main>}
    </div>
    </div>
    {runtime && ui.panel && <Dialog key={`${ui.panel.type}:${'id' in ui.panel ? ui.panel.id : 'key' in ui.panel ? ui.panel.key : 'caseId' in ui.panel ? ui.panel.caseId : ''}`} title={panelTitle(ui.panel, runtime)} onClose={closePanel} returnFocus={panelOpener}>
      {state.error && <div ref={operationError} className="app-alert" role="alert" tabIndex={-1}><span>{state.error}</span><button className="icon-button" onClick={state.dismissError} aria-label="关闭提示"><X size={16} /></button></div>}
      <PanelErrorBoundary onClose={closePanel}><Suspense fallback={<p className="muted" role="status">正在打开…</p>}><PanelContent panel={ui.panel} runtime={runtime} perform={state.perform} busy={state.busy}
        currentCaseId={ui.caseId} connectorOAuthResult={oauthResult} onOpenPanel={openPanel} onClose={closePanel} onSelectCase={selectCase}
        onPanelSubmitted={caseId => dispatch({ type: 'panelSubmitted', expected: ui.panel!, caseId })} /></Suspense></PanelErrorBoundary>
    </Dialog>}
    {state.notice && <div className="notice" role="status"><span>{state.notice}</span><button className="icon-button" onClick={state.dismissNotice} aria-label="关闭通知"><X size={15} /></button></div>}
  </div>;
}
