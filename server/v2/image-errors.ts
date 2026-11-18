import { APICallError } from 'ai';

/** A deterministic rejected image cannot improve through automatic retries. */
export function imageRequestError(error: unknown): string | undefined {
  const seen = new Set<unknown>(); let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (APICallError.isInstance(current) && [400, 415, 422].includes(current.statusCode ?? 0) &&
      /image|vision|图片|视觉|多模态|multimodal|11135/i.test(`${current.message} ${current.responseBody ?? ''}`)) {
      return '模型或网关拒绝了图片请求。请检查图片，或切换支持看图的模型后重发；本次没有丢弃图片改用纯文字回答。';
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
