import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { feedbackVersion } from '../server/feedback-version.js';
import { taskOutcomeEvidenceSchema, taskOutcomeReferenceSchema, type TaskOutcomeEvidence } from '../shared/personal-memory.js';

const id = z.string().min(1);
const date = z.iso.datetime({ offset: true });
const verdict = z.enum(['useful', 'off_target', 'correction', 'not_now']);
const identified = z.object({ id }).passthrough();
const feedbackSchema = z.object({
  id, targetType: z.enum(['message', 'artifact']), targetId: id, caseId: id, verdict, createdAt: date,
  targetContent: z.string(), targetVersion: z.string().optional(), taskOutcome: taskOutcomeReferenceSchema.optional(),
});
const targetSchema = z.object({
  id, caseId: id, content: z.string(), createdAt: date, runId: id.optional(), replyTo: id.optional(),
  role: z.string().optional(), outputState: z.string().optional(), taskId: id.optional(), requirementsRevision: z.number().optional(),
});
const runSchema = z.object({
  id, caseId: id, eventId: id, startedAt: date, endedAt: date, status: z.literal('completed'),
  trigger: z.string(), taskId: id.optional(), taskOutcomeEventId: id.optional(),
  taskExecution: z.object({ requirementsRevision: z.number().int().positive() }).optional(),
  inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  usageStatus: z.enum(['reported', 'partial', 'unknown', 'not_used']).optional(), pendingModelCalls: z.number().optional(),
});
const dispatchSchema = z.object({
  runId: id,
  contexts: z.array(z.object({ role: z.string().optional(), memories: z.array(z.object({
    key: id, revision: z.number().int().positive(), subject: z.enum(['owner', 'agent']),
  })) })),
});
const exportSchema = z.object({
  version: z.literal(3), runtime: z.literal('mastra'), feedback: z.array(identified), messages: z.array(identified),
  artifacts: z.array(identified), runs: z.array(identified), events: z.array(identified),
  contextState: z.object({
    dispatchContexts: z.array(dispatchSchema),
    taskOutcomes: z.array(z.unknown()).optional(),
    personalMemory: z.object({ versions: z.array(z.unknown()) }).optional(),
  }),
});
const ledgerVersionSchema = z.object({ fact: z.object({ personal: z.object({
  evidence: z.array(z.object({ taskOutcome: z.unknown().optional() })),
}).optional() }) });
type ExportData = z.infer<typeof exportSchema>;

function unique<T extends z.ZodType>(rows: readonly unknown[], schema: T, problem: string): z.infer<T> {
  const row = schema.safeParse(rows[0]);
  if (rows.length !== 1 || !row.success) throw new Error(problem);
  return row.data;
}

function ratedRun(data: ExportData, feedbackId: string, methodKey: string) {
  const feedback = unique(data.feedback.filter(row => row.id === feedbackId), feedbackSchema, '未找到唯一可用的消息或成果反馈。');
  const isMessage = feedback.targetType === 'message';
  const target = unique((isMessage ? data.messages : data.artifacts).filter(row => row.id === feedback.targetId),
    targetSchema, '反馈指向的目标未保存在导出中。');
  const versionMatches = feedback.targetVersion === undefined ? target.content.length <= 8000
    : feedback.targetVersion === feedbackVersion(target.content);
  if (target.caseId !== feedback.caseId || !versionMatches || target.content.slice(0, 8000) !== feedback.targetContent
    || Date.parse(feedback.createdAt) < Date.parse(target.createdAt)
    || isMessage && (target.role !== 'assistant' || target.outputState && target.outputState !== 'complete')) {
    throw new Error('评价对象已变化，或不是可核对的完整交付。');
  }

  const task = feedback.taskOutcome;
  if (task?.unavailable || !isMessage && !task) throw new Error('缺少反馈绑定的任务结果回执。');
  const run = unique(data.runs.filter(row => task ? row.taskOutcomeEventId === task.outcomeEventId : row.id === target.runId),
    runSchema, '缺少与评价目标绑定的唯一已结束运行。');
  if (run.caseId !== target.caseId || Date.parse(target.createdAt) < Date.parse(run.startedAt)
    || Date.parse(target.createdAt) > Date.parse(run.endedAt)) throw new Error('运行时间或场景与目标不一致。');
  if (task) {
    if (run.taskId !== task.taskId || (run.taskExecution?.requirementsRevision ?? 1) !== task.requirementsRevision
      || (isMessage ? target.runId !== run.id : target.taskId !== task.taskId || (target.requirementsRevision ?? 1) !== task.requirementsRevision)
      || !data.events.some(event => event.id === task.outcomeEventId && event.kind === 'task.outcome' && event.sourceId === 'task-outcome'
        && event.caseId === target.caseId && event.status === 'processed')
      || task.targetContentHash !== createHash('sha256').update(feedback.targetContent).digest('hex')) {
      throw new Error('任务、要求版本或结果回执与反馈不一致。');
    }
  } else if (run.taskId || run.trigger !== 'chat' || !target.replyTo || !data.events.some(event => event.id === run.eventId
    && event.kind === 'owner.message' && event.sourceId === 'owner-chat' && event.messageId === target.replyTo && event.caseId === target.caseId)) {
    throw new Error('该消息缺少可核对的本人对话运行。');
  }

  const dispatches = data.contextState.dispatchContexts.filter(entry => entry.runId === run.id);
  const actor = dispatches.length === 1 ? dispatches[0].contexts.filter(context => context.role === 'actor') : [];
  if (!actor.length) throw new Error('缺少实际对话或任务模型调用的上下文清单，无法核对方法是否送入。');
  const exposures = actor.map(context => context.memories.find(memory => memory.subject === 'agent' && memory.key === methodKey)?.revision);
  const revisions = [...new Set(exposures.filter((revision): revision is number => revision !== undefined))].sort((a, b) => a - b);
  const usageStatus = run.pendingModelCalls ? 'unknown' : run.usageStatus ?? 'unknown';
  return { feedback, run, task, publicResult: {
    feedbackId: feedback.id, verdict: feedback.verdict, targetType: feedback.targetType, targetId: feedback.targetId,
    runId: run.id, caseId: run.caseId, runEndedAt: run.endedAt, ratedAt: feedback.createdAt,
    method: { actorDispatches: actor.length, dispatchesWithMethod: exposures.filter(value => value !== undefined).length, revisions },
    usage: { status: usageStatus, ...(usageStatus === 'reported' || usageStatus === 'partial'
      ? { inputTokens: run.inputTokens, outputTokens: run.outputTokens } : {}) },
    ...(task ? { taskId: task.taskId, requirementsRevision: task.requirementsRevision, outcomeEventId: task.outcomeEventId } : {}),
  } };
}

function exportedOutcome(data: ExportData, sample: ReturnType<typeof ratedRun>): TaskOutcomeEvidence | undefined {
  const { task, run } = sample;
  if (!task) return;
  const receipts = data.contextState.taskOutcomes ?? (data.contextState.personalMemory?.versions ?? []).flatMap(version => {
    const parsed = ledgerVersionSchema.safeParse(version);
    return (parsed.data?.fact.personal?.evidence ?? []).map(evidence => evidence.taskOutcome);
  });
  const matching = receipts.flatMap(receipt => {
    const outcome = taskOutcomeEvidenceSchema.safeParse(receipt).data;
    return outcome?.eventId === task.outcomeEventId && outcome.runId === run.id && outcome.taskId === task.taskId
      && outcome.requirementsRevision === task.requirementsRevision && outcome.caseId === run.caseId && outcome.executionEventId === run.eventId
      && outcome.status === run.status && outcome.recordedAt === run.endedAt ? [outcome] : [];
  });
  const first = matching[0];
  return first && matching.every(outcome => isDeepStrictEqual(outcome, first)) ? first : undefined;
}

function compareChecks(baseline: TaskOutcomeEvidence | undefined, followUp: TaskOutcomeEvidence | undefined) {
  if (!baseline || !followUp) return { status: 'unavailable' as const, checks: [] };
  const checks = baseline.checks.flatMap(first => {
    const sameCheck = (candidate: TaskOutcomeEvidence['checks'][number]) => candidate.source === first.source && candidate.name === first.name;
    const later = followUp.checks.filter(sameCheck);
    if (later.length !== 1 || baseline.checks.filter(sameCheck).length !== 1) return [];
    return [{ source: first.source, name: first.name, baseline: { passed: first.passed, referenceId: first.referenceId },
      followUp: { passed: later[0].passed, referenceId: later[0].referenceId } }];
  });
  return { status: checks.length ? 'available' as const : 'no_shared_unique_checks' as const, checks };
}

/** A human chooses comparable work and grades it independently. This only joins existing receipts. */
export function compareMethod(raw: unknown, methodKey: string, baselineFeedbackId: string, followUpFeedbackId: string) {
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) throw new Error('需要包含对话、反馈、运行和模型上下文清单的 榫 Tenon 完整 JSON 导出。');
  const data = parsed.data;
  const baseline = ratedRun(data, baselineFeedbackId, methodKey);
  const followUp = ratedRun(data, followUpFeedbackId, methodKey);
  if (baseline.feedback.targetId === followUp.feedback.targetId || baseline.run.id === followUp.run.id || baseline.run.eventId === followUp.run.eventId
    || baseline.feedback.targetType !== followUp.feedback.targetType || Boolean(baseline.task) !== Boolean(followUp.task)
    || baseline.task && baseline.task.taskId === followUp.task?.taskId
    || Date.parse(followUp.run.startedAt) < Math.max(Date.parse(baseline.run.endedAt), Date.parse(baseline.feedback.createdAt))) {
    throw new Error('需要同类、不同运行的两个样本，且后一次须在原反馈保存后开始。');
  }
  const laterRevisions = followUp.publicResult.method.revisions;
  if (laterRevisions.length !== 1 || baseline.publicResult.method.revisions.some(revision => revision >= laterRevisions[0])) {
    throw new Error('后一次运行没有可单独比较的新方法版本。');
  }
  const grade = (value: z.infer<typeof verdict>) => value === 'useful' ? 1 : value === 'not_now' ? null : 0;
  const before = grade(baseline.feedback.verdict), after = grade(followUp.feedback.verdict);
  const verdictChange = before === null || after === null ? 'inconclusive' : after > before ? 'better' : after < before ? 'worse' : 'unchanged';
  return { methodKey, baseline: baseline.publicResult, followUp: followUp.publicResult, verdictChange,
    taskChecks: compareChecks(exportedOutcome(data, baseline), exportedOutcome(data, followUp)),
    meaning: '这是本人选定样本的历史比较。发送了方法不证明模型采用；同名检查只说明各自回执中的条件，评价变化不证明因果或长期能力。' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , file, methodKey, baselineId, followUpId, ...extra] = process.argv;
  try {
    if (!file || !methodKey || !baselineId || !followUpId || extra.length) {
      throw new Error('用法：npm run compare:method -- <导出.json> <方法key> <原反馈ID> <后续反馈ID>');
    }
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new Error('无法读取指定的 JSON 导出。'); }
    process.stdout.write(JSON.stringify(compareMethod(raw, methodKey, baselineId, followUpId), null, 2) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : '比较失败。') + '\n');
    process.exitCode = 1;
  }
}
