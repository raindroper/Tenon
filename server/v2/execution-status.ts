import { localProjectCapability } from '../../shared/local-project.js';
import type { TaskRecord } from '../../shared/task-consent.js';
import type { DeviceBroker } from '../devices/broker.js';
import { projectDeviceUnavailable } from '../../shared/project-placement.js';

/** Live facts only: a review's tool list is not the product's entire capability. */
export function executionStatus(devices: Pick<DeviceBroker, 'listDevices' | 'projects'>, tasks: TaskRecord[]) {
  const projects = tasks.filter(task => task.spec.project);
  const selected = [...projects.filter(task => ['approved', 'running'].includes(task.state)),
    ...projects.filter(task => !['approved', 'running'].includes(task.state)).slice(-8)];
  return {
    observedAt: new Date().toISOString(),
    devices: devices.listDevices().filter(device => !device.revokedAt).map(device => ({
      id: device.id, name: device.name, platform: device.platform, online: device.online,
      localProjectExecution: device.capabilities.includes(localProjectCapability),
      unavailableReason: projectDeviceUnavailable(device),
      ...(device.platform === 'linux' ? { requiresResourceApproval: true } : {}),
    })),
    localTasks: selected.map(task => {
      const operation = devices.projects.forTask(task.id);
      return { id: task.id, title: task.spec.title, state: task.state,
        ...(task.flow ? { phase: task.flow.phase, pendingInputs: task.flow.dependencies.filter(dependency => ['waiting', 'reviewing'].includes(dependency.state)).length } : {}),
        requirementsRevision: task.requirementsRevision ?? 1, deviceId: task.spec.project!.deviceId, root: task.spec.project!.root,
        ...(operation ? { native: { state: operation.state, sessionCreated: Boolean(operation.threadId),
          modelCalls: operation.modelCalls, recordedTools: operation.toolCounts?.total ?? operation.tools.length, updatedAt: operation.updatedAt,
          ...(operation.delivery ? { delivery: { requirementsRevision: operation.delivery.requirementsRevision,
            verification: operation.delivery.verification?.checks.map(check => ({ id: check.id, status: check.status, detail: check.detail })) } } : {}),
          error: operation.error } } : { native: null }) };
    }),
    meaning: '设备能力、任务许可和执行结果是不同事实。本轮回顾没有本地执行工具，不表示整个产品只能用GitHub。已登记的本地任务以执行器回执为准；没有会话或工具记录时，不能声称已读取代码，也不能把一次连接失败说成未接入能力。',
  };
}

export const EXECUTION_STATUS_GUIDANCE = '\nexecutionStatus 和 read_execution_status 提供同一运行时的实际设备能力与本场景本地任务状态。涉及已登记委托的进展、失败或能力判断时，先刷新此只读状态。不要把当前回顾/交流工具列表当作整个产品的能力，不要因本轮只有GitHub资料工具便声称本地能力未接入。后台回顾不能接管已登记的本地验收、擅自改走其他代码来源或重复向本人索取同一输入；执行器没有实际代码回执时如实说明尚未开始/失败，不能编造全局能力结论。此状态不授予任何执行权。';
