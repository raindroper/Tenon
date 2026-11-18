import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import PQueue from 'p-queue';
import { z } from 'zod';
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_PROJECT_SCREENSHOT_BYTES,
  type ImageAttachment, type ImageUpload } from '../../shared/chat-images.js';
import { RuntimeInputError } from '../runtime.js';

const maxEncodedBytes = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const imageUpload = (encodedBytes: number) => z.object({
  name: z.string().trim().min(1).max(200).refine(value => !/[\\/\x00-\x1f]/.test(value)),
  data: z.string().min(4).max(encodedBytes).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export const imageUploadsInput = z.array(imageUpload(maxEncodedBytes)).max(MAX_CHAT_IMAGES)
  .refine(images => images.reduce((size, image) => size + Buffer.byteLength(image.data, 'base64'), 0) <= MAX_CHAT_IMAGE_BYTES, '每条消息的图片合计不能超过 1 MB。');
export const projectScreenshotInput = imageUpload(Math.ceil(MAX_PROJECT_SCREENSHOT_BYTES / 3) * 4);
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PreparedImage { attachment: ImageAttachment; data: Buffer }
// Bound native decoding on the small test host; uploads are processed before any durable write.
const decoder = new PQueue({ concurrency: 1 });
export async function prepareImages(input: ImageUpload[] = []): Promise<PreparedImage[]> {
  const images = imageUploadsInput.parse(input);
  const prepared = await prepare(images, MAX_IMAGE_BYTES);
  if (prepared.reduce((size, image) => size + image.data.length, 0) > MAX_CHAT_IMAGE_BYTES) throw new RuntimeInputError(400, '处理后的图片合计超过 1 MB，请减少图片。');
  return prepared;
}

export async function prepareProjectScreenshot(input: ImageUpload): Promise<PreparedImage> {
  const image = projectScreenshotInput.parse(input);
  if (!Buffer.from(image.data, 'base64').subarray(0, 8).equals(pngHeader)) throw new RuntimeInputError(400, '项目截图必须为 PNG。');
  return (await prepare([image], MAX_PROJECT_SCREENSHOT_BYTES))[0];
}

async function prepare(images: ImageUpload[], maxBytes: number): Promise<PreparedImage[]> {
  if (!images.length) return [];
  if (decoder.size >= 4) throw new RuntimeInputError(409, '图片正在处理中，请稍后再发。');
  return decoder.add(async () => {
    const prepared: PreparedImage[] = [];
    for (const image of images) {
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.length > maxBytes || bytes.toString('base64') !== image.data) throw new RuntimeInputError(400, `图片编码无效或超过 ${maxBytes / 1024} KB。`);
      const png = bytes.subarray(0, 8).equals(pngHeader);
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!png && !jpeg && !webp) throw new RuntimeInputError(400, '仅支持 PNG、JPEG 和 WebP 图片。');
      try {
        const pipeline = sharp(bytes, { limitInputPixels: 8 * 1024 * 1024, failOn: 'warning' }).timeout({ seconds: 5 });
        const metadata = await pipeline.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
        const normalized = pipeline.rotate().resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true });
        let output = await normalized.toBuffer({ resolveWithObject: true });
        // Decoding/re-encoding strips EXIF/location metadata and rejects broken images.
        if (output.data.length > maxBytes) output = await normalized.webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
        if (output.data.length > maxBytes) throw new RuntimeInputError(400, `图片处理后仍超过 ${maxBytes / 1024} KB，请裁剪后发送。`);
        const mediaType = output.info.format === 'jpeg' ? 'image/jpeg' : output.info.format === 'png' ? 'image/png' : 'image/webp';
        prepared.push({ attachment: { id: randomUUID(), name: image.name, mediaType, size: output.data.length, width: output.info.width, height: output.info.height }, data: output.data });
      } catch (error) {
        if (error instanceof RuntimeInputError) throw error;
        throw new RuntimeInputError(400, '图片无法解码、已损坏或尺寸过大，请重新导出后发送。');
      }
    }
    return prepared;
  }) as Promise<PreparedImage[]>;
}
