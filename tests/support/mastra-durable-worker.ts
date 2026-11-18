import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { Store } from '../../server/store.js';
import { UsageTracker } from '../../server/v2/usage.js';
import type { Run } from '../../shared/types.js';
import { MockLanguageModelV4 } from './model.js';

const [directory, action] = process.argv.slice(2);
if (!directory || !action) throw new Error('An isolated directory and action are required.');
const store = new Store(directory);
const runId = 'sdk-admission-run';
const operationId = 'sdk-admission-operation';
interface Control { allowed: boolean; deadline: number; maxCalls: number }
interface Evidence { providerCalls: number; submissions: number; toolEntries: number; receiptUses: number; completions: number; phases: string[] }
const initial: Evidence = { providerCalls: 0, submissions: 0, toolEntries: 0, receiptUses: 0, completions: 0, phases: [] };
const evidence = () => store.getMeta<Evidence>('admission.evidence', initial);
function record(update: Partial<Evidence>) { store.setMeta('admission.evidence', { ...evidence(), ...update }); }
function guard() {
  const control = store.getMeta<Control>('admission.control', { allowed: false, deadline: 0, maxCalls: 0 });
  if (!control.allowed) throw new Error('ADMISSION_PERMISSION_REVOKED');
  if (Date.now() >= control.deadline) throw new Error('ADMISSION_DEADLINE_EXPIRED');
}
if (action.startsWith('start')) {
  store.setMeta('admission.control', { allowed: true, deadline: Date.now() + 60_000, maxCalls: 2 });
  store.setMeta('admission.evidence', initial);
  store.insert('runs', { id: runId, trigger: 'manual', mode: 'execution', status: 'running', startedAt: new Date().toISOString(),
    steps: 0, inputTokens: 0, outputTokens: 0, usageStatus: 'not_used' } satisfies Run);
}
if (['resume-revoked', 'resume-expired', 'resume-exhausted'].includes(action)) {
  const control = store.getMeta<Control>('admission.control', { allowed: false, deadline: 0, maxCalls: 0 });
  store.setMeta('admission.control', { ...control, ...(action === 'resume-revoked' ? { allowed: false }
    : action === 'resume-expired' ? { deadline: 1 } : { maxCalls: 1 }) });
}
const run = store.get('runs', runId)!;
const tracker = new UsageTracker(store); tracker.recover();
let notifyModelEntered!: () => void; let releaseModel!: () => void;
const modelEntered = new Promise<void>(resolve => { notifyModelEntered = resolve; });
const modelRelease = new Promise<void>(resolve => { releaseModel = resolve; });
const reported = { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
const model = tracker.meter(run, new MockLanguageModelV4({ doGenerate: async input => {
  const saved = store.get('runs', runId)!;
  assert.equal(saved.pendingModelCalls, 1, 'Production usage wrapper must persist its marker before the provider.');
  record({ providerCalls: evidence().providerCalls + 1 });
  const hasReceipt = JSON.stringify(input.prompt).includes('RECEIPT_COMPLETE');
  if (action === 'resume-race' && hasReceipt) { notifyModelEntered(); await modelRelease; }
  return { content: [{ type: 'text' as const, text: hasReceipt ? 'Completed from the saved receipt.' : 'Prepared the authorized operation.' }],
    warnings: [], usage: reported, finishReason: { unified: 'stop' as const, raw: 'fixture' } };
} }), new AbortController().signal, () => {
  guard();
  const control = store.getMeta<Control>('admission.control', { allowed: false, deadline: 0, maxCalls: 0 });
  if (run.steps >= control.maxCalls) throw new Error('ADMISSION_CALL_LIMIT');
  run.steps++; store.put('runs', run);
});
const agent = new Agent({ id: 'sdk-admission-agent', name: 'Offline admission',
  instructions: 'Use the saved operation receipt, then finish.', model, maxRetries: 0 });
const operationSchema = z.object({ operationId: z.string() });
const deliveredSchema = z.object({ operationId: z.string(), text: z.string() });
const dispatch = createStep({ id: 'dispatch', inputSchema: z.object({ taskId: z.string() }), outputSchema: operationSchema,
  execute: async () => {
    guard(); record({ toolEntries: evidence().toolEntries + 1, phases: [...evidence().phases, action] });
    if (store.getMeta('admission.submitted', false)) return { operationId };
    const output = await agent.stream('Prepare the authorized operation.', { maxSteps: 1 }); await output.getFullOutput();
    if (!store.getMeta('admission.submitted', false)) {
      store.setMeta('admission.submitted', true); record({ submissions: evidence().submissions + 1 });
    }
    if (action === 'start-crash') await crash();
    return { operationId };
  } });
const deliver = createStep({ id: 'deliver', inputSchema: operationSchema, outputSchema: deliveredSchema,
  resumeSchema: z.object({ operationId: z.string(), result: z.literal('RECEIPT_COMPLETE') }), suspendSchema: operationSchema,
  execute: async ({ inputData, resumeData, suspend, getStepResult }) => {
    guard(); assert.equal(inputData.operationId, operationId);
    assert.deepEqual(getStepResult(dispatch), { operationId }, 'Prior step output must survive a cold process.');
    const saved = store.getMeta<{ operationId: string; text: string } | null>('admission.artifact', null);
    if (saved) return saved;
    if (!resumeData) return suspend({ operationId });
    assert.equal(resumeData.operationId, operationId);
    record({ toolEntries: evidence().toolEntries + 1, receiptUses: evidence().receiptUses + 1, phases: [...evidence().phases, action] });
    const output = await agent.stream(resumeData.result, { maxSteps: 1 });
    const content = await output.getFullOutput();
    if (!content.text) throw new Error('ADMISSION_NO_DELIVERY');
    const artifact = { operationId, text: content.text };
    store.setMeta('admission.artifact', artifact);
    if (action === 'resume-crash') await crash();
    return artifact;
  } });
const complete = createStep({ id: 'complete', inputSchema: deliveredSchema, outputSchema: deliveredSchema,
  execute: async ({ inputData }) => {
    guard();
    if (!store.getMeta('admission.delivered', false)) record({ completions: evidence().completions + 1 });
    store.setMeta('admission.delivered', inputData); return inputData;
  } });
const workflow = createWorkflow({ id: 'sdk-admission-workflow', inputSchema: z.object({ taskId: z.string() }), outputSchema: deliveredSchema,
  options: { autoRestartActiveRuns: false }, retryConfig: { attempts: 0 } }).then(dispatch).then(deliver).then(complete).commit();
const storage = new LibSQLStore({ id: 'sdk-admission-store', url: `file:${join(directory, 'durable.db').replaceAll('\\', '/')}` });
const mastra = new Mastra({ agents: { agent }, storage, logger: false, recovery: { workflows: 'off', durableAgents: 'off' } });
mastra.addWorkflow(workflow);
let result: unknown;
async function crash(): Promise<never> {
  await new Promise<void>(resolve => process.stdout.write(`ADMISSION_RESULT:${JSON.stringify({ result: { status: 'crashed' },
    evidence: evidence(), usage: store.get('runs', runId) })}\n`, () => resolve()));
  process.exit(75);
}
try {
  const execution = await workflow.createRun({ runId });
  const receipt = { step: 'deliver', resumeData: { operationId, result: 'RECEIPT_COMPLETE' } };
  let duplicateError: string | undefined;
  const output = await (async () => {
    if (action.startsWith('start')) return execution.start({ inputData: { taskId: 'sdk-admission-task' } });
    if (action === 'restart') return execution.restart();
    if (action !== 'resume-race') return execution.resume(receipt);
    const first = execution.resume(receipt);
    await modelEntered;
    const duplicate = await workflow.createRun({ runId });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      duplicateError = await Promise.race([
        duplicate.resume(receipt).then(() => 'DUPLICATE_WAS_ACCEPTED', error => error instanceof Error ? error.message : String(error)),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('DUPLICATE_DID_NOT_SETTLE'), 3000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); releaseModel(); }
    assert.notEqual(duplicateError, 'DUPLICATE_WAS_ACCEPTED');
    assert.notEqual(duplicateError, 'DUPLICATE_DID_NOT_SETTLE');
    return first;
  })();
  const snapshot = await workflow.getWorkflowRunById(runId);
  result = { status: output.status, text: output.status === 'success' ? output.result.text : undefined,
    error: output.status === 'failed' ? output.error.message : undefined, duplicateError, snapshot };
} catch (error) {
  result = { error: error instanceof Error ? error.message : String(error) };
} finally {
  const usage = store.get('runs', runId);
  const facts = evidence();
  await mastra.shutdown(); store.close();
  process.stdout.write(`ADMISSION_RESULT:${JSON.stringify({ result, evidence: facts, usage })}\n`);
}
