import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectDeliveryRequestSchema, projectDeliveryProblem, projectFinalFileSchema, projectRequirementProblem, type ProjectDelivery } from '../shared/project-contract.js';
import { executeProjectDelivery, completedDeliveryProblem } from '../desktop/project-delivery.js';
import type { ProjectToolItem } from '../shared/local-project.js';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-delivery-v2-'));
  const workspace = path.join(directory, 'workspace');
  for (const folder of [workspace, path.join(directory, 'temporary'), path.join(directory, 'outputs')]) await mkdir(folder);
  const requirements = [{ id: 'owner-total', text: 'The total must equal 42', revision: 1, sourceEventId: 'owner-message' }];
  const outputs = [{ path: 'total.json', format: 'json', description: 'Computed total' }];
  const request = projectDeliveryRequestSchema.parse({ summary: 'Read actual total', outputs, checks: [{ id: 'total',
    requirementIds: ['owner-total'], criterion: 'Total equals 42', assertions: [{ kind: 'json', path: 'total.json', key: ['total'], equals: 42 }] }] });
  const saved: ProjectDelivery[] = []; const tools: ProjectToolItem[] = [];
  let active = true;
  const execution = { revision: 1, requirements, objective: 'Compute total', workspace, directory,
    async guard() { if (!active) throw new Error('revoked'); },
    async command() { throw new Error('No command was selected'); }, async desktop() { return false; },
    async recordTool(tool: ProjectToolItem) { tools.push(structuredClone(tool)); },
    async save(delivery: ProjectDelivery) { saved.push(structuredClone(delivery)); } };
  return { request, execution, saved, tools, workspace, directory, revoke() { active = false; } };
}

test('frozen file selectors reject an extension that conflicts with the exact filename', () => {
  const workbook = { description: 'Final workbook', filename: 'release.XLSX', format: 'xlsx' };
  assert.deepEqual(projectFinalFileSchema.parse(workbook), workbook);
  assert.throws(() => projectFinalFileSchema.parse({ ...workbook, format: 'pdf' }), /最终文件名与扩展名不一致/);
  assert.throws(() => projectFinalFileSchema.parse({ ...workbook, filename: 'README' }), /最终文件名与扩展名不一致/);
});

test('v2 derives pass from current bytes, rejects old manual pass arguments, and preserves optional limitations', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":17}');
  const wrong = await executeProjectDelivery(f.request, f.execution);
  assert.equal(wrong.verification?.checks[0].status, 'failed');
  assert.match(projectDeliveryProblem(wrong, 1)!, /必需检查/);
  assert.throws(() => projectDeliveryRequestSchema.parse({ ...f.request, checks: [{ ...f.request.checks[0], status: 'passed', toolIds: ['unrelated'] }] }));
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  const request = projectDeliveryRequestSchema.parse({ ...f.request, checks: [...f.request.checks,
    { id: 'editorial', requirementIds: [], criterion: 'Optional editorial opinion', required: false, limitation: 'Not reviewed by a person' }] });
  const correct = await executeProjectDelivery(request, f.execution);
  assert.equal(projectDeliveryProblem(correct, 1), undefined);
  assert.equal(correct.verification?.checks[1].status, 'unverified');
  assert.equal(await completedDeliveryProblem(correct, 1, f.workspace, f.directory), undefined);
  assert.match(projectDeliveryProblem(correct, 2)!, /版本/);
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":16}');
  assert.match((await completedDeliveryProblem(correct, 1, f.workspace, f.directory))!, /变化/);
});

test('frozen final files require distinct current artifacts covered by passed checks', async () => {
  const f = await fixture();
  const finalFiles = [{ description: 'Final workbook', format: 'xlsx' }];
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  const partial = await executeProjectDelivery(f.request, f.execution);
  assert.equal(projectRequirementProblem(f.request, f.execution.requirements), undefined);
  assert.match(projectDeliveryProblem(partial, 1, undefined, finalFiles)!, /Final workbook/);

  const workbook = { path: 'final.xlsx', format: 'xlsx', description: 'Final workbook' };
  await writeFile(path.join(f.workspace, workbook.path), 'fixture payload');
  const withWorkbook = projectDeliveryRequestSchema.parse({ ...f.request, outputs: [...f.request.outputs, workbook],
    checks: [{ ...f.request.checks[0], files: ['total.json'] }] });
  const unchecked = await executeProjectDelivery(withWorkbook, f.execution);
  assert.match(projectDeliveryProblem(unchecked, 1, undefined, finalFiles)!, /Final workbook/);

  const workbookHash = createHash('sha256').update(await readFile(path.join(f.workspace, workbook.path))).digest('hex');
  const bound = projectDeliveryRequestSchema.parse({ ...withWorkbook, checks: [...withWorkbook.checks, {
    id: 'workbook', criterion: 'Match the expected workbook bytes', files: [workbook.path],
    assertions: [{ kind: 'sha256', path: workbook.path, equals: workbookHash }],
  }] });
  const complete = await executeProjectDelivery(bound, f.execution);
  assert.equal(projectDeliveryProblem(complete, 1, complete.verification!.files.map(file => ({ ...file, path: file.publishedPath })), finalFiles), undefined);
  assert.match(projectDeliveryProblem(complete, 1, undefined, [{ ...finalFiles[0], count: 2 }])!, /Final workbook/);
  assert.match(projectDeliveryProblem(complete, 1, undefined, [{ ...finalFiles[0], filename: 'other.xlsx' }])!, /Final workbook/);
});

test('v2 saves partial evidence and reuses unchanged readback when only a missing report is supplied', async () => {
  const f = await fixture(); await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  const request = projectDeliveryRequestSchema.parse({ ...f.request,
    outputs: [...f.request.outputs, { path: 'report.md', format: 'md', description: 'Required report' }],
    checks: [{ ...f.request.checks[0], files: ['total.json'] }] });
  const first = await executeProjectDelivery(request, f.execution);
  assert.equal(first.verification?.checks[0].status, 'passed');
  assert.match(projectDeliveryProblem(first, 1)!, /report\.md/);
  const checked = first.evidence![0].toolId;
  await writeFile(path.join(f.workspace, 'report.md'), 'Actual total is 42');
  const before = f.tools.length;
  const second = await executeProjectDelivery(request, { ...f.execution, previous: first });
  assert.equal(second.evidence![0].toolId, checked); assert.equal(f.tools.length, before);
  assert.equal(projectDeliveryProblem(second, 1), undefined);
  assert.equal(f.saved.at(-1)?.missing?.length, 0);
});

test('explicit readback reuses only its scoped receipt when unrelated outputs are added, removed or renamed', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  await writeFile(path.join(f.workspace, 'note.md'), 'Optional note');
  await writeFile(path.join(f.workspace, 'renamed.md'), 'Optional note');
  const explicit = { ...f.request.checks[0], files: ['total.json'] };
  const run = (outputs = f.request.outputs, check = explicit, previous?: ProjectDelivery, revision = 1) =>
    executeProjectDelivery(projectDeliveryRequestSchema.parse({ ...f.request, outputs, checks: [check] }), { ...f.execution, previous, revision });
  const first = await run();
  const original = first.evidence![0];
  const note = { path: 'note.md', format: 'md', description: 'Optional note' };
  const added = await run([...f.request.outputs, note], explicit, first);
  const changedNote = await run([{ ...note, path: 'renamed.md', description: 'Renamed note' }, ...f.request.outputs], explicit, added);
  const removed = await run(f.request.outputs, explicit, changedNote);
  for (const attempt of [added, changedNote, removed]) assert.deepEqual(attempt.evidence![0], original);
  assert.equal(f.tools.length, 2, 'Reusing a check does not record another execution');
  assert.match(projectDeliveryProblem(removed, 1, undefined, [{ description: 'Frozen report', format: 'md' }])!, /Frozen report/);

  const renamed = await run([{ ...f.request.outputs[0], description: 'New selected metadata' }], explicit, first);
  const criterion = await run(f.request.outputs, { ...explicit, criterion: 'A new criterion' }, first);
  const revised = await run(f.request.outputs, explicit, first, 2);
  for (const attempt of [renamed, criterion, revised]) assert.notEqual(attempt.evidence![0].toolId, original.toolId);

  const optionalRequest = projectDeliveryRequestSchema.parse({ ...f.request, checks: [
    { ...explicit, id: 'auxiliary', required: false }, explicit,
  ] });
  const optional = await executeProjectDelivery(optionalRequest, f.execution);
  const required = await executeProjectDelivery({ ...optionalRequest, checks: [{ ...optionalRequest.checks[0], required: true }, explicit] },
    { ...f.execution, previous: optional });
  assert.notEqual(required.evidence![0].toolId, optional.evidence![0].toolId);
  assert.equal(required.evidence![1].toolId, optional.evidence![1].toolId);

  await writeFile(path.join(f.workspace, 'total.json'), '{"total":17}');
  const changedBytes = await run(f.request.outputs, explicit, first);
  assert.notEqual(changedBytes.evidence![0].toolId, original.toolId);
  assert.equal(changedBytes.evidence![0].status, 'failed');
});

test('implicit all-output readback includes an added output in its definition and coverage', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  await writeFile(path.join(f.workspace, 'note.md'), 'Optional note');
  const first = await executeProjectDelivery(f.request, f.execution);
  const request = projectDeliveryRequestSchema.parse({ ...f.request,
    outputs: [...f.request.outputs, { path: 'note.md', format: 'md', description: 'Optional note' }] });
  const added = await executeProjectDelivery(request, { ...f.execution, previous: first });
  assert.notEqual(added.evidence![0].toolId, first.evidence![0].toolId);
  assert.equal(added.evidence![0].status, 'unverified');
});

test('an existing checker with zero exit but failed JSON result cannot pass the required check', async () => {
  const f = await fixture(); await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  const request = projectDeliveryRequestSchema.parse({ ...f.request,
    outputs: [...f.request.outputs, { path: 'audit.json', format: 'json', description: 'Validator result' }],
    checks: [{ id: 'validation', criterion: 'The validator found no issues', requirementIds: ['owner-total'], files: ['total.json'],
      command: { argv: ['node', 'actual-check.cjs'] }, assertions: [{ kind: 'json', path: 'audit.json', key: ['issues'], equals: 0 }] }] });
  const delivery = await executeProjectDelivery(request, { ...f.execution, async command() {
    await writeFile(path.join(f.workspace, 'audit.json'), '{"issues":64}');
    return { exitCode: 0, stdout: 'Check completed', stderr: '' };
  } });
  assert.equal(delivery.verification?.checks[0].status, 'failed');
  assert.match(projectDeliveryProblem(delivery, 1)!, /必需检查/);
});

test('requirements are references and explicit owner revisions can supersede an earlier condition', async () => {
  const f = await fixture();
  assert.equal(projectRequirementProblem(f.request, f.execution.requirements), undefined);
  assert.match(projectRequirementProblem({ ...f.request, checks: [{ ...f.request.checks[0], requirementIds: ['foreign'] }] }, f.execution.requirements)!, /不属于/);
  const requirements = [...f.execution.requirements, { id: 'owner-update', text: 'Use 43 instead', revision: 2, sourceEventId: 'owner-new-message' }];
  const replacement = { ...f.request, checks: [{ ...f.request.checks[0], requirementIds: ['owner-update'] }], supersededRequirements: [{ id: 'owner-total', revision: 2 }] };
  assert.equal(projectRequirementProblem(replacement, requirements), undefined);
  assert.match(projectRequirementProblem(replacement, f.execution.requirements)!, /真实补充/);
});

test('revocation during validation prevents publishing and cached evidence remains version bound', async () => {
  const f = await fixture(); await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  const first = await executeProjectDelivery(f.request, f.execution);
  const next = await executeProjectDelivery(f.request, { ...f.execution, revision: 2, previous: first });
  assert.notEqual(next.evidence![0].toolId, first.evidence![0].toolId);
  const request = projectDeliveryRequestSchema.parse({ ...f.request, checks: [{ ...f.request.checks[0], command: { argv: ['node', 'check.cjs'] } }] });
  await assert.rejects(executeProjectDelivery(request, { ...f.execution, async command() {
    f.revoke(); return { exitCode: 0, stdout: 'finished', stderr: '' };
  } }), /revoked/);
  assert.equal(await readFile(path.join(f.workspace, 'total.json'), 'utf8'), '{"total":42}');
});

test('scoped desktop verification can support a file-free task without accepting an invented success', async () => {
  const f = await fixture();
  const request = projectDeliveryRequestSchema.parse({ summary: 'Verify the actual app page', outputs: [],
    checks: [{ id: 'page', criterion: 'Logs page is visible', requirementIds: ['owner-total'], desktop: { key: 'page', equals: 'logs' } }] });
  const missing = await executeProjectDelivery(request, f.execution);
  assert.equal(missing.verification?.checks[0].status, 'failed');
  const actual = await executeProjectDelivery(request, { ...f.execution, async desktop(check) { return check.key === 'page' && check.equals === 'logs'; } });
  assert.equal(projectDeliveryProblem(actual, 1), undefined);
  const changed = await executeProjectDelivery(request, { ...f.execution, previous: actual });
  assert.notEqual(changed.evidence![0].toolId, actual.evidence![0].toolId);
  assert.equal(changed.evidence![0].status, 'failed');
});

test('command-only success remains operation evidence and cannot certify file content', async () => {
  const f = await fixture(); await writeFile(path.join(f.workspace, 'total.json'), '{"total":17}');
  const request = projectDeliveryRequestSchema.parse({ ...f.request, checks: [{ id: 'total', requirementIds: ['owner-total'],
    criterion: 'The total equals 42', files: ['total.json'], command: { argv: ['node', '-e', 'console.log("hello")'] } }] });
  let commands = 0;
  const execution = { ...f.execution, async command() { commands++; return { exitCode: 0, stdout: 'hello', stderr: '' }; } };
  const delivery = await executeProjectDelivery(request, execution);
  assert.equal(commands, 1); assert.equal(f.tools.at(-1)?.state, 'succeeded');
  assert.equal(delivery.verification?.checks[0].status, 'unverified');
  assert.match(projectDeliveryProblem(delivery, 1)!, /必需检查/);
  const operationRequest = projectDeliveryRequestSchema.parse({ ...request, outputs: [], checks: [{ ...request.checks[0], files: [] }] });
  const operation = await executeProjectDelivery(operationRequest, execution);
  assert.equal(projectDeliveryProblem(operation, 1), undefined, 'A file-free operation retains its real command-result semantics');
  const repeated = await executeProjectDelivery(operationRequest, { ...execution, previous: operation });
  assert.equal(commands, 3, 'A passed arbitrary command runs again on resubmission');
  assert.notEqual(repeated.evidence![0].toolId, operation.evidence![0].toolId);
});

test('an old unrelated passing report cannot certify the declared file and a current report binds both hash and conclusion', async () => {
  const f = await fixture();
  const subject = path.join(f.workspace, 'total.json'), report = path.join(f.workspace, 'audit.json');
  await writeFile(subject, '{"total":17}');
  await writeFile(report, '{"issues":0,"inputSha256":"' + '0'.repeat(64) + '"}');
  const request = projectDeliveryRequestSchema.parse({ ...f.request,
    outputs: [...f.request.outputs, { path: 'audit.json', format: 'json', description: 'Actual check report' }],
    checks: [{ id: 'report', criterion: 'The total checker found no issues', requirementIds: ['owner-total'], files: ['total.json'],
      command: { argv: ['node', 'checker.cjs'] }, assertions: [{ kind: 'json', path: 'audit.json', key: ['issues'], equals: 0 }] }] });
  const unchanged = { ...f.execution, async command() { return { exitCode: 0, stdout: 'hello', stderr: '' }; } };
  const unrelated = await executeProjectDelivery(request, unchanged);
  assert.equal(unrelated.evidence?.[0].status, 'unverified'); assert.match(projectDeliveryProblem(unrelated, 1)!, /必需检查/);
  const bound = projectDeliveryRequestSchema.parse({ ...request, checks: [{ ...request.checks[0],
    reportBindings: [{ subject: 'total.json', report: 'audit.json', key: ['inputSha256'] }] }] });
  const stale = await executeProjectDelivery(bound, unchanged);
  assert.equal(stale.evidence?.[0].status, 'failed'); assert.match(stale.evidence![0].detail, /指纹不匹配/);
  const checker = { ...f.execution, async command() {
    const bytes = await readFile(subject);
    await writeFile(report, JSON.stringify({ issues: JSON.parse(bytes.toString()).total === 42 ? 0 : 1,
      inputSha256: createHash('sha256').update(bytes).digest('hex') }));
    return { exitCode: 0, stdout: 'Actual checker ran', stderr: '' };
  } };
  const wrong = await executeProjectDelivery(bound, checker);
  assert.equal(wrong.evidence?.[0].status, 'failed'); assert.match(projectDeliveryProblem(wrong, 1)!, /必需检查/);
  await writeFile(subject, '{"total":42}');
  const correct = await executeProjectDelivery(bound, checker);
  assert.equal(projectDeliveryProblem(correct, 1), undefined);
  assert.deepEqual(correct.evidence![0].reportBindings, bound.checks[0].reportBindings);
  assert.deepEqual(correct.evidence![0].files.map(file => file.path).sort(), ['audit.json', 'total.json']);
});

test('cached report checks include the report bytes and require an assertion beyond the input fingerprint', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  const hash = createHash('sha256').update(await readFile(path.join(f.workspace, 'total.json'))).digest('hex');
  await writeFile(path.join(f.workspace, 'audit.json'), JSON.stringify({ issues: 0, inputSha256: hash }));
  const request = projectDeliveryRequestSchema.parse({ ...f.request,
    outputs: [...f.request.outputs, { path: 'audit.json', format: 'json', description: 'Recorded check report' }],
    checks: [{ id: 'report', criterion: 'Actual report has no issues', requirementIds: ['owner-total'], files: ['total.json'],
      assertions: [{ kind: 'json', path: 'audit.json', key: ['issues'], equals: 0 }],
      reportBindings: [{ subject: 'total.json', report: 'audit.json', key: ['inputSha256'] }] }] });
  const first = await executeProjectDelivery(request, f.execution);
  assert.equal(projectDeliveryProblem(first, 1), undefined);
  const before = f.tools.length;
  const reused = await executeProjectDelivery(request, { ...f.execution, previous: first });
  assert.equal(reused.evidence![0].toolId, first.evidence![0].toolId); assert.equal(f.tools.length, before);
  await writeFile(path.join(f.workspace, 'unrelated.md'), 'Optional note');
  const plusNote = projectDeliveryRequestSchema.parse({ ...request, outputs: [...request.outputs,
    { path: 'unrelated.md', format: 'md', description: 'Optional note' }] });
  const reusedWithNote = await executeProjectDelivery(plusNote, { ...f.execution, previous: reused });
  assert.equal(reusedWithNote.evidence![0].toolId, first.evidence![0].toolId); assert.equal(f.tools.length, before);
  await writeFile(path.join(f.workspace, 'audit.json'), JSON.stringify({ issues: 3, inputSha256: hash }));
  const changed = await executeProjectDelivery(request, { ...f.execution, previous: first });
  assert.equal(changed.evidence?.[0].status, 'failed'); assert.notEqual(changed.evidence![0].toolId, first.evidence![0].toolId);
  const fingerprintOnly = projectDeliveryRequestSchema.parse({ ...request, checks: [{ ...request.checks[0],
    assertions: [{ kind: 'json', path: 'audit.json', key: ['inputSha256'], equals: hash }] }] });
  const incomplete = await executeProjectDelivery(fingerprintOnly, f.execution);
  assert.equal(incomplete.evidence?.[0].status, 'unverified'); assert.match(projectDeliveryProblem(incomplete, 1)!, /必需检查/);
});

test('a check can create and bind a private report without adding it to final artifacts', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  const report = path.join(f.directory, 'temporary', 'private-audit.json');
  const hash = createHash('sha256').update(await readFile(path.join(f.workspace, 'total.json'))).digest('hex');
  const request = projectDeliveryRequestSchema.parse({ ...f.request, checks: [{ id: 'audit', criterion: 'Actual audit passes',
    requirementIds: ['owner-total'], files: ['total.json'], command: { argv: ['validator'] },
    assertions: [{ kind: 'json', path: report, key: ['issues'], equals: 0 }],
    reportBindings: [{ subject: 'total.json', report, key: ['sha256'] }],
  }] });
  const first = await executeProjectDelivery(request, { ...f.execution, async command() {
    await writeFile(report, JSON.stringify({ issues: 0, sha256: hash }));
    return { exitCode: 0, stdout: 'Actual validator ran', stderr: '' };
  } });
  const frozen = [{ description: 'Final total', filename: 'total.json' }];
  assert.equal(projectDeliveryProblem(first, 1, undefined, frozen), undefined);
  assert.deepEqual(first.verification!.files.map(file => file.path), ['total.json']);
  assert.deepEqual(first.evidence![0].files.map(file => file.path), ['total.json']);
  assert.equal(first.evidence![0].dependencies?.[0].publishedPath, 'temporary/private-audit.json');
  assert.deepEqual(first.verification!.dependencies, first.evidence![0].dependencies);
  assert.equal(await completedDeliveryProblem(first, 1, f.workspace, f.directory, frozen), undefined);
  assert.match(projectDeliveryProblem(first, 1, undefined, [{ description: 'Required audit artifact', filename: 'private-audit.json' }])!, /Required audit artifact/);

  const direct = projectDeliveryRequestSchema.parse({ ...request, checks: [{ ...request.checks[0], command: undefined }] });
  const readback = await executeProjectDelivery(direct, f.execution);
  const cached = await executeProjectDelivery(direct, { ...f.execution, previous: readback });
  assert.equal(cached.evidence![0].toolId, readback.evidence![0].toolId);
  await writeFile(report, JSON.stringify({ issues: 1, sha256: hash }));
  assert.match((await completedDeliveryProblem(first, 1, f.workspace, f.directory, frozen))!, /辅助文件已变化/);
  const mutated = await executeProjectDelivery(direct, { ...f.execution, previous: readback });
  assert.notEqual(mutated.evidence![0].toolId, readback.evidence![0].toolId);
  assert.equal(mutated.evidence![0].status, 'failed');
});

test('out-of-scope and alias-to-output verification dependencies are rejected', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'total.json'), '{"total":42}');
  const unrelated = path.join(f.directory, 'unrelated.json');
  await writeFile(unrelated, '{"total":42}');
  for (const [target, problem] of [[unrelated, /不在本任务/], [path.join(f.workspace, 'total.json'), /相同文件路径/]] as const) {
    const request = projectDeliveryRequestSchema.parse({ ...f.request, checks: [{ ...f.request.checks[0], assertions: [
      { kind: 'json', path: target, key: ['total'], equals: 42 },
    ] }] });
    const refused = await executeProjectDelivery(request, f.execution);
    assert.equal(refused.evidence?.[0].status, 'failed');
    assert.match(refused.evidence![0].detail, problem);
    assert.deepEqual(refused.verification!.dependencies, []);
  }
});
