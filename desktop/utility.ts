import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { DeviceOperationReceipt } from '../shared/local-device.js';
import { LocalHand } from './hand.js';
import { OperationJournal } from './journal.js';
import { loadMxc, type MxcAdapter } from './mxc.js';
import { consumeEvents, deviceFetch } from './transport.js';
import type { LocalGrant } from './security.js';
import { ProjectHand } from './project-hand.js';
import { ProjectJournal } from './project-journal.js';
import type { ProjectResources } from './project-configuration.js';

interface Configuration { baseUrl: string; deviceId: string; credential: string; grants: LocalGrant[]; privateDirectory: string; version: string; downloadsDirectory?: string; projectResources: ProjectResources }
interface ParentPort { on(name: 'message', callback: (event: { data: { kind: string; configuration?: Configuration; requestId?: string } }) => void): void; postMessage(value: unknown): void }
const parent = (process as unknown as { parentPort: ParentPort }).parentPort;
let generation = 0;
let current: { controller: AbortController; hand?: LocalHand; projects?: ProjectHand; done?: Promise<void> } | undefined;
let mutations = Promise.resolve();
const status = (message: string) => parent.postMessage({ kind: 'status', message });
const delay = (milliseconds: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, milliseconds); signal.addEventListener('abort', finish, { once: true });
});
async function stop(): Promise<void> {
  const previous = current;
  if (!previous) return;
  previous.controller.abort();
  const drained = Promise.all([previous.hand?.stop(), previous.projects?.stop()]);
  await previous.done?.catch(() => {});
  await drained;
  if (current === previous) current = undefined;
}
async function start(configuration: Configuration, expected: number): Promise<void> {
  if (expected !== generation) return;
  const active = { controller: new AbortController() } as NonNullable<typeof current>;
  current = active;
  let adapter: MxcAdapter | undefined;
  try { adapter = await loadMxc(); }
  catch { status('本地命令隔离不可用，仍可查询获准的目录。'); }
  if (expected !== generation || active.controller.signal.aborted) return;
  const postReceipt = async (receipt: DeviceOperationReceipt) => {
    await deviceFetch(configuration.baseUrl, '/api/device/results', configuration.credential, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(receipt), signal: AbortSignal.timeout(15000),
    });
  };
  const journal = new OperationJournal(path.join(configuration.privateDirectory, 'operations'));
  await mkdir(path.join(configuration.privateDirectory, 'isolation-anchor'), { recursive: true });
  const hand = new LocalHand(configuration.deviceId, configuration.grants, journal, adapter, configuration.privateDirectory, postReceipt, status,
    async (message, signal) => { const response = await deviceFetch(configuration.baseUrl, '/api/device/admit', configuration.credential, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: message.operationId, specHash: message.specHash }),
      signal: AbortSignal.any([signal, active.controller.signal, AbortSignal.timeout(15000)]) });
      const admission = await response.json() as { accepted?: boolean; deadline?: number };
      if (admission.accepted !== true || admission.deadline !== message.deadline) throw new Error('服务器未返回有效的一次性执行许可。'); }, configuration.downloadsDirectory);
  active.hand = hand;
  const projects = new ProjectHand({ deviceId: configuration.deviceId, baseUrl: configuration.baseUrl, credential: configuration.credential,
    resources: configuration.projectResources, journal: new ProjectJournal(path.join(configuration.privateDirectory, 'projects')), status,
    post: async event => {
      const response = await deviceFetch(configuration.baseUrl, '/api/device/projectevents', configuration.credential, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(15000) });
      return response.json() as Promise<{ sequence: number }>;
    } });
  active.projects = projects;
  active.done = (async () => {
    await hand.recover();
    await projects.recover();
    let backoff = 1000;
    while (!active.controller.signal.aborted && expected === generation) {
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      let pulseAttempt: Promise<unknown> | undefined;
      let online = false;
      try {
        const announce = async () => {
          const grants = await hand.advertisedGrants();
          const capabilities = [...await hand.advertisedCapabilities(grants), ...await projects.capabilities()];
          await deviceFetch(configuration.baseUrl, '/api/device/status', configuration.credential, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grants, capabilities, version: configuration.version }),
            signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(15000)]) });
          parent.postMessage({ kind: 'grants', grants, capabilities });
        };
        await hand.flushReceipts();
        await projects.flush();
        await announce();
        const response = await deviceFetch(configuration.baseUrl, '/api/device/events', configuration.credential,
          { headers: { Accept: 'text/event-stream' }, signal: active.controller.signal });
        if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('设备事件通道格式错误。');
        online = true;
        parent.postMessage({ kind: 'connection', online });
        status('已连接服务，等待获准的本地任务。'); backoff = 1000;
        const pulse = async () => {
          if (!online || active.controller.signal.aborted) return;
          // A failed status update must never prevent an authorized late receipt.
          pulseAttempt = Promise.allSettled([hand.flushReceipts({ whileRunning: true }), projects.flush(), announce()]);
          await pulseAttempt;
          if (online && !active.controller.signal.aborted) heartbeat = setTimeout(() => { void pulse(); }, 30000);
        };
        heartbeat = setTimeout(() => { void pulse(); }, 30000);
        await consumeEvents(response, message => { if (message.kind.startsWith('project-')) projects.accept(message); else hand.accept(message); }, active.controller.signal);
      } catch (error) { if (!active.controller.signal.aborted) status(`设备连接中断：${(error as Error).message} 将重连；原操作不会自动重做。`); }
      finally {
        online = false;
        parent.postMessage({ kind: 'connection', online });
        if (heartbeat) clearTimeout(heartbeat);
        hand.cancelAll('设备事件连接已断开，正在结束原操作。');
        await projects.pause('设备连接中断，正在保存会话并排空本机操作。')
          .catch(error => status('原项目进程退出仍待核对，已保留记录并继续同步：' + (error as Error).message));
        await pulseAttempt;
      }
      if (!active.controller.signal.aborted) { await delay(backoff, active.controller.signal); backoff = Math.min(backoff * 2, 30000); }
    }
  })();
}
parent.on('message', event => {
  const message = event.data;
  if (!['configure', 'stop'].includes(message.kind)) return;
  const expected = ++generation;
  // Close admission synchronously before queueing the lifecycle mutation.
  current?.controller.abort();
  const drain = Promise.all([current?.hand?.stop(), current?.projects?.stop()]);
  mutations = mutations.then(async () => {
    await drain;
    await stop();
    if (message.kind === 'configure' && message.configuration && expected === generation) await start(message.configuration, expected);
    if (message.kind === 'stop') parent.postMessage({ kind: 'stopped', requestId: message.requestId });
  }).catch(error => { status(`本地执行层错误：${(error as Error).message}`); if (message.requestId) parent.postMessage({ kind: 'stop-failed', requestId: message.requestId, error: (error as Error).message }); });
});
parent.postMessage({ kind: 'ready' });
