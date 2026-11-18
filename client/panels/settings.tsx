import { useId, useState, type FormEvent, type MouseEvent } from 'react';
import { ArrowDownToLine, Cable, Check, LoaderCircle } from 'lucide-react';
import type { SettingsInput } from '../../shared/types';
import { api } from '../api';
import type { PanelContext } from './types';
import { settingsPatch } from '../lib/settings-patch';
import { NotificationSettings } from '../components/NotificationSettings';
import { ModelConnectionsPanel } from '../components/ModelConnectionsPanel';

const settingsSections = [
  { id: 'identity', label: '称呼与相处' },
  { id: 'autonomy', label: '自主行动' },
  { id: 'models', label: '模型' },
  { id: 'notifications', label: '通知' },
  { id: 'wechat', label: '微信观察' },
  { id: 'data', label: '数据' },
] as const;

function revealSettingsSection(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const node = document.getElementById(`settings-section-${id}`);
  if (!node) return;
  event.preventDefault();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  if (!node.hasAttribute('tabindex')) node.tabIndex = -1;
  node.focus({ preventScroll: true });
}

export function SettingsPanel({ runtime, perform, busy, onClose, onOpenPanel }: PanelContext) {
  const desktop = typeof window === 'undefined' ? undefined : (window as Window & {
    raeLocalDevice?: { openWeChatSettings?: () => Promise<void> };
  }).raeLocalDevice;
  const [wechatError, setWechatError] = useState('');
  const formId = useId();
  const [initial] = useState(() => runtime.settings);
  const [form, setForm] = useState<SettingsInput>(() => {
    const { apiKeyConfigured: _configured, enabledRevision: _revision, apiBaseUrl: _url, model: _model,
      reasoningEffort: _reasoning, maxOutputTokens: _output, ...settings } = initial;
    return settings;
  });
  const saving = busy.includes('settings');
  function update<K extends keyof SettingsInput>(key: K, value: SettingsInput[K]) {
    setForm(current => ({ ...current, [key]: value }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const payload = settingsPatch(initial, form);
    if (await perform('settings', () => api('/api/settings', 'POST', payload), '设置已保存。')) onClose();
  }
  return <div className="form-stack settings-panel">
    <nav className="settings-nav" aria-label="设置分类">
      {settingsSections.map(section => <a key={section.id} href={`#settings-section-${section.id}`}
        onClick={event => revealSettingsSection(event, section.id)}>{section.label}</a>)}
    </nav>
    <form id={formId} className="form-stack settings-form" onSubmit={event => void save(event)}>
    <fieldset disabled={saving} className="form-stack">
      <section id="settings-section-identity" className="panel-section settings-section settings-fields">
        <h3>彼此的称呼</h3>
        <div className="form-row">
          <label>怎么称呼你<input value={form.ownerName || ''} maxLength={80} onChange={event => update('ownerName', event.target.value)} placeholder="你的名字或昵称" /></label>
          <label>分身的名字<input required value={form.agentName || ''} maxLength={80} onChange={event => update('agentName', event.target.value)} /></label>
        </div>
        <label>长期角色与相处方式<textarea required rows={4} maxLength={20000} value={form.mission || ''} onChange={event => update('mission', event.target.value)} /></label>
      </section>
      <section id="settings-section-autonomy" className="panel-section settings-section settings-fields">
        <h3>自主行动</h3>
        <label className="checkbox-label"><input type="checkbox" checked={form.enabled || false} onChange={event => update('enabled', event.target.checked)} />开启自主学习与交流</label>
        <p className="field-note">根据新消息、反馈、资料变化和已安排回访进行学习；没有线索或安排时等待。实际交付仍需明确委托或批准。</p>
        <div className="form-row">
          <label>后台分析最多处理步数<input type="number" required min="1" max="50" step="1" value={form.maxStepsPerRun ?? 20} onChange={event => update('maxStepsPerRun', Number(event.target.value))} /></label>
          <label>时区<input required value={form.timezone || 'Asia/Shanghai'} onChange={event => update('timezone', event.target.value)} /></label>
        </div>
        <p className="field-note">这个设置用于后台回顾和对话中的记忆整理。你发起的对话和新委托默认没有总步数上限，可以随时停止。已安排的日常提醒在暂停推理时仍会投递。</p>
        <label className="checkbox-label"><input type="checkbox" checked={(form.maxOutputContinuations ?? 1) > 0}
          onChange={event => update('maxOutputContinuations', event.target.checked ? 1 : 0)} />回复被截断时，自动续写一次</label>
        <p className="field-note">续写只补充正文，沿用本轮的取消状态和已保存的执行限制。单次输出上限在各模型配置中设置。</p>
      </section>
    </fieldset>
    </form>
    <div id="settings-section-models" className="settings-section" tabIndex={-1}>
      <ModelConnectionsPanel directory={runtime.modelConnections} perform={perform} busy={busy} />
    </div>
    <div id="settings-section-notifications" className="settings-section" tabIndex={-1}>
      <NotificationSettings caseId={runtime.conversation.caseId ?? 'personal-growth'} />
    </div>
    <section id="settings-section-wechat" className="panel-section settings-section">
      <h3>微信观察</h3>
      <p className="field-note">选择群聊或联系人，查看接收和分析进度，配置历史范围与自动观察。</p>
      {desktop?.openWeChatSettings ? <button type="button" className="button" onClick={async () => {
        setWechatError('');
        try { await desktop.openWeChatSettings!(); }
        catch { setWechatError('未能打开本机设置，请从任务栏托盘打开「本地设备与授权」。'); }
      }}>打开微信观察设置</button> : <p className="field-note">请在登录微信的 Windows 电脑上使用榫客户端。已有旧版客户端可从托盘打开「本地设备与授权」，或检查更新。</p>}
      {wechatError && <p role="status" className="inline-result failure">{wechatError}</p>}
    </section>
    <section id="settings-section-data" className="panel-section settings-section">
      <h3>数据</h3>
      <p className="field-note">导出当前数据和只读历史，不包含 API 密钥。</p>
      <a className="button download-link" href="/api/export" download><ArrowDownToLine size={15} />导出数据</a>
      <h3>外部连接器</h3>
      <p className="field-note">把已授权的资料或邮件绑定到对应场景。</p>
      <button type="button" className="button" onClick={() => onOpenPanel({ type: 'connectors' })}><Cable size={15} />管理连接器</button>
    </section>
    <p className="field-note"><a href={new URL('../assets/fonts/MiSans-LICENSE.pdf', import.meta.url).href} target="_blank" rel="noopener noreferrer">MiSans 字体许可</a> · <a href={new URL('../assets/fonts/tenon-song-LICENSE.txt', import.meta.url).href} target="_blank" rel="noopener noreferrer">字标字体许可</a></p>
    <div className="form-actions"><button type="button" className="button button-quiet" onClick={onClose}>关闭</button><button type="submit" form={formId} className="button button-primary" disabled={saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存常规设置</button></div>
  </div>;
}
