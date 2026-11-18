import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { RuntimeMessage } from '../../shared/runtime-view';
import type { DraftImage } from '../lib/chat-images';
import { imagePath } from '../../shared/chat-images';

function SavedImage({ image, onLoad }: { image: NonNullable<RuntimeMessage['attachments']>[number]; onLoad(): void }) {
  const [failed, setFailed] = useState(false);
  return <a className="message-image" href={imagePath(image.id)} target="_blank" rel="noopener noreferrer" title={`打开图片：${image.name}`}>
    {failed ? <span>图片加载失败，点击打开：{image.name}</span> : <img src={imagePath(image.id)} alt={image.name}
      width={image.width} height={image.height} loading="lazy" onLoad={onLoad} onError={() => setFailed(true)} />}
  </a>;
}

export function MessageImages({ images, onLoad }: { images: RuntimeMessage['attachments']; onLoad(): void }) {
  if (!images?.length) return null;
  return <div className="message-images" aria-label="消息中的图片">{images.map(image => <SavedImage key={image.id} image={image} onLoad={onLoad} />)}</div>;
}

function PendingImage({ image, onLoad }: { image: DraftImage; onLoad(): void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const preview = URL.createObjectURL(image.blob);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [image.blob]);
  return <div className="message-image"><img src={url} alt={image.name} onLoad={onLoad} /></div>;
}

export function PendingMessageImages({ images, onLoad }: { images: readonly DraftImage[]; onLoad(): void }) {
  if (!images.length) return null;
  return <div className="message-images" aria-label="消息中的图片">{images.map(image => <PendingImage key={image.id} image={image} onLoad={onLoad} />)}</div>;
}

export function DraftImages({ images, onRemove }: { images: readonly DraftImage[]; onRemove(id: string): void }) {
  if (!images.length) return null;
  return <ul className="draft-images" aria-label="待发送图片">{images.map(image => <li key={image.id}>
    <img src={image.url} alt={image.name} /><span title={image.name}>{image.name}</span>
    <button type="button" className="icon-button" aria-label={`移除图片：${image.name}`} onClick={() => onRemove(image.id)}><X size={14} /></button>
  </li>)}</ul>;
}
