import type { CaseMemory } from '../../server/v2/memory.js';

/** Storage fixtures only: production owner operations enter PersonalMemory. */
export function putSharedFact(memory: CaseMemory, input: { key: string; value: string; domains: string[]; evidenceIds: string[] }) {
  return memory.updateSharedFact(input.key, existing => {
    const timestamp = new Date().toISOString();
    return { fact: { ...input, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp }, result: undefined };
  });
}
