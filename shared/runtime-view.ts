import type { AgentStatus, ReasoningPolicy, Run, Settings, Source } from './types.js';
import type { PersonalMemoryEntry, PersonalMemoryPage } from './personal-memory.js';
import type { TaskRecord } from './task-consent.js';
import type { ProjectWorkspace } from './local-project.js';
import type { ImageAttachment } from './chat-images.js';
import type { ChatFileAttachment } from './chat-files.js';
import type { MediaJob } from './media.js';
import type { LocalDevice } from './local-device.js';
import type { SceneThemeId } from './scene-theme.js';
import type { SceneBackgroundSource } from './scene-background.js';
import type { MeetingReminder } from './reminders.js';
import type { ModelDirectory } from './model-connections.js';

/** Kernel versions whose public state shape this client can consume. */
export const SUPPORTED_RUNTIME_SCHEMA_VERSIONS = [3, 4, 5, 6, 7, 8, 9] as const;
export type RuntimeSchemaVersion = (typeof SUPPORTED_RUNTIME_SCHEMA_VERSIONS)[number];

export interface RuntimeMessage {
  id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string;
  caseId?: string; replyTo?: string; replyPreview?: string; runId?: string; attachments?: ImageAttachment[]; files?: ChatFileAttachment[]; reasoningEffort?: ReasoningPolicy; deviceId?: string;
  requestId?: string;
  outputState?: 'streaming' | 'complete' | 'incomplete'; outputNote?: string; feedbackVersion?: string; reminder?: MeetingReminder;
}
/** Bounded projection of saved public replies, independent of the open history page. */
export interface RuntimeMessageNotice {
  id: string; caseId?: string; createdAt: string; preview: string;
  outputState?: RuntimeMessage['outputState'];
}
export interface RuntimeCase {
  id: string; title: string; objective: string; domain: string;
  backgroundSources?: SceneBackgroundSource[];
  themeId?: SceneThemeId;
  status: 'active' | 'waiting' | 'completed' | 'cancelled'; threadId: string; createdAt: string; updatedAt: string; feedbackVersion?: string;
}
export interface RuntimeWorkspaceSource {
  sourceId: string; root: string; caseId: string; include?: string[]; generation: string; connectionId: string;
  status: 'starting' | 'active' | 'failed' | 'removed'; health: string | null; watching: boolean;
  observationRoots: readonly string[]; createdAt: string; updatedAt: string; removedAt?: string;
}
export interface RuntimeArtifact {
  id: string; title: string; content: string; format: 'markdown' | 'text'; createdAt: string;
  caseId?: string; taskId?: string; requirementsRevision?: number; status: 'prepared' | 'verified'; feedbackVersion?: string;
}
export interface RuntimeFeedback {
  id: string; targetType: 'message' | 'artifact' | 'case'; targetId: string;
  verdict: 'useful' | 'off_target' | 'correction' | 'not_now'; comment: string; createdAt: string;
  caseId?: string; targetContent?: string; targetVersion?: string;
}
export interface RuntimeEventSummary {
  id: string; sourceId: string; kind: string; operation: 'create' | 'update' | 'delete';
  status: 'pending' | 'leased' | 'processed' | 'failed'; occurredAt: string; receivedAt?: string;
  caseId?: string; messageId?: string; attempts: number; lastError: string | null;
}
export interface RuntimeGrantSummary {
  caseId: string; repoRoot: string; worktreePath: string; status: 'prepared' | 'verified' | 'failed'; revision: number; allowedFiles: string[]; revokedAt?: string;
}
export interface RuntimeRun extends Run { caseId?: string; eventId?: string }
export interface RuntimeViewScope { caseId?: string; before?: string }
export interface RuntimeHistoryScope { kind: 'runs' | 'events'; caseId?: string; before?: string }
export interface RuntimeHistoryPage<T = RuntimeRun | RuntimeEventSummary> { items: T[]; nextBefore: string | null }
export interface RuntimeView {
  modelConnections?: ModelDirectory;
  /** Persisted kernel schema, distinct from the RuntimeApi command contract version. */
  runtime: 'mastra'; schemaVersion: RuntimeSchemaVersion; settings: Settings; status: AgentStatus;
  messages: RuntimeMessage[]; cases: RuntimeCase[]; understanding: PersonalMemoryEntry[];
  /** The bounded live memory window; older records are read by the memory panel's own pages. */
  understandingPage?: Pick<PersonalMemoryPage, 'total' | 'offset' | 'nextOffset'>;
  conversation: { caseId: string | null; before: string | null; beforeCreatedAt: string | null; nextBefore: string | null };
  casePreviews: Record<string, string>;
  notificationMessages?: RuntimeMessageNotice[];
  tasks: TaskRecord[];
  projectWorkspaces?: ProjectWorkspace[];
  projectOperations?: Array<{ taskId: string; sequence: number; state: string; updatedAt: string; environment?: string }>;
  mediaJobs?: MediaJob[];
  devices?: Array<Pick<LocalDevice, 'id' | 'name' | 'online' | 'capabilities'> & Partial<Pick<LocalDevice, 'platform'>>>;
  sources: readonly Source[]; workspaceSources: RuntimeWorkspaceSource[]; artifacts: readonly RuntimeArtifact[];
  feedback: RuntimeFeedback[]; runs: RuntimeRun[]; events: RuntimeEventSummary[]; grants: RuntimeGrantSummary[];
  /** Recent global pages; visible-message associations may add older items to runs/events. */
  history: { runs: RuntimeHistoryPage<RuntimeRun>; events: RuntimeHistoryPage<RuntimeEventSummary> };
  archive: { readOnly: true; counts: { memories: number; initiatives: number; activities: number } };
}
export interface RuntimeViewDelta {
  base: string;
  replace: Partial<RuntimeView>;
  remove?: Array<'mediaJobs' | 'devices' | 'projectWorkspaces' | 'projectOperations'>;
}
export interface CaseDetailView {
  case: RuntimeCase; working: string | null; history: unknown[]; shared: unknown[];
  taskHistories?: Array<{ taskId: string; requirementsRevision: number; caseId: string; threadId: string; history: unknown[] }>;
}
