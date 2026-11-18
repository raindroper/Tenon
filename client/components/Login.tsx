import { useId, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { canShowWindowsDesktopDownload, windowsDesktopDownload, windowsDesktopFilename } from '../lib/desktop-download';
import { tenonMark } from './primitives';

export function LoginBrand({ headingId }: { headingId?: string }) {
  return <div className="login-lockup">
    <img className="login-mark" src={tenonMark} alt="" />
    <div className="login-name">
      <h1 id={headingId} className="login-cn">榫</h1>
      <p className="login-en" lang="en">Tenon</p>
    </div>
  </div>;
}

export function Login({ busy, error, onLogin }: { busy: boolean; error: string; onLogin(username: string, password: string): Promise<boolean> }) {
  const [username, setUsername] = useState('rae');
  const [password, setPassword] = useState('');
  const id = useId(); const passwordInput = useRef<HTMLInputElement>(null);
  const ready = Boolean(username.trim() && password);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    const accepted = await onLogin(username, password);
    setPassword('');
    if (!accepted) passwordInput.current?.focus();
  };
  return <main className="login-page">
    <img className="login-ghost" src={tenonMark} alt="" />
    <div className="login-grain" aria-hidden="true" />
    <section className="login-content" aria-labelledby={id + '-title'}>
      <LoginBrand headingId={id + '-title'} />
      <div className="login-rule" aria-hidden="true" />
      <form className="login-form" onSubmit={event => void submit(event)} aria-busy={busy}>
        <label htmlFor={id + '-username'}>用户名</label>
        <input id={id + '-username'} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
          value={username} onChange={event => setUsername(event.target.value)} required maxLength={80} disabled={busy} />
        <label htmlFor={id + '-password'}>密码</label>
        <input ref={passwordInput} id={id + '-password'} name="password" type="password" autoComplete="current-password"
          value={password} onChange={event => setPassword(event.target.value)} required maxLength={1024} disabled={busy}
          aria-invalid={Boolean(error)} aria-describedby={error ? id + '-error' : undefined} />
        {error && <p id={id + '-error'} className="field-error" role="alert">{error}</p>}
        <button className="button button-primary login-submit" type="submit" disabled={busy || !ready}>
          {busy ? <><LoaderCircle size={16} className="spin" />正在登录…</> : '进入空间'}
        </button>
      </form>
      {canShowWindowsDesktopDownload() && <a className="login-download" href={windowsDesktopDownload} download={windowsDesktopFilename}>
        下载 Windows 客户端
      </a>}
    </section>
  </main>;
}
