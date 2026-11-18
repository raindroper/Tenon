import { MockLanguageModelV4 as NativeMockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';

type Options = ConstructorParameters<typeof NativeMockLanguageModelV4>[0];

/** Adapt completed scripted fixtures to the single production streaming transport. */
export function scriptedStream(result: LanguageModelV4GenerateResult): ReadableStream<LanguageModelV4StreamPart> {
  const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: result.warnings }];
  for (const [index, part] of result.content.entries()) {
    if (part.type === 'text' || part.type === 'reasoning') {
      const id = `${part.type}-${index}`;
      parts.push({ type: part.type === 'text' ? 'text-start' : 'reasoning-start', id },
        { type: part.type === 'text' ? 'text-delta' : 'reasoning-delta', id, delta: part.text },
        { type: part.type === 'text' ? 'text-end' : 'reasoning-end', id });
    } else if (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'source' || part.type === 'file' || part.type === 'reasoning-file' || part.type === 'tool-approval-request' || part.type === 'custom') {
      parts.push(part);
    } else {
      throw new Error('Unsupported scripted model result part');
    }
  }
  parts.push({ type: 'finish', finishReason: result.finishReason, usage: result.usage, providerMetadata: result.providerMetadata });
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
}

/** Explicit doStream fixtures keep their gates/errors/chunks unchanged. */
export class MockLanguageModelV4 extends NativeMockLanguageModelV4 {
  constructor(options: Options = {}) {
    let calls = 0;
    const scripted = options.doGenerate;
    super({ ...options, ...(options.doStream || scripted === undefined ? {} : { doStream: async parameters => {
      const index = calls++;
      const result = typeof scripted === 'function' ? await scripted(parameters) : Array.isArray(scripted) ? scripted[index] : scripted;
      return { stream: scriptedStream(result) };
    } }) });
  }
}
