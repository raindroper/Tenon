import type { AgentStatus, Feedback, ReasoningPolicy, Source, Trigger } from '../shared/types.js';
import type { RuntimeView, RuntimeViewScope, RuntimeFeedback, CaseDetailView, RuntimeCase, RuntimeHistoryScope, RuntimeHistoryPage } from '../shared/runtime-view.js';
import type { PersonalMemoryEntry, CorrectPersonalMemoryInput, PersonalMemoryMutationContext, PersonalMemoryPage, PersonalMemorySubject } from '../shared/personal-memory.js';
import type { SceneBackgroundSource } from '../shared/scene-background.js';
import type { OwnerTaskRequest, TaskRecord, TaskEvidenceRef } from '../shared/task-consent.js';
import type { TaskFinalFilesUpdate } from '../shared/task-flow.js';
import type { WorkspaceExecutor } from './v2/workspace.js';
import type { ProjectRequest, ProjectOperation, ServerProjectResources } from '../shared/local-project.js';
import type { ProjectFileDelivery } from '../shared/project-files.js';
import type { ImageAttachment, ImageUpload } from '../shared/chat-images.js';
import type { ChatFileUpload } from '../shared/chat-files.js';
import type { MediaCatalog, MediaJob } from '../shared/media.js';
import type { DeviceBroker } from './devices/broker.js';
import type { DeviceOperation, DevicePairing, LocalDevice } from '../shared/local-device.js';
import type { ConnectorConnection, ConnectorDirectory, ConnectorDocumentMetadata, ConnectorKind, TencentDocsCredential } from '../shared/connectors.js';
import type { RetiredAgentWeChatArchive } from './connectors/service.js';
import type { EwsConnectInput, EwsUpdateInput, EwsQueryInput, EwsReadInput, EwsMessagePage, EwsMessageReadPage } from '../shared/ews.js';
import type { EwsAttachmentPage, EwsMessageContext, EwsSelectionInput, EwsMailUpload } from '../shared/ews.js';
import type { EwsMailOperation } from '../shared/mail.js';
import type { GitHubConnectInput, GitHubUpdateInput, GitHubUpgradeInput } from '../shared/github-connection.js';
import type { OAuthAppInput, OAuthAppKind } from '../shared/oauth-apps.js';
import type { WeChatObservationBatch, WeChatObservationBinding, WeChatObservationGrant, WeChatObservationReceipt, WeChatObservationRevocation, WeChatObservationSelection, WeChatObservationStop, WeChatConversationStatus } from '../shared/wechat-observation.js';

import type { RuntimeModelCommands } from './models/runtime.js';
export type PersonalMemoryCorrection = CorrectPersonalMemoryInput;
export interface RuntimeFeedbackInput {
  targetType: 'message' | 'artifact' | 'case'; targetId: string;
  verdict: Feedback['verdict']; comment: string; targetVersion?: string;
}
export interface RuntimeSourceInput { title: string; content: string; filename?: string; caseId?: string }
export interface RuntimeCaseInput { title: string; objective: string; domain: string; requestId?: string; backgroundSources?: SceneBackgroundSource[] }
export interface RuntimeCasePatch { title?: string; objective?: string; status?: 'active' | 'waiting' | 'cancelled'; backgroundSources?: SceneBackgroundSource[] }
export interface WorkspaceSourceInput { sourceId: string; root: string; caseId: string; include?: string[] }
export interface ConnectorSelection { caseId: string; scope: string; connectionId?: string }
export interface RuntimeConnectorCommands {
  list(): Promise<ConnectorDirectory>;
  connectGitHub(input: GitHubConnectInput): Promise<ConnectorConnection>;
  updateGitHub(id: string, input: GitHubUpdateInput): Promise<ConnectorConnection>;
  upgradeGitHub(id: string, input: GitHubUpgradeInput): Promise<ConnectorConnection>;
  saveOAuthApp(kind: OAuthAppKind, input: OAuthAppInput): Promise<ConnectorDirectory>;
  connectEws(input: EwsConnectInput): Promise<ConnectorConnection>;
  updateEws(id: string, input: EwsUpdateInput): Promise<ConnectorConnection>;
  queryEwsMessages(id: string, input: EwsQueryInput): Promise<EwsMessagePage>;
  readEwsMessage(id: string, input: EwsReadInput): Promise<EwsMessageReadPage>;
  getEwsMessageContext(id: string, input: EwsSelectionInput): Promise<EwsMessageContext>;
  listEwsMessageAttachments(id: string, input: EwsSelectionInput): Promise<EwsAttachmentPage>;
  downloadEwsAttachment(id: string, input: EwsSelectionInput & { attachmentId: string }): Promise<{ name: string; contentType: string; bytes: Buffer }>;
  uploadEwsMailAttachment(id: string, input: { name: string; contentType: string; bytes: Buffer }): Promise<EwsMailUpload>;
  copyEwsMailAttachment(id: string, input: EwsSelectionInput & { attachmentId: string; allowProtectedSourcePlaintext?: true }): Promise<EwsMailUpload>;
  removeEwsMailAttachment(id: string, uploadId: string): Promise<void>;
  start(kind: ConnectorKind, input: ConnectorSelection, origin: string): Promise<{ url: string; state: string }>;
  complete(kind: ConnectorKind, state: string, code: string, origin: string): Promise<ConnectorConnection>;
  saveTencentDocsCredential(token: string): Promise<TencentDocsCredential>;
  removeTencentDocsCredential(id: string): Promise<{ id: string; removed: true }>;
  previewTencentDocument(input: ConnectorSelection & { credentialId: string }): Promise<ConnectorDocumentMetadata>;
  connectTencentDocument(input: ConnectorSelection & { credentialId: string }): Promise<ConnectorConnection>;
  sync(id: string): Promise<ConnectorConnection>;
  disconnect(id: string): Promise<{ id: string; disconnected: true }>;
}
export interface RuntimeWeChatObservationCommands {
  list(): Promise<WeChatObservationGrant[]>;
  status(id: string): Promise<WeChatConversationStatus>;
  analyze(id: string): Promise<{ queued: boolean }>;
  start(input: WeChatObservationSelection): Promise<WeChatObservationGrant>;
  renew(id: string, input: WeChatObservationSelection): Promise<WeChatObservationGrant>;
  revoke(id: string): Promise<WeChatObservationRevocation>;
  ingest(deviceId: string, input: WeChatObservationBatch): Promise<WeChatObservationReceipt>;
  stopFromDevice(deviceId: string, input: WeChatObservationBinding): Promise<WeChatObservationStop>;
}

/** The one production runtime contract. HTTP cannot write native memory or queue records directly. */
export interface RuntimeApi {
  readonly modelConnections?: RuntimeModelCommands;
  /** The sole runtime-owned device transport; owner mutations use the commands below. */
  readonly devices?: DeviceBroker;
  readonly connectorSettings?: RuntimeConnectorCommands;
  readonly weChatObservations?: RuntimeWeChatObservationCommands;
  exportRetiredAgentWeChat?(): Promise<RetiredAgentWeChatArchive | undefined>;
  /** Complete canonical ledger/journal export; live snapshots remain bounded projections. */
  exportContextState?(): Promise<{ personalMemory: unknown; sourceReviews: unknown }>;
  listDevices?(): Promise<LocalDevice[]>;
  listDeviceOperations?(): Promise<DeviceOperation[]>;
  createDevicePairing?(): Promise<DevicePairing>;
  renameDevice?(id: string, input: { name: string }): Promise<LocalDevice>;
  revokeDevice?(id: string): Promise<{ id: string; revoked: true }>;
  start(): void;
  stop(): void | Promise<void>;
  cancel(): void | Promise<void>;
  beginShutdown(): void | Promise<void>;
  close(): void | Promise<void>;
  request(trigger: Trigger): void | Promise<void>;
  status(): AgentStatus;
  checkConnection(): Promise<{ ok: boolean; message: string; model?: string }>;
  snapshot(scope?: RuntimeViewScope): Promise<RuntimeView>;
  history(scope: RuntimeHistoryScope): Promise<RuntimeHistoryPage>;
  listCaseImages(caseId: string): Promise<ImageAttachment[]>;
  /** Invalidate the public snapshot after a committed change; this never starts inference. */
  subscribe(listener: () => void): () => void;
  listTasks(): Promise<TaskRecord[]>;
  projectTask?(id: string): Promise<(ProjectOperation & { receivedModelText?: string }) | null>;
  prepareProjectFiles?(id: string, stage?: { dependencyId: string; revision: number }): Promise<ProjectFileDelivery>;
  projectFileContent?(id: string, deliveryId: string, path?: string): Promise<{ name: string; contentType: string; bytes: Buffer }>;
  stopProjectEnvironment?(id: string): Promise<ProjectOperation>;
  getMailOperation(taskId: string): Promise<Pick<EwsMailOperation, 'id' | 'taskId' | 'state' | 'updatedAt' | 'error' | 'submittedAt' | 'attachmentCount'> | null>;
  requestTask(input: OwnerTaskRequest): Promise<TaskRecord>;
  approveTask(id: string, revision: number, ownerEventId?: string, serverResources?: ServerProjectResources, projectSelection?: ProjectRequest): Promise<TaskRecord>;
  rejectTask(id: string, revision: number, ownerEventId?: string): Promise<TaskRecord>;
  revokeTask(id: string, revision: number): Promise<TaskRecord>;
  reviseTask(id: string, revision: number, sourceEventId: string, refs?: TaskEvidenceRef[], stageReview?: 'auto' | 'owner',
    finalFiles?: TaskFinalFilesUpdate): Promise<TaskRecord>;
  answerTaskInput?(taskId: string, dependencyId: string, revision: number, answers: Record<string, string>, ownerEventId?: string): Promise<TaskRecord>;
  acceptTaskDelivery?(taskId: string, revision: number): Promise<TaskRecord>;
  listMediaModels(): Promise<MediaCatalog>;
  cancelMediaJob(id: string): Promise<MediaJob>;
  getMediaContent(id: string): Promise<{ path: string; mediaType: string; size: number; name: string }>;
  ingestOwnerMessage(content: string, caseId?: string, replyTo?: string, attachments?: ImageUpload[], reasoningEffort?: ReasoningPolicy,
    deviceId?: string, requestId?: string, files?: ChatFileUpload[]): Promise<{ payload: Record<string, unknown> }>;
  stopChatRun(id: string): Promise<{ stopped: boolean }>;
  retryEvent(id: string): Promise<{ id: string; status: string }>;
  addFeedback(input: RuntimeFeedbackInput): Promise<RuntimeFeedback>;
  addSource(input: RuntimeSourceInput): Promise<Source>;
  createCase(input: RuntimeCaseInput): Promise<RuntimeCase>;
  listCases(): Promise<RuntimeCase[]>;
  getCase(id: string): Promise<RuntimeCase | undefined>;
  getCaseDetails(id: string): Promise<CaseDetailView>;
  updateCase(id: string, patch: RuntimeCasePatch): Promise<RuntimeCase>;
  cancelCase(id: string): Promise<unknown>;
  listPersonalMemory(): Promise<PersonalMemoryEntry[]>;
  pagePersonalMemory?(input?: { offset?: number; limit?: number; subject?: PersonalMemorySubject }): Promise<PersonalMemoryPage>;
  correctPersonalMemory(key: string, input: PersonalMemoryCorrection, mutation?: PersonalMemoryMutationContext): Promise<PersonalMemoryEntry>;
  retractPersonalMemory(key: string, mutation?: PersonalMemoryMutationContext): Promise<PersonalMemoryEntry>;
  restorePersonalMemory(key: string, revision: number, mutation?: PersonalMemoryMutationContext): Promise<PersonalMemoryEntry>;
  registerWorkspaceSource(input: WorkspaceSourceInput): Promise<unknown>;
  removeWorkspaceSource(sourceId: string): Promise<unknown>;
  prepareWorkspace(input: Parameters<WorkspaceExecutor['prepare']>[0]): Promise<unknown>;
  getWorkspaceHandoff(caseId: string): Promise<unknown>;
  revokeWorkspace(caseId: string): Promise<unknown>;
}

export class RuntimeInputError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
