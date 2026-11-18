import { useEffect, useState } from 'react';
import { notificationBridge, notificationPermission, notificationPreferences, saveNotificationPreferences, subscribeNotificationPreferences } from '../lib/notifications';
import { sendTestNotification } from '../state/useNotifications';

export function NotificationSettings({ caseId }: { caseId: string }) {
  const [preferences, setPreferences] = useState(notificationPreferences);
  const [permission, setPermission] = useState(notificationPermission);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const refresh = () => { setPreferences(notificationPreferences()); setPermission(notificationPermission()); };
    const unsubscribe = subscribeNotificationPreferences(refresh);
    window.addEventListener('focus', refresh);
    return () => { unsubscribe(); window.removeEventListener('focus', refresh); };
  }, []);
  async function enable() {
    setBusy(true); setMessage('');
    try {
      // Must be requested directly from a user gesture, never from snapshot delivery.
      const result = notificationPermission() === 'default' ? await Notification.requestPermission() : notificationPermission();
      setPermission(result);
      if (result !== 'granted') { setMessage('请在浏览器的网站权限中允许通知，再回到这里开启。'); return; }
      saveNotificationPreferences({ ...notificationPreferences(), enabled: true });
      setMessage('已开启。通知也受 Windows 通知设置和勿扰模式控制。');
    } catch { setMessage('无法开启通知，请检查浏览器权限与本机存储设置。'); }
    finally { setBusy(false); }
  }
  function update(preview: boolean, enabled = preferences.enabled) {
    try { saveNotificationPreferences({ enabled, preview }); setMessage(''); }
    catch { setMessage('无法保存通知设置，请检查本机存储权限。'); }
  }
  return <section className="panel-section" aria-labelledby="desktop-notification-title">
    <h3 id="desktop-notification-title">桌面通知 <span className="tag">{preferences.enabled && permission === 'granted' ? '已开启' : '未开启'}</span></h3>
    <p className="field-note">收到回复和日常提醒、任务完成或失败、事项待确认时通知你。点击通知返回对应场景。</p>
    {notificationBridge() && <p className="field-note">榫窗口在前台时只更新未读角标。测试通知可直接发送。</p>}
    {permission === 'upgrade' ? <p className="field-note">请从托盘检查更新，安装 0.1.12 或更高版本后使用桌面通知。</p>
      : permission === 'unsupported' ? <p className="field-note">当前环境不支持桌面通知，请使用 HTTPS 网页或更新后的 Windows 客户端。</p>
      : <>
        {permission === 'denied' && <p className="field-note">浏览器已阻止通知，请在地址栏的网站权限中允许通知。</p>}
        <div className="form-actions">
          {preferences.enabled ? <button type="button" className="button" onClick={() => update(preferences.preview, false)}>关闭通知</button>
            : <button type="button" className="button" disabled={busy || permission === 'denied'} onClick={() => void enable()}>开启桌面通知</button>}
          <button type="button" className="button" disabled={!preferences.enabled || permission !== 'granted'} onClick={() => {
            void sendTestNotification(caseId).then(() => setMessage('已发送测试通知；若未看到，请检查 Windows 通知设置和勿扰模式。'),
              cause => setMessage(cause instanceof Error ? cause.message : '测试通知发送失败。'));
          }}>发送测试通知</button>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={preferences.preview} onChange={event => update(event.target.checked)} />在通知中显示消息或任务摘要</label>
      </>}
    <p className="field-note">设置仅对当前浏览器或客户端生效。网页需保留标签页；Windows 客户端可关闭窗口留在托盘。退出客户端、电脑休眠或离线期间无法接收实时通知。</p>
    {message && <p className="field-note" role="status">{message}</p>}
  </section>;
}
