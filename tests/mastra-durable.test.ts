import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function stage(directory: string, action: string, expectedExit = 0) {
  const child = spawn(process.execPath, ['--import', './scripts/test-network-guard.mjs', '--import', 'tsx',
    'tests/support/mastra-durable-worker.ts', directory, action], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += String(value); }); child.stderr.on('data', value => { stderr += String(value); });
  const timeout = setTimeout(() => child.kill(), 20_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timeout);
  assert.equal(code, expectedExit, stderr || stdout);
  const record = stdout.split('\n').find(line => line.startsWith('ADMISSION_RESULT:'));
  assert.ok(record, stderr || stdout);
  return JSON.parse(record.slice('ADMISSION_RESULT:'.length)) as { result: { status?: string; text?: string; error?: string; duplicateError?: string;
    snapshot?: { status: string; steps: Record<string, { status: string; output?: unknown }> } };
    evidence: { providerCalls: number; submissions: number; toolEntries: number; receiptUses: number; completions: number; phases: string[] };
    usage: { inputTokens: number; outputTokens: number; pendingModelCalls: number; usageStatus: string; steps: number } };
}

test('native Workflow suspends, cold-resumes from one receipt, and rejects a terminal replay', { timeout: 65_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-durable-admission-'));
  const started = await stage(directory, 'start');
  assert.equal(started.result.status, 'suspended', JSON.stringify(started));
  assert.deepEqual(started.result.snapshot?.steps.dispatch.output, { operationId: 'sdk-admission-operation' });
  assert.equal(started.evidence.providerCalls, 1); assert.equal(started.evidence.submissions, 1);
  const resumed = await stage(directory, 'resume');
  assert.equal(resumed.result.status, 'success', JSON.stringify(resumed));
  assert.match(resumed.result.text ?? '', /Completed from the saved receipt/);
  assert.equal(resumed.evidence.submissions, 1); assert.equal(resumed.evidence.receiptUses, 1);
  assert.deepEqual(resumed.evidence.phases, ['start', 'resume']);
  assert.equal(resumed.evidence.providerCalls, 2);
  assert.equal(resumed.evidence.completions, 1); assert.equal(resumed.usage.steps, 2);
  assert.equal(resumed.usage.inputTokens, 22); assert.equal(resumed.usage.outputTokens, 6);
  assert.equal(resumed.usage.pendingModelCalls, 0); assert.equal(resumed.usage.usageStatus, 'reported');
  const repeated = await stage(directory, 'resume');
  assert.ok(repeated.result.error, JSON.stringify(repeated));
  assert.deepEqual(repeated.evidence, resumed.evidence); assert.deepEqual(repeated.usage, resumed.usage);
});

test('a duplicate receipt cannot resume a Workflow while its first resume is inside a model call', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-durable-resume-race-'));
  await stage(directory, 'start');
  const resumed = await stage(directory, 'resume-race');
  assert.equal(resumed.result.status, 'success', JSON.stringify(resumed));
  assert.ok(resumed.result.duplicateError);
  assert.equal(resumed.evidence.providerCalls, 2); assert.equal(resumed.evidence.submissions, 1);
  assert.equal(resumed.evidence.receiptUses, 1); assert.equal(resumed.evidence.completions, 1);
});

for (const action of ['resume-revoked', 'resume-expired', 'resume-exhausted']) {
  test(`cold native Workflow ${action} rebuilds guards and retains the original budget and usage`, { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rae-durable-guard-'));
    const started = await stage(directory, 'start');
    const blocked = await stage(directory, action);
    assert.equal(blocked.result.status, 'failed', JSON.stringify(blocked));
    assert.equal(blocked.evidence.providerCalls, started.evidence.providerCalls);
    assert.equal(blocked.evidence.submissions, 1); assert.equal(blocked.evidence.completions, 0);
    assert.deepEqual(blocked.usage, started.usage, 'Rejected continuation must not count a provider request or refresh the budget.');
  });
}

test('a crash after external acceptance rechecks the stable operation and never resubmits it', { timeout: 65_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-durable-submission-'));
  const crashed = await stage(directory, 'start-crash', 75);
  assert.equal(crashed.evidence.submissions, 1);
  const recovered = await stage(directory, 'restart');
  assert.equal(recovered.result.status, 'suspended', JSON.stringify(recovered));
  assert.equal(recovered.evidence.submissions, 1); assert.equal(recovered.evidence.providerCalls, 1);
  const completed = await stage(directory, 'resume');
  assert.equal(completed.result.status, 'success', JSON.stringify(completed));
  assert.equal(completed.evidence.submissions, 1); assert.equal(completed.evidence.completions, 1);
});

test('a crash after a persisted delivery restores that result without another model call', { timeout: 65_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-durable-delivery-'));
  await stage(directory, 'start');
  const crashed = await stage(directory, 'resume-crash', 75);
  assert.equal(crashed.evidence.providerCalls, 2);
  const recovered = await stage(directory, 'restart');
  assert.equal(recovered.result.status, 'success', JSON.stringify(recovered));
  assert.equal(recovered.evidence.providerCalls, 2); assert.equal(recovered.evidence.completions, 1);
  assert.deepEqual(recovered.usage, crashed.usage);
});
