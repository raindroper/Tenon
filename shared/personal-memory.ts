import { z } from 'zod';

const identifier = z.string().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Historical result facts. Passing a check proves only its named condition,
 * never the general quality of an artifact or competence of a learned method. */
export const taskOutcomeEvidenceSchema = z.object({
  eventId: identifier, taskId: identifier, runId: identifier, caseId: identifier,
  executionEventId: identifier, approvalRevision: z.number().int().positive(), requirementsRevision: z.number().int().positive(),
  status: z.enum(['completed', 'failed', 'interrupted']), recordedAt: z.string().datetime(),
  deliveries: z.array(z.object({ artifactId: identifier, contentHash: hash, status: z.enum(['prepared', 'verified']) }).strict()).max(8),
  operations: z.array(z.object({ kind: z.enum(['device', 'media', 'project', 'mail', 'github']), id: identifier, requirementsRevision: z.number().int().positive(),
    receiptHash: hash, state: z.string().min(1).max(80) }).strict()).max(4),
  checks: z.array(z.object({ source: z.enum(['artifact', 'device', 'media', 'workspace', 'runtime', 'project', 'mail', 'github']), referenceId: identifier,
    name: z.string().min(1).max(200), passed: z.boolean(), detail: z.string().min(1).max(600) }).strict()).max(20),
  sourceEventIds: z.array(identifier).max(128),
}).strict();
export type TaskOutcomeEvidence = z.infer<typeof taskOutcomeEvidenceSchema>;
export const taskOutcomeReferenceSchema = z.object({ taskId: identifier, requirementsRevision: z.number().int().positive(),
  outcomeEventId: identifier, targetContentHash: hash,
  /** A known task target without a usable result journal stays fenced; this is not evidence. */
  unavailable: z.literal(true).optional() }).strict();
export type TaskOutcomeReference = z.infer<typeof taskOutcomeReferenceSchema>;

export type PersonalMemoryKind = 'fact' | 'preference' | 'habit' | 'experience';
export type PersonalMemorySubject = 'owner' | 'agent';
export type PersonalMemoryPurpose = 'identity' | 'interaction' | 'context';
export interface PersonalMemoryIdentity {
  kind: 'name' | 'alias'; value: string; platform?: string; conversationId?: string;
}
/** Supplied by trusted runtime adapters, never accepted as a model's assertion of authority. */
export type PersonalMemoryMutationSource =
  | { kind: 'owner-message'; eventId: string; caseId: string; contentHash: string; excerpt: string; messageId?: string }
  | { kind: 'owner-command'; commandId: string; acceptedAt: string }
  | { kind: 'legacy' };
export interface PersonalMemoryMutationContext { source: PersonalMemoryMutationSource; expectedRevision?: number }
export type PersonalMemoryScope = 'case' | 'domain' | 'global';
export type PersonalMemoryLevel = 'hypothesis' | 'explicit';
export type PersonalMemoryStatus = 'active' | 'retracted';
export type PersonalMemoryEffectiveStatus = PersonalMemoryStatus | 'expired' | 'evidence_unavailable';
export interface PersonalMemoryRating {
  verdict: 'useful' | 'off_target' | 'correction' | 'not_now';
  targetType: 'message' | 'artifact' | 'case'; targetId: string; targetContentHash: string;
}
export interface PersonalMemoryEvidence {
  eventId: string; excerpt: string; actor: 'owner' | 'external' | 'agent' | 'system'; kind: string;
  sourceId: string; sourceGeneration?: string; caseId: string; occurredAt: string; receivedAt: string;
  /** Excerpt is rated server-side target text, not words attributed to the owner or verified success. */
  rating?: PersonalMemoryRating;
  /** Concrete task/version/result references; ratings remain subjective and methods remain hypotheses. */
  taskOutcome?: TaskOutcomeEvidence;
}
export interface PersonalMemoryVersion {
  subject: PersonalMemorySubject;
  purpose?: PersonalMemoryPurpose; identity?: PersonalMemoryIdentity;
  mutationSource?: PersonalMemoryMutationSource;
  revision: number; value: string; kind: PersonalMemoryKind; level: PersonalMemoryLevel; scope: PersonalMemoryScope;
  domains: string[]; caseIds: string[]; evidenceIds: string[]; evidence: PersonalMemoryEvidence[];
  status: PersonalMemoryStatus; origin: 'learned' | 'owner' | 'legacy';
  validFrom: string; expiresAt: string | null; updatedAt: string;
}
export interface PersonalMemoryEntry extends PersonalMemoryVersion {
  key: string; supersedes: number | null; createdAt: string; effectiveStatus: PersonalMemoryEffectiveStatus;
  /** At most the eight most recent superseded versions; not an unlimited audit archive. */
  history: PersonalMemoryVersion[];
}
export interface PersonalMemoryPage {
  entries: PersonalMemoryEntry[]; total: number; offset: number; nextOffset: number | null;
}
export type PersonalMemoryCorrectionNotice = Pick<PersonalMemoryEntry, 'key' | 'subject' | 'revision' | 'updatedAt'> & (
  { status: 'active'; value: string } | { status: 'retracted' | 'out_of_scope' }
);
export interface RetiredMemoryScope {
  domains: string[];
  caseIds?: string[];
}
/** Compact suppression evidence kept independently of the eight restorable versions. */
export type PersonalMemoryRetirement = { except?: RetiredMemoryScope } & (
  { type: 'event'; eventId: string; caseId: string; excerptHash: string; ownerChat: boolean }
  | { type: 'literal'; value: string; scope: RetiredMemoryScope }
);
/** Metadata stored alongside existing SharedFact fields in the one native resource core. */
export type PersonalMemoryDetails = Omit<PersonalMemoryEntry,
  'key' | 'value' | 'domains' | 'evidenceIds' | 'createdAt' | 'updatedAt' | 'effectiveStatus'> & { retirements?: PersonalMemoryRetirement[] };
export interface LearnPersonalMemoryInput {
  key: string; value: string; evidenceExcerpt: string; kind?: PersonalMemoryKind;
  scope?: PersonalMemoryScope; mode?: 'observe' | 'correction'; expiresAt?: string;
  interpretation?: 'assertion' | 'inference'; purpose?: PersonalMemoryPurpose; identity?: PersonalMemoryIdentity; expectedRevision?: number;
}
export type LearnMethodMemoryInput = Omit<LearnPersonalMemoryInput, 'kind' | 'scope'> & { scope?: 'case' | 'domain' };
export interface CorrectPersonalMemoryInput {
  subject?: PersonalMemorySubject;
  value: string; kind?: PersonalMemoryKind; scope?: PersonalMemoryScope;
  domains?: string[]; caseIds?: string[]; expiresAt?: string | null;
  purpose?: PersonalMemoryPurpose; identity?: PersonalMemoryIdentity; expectedRevision?: number;
}
export interface PersonalMemoryContextItem {
  key: string; revision: number; value: string; subject: PersonalMemorySubject; level: PersonalMemoryLevel;
  purpose: PersonalMemoryPurpose; scope: PersonalMemoryScope; domains: string[]; caseIds: string[];
  expiresAt: string | null; identity?: PersonalMemoryIdentity;
}
export interface PersonalMemoryContext {
  identities: PersonalMemoryContextItem[]; interactionPolicies: PersonalMemoryContextItem[];
  ownerFacts: PersonalMemoryContextItem[]; methods: PersonalMemoryContextItem[];
  completeness: { complete: boolean; eligibleCount: number; selectedCount: number; omittedCount: number;
    omitted: Array<{ key: string; revision: number; reason: 'context_capacity' }> };
  recentOwnerMessages?: RecentOwnerContext;
  corrections?: PersonalMemoryCorrectionNotice[];
}
export interface RecentOwnerContext {
  messages: Array<{ eventId: string; messageId: string; content: string; occurredAt: string; timezone: string | null;
    totalCharacters: number; truncated: boolean; readWith: { tool: 'read_event'; arguments: { eventId: string; offset: number; limit: number } } }>;
  completeness: { windowLimit: number; complete: boolean; omittedCount: number };
  fingerprint: string;
}
export interface PersonalMemoryOwnerDependencies { caseId: string; domain: string; fingerprint: string }
export interface PersonalMemoryLearnResult {
  entry: PersonalMemoryEntry; applied: boolean;
  reason: 'learned' | 'corrected' | 'duplicate' | 'protected_explicit' | 'retracted' | 'scope_conflict' | 'stale_evidence';
}
