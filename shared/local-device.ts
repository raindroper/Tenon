import { z } from 'zod';
import type { ProjectServerMessage } from './local-project.js';

const absoluteWindowsPath = z.string().min(3).max(4000).refine(value => /^[A-Za-z]:[\\/]/.test(value) && !/[\0\r\n]/.test(value), '须使用设备上的本地绝对路径。');
export const legacyDeviceCommandSpecSchema = z.object({
  deviceId: z.string().min(1).max(200), grantId: z.string().min(1).max(200), grantRevision: z.number().int().positive(),
  executable: absoluteWindowsPath, args: z.array(z.string().max(16000).refine(value => !value.includes('\0'))).max(100),
  cwd: absoluteWindowsPath, timeoutMs: z.number().int().min(1).max(300000),
}).strict();
export type LegacyDeviceCommandSpec = z.infer<typeof legacyDeviceCommandSpecSchema>;

const taskPath = absoluteWindowsPath.refine(value => !/[:<>"|?*\x00-\x1f]/.test(value.slice(2)) && !/[. ](?:[\\/]|$)/.test(value), '任务路径不能包含设备名、备用数据流或有歧义的路径段。');
export const taskDevicePathSchema = taskPath;
export const taskDeviceCommandSpecSchema = z.object({
  deviceId: z.string().min(1).max(200),
  executable: taskPath.refine(value => /\.exe$/i.test(value), '请使用 .exe 的绝对路径。'),
  args: z.array(z.string().max(16000).refine(value => !/[\0\r\n]/.test(value), '命令参数不能包含 NUL 或换行。')).max(100),
  timeoutMs: z.number().int().min(1).max(300000),
  access: z.discriminatedUnion('kind', [z.object({ kind: z.literal('scratch') }).strict(),
    z.object({ kind: z.literal('directory'), root: taskPath, readOnly: z.boolean() }).strict()]),
}).strict();
export type TaskDeviceCommandSpec = z.infer<typeof taskDeviceCommandSpecSchema>;
export const taskCommandCapability = 'local_command_task_scope';
export const deviceDirectoryLookupSchema = z.object({
  kind: z.literal('list_directory'), deviceId: z.string().min(1).max(200),
  root: z.union([z.literal('windows-downloads'), taskPath]), timeoutMs: z.number().int().min(1).max(300000),
  extension: z.string().trim().regex(/^[A-Za-z0-9]{1,15}$/).transform(value => value.toLowerCase()).optional(),
  nameContains: z.string().trim().min(1).max(120).refine(value => !/[\x00-\x1f\\/]/.test(value)).optional(),
  entryType: z.enum(['file', 'directory']).optional(),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();
export type DeviceDirectoryLookupSpec = z.infer<typeof deviceDirectoryLookupSchema>;
export const deviceDirectoryLookupCapability = 'local_directory_lookup';
export const deviceDirectoryEntriesCapability = 'local_directory_entries';
export const deviceDirectoryLookupResultSchema = z.object({
  entryType: z.enum(['file', 'directory']).optional(),
  directory: taskPath, files: z.array(z.object({ name: z.string().min(1).max(255).refine(value => !/[\x00-\x1f\\/]/.test(value)),
    size: z.number().int().nonnegative(), modifiedAt: z.string().datetime() }).strict()).max(100),
  scanned: z.number().int().nonnegative(), truncated: z.boolean(),
}).strict().refine(result => result.scanned >= result.files.length);
export type DeviceDirectoryLookupResult = z.infer<typeof deviceDirectoryLookupResultSchema>;
export const deviceCommandSpecSchema = z.union([legacyDeviceCommandSpecSchema, taskDeviceCommandSpecSchema, deviceDirectoryLookupSchema]);
export type DeviceCommandSpec = z.infer<typeof deviceCommandSpecSchema>;
export interface DeviceGrant {
  id: string; revision: number; root: string; executable: string; readOnly: boolean; available?: boolean; reason?: string;
}
export interface LocalDevice {
  id: string; name: string; platform: 'win32' | 'linux'; createdAt: string; lastSeenAt?: string; revokedAt?: string;
  grants: DeviceGrant[]; capabilities: string[]; version?: string; online: boolean;
}
export type DeviceOperationState = 'dispatched' | 'running' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface DeviceOperationReceipt {
  operationId: string; state: DeviceOperationState; exitCode?: number; stdout?: string; stderr?: string; error?: string;
  startedAt?: string; finishedAt?: string;
}
export interface DeviceOperation {
  operationId: string; taskId: string; taskRevision: number; runId: string; specHash: string; spec: DeviceCommandSpec;
  /** Server-side requirement snapshot. Historical operations belong to version 1. */
  requirementsRevision?: number;
  issuedAt: string; deadline: number; admittedAt?: string; receipt: DeviceOperationReceipt; receiptReceivedAt?: string;
}
export interface DeviceExecuteMessage extends Omit<DeviceOperation, 'receipt' | 'requirementsRevision'> { kind: 'execute' }
export interface DeviceCancelMessage { kind: 'cancel'; operationId: string; reason: string }
export type DeviceServerMessage = DeviceExecuteMessage | DeviceCancelMessage | ProjectServerMessage;
export interface DeviceEnrollment { device: LocalDevice; credential: string }
export interface DevicePairing { token: string; expiresAt: string }
export interface DeviceStatusUpdate { grants: DeviceGrant[]; capabilities?: string[]; version?: string }

/** Only call after the operation has been matched to the exact approved task. */
export function commandFailureMessage(receipt: DeviceOperationReceipt): string {
  const state = receipt.state === 'unknown' ? '本地命令结果尚未确认，不会自动重新执行'
    : receipt.state === 'cancelled' ? '本地命令已取消'
      : receipt.state === 'failed' || receipt.state === 'completed' ? '本地命令执行失败' : '本地命令尚未返回完成回执';
  const code = receipt.exitCode === undefined ? '' : `（退出码 ${receipt.exitCode}）`;
  const detail = [receipt.error?.trim(), receipt.stderr?.trim()].filter((value): value is string => Boolean(value));
  return `${state}${code}。${detail.length ? '\n' + [...new Set(detail)].join('\n').replace(/\u0000/g, '').slice(0, 2000) : ''}`;
}
