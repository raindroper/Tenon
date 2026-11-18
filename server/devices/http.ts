import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ProjectError, projectInputForDevice } from './projects.js';
import { projectGuardSchema, projectEventSchema } from '../../shared/local-project.js';
import { DeviceBroker, DeviceBrokerError, deviceEnrollmentSchema } from './broker.js';
import type { DeviceOperationReceipt, DeviceStatusUpdate } from '../../shared/local-device.js';
import { weChatObservationBatch, weChatObservationBinding } from '../../shared/wechat-observation.js';
import { RuntimeInputError, type RuntimeWeChatObservationCommands } from '../runtime.js';
import { projectScreenshotInput } from '../v2/images.js';
import { HttpError, readJsonBody as readJson } from '../http.js';
import { projectFilesUploadSchema } from '../../shared/project-files.js';

const serverWorkerRoutes = new Set(['/api/device/status', '/api/device/events', '/api/device/projectevents',
  '/api/device/projectguard', '/api/device/projectmodel', '/api/device/projectcontext', '/api/device/projectfiles']);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body));
}

function parameterIssues(error: z.ZodError) {
  return error.issues.slice(0, 5).map(issue => {
    const field = issue.path.map(value => {
      if (typeof value === 'number') return String(value);
      return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(value)) ? String(value) : '[字段]';
    }).join('.') || 'input';
    let limit: string | undefined;
    let rule = '不符合字段约束';
    if (issue.code === 'too_big') { limit = String(issue.maximum); rule = `最大为 ${limit}`; }
    else if (issue.code === 'too_small') { limit = String(issue.minimum); rule = `最小为 ${limit}`; }
    else if (issue.code === 'invalid_type') rule = `需要 ${issue.expected}`;
    else if (issue.code === 'unrecognized_keys') rule = '包含未支持字段';
    else if (issue.code === 'invalid_value') rule = '取值不在允许范围内';
    return { field, code: issue.code, rule, ...(limit ? { limit } : {}) };
  });
}
/** Called before owner cookie auth. Only device paths accept scoped device credentials. */
export async function routeDeviceHttp(broker: DeviceBroker, request: IncomingMessage, response: ServerResponse, path: string, method = request.method ?? 'GET',
  weChatObservations?: Pick<RuntimeWeChatObservationCommands, 'ingest' | 'stopFromDevice'>): Promise<boolean> {
  if (!path.startsWith('/api/device/')) return false;
  let contextTool: string | undefined;
  try {
    // Device bridges are native outgoing clients. A browser Origin never authorizes enrollment or OS calls.
    if (request.headers.origin !== undefined) throw new DeviceBrokerError(403, '设备连接不接受网页来源请求。');
    if (path === '/api/device/enroll' && method === 'POST') {
      json(response, 201, broker.enroll(deviceEnrollmentSchema.parse(await readJson(request)))); return true;
    }
    const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
    const device = match ? broker.authenticate(match[1], { allowRevoked: path === '/api/device/results' || path === '/api/device/projectevents' }) : undefined;
    if (!device) throw new DeviceBrokerError(401, '设备凭据无效或连接已撤销。');
    if (device.platform === 'linux' && !serverWorkerRoutes.has(path)) throw new DeviceBrokerError(403, '服务端设备凭据只适用于隔离项目协议。');
    if (path === '/api/device/projectfiles' && method === 'POST') {
      const input = projectFilesUploadSchema.parse(await readJson(request, 8 * 1024 * 1024));
      json(response, 200, broker.projects.fileResults.receive(device.id, input)); return true;
    }
    if (path === '/api/device/projectevents' && method === 'POST') {
      const raw = await readJson(request);
      const events = z.array(projectEventSchema).min(1).max(50).refine(values => values.every((value, index) =>
        value.operationId === values[0].operationId && (!index || value.sequence === values[index - 1].sequence + 1)))
        .parse(Array.isArray(raw) ? raw : [raw]);
      json(response, 200, broker.projects.recordBatch(device.id, events)); return true;
    }
    if (path === '/api/device/projectguard' && method === 'POST') {
      const value = broker.projects.authorize(device.id, projectGuardSchema.parse(await readJson(request)));
      json(response, 200, { accepted: true, requirementsRevision: value.operation.input.requirementsRevision,
        sequence: value.operation.sequence, input: projectInputForDevice(value.operation.input, device) }); return true;
    }
    if (path === '/api/device/projectmodel' && method === 'POST') {
      const value = z.object({ authorization: projectGuardSchema, requestId: z.string().min(1).max(200),
        request: z.record(z.string(), z.unknown()) }).strict().parse(await readJson(request));
      const authorized = broker.projects.authorize(device.id, value.authorization);
      await authorized.context.model(authorized.operation, request, response, value.request, value.requestId); return true;
    }
    if (path === '/api/device/projectcontext' && method === 'POST') {
      const value = z.object({ authorization: projectGuardSchema, input: z.record(z.string(), z.unknown()) }).strict().parse(await readJson(request));
      const authorized = broker.projects.authorize(device.id, value.authorization);
      if (value.input.action === 'call' && typeof value.input.name === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value.input.name)) contextTool = value.input.name;
      json(response, 200, await authorized.context.context(authorized.operation, value.input)); return true;
    }
    if (path === '/api/device/projectevidence' && method === 'POST') {
      const value = z.object({ authorization: projectGuardSchema, image: projectScreenshotInput }).strict()
        .parse(await readJson(request));
      json(response, 200, await broker.projects.recordEvidence(device.id, value.authorization, value.image)); return true;
    }
    if (path === '/api/device/wechatobservations' && weChatObservations) {
      if (method === 'POST') {
        const input = weChatObservationBatch.parse(await readJson(request));
        json(response, 200, await weChatObservations.ingest(device.id, input)); return true;
      }
      if (method === 'DELETE') {
        const input = weChatObservationBinding.parse(await readJson(request));
        json(response, 200, await weChatObservations.stopFromDevice(device.id, input)); return true;
      }
    }
    if (path === '/api/device/status' && method === 'POST') {
      json(response, 200, broker.updateDevice(device.id, await readJson(request) as DeviceStatusUpdate)); return true;
    }
    if (path === '/api/device/results' && method === 'POST') {
      json(response, 200, broker.recordResult(device.id, await readJson(request) as DeviceOperationReceipt)); return true;
    }
    if (path === '/api/device/admit' && method === 'POST') {
      json(response, 200, broker.admit(device.id, await readJson(request) as { operationId: string; specHash: string })); return true;
    }
    if (path === '/api/device/events' && method === 'GET') {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let ready = false; const buffered: string[] = [];
      const deliver = (frame: string) => {
        if (response.destroyed || response.writableEnded) throw new DeviceBrokerError(409, '设备连接已中断。');
        if (!response.write(frame) && response.writableLength > 4 * 1024 * 1024) {
          response.destroy(); throw new DeviceBrokerError(409, '设备连接无法及时接收命令。');
        }
      };
      const detach = broker.attach(device.id, message => {
        const frame = `event: operation\ndata: ${JSON.stringify(message)}\n\n`;
        if (!ready) buffered.push(frame); else deliver(frame);
      }, () => response.end());
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
      response.flushHeaders(); response.write(': device-connected\n\n'); ready = true; for (const frame of buffered) deliver(frame);
      heartbeat = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n'); }, 15000); heartbeat.unref();
      response.once('close', () => { clearInterval(heartbeat); detach(); }); return true;
    }
    throw new DeviceBrokerError(405, '不支持此设备操作。');
  } catch (error) {
    if (response.headersSent) response.destroy();
    else {
      const known = error instanceof HttpError || error instanceof DeviceBrokerError || error instanceof RuntimeInputError || error instanceof ProjectError;
      const issues = error instanceof z.ZodError ? parameterIssues(error) : undefined;
      json(response, known ? error.status : error instanceof z.ZodError ? 400 : 500,
        { error: known ? error.message : issues ? issues.map(issue => `${contextTool ? contextTool + '.' : ''}${issue.field} ${issue.rule}。`).join(' ') : '设备连接处理失败。',
          ...(issues ? { code: contextTool ? 'invalid_tool_arguments' : 'invalid_device_arguments', ...(contextTool ? { tool: contextTool } : {}), issues } : {}) });
    }
    return true;
  }
}
