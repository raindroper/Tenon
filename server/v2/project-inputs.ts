import { createHash } from 'node:crypto';
import type { Message } from '../../shared/types.js';
import type { TaskRecord } from '../../shared/task-consent.js';
import type { Store } from '../store.js';
import type { EventInbox } from './events.js';
import type { SourceRegistry } from './sources.js';
import type { ProjectInputFile } from '../../shared/project-contract.js';
import { isOwnerChatEvent } from './consent.js';

/** Source-bound owner messages are task inputs, distinct from optional external evidence. */
export function projectInputContext(task: TaskRecord, store: Store, inbox: EventInbox, sources: Pick<SourceRegistry, 'isEventAllowed'>, sinceRevision = 0) {
  const messages = new Map<string, Message>();
  const sourceEventIds = new Set<string>();
  const approval = task.ownerDecision?.action === 'approve' ? task.ownerDecision : undefined;
  const origins = new Set([
    ...(sinceRevision < 1 ? [task.sourceEventId, approval?.eventId] : []),
    ...(task.requirementUpdates ?? []).filter(update => update.revision > sinceRevision).map(update => update.sourceEventId),
  ]);
  let available = true;
  for (const id of origins) {
    const event = id ? inbox.get(id) : undefined;
    if (approval && id === approval.eventId && (!event || !isOwnerChatEvent(event) || event.externalId !== approval.messageId
      || event.caseId !== approval.caseId || createHash('sha256').update(String(event.payload.content)).digest('hex') !== approval.contentHash)) {
      available = false; continue;
    }
    if (!event || !isOwnerChatEvent(event)) continue;
    sourceEventIds.add(event.id);
    if (!sources.isEventAllowed(event)) { available = false; continue; }
    const original = store.get('messages', event.externalId);
    if (!original || original.role !== 'user' || original.caseId !== event.caseId) continue;
    messages.set(original.id, original);
    const quote = original.replyTo ? store.get('messages', original.replyTo) : undefined;
    if (quote?.role === 'user' && quote.caseId === original.caseId) {
      const quoteEventId = inbox.ownerMessageEventIds([quote.id]).get(quote.id);
      const quoteEvent = quoteEventId ? inbox.get(quoteEventId) : undefined;
      if (quoteEventId) sourceEventIds.add(quoteEventId);
      if (quoteEventId === null || quoteEventId && (!quoteEvent || !isOwnerChatEvent(quoteEvent) || !sources.isEventAllowed(quoteEvent))) {
        available = false; continue;
      }
      messages.set(quote.id, quote);
    }
  }
  return { messages: [...messages.values()], sourceEventIds: [...sourceEventIds], available };
}

/** Re-resolve original owner attachments under the task's current consent on every read. */
export function projectInputs(task: TaskRecord, store: Store, inbox: EventInbox, sources: SourceRegistry) {
  return projectInputContext(task, store, inbox, sources).messages.flatMap(message => (message.files ?? []).map(file => {
    const saved = store.readChatFile(file.id, message.id);
    if (!saved || saved.caseId !== message.caseId) throw new Error('原委托附件已经不可读取：' + file.name);
    const manifest: ProjectInputFile = { id: file.id, messageId: message.id, name: file.name, size: saved.data.length,
      sha256: createHash('sha256').update(saved.data).digest('hex') };
    return { manifest, data: saved.data };
  }));
}
