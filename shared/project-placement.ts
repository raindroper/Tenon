import type { LocalDevice } from './local-device.js';
import { localProjectCapability, windowsDesktopCapability } from './local-project.js';
import type { TaskRecord } from './task-consent.js';

export interface ConfirmedProjectLocation { deviceId: string; root: string; taskId: string }
type PlacementDevice = Pick<LocalDevice, 'id' | 'online' | 'capabilities'> & Partial<Pick<LocalDevice, 'platform' | 'revokedAt'>>;

/** Past approved scopes are location evidence only. Every new goal still obtains its own consent. */
export function confirmedProjectLocations(tasks: readonly TaskRecord[], caseId?: string): ConfirmedProjectLocation[] {
  if (!caseId) return [];
  const locations = new Map<string, ConfirmedProjectLocation>();
  for (const task of tasks) {
    const project = task.spec.project;
    if (task.spec.caseId !== caseId || !task.approvalRevision || !project || project.root === 'task-temporary'
      || ['proposed', 'rejected', 'revoked'].includes(task.state)) continue;
    locations.set(project.deviceId + ':' + project.root.replaceAll('/', '\\').toLowerCase(), { deviceId: project.deviceId, root: project.root, taskId: task.id });
  }
  return [...locations.values()];
}

export function projectDeviceUnavailable(device: PlacementDevice, desktop = false): string | undefined {
  if (device.revokedAt) return '设备连接已撤销';
  if (!device.online) return '设备离线，等待恢复连接';
  if (!device.capabilities.includes(localProjectCapability)) return '客户端项目执行协议不兼容，请更新客户端';
  if (desktop && (device.platform === 'linux' || !device.capabilities.includes(windowsDesktopCapability))) return '设备不支持本次 Windows 应用操作';
  return undefined;
}

/** Availability never changes the default's identity or turns the last online server into a local replacement. */
export function defaultProjectLocation(devices: readonly PlacementDevice[], locations: readonly ConfirmedProjectLocation[], selectedDeviceId?: string): { deviceId: string; root?: string } | undefined {
  if (selectedDeviceId) {
    const matching = locations.filter(location => location.deviceId === selectedDeviceId);
    return { deviceId: selectedDeviceId, ...(matching.length === 1 ? { root: matching[0].root } : {}) };
  }
  if (locations.length === 1) return locations[0];
  if (locations.length > 1) return undefined;
  const clients = devices.filter(device => device.platform !== 'linux' && !device.revokedAt);
  return clients.length === 1 ? { deviceId: clients[0].id } : undefined;
}
