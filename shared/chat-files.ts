export const MAX_CHAT_FILES = 4;
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_FILES_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_FILE_NAME = 200;

export interface ChatFileUpload {
  name: string;
  mediaType: string;
  data: string;
}

export interface ChatFileAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export const chatFilePath = (id: string): string => `/api/chat/files/${encodeURIComponent(id)}`;
