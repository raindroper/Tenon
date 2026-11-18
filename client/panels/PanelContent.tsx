import { Empty, Markdown } from '../components/primitives';
import { dateTime } from '../lib/format';
import { SettingsPanel } from './settings';
import { MemoryPanel, EditMemoryPanel } from './memory';
import { SourcesPanel, AddSourcePanel } from './sources';
import { ActivityPanel, ArtifactPanel } from './activity';
import { HistoryPanel, CaseDetailPanel, CaseEditorPanel } from './history';
import { TaskRequestPanel } from './tasks';
import { MediaRequestPanel } from './media';
import { FeedbackPanel } from './feedback';
import { DevicesPanel } from './devices';
import { ConnectorsPanel } from './connectors';
import { EwsComposePanel } from './EwsComposePanel';
import type { PanelContentProps } from './types';

export function PanelContent({ panel, currentCaseId, connectorOAuthResult, ...context }: PanelContentProps) {
  const { runtime } = context;
  switch (panel.type) {
    case 'history': return <HistoryPanel {...context} currentCaseId={currentCaseId} />;
    case 'memory': return <MemoryPanel {...context} />;
    case 'sources': return <SourcesPanel {...context} />;
    case 'runs': return <ActivityPanel {...context} />;
    case 'settings': return <SettingsPanel {...context} />;
    case 'devices': return <DevicesPanel {...context} />;
    case 'connectors': return <ConnectorsPanel {...context} initialCaseId={currentCaseId} oauthResult={connectorOAuthResult} />;
    case 'ewsCompose': return <EwsComposePanel key={`${panel.connectionId}:${panel.mode}:${panel.original?.messageId ?? ''}`}
      {...context} connectionId={panel.connectionId} mode={panel.mode} original={panel.original} />;
    case 'addSource': return <AddSourcePanel {...context} caseId={currentCaseId} />;
    case 'source': {
      const source = runtime.sources.find(item => item.id === panel.id);
      return source ? <><p className="field-note">{source.filename || '文本资料'} · {dateTime(source.createdAt, runtime.settings.timezone, true)}</p><Markdown>{source.content}</Markdown></> : <MissingRecord />;
    }
    case 'artifact': {
      const artifact = runtime.artifacts.find(item => item.id === panel.id);
      return artifact ? <ArtifactPanel {...context} artifact={artifact} /> : <MissingRecord />;
    }
    case 'editMemory': {
      const selected = panel.entry?.key === panel.key ? panel.entry : undefined;
      const entry = runtime.understanding.find(item => item.key === panel.key) ?? selected;
      return entry ? <EditMemoryPanel {...context} entry={entry} initialEntry={selected} /> : <MissingRecord />;
    }
    case 'feedback': return <FeedbackPanel {...context} target={panel.target} />;
    case 'caseDetail': return <CaseDetailPanel {...context} caseId={panel.caseId} />;
    case 'caseEditor': {
      const item = panel.caseId ? runtime.cases.find(candidate => candidate.id === panel.caseId) : undefined;
      return panel.caseId && !item ? <MissingRecord /> : <CaseEditorPanel {...context} item={item} />;
    }
    case 'taskRequest': return panel.mediaKind
      ? <MediaRequestPanel key={panel.mediaKind} {...context} initialCaseId={currentCaseId} kind={panel.mediaKind} draft={panel.draft} />
      : <TaskRequestPanel {...context} initialCaseId={currentCaseId} draft={panel.draft} initialDeviceId={panel.deviceId} windowsTask={panel.windowsTask} proposalTask={panel.proposalTask} />;
  }
}

function MissingRecord() {
  return <Empty title="这份记录已不可用">你可以关闭面板后重新查看当前记录。</Empty>;
}
