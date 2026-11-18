import { Download, FileText, X } from 'lucide-react';
import { chatFilePath, type ChatFileAttachment } from '../../shared/chat-files';
import type { DraftFile } from '../lib/chat-files';
import { attachmentSize } from '../lib/format';

function FileLabel({ name, size }: { name: string; size: number }) {
  return <><FileText size={18} aria-hidden="true" /><span className="chat-file-label">
    <span title={name}>{name}</span><small>{attachmentSize(size)}</small>
  </span></>;
}

export function MessageFiles({ files, pending }: { files?: readonly ChatFileAttachment[]; pending?: readonly DraftFile[] }) {
  if (!files?.length && !pending?.length) return null;
  return <ul className="message-files" aria-label="消息中的文件">
    {files?.map(({ id, name, size }) => <li key={id}>
      <a className="chat-file" href={chatFilePath(id)} download={name} aria-label={`下载文件：${name}`}>
        <FileLabel name={name} size={size} /><Download size={15} aria-hidden="true" />
      </a>
    </li>)}
    {pending?.map(({ id, file }) => <li className="chat-file" key={id}><FileLabel name={file.name} size={file.size} /></li>)}
  </ul>;
}

export function DraftFiles({ files, onRemove }: { files: readonly DraftFile[]; onRemove(id: string): void }) {
  if (!files.length) return null;
  return <ul className="draft-files" aria-label="待发送文件">{files.map(({ id, file }) => <li className="chat-file" key={id}>
    <FileLabel name={file.name} size={file.size} />
    <button type="button" className="icon-button" aria-label={`移除文件：${file.name}`} onClick={() => onRemove(id)}><X size={14} /></button>
  </li>)}</ul>;
}
