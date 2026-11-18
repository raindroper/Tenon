import { z } from 'zod';
import { MAX_PROJECT_FILES } from './project-files.js';

export const projectContractCapability = 'local_project_contract_v1';
export const projectContractV2Capability = 'local_project_contract_v2_1';
const text = (max: number) => z.string().trim().min(1).max(max);
const id = text(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const projectRequirementSchema = z.object({ id, text: text(20000), revision: z.number().int().positive(),
  sourceEventId: id.optional() }).strict();
export type ProjectRequirement = z.infer<typeof projectRequirementSchema>;

function filenameExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export const projectFinalFileSchema = z.object({
  description: text(1000),
  filename: text(240).regex(/^[^<>:"/\\|?*\x00-\x1f]+$/).refine(value => !/[. ]$/.test(value)).optional(),
  format: text(40).regex(/^[a-z0-9][a-z0-9_+-]*$/i).optional(),
  count: z.number().int().positive().max(MAX_PROJECT_FILES).optional(),
}).strict().refine(value => value.filename !== undefined || value.format !== undefined, '最终文件须有确定的文件名或扩展名。')
  .refine(value => value.filename === undefined || value.format === undefined || filenameExtension(value.filename) === value.format.toLowerCase(),
    { path: ['format'], message: '最终文件名与扩展名不一致。' });
export type ProjectFinalFile = z.infer<typeof projectFinalFileSchema>;
export const projectFinalFilesSchema = z.array(projectFinalFileSchema).max(30)
  .refine(values => values.reduce((count, file) => count + (file.count ?? 1), 0) <= MAX_PROJECT_FILES, '必需最终文件数超出成果上限。');
export const projectExecutionContractSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), criteria: z.array(z.string().max(1000)).max(30) }).strict(),
  z.object({ version: z.literal(2), requirements: z.array(projectRequirementSchema), reviewMode: z.enum(['auto', 'owner']).optional(),
    finalFiles: projectFinalFilesSchema.optional() }).strict(),
]);
export type ProjectExecutionContract = z.infer<typeof projectExecutionContractSchema>;
export const projectInputFileSchema = z.object({
  id, messageId: id, name: text(240), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ProjectInputFile = z.infer<typeof projectInputFileSchema>;

/** An execution plan is an interpretation of the original consent, never new consent. */
export const projectPlanSchema = z.object({
  objective: text(4000),
  basis: z.array(z.object({ kind: z.enum(['owner', 'skill', 'project', 'assumption']), reference: text(4000), detail: text(4000),
    toolIds: z.array(id).max(30).optional() }).strict()).min(1).max(30),
  method: text(4000),
  environment: z.array(z.object({ requirement: text(1000), result: text(2000), toolIds: z.array(id).max(30) }).strict()).max(30),
  alternativeReason: text(4000).optional(),
  criteriaOverrides: z.array(z.object({ criterion: text(1000), revision: z.number().int().positive(), quote: text(2000), reason: text(2000) }).strict()).max(30).optional(),
  outputs: z.array(z.object({ path: text(4000), format: text(100), description: text(2000) }).strict()).max(MAX_PROJECT_FILES),
  checks: z.array(z.object({ id, criterion: text(2000), required: z.boolean(), method: text(2000),
    basis: z.enum(['owner', 'skill', 'project', 'assumption']) }).strict()).min(1),
}).strict().refine(value => new Set(value.checks.map(check => check.id)).size === value.checks.length, '检查编号不能重复。')
  .refine(value => value.checks.some(check => check.required), '执行方案须包含对交付目标的必需检查。')
  .refine(value => new Set(value.outputs.map(output => output.path)).size === value.outputs.length, '产物路径不能重复。');
export type ProjectPlan = z.infer<typeof projectPlanSchema>;
export const projectVerificationInputSchema = z.object({
  checks: z.array(z.object({ id, status: z.enum(['passed', 'warning', 'failed', 'unverified']),
    toolIds: z.array(id).max(50), detail: text(4000), validator: text(4000) }).strict()),
}).strict();
export type ProjectVerificationInput = z.infer<typeof projectVerificationInputSchema>;
export const projectFileEvidenceSchema = z.object({ path: text(4000), size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), format: text(100), publishedPath: text(4000).optional() }).strict();
export type ProjectFileEvidence = z.infer<typeof projectFileEvidenceSchema>;
export const projectVerificationSchema = z.object({
  planHash: z.string().regex(/^[a-f0-9]{64}$/), requirementsRevision: z.number().int().positive(),
  files: z.array(projectFileEvidenceSchema).max(MAX_PROJECT_FILES), checks: projectVerificationInputSchema.shape.checks,
  dependencies: z.array(projectFileEvidenceSchema).max(MAX_PROJECT_FILES).optional(),
  checkedAt: z.string().datetime(),
}).strict();
export type ProjectVerification = z.infer<typeof projectVerificationSchema>;
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const projectAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), path: text(4000), equals: z.string().max(100000).optional(), contains: text(100000).optional() }).strict()
    .refine(value => value.equals !== undefined || value.contains !== undefined, '文本检查须给出预期内容。'),
  z.object({ kind: z.literal('json'), path: text(4000), key: z.array(z.union([text(200), z.number().int().nonnegative()])).max(30), equals: scalar }).strict(),
  z.object({ kind: z.literal('sha256'), path: text(4000), equals: hash }).strict(),
]);
export const projectCheckCommandSchema = z.object({ argv: z.array(text(100000)).min(1).max(200), cwd: text(4000).optional(),
  timeoutMs: z.number().int().positive().max(2147480000).optional() }).strict();
export type ProjectCheckCommand = z.infer<typeof projectCheckCommandSchema>;
export const projectDesktopCheckSchema = z.object({ key: text(200), equals: scalar }).strict();
export const projectReportBindingSchema = z.object({ subject: text(4000), report: text(4000),
  key: z.array(z.union([text(200), z.number().int().nonnegative()])).min(1).max(30),
}).strict();
export const projectDeliveryRequestSchema = z.object({
  summary: text(8000),
  outputs: projectPlanSchema.shape.outputs,
  checks: z.array(z.object({ id, requirementIds: z.array(id).default([]), criterion: text(2000),
    required: z.boolean().default(true), command: projectCheckCommandSchema.optional(),
    desktop: projectDesktopCheckSchema.optional(),
    files: z.array(text(4000)).max(MAX_PROJECT_FILES).default([]),
    assertions: z.array(projectAssertionSchema).max(100).default([]),
    reportBindings: z.array(projectReportBindingSchema).max(MAX_PROJECT_FILES).default([]),
    limitation: text(4000).optional(),
  }).strict()).min(1),
  supersededRequirements: z.array(z.object({ id, revision: z.number().int().positive() }).strict()).default([]),
  stage: z.object({ id, index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), title: text(300) }).strict()
    .refine(value => value.index <= value.count, '阶段序号超过阶段总数。').optional(),
}).strict().refine(value => new Set(value.checks.map(check => check.id)).size === value.checks.length, '检查编号不能重复。')
  .refine(value => new Set(value.outputs.map(output => output.path)).size === value.outputs.length, '产物路径不能重复。');
export type ProjectDeliveryRequest = z.infer<typeof projectDeliveryRequestSchema>;
export function projectCheckScope(request: ProjectDeliveryRequest, check: ProjectDeliveryRequest['checks'][number]) {
  const selected = check.files.length ? check.files : request.outputs.map(output => output.path);
  const outputPaths = new Set(request.outputs.map(output => output.path));
  const referenced = [...check.assertions.map(assertion => assertion.path), ...check.reportBindings.map(binding => binding.report)];
  const paths = new Set([...selected, ...referenced.filter(path => outputPaths.has(path)), ...check.reportBindings.map(binding => binding.subject)]);
  const dependencyPaths = new Set(referenced.filter(path => !outputPaths.has(path)));
  const outputs = request.outputs.filter(output => check.command || check.desktop || paths.has(output.path))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { selected, paths, dependencyPaths, definition: JSON.stringify({ version: 2, outputs, check }) };
}

export const projectCheckEvidenceSchema = z.object({
  id, requirementIds: z.array(id), toolId: id,
  definitionHash: hash, definitionVersion: z.literal(2).optional(), requirementsRevision: z.number().int().positive(),
  files: z.array(projectFileEvidenceSchema).max(MAX_PROJECT_FILES),
  dependencies: z.array(projectFileEvidenceSchema).max(MAX_PROJECT_FILES).optional(),
  command: projectCheckCommandSchema.optional(),
  desktop: projectDesktopCheckSchema.optional(),
  assertions: z.array(projectAssertionSchema).max(100),
  reportBindings: z.array(projectReportBindingSchema).max(MAX_PROJECT_FILES).default([]),
  status: z.enum(['passed', 'failed', 'unverified']), detail: text(4000),
}).strict();
export type ProjectCheckEvidence = z.infer<typeof projectCheckEvidenceSchema>;
export interface ProjectDelivery {
  version?: 2;
  plan: ProjectPlan;
  planHash: string;
  requirementsRevision: number;
  verification?: ProjectVerification;
  request?: ProjectDeliveryRequest;
  evidence?: ProjectCheckEvidence[];
  missing?: string[];
}
export const projectDeliverySchema = z.object({ version: z.literal(2), plan: projectPlanSchema, planHash: hash,
  requirementsRevision: z.number().int().positive(), verification: projectVerificationSchema.optional(),
  request: projectDeliveryRequestSchema, evidence: z.array(projectCheckEvidenceSchema),
  missing: z.array(text(4000)).max(MAX_PROJECT_FILES) }).strict();

export function projectRequirementProblem(request: ProjectDeliveryRequest, requirements: readonly ProjectRequirement[]): string | undefined {
  const outputPaths = new Set(request.outputs.map(output => output.path));
  const dependencies = new Set<string>();
  for (const check of request.checks) {
    if (check.files.some(path => !outputPaths.has(path)) || check.reportBindings.some(binding => !outputPaths.has(binding.subject))) {
      return '检查的交付文件与报告受检对象须列在成果清单中：' + check.id;
    }
    for (const assertion of check.assertions) if (!outputPaths.has(assertion.path)) dependencies.add(assertion.path);
    for (const binding of check.reportBindings) if (!outputPaths.has(binding.report)) dependencies.add(binding.report);
  }
  if (dependencies.size > MAX_PROJECT_FILES) return '检查所引用的验证文件过多。';
  for (const change of request.supersededRequirements) {
    const original = requirements.find(value => value.id === change.id);
    if (!original || !requirements.some(value => value.revision === change.revision && value.revision > original.revision && value.sourceEventId)) {
      return '条件替换须引用本人真实补充要求的版本：' + change.id;
    }
  }
  for (const check of request.checks) for (const ref of check.requirementIds) {
    if (!requirements.some(value => value.id === ref)) return '检查引用了不属于本任务的条件：' + ref;
  }
  if (request.stage) return;
  for (const requirement of requirements) {
    if (!request.supersededRequirements.some(value => value.id === requirement.id)
      && !request.checks.some(check => check.required && check.requirementIds.includes(requirement.id))) return '缺少必需条件的检查：' + requirement.id;
  }
}

export function projectPlanProblem(plan: ProjectPlan, criteria: readonly string[], updates: readonly { revision: number; content: string }[]): string | undefined {
  for (const override of plan.criteriaOverrides ?? []) {
    if (!criteria.includes(override.criterion) || !updates.some(update => update.revision === override.revision && update.content.includes(override.quote))) {
      return '条件变更须引用本人实际补充要求的版本与原话。';
    }
  }
  for (const criterion of criteria) {
    if (!plan.checks.some(check => check.required && check.basis === 'owner' && check.criterion === criterion)
      && !plan.criteriaOverrides?.some(override => override.criterion === criterion)) return '方案须保留本人明确的必需验收条件：' + criterion;
  }
}

export function projectFinalFilesProblem(delivery: ProjectDelivery | undefined, finalFiles?: readonly ProjectFinalFile[]): string | undefined {
  if (!finalFiles?.length || delivery?.request?.stage) return;
  const current = delivery?.verification;
  const verified = new Map<string, ProjectFileEvidence>();
  const required = new Set(delivery?.plan.checks.filter(check => check.required).map(check => check.id));
  const proofFiles = new Map(current?.files.map(file => [file.path, file]));
  for (const result of current?.checks ?? []) {
    if (result.status !== 'passed' || !required.has(result.id)) continue;
    const check = delivery?.evidence?.find(evidence => evidence.id === result.id);
    if (!check || check.status !== 'passed' || check.requirementsRevision !== current?.requirementsRevision
      || result.toolIds.length !== 1 || check.toolId !== result.toolIds[0]) continue;
    const subjects = new Set(check.assertions.map(assertion => assertion.path));
    for (const binding of check.reportBindings) {
      if (check.assertions.some(assertion => assertion.path === binding.report && assertion.kind !== 'sha256'
        && (assertion.kind !== 'json' || JSON.stringify(assertion.key) !== JSON.stringify(binding.key)))) subjects.add(binding.subject);
    }
    for (const file of check.files) {
      const actual = proofFiles.get(file.path);
      if (actual?.publishedPath && subjects.has(file.path) && actual.publishedPath === file.publishedPath
        && actual.size === file.size && actual.sha256 === file.sha256) verified.set(actual.publishedPath, actual);
    }
  }
  // Match named requirements first. Each verified file may satisfy only one required slot.
  const selectors = [...finalFiles].sort((a, b) => Number(Boolean(b.filename)) - Number(Boolean(a.filename)));
  for (const selector of selectors) {
    let missing = selector.count ?? 1;
    for (const publishedPath of verified.keys()) {
      const filename = publishedPath.split('/').at(-1)!;
      if (selector.filename !== undefined && selector.filename !== filename
        || selector.format !== undefined && selector.format.toLowerCase() !== filenameExtension(filename)) continue;
      verified.delete(publishedPath);
      if (--missing === 0) break;
    }
    if (missing) return '缺少当前已通过检查的必需最终文件：' + selector.description;
  }
}

export function projectDeliveryProblem(delivery: ProjectDelivery | undefined, revision: number,
  publishedFiles?: readonly { path?: string; size: number; sha256: string }[], finalFiles?: readonly ProjectFinalFile[]): string | undefined {
  if (!delivery || delivery.requirementsRevision !== revision) return '缺少当前要求版本的执行方案。';
  if (delivery.request?.stage) return '当前记录是阶段产物，最终成果尚待汇总交付。';
  if (delivery.missing?.length) return '仍缺少成果：' + delivery.missing.join('、');
  const proof = delivery.verification;
  if (!proof || proof.planHash !== delivery.planHash || proof.requirementsRevision !== revision) return '当前成果尚无匹配的检查回执。';
  if (delivery.plan.outputs.length !== proof.files.length || delivery.plan.outputs.some(output =>
    !proof.files.some(file => file.path === output.path && file.format === output.format))) return '实际文件与执行方案不匹配。';
  if (publishedFiles) {
    const unmatched = [...publishedFiles];
    for (const file of proof.files) {
      const index = unmatched.findIndex(saved => saved.sha256 === file.sha256 && saved.size === file.size
        && (delivery.version !== 2 || file.publishedPath !== undefined && saved.path === file.publishedPath));
      if (index < 0) return '已保存成果与实际通过检查的文件不一致：' + file.path;
      unmatched.splice(index, 1);
    }
  }
  if (new Set(proof.checks.map(check => check.id)).size !== proof.checks.length
    || proof.checks.length !== delivery.plan.checks.length) return '检查回执与验收条件不匹配。';
  for (const check of delivery.plan.checks) {
    const result = proof.checks.find(value => value.id === check.id);
    if (!result || check.required && result.status !== 'passed') return '必需检查未通过：' + check.criterion;
    if (result.status === 'passed' && !result.toolIds.length) return '通过结论缺少实际操作回执：' + check.criterion;
    if (delivery.version === 2 && result.status === 'passed') {
      const evidence = delivery.evidence?.find(value => value.id === check.id);
      if (!evidence || evidence.requirementsRevision !== revision || evidence.status !== 'passed'
        || result.toolIds.length !== 1 || result.toolIds[0] !== evidence.toolId
        || evidence.files.some(file => !proof.files.some(current =>
          current.path === file.path && current.sha256 === file.sha256 && current.size === file.size))
        || evidence.dependencies?.some(file => !proof.dependencies?.some(current => current.path === file.path && current.sha256 === file.sha256
          && current.size === file.size && current.publishedPath === file.publishedPath))) return '检查缺少当前成果的实际验证记录：' + check.criterion;
    }
  }
  return projectFinalFilesProblem(delivery, finalFiles);
}
