import type { Processor } from '@mastra/core/processors';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { IMAGE_MEDIA_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES } from '../../shared/chat-images.js';

export interface ResolvedImage { data: Uint8Array; mediaType: string }
export type CaseImageResolver = (id: string, caseId: string) => ResolvedImage | Promise<ResolvedImage>;

const IMAGE_PROTOCOL = 'rae-image:';
const omitted = '［历史图片未附入本轮：为控制上下文体积，优先保留最近图片。本轮未看到这张图片的内容，不得据此猜测；需要查看时，请本人引用原消息。］';

/** Opaque local identifiers, never an externally fetchable URL. */
export function imageReference(id: string): URL {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('图片引用无效。');
  return new URL(`${IMAGE_PROTOCOL}${id}`);
}

/** Mastra otherwise tries to fetch opaque references before its transient hook. */
export function withLocalImageReferences(model: LanguageModelV4): LanguageModelV4 {
  return new Proxy(model, { get(target, property) {
    if (property === 'supportedUrls') return Promise.resolve(target.supportedUrls).then(urls => ({
      ...urls, 'image/*': [...urls['image/*'] ?? [], /^rae-image:/],
    }));
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function imageId(data: string | Uint8Array | URL): string | undefined {
  const value = data instanceof URL ? data.href : typeof data === 'string' ? data : undefined;
  if (!value?.startsWith(IMAGE_PROTOCOL)) return undefined;
  const id = value.slice(IMAGE_PROTOCOL.length);
  if (imageReference(id).href !== value) throw new Error('图片引用无效。');
  return id;
}

/**
 * Hydrate only the provider-bound copy. Native Mastra memory keeps small local
 * references, so follow-ups/restarts reuse the original image without copying
 * base64 into thread history or owner snapshots. The resolver enforces case scope.
 */
export function caseImageContext(caseId: string, resolve?: CaseImageResolver): Processor & { processLLMRequest: NonNullable<Processor['processLLMRequest']> } {
  return { id: 'case-image-context', async processLLMRequest({ prompt, abortSignal }) {
    const candidates = prompt.flatMap((message, messageIndex) => message.role === 'user'
      ? message.content.flatMap((part, partIndex) => {
        const id = part.type === 'file' ? imageId(part.data) : undefined;
        return id ? [{ messageIndex, partIndex, id }] : [];
      }) : []);
    if (!candidates.length) return;
    if (!resolve) throw new Error('图片存储未连接，未将无法读取的图片交给模型。');
    const selected = new Map<string, { image: ResolvedImage; position: string }>();
    const examined = new Set<string>();
    let bytes = 0;
    for (const candidate of [...candidates].reverse()) {
      abortSignal?.throwIfAborted();
      if (examined.has(candidate.id) || selected.size >= MAX_CHAT_IMAGES) continue;
      examined.add(candidate.id);
      const image = await resolve(candidate.id, caseId);
      abortSignal?.throwIfAborted();
      if (!image.data.byteLength || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(image.mediaType)) throw new Error('图片内容或格式无效。');
      if (bytes + image.data.byteLength > MAX_CHAT_IMAGE_BYTES) continue;
      selected.set(candidate.id, { image, position: `${candidate.messageIndex}:${candidate.partIndex}` });
      bytes += image.data.byteLength;
    }
    const locations = new Map(candidates.map(candidate => [`${candidate.messageIndex}:${candidate.partIndex}`, candidate.id]));
    return { prompt: prompt.map((message, messageIndex) => message.role !== 'user' ? message : {
      ...message, content: message.content.map((part, partIndex) => {
        const position = `${messageIndex}:${partIndex}`;
        const id = locations.get(position);
        if (!id) return part;
        const retained = selected.get(id);
        return retained?.position === position && part.type === 'file'
          ? { ...part, data: retained.image.data, mediaType: retained.image.mediaType }
          : { type: 'text' as const, text: retained ? '［同一图片已附在较近的消息中。］' : omitted };
      }),
    }) };
  } };
}
