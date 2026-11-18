import { useEffect, useState, type FormEvent } from 'react';
import { Copy, LoaderCircle, Monitor, Pencil, RefreshCw } from 'lucide-react';
import { deviceDirectoryLookupCapability, type DeviceOperation, type DevicePairing, type LocalDevice } from '../../shared/local-device';
import { api } from '../api';
import { dateTime } from '../lib/format';
import { commandAccessText, operationStateText } from '../lib/local-command';
import { localProjectCapability } from '../../shared/local-project';
import type { PanelContext } from './types';

export function DevicesPanel({ runtime, perform, busy }: PanelContext) {
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [operations, setOperations] = useState<DeviceOperation[]>([]);
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [renameDraft, setRenameDraft] = useState<{ deviceId: string; name: string }>();
  const currentDevices = runtime.devices;
  const currentDeviceKey = currentDevices?.map(device => device.id).join(',') ?? '';
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void Promise.all([api<LocalDevice[]>('/api/devices', 'GET', undefined, controller.signal),
      api<DeviceOperation[]>('/api/device-operations', 'GET', undefined, controller.signal)])
      .then(([list, receipts]) => { if (!controller.signal.aborted) { setDevices(list); setOperations(receipts); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取设备失败。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload, currentDeviceKey]);
  async function rename(event: FormEvent, deviceId: string, name: string) {
    event.preventDefault();
    const key = `rename-device:${deviceId}`;
    if (await perform(key, async () => {
      const updated = await api<LocalDevice>(`/api/devices/${encodeURIComponent(deviceId)}/rename`, 'POST', { name });
      setDevices(previous => previous.map(device => device.id === deviceId ? updated : device));
    }, '设备名称已保存。')) {
      setRenameDraft(previous => previous?.deviceId === deviceId ? undefined : previous);
      setReload(value => value + 1);
    }
  }
  return <div className="form-stack">
    <p className="field-note">在 Windows 客户端登录即可连接电脑。服务器执行设备由部署配置接入，每项服务器任务都需要确认资源范围。</p>
    <div className="form-actions">
      <button className="button button-primary" disabled={busy.includes('device-pairing')} onClick={() => void perform('device-pairing', async () => {
        setPairing(await api<DevicePairing>('/api/devices/pairings', 'POST', {}));
      })}>{busy.includes('device-pairing') ? <LoaderCircle size={15} className="spin" /> : <Monitor size={15} />}生成手动配对码</button>
      <button className="button" disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />刷新</button>
    </div>
    {pairing && <section className="panel-section device-pairing" aria-live="polite"><h3>在 Windows 客户端输入配对码</h3>
      <code className="pairing-code">{pairing.token}</code>
      <p className="field-note">仅可使用一次，{dateTime(pairing.expiresAt, runtime.settings.timezone, true)} 到期。</p>
      <button className="button" onClick={() => void perform('copy-pairing', () => navigator.clipboard.writeText(pairing.token), '配对码已复制。')}><Copy size={15} />复制配对码</button>
    </section>}
    {loading && <p className="muted" role="status">正在读取设备…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {!loading && !error && !devices.length && <p className="muted">还没有连接的设备。请打开 Windows 客户端并登录。</p>}
    {devices.map(device => {
      const current = currentDevices?.find(item => item.id === device.id);
      const name = current?.name ?? device.name;
      const online = current?.online ?? device.online;
      const capabilities = current?.capabilities ?? device.capabilities;
      const draft = renameDraft?.deviceId === device.id ? renameDraft : undefined;
      const renaming = busy.includes(`rename-device:${device.id}`);
      const revoking = busy.includes(`device:${device.id}`);
      return <section className="panel-section" key={device.id}>
      <h3><Monitor size={16} /> {name} <span className="tag">{device.platform === 'linux' ? 'Linux 服务器' : 'Windows'}</span><span className="tag">{device.revokedAt ? '已撤销' : online ? '在线' : '离线'}</span></h3>
      {device.lastSeenAt && <p className="field-note">最近连接：{dateTime(device.lastSeenAt, runtime.settings.timezone, true)}</p>}
      {online && capabilities.includes(deviceDirectoryLookupCapability) && <p className="field-note">可查询你在对话里指定的文件夹。</p>}
      {online && capabilities.includes(localProjectCapability) && <p className="field-note">{device.platform === 'linux' ? '可在独立临时目录中读写文件和运行命令。' : '可读取与编辑代码、运行命令、调试及浏览器验证。'}</p>}
      {device.grants.map(grant => <div className="task-scope" key={grant.id}><p className="resource-path">{grant.root}</p>
        <p className="resource-path">{grant.executable}</p><p className="field-note">授权版本 {grant.revision} · {grant.readOnly ? '只读' : '可写工作目录'}{grant.available === false ? ` · 不可用：${grant.reason || '执行环境不可用'}` : ''}</p></div>)}
      {!device.revokedAt && <>
        {device.platform === 'win32' && draft && <form className="form-stack" onSubmit={event => void rename(event, device.id, draft.name.trim())}>
          <label>设备名称<input autoFocus required maxLength={120} disabled={renaming || revoking} value={draft.name}
            onChange={event => setRenameDraft({ deviceId: device.id, name: event.target.value })} /></label>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={renaming || revoking || !draft.name.trim() || draft.name.trim() === name}>
              {renaming && <LoaderCircle size={15} className="spin" />}保存名称</button>
            <button type="button" className="button button-quiet" disabled={renaming} onClick={() => setRenameDraft(undefined)}>取消</button>
          </div>
        </form>}
        <div className="form-actions">
          {device.platform === 'win32' && !draft && <button type="button" className="text-link" disabled={renaming || revoking}
            aria-label={`修改「${name}」的名称`} onClick={() => setRenameDraft({ deviceId: device.id, name })}><Pencil size={13} />修改名称</button>}
          <button type="button" className="text-link" disabled={revoking || renaming} onClick={() => void perform(`device:${device.id}`, async () => {
            await api(`/api/devices/${encodeURIComponent(device.id)}/revoke`, 'POST', {}); setReload(value => value + 1);
          }, '已撤销这台设备；进行中的操作以实际停止回执为准。')}>撤销设备连接</button>
        </div>
      </>}
    </section>; })}
    {operations.length > 0 && <section className="panel-section"><h3>最近执行回执</h3>{operations.slice().reverse().slice(0, 20).map(operation => <details className="task-scope" key={operation.operationId}>
      <summary>{operationStateText[operation.receipt.state]}</summary><p className="resource-path">{'kind' in operation.spec ? operation.spec.entryType === 'directory' ? '查询直接子文件夹' : '查询文件列表' : operation.spec.executable}</p>
      <p className="resource-path">{commandAccessText(operation.spec)}</p>
      <p className="field-note">{'args' in operation.spec && `${JSON.stringify(operation.spec.args)} · `}{dateTime(operation.issuedAt, runtime.settings.timezone, true)}</p>
      {operation.receipt.exitCode !== undefined && <p>退出码：{operation.receipt.exitCode}</p>}
      {operation.receipt.stdout && <pre className="command-output">{operation.receipt.stdout}</pre>}
      {operation.receipt.stderr && <pre className="command-output">{operation.receipt.stderr}</pre>}
      {operation.receipt.error && <p className="field-error">{operation.receipt.error}</p>}
    </details>)}</section>}
  </div>;
}
