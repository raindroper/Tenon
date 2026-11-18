import type { MediaSpec } from './media.js';
import type { DeviceCommandSpec } from './local-device.js';
import type { MailTaskSpec, MailTaskReceipt } from './mail.js';
import type { GitHubTaskReceipt, GitHubTaskSpec } from './github.js';
import type { LocalProjectSpec, ProjectRequest } from './local-project.js';
import type { ModelBinding } from './model-connections.js';
import type { TaskAcceptance, TaskFinalFilesUpdate, TaskFlowView } from './task-flow.js';
export type TaskCapability = 'artifact' | 'workspace' | 'media' | 'local-command' | 'mail' | 'github' | 'project' | 'review';
export type TaskState = 'proposed' | 'approved' | 'running' | 'completed' | 'failed' | 'rejected' | 'revoked';

/** A reference to the original authorized observation, never a copied source or access grant. */
export interface TaskEvidenceRef {
  eventId: string;
  sourceId: string;
  sourceCaseId: string;
  sourceGeneration?: string;
}

/** A description of authorized work, never the deliverable itself. */
export interface TaskSpec {
  caseId: string;
  title: string;
  objective: string;
  expectedOutput: string;
  capabilities: TaskCapability[];
  media?: MediaSpec;
  command?: DeviceCommandSpec;
  mail?: MailTaskSpec;
  github?: GitHubTaskSpec;
  project?: LocalProjectSpec;
  directoryAnalysis?: true;
  workspace?: { revision: number; files: string[] };
  acceptance?: TaskAcceptance;
  /** A source proposal may describe project work before the owner binds a device. */
  projectSelection?: { reason: string };
  /** Runtime-issued read-only review, inherited from an active task's precise pending input. */
  review?: { dependencyId: string; eventIds: string[]; dependencyRevision: number };
}
/** Owner-authored additions to the original objective; never a new resource grant. */
export interface TaskRequirementUpdate {
  revision: number;
  sourceEventId: string;
  content: string;
  createdAt: string;
  /** Original conversation of the owner's continuation; the task keeps its home case. */
  caseId?: string;
  evidenceEventIds?: string[];
  /** Explicit owner change to stage review; the original resource scope remains immutable. */
  stageReview?: 'auto' | 'owner';
  finalFiles?: TaskFinalFilesUpdate;
}
export interface TaskRecord {
  executionContractVersion?: 1 | 2;
  contextTaskIds?: string[];
  /** Execution scopes use stable IDs; all belong to one owner-visible task. The first scope keeps the historical task ID. */
  rootTaskId?: string;
  operationRole?: 'execution' | 'clarification' | 'review';
  dependencyId?: string;
  dependencyQuestionKeys?: string[];
  parentScope?: { operationId: string; approvalRevision: number; requirementsRevision: number };
  /** Preserve the exact published proposal when the owner supplies its missing project scope. */
  proposalSpec?: TaskSpec;
  /** Read-only aggregation; operation scopes and dependencies remain the writable facts. */
  flow?: TaskFlowView;
  /** Immutable inference selection; it grants no execution or resource permissions. */
  modelBinding?: ModelBinding | null;
  id: string;
  /** Compare-and-set version for changes to this record, including lifecycle transitions. */
  revision: number;
  state: TaskState;
  /** The original, immutable objective and exact authorized operation/resource scope. */
  spec: TaskSpec;
  /** Legacy records have version 1. Status changes do not advance this version. */
  requirementsRevision?: number;
  requirementUpdates?: TaskRequirementUpdate[];
  /** Live reads must revalidate every referenced source and generation. */
  evidenceRefs?: TaskEvidenceRef[];
  sourceEventId?: string;
  ownerRequestId?: string;
  ownerDecision?: { action: 'approve' | 'reject'; eventId: string; messageId: string; caseId: string; contentHash: string; at: string };
  /** Stable identity of the consent that admitted execution; not the record's current version. */
  approvalRevision?: number;
  /** The exact Linux execution scope confirmed in the task card. */
  serverApproval?: { projectSpecHash: string };
  executionEventId?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  revokedAt?: string;
  error?: string;
  /** Transport result projection; it does not confer permission or imply delivery. */
  mailReceipt?: MailTaskReceipt;
  /** Projection of durable remote receipts, never a source of execution permission. */
  githubReceipts?: GitHubTaskReceipt[];
  /** Final device evidence resolved an earlier non-final outcome; never a new permit. */
  deviceResolution?: { operationId: string; resolvedAt: string; previousState: TaskState; previousError?: string };
  projectResolution?: { operationId: string; resolvedAt: string; previousState: TaskState; previousError?: string };
}
export interface OwnerTaskRequest { requestId: string; spec: Omit<TaskSpec, 'project'> & { project?: ProjectRequest } }

/** Conversation membership follows actual owner continuations; execution keeps its original home. */
export function taskInConversation(task: TaskRecord, caseId: string): boolean {
  return task.spec.caseId === caseId || Boolean(task.requirementUpdates?.some(update => update.caseId === caseId));
}
export function taskNeedsAttention(task: TaskRecord): boolean {
  return task.state === 'proposed' || Boolean(task.flow && ['waiting_approval', 'waiting_input', 'awaiting_acceptance'].includes(task.flow.phase));
}
