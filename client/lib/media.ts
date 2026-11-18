import { mediaSpecSchema, type MediaKind, type MediaModel, type MediaSpec, type MediaJobState } from '../../shared/media';
import type { TaskCapability, TaskSpec } from '../../shared/task-consent';

export const capabilityText: Record<TaskCapability, string> = {
  artifact: '准备文本交付', workspace: '处理已授权文件', media: '生成图片或视频', 'local-command': '在指定设备执行命令',
  mail: '发送已明确授权的邮件', github: '处理已授权的 GitHub 仓库', project: '处理本地项目工作区', review: '核对任务所需的回复',
};
export const mediaStateText: Record<MediaJobState, string> = {
  submitting: '正在提交生成请求', queued: '等待生成', running: '正在生成', downloading: '正在保存结果',
  completed: '生成完成', failed: '生成未完成', unknown: '提交状态待核对', cancelled: '已停止',
};
export const mediaKindText = (kind: MediaKind) => kind === 'image' ? '图片' : '视频';
export interface MediaParameterDraft {
  size: string; seconds: string; resolution: string; aspectRatio: string; enableAudio?: boolean;
}

/** Model changes must not retain hidden values missing from the new model's controls. */
export function reconcileMediaParameters(current: MediaParameterDraft, model: MediaModel): MediaParameterDraft {
  const video = model.videoGeneration;
  const seconds = current.seconds && (video?.minSeconds !== undefined && Number(current.seconds) < video.minSeconds || video?.maxSeconds !== undefined && Number(current.seconds) > video.maxSeconds) ? '' : current.seconds;
  const resolution = current.resolution && video?.resolutions?.length && !video.resolutions.includes(current.resolution) ? '' : current.resolution;
  const aspectRatio = current.aspectRatio && video?.aspectRatios?.length && !video.aspectRatios.includes(current.aspectRatio) ? '' : current.aspectRatio;
  // Audio is an explicit content preference: preserve it and report incompatibility instead of silently enabling sound.
  return seconds === current.seconds && resolution === current.resolution && aspectRatio === current.aspectRatio ? current : { ...current, seconds, resolution, aspectRatio };
}
export function compatibleMediaModels(models: readonly MediaModel[], kind: MediaKind, hasReference: boolean): MediaModel[] {
  const capability = kind === 'image' ? hasReference ? 'image-to-image' : 'text-to-image' : hasReference ? 'image-to-video' : 'text-to-video';
  return models.filter(model => model.tags.includes(capability));
}
export function mediaTaskSpec(caseId: string, input: MediaSpec): TaskSpec {
  const media = mediaSpecSchema.parse(input);
  return { caseId, title: `生成${mediaKindText(media.kind)}`, objective: media.prompt,
    expectedOutput: media.kind === 'image' ? '一张符合描述、可预览并下载的图片。' : '一个符合描述、可播放并下载的视频。',
    capabilities: ['media'], media };
}
