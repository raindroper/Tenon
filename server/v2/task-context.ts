import { z } from 'zod';
import type { TaskEvidenceRef, TaskRecord } from '../../shared/task-consent.js';
import type { EventInbox, StoredEvent } from './events.js';
import type { SourceRegistry } from './sources.js';
import { evidenceTime, type EvidenceTime } from '../../shared/time.js';

export const MAX_TASK_EVIDENCE_REFS = 30;
const identifier = z.string().trim().min(1).max(300);
const searchSchema = z.object({ sourceCaseId: identifier, sourceId: identifier.optional(), query: z.string().max(200).default(''),
  limit: z.number().int().min(1).max(10).default(5) }).strict();
const pageSchema = z.object({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), limit: z.number().int().min(1).max(4000) }).strict();
export const TASK_SOURCE_KINDS = new Set(['workspace.file', 'owner.source', 'connector.change', 'connector.document_snapshot', 'connector.mail_query', 'connector.mail_read', 'connector.document_read', 'connector.github_read', 'web.search']);
type TaskContextTarget = Pick<TaskRecord, 'spec' | 'evidenceRefs'>;

export interface TaskContextOptions {
  inbox: Pick<EventInbox, 'get' | 'findForCase'>;
  sources: Pick<SourceRegistry, 'isEventAllowed' | 'resolveEventCase'>;
  timezone?: () => string;
}
export interface TaskEvidenceOrigin {
  kind: string;
  actor: StoredEvent['actor'];
  operation: StoredEvent['operation'];
  sourceId: string;
  sourceGeneration?: string;
  sourceCaseId: string;
  title?: string;
  externalId: string;
  occurredAt: string;
  temporal: EvidenceTime;
  basis?: 'gateway_summary';
  untrusted?: true;
  sources?: unknown;
}
export class TaskContextError extends Error {
  constructor(readonly code: 'invalid_scope' | 'unavailable', message: string) { super(message); this.name = 'TaskContextError'; }
}

/** Read-only task evidence access. Task consent remains the sole writer of links.
 * The owner entry point validates the explicitly selected scene against its scene
 * directory; this service never discovers all scenes or treats a link as consent. */
export class TaskContext {
  constructor(private readonly options: TaskContextOptions) {}

  private available(event?: StoredEvent): event is StoredEvent & { caseId: string } {
    if (!event?.caseId || !TASK_SOURCE_KINDS.has(event.kind)) return false;
    if (event.kind === 'owner.source' ? event.actor !== 'owner' : event.actor !== 'external') return false;
    if (!['owner.source', 'web.search'].includes(event.kind) && !event.sourceGeneration) return false;
    if (event.kind === 'web.search' && (event.payload.status !== 'ok' || event.payload.basis !== 'gateway_summary')) return false;
    return this.options.sources.resolveEventCase(event) === event.caseId && this.options.sources.isEventAllowed(event);
  }

  private origin(event: StoredEvent & { caseId: string }): TaskEvidenceOrigin {
    const title = typeof event.payload.title === 'string' ? event.payload.title
      : typeof event.payload.relativePath === 'string' ? event.payload.relativePath : undefined;
    return { kind: event.kind, actor: event.actor, operation: event.operation, sourceId: event.sourceId,
      ...(event.sourceGeneration ? { sourceGeneration: event.sourceGeneration } : {}), sourceCaseId: event.caseId,
      ...(title ? { title: title.slice(0, 200) } : {}), externalId: event.externalId, occurredAt: event.occurredAt,
      temporal: evidenceTime(event, this.options.timezone?.() ?? 'Asia/Shanghai'),
      ...(event.kind === 'web.search' ? { basis: 'gateway_summary' as const, untrusted: true as const, sources: event.payload.sources } : {}) };
  }

  private reference(event: StoredEvent & { caseId: string }): TaskEvidenceRef {
    return { eventId: event.id, sourceId: event.sourceId, sourceCaseId: event.caseId,
      ...(event.sourceGeneration ? { sourceGeneration: event.sourceGeneration } : {}) };
  }

  private content(event: StoredEvent): string {
    // A source's structured envelope may contain fields that are not source text.
    // In particular a deletion has provenance but no captured body to invent.
    if (event.kind === 'connector.github_read') return JSON.stringify(event.payload.result ?? null);
    if (event.kind === 'connector.mail_query') return JSON.stringify(event.payload.messages ?? []);
    return typeof event.payload.content === 'string' ? event.payload.content : '';
  }

  search(input: { sourceCaseId: string; sourceId?: string; query?: string; limit?: number }) {
    const scope = searchSchema.parse(input);
    const events = this.options.inbox.findForCase(scope.sourceCaseId, scope.query, scope.limit, event =>
      this.available(event) && (!scope.sourceId || event.sourceId === scope.sourceId));
    return { events: events.map(event => ({ id: event.id, ...this.origin(event as StoredEvent & { caseId: string }),
      excerpt: this.content(event).slice(0, 500) })) };
  }

  /** Reconstruct exact provenance from durable events, never from model-supplied metadata.
   * Callers must also restrict IDs to this owner turn's exposed results or existing task links. */
  capture(eventIds: readonly string[], allowedSourceCaseIds: readonly string[]): TaskEvidenceRef[] {
    const ids = z.array(identifier).max(MAX_TASK_EVIDENCE_REFS).parse(eventIds);
    const cases = new Set(z.array(identifier).max(MAX_TASK_EVIDENCE_REFS).parse(allowedSourceCaseIds));
    return [...new Set(ids)].map(id => {
      const event = this.options.inbox.get(id);
      if (!this.available(event) || !cases.has(event.caseId)) {
        throw new TaskContextError('invalid_scope', '关联资料必须来自本次明确选择且仍获授权的来源场景。');
      }
      return this.reference(event);
    });
  }

  private permitted(task: TaskContextTarget, event?: StoredEvent): event is StoredEvent & { caseId: string } {
    if (!this.available(event)) return false;
    if (event.caseId === task.spec.caseId) return true;
    return Boolean(task.evidenceRefs?.some(ref => ref.eventId === event.id && ref.sourceId === event.sourceId
      && ref.sourceCaseId === event.caseId && ref.sourceGeneration === event.sourceGeneration));
  }

  canRead(task: TaskContextTarget, eventId: string): boolean {
    return identifier.safeParse(eventId).success && this.permitted(task, this.options.inbox.get(eventId));
  }

  read(task: TaskContextTarget, eventId: string, offset = 0, limit = 4000) {
    identifier.parse(eventId); const page = pageSchema.parse({ offset, limit });
    const event = this.options.inbox.get(eventId);
    // Fetch and verify at the actual read boundary. No stored excerpt,
    // previous search result or formerly valid reference is an access grant.
    if (!this.permitted(task, event)) throw new TaskContextError('unavailable', '当前任务未关联这条资料，或原来源已停用、替换或不再可读。');
    const content = this.content(event);
    return { eventId: event.id, ...this.origin(event), content: content.slice(page.offset, page.offset + page.limit),
      offset: page.offset, total: content.length, nextOffset: page.offset + page.limit < content.length ? page.offset + page.limit : null,
      ...(typeof event.payload.totalCharacters === 'number' ? { sourceTotalCharacters: event.payload.totalCharacters,
        sourceTruncated: event.payload.truncated === true } : {}) };
  }
}
