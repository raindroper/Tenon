import { z } from 'zod';
import type { ProjectDelivery } from './project-contract.js';
import type { ProjectOperation } from './local-project.js';

export const projectFilesCapability = 'project_file_delivery_v1';
export const projectFinalFilesCapability = 'project_final_file_delivery_v1';
export const PROJECT_FILE_CHUNK_BYTES = 256 * 1024;
export const MAX_PROJECT_FILES = 4096;
const privateDirectories = new Set(['.git', '.codex', '.agents', '.aws']);
/** Reserved native/VCS directories are not owner deliverables, including the pinned Linux engine's mount bookkeeping. */
export function isProjectResultPath(value: string): boolean {
  const parts = value.split('/');
  return !parts.some(part => privateDirectories.has(part))
    && !(parts[0] === 'temporary' && /^codex-bwrap-synthetic-mount-targets-\d+$/.test(parts[1] ?? ''));
}
export const projectFilePathSchema = z.string().min(1).max(1024).refine(value =>
  !/[\\:\u0000-\u001f\u007f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..')
  && /^(workspace|temporary|outputs)\//.test(value) && isProjectResultPath(value), '文件路径须在本任务的成果目录内。');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200);
export const projectFileSchema = z.object({ path: projectFilePathSchema, size: z.number().int().nonnegative(), sha256: hash,
  sourcePath: z.string().min(1).max(4000).optional() }).strict();
export const projectFileSelectionSchema = z.object({ fingerprint: hash,
  files: z.array(z.object({ path: z.string().min(1).max(4000), size: z.number().int().nonnegative(), sha256: hash }).strict())
    .min(1).max(MAX_PROJECT_FILES).refine(files => new Set(files.map(file => file.path)).size === files.length, '阶段成果路径不能重复。'),
}).strict();
export type ProjectFileSelection = z.infer<typeof projectFileSelectionSchema>;
const windowsFilePath = projectFilePathSchema.refine(value => isProjectResultPath(value.toLowerCase())
  && value.split('/').every(part => !/[<>"|?*]|[. ]$/.test(part) && !/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)));
const uniquePublishedPaths = (files: readonly { path: string }[]) =>
  new Set(files.map(file => file.path.normalize('NFC').toLowerCase())).size === files.length;
export const projectFinalFileSelectionSchema = z.array(projectFileSchema.omit({ sourcePath: true }).extend({ path: windowsFilePath }))
  .min(1).max(MAX_PROJECT_FILES).refine(uniquePublishedPaths, '最终成果文件名称存在重复或大小写冲突。');
export type ProjectFinalFileSelection = z.infer<typeof projectFinalFileSelectionSchema>;

export function requiresProjectFileDelivery(operation: Pick<ProjectOperation, 'input' | 'delivery'>): boolean {
  return Boolean(operation.input.deliverFiles && (operation.input.spec.serverResources || operation.delivery?.verification?.files.length));
}

/** Canonical fingerprint input shared by the worker and server. The final receipt contains no local source paths. */
export function projectFinalFileIdentity(delivery: ProjectDelivery | undefined, revision: number) {
  const proof = delivery?.verification;
  if (delivery?.version !== 2 || !delivery.request || delivery.request.stage || delivery.missing?.length
    || delivery.requirementsRevision !== revision || !proof?.files.length || proof.requirementsRevision !== revision
    || proof.planHash !== delivery.planHash) return;
  const parsed = projectFinalFileSelectionSchema.safeParse(proof.files.map(file => ({ path: file.publishedPath, size: file.size, sha256: file.sha256 })));
  if (!parsed.success) return;
  const files = parsed.data;
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, proofIdentity: JSON.stringify([revision, proof.planHash, proof.checkedAt,
    proof.checks.map(check => [check.id, check.status, check.toolIds]),
    delivery.evidence?.map(check => [check.id, check.definitionHash, check.requirementsRevision, check.status, check.toolId]), files]) };
}
export const projectFileSnapshotSchema = z.object({ operationId: id, taskId: id, specHash: hash,
  approvalRevision: z.number().int().positive(), requirementsRevision: z.number().int().positive(), checkpoint: hash,
  stageFingerprint: hash.optional(), finalFingerprint: hash.optional() }).strict()
  .refine(value => !value.finalFingerprint || !value.stageFingerprint && value.checkpoint === value.finalFingerprint);
export type ProjectFileSnapshot = z.infer<typeof projectFileSnapshotSchema>;
export const projectFilesManifestSchema = z.object({ snapshot: projectFileSnapshotSchema,
  files: z.array(projectFileSchema).max(MAX_PROJECT_FILES), omittedLinks: z.number().int().nonnegative(),
}).strict().refine(value => uniquePublishedPaths(value.files),
  '成果文件名称存在重复或大小写冲突。');
export type ProjectFilesManifest = z.infer<typeof projectFilesManifestSchema>;
export interface ProjectFileDelivery extends ProjectFilesManifest {
  id: string; createdAt: string;
  /** Explicit, one-time recovery from a previously verified export; never a new execution receipt. */
  recovery?: { kind: 'verified-export'; sourceSha256: string; note: string };
}
export const projectFilesRequestSchema = z.object({ kind: z.literal('project-files'), operationId: id,
  requestId: z.string().uuid(), snapshot: projectFileSnapshotSchema, selection: projectFileSelectionSchema.optional(),
  finalSelection: projectFinalFileSelectionSchema.optional() }).strict()
  .refine(value => value.operationId === value.snapshot.operationId
    && value.snapshot.stageFingerprint === value.selection?.fingerprint && Boolean(value.snapshot.finalFingerprint) === Boolean(value.finalSelection),
  '文件选择与领取快照不一致。');
export type ProjectFilesRequest = z.infer<typeof projectFilesRequestSchema>;
export const projectFilesUploadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin'), requestId: z.string().uuid(), manifest: projectFilesManifestSchema }).strict(),
  z.object({ action: z.literal('chunk'), requestId: z.string().uuid(), deliveryId: hash,
    path: projectFilePathSchema, offset: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil(PROJECT_FILE_CHUNK_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ action: z.literal('commit'), requestId: z.string().uuid(), deliveryId: hash }).strict(),
  z.object({ action: z.literal('error'), requestId: z.string().uuid(), error: z.string().min(1).max(2000) }).strict(),
]);
export type ProjectFilesUpload = z.infer<typeof projectFilesUploadSchema>;
