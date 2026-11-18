import type { RuntimeFeedback, RuntimeMessage, RuntimeView } from '../../shared/runtime-view';
import { taskInConversation, type TaskRecord } from '../../shared/task-consent';
import type { EwsComposeMode } from '../lib/ews-mail';
import type { PersonalMemoryEntry } from '../../shared/personal-memory';

export const DEFAULT_SCENE_ID = 'personal-growth';
export const DEFAULT_SCENE_NAME = '通用';
export const NEW_SCENE = ':new:';

export type FeedbackTarget = { type: RuntimeFeedback['targetType']; id: string; label: string; version: string };
export type Panel =
  | { type: 'history' | 'memory' | 'sources' | 'runs' | 'settings' | 'devices' | 'connectors' | 'addSource' }
  | { type: 'taskRequest'; draft?: string; mediaKind?: 'image' | 'video'; deviceId?: string; windowsTask?: TaskRecord['spec']; proposalTask?: TaskRecord }
  | { type: 'ewsCompose'; connectionId: string; mode: EwsComposeMode; original?: { queryId: string; messageId: string } }
  | { type: 'source' | 'artifact'; id: string }
  | { type: 'editMemory'; key: string; entry?: PersonalMemoryEntry }
  | { type: 'feedback'; target: FeedbackTarget }
  | { type: 'caseEditor'; caseId?: string }
  | { type: 'caseDetail'; caseId: string };

export interface UiState {
  caseId: string | null;
  reply: RuntimeMessage | null;
  panel: Panel | null;
}
export const initialUiState: UiState = { caseId: null, reply: null, panel: null };
export type UiAction =
  | { type: 'openPanel'; panel: Panel }
  | { type: 'closePanel'; expected?: Panel | null }
  | { type: 'selectCase'; caseId: string | null }
  | { type: 'replyTo'; message: RuntimeMessage }
  | { type: 'cancelReply' }
  | { type: 'messageSent'; replyId?: string }
  | { type: 'panelSubmitted'; expected: Panel; caseId: string };

/** One panel can own focus at a time. Context changes and quoted replies move together. */
export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'openPanel': return { ...state, panel: action.panel };
    case 'closePanel': return action.expected !== undefined && state.panel !== action.expected ? state : { ...state, panel: null };
    case 'selectCase': return { caseId: action.caseId, reply: null, panel: null };
    case 'replyTo': return { caseId: action.message.caseId ?? null, reply: action.message, panel: null };
    case 'cancelReply': return { ...state, reply: null };
    case 'messageSent': return state.reply?.id === action.replyId ? { ...state, reply: null } : state;
    case 'panelSubmitted': return state.panel !== action.expected ? state : { caseId: action.caseId, reply: null, panel: null };
  }
}

/** Matches the server's stable ensureCase('personal-growth') identity, never a title or list order. */
export function deriveConversation(runtime: RuntimeView, selectedCaseId: string | null) {
  const caseId = selectedCaseId ?? (runtime.cases.some(item => item.id === DEFAULT_SCENE_ID) ? DEFAULT_SCENE_ID : null);
  return {
    caseId,
    item: runtime.cases.find(item => item.id === caseId),
    messages: caseId ? runtime.messages.filter(message => message.caseId === caseId) : [],
    tasks: caseId ? runtime.tasks.filter(task => taskInConversation(task, caseId)) : [],
  };
}

/** A continuation places the existing card in that conversation, without moving its home history. */
export function taskConversationDate(task: TaskRecord, caseId: string | null): string {
  if (task.spec.caseId === caseId) return task.createdAt;
  return task.requirementUpdates?.reduce((latest, update) =>
    update.caseId === caseId && update.createdAt > latest ? update.createdAt : latest, '') || task.createdAt;
}

export function sceneName(id: string, title?: string): string {
  return id === DEFAULT_SCENE_ID && (!title || title === '相处与成长') ? DEFAULT_SCENE_NAME : title ?? '场景';
}

export function openSceneChoices(cases: RuntimeView['cases']) {
  const choices = cases.filter(item => item.status === 'active' || item.status === 'waiting')
    .map(({ id, title }) => ({ id, title: sceneName(id, title) }));
  if (!cases.some(item => item.id === DEFAULT_SCENE_ID)) {
    choices.unshift({ id: DEFAULT_SCENE_ID, title: DEFAULT_SCENE_NAME });
  }
  return choices;
}

export function initialSceneChoice(choices: ReturnType<typeof openSceneChoices>, current?: string | null): string {
  if (current && choices.some(item => item.id === current)) return current;
  return choices.some(item => item.id === DEFAULT_SCENE_ID) ? DEFAULT_SCENE_ID : '';
}

export type SceneCreationAttempt = { fingerprint: string; requestId: string };

export function sceneCreationRequest(input: { title: string; objective: string; domain: string }, attempt: { current: SceneCreationAttempt | null }) {
  const fingerprint = JSON.stringify([input.title, input.objective, input.domain]);
  if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: crypto.randomUUID() };
  return { ...input, requestId: attempt.current.requestId };
}
