import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { mediaModelError, mediaSpecSchema, type MediaCatalog, type MediaKind, type MediaSpec } from '../../shared/media';
import type { RuntimeCase } from '../../shared/runtime-view';
import { imagePath, type ImageAttachment } from '../../shared/chat-images';
import { api } from '../api';
import { compatibleMediaModels, mediaKindText, mediaTaskSpec, reconcileMediaParameters, type MediaParameterDraft } from '../lib/media';
import { initialSceneChoice, NEW_SCENE, openSceneChoices, sceneCreationRequest, type SceneCreationAttempt } from '../state/ui-state';
import type { PanelContext } from './types';

export function MediaRequestPanel({ kind, draft = '', initialCaseId, runtime, perform, busy, onClose, onPanelSubmitted }: PanelContext & {
  kind: MediaKind; draft?: string; initialCaseId?: string | null;
}) {
  const cases = openSceneChoices(runtime.cases);
  const [caseId, setCaseId] = useState(() => initialSceneChoice(cases, initialCaseId));
  const [prompt, setPrompt] = useState(draft);
  const [modelId, setModelId] = useState('');
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [parameters, setParameters] = useState<MediaParameterDraft>({ size: '', seconds: '', resolution: '', aspectRatio: '' });
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(''); const [reload, setReload] = useState(0);
  const [referencePage, setReferencePage] = useState<{ caseId: string; images: ImageAttachment[]; error?: string } | null>(null);
  const [reloadReferences, setReloadReferences] = useState(0);
  const createdCase = useRef<string | null>(null);
  const creationAttempt = useRef<SceneCreationAttempt | null>(null);
  const submission = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const selectedOpenCase = cases.some(item => item.id === caseId);
  const referenceCaseId = selectedOpenCase && runtime.cases.some(item => item.id === caseId) ? caseId : '';
  useEffect(() => {
    const controller = new AbortController(); setCatalog(null); setCatalogError('');
    void api<MediaCatalog>('/api/media/models', 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalog(value);
    }).catch(cause => { if (!controller.signal.aborted) setCatalogError(cause instanceof Error ? cause.message : '暂时无法读取生成模型。'); });
    return () => controller.abort();
  }, [reload, runtime.settings.apiBaseUrl]);
  useEffect(() => {
    if (!referenceCaseId) return;
    const controller = new AbortController();
    void api<ImageAttachment[]>(`/api/cases/${encodeURIComponent(referenceCaseId)}/images`, 'GET', undefined, controller.signal).then(images => {
      if (!controller.signal.aborted) setReferencePage({ caseId: referenceCaseId, images });
    }).catch(cause => {
      if (!controller.signal.aborted) setReferencePage({ caseId: referenceCaseId, images: [], error: cause instanceof Error ? cause.message : '暂时无法读取参考图。' });
    });
    return () => controller.abort();
  }, [referenceCaseId, reloadReferences]);
  const models = compatibleMediaModels(catalog?.models ?? [], kind, referenceIds.length > 0);
  const selected = models.find(model => model.id === modelId) ?? models[0];
  useEffect(() => { if (selected) setParameters(current => reconcileMediaParameters(current, selected)); }, [selected]);
  const { size, seconds, resolution, aspectRatio, enableAudio } = parameters;
  function updateParameter<K extends keyof MediaParameterDraft>(key: K, value: MediaParameterDraft[K]) {
    setParameters(current => ({ ...current, [key]: value }));
  }
  const caseReferences = referencePage?.caseId === referenceCaseId ? referencePage : null;
  const references = caseReferences?.images ?? [];
  const request: MediaSpec = { kind, model: selected?.id ?? '', prompt,
    ...(referenceIds.length ? { referenceImageIds: referenceIds } : {}), ...(kind === 'image' && size.trim() ? { size: size.trim() } : {}),
    ...(kind === 'video' ? { ...(seconds.trim() ? { seconds: Number(seconds) } : {}), ...(resolution.trim() ? { resolution: resolution.trim() } : {}),
      ...(aspectRatio.trim() ? { aspectRatio: aspectRatio.trim() } : {}), ...(enableAudio !== undefined ? { enableAudio } : {}) } : {}) };
  const parsed = mediaSpecSchema.safeParse(request);
  const modelError = parsed.success && selected ? mediaModelError(parsed.data, selected) : undefined;
  const saving = busy.includes('task-request');
  const caseActive = caseId === NEW_SCENE || selectedOpenCase;
  const ready = catalog?.enabled && !catalog.error && !catalogError && selected && parsed.success && !modelError && caseActive;
  const video = selected?.videoGeneration;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!ready || !parsed.success || saving) return;
    let targetCaseId = caseId === NEW_SCENE ? createdCase.current : caseId;
    const accepted = await perform('task-request', async () => {
      if (!targetCaseId) {
        const input = { title: `生成${mediaKindText(kind)}`, objective: parsed.data.prompt, domain: 'personal' };
        const item = await api<RuntimeCase>('/api/cases', 'POST', sceneCreationRequest(input, creationAttempt));
        targetCaseId = item.id; createdCase.current = item.id;
      }
      const spec = mediaTaskSpec(targetCaseId, parsed.data); const fingerprint = JSON.stringify(spec);
      if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, requestId: crypto.randomUUID() };
      await api('/api/tasks', 'POST', { requestId: submission.current.requestId, spec });
    }, `已授权本次${mediaKindText(kind)}生成。`);
    if (accepted && targetCaseId) onPanelSubmitted(targetCaseId);
  }
  return <form className="form-stack media-request-form" onSubmit={event => void submit(event)}>
    <p className="field-note">提交即允许按下面的描述和参数生成一{kind === 'image' ? '张图片' : '个视频'}，结果会出现在这段对话里。</p>
    <fieldset className="form-stack" disabled={saving}>
      <label>关联场景<select required value={caseId} onChange={event => { setCaseId(event.target.value); setReferencePage(null); setReferenceIds([]); }}>
        <option value="" disabled>选择场景</option>
        {caseId && !caseActive && <option value={caseId} disabled>当前场景已停止或不可用</option>}
        {cases.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        <option value={NEW_SCENE}>为本次生成新建场景</option>
      </select></label>
      {!catalog && !catalogError ? <p className="field-note" role="status"><LoaderCircle size={13} className="spin" /> 正在读取生成模型…</p> : null}
      {catalogError || catalog?.error || catalog && !catalog.enabled ? <div className="field-error" role="alert"><p>{catalogError || catalog?.error || '媒体生成暂未连接。'}</p><button className="text-link" type="button" onClick={() => setReload(value => value + 1)}>重新连接</button></div> : null}
      <label>生成模型<select value={selected?.id ?? ''} required onChange={event => setModelId(event.target.value)}>
        {!models.length && <option value="">暂无可用{mediaKindText(kind)}模型</option>}{models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select></label>
      <label>想生成什么<textarea autoFocus required rows={5} maxLength={8000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={kind === 'image' ? '描述画面、主体、风格，以及你在意的细节…' : '描述主体、动作、场景和镜头变化…'} /></label>
      <details className="output-settings form-stack"><summary>参考图与参数（可选）</summary>
        <div className="form-stack media-parameters">
          {references.length ? <fieldset className="form-stack"><legend>使用对话里的参考图{kind === 'video' ? '（最多一张）' : '（最多三张）'}</legend><div className="media-reference-grid">{references.map(image => <label key={image.id} className="media-reference">
            <input type="checkbox" checked={referenceIds.includes(image.id)} disabled={!referenceIds.includes(image.id) && referenceIds.length >= (kind === 'video' ? 1 : 3)}
              onChange={event => setReferenceIds(current => event.target.checked ? [...current, image.id] : current.filter(id => id !== image.id))} />
            <img src={imagePath(image.id)} alt={image.name} loading="lazy" /><span>{image.name}</span>
          </label>)}</div></fieldset> : caseReferences?.error ? <div className="field-error" role="alert">
            <p>{caseReferences.error}</p><button className="text-link" type="button" onClick={() => { setReferencePage(null); setReloadReferences(value => value + 1); }}>重新读取参考图</button>
          </div> : referenceCaseId && !caseReferences ? <p className="field-note" role="status">正在读取参考图…</p>
            : <p className="field-note">需要参考图时，可先在这段对话上传图片，再回来选择。</p>}
          {kind === 'image' ? <label>图片尺寸<input value={size} maxLength={40} onChange={event => updateParameter('size', event.target.value)} placeholder="留空沿用模型默认，例如 1024x1024" /></label> : <>
            <label>时长（秒）<input type="number" min={video?.minSeconds ?? 1} max={video?.maxSeconds ?? 120} value={seconds} onChange={event => updateParameter('seconds', event.target.value)} placeholder={video?.defaultSeconds ? `默认 ${video.defaultSeconds} 秒` : '沿用模型默认'} /></label>
            <label>分辨率{video?.resolutions?.length ? <select value={resolution} onChange={event => updateParameter('resolution', event.target.value)}><option value="">沿用模型默认</option>{video.resolutions.map(value => <option key={value}>{value}</option>)}</select>
              : <input value={resolution} maxLength={40} onChange={event => updateParameter('resolution', event.target.value)} placeholder="沿用模型默认" />}</label>
            <label>画面比例{video?.aspectRatios?.length ? <select value={aspectRatio} onChange={event => updateParameter('aspectRatio', event.target.value)}><option value="">沿用模型默认</option>{video.aspectRatios.map(value => <option key={value} value={value}>{value === 'adaptive' ? '自适应' : value}</option>)}</select>
              : <input value={aspectRatio} maxLength={30} onChange={event => updateParameter('aspectRatio', event.target.value)} placeholder="沿用模型默认，例如 16:9" />}</label>
            <label>声音<select value={enableAudio === undefined ? '' : String(enableAudio)} onChange={event => updateParameter('enableAudio', event.target.value === '' ? undefined : event.target.value === 'true')}>
              <option value="">沿用模型默认{video?.defaultEnableAudio === undefined ? '' : video.defaultEnableAudio ? '（开启）' : '（关闭）'}</option>
              <option value="true" disabled={video?.audioMode !== 'switchable' && video?.audioMode !== 'always-on'}>开启</option>
              <option value="false" disabled={video?.audioMode !== 'switchable'}>关闭</option>
            </select></label>
            {video?.audioMode === 'always-on' ? <p className="field-note">此模型始终生成声音；需要静音时请选择支持关闭声音的模型。</p>
              : video?.audioMode !== 'switchable' ? <p className="field-note">此模型未提供声音控制能力，沿用上游默认。</p> : null}
          </>}
        </div>
      </details>
      {prompt && selected && !parsed.success && <p className="field-error">请检查描述长度和生成参数；尺寸请用宽x高，比例请用宽:高。</p>}
      {modelError && <p className="field-error" role="alert">{modelError}</p>}
      {catalog?.enabled && !models.length && <p className="field-note">网关没有提供支持当前{referenceIds.length ? '参考图方式的' : ''}{mediaKindText(kind)}模型。</p>}
    </fieldset>
    {!runtime.settings.enabled && <p className="field-note">当前已暂停运行，授权会先保存，恢复运行后生成。</p>}
    <div className="form-actions"><button type="button" className="button button-quiet" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={saving || !ready}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}授权并生成{mediaKindText(kind)}</button></div>
  </form>;
}
