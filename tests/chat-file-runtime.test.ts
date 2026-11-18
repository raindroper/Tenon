import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import AdmZip from 'adm-zip';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { chatFileContextPrefix, type ChatFileContext } from '../server/v2/chat-file-context.js';
import { caseEventPrefix } from '../server/v2/source-context.js';
import { MockLanguageModelV4 } from './support/model.js';

const privateCell = '样品-甲 / 架位-18';
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function workbook() {
  const zip = new AdmZip();
  const add = (path: string, text: string) => zip.addFile(path, Buffer.from(text));
  add('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="book" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', `<workbook xmlns="${spreadsheet}" xmlns:r="${relationships}">
    <sheets><sheet name="库存" sheetId="1" r:id="inventory"/></sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="inventory" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  add('xl/worksheets/sheet1.xml', `<worksheet xmlns="${spreadsheet}"><sheetData><row r="2">
    <c r="A2" t="inlineStr"><is><t>${privateCell}</t></is></c><c r="B2"><v>37</v></c></row></sheetData></worksheet>`);
  return zip.toBuffer().toString('base64');
}

test('workbook contents reach only the actor handling the original attachment or its same-scene quote', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-chat-file-runtime-'));
  const store = new Store(directory);
  const seen = new Map<string, { files: ChatFileContext[]; tools: number }>();
  const model = new MockLanguageModelV4({ doGenerate: async ({ prompt, tools }) => {
    const parts = prompt.flatMap(message => message.role === 'user'
      ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []);
    const eventPart = parts.filter(text => text.startsWith(caseEventPrefix)).at(-1);
    const fileParts = parts.filter(text => text.startsWith(chatFileContextPrefix));
    if (eventPart) {
      const { event } = JSON.parse(eventPart.slice(caseEventPrefix.length)) as { event: { id: string } };
      assert.ok(fileParts.length <= 1);
      seen.set(event.id, { files: fileParts.flatMap(text => JSON.parse(text.slice(chatFileContextPrefix.length))), tools: tools?.length ?? 0 });
    } else {
      assert.equal(fileParts.length, 0);
    }
    return { content: [{ type: 'text', text: '已处理。' }], finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 3, text: 3, reasoning: 0 } }, warnings: [] };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const scene = await runtime.createCase({ title: '库存', objective: '', domain: 'work' });
    const unrelated = await runtime.createCase({ title: '别的场景', objective: '', domain: 'work' });
    const file = { name: '在库.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: workbook() };
    const upload = await runtime.ingestOwnerMessage('', scene.id, undefined, undefined, undefined, undefined, undefined, [file]);
    assert.equal(seen.size, 0);
    await store.updateSettings({ enabled: true });
    runtime.start();
    const wait = async (id: string) => {
      const deadline = Date.now() + 12_000;
      for (;;) {
        const event = runtime.inbox.get(id);
        if (event?.status === 'processed') return seen.get(id);
        assert.notEqual(event?.status, 'failed', event?.lastError ?? 'owner event failed');
        assert.ok(Date.now() < deadline, 'owner event did not finish');
        await delay(25);
      }
    };
    const original = await wait(upload.id);
    assert.equal(original?.tools, 0);
    assert.equal(original?.files[0]?.status, 'readable');
    assert.match(JSON.stringify(original?.files), /库存.*A2.*样品-甲.*B2.*37/u);
    const followup = await runtime.ingestOwnerMessage('读取刚才引用的文件。', scene.id, upload.externalId);
    assert.deepEqual((await wait(followup.id))?.files, original.files);
    const sameScene = await runtime.ingestOwnerMessage('新的问题。', scene.id);
    assert.deepEqual((await wait(sameScene.id))?.files, []);
    const elsewhere = await runtime.ingestOwnerMessage('另一个场景。', unrelated.id);
    assert.deepEqual((await wait(elsewhere.id))?.files, []);
    assert.ok(!JSON.stringify((await runtime.getCaseDetails(scene.id)).history).includes(privateCell));
  } finally {
    await runtime.close();
    store.close();
  }
});
