import type { AgentStatus, RunUsageStatus } from '../../shared/types';

function createDateFormats(timeZone: string) {
  const time = { timeZone, hour: '2-digit', minute: '2-digit', hour12: false } as const;
  return { timeZone,
    time: new Intl.DateTimeFormat('zh-CN', time),
    timeWithDate: new Intl.DateTimeFormat('zh-CN', { ...time, month: 'numeric', day: 'numeric' }),
  };
}

let currentDateFormats: ReturnType<typeof createDateFormats> | undefined;
function dateFormats(zone: string) {
  if (!currentDateFormats || currentDateFormats.timeZone !== zone) currentDateFormats = createDateFormats(zone);
  return currentDateFormats;
}

export function dateTime(value: string, zone = 'Asia/Shanghai', withDate = false): string {
  try {
    const formats = dateFormats(zone);
    return (withDate ? formats.timeWithDate : formats.time).format(new Date(value));
  } catch { return ''; }
}

export function autonomyText(status: AgentStatus, zone: string): string {
  if (status.state === 'needs_setup') return '连接模型后处理已保存的消息与线索。';
  if (status.state === 'paused') return '新线索先保存；已排提醒仍会投递。';
  if (status.state === 'working') return '正在处理已有线索。';
  if (status.state === 'error') return '有一次异常待查看，详情见运行记录。';
  if (status.pending) return '有线索待处理。';
  const next = status.nextWakeAt && dateTime(status.nextWakeAt, zone, true);
  return next ? `下次计划唤醒：${next}` : '暂无定时安排，等待新消息或资料。';
}

export function tokenUsageText(usage: { inputTokens: number; outputTokens: number; usageStatus?: RunUsageStatus }, withTotal = true): string {
  const total = usage.inputTokens + usage.outputTokens;
  if (usage.usageStatus === 'not_used' && total === 0) return '未调用模型';
  if (usage.usageStatus !== 'reported' && total === 0) return '用量未知，模型未返回完整统计';
  return `输入 ${usage.inputTokens.toLocaleString()} / 输出 ${usage.outputTokens.toLocaleString()}${withTotal ? ` / 合计 ${total.toLocaleString()}` : ''} tokens${usage.usageStatus === 'reported' ? '' : '（已报告部分）'}`;
}

export function attachmentSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function download(name: string, content: string, type = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
