import { ArrowDownToLine, LoaderCircle } from 'lucide-react';
import { mediaContentPath, type MediaJob } from '../../shared/media';
import { api, type Perform } from '../api';
import { mediaStateText } from '../lib/media';

export function MediaResult({ job, busy, perform, onLoad }: { job: MediaJob; busy: readonly string[]; perform: Perform; onLoad(): void }) {
  const active = ['submitting', 'queued', 'running', 'downloading'].includes(job.state);
  const stopping = busy.includes(`media:${job.id}`);
  const file = job.files[0];
  return <div className="media-result" aria-label={`${job.kind === 'image' ? '图片' : '视频'}生成结果`}>
    <p className="media-result-state" role="status">{active && <LoaderCircle size={13} className="spin" />}{mediaStateText[job.state]}
      {active && typeof job.progress === 'number' && Number.isFinite(job.progress) ? ` · ${Math.round(Math.min(100, Math.max(0, job.progress)))}%` : ''}</p>
    {job.error && <p className="field-error">{job.error}</p>}
    {file && <div className="media-file">
      {job.kind === 'image' ? <a href={mediaContentPath(job.id)} target="_blank" rel="noopener noreferrer" title="打开生成图片"><img src={mediaContentPath(job.id)} alt={job.prompt} loading="lazy" onLoad={onLoad} /></a>
        : <video controls preload="metadata" src={mediaContentPath(job.id)} aria-label="生成的视频" onLoadedMetadata={onLoad} />}
      <a className="text-link" href={mediaContentPath(job.id)} download={file.name}><ArrowDownToLine size={14} />下载{job.kind === 'image' ? '图片' : '视频'}</a>
    </div>}
    {active && <button className="text-link" disabled={stopping} onClick={() => void perform(`media:${job.id}`, () => api(`/api/media/${encodeURIComponent(job.id)}/cancel`, 'POST', {}), '已提交取消请求。')}>{stopping ? '正在提交…' : '尝试取消'}</button>}
    {active && <p className="field-note">上游已开始的生成可能无法取消。</p>}
    {job.state === 'unknown' && <p className="field-note">尚不能确认上游是否已经接收请求，系统不会自动重复提交。</p>}
  </div>;
}
