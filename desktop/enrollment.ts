import type { DeviceEnrollment } from '../shared/local-device.js';
import { secureBaseUrl } from './security.js';
import { deviceFetch } from './transport.js';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export async function enrollDevice(baseUrl: string, name: string, pairingToken: string): Promise<DeviceEnrollment> {
  const response = await deviceFetch(baseUrl, '/api/device/enroll', undefined, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingToken, name, platform: 'win32' }), signal: AbortSignal.timeout(15000),
  });
  const enrollment = await response.json() as DeviceEnrollment;
  if (typeof enrollment?.device?.id !== 'string' || !enrollment.device.id || typeof enrollment.credential !== 'string' || enrollment.credential.length > 4000) {
    throw new Error('服务器未返回有效设备凭据。');
  }
  return enrollment;
}

export async function enrollFromLogin(options: {
  baseUrl: string;
  name: string;
  ownerFetch(url: string, init: RequestInit): Promise<Response>;
  isCurrent(): boolean;
}): Promise<DeviceEnrollment | undefined> {
  const origin = secureBaseUrl(options.baseUrl);
  const request = (route: string, method: 'GET' | 'POST') => options.ownerFetch(origin + route, {
    method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: { Origin: origin, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  if (!options.isCurrent()) return;
  const response = await request('/api/auth/session', 'GET');
  if (response.status === 401) return;
  if (!response.ok) throw new Error('暂时无法核对登录状态。');
  const session = await response.json() as { required?: boolean; authenticated?: boolean } | null;
  if (session?.required !== true || session.authenticated !== true || !options.isCurrent()) return;
  const pairing = await request('/api/devices/pairings', 'POST');
  if (pairing.status === 401) return;
  if (!pairing.ok) throw new Error('暂时无法登记这台电脑。');
  const result = await pairing.json() as { token?: string } | null;
  if (typeof result?.token !== 'string' || !tokenPattern.test(result.token)) throw new Error('服务器未返回有效的设备登记凭据。');
  if (!options.isCurrent()) return;
  return enrollDevice(origin, options.name, result.token);
}
