import { createHash } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { Processor } from '@mastra/core/processors';
import { parseObservationGroups, wrapInObservationGroup, type ObserveHooks, type ObserveTransformHooks } from '@mastra/memory/processors';
import type { Store } from '../store.js';
import { isOwnerChatEvent } from './consent.js';
import type { EventInbox, InboxEvent } from './events.js';
import { caseEventPrefix } from './source-context.js';
import type { RecentOwnerContext } from '../../shared/personal-memory.js';

export interface RetiredObservationEvidence {
  eventIds: ReadonlySet<string>;
  values: readonly string[];
}

export interface OwnerObservationSource {
  eventId: string;
  messageId: string;
  content: string;
}

interface ObservationContextOptions {
  store: Pick<Store, 'get'>;
  inbox: Pick<EventInbox, 'get'>;
  sourceAllowed: (caseId: string, event: InboxEvent) => boolean;
  retiredEvidence: (caseId: string) => Promise<RetiredObservationEvidence>;
  historyForCase?: (caseId: string) => Promise<readonly MastraDBMessage[]>;
  observationsForCase?: (caseId: string) => Promise<string | undefined>;
  recentOwnerEvents?: (caseId: string) => readonly InboxEvent[];
  ownerId?: string;
}

interface ProjectedEvent {
  id?: unknown;
  externalId?: unknown;
  caseId?: unknown;
  actor?: unknown;
  kind?: unknown;
  sourceId?: unknown;
  payload?: { messageId?: unknown };
}
type ActorMessageList = Parameters<NonNullable<Processor['processInputStep']>>[0]['messageList'];

// Native thread observation groups are separated by whitespace or a timestamp marker.
const groupSeparator = /^\n\n(?:--- message boundary \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\) ---\n\n)?/;
const policyMarker = /\n<!-- rae-owner-policy:v1:([a-f0-9]{64}) -->$/;

function policyFingerprint(retired: RetiredObservationEvidence): string {
  return createHash('sha256').update(JSON.stringify([[...retired.eventIds].sort(), [...retired.values].sort()])).digest('hex');
}

function stampObservation(text: string, fingerprint: string): string {
  const body = text.replace(/<!--\s*rae-owner-policy:[\s\S]*?-->/g, '').trim();
  return body ? `${body}\n<!-- rae-owner-policy:v1:${fingerprint} -->` : '';
}

function claimsOwnerChat(projected: ProjectedEvent | undefined): boolean {
  return projected?.kind === 'owner.message' && projected.actor === 'owner' && projected.sourceId === 'owner-chat';
}

export function isRetiredObservationSource(source: OwnerObservationSource, retired: RetiredObservationEvidence): boolean {
  return retired.eventIds.has(source.eventId) || retired.values.some(value => source.content.includes(value));
}

/** Verifies native attribution against the durable inbox and public message. */
export class ObservationContext {
  private readonly ownerId: string;
  private readonly observationPolicies = new Map<string, string>();
  private readonly reflectionPolicies = new Map<string, string>();

  constructor(private readonly options: ObservationContextOptions) {
    this.ownerId = options.ownerId ?? 'owner';
  }

  readOwnerMessage(caseId: string, eventId: string): OwnerObservationSource | undefined {
    const event = this.options.inbox.get(eventId);
    if (!event || !isOwnerChatEvent(event) || event.caseId !== caseId || !this.options.sourceAllowed(caseId, event)) return undefined;
    const message = this.options.store.get('messages', event.externalId);
    if (message?.role !== 'user' || message.caseId !== caseId || message.content !== event.payload.content) return undefined;
    return { eventId: event.id, messageId: message.id, content: message.content };
  }

  /** A fingerprint is metadata only. It deliberately notices unsaved new owner directions too. */
  recentOwnerFingerprint(caseId: string): string {
    const originals = (this.options.recentOwnerEvents?.(caseId) ?? []).slice(0, 8).flatMap(event => {
      const source = this.readOwnerMessage(caseId, event.id);
      return source ? [[source.eventId, source.messageId, createHash('sha256').update(source.content).digest('hex')]] : [];
    });
    return createHash('sha256').update(JSON.stringify(originals)).digest('hex');
  }

  /** Raw, verified owner text only; no assistant promises, summaries, task consent, or wider scene access. */
  async recentOwnerContext(caseId: string): Promise<RecentOwnerContext> {
    const retired = await this.options.retiredEvidence(caseId);
    const candidates = (this.options.recentOwnerEvents?.(caseId) ?? []).slice(0, 8);
    const result: RecentOwnerContext = { messages: [], completeness: { windowLimit: 8, complete: true, omittedCount: 0 },
      fingerprint: this.recentOwnerFingerprint(caseId) };
    let remaining = 8_000;
    for (const event of candidates) {
      const source = this.readOwnerMessage(caseId, event.id);
      if (!source || isRetiredObservationSource(source, retired)) continue;
      if (!remaining) { result.completeness.complete = false; result.completeness.omittedCount++; continue; }
      const content = source.content.slice(0, remaining);
      const truncated = content.length !== source.content.length;
      remaining -= content.length;
      result.messages.push({ ...source, content, occurredAt: event.occurredAt,
        timezone: typeof event.payload.timezone === 'string' ? event.payload.timezone : null,
        totalCharacters: source.content.length, truncated,
        readWith: { tool: 'read_event', arguments: { eventId: source.eventId, offset: content.length, limit: 4000 } } });
      if (truncated) result.completeness.complete = false;
    }
    return result;
  }

  private projectedEvent(caseId: string, message: MastraDBMessage): ProjectedEvent | undefined {
    if (message.role !== 'user' || message.threadId !== caseId || message.resourceId !== this.ownerId) return undefined;
    const envelopes = message.content.parts.filter(part => part.type === 'text' && part.text.startsWith(caseEventPrefix));
    const envelope = envelopes[0];
    if (envelopes.length !== 1 || envelope?.type !== 'text') return undefined;
    try { return JSON.parse(envelope.text.slice(caseEventPrefix.length))?.event; }
    catch { return undefined; }
  }

  ownerSourceForMessage(caseId: string, message: MastraDBMessage): OwnerObservationSource | undefined {
    const projected = this.projectedEvent(caseId, message);
    if (typeof projected?.id !== 'string' || projected.caseId !== caseId) return undefined;
    const source = this.readOwnerMessage(caseId, projected.id);
    return source && projected.externalId === source.messageId && projected.payload?.messageId === source.messageId ? source : undefined;
  }

  private shouldVerifySource(caseId: string, message: MastraDBMessage): boolean {
    const projected = this.projectedEvent(caseId, message);
    if (typeof projected?.id !== 'string') return false;
    const original = this.options.inbox.get(projected.id);
    return original ? original.kind === 'owner.message' && original.sourceId === 'owner-chat'
      : claimsOwnerChat(projected);
  }

  async pruneActorHistory(caseId: string, messageList: ActorMessageList): Promise<void> {
    const retired = await this.options.retiredEvidence(caseId);
    const escapedValues = retired.values.map(value => JSON.stringify(value).slice(1, -1));
    const denied: string[] = [];
    let turn: string[] = [];
    let blocked = false;
    for (const message of messageList.get.all.db()) {
      if (message.role === 'user' || message.role === 'signal') {
        if (blocked) denied.push(...turn);
        turn = [];
        blocked = false;
      }
      if (messageList.isNewMessage(message)) continue;
      turn.push(message.id);
      if (blocked) continue;
      const source = this.ownerSourceForMessage(caseId, message);
      if (source ? isRetiredObservationSource(source, retired)
        : this.shouldVerifySource(caseId, message) || claimsOwnerChat(this.projectedEvent(caseId, message))) {
        blocked = true;
      } else if (escapedValues.length) {
        const content = JSON.stringify(message.content);
        blocked = escapedValues.some(value => content.includes(value));
      }
    }
    if (blocked) denied.push(...turn);
    if (denied.length) messageList.removeByIds(denied, { pruned: true });
  }

  readonly beforeObservation: NonNullable<ObserveTransformHooks['beforeObservation']> = async ({ threadId, resourceId, messages }) => {
    if (!threadId || resourceId !== this.ownerId) return { messages: [] };
    this.observationPolicies.delete(threadId);
    const retired = await this.options.retiredEvidence(threadId);
    const previous = await this.options.observationsForCase?.(threadId);
    if (previous && (!this.options.historyForCase
      || await this.filterObservations(threadId, previous, await this.options.historyForCase(threadId), retired) !== previous)) {
      throw new Error('本场景的历史观察须按当前记忆范围重建。');
    }
    const filtered = messages.flatMap(message => {
      const source = this.ownerSourceForMessage(threadId, message);
      if (!source || isRetiredObservationSource(source, retired)) return [];
      // Native IDs still delimit SDK observation ranges. Include the public ID alongside original text for traceability.
      const original: MastraDBMessage = { ...message, content: { format: 2, parts: [{ type: 'text', text: `[来源消息ID ${source.messageId}] ${source.content}` }] } };
      return [original];
    });
    if (filtered.length) this.observationPolicies.set(threadId, policyFingerprint(retired));
    return { messages: filtered };
  };

  readonly hooks: ObserveHooks = {
    beforeObservation: this.beforeObservation,
    afterObservation: ({ threadId, resourceId, observations }) => {
      if (!threadId || resourceId !== this.ownerId) throw new Error('无法核对观察的来源范围。');
      const fingerprint = this.observationPolicies.get(threadId);
      this.observationPolicies.delete(threadId);
      if (!fingerprint) throw new Error('无法核对观察的来源范围。');
      return { observations: stampObservation(observations, fingerprint) };
    },
    onObservationEnd: ({ threadId, error }) => { if (threadId && error) this.observationPolicies.delete(threadId); },
    beforeReflection: async ({ threadId, resourceId, observations }) => {
      if (!threadId || resourceId !== this.ownerId || !this.options.historyForCase) throw new Error('无法核对反思的原始观察来源。');
      this.reflectionPolicies.delete(threadId);
      const retired = await this.options.retiredEvidence(threadId);
      if (!observations || await this.filterObservations(threadId, observations, await this.options.historyForCase(threadId), retired) !== observations) {
        throw new Error('本场景的历史观察须按当前记忆范围重建。');
      }
      this.reflectionPolicies.set(threadId, policyFingerprint(retired));
      return { observations };
    },
    afterReflection: ({ threadId, resourceId, observations }) => {
      if (!threadId || resourceId !== this.ownerId) throw new Error('无法核对反思的原始观察来源。');
      const fingerprint = this.reflectionPolicies.get(threadId);
      this.reflectionPolicies.delete(threadId);
      const groups = parseObservationGroups(observations);
      if (!fingerprint || !groups.length) throw new Error('无法核对反思的原始观察来源。');
      return { observations: groups.map(group => wrapInObservationGroup(
        stampObservation(group.content, fingerprint), group.range, group.id, undefined, group.kind,
      )).join('\n\n') };
    },
    onReflectionEnd: ({ threadId, error }) => { if (threadId && error) this.reflectionPolicies.delete(threadId); },
  };

  async filterObservations(caseId: string, observations: string, messages: readonly MastraDBMessage[],
    retiredEvidence?: RetiredObservationEvidence): Promise<string> {
    if (!observations) return '';
    const groups = parseObservationGroups(observations);
    if (!groups.length) return '';
    const text = observations.trim();
    const groupEnds: number[] = [];
    let offset = 0;
    for (const group of groups) {
      if (offset) {
        const separator = groupSeparator.exec(text.slice(offset));
        if (!separator) return '';
        offset += separator[0].length;
      }
      const rendered = wrapInObservationGroup(group.content, group.range, group.id, undefined, group.kind);
      if (!text.startsWith(rendered, offset)) return '';
      offset += rendered.length;
      groupEnds.push(offset);
    }
    if (offset !== text.length) return '';
    const retired = retiredEvidence ?? await this.options.retiredEvidence(caseId);
    const fingerprint = policyFingerprint(retired);
    const indices = new Map(messages.map((message, index) => [message.id, index]));
    const verified = new Map<string, 'current' | 'retired' | 'invalid'>();
    let retained = 0;
    for (const [index, group] of groups.entries()) {
      const policy = policyMarker.exec(group.content)?.[1];
      if (policy && policy !== fingerprint) break;
      if (retired.values.some(value => group.content.includes(value))) break;
      const rangesAreCurrent = group.range.split(',').every(range => {
        const [from, to, extra] = range.split(':');
        const start = indices.get(from);
        const end = indices.get(to);
        if (extra !== undefined || start === undefined || end === undefined || start > end) return false;
        const originals = messages.slice(start, end + 1).filter(message => this.shouldVerifySource(caseId, message));
        let verifiedCurrent = 0;
        const valid = originals.every(message => {
          if (!verified.has(message.id)) {
            const source = this.ownerSourceForMessage(caseId, message);
            verified.set(message.id, !source ? 'invalid' : isRetiredObservationSource(source, retired) ? 'retired' : 'current');
          }
          const status = verified.get(message.id);
          if (status === 'current') { verifiedCurrent++; return true; }
          // The SDK range is computed before filtering. A matching stamp proves retired inputs were withheld.
          return status === 'retired' && policy === fingerprint;
        });
        return valid && verifiedCurrent > 0;
      });
      // A later observation can depend on previous observations, even when its own raw range is still readable.
      if (!rangesAreCurrent) break;
      retained = groupEnds[index];
    }
    return retained === text.length ? observations : text.slice(0, retained);
  }
}
