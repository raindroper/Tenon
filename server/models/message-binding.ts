import type { ModelBinding } from '../../shared/model-connections.js';
import type { Message } from '../../shared/types.js';

/** Legacy owner-message effort becomes part of the immutable request selection, never a second provider override. */
export function bindMessageReasoning(binding: ModelBinding | null | undefined, message?: Pick<Message, 'reasoningEffort'>): ModelBinding | null | undefined {
  const reasoning = message?.reasoningEffort;
  if (!binding || reasoning === undefined || reasoning === binding.selection.reasoning) return binding;
  return { ...binding, selection: { ...binding.selection, reasoning } };
}
