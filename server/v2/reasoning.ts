import type { DeepSeekLanguageModelChatOptions } from '@ai-sdk/deepseek';
import type { ReasoningPolicy, RunReasoning } from '../../shared/types.js';

interface ReasoningContext {
  policy: ReasoningPolicy;
  source?: RunReasoning['source'];
  execution: boolean;
  /** Only the persisted owner message may qualify for the narrow low-effort exception. */
  ownerMessage?: { content: string; replyTo?: string; attachments?: readonly unknown[]; files?: readonly unknown[] };
  hasPriorConversation: boolean;
}

// A closed set of standalone greetings, not a general complexity/intent classifier.
const greeting = /^(?:你好|您好|嗨|哈喽|早上好|早安|下午好|晚上好|晚安|hello|hi|hey)[\s!！。.]*$/iu;

/** Decide once per run, without a classifier model or allowing external text to set parameters. */
export function selectReasoning(input: ReasoningContext): RunReasoning {
  const decision = (effort: RunReasoning['effort'], reason: string): RunReasoning => ({ policy: input.policy, effort, reason, policyVersion: 1, ...(input.source ? { source: input.source } : {}) });
  if (input.policy !== 'auto') return decision(input.policy, input.source === 'message' ? '使用这条消息指定的思考强度。' : '使用本人保存的默认推理强度。');
  const message = input.ownerMessage;
  if (!input.execution && !input.hasPriorConversation && message && !message.replyTo
    && !message.attachments?.length && !message.files?.length && greeting.test(message.content.trim())) {
    return decision('low', '新会话的独立寒暄使用轻量推理。');
  }
  return decision('high', input.execution ? '获准任务使用高强度推理。' : '实质问题、上下文续问或学习默认使用高强度推理。');
}

export function reasoningProviderOptions(decision: Pick<RunReasoning, 'effort'>): { deepseek?: DeepSeekLanguageModelChatOptions } {
  if (!['none', 'low', 'high', 'max'].includes(decision.effort)) return {};
  return { deepseek: decision.effort === 'none'
    ? { thinking: { type: 'disabled' } }
    : { thinking: { type: 'enabled' }, reasoningEffort: decision.effort as 'low' | 'high' | 'max' } };
}
