import { createHash } from 'node:crypto';
import type { ProjectEvent } from '../../shared/local-project.js';
import { projectDeliveryRequestSchema, projectDeliverySchema, projectPlanSchema, type ProjectExecutionContract, type ProjectPlan } from '../../shared/project-contract.js';

/** Scripted device evidence for integration tests that exercise lifecycle, not native files. */
export function fixtureDelivery(revision: number, toolId = 'fixture-validation', contractOrCriteria?: ProjectExecutionContract | string[]): ProjectEvent['event'][] {
  if (contractOrCriteria && !Array.isArray(contractOrCriteria) && contractOrCriteria.version === 2) {
    const request = projectDeliveryRequestSchema.parse({ summary: 'Scripted offline validation', outputs: [],
      checks: [{ id: 'check-0', requirementIds: contractOrCriteria.requirements.map(requirement => requirement.id),
        criterion: 'Fixture validation succeeds', required: true, command: { argv: ['fixture-project-check'] } }] });
    const check = request.checks[0];
    const plan = projectPlanSchema.parse({ objective: 'Verify fixture result', basis: [{ kind: 'owner', reference: 'fixture request', detail: 'Check fixture output' }],
      method: request.summary, environment: [], outputs: [], checks: [{ id: check.id, criterion: check.criterion, required: true, method: 'Fixture tool', basis: 'owner' }] });
    const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    const definitionHash = createHash('sha256').update(JSON.stringify({ outputs: request.outputs, check })).digest('hex');
    const delivery = projectDeliverySchema.parse({ version: 2, plan, planHash, requirementsRevision: revision, request, missing: [],
      evidence: [{ id: check.id, requirementIds: check.requirementIds, toolId, definitionHash, requirementsRevision: revision,
        files: [], command: check.command, assertions: check.assertions, status: 'passed', detail: 'Actual fixture check passed' }],
      verification: { planHash, requirementsRevision: revision, files: [], checkedAt: new Date().toISOString(),
        checks: [{ id: check.id, status: 'passed', toolIds: [toolId], detail: 'Actual fixture check passed', validator: 'fixture-project-check' }] } });
    return [{ kind: 'tool', item: { id: toolId, type: 'projectCheck', label: 'Fixture validation', state: 'running' } },
      { kind: 'tool', item: { id: toolId, type: 'projectCheck', label: 'Fixture validation', state: 'succeeded', exitCode: 0 } },
      { kind: 'delivery', delivery }];
  }
  const criteria = Array.isArray(contractOrCriteria) ? contractOrCriteria : contractOrCriteria?.criteria ?? [];
  const plan: ProjectPlan = { objective: 'Verify fixture result', basis: [{ kind: 'owner', reference: 'fixture request', detail: 'Check fixture output' }],
    method: 'Scripted offline validation', environment: [], outputs: [], checks: (criteria.length ? criteria : ['Fixture validation succeeds']).map((criterion, i) =>
      ({ id: 'check-' + i, criterion, required: true, method: 'Fixture tool', basis: 'owner' })) };
  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return [{ kind: 'tool', item: { id: toolId, type: 'commandExecution', label: 'Fixture validation', state: 'succeeded', exitCode: 0 } },
    { kind: 'plan', plan, planHash }, { kind: 'verification', verification: { planHash, requirementsRevision: revision,
      files: [], checkedAt: new Date().toISOString(), checks: plan.checks.map(check => ({ id: check.id, status: 'passed', toolIds: [toolId], detail: 'Fixture validation passed', validator: 'offline fixture' })) } }];
}
