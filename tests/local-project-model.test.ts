import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { UsageTracker } from '../server/v2/usage.js';
import { forwardProjectModel, responsesUsage } from '../server/v2/project-model.js';
import { ProjectBroker, ProjectError, projectSpecHash } from '../server/devices/projects.js';
import { localProjectCapability, localProjectSpecSchema, type ProjectExecutionInput } from '../shared/local-project.js';
import { ProjectModelStream } from '../shared/project-model-stream.js';
import { ProjectBridge } from '../desktop/project-bridge.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';
import type { Run } from '../shared/types.js';

async function fixture(contractVersion?: 2) {
  const store = new Store(await mkdtemp(join(tmpdir(), 'rae-project-model-')));
  const db = new DatabaseSync(':memory:');
  store.getApiKey = () => 'offline-fixture-key';
  const broker = new ProjectBroker(db, { device: id => ({ id, name: 'fixture', platform: 'win32', online: true, grants: [],
    capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability], createdAt: new Date().toISOString() }), send() {}, assertActive() {}, changed() {}, result() {} });
  const spec = localProjectSpecSchema.parse({ deviceId: 'device' });
  const input: ProjectExecutionInput = { operationId: 'operation', taskId: 'task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'fixture', objective: 'fixture', expectedOutput: 'fixture', ownerRequest: 'fixture', updates: [],
    model: { model: store.getSettings().model, reasoningEffort: 'high', maxOutputTokens: null }, stepLimit: 2, deadline: null, issuedAt: new Date().toISOString(),
    ...(contractVersion ? { contract: { version: contractVersion, requirements: [] } } : {}) };
  const controller = new AbortController();
  const pending = broker.run(input, { signal: controller.signal, guard() {}, onEvent() {}, async model() {}, async context() {} });
  const run: Run = { id: 'run', taskId: 'task', mode: 'execution', trigger: 'manual', status: 'running', startedAt: new Date().toISOString(),
    steps: 0, inputTokens: 0, outputTokens: 0, usageStatus: 'not_used', taskExecution: { deadline: null, stepLimit: 2, requirementsRevision: 1 } };
  store.insert('runs', run);
  return { broker, input, run, controller, options: { store, projects: broker, run, usage: new UsageTracker(store), signal: controller.signal,
    guard() {}, save() { store.put('runs', run); } }, async close() {
      broker.record('device', { operationId: 'operation', sequence: 1, requirementsRevision: 1, at: new Date().toISOString(),
        event: { kind: 'finished', state: contractVersion ? 'failed' : 'completed', output: 'fixture complete' } });
      await pending;
      db.close();
      store.close();
    } };
}

test('project Responses relay retains actual provider usage after desktop disconnect', async () => {
  const { broker, input, run, options, close } = await fixture();
  const response = { destroyed: true, writeHead() {}, write() { throw new Error('A disconnected downstream cannot receive more bytes'); }, end() {} } as unknown as ServerResponse;
  let read = 0; let calls = 0; let permitted = true;
  try {
    const binding = options.store.models.resolve({ purpose: 'task' })!;
    options.store.models.recordDiagnostic(binding.selection.connectionId, { category: 'transport', message: 'Prior connection failure', at: new Date().toISOString() },
      { expectedIdentityRevision: binding.identityRevision, expectedBindingRevision: binding.bindingRevision });
    await forwardProjectModel({ ...options, guard() { assert.ok(permitted); },
      fetch: async (_address, init) => {
        calls++; const body = JSON.parse(String(init?.body));
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer offline-fixture-key');
        assert.equal(body.store, false); assert.equal(body.max_output_tokens, undefined);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({ pull(stream) {
          read++;
          if (read === 1) stream.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"durable public text"}\n\n'));
          else if (read === 2) stream.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"fixture","usage":{"input_tokens":17,"output_tokens":8,"total_tokens":25}}}\n\n'));
          else stream.close();
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      } }, broker.get('operation')!, {} as IncomingMessage, response, { model: input.model.model, tools: [{ type: 'namespace', name: 'fixture', tools: [] }],
        max_output_tokens: 1, store: true }, 'request-1');
    assert.ok(read >= 2); assert.equal(calls, 1); assert.equal(run.steps, 1);
    assert.equal(run.inputTokens, 17); assert.equal(run.outputTokens, 8); assert.equal(run.usageStatus, 'reported'); assert.equal(run.pendingModelCalls, 0);
    assert.equal(broker.receivedModelText('operation'), 'durable public text');
    assert.equal(broker.get('operation')?.modelCalls, 1);
    const receipt = broker.export().modelCalls.find(value => value.requestId === 'request-1') as { transport?: { responseId?: string; receivedBytes: number; forwardedBytes: number; terminalMs: number } } | undefined;
    assert.equal(receipt?.transport?.responseId, 'fixture');
    assert.ok(receipt!.transport!.receivedBytes > 0 && receipt!.transport!.forwardedBytes > 0);
    assert.ok(receipt!.transport!.terminalMs >= 0);
    assert.equal(options.store.models.get(binding.selection.connectionId)?.recentDiagnostic, undefined);
    permitted = false;
    await assert.rejects(forwardProjectModel({ ...options,
      guard() { if (!permitted) throw new Error('revoked'); }, save() {}, fetch: async () => { throw new Error('Must not dispatch'); } },
    broker.get('operation')!, {} as IncomingMessage, response, { model: input.model.model }, 'request-2'), /revoked/);
    assert.equal(broker.get('operation')?.modelCalls, 1);
    assert.deepEqual(responsesUsage({ input_tokens: 4 }), { inputTokens: 4, outputTokens: 0, usageStatus: 'partial' });
    assert.equal(responsesUsage(undefined).usageStatus, 'unknown');
  } finally { await close(); }
});

const textFrame = 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"已收到"}\r\n\r\n';
const tornFrame = 'event: response.completed\ndata: {"type":"response.completed","response":';
const providerUsage = { input_tokens: 17, output_tokens: 8, total_tokens: 25 };
const eventStream = (body: ReadableStream<Uint8Array>) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
const bytes = (value: string) => new TextEncoder().encode(value);

test('fragmented large SSE event is held until the blank line and does not lose following events', () => {
  const relay = new ProjectModelStream();
  const seen: unknown[] = [];
  const piece = 'x'.repeat(8192);
  const encoded = bytes(piece);
  assert.equal(relay.push(bytes('data: {"type":"response.output_text.delta","delta":"')), '');
  for (let i = 0; i < 1024; i++) assert.equal(relay.push(encoded), '');
  assert.equal(relay.push(bytes('"}\r\n')), '');
  const forwarded = relay.push(bytes('\r\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture"}}\n\n'),
    event => seen.push(event.type === 'response.output_text.delta' ? String(event.delta).length : event.type));
  assert.deepEqual(seen, [8 * 1024 * 1024, 'response.completed']);
  assert.match(forwarded, /\n\nevent: response.completed\ndata: .*\n\n$/);
  assert.equal(relay.terminal, true);
});

function downstream() {
  const out = { headers: 0, chunks: [] as string[], ended: 0 };
  const events = new EventEmitter();
  const response = Object.assign(events, { destroyed: false, writableEnded: false, writeHead() { out.headers++; }, flushHeaders() {},
    write(value: string) { out.chunks.push(value); },
    end(value?: string) { this.writableEnded = true; out.ended++; if (value) out.chunks.push(value); },
    destroy() { this.destroyed = true; events.emit('close'); },
  }) as unknown as ServerResponse;
  return { out, response, content: () => out.chunks.join('') };
}

test('native compaction keeps its stream and usage but never becomes task fallback text', async () => {
  const { broker, input, run, options, close } = await fixture();
  const summary = 'Internal checkpoint: rerun the failing test.';
  const output = 'Fixed the issue and verified the test.';
  try {
    for (const [kind, text] of [['compaction', summary], ['turn', output]]) {
      const { response, content } = downstream();
      await forwardProjectModel({ ...options, fetch: async () => new Response(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`
        + `data: ${JSON.stringify({ type: 'response.completed', response: { id: kind, usage: providerUsage } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ) }, broker.get('operation')!, {} as IncomingMessage, response, {
        model: input.model.model, client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ request_kind: kind }) },
      }, kind);
      assert.ok(content().includes(text), 'The task device must receive the complete provider stream');
      assert.equal(broker.receivedModelText('operation'), kind === 'compaction' ? '' : output);
    }
    const [compact, turn] = broker.export().modelCalls;
    assert.equal(compact.purpose, 'compaction');
    assert.equal(compact.publicText, undefined);
    assert.equal(turn.publicText, output);
    assert.equal(run.steps, 2);
    assert.equal(run.inputTokens, 34);
    assert.equal(run.outputTokens, 16);
    assert.equal(run.pendingModelCalls, 0);
  } finally { await close(); }
});

test('relay turns a cut or aborted SSE stream into one framed failure and retains only received content', async t => {
  for (const scenario of ['missing_terminal', 'transport_interrupted', 'request_timeout', 'task_stopped'] as const) {
    await t.test(scenario, async () => {
      const { broker, input, run, controller, options, close } = await fixture();
      const { out, response, content } = downstream();
      let calls = 0;
      // Keep the timer alive for the deliberately silent provider fixture.
      const keepAlive = setTimeout(() => {}, 1000);
      try {
        let pull = 0;
        let stop: ReturnType<typeof setTimeout> | undefined;
        const chunks = bytes(textFrame + tornFrame);
        const split = Buffer.byteLength(textFrame.slice(0, textFrame.indexOf('已'))) + 1;
        await forwardProjectModel({ ...options, requestTimeoutMs: scenario === 'request_timeout' ? 25 : 2000,
          fetch: async () => {
            calls++;
            return eventStream(new ReadableStream<Uint8Array>({
              pull(stream) {
                pull++;
                if (pull === 1) stream.enqueue(chunks.subarray(0, split));
                else if (pull === 2) stream.enqueue(chunks.subarray(split));
                else if (scenario === 'missing_terminal') stream.close();
                else if (scenario === 'transport_interrupted') stream.error(new Error('private upstream detail'));
                else if (scenario === 'task_stopped') stop ??= setTimeout(() => controller.abort('private cancel detail'), 5);
              },
              cancel() { clearTimeout(stop); },
            }));
          },
        }, broker.get('operation')!, {} as IncomingMessage, response, { model: input.model.model }, 'request');
        assert.equal(calls, 1);
        assert.equal(out.headers, 1);
        assert.equal(out.ended, 1);
        assert.equal((content().match(/event: response.failed/g) ?? []).length, 1);
        assert.match(content(), /已收到/);
        assert.doesNotMatch(content(), /private|event: response.completed/);
        assert.ok(content().includes('"code":"' + scenario + '"'));
        assert.match(content(), /\n\nevent: response.failed\ndata: .*\n\n$/);
        assert.equal(run.pendingModelCalls, 0);
        assert.equal(run.usageStatus, 'unknown');
        assert.equal(broker.receivedModelText('operation'), '已收到');
        assert.equal(broker.export().modelCalls[0].failureCode, scenario);
        const connection = options.store.models.get(options.store.models.resolve({ purpose: 'task' })!.selection.connectionId)!;
        assert.equal(connection.recentDiagnostic?.category, scenario === 'task_stopped' ? undefined : 'transport');
        assert.equal(JSON.stringify(connection.recentDiagnostic ?? {}).includes('private'), false);
      } finally { clearTimeout(keepAlive); await close(); }
    });
  }
});

test('relay closes promptly at the provider terminal and preserves incomplete or failed outcome and usage', async t => {
  for (const scenario of ['completed', 'provider_incomplete', 'provider_failed', 'invalid_stream'] as const) {
    await t.test(scenario, async () => {
      const { broker, input, run, options, close } = await fixture();
      const { out, response, content } = downstream();
      let canceled = false;
      try {
        const providerType = scenario === 'provider_failed' ? 'response.failed' : 'response.completed';
        const payload = scenario === 'provider_failed' ? { error: { code: 'model_error', message: 'provider failure' } }
          : scenario === 'invalid_stream' ? {}
          : { id: 'fixture', ...(scenario === 'provider_incomplete' ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } : {}) };
        await forwardProjectModel({ ...options, fetch: async () => eventStream(new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(bytes(textFrame.slice(0, -1)));
            stream.enqueue(bytes('\n' + 'event: ' + providerType + '\ndata: ' + JSON.stringify({
              type: providerType, response: { ...payload, usage: providerUsage },
            }) + '\n\n' + tornFrame));
          },
          cancel() { canceled = true; assert.equal(out.ended, 1); },
        })) }, broker.get('operation')!, {} as IncomingMessage, response, { model: input.model.model }, 'request');
        assert.equal(canceled, true);
        assert.equal(out.ended, 1);
        const terminalType = scenario === 'completed' ? 'response.completed'
          : scenario === 'provider_incomplete' ? 'response.incomplete' : 'response.failed';
        assert.equal((content().match(new RegExp('event: ' + terminalType, 'g')) ?? []).length, 1);
        assert.doesNotMatch(content(), /missing_terminal|transport_interrupted/);
        assert.equal(run.inputTokens, 17);
        assert.equal(run.outputTokens, 8);
        assert.equal(run.usageStatus, 'reported');
        assert.equal(broker.receivedModelText('operation'), '已收到');
        assert.equal(broker.export().modelCalls[0].failureCode, scenario === 'completed' ? undefined : scenario);
        const connection = options.store.models.get(options.store.models.resolve({ purpose: 'task' })!.selection.connectionId)!;
        assert.equal(connection.recentDiagnostic?.category, scenario === 'completed' ? undefined : 'protocol');
        if (scenario === 'provider_incomplete') assert.equal(connection.recentDiagnostic?.code, 'response_incomplete');
      } finally { await close(); }
    });
  }
});

test('project HTTP diagnostics distinguish quota from bare 401 without clearing either account credential', async t => {
  for (const status of [429, 401]) await t.test(String(status), async () => {
    const { broker, input, options, close } = await fixture(); const { response } = downstream();
    try {
      await assert.rejects(forwardProjectModel({ ...options, fetch: async () => Response.json({ error: { code: status === 429 ? 'insufficient_quota' : 'not_accepted', message: 'private credential offline-fixture-key' } }, { status }) },
        broker.get('operation')!, {} as IncomingMessage, response, { model: input.model.model }, 'request'));
      const binding = options.store.models.resolve({ purpose: 'task' })!; const connection = options.store.models.get(binding.selection.connectionId)!;
      assert.equal(connection.status, 'ready'); assert.equal(connection.recentDiagnostic?.category, status === 429 ? 'quota' : 'permission');
      assert.equal(connection.recentDiagnostic?.status, status); assert.equal(JSON.stringify(connection.recentDiagnostic).includes('offline-fixture-key'), false);
      assert.ok(options.store.models.getCredential(connection.id));
    } finally { await close(); }
  });
});

test('relay returns an HTTP error before SSE begins when provider returns an incompatible response', async () => {
  const { broker, input, run, options, close } = await fixture();
  const { out, response } = downstream();
  try {
    await assert.rejects(forwardProjectModel({ ...options, fetch: async () => Response.json({ error: 'private body' }) },
      broker.get('operation')!, {} as IncomingMessage, response, { model: input.model.model }, 'request'),
    error => error instanceof ProjectError && error.status === 502 && !error.message.includes('private body'));
    assert.equal(out.headers, 0);
    assert.equal(run.pendingModelCalls, 0);
    assert.equal(broker.export().modelCalls[0].failureCode, 'invalid_stream');
  } finally { await close(); }
});

test('a Responses stream without Content-Type keeps text, terminal validation and provider usage', async () => {
  const { broker, input, run, options, close } = await fixture();
  const { out, response, content } = downstream();
  let cancelled = false;
  try {
    await forwardProjectModel({ ...options, fetch: async () => {
      const upstream = new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(bytes(textFrame.slice(0, -1)));
          stream.enqueue(bytes('\nevent: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed',
            response: { id: 'fixture', status: 'completed', usage: providerUsage } }) + '\n\n'));
        },
        cancel() { cancelled = true; },
      }));
      assert.equal(upstream.headers.get('content-type'), null);
      return upstream;
    } }, broker.get('operation')!, {} as IncomingMessage, response, { model: input.model.model }, 'request');
    assert.equal(out.headers, 1); assert.equal(out.ended, 1); assert.equal(cancelled, true);
    assert.match(content(), /response.completed/); assert.doesNotMatch(content(), /response.failed/);
    assert.equal(broker.receivedModelText('operation'), '已收到');
    assert.equal(broker.export().modelCalls[0].failureCode, undefined);
    assert.equal(run.inputTokens, 17); assert.equal(run.outputTokens, 8);
    assert.equal(run.usageStatus, 'reported'); assert.equal(run.pendingModelCalls, 0);
  } finally { await close(); }
});

test('a JSON completion without Content-Type cannot masquerade as a completed Responses stream', async () => {
  const { broker, input, run, options, close } = await fixture();
  const { response, content } = downstream();
  try {
    await forwardProjectModel({ ...options, fetch: async () => new Response(bytes(JSON.stringify({
      id: 'fixture', object: 'response', status: 'completed', output: [], usage: providerUsage,
    }))) }, broker.get('operation')!, {} as IncomingMessage, response, { model: input.model.model }, 'request');
    assert.match(content(), /response.failed/); assert.doesNotMatch(content(), /response.completed|input_tokens/);
    assert.equal(broker.receivedModelText('operation'), '');
    assert.equal(broker.export().modelCalls[0].failureCode, 'missing_terminal');
    assert.equal(run.usageStatus, 'unknown'); assert.equal(run.pendingModelCalls, 0);
  } finally { await close(); }
});

test('v2 lets native streaming outlive first-response waiting while legacy requests retain their total timeout', async t => {
  for (const contractVersion of [undefined, 2] as const) {
    const f = await fixture(contractVersion);
    const { response, content } = downstream();
    const configuredTimeouts: number[] = [];
    const timeout = t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      configuredTimeouts.push(milliseconds); return new AbortController().signal;
    });
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await forwardProjectModel({ ...f.options, firstResponseTimeoutMs: 20,
        fetch: async () => eventStream(new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(bytes(textFrame));
            terminalTimer = setTimeout(() => stream.enqueue(bytes('data: ' + JSON.stringify({ type: 'response.completed',
              response: { id: 'long-stream', usage: providerUsage } }) + '\n\n')), 60);
          },
          cancel() { clearTimeout(terminalTimer); },
        })) }, f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, 'long-stream');
      assert.deepEqual(configuredTimeouts, contractVersion === 2 ? [] : [180_000]);
      assert.match(content(), /response.completed/); assert.doesNotMatch(content(), /response.failed/);
      assert.equal(f.run.usageStatus, 'reported'); assert.equal(f.run.outputTokens, 8);
    } finally { timeout.mock.restore(); clearTimeout(terminalTimer); await f.close(); }
  }
});

test('v2 bounds first response and honors an explicitly configured request deadline', async t => {
  for (const scenario of ['first_response_timeout', 'request_timeout'] as const) await t.test(scenario, async () => {
    const f = await fixture(2);
    const { response, content } = downstream();
    let cancelled = false;
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await forwardProjectModel({ ...f.options, firstResponseTimeoutMs: 20,
        ...(scenario === 'request_timeout' ? { requestTimeoutMs: 30 } : {}),
        fetch: async () => eventStream(new ReadableStream<Uint8Array>({
          start(stream) { if (scenario === 'request_timeout') stream.enqueue(bytes(textFrame)); },
          cancel() { cancelled = true; },
        })) }, f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, 'timeout');
      assert.equal(cancelled, true); assert.match(content(), new RegExp(scenario));
      assert.equal(f.broker.export().modelCalls[0].failureCode, scenario);
      assert.equal(f.run.pendingModelCalls, 0); assert.equal(f.run.usageStatus, 'unknown');
    } finally { clearTimeout(keepAlive); await f.close(); }
  });
});

test('v2 records partial usage and releases the upstream reader when its execution consumer closes', async () => {
  const f = await fixture(2);
  const { response, content } = downstream();
  let readStarted!: () => void;
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  const write = response.write.bind(response);
  response.write = ((value: string) => { write(value); readStarted(); return true; }) as typeof response.write;
  let finishCancel!: () => void;
  const cancelFinished = new Promise<void>(resolve => { finishCancel = resolve; });
  let cancelStarted!: () => void;
  const cancelling = new Promise<void>(resolve => { cancelStarted = resolve; });
  let settled = false;
  const forwarding = forwardProjectModel({ ...f.options,
    fetch: async () => eventStream(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(bytes(textFrame + 'data: {"type":"response.in_progress","response":{"usage":{"input_tokens":17}}}\n\n')); },
      async cancel() { cancelStarted(); await cancelFinished; },
    })) }, f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, 'disconnect')
    .finally(() => { settled = true; });
  try {
    await reading;
    response.destroy();
    await cancelling; await Promise.resolve(); assert.equal(settled, false);
    assert.equal(f.broker.export().modelCalls[0].state, 'pending', 'The receipt must not report drain while reader cancellation is still running');
    finishCancel(); await forwarding;
    assert.match(content(), /已收到/);
    assert.equal(f.broker.export().modelCalls[0].failureCode, 'transport_interrupted');
    assert.equal(f.broker.export().modelCalls[0].state, 'settled');
    assert.equal(f.run.inputTokens, 17); assert.equal(f.run.usageStatus, 'partial'); assert.equal(f.run.pendingModelCalls, 0);
    assert.equal(f.controller.signal.aborted, false, 'A closed model consumer does not revoke the task');
  } finally { finishCancel(); await forwarding; await f.close(); }
});

test('a completed provider terminal keeps its operation pending until reader cancellation finishes', async () => {
  const f = await fixture(2);
  const { response, content } = downstream();
  let cancelStarted!: () => void, releaseCancel!: () => void;
  const started = new Promise<void>(resolve => { cancelStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseCancel = resolve; });
  let resolved = false;
  const forwarding = forwardProjectModel({ ...f.options, fetch: async () => eventStream(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(bytes(textFrame + 'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'complete-but-draining', usage: providerUsage } }) + '\n\n')); },
    async cancel() { cancelStarted(); await release; },
  })) }, f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, 'drain-gate')
    .then(() => { resolved = true; });
  try {
    await started; await Promise.resolve();
    assert.match(content(), /response.completed/);
    assert.equal(f.run.usageStatus, 'reported');
    assert.equal(f.broker.export().modelCalls[0].state, 'pending');
    assert.equal(resolved, false);
    releaseCancel(); await forwarding;
    assert.equal(f.broker.export().modelCalls[0].state, 'settled');
    assert.equal(f.broker.export().modelCalls[0].failureCode, undefined);
  } finally { releaseCancel(); await forwarding; await f.close(); }
});

test('timing and diagnostic persistence faults still preserve usage, cancel the reader and finish the original receipt', async t => {
  for (const fault of ['timing', 'diagnostic', 'text'] as const) await t.test(fault, async t => {
    const f = await fixture(2);
    const { response } = downstream();
    let cancelled = false;
    let upstream: ReadableStream<Uint8Array> | undefined;
    const fail = () => { throw new Error('injected final metadata failure'); };
    if (fault === 'timing') t.mock.method(f.broker, 'modelTiming', fail);
    else if (fault === 'diagnostic') t.mock.method(f.options.store.models, 'clearDiagnostic', fail);
    else t.mock.method(f.broker, 'modelText', fail);
    try {
      await assert.rejects(forwardProjectModel({ ...f.options, fetch: async () => {
        upstream = new ReadableStream<Uint8Array>({
          start(stream) { stream.enqueue(bytes(textFrame + 'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'metadata-fault', usage: providerUsage } }) + '\n\n')); },
          cancel() { cancelled = true; },
        });
        return eventStream(upstream);
      } }, f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, fault),
      error => error instanceof AggregateError && error.errors.some(cause => cause instanceof Error && cause.message === 'injected final metadata failure'));
      assert.equal(cancelled, true); assert.equal(upstream?.locked, false);
      assert.equal(f.run.usageStatus, 'reported'); assert.equal(f.run.pendingModelCalls, 0);
      assert.equal(f.broker.export().modelCalls[0].state, 'settled');
      assert.equal(f.broker.export().modelCalls[0].failureCode, 'transport_interrupted');
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

test('an errored upstream reader can finish its receipt even when cancel rejects the prior stream error', async () => {
  const f = await fixture(2);
  const { response, content } = downstream();
  let reads = 0;
  try {
    await forwardProjectModel({ ...f.options, fetch: async () => eventStream(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (reads++ === 0) stream.enqueue(bytes(textFrame));
        else stream.error(new Error('fixture stream already errored'));
      },
    }, { highWaterMark: 0 })) }, f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, 'errored');
    assert.match(content(), /transport_interrupted/);
    assert.equal(f.broker.export().modelCalls[0].state, 'settled');
    assert.equal(f.run.usageStatus, 'unknown'); assert.equal(f.run.pendingModelCalls, 0);
  } finally { await f.close(); }
});

test('a cancellation rejection without a closed reader cannot publish a settled operation receipt', async t => {
  const f = await fixture(2);
  const { response } = downstream();
  let reads = 0, released = false;
  const upstream = new ReadableStream<Uint8Array>();
  const reader: ReadableStreamDefaultReader<Uint8Array> = {
    closed: new Promise<void>(() => {}),
    async read() {
      if (reads++ === 0) return { done: false, value: bytes(textFrame) };
      throw new Error('fixture read failed before closing');
    },
    async cancel() { throw new Error('fixture cancellation could not confirm shutdown'); },
    releaseLock() { released = true; },
  };
  t.mock.method(upstream, 'getReader', () => reader);
  try {
    await assert.rejects(forwardProjectModel({ ...f.options, fetch: async () => eventStream(upstream) },
      f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, 'uncertain-drain'), AggregateError);
    assert.equal(released, true);
    assert.equal(f.broker.export().modelCalls[0].state, 'pending');
    assert.equal(f.broker.export().modelCalls[0].settledAt, undefined);
    assert.equal(f.run.usageStatus, 'unknown'); assert.equal(f.run.pendingModelCalls, 0);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('the server pauses provider reads under backpressure and still accepts the same terminal after drain', async () => {
  const f = await fixture(2);
  const { response, content } = downstream();
  const write = response.write.bind(response);
  let blocked!: () => void;
  const waiting = new Promise<void>(resolve => { blocked = resolve; });
  let writes = 0, reads = 0;
  response.write = ((value: string) => { write(value); writes++; if (writes === 1) { blocked(); return false; } return true; }) as typeof response.write;
  const forwarding = forwardProjectModel({ ...f.options, fetch: async () => eventStream(new ReadableStream<Uint8Array>({
    pull(stream) {
      reads++;
      stream.enqueue(bytes(reads === 1 ? textFrame : 'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'drained', usage: providerUsage } }) + '\n\n'));
    },
  }, { highWaterMark: 0 })) }, f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, 'backpressure');
  try {
    await waiting; await Promise.resolve(); assert.equal(reads, 1);
    response.emit('drain'); await forwarding;
    assert.equal(reads, 2); assert.equal(writes, 2); assert.match(content(), /response.completed/);
    assert.equal(f.run.usageStatus, 'reported'); assert.equal(f.broker.export().modelCalls[0].failureCode, undefined);
  } finally { f.controller.abort(); await forwarding; await f.close(); }
});

test('a stalled model consumer has a bounded write wait and retains the actual partial response', async () => {
  const f = await fixture(2);
  const { response } = downstream();
  const write = response.write.bind(response);
  response.write = ((value: string) => { write(value); return false; }) as typeof response.write;
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await forwardProjectModel({ ...f.options, writeTimeoutMs: 20, fetch: async () => eventStream(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(bytes(textFrame)); },
      cancel() { cancelled = true; },
    })) }, f.broker.get('operation')!, {} as IncomingMessage, response, { model: f.input.model.model }, 'write-timeout');
    assert.equal(cancelled, true); assert.equal(response.destroyed, true);
    assert.equal(f.broker.export().modelCalls[0].failureCode, 'downstream_timeout');
    assert.equal(f.broker.receivedModelText('operation'), '已收到');
    assert.equal(f.run.pendingModelCalls, 0); assert.equal(f.run.usageStatus, 'unknown');
  } finally { clearTimeout(keepAlive); await f.close(); }
});

test('both real HTTP relay hops expose SSE headers before the first complete provider frame', async t => {
  for (const scenario of ['headers_only', 'partial_frame'] as const) await t.test(scenario, async () => {
    const f = await fixture(2);
    let cancelProvider!: () => void;
    const providerCancelled = new Promise<void>(resolve => { cancelProvider = resolve; });
    let startProvider!: () => void;
    const providerStarted = new Promise<void>(resolve => { startProvider = resolve; });
    const forwards = new Set<Promise<void>>();
    const server = createServer((request, response) => {
      const forwarding = (async () => {
        for await (const _ of request) { /* The authenticated fixture uses the fixed current input below. */ }
        await forwardProjectModel({ ...f.options, firstResponseTimeoutMs: 1000,
          fetch: async () => {
            startProvider();
            return eventStream(new ReadableStream<Uint8Array>({
              start(stream) {
                if (scenario === 'partial_frame') stream.enqueue(bytes('data: {"type":"response.output_text.delta","delta":"'));
              },
              cancel() { cancelProvider(); },
            }));
          } }, f.broker.get('operation')!, request, response, { model: f.input.model.model }, scenario);
      })().finally(() => forwards.delete(forwarding));
      forwards.add(forwarding); void forwarding.catch(() => response.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const bridge = new ProjectBridge({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
      credential: 'fixture', input: () => f.input, signal: f.controller.signal, async assertLocal() {},
      request: async (base, route, _credential, init) => fetch(base + route, init) });
    const local = await bridge.start();
    const consumer = new AbortController();
    let headerDeadline: ReturnType<typeof setTimeout> | undefined;
    const setupDeadline = setTimeout(() => consumer.abort(new Error('The loopback provider did not start')), 30000);
    try {
      const pending = fetch(local + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
        body: JSON.stringify({ model: f.input.model.model, input: [] }), signal: consumer.signal });
      await Promise.race([providerStarted, pending.then(() => undefined)]); clearTimeout(setupDeadline);
      headerDeadline = setTimeout(() => consumer.abort(new Error('SSE headers were buffered behind an unfinished frame')), 500);
      const response = await pending;
      clearTimeout(headerDeadline);
      assert.equal(response.status, 200); assert.equal(consumer.signal.aborted, false);
      if (scenario === 'headers_only') {
        assert.match(await response.text(), /first_response_timeout/);
      } else {
        const reading = response.text(); void reading.catch(() => {});
        consumer.abort(); await assert.rejects(reading);
      }
      await providerCancelled; await Promise.all(forwards);
      assert.equal(f.run.pendingModelCalls, 0); assert.equal(f.run.usageStatus, 'unknown');
      assert.equal(f.broker.export().modelCalls[0].failureCode, scenario === 'headers_only' ? 'first_response_timeout' : 'transport_interrupted');
    } finally {
      clearTimeout(setupDeadline); clearTimeout(headerDeadline); consumer.abort(); f.controller.abort(); await bridge.close();
      await Promise.allSettled(forwards); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await f.close();
    }
  });
});
