/** Shared image-processing limits are independent of the model gateway's request-body policy. */
export const MAX_CHAT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_CHAT_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGE_EDGE = 2048;
export const MAX_PROJECT_SCREENSHOTS = 4;
export const MAX_PROJECT_SCREENSHOT_BYTES = 1024 * 1024;
export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageMediaType = typeof IMAGE_MEDIA_TYPES[number];
export interface ImageUpload { name: string; data: string }
export interface ImageAttachment {
  id: string; name: string; mediaType: ImageMediaType; size: number; width: number; height: number;
}
export const imagePath = (id: string) => `/api/images/${encodeURIComponent(id)}`;
