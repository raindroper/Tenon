import path from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { ContainerRequest, MxcProcess } from '@microsoft/mxc-sdk/v1';
import type { LegacyDeviceCommandSpec } from '../shared/local-device.js';
import { commandLine, type LocalGrant } from './security.js';
import { decodeCommandOutput } from './command-output.js';

export interface MxcAdapter {
  getPlatformSupport(): { isSupported: boolean; isolationTier?: string };
  probe(request: ContainerRequest): { tier?: string; needsDaclAugmentation?: boolean; error?: string; warnings?: string[] };
  spawn(request: ContainerRequest, options?: { telemetry?: { enabled: boolean } }): Promise<MxcProcess>;
}
export async function loadMxc(): Promise<MxcAdapter> { return await import('@microsoft/mxc-sdk/v1'); }
export function sandboxRequest(spec: LegacyDeviceCommandSpec, grant: LocalGrant, privateDirectory: string, environment = process.env): ContainerRequest {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  const localAppData = environment.LOCALAPPDATA;
  if (!systemRoot || !localAppData) throw new Error('缺少 Windows 系统环境，无法启动隔离执行。');
  const systemTools = path.win32.join(systemRoot, 'System32');
  const toolchain = grant.executableOnly ? [] : [grant.toolchainRoot];
  const readonlyPaths = [grant.executable, ...toolchain, systemRoot, ...(grant.readOnly ? [grant.root] : [])];
  return {
    command: commandLine(spec.executable, spec.args), workingDirectory: spec.cwd, timeoutMs: spec.timeoutMs,
    environment: { SYSTEMROOT: systemRoot, LOCALAPPDATA: localAppData,
      PATH: [...toolchain, systemTools].join(';'),
      TEMP: spec.cwd, TMP: spec.cwd }, inheritDefaultEnvironment: false,
    filesystem: { readonlyPaths, readwritePaths: grant.readOnly ? [] : [grant.root], deniedPaths: [privateDirectory], clearPolicyOnExit: true },
    network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } },
    // Node and other Windows tools require Win32k during DLL initialization.
    // Permit initialization while denying external UI objects and input.
    ui: { disable: false, clipboard: 'none', allowInputInjection: false },
    // enumeratePaths cannot downgrade to legacy AppContainer/DACL. Use an empty
    // private anchor: overlapping an actual workspace grant would narrow it to
    // enumeration-only, overriding its read/write access in Windows PSEC.
    containment: { type: 'processcontainer', config: { filesystem: { enumeratePaths: [path.win32.join(privateDirectory, 'isolation-anchor')] },
      ui: { isolation: 'container', desktopSystemControl: false, systemSettings: 'none', ime: false } } },
  };
}
export function requireStrictProbe(adapter: MxcAdapter, request: ContainerRequest): void {
  if (!adapter.getPlatformSupport().isSupported) throw new Error('此设备未提供 MXC 隔离能力。');
  const probe = adapter.probe(request);
  if (probe.error || probe.tier !== 'base-container' || probe.needsDaclAugmentation) throw new Error(`严格隔离不可用：${probe.error ?? probe.tier ?? '未检测到原生 PSEC'}。未使用非隔离执行或 DACL 降级。`);
}
export interface CommandResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; outputLimited: boolean }
export class NativeDrainError extends Error {}
export async function runSandbox(adapter: MxcAdapter, request: ContainerRequest, signal: AbortSignal, beforeSpawn?: () => Promise<void>): Promise<CommandResult> {
  requireStrictProbe(adapter, request);
  await beforeSpawn?.();
  if (signal.aborted) return { exitCode: -1, stdout: '', stderr: '', timedOut: false, cancelled: true, outputLimited: false };
  const child = await adapter.spawn(request, { telemetry: { enabled: false } });
  let outputLimited = false;
  let outputBytes = 0;
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  const kill = () => child.kill();
  const abort = () => { try { kill(); } catch { /* wait() must still establish the actual terminal result. */ } };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const watch = (stream: Readable | null, chunks: Buffer[]): Promise<void> => {
    if (!stream) return Promise.resolve();
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = Math.min(bytes.length, Math.max(0, 128 * 1024 - outputBytes));
      if (retained) chunks.push(Buffer.from(bytes.subarray(0, retained)));
      outputBytes += bytes.length;
      if (outputBytes > 128 * 1024 && !outputLimited) { outputLimited = true; abort(); }
    });
    return finished(stream).then(() => {});
  };
  const output = watch(child.standardOutput, stdout);
  const errorOutput = watch(child.standardError, stderr);
  // Observe rejections immediately while native wait drains; never return early
  // while one of the accepted native calls or streams remains alive.
  const streams = Promise.allSettled([output, errorOutput]);
  try {
    const result = await child.wait();
    const completedStreams = await streams;
    const failed = completedStreams.find(item => item.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    child.dispose(); // wait() and both output streams have settled first.
    return { exitCode: result.exitCode, timedOut: result.timedOut,
      stdout: decodeCommandOutput(Buffer.concat(stdout), undefined, outputLimited),
      stderr: decodeCommandOutput(Buffer.concat(stderr), undefined, outputLimited), cancelled: signal.aborted, outputLimited };
  } catch (error) {
    abort();
    // A rejected wait may still have native cleanup underway. The SDK owns the
    // process tree; dispose is cleanup only, never an acknowledgement of stop.
    await streams;
    throw new NativeDrainError(`无法确认原生命令已完全结束：${(error as Error).message}`);
  } finally { signal.removeEventListener('abort', abort); }
}
