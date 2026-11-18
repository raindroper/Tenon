import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { projectPlanSchema, projectVerificationInputSchema, projectDeliveryProblem,
  projectDeliveryRequestSchema, projectRequirementProblem, projectCheckScope,
  type ProjectCheckEvidence, type ProjectDeliveryRequest, type ProjectRequirement, type ProjectFinalFile,
  type ProjectDelivery, type ProjectFileEvidence, type ProjectPlan, type ProjectVerificationInput, type ProjectVerification } from '../shared/project-contract.js';
import type { ProjectToolItem } from '../shared/local-project.js';
import { projectFilePathSchema } from '../shared/project-files.js';

export const legacyProjectContractTools = [
  { name: 'project_execution_evidence', description: '回查当前执行方案与本次实际操作编号、状态和检查输出，供成果验证引用。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'read_project_task_result', description: '分页读取本次委托关联的历史任务结果，作为当前任务资料。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['taskId'], additionalProperties: false } },
  { name: 'record_project_plan', description: '读取本次原话、原件及所选 Skill 后记录执行方案、依据、实际环境检查、预期文件与验收条件。替代方案保持同一目标和权限，交付改变或实质冲突用 ask_rae_owner。检查区分必需项和非阻断项。文件格式使用扩展名，如 xlsx、md。本人明确修改原条件时，criteriaOverrides 引用补充要求的 revision 和原话 quote。', inputSchema: z.toJSONSchema(projectPlanSchema) },
  { name: 'verify_project_delivery', description: '交付前验证已登记方案。客户端实际读取并校验产物。每项检查写明实际覆盖范围、校验程序来源以及本次已完成工具编号 toolIds。passed 需要成功操作证据。无法验证填 unverified，告警填 warning，必需项通过后才能完成。临时自检只能证明其实际覆盖的条件。', inputSchema: z.toJSONSchema(projectVerificationInputSchema) },
];
export const projectContractTools = [
  legacyProjectContractTools[1],
  { name: 'submit_project_delivery', description: '核对并登记本次实际成果。outputs只填实际交付文件，checks的files限定本项检查的交付文件。assertions和reportBindings.report可引用本任务工作区内的辅助验证文件，程序单独保留指纹。command.argv 是原生沙箱中的程序与参数数组，退出成功只证明该次运行。文件检查须用assertions回读文本、JSON字段或SHA256，或用reportBindings绑定报告中记录受检交付文件SHA256的字段，并另外断言该报告的检查结论。没有可执行检查时用limitation说明未验证项，必需项未通过仍不能完成。stage用于逐阶段人工审核，index/count须来自适用流程，每阶段提交后等待本人决定。普通最终交付省略stage。', inputSchema: z.toJSONSchema(projectDeliveryRequestSchema) },
];
export const planHash = (plan: ProjectPlan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

export async function projectFileEvidence(plan: Pick<ProjectPlan, 'outputs'>, workspace: string, directory: string, publishedPaths = false,
  validateRootedPath?: (path: string) => void): Promise<ProjectFileEvidence[]> {
  const roots = await Promise.all([workspace, path.join(directory, 'temporary'), path.join(directory, 'outputs')].map(root => realpath(root)));
  const files: ProjectFileEvidence[] = [];
  for (const output of plan.outputs) {
    const absolute = path.resolve(workspace, output.path);
    const actual = await realpath(absolute);
    const rootIndex = roots.findIndex(root => { const relative = path.relative(canonical(root), canonical(actual));
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); });
    if (rootIndex < 0) throw new Error('成果文件不在本任务的输出范围内。');
    if (canonical(actual) !== canonical(absolute)) throw new Error('成果路径包含目录别名或链接。');
    const publishedPath = ['workspace', 'temporary', 'outputs'][rootIndex] + '/' + path.relative(roots[rootIndex], actual).split(path.sep).join('/');
    validateRootedPath?.(publishedPath);
    const before = await lstat(actual);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('成果必须是本任务范围内的普通文件。');
    const format = output.format.toLowerCase().replace(/^\./, '');
    if (!['file', 'text', 'binary', 'executable'].includes(format)
      && path.extname(actual).slice(1).toLowerCase() !== format && path.basename(actual).toLowerCase() !== format) throw new Error('成果文件扩展名不符合方案：' + output.path);
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || canonical(await realpath(absolute)) !== canonical(absolute)) throw new Error('打开成果时文件身份已变化。');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat(); const current = await lstat(actual);
      if (before.dev !== after.dev || before.ino !== after.ino || after.ino !== current.ino || after.dev !== current.dev
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.mtimeMs !== current.mtimeMs || current.nlink !== 1
        || canonical(await realpath(absolute)) !== canonical(absolute)) throw new Error('检查期间成果文件发生变化。');
      files.push({ path: output.path, format: output.format, size: after.size, sha256: hash.digest('hex'), ...(publishedPaths ? { publishedPath } : {}) });
    } finally { await handle.close(); }
  }
  return files;
}

export function verifyProjectChecks(plan: ProjectPlan, input: ProjectVerificationInput, tools: ReadonlyMap<string, ProjectToolItem>): void {
  for (const check of input.checks) {
    if (!plan.checks.some(expected => expected.id === check.id)) throw new Error('检查不属于当前执行方案。');
    for (const id of check.toolIds) {
      const tool = tools.get(id);
      if (!tool || tool.state === 'running' || tool.type === 'dynamicToolCall') throw new Error('检查引用了未知或未结束的实际操作。');
      if (check.status === 'passed' && tool.state !== 'succeeded') throw new Error('失败的实际操作不能证明检查通过。');
    }
  }
}

export async function verifyProjectDelivery(delivery: ProjectDelivery, input: ProjectVerificationInput, tools: ReadonlyMap<string, ProjectToolItem>,
  workspace: string, directory: string): Promise<ProjectVerification> {
  verifyProjectChecks(delivery.plan, input, tools);
  const proof: ProjectVerification = { ...input, planHash: delivery.planHash, requirementsRevision: delivery.requirementsRevision,
    files: await projectFileEvidence(delivery.plan, workspace, directory), checkedAt: new Date().toISOString() };
  // Incomplete checks are durable evidence too. The completion boundary decides whether they suffice.
  return proof;
}

export async function completedDeliveryProblem(delivery: ProjectDelivery | undefined, revision: number, workspace: string, directory: string,
  finalFiles?: readonly ProjectFinalFile[]): Promise<string | undefined> {
  const problem = projectDeliveryProblem(delivery, revision, undefined, finalFiles);
  if (problem) return problem;
  const current = await projectFileEvidence(delivery!.plan, workspace, directory, delivery!.version === 2);
  if (JSON.stringify(current) !== JSON.stringify(delivery!.verification!.files)) return '验证之后文件已变化，请检查当前产物。';
  const passed = new Set(delivery!.verification!.checks.filter(check => check.status === 'passed').map(check => check.id));
  const dependencies = new Map(delivery!.evidence?.filter(check => passed.has(check.id))
    .flatMap(check => (check.dependencies ?? []).map(file => [file.path, file] as const)));
  for (const expected of dependencies.values()) {
    try {
      const current = await readDependency(expected.path, workspace, directory);
      if (sameCheckedFiles([expected], [current])) continue;
    } catch { /* A missing or out-of-scope dependency is no longer the checked input. */ }
    return '验证之后辅助文件已变化：' + expected.path;
  }
}

async function readDependency(path: string, workspace: string, directory: string): Promise<ProjectFileEvidence> {
  const [file] = await projectFileEvidence({ outputs: [{ path, format: 'file', description: '辅助验证文件' }] }, workspace, directory, true,
    rootedPath => { projectFilePathSchema.parse(rootedPath); });
  return file;
}

interface DeliveryExecution {
  revision: number;
  requirements: readonly ProjectRequirement[];
  objective: string;
  workspace: string;
  directory: string;
  previous?: ProjectDelivery;
  guard(): Promise<void>;
  command(command: NonNullable<ProjectDeliveryRequest['checks'][number]['command']>, toolId: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  desktop(check: NonNullable<ProjectDeliveryRequest['checks'][number]['desktop']>): Promise<boolean>;
  recordTool(tool: ProjectToolItem): Promise<void>;
  save(delivery: ProjectDelivery): Promise<void>;
}

/** All pass states here come from actual reads or a sandboxed command result. */
export async function executeProjectDelivery(request: ProjectDeliveryRequest, execution: DeliveryExecution): Promise<ProjectDelivery> {
  const problem = projectRequirementProblem(request, execution.requirements);
  if (problem) throw new Error(problem);
  const plan = projectPlanSchema.parse({ objective: execution.objective.slice(0, 4000),
    basis: [{ kind: 'owner', reference: '当前委托及要求引用', detail: '原话与来源由任务记录保存。' }],
    method: request.summary.slice(0, 4000), environment: [], outputs: request.outputs,
    checks: request.checks.map(check => ({ id: check.id, criterion: check.criterion, required: check.required,
      method: check.command ? check.command.argv.join(' ').slice(0, 2000) : '实际文件回读',
      basis: check.requirementIds.length ? 'owner' : 'project' })) });
  const delivery: ProjectDelivery = { version: 2, plan, planHash: planHash(plan), requirementsRevision: execution.revision,
    request, evidence: [], missing: [] };
  const scopes = request.checks.map(check => ({ check, ...projectCheckScope(request, check) }));
  const dependencyPaths = new Set(scopes.flatMap(scope => [...scope.dependencyPaths]));
  const dependencies = new Map<string, ProjectFileEvidence>();
  const dependencyProblems = new Map<string, string>();
  let files: ProjectFileEvidence[] = [];
  const refreshFiles = async () => {
    files = []; delivery.missing = [];
    for (const output of plan.outputs) {
      await execution.guard();
      try { files.push(...await projectFileEvidence({ ...plan, outputs: [output] }, execution.workspace, execution.directory, true)); }
      catch (error) { delivery.missing.push((output.path + '（' + (error instanceof Error ? error.message : '无法读取') + '）').slice(0, 4000)); }
    }
    dependencies.clear(); dependencyProblems.clear();
    const outputNames = new Set(files.map(file => canonical(file.publishedPath!)));
    for (const path of dependencyPaths) {
      await execution.guard();
      try {
        const file = await readDependency(path, execution.workspace, execution.directory);
        if (outputNames.has(canonical(file.publishedPath!))) throw new Error('请使用成果清单中的相同文件路径。');
        dependencies.set(path, file);
      } catch (error) { dependencyProblems.set(path, error instanceof Error ? error.message : '无法读取'); }
    }
  };
  const persist = async () => {
    delivery.verification = { planHash: delivery.planHash, requirementsRevision: execution.revision,
      files: [...files], ...(dependencyPaths.size ? { dependencies: [...dependencies.values()] } : {}),
      checkedAt: new Date().toISOString(), checks: request.checks.map(check => {
        const actual = delivery.evidence!.find(item => item.id === check.id);
        return { id: check.id, status: actual?.status ?? 'unverified', toolIds: actual ? [actual.toolId] : [],
          detail: actual?.detail ?? check.limitation ?? '检查尚未执行。', validator: actual?.command ? actual.command.argv.join(' ').slice(0, 4000) : '文件回读' };
      }) };
    await execution.guard(); await execution.save(structuredClone(delivery));
  };
  await refreshFiles(); await persist();
  for (const { check, selected, paths, dependencyPaths, definition } of scopes) {
    await execution.guard();
    const before = files.filter(file => selected.includes(file.path));
    const observed = files.filter(file => paths.has(file.path));
    const observedDependencies = [...dependencies.values()].filter(file => dependencyPaths.has(file.path));
    const definitionHash = createHash('sha256').update(definition).digest('hex');
    const cached = execution.previous?.requirementsRevision === execution.revision
      ? execution.previous.evidence?.find(value => value.id === check.id && value.definitionVersion === 2 && value.definitionHash === definitionHash
        && value.requirementsRevision === execution.revision
        && value.status === 'passed' && !check.command && !check.desktop && sameCheckedFiles(value.files, observed)
        && sameCheckedFiles(value.dependencies ?? [], observedDependencies)) : undefined;
    if (cached && observed.length === paths.size && observedDependencies.length === dependencyPaths.size) {
      delivery.evidence!.push(cached); await persist(); continue;
    }
    const toolId = 'check-' + randomUUID();
    const tool: ProjectToolItem = { id: toolId, type: 'projectCheck', label: check.criterion.slice(0, 500), state: 'running',
      startedAt: new Date().toISOString(), ...(check.command ? { command: check.command.argv.join(' ') } : {}) };
    const proof: ProjectCheckEvidence = { id: check.id, requirementIds: check.requirementIds, toolId, definitionHash, definitionVersion: 2,
      requirementsRevision: execution.revision, files: before, assertions: check.assertions, reportBindings: check.reportBindings,
      command: check.command, desktop: check.desktop,
      status: 'unverified', detail: check.limitation ?? '尚无实际检查。' };
    const readEvidence = (path: string): ProjectFileEvidence => {
      const target = files.find(file => file.path === path) ?? dependencies.get(path);
      if (!target) throw new Error('无法读取检查文件：' + path + '。' + (dependencyProblems.get(path) ?? ''));
      const list = dependencyPaths.has(path) ? proof.dependencies ??= [] : proof.files;
      if (!list.some(file => file.path === path)) list.push(target);
      return target;
    };
    await execution.recordTool(tool);
    try {
      if (before.length !== selected.length) throw new Error('本项所需成果尚未齐全。');
      if (check.command) {
        const result = await execution.command(check.command, toolId);
        tool.exitCode = result.exitCode; tool.output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-500000);
        if (result.exitCode !== 0) throw new Error('检查程序退出码为 ' + result.exitCode + '。');
        await refreshFiles();
      }
      if (check.desktop && !await execution.desktop(check.desktop)) throw new Error('当前版本没有符合条件的实际应用核验结果。');
      for (const assertion of check.assertions) {
        await execution.guard();
        const target = readEvidence(assertion.path);
        if (assertion.kind === 'sha256') {
          if (target.sha256 !== assertion.equals) throw new Error('SHA-256 与预期不符：' + assertion.path);
          continue;
        }
        const content = await readCheckedText(path.resolve(execution.workspace, assertion.path), target);
        if (assertion.kind === 'text') {
          if (assertion.equals !== undefined && content !== assertion.equals
            || assertion.contains !== undefined && !content.includes(assertion.contains)) throw new Error('文本内容与预期不符：' + assertion.path);
        } else {
          const value = jsonField(JSON.parse(content), assertion.key);
          if (value !== assertion.equals) throw new Error('JSON 字段与预期不符：' + assertion.path + ' / ' + assertion.key.join('.'));
        }
      }
      for (const binding of check.reportBindings) {
        await execution.guard();
        const subject = readEvidence(binding.subject), report = readEvidence(binding.report);
        const content = await readCheckedText(path.resolve(execution.workspace, report.path), report);
        if (jsonField(JSON.parse(content), binding.key) !== subject.sha256) {
          throw new Error('验证报告的受检文件指纹不匹配：' + binding.subject);
        }
      }
      await refreshFiles();
      if (before.some(file => !files.some(current => current.path === file.path && current.sha256 === file.sha256 && current.size === file.size))) {
        throw new Error('检查期间成果已变化，请对当前文件重新检查。');
      }
      if (proof.dependencies && !sameCheckedFiles(proof.dependencies,
        [...dependencies.values()].filter(file => dependencyPaths.has(file.path)))) throw new Error('检查期间辅助验证文件已变化。');
      const uncovered = selected.filter(file => !check.assertions.some(assertion => assertion.path === file)
        && !check.reportBindings.some(binding => binding.subject === file && check.assertions.some(assertion =>
          assertion.path === binding.report && assertion.kind !== 'sha256'
          && (assertion.kind !== 'json' || JSON.stringify(assertion.key) !== JSON.stringify(binding.key)))));
      if (uncovered.length) {
        proof.detail = ('以下文件仍缺直接内容断言，或绑定当前文件指纹的报告结论：' + uncovered.join('、')).slice(0, 4000);
      } else if (check.command || check.desktop || check.assertions.length) {
        proof.status = 'passed'; proof.detail = '已执行所列检查，覆盖绑定的当前文件或实际应用状态。';
      }
      tool.state = proof.status === 'passed' || check.command ? 'succeeded' : 'failed';
    } catch (error) {
      proof.status = 'failed'; proof.detail = (error instanceof Error ? error.message : '检查未通过。').slice(0, 4000);
      tool.state = 'failed';
    }
    tool.endedAt = new Date().toISOString();
    await execution.recordTool(tool);
    delivery.evidence!.push(proof); await persist();
  }
  return delivery;
}

function sameCheckedFiles(left: readonly ProjectFileEvidence[], right: readonly ProjectFileEvidence[]): boolean {
  return left.length === right.length && left.every(file => right.some(current => current.path === file.path
    && current.size === file.size && current.sha256 === file.sha256 && current.format === file.format && current.publishedPath === file.publishedPath));
}

function jsonField(value: unknown, keys: readonly (string | number)[]): unknown {
  for (const key of keys) value = value && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}

async function readCheckedText(file: string, evidence: ProjectFileEvidence): Promise<string> {
  if (evidence.size > 8 * 1024 * 1024) throw new Error('此文件超出内置文本断言范围，请使用原生校验程序检查。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('检查目标不是普通文件。');
    const data = await handle.readFile();
    if (data.length !== evidence.size || createHash('sha256').update(data).digest('hex') !== evidence.sha256) throw new Error('断言读取的文件已变化。');
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } finally { await handle.close(); }
}
