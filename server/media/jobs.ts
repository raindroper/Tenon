import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Store } from '../store.js';
import { RuntimeInputError } from '../runtime.js';
import type { TaskConsent } from '../v2/consent.js';
import type { TaskRecord } from '../../shared/task-consent.js';
import { mediaContentPath, mediaModelError, mediaSpecSchema, type MediaCatalog, type MediaJob, type MediaSpec } from '../../shared/media.js';
import { MAX_CHAT_IMAGE_BYTES } from '../../shared/chat-images.js';
import { HubMediaError, type HubImageSource, type HubMediaClient, type HubVideoStatus, type MediaContent } from './hub-media.js';

export type MediaBackend = Pick<HubMediaClient, 'catalog' | 'generateImage' | 'openImage' | 'submitVideo' | 'videoStatus' | 'downloadVideo' | 'cancelVideo'>;
export interface StoredMediaJob extends MediaJob {
  imageSource?: HubImageSource; localPath?: string; nextPollAt?: number; failures?: number;
  /** Submission snapshots; historical jobs belong to requirement version 1. */
  taskRevision?: number; requirementsRevision?: number; specHash?: string;
  /** Confirmed there is no Hub output to preserve. A private file also frees the queue. */
  videoOutputSettled?: true;
}
interface MediaJobsOptions { store: Store; consent: TaskConsent; client: MediaBackend; dataDir: string; assertActive(): void; onResult?(): void }
const now = () => new Date().toISOString();
const terminal = new Set<MediaJob['state']>(['completed', 'failed', 'unknown', 'cancelled']);
const needsVideoSettlement = (job: StoredMediaJob) => job.kind === 'video' && !job.files.length && !job.videoOutputSettled;
const waitingCancellation = (status: HubVideoStatus) => status.status === 'failed' && !status.hasOutput && status.error?.code === 'cancelled'
  && status.error.message === 'cancelled while queued (未提交到上游，未扣费)';
const canPoll = (job: StoredMediaJob) => !terminal.has(job.state) || job.state === 'cancelled' && Boolean(job.upstreamId) && needsVideoSettlement(job);

/** Durable media handoff over the existing task permission and gateway APIs. No model loop. */
export class MediaJobs {
  private readonly controllers = new Map<string, AbortController>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private polling = false;
  private closed = false;
  constructor(private readonly options: MediaJobsOptions) {}
  list(): MediaJob[] {
    return this.options.store.list('mediaJobs').map(job => {
      const blocked = terminal.has(job.state) && needsVideoSettlement(job);
      const error = [job.error, blocked ? '原视频尚未保存私有副本，也未确认无可保存产物。为保护产物，后续视频会等待；可在 Hub 核对原任务。' : undefined].filter(Boolean).join(' ');
      return { id: job.id, taskId: job.taskId, caseId: job.caseId, kind: job.kind,
        model: job.model, prompt: job.prompt, state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt, files: job.files,
        ...(job.upstreamId ? { upstreamId: job.upstreamId } : {}), ...(job.progress !== undefined ? { progress: job.progress } : {}), ...(error ? { error } : {}) };
    });
  }
  blocksVideo(taskId: string): boolean { return this.options.store.list('mediaJobs').some(job => job.taskId !== taskId && needsVideoSettlement(job)); }
  operationForTask(taskId: string): StoredMediaJob | undefined {
    return this.options.store.get('mediaJobs', createHash('sha256').update(`media:${taskId}`).digest('hex'));
  }
  catalog(signal = new AbortController().signal): Promise<MediaCatalog> { return this.options.client.catalog(signal); }
  private save(job: StoredMediaJob, notify = true): StoredMediaJob {
    this.options.assertActive(); const saved = this.options.store.put('mediaJobs', { ...job, updatedAt: now() });
    if (notify && terminal.has(saved.state)) this.resultChanged();
    return saved;
  }
  private resultChanged(): void {
    try { this.options.onResult?.(); }
    catch { /* A failed wake-up hint cannot undo a durable receipt; the next task tick reconciles it. */ }
  }
  recover(): void {
    for (const item of this.options.store.list('mediaJobs')) {
      if (terminal.has(item.state)) {
        if (canPoll(item)) this.save({ ...item, nextPollAt: 0 });
        else this.resultChanged();
        continue;
      }
      if (item.upstreamId || item.imageSource) this.save({ ...item, nextPollAt: 0 });
      else {
        this.save({ ...item, state: 'unknown', error: '上次提交中断，无法确认网关是否已受理；不会自动重复生成，请先查看Hub记录。' });
      }
    }
  }
  async validate(spec: MediaSpec, caseId: string): Promise<void> {
    const catalog = await this.catalog();
    if (!catalog.enabled) throw new RuntimeInputError(409, 'Hub媒体模块尚未启用。');
    const model = catalog.models.find(item => item.id === spec.model);
    const error = mediaModelError(spec, model);
    if (error) throw new RuntimeInputError(400, error);
    let total = 0;
    for (const id of spec.referenceImageIds ?? []) {
      const image = this.options.store.readImage(id);
      if (!image || image.caseId !== caseId) throw new RuntimeInputError(409, '参考图不存在或不属于当前主题。');
      total += image.data.length;
    }
    if (total > MAX_CHAT_IMAGE_BYTES) throw new RuntimeInputError(400, '参考图片合计超过1MB，请减少参考图。');
  }
  private references(spec: MediaSpec, caseId: string): string[] {
    return (spec.referenceImageIds ?? []).map(id => {
      const image = this.options.store.readImage(id);
      if (!image || image.caseId !== caseId) throw new RuntimeInputError(409, '参考图已不可用。');
      return `data:${image.attachment.mediaType};base64,${image.data.toString('base64')}`;
    });
  }
  async submit(task: TaskRecord, parentSignal: AbortSignal): Promise<MediaJob> {
    const id = createHash('sha256').update(`media:${task.id}`).digest('hex');
    if (this.closed) throw new Error('媒体连接正在关闭。');
    parentSignal.throwIfAborted();
    const approved = this.options.consent.assertApproved(task.id, task.spec.caseId, 'media', task.revision, task.requirementsRevision ?? 1);
    if (!isDeepStrictEqual(approved.spec.media, task.spec.media)) throw new RuntimeInputError(409, '媒体操作不能更换本人批准的生成参数。');
    const spec = mediaSpecSchema.parse(task.spec.media);
    const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    const existing = this.options.store.get('mediaJobs', id);
    if (existing) {
      if (existing.taskId !== task.id || existing.caseId !== task.spec.caseId || existing.kind !== spec.kind
        || existing.model !== spec.model || existing.prompt !== spec.prompt || existing.specHash && existing.specHash !== specHash) {
        throw new RuntimeInputError(409, '既有媒体操作不能更换原任务或生成参数。');
      }
      return this.list().find(item => item.id === id)!;
    }
    await this.validate(spec, task.spec.caseId); parentSignal.throwIfAborted();
    this.options.consent.assertApproved(task.id, task.spec.caseId, 'media', task.revision, task.requirementsRevision ?? 1);
    const controller = new AbortController(); const signal = AbortSignal.any([parentSignal, controller.signal]); this.controllers.set(id, controller);
    let job: StoredMediaJob = { id, taskId: task.id, caseId: task.spec.caseId, kind: spec.kind, model: spec.model, prompt: spec.prompt,
      taskRevision: task.revision, requirementsRevision: task.requirementsRevision ?? 1, specHash,
      state: 'submitting', createdAt: now(), updatedAt: now(), files: [] };
    this.options.store.insert('mediaJobs', job); // Commit before the potentially paid POST.
    const operation = (async () => {
      try {
        const references = this.references(spec, job.caseId);
        signal.throwIfAborted(); this.options.consent.assertApproved(task.id, task.spec.caseId, 'media', task.revision, task.requirementsRevision ?? 1);
        if (spec.kind === 'image') {
          const result = await this.options.client.generateImage({ model: spec.model, prompt: spec.prompt, ...(spec.size ? { size: spec.size } : {}), ...(references.length ? { image: references } : {}) }, signal);
          job = { ...job, imageSource: result.source, state: 'downloading' }; job = this.save(job);
          job = await this.download(job, await this.options.client.openImage(result.source, signal), signal);
        } else {
          const result = await this.options.client.submitVideo({ model: spec.model, prompt: spec.prompt,
            ...(spec.seconds !== undefined ? { seconds: spec.seconds } : {}), ...(spec.resolution ? { resolution: spec.resolution } : {}),
            ...(spec.aspectRatio ? { aspect_ratio: spec.aspectRatio } : {}), ...(spec.enableAudio !== undefined ? { enable_audio: spec.enableAudio } : {}),
            ...(references[0] ? { image: references[0] } : {}) }, signal);
          job = { ...job, upstreamId: result.id, state: 'queued', nextPollAt: Date.now() + 5000 }; job = this.save(job);
        }
      } catch (error) {
        const known = Boolean(job.upstreamId || job.imageSource);
        const permanent = error instanceof HubMediaError && !error.retryable;
        const definitelyNotSubmitted = error instanceof HubMediaError && !error.uncertain;
        let state: MediaJob['state'] = definitelyNotSubmitted ? 'failed' : 'unknown';
        if (known) state = permanent ? 'failed' : job.kind === 'video' ? 'queued' : 'downloading';
        job = this.save({ ...job, state, ...(job.kind === 'video' && !known && definitelyNotSubmitted ? { videoOutputSettled: true as const } : {}),
          error: error instanceof HubMediaError ? error.message : known ? '产物接收暂未完成，将只重试获取，不会重新生成。' : '提交结果无法确认，不会自动重复生成；请先查看Hub记录。', nextPollAt: Date.now() + 10000 });
      } finally { this.controllers.delete(id); }
      return this.list().find(item => item.id === id)!;
    })();
    this.active.add(operation); try { return await operation; } finally { this.active.delete(operation); }
  }
  private async download(job: StoredMediaJob, content: MediaContent, signal: AbortSignal): Promise<StoredMediaJob> {
    const directory = join(this.options.dataDir, 'media'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${job.id}.bin`); const temporary = join(directory, `${job.id}.part`);
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    let bytes = 0;
    const maximum = job.kind === 'image' ? 20 * 1024 * 1024 : 100 * 1024 * 1024;
    try {
      await pipeline(Readable.fromWeb(content.body as never), new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length; done(bytes > maximum ? new Error('生成产物超过文件接收上限。') : null, chunk);
      } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      if (!bytes) throw new Error('产物为空。');
      const file = await open(temporary, 'r+'); try { await file.sync(); } finally { await file.close(); }
      signal.throwIfAborted(); await rename(temporary, path);
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    return this.complete(job, path, content.mediaType, bytes);
  }
  private complete(job: StoredMediaJob, path: string, mediaType: string, bytes: number): StoredMediaJob {
    const extension = mediaType === 'video/mp4' ? 'mp4' : mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png';
    const latest = this.options.store.get('mediaJobs', job.id) ?? job;
    const { imageSource: _source, ...retained } = latest;
    const saved = this.save({ ...retained, localPath: path, state: latest.state === 'cancelled' ? 'cancelled' : 'completed', error: latest.state === 'cancelled' ? latest.error : undefined, progress: 100,
      files: [{ id: job.id, name: `${job.kind}-${job.id.slice(0, 10)}.${extension}`, mediaType, size: bytes, url: mediaContentPath(job.id) }] });
    return saved;
  }
  private async recoverFile(job: StoredMediaJob): Promise<boolean> {
    const path = join(this.options.dataDir, 'media', `${job.id}.bin`);
    let file;
    try {
      file = await open(path, 'r'); const info = await file.stat(); const header = Buffer.alloc(12); await file.read(header, 0, 12, 0);
      const mime = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : header[0] === 255 && header[1] === 216 ? 'image/jpeg'
        : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
        : header.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4' : undefined;
      if (!mime || !info.size || (job.kind === 'video') !== (mime === 'video/mp4')) return false;
      this.complete(job, path, mime, info.size); return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    finally { await file?.close(); }
  }
  async tick(): Promise<void> {
    if (this.closed || this.polling) return; this.polling = true;
    try {
      for (const item of this.options.store.list('mediaJobs')) {
        if (this.closed || !canPoll(item) || this.controllers.has(item.id) || (item.nextPollAt ?? 0) > Date.now()) continue;
        const controller = new AbortController(); this.controllers.set(item.id, controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
        const operation = (async () => {
          let job = item;
          try {
            if (await this.recoverFile(job)) return;
            if (job.imageSource) job = await this.download(job, await this.options.client.openImage(job.imageSource, signal), signal);
            else if (job.upstreamId) {
              const upstreamId = job.upstreamId;
              const result = await this.options.client.videoStatus(upstreamId, signal);
              signal.throwIfAborted();
              if (result.id !== upstreamId) throw new Error('Hub returned another video task');
              const latest = this.options.store.get('mediaJobs', job.id);
              if (!latest || !canPoll(latest)) return;
              job = latest;
              if (result.status === 'completed' || result.hasOutput) job = await this.download(job, await this.options.client.downloadVideo(upstreamId, signal), signal);
              else if (waitingCancellation(result) || result.status === 'failed' && !result.hasOutput && ['invalid_request', 'upstream_error'].includes(result.error?.code ?? '')) {
                job = this.save({ ...job, state: job.state === 'cancelled' || waitingCancellation(result) ? 'cancelled' : 'failed',
                  videoOutputSettled: true, error: result.error?.message });
              } else if (job.state === 'cancelled') {
                // The upstream worker can still advance a locally cancelled queue item.
                this.save({ ...job, nextPollAt: Date.now() + 60000 });
              } else if (result.status === 'failed') {
                job = this.save({ ...job, state: 'failed', error: result.error?.message ?? '视频生成失败。' });
              } else this.save({ ...job, state: result.status === 'queued' ? 'queued' : 'running', nextPollAt: Date.now() + 10000, error: undefined });
            }
          } catch (error) {
            const latest = this.options.store.get('mediaJobs', job.id);
            if (!this.closed && latest && canPoll(latest)) {
              const permanent = error instanceof HubMediaError && !error.retryable;
              this.save({ ...latest, ...(permanent && latest.state !== 'cancelled' ? { state: 'failed' as const } : {}), failures: (latest.failures ?? 0) + 1,
                nextPollAt: Date.now() + Math.min(300000, 15000 * 2 ** Math.min(latest.failures ?? 0, 5)),
                error: permanent ? `${error.message} 原任务引用已保留，不会重新生成。` : '进度或产物暂未取回，将继续查询已有任务，不会重新生成。' });
            }
          } finally { this.controllers.delete(item.id); }
        })();
        this.operations.set(item.id, operation);
        this.active.add(operation); try { await operation; } finally { this.active.delete(operation); this.operations.delete(item.id); }
      }
    } finally { this.polling = false; }
  }
  async cancel(id: string): Promise<MediaJob> {
    this.options.assertActive();
    const job = this.options.store.get('mediaJobs', id); if (!job) throw new RuntimeInputError(404, '媒体任务不存在。');
    if (terminal.has(job.state)) return this.list().find(item => item.id === id)!;
    if (!job.upstreamId) throw new RuntimeInputError(409, '生成请求已发送，当前无法确认上游可取消；将继续接收结果。');
    try {
      const result = await this.options.client.cancelVideo(job.upstreamId, new AbortController().signal);
      const latest = this.options.store.get('mediaJobs', id) ?? job;
      if (terminal.has(latest.state)) return this.list().find(item => item.id === id)!;
      if (result.id !== job.upstreamId || result.status !== 'failed' || result.error?.code.toLowerCase() !== 'cancelled') throw new Error('Hub cancellation unconfirmed');
      const safe = waitingCancellation(result);
      this.save({ ...latest, state: 'cancelled', ...(safe ? { videoOutputSettled: true as const } : {}),
        error: safe ? 'Hub 已确认任务仍在本地排队且未提交上游。' : 'Hub 已响应取消，但上游仍可能生成。将继续核对原任务并保留可取回的产物。',
        nextPollAt: Date.now() + 10000 }, false);
      if (safe) this.controllers.get(id)?.abort();
      await this.operations.get(id);
      this.resultChanged();
      return this.list().find(item => item.id === id)!;
    } catch (error) { throw new RuntimeInputError(409, error instanceof HubMediaError ? error.message : '当前无法取消，将继续查询已有任务。'); }
  }
  async content(id: string) {
    const job = this.options.store.get('mediaJobs', id);
    if (!job?.localPath || !job.files[0]) throw new RuntimeInputError(404, '媒体产物尚未就绪。');
    const info = await stat(job.localPath); return { path: job.localPath, ...job.files[0], size: info.size };
  }
  async close(): Promise<void> {
    this.closed = true; for (const controller of this.controllers.values()) controller.abort();
    while (this.active.size) await Promise.allSettled([...this.active]);
  }
}
