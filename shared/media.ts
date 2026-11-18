import { z } from 'zod';

export type MediaKind = 'image' | 'video';
export type MediaCapability = 'text-to-image' | 'image-to-image' | 'text-to-video' | 'image-to-video';
export interface MediaModel {
  id: string; name: string; tags: MediaCapability[];
  videoGeneration?: { minSeconds?: number; maxSeconds?: number; defaultSeconds?: number; resolutions?: string[]; defaultResolution?: string;
    aspectRatios?: string[]; defaultAspectRatio?: string; maxPromptLength?: number; audioMode?: string; defaultEnableAudio?: boolean };
}
export const mediaSpecSchema = z.object({
  kind: z.enum(['image', 'video']), model: z.string().trim().min(1).max(200), prompt: z.string().trim().min(1).max(8000),
  referenceImageIds: z.array(z.string().uuid()).max(3).refine(ids => new Set(ids).size === ids.length).optional(),
  size: z.string().max(40).regex(/^\d{2,5}x\d{2,5}$/).optional(),
  seconds: z.number().int().min(1).max(120).optional(), resolution: z.string().trim().min(1).max(40).optional(),
  aspectRatio: z.string().trim().max(30).regex(/^(?:\d{1,3}:\d{1,3}|adaptive)$/).optional(), enableAudio: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'image' && (value.seconds !== undefined || value.resolution !== undefined || value.aspectRatio !== undefined || value.enableAudio !== undefined)) context.addIssue({ code: 'custom', message: '图片不附带视频参数。' });
  if (value.kind === 'video' && (value.size !== undefined || (value.referenceImageIds?.length ?? 0) > 1)) context.addIssue({ code: 'custom', message: '视频最多使用一张参考图，尺寸使用分辨率参数。' });
});
export type MediaSpec = z.infer<typeof mediaSpecSchema>;

/** Shared catalog validation; a structurally valid request still needs actual model support. */
export function mediaModelError(spec: MediaSpec, model: MediaModel | undefined): string | undefined {
  const hasImage = Boolean(spec.referenceImageIds?.length);
  const tag = spec.kind === 'image' ? hasImage ? 'image-to-image' : 'text-to-image' : hasImage ? 'image-to-video' : 'text-to-video';
  if (!model?.tags.includes(tag)) return '所选模型不支持这次媒体生成方式。';
  const video = model.videoGeneration;
  if (spec.seconds !== undefined && (video?.minSeconds !== undefined && spec.seconds < video.minSeconds || video?.maxSeconds !== undefined && spec.seconds > video.maxSeconds)) return '视频时长超出所选模型范围。';
  if (spec.resolution && video?.resolutions?.length && !video.resolutions.includes(spec.resolution)) return '所选模型不支持这一分辨率。';
  if (spec.aspectRatio && video?.aspectRatios?.length && !video.aspectRatios.includes(spec.aspectRatio)) return '所选模型不支持这一画面比例。';
  if (video?.maxPromptLength && Array.from(spec.prompt).length > video.maxPromptLength) return '描述超过所选视频模型的长度限制，请精简后提交。';
  if (spec.enableAudio === false && video?.audioMode === 'always-on') return '所选模型始终生成声音，无法关闭；如需静音，请选择支持关闭声音的模型。';
  if (spec.enableAudio !== undefined && video?.audioMode !== 'always-on' && video?.audioMode !== 'switchable') return '所选模型没有声明可用的声音控制能力，请沿用模型默认或选择其他模型。';
}
export interface MediaFile { id: string; name: string; mediaType: string; size: number; url: string }
export type MediaJobState = 'submitting' | 'queued' | 'running' | 'downloading' | 'completed' | 'failed' | 'unknown' | 'cancelled';
export interface MediaJob {
  id: string; taskId: string; caseId: string; kind: MediaKind; model: string; prompt: string; state: MediaJobState;
  createdAt: string; updatedAt: string; upstreamId?: string; progress?: number; error?: string; files: MediaFile[];
}
export interface MediaCatalog { enabled: boolean; models: MediaModel[]; error?: string }
export const mediaContentPath = (id: string) => `/api/media/${encodeURIComponent(id)}/content`;
