import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaTaskSpec, compatibleMediaModels, mediaStateText, reconcileMediaParameters } from '../client/lib/media.js';
import { mediaModelError, mediaSpecSchema, type MediaModel } from '../shared/media.js';
import type { MediaJob } from '../shared/media.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaResult } from '../client/components/MediaResult.js';

test('media form grants only the reviewed single media request and preserves its exact references and parameters', () => {
  const image = mediaTaskSpec('case-image', { kind: 'image', model: 'actual-model-id', prompt: '  一只在月球读书的猫  ', size: '1024x1024',
    referenceImageIds: ['01921500-3ed4-4235-aabc-62f235c5101f'] });
  assert.deepEqual(image.capabilities, ['media']); assert.equal(image.caseId, 'case-image'); assert.equal(image.workspace, undefined);
  assert.equal(image.objective, '一只在月球读书的猫'); assert.equal(image.media?.prompt, image.objective);
  assert.equal(image.media?.model, 'actual-model-id'); assert.deepEqual(image.media?.referenceImageIds, ['01921500-3ed4-4235-aabc-62f235c5101f']);
  const video = mediaTaskSpec('case-video', { kind: 'video', model: 'video-model', prompt: '镜头缓慢靠近小屋。', seconds: 5, resolution: '720p', aspectRatio: '16:9' });
  assert.deepEqual(video.capabilities, ['media']); assert.equal(video.media?.seconds, 5); assert.equal(video.media?.resolution, '720p');
  assert.throws(() => mediaTaskSpec('case', { kind: 'video', model: 'video', prompt: '测试', size: '1024x1024' }));
});

test('media selection follows catalog capabilities rather than model names and switches for reference-image generation', () => {
  const models: MediaModel[] = [
    { id: 'looks-like-image', name: 'Image model name', tags: ['text-to-video'] },
    { id: 'text', name: 'Text to image', tags: ['text-to-image'] },
    { id: 'edit', name: 'Reference image', tags: ['image-to-image'] },
    { id: 'both', name: 'Both image modes', tags: ['text-to-image', 'image-to-image'] },
    { id: 'animate', name: 'Animate image', tags: ['image-to-video'] },
  ];
  assert.deepEqual(compatibleMediaModels(models, 'image', false).map(model => model.id), ['text', 'both']);
  assert.deepEqual(compatibleMediaModels(models, 'image', true).map(model => model.id), ['edit', 'both']);
  assert.deepEqual(compatibleMediaModels(models, 'video', false).map(model => model.id), ['looks-like-image']);
  assert.deepEqual(compatibleMediaModels(models, 'video', true).map(model => model.id), ['animate']);
});

test('adaptive video ratio is accepted only by a catalog model that actually supports it', () => {
  const media = mediaSpecSchema.parse({ kind: 'video', model: 'adaptive-video', prompt: '画面沿用参考图比例。', aspectRatio: 'adaptive' });
  const model: MediaModel = { id: media.model, name: 'Adaptive fixture', tags: ['text-to-video'], videoGeneration: { aspectRatios: ['adaptive', '16:9'] } };
  assert.equal(mediaModelError(media, model), undefined);
  assert.match(mediaModelError(media, { ...model, videoGeneration: { aspectRatios: ['16:9'] } })!, /比例/);
  assert.equal(mediaSpecSchema.safeParse({ ...media, aspectRatio: 'unsupported' }).success, false);
});

test('explicit silence is an API parameter and cannot be silently accepted by an always-on or unknown-audio model', () => {
  const media = mediaSpecSchema.parse({ kind: 'video', model: 'video', prompt: '安静的海边。', enableAudio: false });
  const model: MediaModel = { id: media.model, name: 'Audio fixture', tags: ['text-to-video'], videoGeneration: { audioMode: 'switchable', defaultEnableAudio: true } };
  assert.equal(mediaTaskSpec('case', media).media?.enableAudio, false);
  assert.equal(mediaModelError(media, model), undefined);
  assert.match(mediaModelError(media, { ...model, videoGeneration: { audioMode: 'always-on', defaultEnableAudio: true } })!, /无法关闭/);
  assert.match(mediaModelError(media, { ...model, videoGeneration: undefined })!, /声音控制能力/);
  assert.equal(mediaModelError({ ...media, enableAudio: undefined }, { ...model, videoGeneration: { audioMode: 'always-on' } }), undefined);
  assert.equal(mediaSpecSchema.safeParse({ kind: 'image', model: 'image', prompt: '海边。', enableAudio: false }).success, false);
});

test('changing video model clears unsupported visual parameters while preserving an explicit audio preference', () => {
  const draft = { size: '', seconds: '3', resolution: '4K', aspectRatio: '21:9', enableAudio: false };
  const model: MediaModel = { id: 'next-video', name: 'Next fixture', tags: ['text-to-video'],
    videoGeneration: { minSeconds: 4, maxSeconds: 15, resolutions: ['768P', '2K'], aspectRatios: ['adaptive', '16:9'], audioMode: 'always-on' } };
  assert.deepEqual(reconcileMediaParameters(draft, model), { ...draft, seconds: '', resolution: '', aspectRatio: '' });
  const compatible = { ...draft, seconds: '5', resolution: '2K', aspectRatio: 'adaptive' };
  assert.deepEqual(reconcileMediaParameters(compatible, model), compatible);
  assert.match(mediaModelError({ kind: 'video', model: model.id, prompt: '静音视频', enableAudio: reconcileMediaParameters(draft, model).enableAudio }, model)!, /无法关闭/);
});

test('media delivery distinguishes submission uncertainty and saving from a completed artifact', () => {
  assert.equal(mediaStateText.unknown, '提交状态待核对');
  assert.equal(mediaStateText.downloading, '正在保存结果');
  assert.equal(mediaStateText.completed, '生成完成');
  assert.notEqual(mediaStateText.submitting, mediaStateText.completed);
});

test('media preview and download use the authenticated local content route instead of exposing a signed upstream URL', () => {
  const job: MediaJob = { id: 'local-job', taskId: 'task', caseId: 'case', kind: 'image', model: 'image', prompt: '生成图片', state: 'completed',
    createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z',
    files: [{ id: 'file', name: 'image.png', mediaType: 'image/png', size: 20, url: 'https://gateway.example/private?token=UPSTREAM_SECRET' }] };
  const html = renderToStaticMarkup(createElement(MediaResult, { job, busy: [], perform: async () => true, onLoad() {} }));
  assert.match(html, /src="\/api\/media\/local-job\/content"/); assert.match(html, /download="image.png"/);
  assert.doesNotMatch(html, /gateway\.example|UPSTREAM_SECRET/);
  const video = renderToStaticMarkup(createElement(MediaResult, { job: { ...job, kind: 'video' }, busy: [], perform: async () => true, onLoad() {} }));
  assert.match(video, /<video/); assert.match(video, /controls=""/); assert.match(video, /preload="metadata"/);
});
