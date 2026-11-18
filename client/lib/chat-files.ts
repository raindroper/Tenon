import type { ChatFileUpload } from '../../shared/chat-files';

export interface DraftFile { id: string; file: File }

export async function attachmentData(blob: Blob, failureMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') { reject(new Error(failureMessage)); return; }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = reader.onabort = () => reject(new Error(failureMessage));
    reader.readAsDataURL(blob);
  });
}

export async function fileUpload({ file }: DraftFile): Promise<ChatFileUpload> {
  return { name: file.name, mediaType: file.type || 'application/octet-stream',
    data: await attachmentData(file, `无法读取文件“${file.name}”，请重新添加。`) };
}
