import type { ImageUpload } from '../../shared/chat-images';
import type { ChatFileUpload } from '../../shared/chat-files';
import type { RuntimeMessage, RuntimeView } from '../../shared/runtime-view';
import type { ReasoningPolicy } from '../../shared/types';

export interface MessageSubmissionInput {
  content: string; caseId?: string; replyTo?: string; attachments?: ImageUpload[]; reasoningEffort?: ReasoningPolicy; deviceId?: string;
  files?: ChatFileUpload[];
}

/** Keep a POST receipt visible until the live page can account for it. */
export function messagesAwaitingProjection(receipts: readonly RuntimeMessage[], view: Pick<RuntimeView, 'conversation' | 'messages'>) {
  const { caseId, nextBefore } = view.conversation;
  const ids = new Set(view.messages.map(message => message.id));
  const oldest = nextBefore ? view.messages[0]?.createdAt : undefined;
  return receipts.filter(message => message.caseId !== caseId || !ids.has(message.id) && (!oldest || message.createdAt >= oldest));
}

/** A failed transport keeps the identity of its captured draft; an acknowledged send releases it. */
export function createMessageSubmissions(newId: () => string = () => crypto.randomUUID()) {
  const submissions = new Map<string, { fingerprint: string; requestId: string }>();
  return {
    prepare(key: string, input: MessageSubmissionInput): MessageSubmissionInput & { requestId: string } {
      const fingerprint = JSON.stringify([input.content, input.caseId ?? null, input.replyTo ?? null,
        input.reasoningEffort ?? null, input.deviceId ?? null, (input.attachments ?? []).map(image => [image.name, image.data]),
        (input.files ?? []).map(file => [file.name, file.mediaType, file.data])]);
      let submission = submissions.get(key);
      if (!submission || submission.fingerprint !== fingerprint) {
        submission = { fingerprint, requestId: newId() }; submissions.set(key, submission);
      }
      return { ...input, requestId: submission.requestId };
    },
    accepted(key: string, requestId: string): void {
      if (submissions.get(key)?.requestId === requestId) submissions.delete(key);
    },
  };
}
