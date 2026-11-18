import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, type ImageUpload } from '../../shared/chat-images';
import { attachmentData } from './chat-files';

const SUPPORTED = new Set<string>(IMAGE_MEDIA_TYPES);
const MAX_INPUT_BYTES = 15 * 1024 * 1024;

export interface DraftImage { id: string; name: string; blob: Blob; url: string }
export const supportsChatImage = (file: File): boolean => SUPPORTED.has(file.type);

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片转换失败，请重新选择。')), type, quality));
}

/** Decode and normalize locally; full-sized originals never enter the request or model history. */
export async function prepareChatImage(file: File): Promise<DraftImage> {
  if (!supportsChatImage(file)) throw new Error('图片仅支持 PNG、JPEG 和 WebP。');
  if (!file.size || file.size > MAX_INPUT_BYTES) throw new Error('请选择不超过 15 MB 的图片。');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`无法读取图片“${file.name}”，请确认文件完整。`); });
  let blob: Blob;
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('图片像素过大，请先裁剪后再发送。');
    const ratio = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片，请更换浏览器重试。');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Prefer lossless screenshots; fall back to WebP only when the payload needs it.
    blob = await encodeCanvas(canvas, 'image/png');
    if (blob.size > MAX_IMAGE_BYTES) blob = await encodeCanvas(canvas, 'image/webp', .86);
    if (blob.size > MAX_IMAGE_BYTES) blob = await encodeCanvas(canvas, 'image/webp', .65);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('压缩后的图片仍超过 512 KB，请裁剪后再发送。');
  } finally { bitmap.close(); }
  return { id: crypto.randomUUID(), name: file.name.slice(0, 200) || '图片', blob, url: URL.createObjectURL(blob) };
}

export async function imageUpload(image: DraftImage): Promise<ImageUpload> {
  return { name: image.name, data: await attachmentData(image.blob, `无法读取图片“${image.name}”，请重新添加。`) };
}
