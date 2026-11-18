import { projectFilesCapability, projectFinalFilesCapability } from '../shared/project-files.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';
import { fixtureDelivery } from './support/project-delivery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { caseEventPrefix } from '../server/v2/source-context.js';
import { createTencentDocsProvider } from '../server/connectors/tencent-docs.js';
import { createEwsProvider, type EwsDraftSnapshot, type EwsTransport } from '../server/connectors/ews.js';
import { localProjectCapability, type ProjectEvent, type ProjectExecutionInput } from '../shared/local-project.js';
import { MockLanguageModelV4 } from './support/model.js';
import { EWS_MAIL_OPERATION_PREFIX, type EwsMailOperation } from '../shared/mail.js';

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 6, text: 6, reasoning: 0 } };
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' } });
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });

for (const scenario of ['complete', 'cancel-send', 'cancel-receipt'] as const) test(scenario === 'cancel-send'
  ? 'revoking a whole task fences every operation and drains an accepted clarification send before acknowledging'
  : scenario === 'cancel-receipt' ? 'a waiting task owns and drains its accepted sent-receipt read before cancellation acknowledges'
    : 'document proposal -> scoped project -> approved mail -> cold wait -> early replies -> delayed sent receipt -> same project -> owner acceptance', { timeout: 30000 }, async t => {
  const cancelDuringSend = scenario === 'cancel-send';
  let document = '# P09\n已有需求。';
  const offlineFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url !== 'https://docs.qq.com/openapi/mcp') return offlineFetch(url, init);
    const req = JSON.parse(String(init.body));
    const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: req.id, result });
    if (req.method === 'initialize') return respond({ protocolVersion: '2025-06-18' });
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (req.method === 'tools/list') return respond({ tools: [{ name: 'manage.query_file_info' }, { name: 'get_content' }] });
    assert.equal(req.params.arguments.file_id, 'p10-plan');
    return respond({ structuredContent: req.params.name === 'manage.query_file_info'
      ? { file_id: 'p10-plan', title: '订单需求', type: 'sheet' } : { content: document } });
  });
  const sentIds = new Map<string, string>();
  const replyBodies: Array<{ id: string; sender: string; body: string; inReplyTo?: string }> = [];
  let sends = 0, draft: EwsDraftSnapshot | undefined;
  let releaseSubmission!: () => void, submissionEntered!: () => void;
  const submissionGate = new Promise<void>(done => { releaseSubmission = done; });
  const entered = new Promise<void>(done => { submissionEntered = done; });
  let holdReceipt = false, releaseReceipt!: () => void, receiptEntered!: () => void;
  const receiptGate = new Promise<void>(done => { releaseReceipt = done; });
  const readingReceipt = new Promise<void>(done => { receiptEntered = done; });
  const transport: EwsTransport = async request => {
    if (request.operation === 'baseline') return { id: 'test-inbox', displayName: '测试收件箱', totalCount: 0, unreadCount: 0 };
    if (request.operation === 'scan') return {
      cursor: { ...request.cursor!, syncState: String(replyBodies.length), catchup: false }, more: false,
      changes: replyBodies.slice(Number(request.cursor!.syncState ?? 0)).map(reply => ({
        ...reply, revision: '1', subject: 'Re: P10 规则确认', receivedAt: request.cursor!.since, senderAddress: reply.sender,
        internetMessageId: '<' + reply.id + '@example.test>', encryption: 'none', bodyStatus: 'read', truncated: false, totalCharacters: reply.body.length,
      })),
    };
    if (request.operation === 'prepare-message') {
      const { operationId, to, cc, bcc, subject, body } = request.prepare!;
      draft = { operationId, draftId: 'test-draft', revision: '1', to, cc, bcc, subject, body, attachments: [],
        snapshotHash: createHash('sha256').update(body).digest('hex') }; return draft;
    }
    if (request.operation === 'inspect-draft') return draft;
    if (request.operation === 'submit-draft') { sends++; submissionEntered(); if (cancelDuringSend) await submissionGate;
      const { operationId, draftId, revision } = request.submit!;
      const internetMessageId = `<${operationId}@example.test>`;
      for (const recipient of draft!.to) sentIds.set(recipient.address, internetMessageId);
      return { operationId, draftId, revision, state: 'submitted',
        ...(cancelDuringSend || !draft!.to.some(recipient => recipient.address === 'backend@example.test') ? { internetMessageId } : {}) }; }
    if (request.operation === 'submission-receipt') {
      if (!holdReceipt) return { operationId: request.submission!.operationId, state: 'pending' };
      receiptEntered(); await receiptGate;
      return { operationId: request.submission!.operationId, state: 'found', internetMessageId: sentIds.get('backend@example.test'), sentMessageId: 'verified-sent-copy' };
    }
    throw new Error('Unexpected EWS fixture operation: ' + request.operation);
  };
  let failure: unknown, models = 0;
  let runtime: V2Coordinator;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    models++;
    try {
      const current = [...options.prompt].reverse().find(message => message.role === 'user'
        && message.content.some(part => part.type === 'text' && part.text.startsWith(caseEventPrefix)));
      const part = current?.role === 'user' && current.content.find(part => part.type === 'text' && part.text.startsWith(caseEventPrefix));
      assert.ok(part && part.type === 'text'); const input = JSON.parse(part.text.slice(caseEventPrefix.length));
      if (input.event.kind === 'growth.observation') {
        const evidence = input.evidencePreviews.find((item: any) => item.content.includes('P10-042'));
        assert.ok(evidence.previousEvidenceId);
        assert.match(String(runtime.inbox.get(evidence.previousEvidenceId)?.payload.content), /P09/);
        return call('finish_review', { outcome: 'propose', evidenceIds: [evidence.evidenceId], anchorEventId: evidence.evidenceId,
          ownerRelation: { kind: 'work_dependency', contextKeys: ['owner.orders'], rationale: '本人负责订单页面。' },
          whyOwnerNeedsToKnow: '新增的订单功能需要梳理和实现。', materialChange: { kind: 'new', fields: { requirement: 'P10-042' } },
          situation: { title: '订单 P10', summary: '新增订单需求，可以先梳理并澄清实现。', status: 'ready', unknowns: ['取消与排序口径'], missingInputs: [] },
          proposal: { title: '实现订单 P10', objective: '梳理、澄清并实现 P10-042，完成回归后交付本人验证。', expectedOutput: '代码和实际检查结果',
            execution: 'project', acceptance: { mode: 'owner', criteria: ['取消规则与排序规则均核对通过'] } } });
      }
      if (input.task?.review) {
        const names = options.tools?.map(tool => tool.name) ?? [];
        assert.ok(names.includes('read_event') && names.includes('read_connected_document') && names.includes('resolve_task_input'));
        assert.ok(!names.some(name => ['prepare_task_mail', 'request_task', 'decide_task', 'write_workspace', 'publish_artifact'].includes(name)));
        const evidence = input.taskFlow.inputReview.evidence;
        const linkedDocument = evidence.find((item: any) => String(item.content).includes('SEE_DOC'));
        if (linkedDocument) {
          if (options.prompt.at(-1)?.role !== 'tool') return call('read_connected_document', { document: 'p10-plan' });
          const receipt = runtime.inbox.list().filter(event => event.kind === 'connector.document_read').at(-1)!;
          assert.ok(receipt, JSON.stringify(options.prompt.at(-1))); assert.match(JSON.stringify(options.prompt), /RULE_SORT: newest first/);
          assert.ok(JSON.stringify(options.prompt).includes(receipt.id));
          return call('resolve_task_input', { answers: [{ questionKey: 'sort', content: '最新订单优先', evidenceEventIds: [linkedDocument.id, receipt.id] }] });
        }
        const answers = evidence.flatMap((item: any) => String(item.content).includes('RULE_') ? [{
          questionKey: String(item.content).includes('RULE_CANCEL') ? 'cancel' : 'sort', content: String(item.content), evidenceEventIds: [item.id],
        }] : []);
        return call('resolve_task_input', { answers });
      }
      return answer('fixture');
    } catch (error) { failure = error; throw error; }
  } });
  const directory = await mkdtemp(join(tmpdir(), 'rae-p10-flow-'));
  let store = new Store(directory); store.getApiKey = () => undefined;
  const create = () => V2Coordinator.create(store, { dataDir: directory, model, ewsTransport: transport,
    connectorProviders: { 'tencent-docs': createTencentDocsProvider({}), ews: createEwsProvider(transport) } });
  runtime = await create();
  async function until(check: () => boolean, message: string) {
    const end = Date.now() + 8000;
    while (!check()) {
      if (failure) throw failure;
      assert.ok(Date.now() < end, message + ': ' + JSON.stringify({ runs: store.list('runs').map(run => ({ state: run.status, error: run.error })), tasks: runtime.consent.tasks() }));
      await delay(10);
    }
  }
  let detach: (() => void) | undefined, dispatches = 0, mailbox = '', firstOperation = '', firstThread = '';
  const attach = (deviceId: string) => {
    detach = runtime.devices.attach(deviceId, message => {
      if (message.kind !== 'project-execute') return;
      dispatches++;
      void (async () => {
        const input: ProjectExecutionInput = message.input;
        let sequence = runtime.devices.projects.get(input.operationId)!.sequence;
        const record = (event: ProjectEvent['event']) => runtime.devices.projects.record(deviceId, { operationId: input.operationId,
          requirementsRevision: input.requirementsRevision, sequence: ++sequence, at: new Date().toISOString(), event });
        firstOperation ||= input.operationId; firstThread ||= 'same-native-thread';
        assert.equal(input.operationId, firstOperation);
        record({ kind: 'started', threadId: firstThread, engineVersion: 'offline-fixture', realPath: input.spec.root, identity: 'fixture-directory' });
        const authorized = runtime.devices.projects.authorize(deviceId, { operationId: input.operationId, requirementsRevision: input.requirementsRevision, specHash: input.specHash });
        if (dispatches === 1) {
          const result = await authorized.context.context(authorized.operation, { action: 'call', name: 'prepare_task_mail', arguments: {
            wait: { key: 'p10-rules', summary: '确认取消与排序规则', questions: [
              { key: 'cancel', question: '哪些订单可以取消？', blocks: '取消功能' }, { key: 'sort', question: '默认如何排序？', blocks: '订单列表' },
            ] },
            messages: [
              { questionKeys: ['cancel'], mail: { connectionId: mailbox, credentialRevision: 1, mode: 'send', to: ['backend@example.test'],
                subject: 'P10 取消规则确认', body: '请确认订单取消规则。', protection: 'plaintext' } },
              { questionKeys: ['sort'], mail: { connectionId: mailbox, credentialRevision: 1, mode: 'send', to: ['pm@example.test'],
                subject: 'P10 排序规则确认', body: '请确认默认排序规则。', protection: 'plaintext' } },
            ],
          } }) as { taskSuspended: boolean };
          assert.equal(result.taskSuspended, true);
          record({ kind: 'environment', state: 'closed', terminals: [] });
          record({ kind: 'paused', reason: 'durable-input-wait' });
        } else {
          const context = await authorized.context.context(authorized.operation, { action: 'catalog' }) as { taskFlow: { resolvedInputs: any[] } };
          assert.equal(context.taskFlow.resolvedInputs[0].answers.length, 2);
          record({ kind: 'tool', item: { id: 'fixture-check', type: 'commandExecution', label: 'fixture regression', state: 'succeeded', exitCode: 0 } });
          fixtureDelivery(input.requirementsRevision, 'delivery-check', input.contract).forEach(record);
          record({ kind: 'environment', state: 'closed', terminals: [] });
          record({ kind: 'finished', state: 'completed', output: '合成执行器报告：两项规则均已核对，等待本人验收。' });
        }
      })().catch(error => { failure = error; });
    });
  };
  try {
    const scene = await runtime.createCase({ title: '订单测试', objective: '关注订单需求', domain: 'fixture' });
    await runtime.correctPersonalMemory('owner.orders', { value: '本人负责订单页面。', scope: 'case', caseIds: [scene.id] });
    const credential = await runtime.connectorSettings.saveTencentDocsCredential('OFFLINE_P10_TOKEN');
    const watch = await runtime.connectorSettings.connectTencentDocument({ caseId: scene.id, scope: 'p10-plan', credentialId: credential.id });
    mailbox = (await runtime.connectorSettings.connectEws({ caseId: scene.id, scope: 'inbox', endpoint: 'https://mail.example.test/EWS/Exchange.asmx',
      username: 'owner@example.test', password: 'OFFLINE_PASSWORD', observeNewMailAndAnalyze: true, persistCredentials: true })).id;
    const device = runtime.devices.enroll({ name: 'Fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
    runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] }); attach(device.id);
    document += '\n# P10\nP10-042：取消订单，并支持默认排序。';
    await runtime.connectorSettings.sync(watch.id); await runtime.connectorSettings.sync(watch.id);
    assert.equal(runtime.inbox.list().filter(event => event.kind === 'connector.change').length, 1);
    assert.equal(models, 0);
    await store.updateSettings({ enabled: true, maxStepsPerRun: 6 }); runtime.start(); await runtime.request('manual');
    await until(() => runtime.consent.tasks().length === 1, 'project proposal');
    const proposal = runtime.consent.tasks()[0];
    assert.ok(proposal.spec.projectSelection); assert.equal(dispatches, 0);
    await assert.rejects(runtime.approveTask(proposal.id, proposal.revision), /选择|范围/);
    await runtime.approveTask(proposal.id, proposal.revision, undefined, undefined, { deviceId: device.id, root: 'D:\\fixture\\p10-project',
      access: 'read-write', readAccess: 'project', network: false, create: true });
    await until(() => Boolean(runtime.consent.task(proposal.id)?.flow?.dependencies.length), 'persisted wait');
    await until(() => runtime.devices.projects.forTask(proposal.id)?.state === 'waiting', 'native pause');
    const mail = runtime.consent.operations(proposal.id).find(operation => operation.spec.mail)!;
    const productMail = runtime.consent.operations(proposal.id).find(operation => operation.spec.mail?.to.includes('pm@example.test'))!;
    assert.ok(productMail); assert.notEqual(mail.id, productMail.id);
    assert.equal(mail.state, 'proposed'); assert.equal(sends, 0);
    await runtime.approveTask(mail.id, mail.revision);
    if (cancelDuringSend) {
      await entered;
      let stopped = false;
      const cancel = runtime.revokeTask(proposal.id, runtime.consent.get(proposal.id)!.revision).then(() => { stopped = true; });
      await delay(20); assert.equal(stopped, false, 'Cancellation must wait for the accepted native write');
      releaseSubmission(); await cancel;
      assert.equal(sends, 1); assert.equal(runtime.consent.get(proposal.id)?.state, 'revoked');
      assert.equal(runtime.consent.get(mail.id)?.state, 'revoked');
      assert.equal(runtime.consent.get(mail.id)?.mailReceipt?.state, 'submitted');
      assert.equal(runtime.consent.get(productMail.id)?.state, 'rejected');
      assert.equal(runtime.consent.dependencies(proposal.id)[0].state, 'cancelled');
      return;
    }
    await until(() => runtime.consent.get(mail.id)?.state === 'completed', 'mail receipt');
    assert.equal(sends, 1); assert.equal(runtime.consent.get(productMail.id)?.state, 'proposed');
    await runtime.approveTask(productMail.id, productMail.revision);
    await until(() => runtime.consent.get(productMail.id)?.state === 'completed', 'product mail receipt');
    assert.equal(sends, 2); assert.equal((await runtime.listTasks()).length, 1);
    // Match the owner settings route: pause/drain, persist disabled state,
    // restart, then cancel any recovered work before explicitly re-enabling.
    await runtime.cancel(); await store.updateSettings({ enabled: false });
    detach?.(); await runtime.close(); store.close();
    store = new Store(directory); store.getApiKey = () => undefined;
    const receipt = store.getMeta<EwsMailOperation | null>(EWS_MAIL_OPERATION_PREFIX + mail.id, null)!;
    assert.equal(receipt.state, 'submitted'); assert.equal(receipt.internetMessageId, undefined);
    store.setMeta(EWS_MAIL_OPERATION_PREFIX + mail.id, { ...receipt, receiptLookup: { ...receipt.receiptLookup!, nextAt: '2100-01-01T00:00:00.000Z' } });
    runtime = await create(); attach(device.id);
    await runtime.cancel(); await store.updateSettings({ enabled: true }); runtime.start();
    assert.equal(runtime.consent.task(proposal.id)?.flow?.phase, 'waiting_input');
    replyBodies.push({ id: 'noise', sender: 'other@example.test', body: 'RULE_SORT bad', inReplyTo: sentIds.get('backend@example.test') },
      { id: 'subject-only', sender: 'pm@example.test', body: 'RULE_SORT wrong thread' },
      { id: 'wrong-reply-chain', sender: 'pm@example.test', body: 'RULE_SORT unrelated chain', inReplyTo: sentIds.get('backend@example.test') },
      { id: 'backend', sender: 'backend@example.test', body: 'RULE_CANCEL: only unpaid orders.', inReplyTo: sentIds.get('backend@example.test') });
    await runtime.connectorSettings.sync(mailbox);
    const dependency = runtime.consent.dependencies(proposal.id)[0];
    await until(() => runtime.consent.replyEvents(dependency.id, productMail.id).events.length === 0, 'other mail binding processes its own inbox position');
    assert.equal(runtime.consent.dependencies(proposal.id)[0].answers.length, 0, 'An early reply must wait for the exact sent receipt');
    holdReceipt = true;
    const waitingReceipt = store.getMeta<EwsMailOperation | null>(EWS_MAIL_OPERATION_PREFIX + mail.id, null)!;
    store.setMeta(EWS_MAIL_OPERATION_PREFIX + mail.id, { ...waitingReceipt, receiptLookup: { ...waitingReceipt.receiptLookup!, nextAt: '1970-01-01T00:00:00.000Z' } });
    await readingReceipt;
    assert.equal(store.latestTaskExecutionRun(proposal.id)?.status, 'running', 'Re-enabled waiting work has one live owner without a new native turn');
    assert.equal(dispatches, 1);
    if (scenario === 'cancel-receipt') {
      let stopped = false;
      const cancel = runtime.revokeTask(proposal.id, runtime.consent.get(proposal.id)!.revision).then(() => { stopped = true; });
      await delay(20); assert.equal(stopped, false, 'Cancellation must drain the accepted receipt read');
      releaseReceipt(); await cancel;
      assert.equal(runtime.consent.get(proposal.id)?.state, 'revoked');
      assert.equal(runtime.consent.get(mail.id)?.state, 'completed');
      assert.equal(store.getMeta<EwsMailOperation>(EWS_MAIL_OPERATION_PREFIX + mail.id, null!).state, 'submitted');
      assert.equal(runtime.consent.dependencies(proposal.id)[0].candidateEventIds.length, 0);
      assert.equal(sends, 2); return;
    }
    releaseReceipt();
    await until(() => runtime.consent.dependencies(proposal.id)[0].answers.length === 1, 'partial answer');
    assert.equal(dispatches, 1); assert.equal(sends, 2);
    await runtime.connectorSettings.sync(mailbox);
    const callsAfterPartial = models;
    await delay(100); assert.equal(models, callsAfterPartial, 'No idle model polling');
    document += '\nRULE_SORT: newest first.';
    replyBodies.push({ id: 'product', sender: 'pm@example.test', body: 'SEE_DOC: 默认排序已补充到已授权的订单需求表，请核对。', inReplyTo: sentIds.get('pm@example.test') });
    await runtime.connectorSettings.sync(mailbox);
    await until(() => runtime.consent.task(proposal.id)?.flow?.phase === 'awaiting_acceptance', 'continued project delivery');
    assert.equal(dispatches, 2); assert.equal(sends, 2);
    const root = runtime.consent.task(proposal.id)!;
    assert.equal(root.id, proposal.id); assert.equal(root.flow!.dependencies[0].candidateEventIds.length, 2);
    assert.equal(root.flow!.dependencies[0].answers.length, 2); assert.equal(root.state, 'running');
    assert.equal(root.flow!.dependencies[0].researchEventIds?.length, 1);
    assert.deepEqual(root.flow!.dependencies[0].replyBindings?.map(binding => binding.questionKeys), [['cancel'], ['sort']]);
    assert.equal((await runtime.acceptTaskDelivery(root.id, root.revision)).state, 'completed');
  } finally { releaseSubmission(); detach?.(); await runtime.close(); store.close(); }
});
