import { modelReasoningOptions, type ModelConnection, type ModelDirectory, type ModelPreference, type ModelSelection } from '../../shared/model-connections';

const REASONING_LABELS: Readonly<Record<string, string>> = {
  default: '服务商默认', auto: '自动', none: '关闭', minimal: '最低', low: '低', medium: '中',
  high: '高', max: '最高', xhigh: '很高', ultra: '极致',
};

export function reasoningLabel(value: string): string { return REASONING_LABELS[value] ?? value; }

export function effectiveSelection(preference: ModelPreference, global: ModelSelection | null): ModelSelection | null {
  return preference.mode === 'explicit' ? preference.selection : global;
}

export function selectionLabel(selection: ModelSelection | null, connections: readonly ModelConnection[]): string {
  if (!selection) return '尚未配置模型';
  const connection = connections.find(item => item.id === selection.connectionId);
  const model = connection?.models?.find(item => item.id === selection.modelId);
  return `${connection?.name ?? '连接已不可用'} / ${model?.name ?? selection.modelId} / ${reasoningLabel(selection.reasoning)}`;
}

export function connectionStatusLabel(connection: ModelConnection): string {
  if (!connection.enabled || connection.status === 'disabled') return '已停用';
  if (connection.status === 'scope-required') return '尚未授权套餐调用';
  if (connection.status === 'reauth-required') return '需要重新登录';
  if (connection.status === 'needs-login' || !connection.credentialConfigured) return connection.kind === 'siwc' ? '尚未登录或授权' : '尚未保存密钥';
  return connection.kind === 'siwc' ? '已连接 ChatGPT' : '密钥已配置';
}

/** A failed connection remains selected; callers decide when to repair it. */
export function selectionIssue(selection: ModelSelection | null, connections: readonly ModelConnection[]): string | null {
  if (!selection?.connectionId) return '请选择一个模型连接。';
  const connection = connections.find(item => item.id === selection.connectionId);
  if (!connection || connection.archived) return '原连接已不可用，请选择其他连接或修复原连接。';
  if (!selection.modelId.trim()) return '请选择或填写模型。';
  if (connection.kind === 'siwc' && !connection.models?.some(model => model.id === selection.modelId)) return '请先获取此账号的模型目录，再选择可用模型。';
  if (!selection.reasoning || !modelReasoningOptions(connection, selection.modelId).includes(selection.reasoning)) return '请为这个模型选择支持的思考强度。';
  if (selection.maxOutputTokens !== null && (!Number.isSafeInteger(selection.maxOutputTokens) || selection.maxOutputTokens <= 0 || selection.maxOutputTokens > 2_147_483_647)) return '输出上限须为有效的正整数，或留空使用服务商默认值。';
  if (connection.kind === 'siwc' && selection.maxOutputTokens !== null) return 'ChatGPT 套餐调用不支持自定义输出上限，请清除此设置。';
  return null;
}

export function selectionAvailability(selection: ModelSelection | null, connections: readonly ModelConnection[]): string | null {
  if (!selection) return '尚未配置模型';
  const connection = connections.find(item => item.id === selection.connectionId);
  if (!connection || connection.archived) return '连接已不可用';
  if (!connection.enabled || connection.status !== 'ready' || !connection.credentialConfigured) return connectionStatusLabel(connection);
  if (connection.kind === 'siwc' && connection.models && !connection.models.some(model => model.id === selection.modelId)) return '所选模型不在当前账号目录中';
  if (!modelReasoningOptions(connection, selection.modelId).includes(selection.reasoning)) return '所选思考强度未确认支持';
  return null;
}

export function connectionReferences(directory: ModelDirectory, id: string): string[] {
  const references: string[] = [];
  if (directory.defaults.global?.connectionId === id) references.push('全局默认');
  if (directory.defaults.background.mode === 'explicit' && directory.defaults.background.selection.connectionId === id) references.push('后台默认');
  const scenes = directory.scenes.filter(scene => scene.preference.mode === 'explicit' && scene.preference.selection.connectionId === id);
  if (scenes.length) references.push(`${scenes.length} 个场景配置`);
  return references;
}

export function chooseConnection(id: string): ModelSelection {
  return { connectionId: id, modelId: '', reasoning: '', maxOutputTokens: null };
}

export function chooseModel(selection: ModelSelection, modelId: string, connection?: ModelConnection): ModelSelection {
  const options = connection ? modelReasoningOptions(connection, modelId) : [];
  return { ...selection, modelId, reasoning: options.includes(selection.reasoning) ? selection.reasoning : '' };
}
