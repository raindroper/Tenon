import { prepareChatImage, supportsChatImage, type DraftImage } from '../lib/chat-images';
import type { DraftFile } from '../lib/chat-files';
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES } from '../../shared/chat-images';
import { MAX_CHAT_FILES, MAX_CHAT_FILE_BYTES, MAX_CHAT_FILES_BYTES, MAX_CHAT_FILE_NAME } from '../../shared/chat-files';

interface AttachmentDraft {
  images: readonly DraftImage[];
  files: readonly DraftFile[];
  pendingImages: number;
  pendingFiles: readonly DraftFile[];
  error: string;
}
const EMPTY: AttachmentDraft = { images: [], files: [], pendingImages: 0, pendingFiles: [], error: '' };
const miB = 1024 * 1024;

/** Owns only unsent attachments. Accepted server messages remain owned by the runtime snapshot. */
export function createAttachmentDrafts(prepare = prepareChatImage, revoke = (url: string) => URL.revokeObjectURL(url)) {
  let drafts: Record<string, AttachmentDraft> = {};
  let active = false; let generation = 0;
  const listeners = new Set<() => void>();
  const update = (key: string, next: AttachmentDraft) => { drafts = { ...drafts, [key]: next }; for (const listener of listeners) listener(); };
  const get = (key: string) => drafts[key] ?? EMPTY;
  return {
    getSnapshot: () => drafts,
    get,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    activate() {
      active = true; const owner = ++generation;
      return () => {
        if (owner !== generation) return;
        active = false; generation++;
        for (const draft of Object.values(drafts)) for (const image of draft.images) revoke(image.url);
        drafts = {};
      };
    },
    async add(key: string, selection: readonly File[]) {
      if (!active || !selection.length) return;
      const initial = get(key);
      const images: File[] = [];
      const files: File[] = [];
      for (const file of selection) (supportsChatImage(file) ? images : files).push(file);
      const fail = (error: string) => update(key, { ...initial, error });
      if (initial.images.length + initial.pendingImages + images.length > MAX_CHAT_IMAGES) {
        return fail(`每条消息最多添加 ${MAX_CHAT_IMAGES} 张图片。`);
      }
      if (initial.files.length + initial.pendingFiles.length + files.length > MAX_CHAT_FILES) {
        return fail(`每条消息最多添加 ${MAX_CHAT_FILES} 个文件。`);
      }
      const invalidName = files.find(file => !file.name.trim() || file.name.length > MAX_CHAT_FILE_NAME);
      if (invalidName) return fail(`文件名须在 1 到 ${MAX_CHAT_FILE_NAME} 个字符之间。`);
      const large = files.find(file => file.size > MAX_CHAT_FILE_BYTES);
      if (large) return fail(`文件“${large.name}”超过 ${MAX_CHAT_FILE_BYTES / miB} MiB。`);
      const fileBytes = [...initial.files, ...initial.pendingFiles].reduce((total, { file }) => total + file.size, 0);
      if (files.reduce((total, file) => total + file.size, fileBytes) > MAX_CHAT_FILES_BYTES) {
        return fail(`每条消息的文件合计最多 ${MAX_CHAT_FILES_BYTES / miB} MiB。`);
      }
      const addedFiles: DraftFile[] = files.map(file => ({ id: crypto.randomUUID(), file }));
      if (!images.length) {
        update(key, { ...initial, files: [...initial.files, ...addedFiles], error: '' });
        return;
      }
      const owner = generation;
      update(key, { ...initial, pendingImages: initial.pendingImages + images.length,
        pendingFiles: [...initial.pendingFiles, ...addedFiles], error: '' });
      const prepared: DraftImage[] = [];
      let error: string | undefined;
      try {
        for (const file of images) {
          prepared.push(await prepare(file));
          if (!active || generation !== owner) return;
        }
        const current = get(key);
        if ([...current.images, ...prepared].reduce((total, image) => total + image.blob.size, 0) > MAX_CHAT_IMAGE_BYTES) throw new Error('这组图片压缩后超过 1 MB，请减少图片或先裁剪。');
      } catch (cause) {
        error = cause instanceof Error ? cause.message : '图片添加失败，请重试。';
      } finally {
        const currentOwner = active && generation === owner;
        if (!currentOwner || error !== undefined) for (const item of prepared) revoke(item.url);
        if (currentOwner) {
          const current = get(key);
          update(key, { ...current, pendingImages: current.pendingImages - images.length,
            pendingFiles: current.pendingFiles.filter(file => !addedFiles.includes(file)),
            ...(error === undefined ? { images: [...current.images, ...prepared], files: [...current.files, ...addedFiles] } : { error }) });
        }
      }
    },
    remove(key: string, ids: readonly string[]) {
      const current = get(key); const selected = new Set(ids);
      for (const image of current.images) if (selected.has(image.id)) revoke(image.url);
      update(key, { ...current, images: current.images.filter(image => !selected.has(image.id)),
        files: current.files.filter(file => !selected.has(file.id)), error: '' });
    },
  };
}
