import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunFinish } from '../server/v2/run-outcome.js';

test('normal stop is complete; output and native tool-step limits are terminal bounded outcomes', () => {
  assert.deepEqual(classifyRunFinish('stop'), { kind: 'complete' });
  const output = classifyRunFinish('length');
  assert.equal(output.kind, 'limited');
  if (output.kind === 'limited') { assert.equal(output.stopReason, 'output_limit'); assert.match(output.note, /回复长度上限.*未能完整回复/); }
  const steps = classifyRunFinish('tool-calls');
  assert.equal(steps.kind, 'limited');
  if (steps.kind === 'limited') { assert.equal(steps.stopReason, 'step_limit'); assert.match(steps.note, /处理步数上限.*尚未完成/); }
  for (const reason of [undefined, 'unknown', 'error', 'content-filter', 'other']) {
    assert.equal(classifyRunFinish(reason).kind, 'invalid', `${reason} cannot prove a completed answer`);
  }
});
