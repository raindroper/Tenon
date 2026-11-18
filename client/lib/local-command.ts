import type { DeviceCommandSpec } from '../../shared/local-device';

export function commandAccessText(command: DeviceCommandSpec): string {
  if ('kind' in command) return command.root === 'windows-downloads' ? '只读 Windows 下载目录' : `只读 ${command.root}`;
  if (!('access' in command)) return `工作目录 ${command.cwd} · 授权版本 ${command.grantRevision}`;
  if (command.access.kind === 'scratch') return '本次任务的临时空间';
  return `${command.access.readOnly ? '只读' : '读写'} ${command.access.root}`;
}

export const operationStateText = {
  dispatched: '等待设备接收', running: '设备正在执行', cancel_requested: '已请求停止，等待设备确认',
  completed: '设备执行结束', failed: '执行失败', cancelled: '设备已确认停止', unknown: '执行结果待核对',
} as const;
