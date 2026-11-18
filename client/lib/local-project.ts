import type { ProjectOperation } from '../../shared/local-project';
import type { RuntimeConnectionHealth } from '../api';

export interface LocalProjectBridge {
  currentId(): Promise<string | undefined>;
  chooseProject(): Promise<{ deviceId: string; root: string } | undefined>;
  openProjectPreview(deviceId: string, url: string): Promise<unknown>;
  openProjectFolder(deviceId: string, operationId: string): Promise<unknown>;
}
export function localProjectBridge(): LocalProjectBridge | undefined {
  if (typeof window === 'undefined') return;
  return (window as Window & { raeLocalDevice?: LocalProjectBridge }).raeLocalDevice;
}

const projectStates = { queued: '等待执行设备接收', running: '正在处理项目', waiting: '等待继续', completed: '执行结束',
  failed: '执行未完成', cancelled: '已停止', unknown: '执行状态待核对' };
const runningSteps: Readonly<Record<string, string>> = {
  fileChange: '正在修改项目文件', mcpToolCall: '正在调用项目工具',
  dynamicToolCall: '正在调用项目工具', collabAgentToolCall: '正在协同处理项目',
};
const sentences = new Intl.Segmenter('zh', { granularity: 'sentence' });

function latestProjectSentence(text: string): string {
  let prose = '';
  let start = 0;
  let fence: string | undefined;
  for (const marker of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gm)) {
    if (!fence) {
      prose = text.slice(Math.max(start, marker.index - 1024), marker.index).trimEnd() || prose;
      fence = marker[1];
    } else if (marker[1].startsWith(fence) && !marker[2].trim()) {
      fence = undefined;
      start = marker.index + marker[0].length;
    }
  }
  const tail = (!fence && text.slice(Math.max(start, text.length - 1024)).trimEnd()) || prose;
  const line = tail.slice(tail.lastIndexOf('\n') + 1).trim().replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '');
  let latest = '';
  for (const { segment } of sentences.segment(line)) latest = segment.trim() || latest;
  return latest.length > 100 ? `${latest.slice(0, 100)}…` : latest;
}

export function projectProgressText(operation: Pick<ProjectOperation, 'state' | 'tools' | 'activity' | 'modelTransport' | 'delivery'> | null, publicText: string | undefined,
  connection?: RuntimeConnectionHealth, server = false): string {
  if (!operation) return '等待项目执行记录';
  if (connection && connection.state !== 'connected' && ['queued', 'running', 'waiting'].includes(operation.state)) return '连接恢复中，最新进度待同步';
  if (operation.state === 'queued' && server) return '等待服务器接收';
  if (operation.state !== 'running') return projectStates[operation.state];
  const tool = [...operation.tools].reverse().find(item => item.state === 'running');
  if (tool?.type === 'commandExecution') return server ? '正在执行服务器命令' : '正在执行本机命令';
  if (tool) return runningSteps[tool.type] ?? '正在执行项目操作';
  if (operation.activity) {
    if (operation.modelTransport?.state === 'receiving' && operation.activity.kind === 'model_transport') return '正在接收模型响应';
    if (operation.activity.kind === 'verification') return '成果检查已记录，正在收尾';
    if (operation.activity.kind === 'plan') return '执行方案已记录，正在继续';
    if (operation.activity.kind === 'environment') return '正在确认执行环境已排空';
    if (operation.activity.kind === 'diff' || operation.tools.at(-1)?.type === 'fileChange') return '文件已变更，等待后续操作';
    if (operation.activity.kind !== 'text') return '最近操作已返回，正在继续';
  }
  const latest = publicText ? latestProjectSentence(publicText) : '';
  return latest ? `${projectStates.running} · ${latest}` : projectStates.running;
}
