import { useId } from 'react';
import { modelReasoningOptions, modelProtocolUseLabel, type ModelConnection, type ModelSelection } from '../../shared/model-connections';
import { chooseConnection, chooseModel, connectionStatusLabel, reasoningLabel } from '../lib/model-selection';

export function ModelSelectionPicker({ connections, value, onChange, disabled, label = '模型配置' }: {
  connections: readonly ModelConnection[]; value: ModelSelection | null; onChange(value: ModelSelection): void;
  disabled?: boolean; label?: string;
}) {
  const catalogId = useId();
  const connection = connections.find(item => item.id === value?.connectionId);
  const protocolId = catalogId + '-protocol';
  const options = connection && value?.modelId ? modelReasoningOptions(connection, value.modelId) : [];
  const catalog = connection?.models ?? [];
  const missingModel = value?.modelId && !catalog.some(model => model.id === value.modelId);
  const missingReasoning = value?.reasoning && !options.includes(value.reasoning);
  return <fieldset className="model-selection-picker form-stack" disabled={disabled} aria-label={label}>
    <label>模型连接<select aria-label="模型连接" aria-describedby={connection ? protocolId : undefined}
      value={value?.connectionId ?? ''} onChange={event => onChange(chooseConnection(event.target.value))}>
      <option value="">选择已保存的连接</option>
      {value?.connectionId && !connection && <option value={value.connectionId}>原连接已不可用</option>}
      {connections.filter(item => !item.archived || item.id === value?.connectionId).map(item => <option key={item.id} value={item.id} disabled={item.archived}>{item.name}{item.status !== 'ready' || !item.enabled ? ` · ${connectionStatusLabel(item)}` : ''}</option>)}
    </select></label>
    {connection && <p id={protocolId} className="field-note">{modelProtocolUseLabel(connection.protocol)}</p>}
    <div className="form-row">
      <label>模型{connection?.kind === 'siwc' ? <select aria-label="模型" value={value?.modelId ?? ''} disabled={!connection}
        onChange={event => value && onChange(chooseModel(value, event.target.value, connection))}>
        <option value="">{catalog.length ? '选择此账号的模型' : '请先获取账号模型目录'}</option>
        {missingModel && <option value={value!.modelId}>{value!.modelId} · 当前目录中不可用</option>}
        {catalog.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select> : <><input aria-label="模型" value={value?.modelId ?? ''} disabled={!connection} maxLength={200} list={catalog.length ? catalogId : undefined}
        placeholder="填写服务商提供的模型 ID" autoComplete="off"
        onChange={event => value && onChange(chooseModel(value, event.target.value, connection))} />
        {catalog.length > 0 && <datalist id={catalogId}>{catalog.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>}</>}
      </label>
      <label>思考强度<select aria-label="思考强度" value={value?.reasoning ?? ''} disabled={!connection || !value?.modelId}
        onChange={event => value && onChange({ ...value, reasoning: event.target.value })}>
        <option value="">选择此模型支持的档位</option>
        {missingReasoning && <option value={value!.reasoning}>{reasoningLabel(value!.reasoning)} · 未确认支持</option>}
        {options.map(option => <option key={option} value={option}>{reasoningLabel(option)}</option>)}
      </select></label>
    </div>
    {connection?.kind === 'siwc' && !catalog.length && <p className="field-note">账号登录后，在连接卡片中获取模型目录。获取目录不会调用模型。</p>}
    {connection && <details className="output-settings">
      <summary>单次输出上限</summary>
      <div className="form-stack">
        {connection.kind === 'siwc' ? <><p className="field-note">ChatGPT 套餐调用使用接口默认上限。</p>
          {value?.maxOutputTokens !== null && <button type="button" className="text-link" onClick={() => value && onChange({ ...value, maxOutputTokens: null })}>清除原输出上限</button>}</>
          : <><label>输出 token 上限（可选）<input type="number" min="1" max="2147483647" step="1" value={value?.maxOutputTokens ?? ''}
            placeholder="沿用模型接口默认值" onChange={event => value && onChange({ ...value, maxOutputTokens: event.target.value === '' ? null : Number(event.target.value) })} /></label>
            <p className="field-note">留空不额外限制输出，接口自身仍可能截断。</p></>}
      </div>
    </details>}
  </fieldset>;
}
