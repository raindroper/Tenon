import { z } from 'zod';
import { REASONING_POLICIES, type ReasoningPolicy } from './types.js';
import { taskDevicePathSchema } from './local-device.js';
import { modelContextWindowSchema } from './model-connections.js';
import { projectFilesRequestSchema, type ProjectFilesRequest, type ProjectFileDelivery } from './project-files.js';
import { projectPlanSchema, projectVerificationSchema, projectDeliverySchema, projectExecutionContractSchema,
  type ProjectDelivery, type ProjectExecutionContract } from './project-contract.js';

export const legacyLocalProjectCapability = 'local_project_codex_v1';
export const previousLocalProjectCapability = 'local_project_codex_v2';
export const localProjectCapability = 'local_project_codex_v4';
export const projectContextWindowCapability = 'local_project_context_window_v1';
export const windowsDesktopCapability = 'windows_desktop_cua_v1';
export const windowsDesktopApplications = ['notepad', 'clash-verge'] as const;
export const windowsDesktopScopeSchema = z.object({ applications: z.array(z.enum(windowsDesktopApplications)).min(1)
  .max(windowsDesktopApplications.length).refine(apps => new Set(apps).size === apps.length, 'Windows 应用不能重复。') }).strict();
export const projectOwnerQuestionSchema = z.object({ questions: z.array(z.object({
  id: z.string().min(1).max(200), header: z.string().min(1).max(12),
  question: z.string().min(1).max(5000),
  options: z.array(z.object({ label: z.string().min(1).max(100), description: z.string().max(1000) }).strict()).min(2).max(3).optional(),
}).strict()).min(1).max(3) }).strict();
const identifier = z.string().min(1).max(200);
const revision = z.number().int().positive();
export const linuxProjectPathSchema = z.string().min(2).max(4000).refine(value =>
  value.startsWith('/') && value.slice(1).split('/').every(part => part && part !== '.' && part !== '..') && !/[\u0000-\u001f]/.test(value),
'须使用规范的 Linux 绝对路径。');
export const projectPathSchema = z.union([taskDevicePathSchema, linuxProjectPathSchema]);

export const serverProjectResourceSchema = z.object({
  cpuMillis: z.number().int().positive(), memoryMiB: z.number().int().positive(), diskMiB: z.number().int().positive(),
  maxProcesses: z.number().int().positive(), workspaceRetention: z.literal('until-task-ends'), network: z.enum(['public', 'none']),
  workspaceStorage: z.literal('persistent').optional(), checkpointMiB: z.number().int().positive().optional(),
}).strict();
export type ServerProjectResources = z.infer<typeof serverProjectResourceSchema>;
export function serverProjectResources(network: boolean): ServerProjectResources {
  return { cpuMillis: 500, memoryMiB: 768, diskMiB: 256, maxProcesses: 128,
    workspaceRetention: 'until-task-ends', network: network ? 'public' : 'none', workspaceStorage: 'persistent', checkpointMiB: 512 };
}
export function expectedServerProjectResources(network: boolean, existing: ServerProjectResources): ServerProjectResources {
  const current = serverProjectResources(network);
  if (existing.workspaceStorage === 'persistent') return current;
  const { workspaceStorage: _storage, checkpointMiB: _checkpoint, ...legacy } = current;
  return legacy;
}

/** The owner authorizes a project and an objective. Tools are selected during execution. */
export const projectRootSchema = z.union([taskDevicePathSchema, z.literal('task-temporary')]);
export const projectRequestSchema = z.object({
  deviceId: identifier,
  root: projectRootSchema.optional().describe('已有项目须给真实目录；缺少时询问或沿用已确认的位置。独立临时任务才明确填写task-temporary。'),
  access: z.enum(['read-only', 'read-write']).default('read-write').describe('默认读写工作区，以支持测试和依赖等普通步骤。仅在本人明确限定只读时收窄；验收目标本身不等于另加只读权限限制。'),
  readAccess: z.enum(['device', 'project']).default('device').describe('默认允许为任务读取本机文件与依赖。仅在本人明确限定读取范围为所选项目时使用project，不因任务是验收而自行收窄。'),
  network: z.boolean().default(true),
  create: z.boolean().default(false),
  desktop: windowsDesktopScopeSchema.optional().describe('仅用于本人明确要求操作这些 Windows 应用。notepad 只操作本任务新开的测试文档及另存为；clash-verge 只查看首页和日志及截图。只登记本人本次指定的应用。'),
  returnScreenshots: z.literal(true).optional().describe('本人本次要求回传截图、页面截图或图片证据时填写 true。'),
}).strict();
export type ProjectRequest = z.infer<typeof projectRequestSchema>;
// Saved scopes and historical wire records keep their original default; new requests are resolved before admission.
export const localProjectSpecSchema = projectRequestSchema.extend({ root: projectRootSchema.default('task-temporary'), serverResources: serverProjectResourceSchema.optional() });
export type LocalProjectSpec = z.infer<typeof localProjectSpecSchema>;

export interface ProjectModelSettings {
  model: string;
  reasoningEffort: ReasoningPolicy;
  maxOutputTokens: number | null;
  contextWindow?: number;
}
export interface ProjectExecutionInput {
  operationId: string;
  taskId: string;
  runId: string;
  approvalRevision: number;
  requirementsRevision: number;
  spec: LocalProjectSpec;
  specHash: string;
  title: string;
  objective: string;
  expectedOutput: string;
  ownerRequest: string;
  updates: Array<{ revision: number; content: string }>;
  model: ProjectModelSettings;
  stepLimit: number | null;
  deadline: number | null;
  issuedAt: string;
  retainWorkspace?: true;
  deliverFiles?: true;
  contract?: ProjectExecutionContract;
}
export type ProjectState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export const projectExecutionInputSchema = z.object({
  operationId: identifier, taskId: identifier, runId: identifier, approvalRevision: revision, requirementsRevision: revision,
  spec: localProjectSpecSchema, specHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(200), objective: z.string().min(1).max(8000), expectedOutput: z.string().min(1).max(2000),
  ownerRequest: z.string().max(20000), updates: z.array(z.object({ revision, content: z.string().max(20000) }).strict()),
  model: z.object({ model: z.string().min(1).max(200), reasoningEffort: z.enum(REASONING_POLICIES),
    maxOutputTokens: z.number().int().positive().nullable(), contextWindow: modelContextWindowSchema.optional() }).strict(),
  stepLimit: z.number().int().nonnegative().nullable(), deadline: z.number().int().nonnegative().nullable(), issuedAt: z.string().datetime(),
  retainWorkspace: z.literal(true).optional(),
  deliverFiles: z.literal(true).optional(),
  contract: projectExecutionContractSchema.optional(),
}).strict();
export type ProjectToolState = 'running' | 'succeeded' | 'failed' | 'interrupted';
export interface ProjectToolItem {
  id: string;
  type: string;
  label: string;
  state: ProjectToolState;
  command?: string;
  output?: string;
  exitCode?: number;
  startedAt?: string;
  endedAt?: string;
  threadId?: string;
  processId?: string;
}
export interface ProjectInteraction {
  id: string;
  kind: 'approval' | 'question';
  method: string;
  title: string;
  detail: string;
  /** Exact native request, retained so an answer cannot approve a different operation. */
  request: Record<string, unknown>;
  state: 'pending' | 'answered' | 'cancelled';
  createdAt: string;
  answer?: Record<string, unknown>;
  answeredAt?: string;
}
export interface ProjectWorkspace {
  id: string;
  deviceId: string;
  root: string;
  realPath: string;
  identity: string;
  lastTaskId: string;
  updatedAt: string;
  temporary?: boolean;
}
export interface ProjectOperation {
  input: ProjectExecutionInput;
  state: ProjectState;
  sequence: number;
  modelCalls: number;
  threadId?: string;
  turnId?: string;
  engineVersion?: string;
  workspace?: ProjectWorkspace;
  workspaceReserved?: boolean;
  output: string;
  finalOutput?: string;
  tools: ProjectToolItem[];
  diff?: string;
  previews: Array<{ url: string; title?: string }>;
  interactions: ProjectInteraction[];
  environment?: { state: 'active' | 'closed' | 'unknown'; retainedWorkspace?: true;
    terminals: Array<{ threadId: string; processId: string; command: string; cwd: string }> };
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  checkpoint?: { hash: string; identity: string };
  files?: ProjectFileDelivery;
  delivery?: ProjectDelivery;
  toolCounts?: { total: number; failed: number; running: number };
  activity?: { kind: string; at: string };
  modelTransport?: { requestId: string; state: 'receiving' | 'received'; responseId?: string; bytes: number; at: string };
}

const toolItemSchema = z.object({
  id: identifier, type: z.string().min(1).max(100), label: z.string().min(1).max(500),
  state: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  command: z.string().max(100000).optional(), output: z.string().max(500000).optional(),
  exitCode: z.number().int().optional(), startedAt: z.string().datetime().optional(), endedAt: z.string().datetime().optional(),
  threadId: identifier.optional(), processId: identifier.optional(),
}).strict();
export const projectEventSchema = z.object({
  operationId: identifier,
  sequence: z.number().int().positive(),
  requirementsRevision: revision,
  at: z.string().datetime(),
  event: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('delivery'), delivery: projectDeliverySchema }).strict(),
    z.object({ kind: z.literal('plan'), plan: projectPlanSchema, planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ kind: z.literal('verification'), verification: projectVerificationSchema }).strict(),
    z.object({ kind: z.literal('model_transport'), requestId: identifier, state: z.enum(['receiving', 'received']),
      responseId: identifier.optional(), bytes: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal('started'), threadId: identifier, engineVersion: z.string().max(100),
      realPath: projectPathSchema, identity: z.string().min(1).max(1000) }).strict(),
    z.object({ kind: z.literal('turn'), turnId: identifier }).strict(),
    z.object({ kind: z.literal('text'), text: z.string().max(250000) }).strict(),
    z.object({ kind: z.literal('tool'), item: toolItemSchema }).strict(),
    z.object({ kind: z.literal('diff'), diff: z.string().max(1000000) }).strict(),
    z.object({ kind: z.literal('preview'), url: z.string().url().max(4000), title: z.string().max(200).optional() }).strict(),
    z.object({ kind: z.literal('paused'), reason: z.string().max(4000) }).strict(),
    z.object({ kind: z.literal('workspace_saved'), hash: z.string().regex(/^[a-f0-9]{64}$/), identity: z.string().min(1).max(1000) }).strict(),
    z.object({ kind: z.literal('workspace_restored'), hash: z.string().regex(/^[a-f0-9]{64}$/), previousIdentity: z.string().min(1).max(1000),
      realPath: projectPathSchema, identity: z.string().min(1).max(1000) }).strict(),
    z.object({ kind: z.literal('environment'), state: z.enum(['active', 'closed', 'unknown']), retainedWorkspace: z.literal(true).optional(),
      terminals: z.array(z.object({ threadId: identifier, processId: identifier, command: z.string().max(100000), cwd: z.string().max(4000) }).strict()).max(200) }).strict(),
    z.object({ kind: z.literal('interaction'), id: identifier, type: z.enum(['approval', 'question']),
      method: z.string().min(1).max(200), title: z.string().min(1).max(300), detail: z.string().max(100000), request: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ kind: z.literal('finished'), state: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
      output: z.string().max(1000000), error: z.string().max(4000).optional() }).strict(),
  ]),
}).strict();
export type ProjectEvent = z.infer<typeof projectEventSchema>;

export const projectGuardSchema = z.object({ operationId: identifier, specHash: z.string().regex(/^[a-f0-9]{64}$/), requirementsRevision: revision }).strict();
export type ProjectGuardInput = z.infer<typeof projectGuardSchema>;

export type ProjectServerMessage =
  | ProjectFilesRequest
  | { kind: 'project-execute'; operationId: string; input: ProjectExecutionInput }
  | { kind: 'project-steer'; operationId: string; requirementsRevision: number; runId: string; updates: ProjectExecutionInput['updates']; contract?: ProjectExecutionContract }
  | { kind: 'project-cancel'; operationId: string; reason: string; mode?: 'pause' | 'cancel' };

export function isLocalPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export const projectServerMessageSchema = z.discriminatedUnion('kind', [
  projectFilesRequestSchema,
  z.object({ kind: z.literal('project-execute'), operationId: identifier, input: projectExecutionInputSchema }).strict(),
  z.object({ kind: z.literal('project-steer'), operationId: identifier, requirementsRevision: revision, runId: identifier,
    updates: z.array(z.object({ revision, content: z.string().max(20000) }).strict()), contract: projectExecutionContractSchema.optional() }).strict(),
  z.object({ kind: z.literal('project-cancel'), operationId: identifier, reason: z.string().max(4000), mode: z.enum(['pause', 'cancel']).optional() }).strict(),
]);
