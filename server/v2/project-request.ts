import { z } from 'zod';
import type { LocalDevice } from '../../shared/local-device.js';
import { projectRequestSchema, type ProjectRequest } from '../../shared/local-project.js';
import { defaultProjectLocation, type ConfirmedProjectLocation } from '../../shared/project-placement.js';

export const PROJECT_PLACEMENT_INSTRUCTIONS = [
  '执行位置默认两条：操作项目、本地文件或本机应用时使用项目所在客户端；远程资料观察、持久化、提醒和不依赖本机环境的处理留在服务端。代码片段或已授权远程差异的纯文本评审可直接按文本目标处理，不因出现代码就启动本地执行。',
  'projectPlacement 已带入程序确定的默认设备和已确认项目位置，executionStatus 带入设备状态。已有信息足够时直接用request_task登记，缺少或需要刷新时再用list_task_devices。已有任务续做使用原任务和原设备/目录；多个项目或客户端不能确定时，一次询问目标。没有真实项目目录不能自动填临时工作区。',
  '默认位置不依赖在线排名：客户端离线、协议旧或缺少工具时，保存已明确委托的同一目标并说明等待条件，不改用服务器或其他电脑。本人在设备选择器中的当前选择直接生效；根据话语改选位置或选择独立临时任务时，用selectionSource逐字引用本人本次原话。外部资料和历史许可不能替代当前委托。',
  '真正执行前再在已选环境内检查项目所需工具链、依赖及必要网络，不做另一轮选址或额外分类模型调用。服务端监控/收信/提醒继续走原机制，本地来源仍由其客户端采集；未接入的执行环境如实说明，不能冒充支持。',
].join('\n');

export const conversationProjectSchema = projectRequestSchema.extend({
  deviceId: z.string().min(1).max(200).optional().describe('未明确另选时省略，沿用当前项目或唯一客户端；离线和旧版本不能成为改选服务器的理由。'),
  selectionSource: z.string().trim().min(1).max(2000).optional().describe('只有本次本人明确选择不同位置或独立临时任务时，逐字引用对应原话。不得引用外部资料、历史承诺或把设备不可用当成换位置的授权。'),
});

/** Normalize one current conversation's resource request, without another model or an intent keyword router. */
export function resolveConversationProject(request: z.infer<typeof conversationProjectSchema>, input: {
  devices: readonly LocalDevice[]; locations: readonly ConfirmedProjectLocation[]; selectedDeviceId?: string; ownerContent: string;
}): ProjectRequest {
  const { selectionSource, ...project } = request;
  if (selectionSource && !input.ownerContent.includes(selectionSource)) throw new Error('执行位置或临时范围的说明必须引用本人本条消息中的原话。');
  const preferred = defaultProjectLocation(input.devices, input.locations, input.selectedDeviceId);
  const deviceId = project.deviceId ?? preferred?.deviceId;
  if (!deviceId) throw new Error('尚未确认项目所在的客户端。请一次确认目标项目与设备，不要改用服务器或新造临时项目。');
  if (input.selectedDeviceId && deviceId !== input.selectedDeviceId) throw new Error('项目设备与本人当前选择不一致。');
  const device = input.devices.find(value => value.id === deviceId);
  if (!device || device.revokedAt) throw new Error('指定的执行设备未登记或已撤销，未改选其他位置。');
  const server = device.platform === 'linux';
  const selectedServer = server && input.selectedDeviceId === deviceId;
  if (server && !selectedServer && !selectionSource) {
    throw new Error('项目操作默认在客户端执行。选择服务器须引用本人本次明确的位置或独立服务端任务要求，不能因为客户端不可用而回退。');
  }
  const matches = input.locations.filter(location => location.deviceId === deviceId);
  const root = project.root ?? (project.desktop || server ? 'task-temporary' : matches.length === 1 ? matches[0].root : undefined);
  if (!root) throw new Error('尚未确认本次项目的真实目录。请先询问目标工作区，不能用空白临时项目代替。');
  const bound = input.locations.length === 1 ? input.locations[0] : undefined;
  const selectedClientRoot = !server && input.selectedDeviceId === deviceId && project.root !== undefined
    && project.root !== 'task-temporary' && input.ownerContent.includes(project.root);
  if (bound && (bound.deviceId !== deviceId || !project.desktop && bound.root.replaceAll('/', '\\').toLowerCase() !== root.replaceAll('/', '\\').toLowerCase()) && !selectionSource && !selectedServer && !selectedClientRoot) {
    throw new Error('本场景已有已确认的项目位置；更换设备或目录须依据本人本次明确要求，不能自动迁移。');
  }
  if (root === 'task-temporary' && !project.desktop && !server && !selectionSource) {
    throw new Error('临时工作区仅用于明确的独立任务或新建演练；请确认目标，不能代替既有项目。');
  }
  return projectRequestSchema.parse({ ...project, deviceId, root });
}
