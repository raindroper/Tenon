import { z } from 'zod';
import type { TaskRecord, TaskSpec } from './task-consent.js';
import { projectFileEvidenceSchema, projectFinalFilesSchema } from './project-contract.js';
import { MAX_PROJECT_FILES } from './project-files.js';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const text = (max: number) => z.string().trim().min(1).max(max);

/** Business progress survives the process that happens to execute an operation. */
export const taskAcceptanceSchema = z.object({
  mode: z.enum(['delivery', 'owner']).default('delivery').describe('最终成果按检查结果自动交付，或交付后等待本人验收。'),
  stageReview: z.enum(['auto', 'owner']).optional().describe('Skill 的逐阶段审核方式，与最终验收 mode 分开。本次本人明确要求逐阶段人工审核时选 owner，要求自动审核时选 auto。依据完整语义判断，不按关键词路由。'),
  criteria: z.array(text(1000)).max(30).default([]),
  finalFiles: projectFinalFilesSchema.optional().describe('只为项目登记已明确的必需最终文件。每类用本人要求或明确引用的规则解释 description，填写已知的精确文件名或通常扩展名（不带点），数量多于一件时填写 count。成果细节不明确时省略，阶段脚本和中间报告不算最终文件。'),
}).strict();
export type TaskAcceptance = z.infer<typeof taskAcceptanceSchema>;
export const taskFinalFilesUpdateSchema = z.object({
  quote: text(4000).describe('本条本人消息中明确改变最终文件要求的原话。'),
  files: projectFinalFilesSchema.describe('本次改变后的完整最终文件要求，保留其他仍适用的文件；仅当本人明确取消全部文件交付时用空数组。'),
}).strict();
export type TaskFinalFilesUpdate = z.infer<typeof taskFinalFilesUpdateSchema>;

export function taskFinalFiles(task: TaskRecord) {
  const updates = task.requirementUpdates ?? [];
  for (let index = updates.length - 1; index >= 0; index--) {
    const change = updates[index].finalFiles;
    if (change) return change.files;
  }
  return task.spec.acceptance?.finalFiles;
}

export function taskStageReviewMode(task: TaskRecord): 'auto' | 'owner' {
  const updates = task.requirementUpdates ?? [];
  for (let index = updates.length - 1; index >= 0; index--) {
    const mode = updates[index].stageReview;
    if (mode) return mode;
  }
  return task.spec.acceptance?.stageReview ?? 'auto';
}

const stageFields = {
  stageId: id, index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), title: text(300),
  files: z.array(projectFileEvidenceSchema).min(1).max(MAX_PROJECT_FILES)
    .refine(files => new Set(files.map(file => file.path)).size === files.length, '阶段成果路径不能重复。'),
};
export const projectStageReviewInputSchema = z.object({ ...stageFields,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(stage => stage.index <= stage.count, '阶段序号不能超过总阶段数。');
export const projectStageReviewSchema = z.object({ ...stageFields,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(stage => stage.index <= stage.count, '阶段序号不能超过总阶段数。');
export type ProjectStageReviewInput = z.infer<typeof projectStageReviewInputSchema>;
export type ProjectStageReview = z.infer<typeof projectStageReviewSchema>;
export const projectStageApproved = '通过当前阶段';
export const projectStageRejected = '退回修改';

/** Both peers hash this canonical snapshot; a client-supplied fingerprint never creates approval. */
export function projectStageReviewContent(stage: ProjectStageReviewInput): string {
  return JSON.stringify([stage.stageId, stage.index, stage.count, stage.title,
    [...stage.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      .map(file => [file.path, file.format, file.size, file.sha256])]);
}

export const taskQuestionSchema = z.object({
  key: id, question: text(5000), blocks: text(1000),
  options: z.array(z.object({ label: text(100), description: z.string().max(1000) }).strict()).min(2).max(3).optional(),
}).strict();
export const taskWaitInputSchema = z.object({
  key: id, summary: text(2000), questions: z.array(taskQuestionSchema).min(1).max(30)
    .refine(values => new Set(values.map(value => value.key)).size === values.length, '问题标识不能重复。'),
  stageReview: projectStageReviewSchema.optional(),
}).strict();
export type TaskWaitInput = z.infer<typeof taskWaitInputSchema>;
export interface TaskAnswer {
  questionKey: string; content: string; evidenceEventIds: string[];
  actor: 'owner' | 'external'; at: string;
}
export interface TaskDependency extends TaskWaitInput {
  id: string; taskId: string; operationId: string; requirementsRevision: number;
  revision: number; state: 'waiting' | 'reviewing' | 'resolved' | 'cancelled';
  answers: TaskAnswer[]; candidateEventIds: string[]; reviewedEventIds: string[];
  researchEventIds?: string[];
  unresolved?: Record<string, string>;
  replyBindings?: Array<{ eventId: string; mailOperationId: string; questionKeys: string[] }>;
  mailOperationIds: string[]; createdAt: string; updatedAt: string;
}

export function projectStageDecision(dependency: TaskDependency): 'approved' | 'rejected' | 'pending' | 'cancelled' {
  if (dependency.state === 'cancelled') return 'cancelled';
  if (dependency.state !== 'resolved') return 'pending';
  const answer = dependency.answers.find(value => value.questionKey === 'stage-decision' && value.actor === 'owner' && value.evidenceEventIds.length);
  if (answer?.content === projectStageApproved) return 'approved';
  return answer?.content === projectStageRejected ? 'rejected' : 'pending';
}

/** Dependencies arrive in durable insertion order. Reworking a stage invalidates later approvals. */
export function latestStageReviews(dependencies: readonly TaskDependency[], operationId: string, requirementsRevision: number): TaskDependency[] {
  const latest = new Map<number, TaskDependency>();
  for (const dependency of dependencies) {
    if (!dependency.stageReview || dependency.operationId !== operationId || dependency.requirementsRevision !== requirementsRevision) continue;
    for (const index of latest.keys()) if (index >= dependency.stageReview.index) latest.delete(index);
    latest.set(dependency.stageReview.index, dependency);
  }
  return [...latest.values()].sort((left, right) => left.stageReview!.index - right.stageReview!.index);
}
export interface TaskOperationSummary {
  id: string; role: 'execution' | 'clarification' | 'review';
  spec: TaskSpec; state: TaskRecord['state']; revision: number;
  requirementsRevision: number; createdAt: string; error?: string;
  mailReceipt?: TaskRecord['mailReceipt'];
}
export interface TaskFlowView {
  phase: 'proposed' | 'running' | 'waiting_approval' | 'waiting_input' | 'reviewing' | 'awaiting_acceptance' | 'completed' | 'stopped';
  operations: TaskOperationSummary[]; dependencies: TaskDependency[];
  acceptance: TaskAcceptance; acceptedAt?: string;
}
export interface MailThreadEvidence {
  messageId: string; sender: string;
  internetMessageId?: string; inReplyTo?: string; references?: string[];
  conversationId?: string;
}
