import type { ImageAttachment } from './chat-images.js';
import type { ChatFileAttachment } from './chat-files.js';
import type { TaskOutcomeReference } from './personal-memory.js';
import type { ProductControl } from './product-control.js';
import type { RunProgress } from './run-progress.js';
import type { MeetingReminder } from './reminders.js';
import type { ModelBinding } from './model-connections.js';

export type MemoryKind = 'fact' | 'preference' | 'hypothesis' | 'experience';
export interface Message { modelBinding?: ModelBinding | null; id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; timezone?: string; runId?: string; initiativeId?: string; caseId?: string; replyTo?: string; attachments?: ImageAttachment[]; files?: ChatFileAttachment[]; reasoningEffort?: ReasoningPolicy; deviceId?: string; outputState?: 'streaming' | 'complete' | 'incomplete'; outputNote?: string; reminder?: MeetingReminder }
export interface Source { id: string; title: string; content: string; filename?: string; createdAt: string; caseId?: string }
export interface Memory { id: string; content: string; kind: MemoryKind; status: 'proposed' | 'confirmed' | 'rejected'; evidence: string[]; createdAt: string; updatedAt: string }
export type InitiativeStatus = 'exploring' | 'planned' | 'active' | 'waiting' | 'completed' | 'dismissed';
export interface Initiative { id: string; title: string; why: string; expectedValue: string; evidence: string[]; status: InitiativeStatus; nextAction: string; outcome?: string; createdAt: string; updatedAt: string }
export interface Artifact { id: string; title: string; content: string; format: 'markdown' | 'text'; initiativeId?: string; createdAt: string; caseId?: string; status?: 'prepared' | 'verified'; taskId?: string; requirementsRevision?: number }
export interface Activity { id: string; kind: 'observation' | 'decision' | 'tool' | 'result' | 'learning' | 'error' | 'wake'; title: string; detail: string; evidence: string[]; runId?: string; createdAt: string }
export interface Feedback { id: string; targetType: 'message' | 'case' | 'initiative' | 'artifact' | 'memory'; targetId: string; verdict: 'useful' | 'off_target' | 'correction' | 'not_now'; comment: string; createdAt: string; caseId?: string; targetContent?: string; targetVersion?: string; taskOutcome?: TaskOutcomeReference }
export type Trigger = 'chat' | 'timer' | 'feedback' | 'source' | 'manual' | 'recovery';
export interface FailureDiagnostic {
  category: 'source_unavailable' | 'model_api' | 'transport' | 'unknown';
  errorName?: string; code?: string; httpStatus?: number; location?: { file: string; line: number };
}
export type UsageStatus = 'reported' | 'partial' | 'unknown';
/** A native-only run has no provider usage to report. Legacy missing usage remains unknown. */
export type RunUsageStatus = UsageStatus | 'not_used';
export type ReasoningEffort = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'ultra';
export const REASONING_POLICIES = ['auto', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh', 'ultra'] as const;
export type ReasoningPolicy = typeof REASONING_POLICIES[number];
/** Requested parameters, never a claim that the upstream honored them or that the answer is correct. */
export interface RunReasoning { policy: ReasoningPolicy; effort: ReasoningEffort; reason: string; policyVersion: 1; source?: 'message' | 'settings' | 'scene' | 'background' | 'global' | 'explicit' }
export interface TokenUsage { inputTokens: number; outputTokens: number; usageStatus: UsageStatus }
export interface Run { modelBinding?: ModelBinding | null; id: string; trigger: Trigger; status: 'running' | 'completed' | 'failed' | 'interrupted'; startedAt: string; endedAt?: string; steps: number; inputTokens: number; outputTokens: number; error?: string; stopReason?: 'output_limit' | 'step_limit' | 'no_progress' | 'owner_stopped'; reviewOutcome?: 'complete' | 'needs_input'; continuations?: number; toolCallsStarted?: number; usageStatus?: RunUsageStatus; pendingModelCalls?: number; caseId?: string; eventId?: string; taskId?: string; mode?: 'growth' | 'execution' | 'connection'; reasoning?: RunReasoning;
  taskExecution?: { requirementsRevision: number; deadline: number | null; stepLimit: number | null; modelStarted?: true; modelFinished?: true;
    pausedBeforeProgress?: true; projectPaused?: true; recoveryReceiptHash?: string; ownerInputEventIds?: string[] };
  /** Recording intent for the immutable result evidence, not an independent task state. */
  taskOutcomeEventId?: string;
  /** Sanitized cause information; never provider bodies, credentials, or private paths. */
  failureDiagnostic?: FailureDiagnostic;
  /** Compact display projection; native messages and receipts remain the facts. */
  progress?: RunProgress;
  /** Actual source events returned by tools, kept for later result/learning revocation checks. */
  evidenceEventIds?: string[];
  reviewDecisionId?: string;
  /** One passive review budget survives interruption and explicit retry. */
  reviewBudget?: { deadline: number; stepLimit: number; usedSteps: number };
  /** Exact selected versions and program-computed clock; no prompt bodies or hidden reasoning. */
  contextManifest?: { policyVersion: 1 | 2 | 3; memories: Array<{ key: string; revision: number; subject: 'owner' | 'agent'; purpose: string }>;
    omittedCount: number; role?: 'actor' | 'observer' | 'reflector'; recentOwner?: { fingerprint: string; messageIds: string[]; eventIds: string[] }; time?: import('./time.js').TemporalContext };
  /** Per-dispatch diagnostic history, exported explicitly rather than copied into live snapshots. */
  contextManifests?: NonNullable<Run['contextManifest']>[];
  productControl?: ProductControl;
  deviceResolution?: { operationId: string; resolvedAt: string; previousStatus: Run['status']; previousError?: string; previousEndedAt?: string } }
export interface Settings { agentName: string; ownerName: string; mission: string; model: string; apiBaseUrl: string; apiKeyConfigured: boolean; enabled: boolean; enabledRevision?: number; reasoningEffort: ReasoningPolicy; maxOutputTokens: number | null; maxOutputContinuations: number; maxStepsPerRun: number; timezone: string }
export type SettingsInput = Partial<Omit<Settings, 'apiKeyConfigured' | 'enabledRevision'>> & { apiKey?: string; clearApiKey?: boolean };
export interface AgentStatus { state: 'needs_setup' | 'paused' | 'idle' | 'working' | 'error'; nextWakeAt: string | null; lastRunAt: string | null; lastError: string | null; todayUsage: TokenUsage; pending: boolean }
