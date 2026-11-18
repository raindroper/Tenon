import assert from 'node:assert/strict';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { extractChatFileText } from '../server/v2/chat-file-extraction.js';

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function workbook(firstSheet: string, options: { workbookTarget?: string; extraEntries?: Record<string, string> } = {}): Buffer {
  const archive = new AdmZip();
  const entries = {
    '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="root" Type="${office}/officeDocument" Target="${options.workbookTarget ?? 'book/content.xml'}"/></Relationships>`,
    'book/content.xml': `<workbook xmlns="${main}" xmlns:link="${office}"><sheets><sheet name="汇总 &amp; 明细" sheetId="1" link:id="sheet1"/><sheet name="其他" sheetId="2" link:id="sheet2"/></sheets></workbook>`,
    'book/_rels/content.xml.rels': `<Relationships xmlns="${relationships}">
      <Relationship Id="sheet1" Type="${office}/worksheet" Target="tabs/a.xml"/>
      <Relationship Id="sheet2" Type="${office}/worksheet" Target="/book/tabs/b.xml"/>
      <Relationship Id="string" Type="${office}/sharedStrings" Target="words.xml"/>
      <Relationship Id="external" Type="${office}/externalLink" TargetMode="External" Target="https://unrelated.example/workbook"/>
      </Relationships>`,
    'book/words.xml': `<sst xmlns="${main}"><si><r><t>产品</t></r><r><t>名称</t></r><rPh><t>ignored pronunciation</t></rPh></si></sst>`,
    'book/tabs/a.xml': firstSheet,
    'book/tabs/b.xml': `<worksheet xmlns="${main}"><sheetData><row r="42"><c t="inlineStr"><is><t>第二张表</t></is></c></row></sheetData></worksheet>`,
    ...options.extraEntries,
  };
  for (const [name, xml] of Object.entries(entries)) archive.addFile(name, Buffer.from(xml));
  return archive.toBuffer();
}

const worksheet = (rows: string) => `<worksheet xmlns="${main}"><sheetData>${rows}</sheetData></worksheet>`;
const xlsx = (bytes: Buffer) => extractChatFileText({ name: '订单.XLSX', bytes });

test('extracts supported UTF-8 files and bounds excerpts without splitting surrogate pairs', async () => {
  const extract = (name: string, bytes: Buffer) => extractChatFileText({ name, bytes });
  assert.deepEqual(await extract('orders.CSV', Buffer.from('\uFEFF订单,金额\r\n1,15')), {
    status: 'readable', text: '订单,金额\r\n1,15', truncated: false,
  });
  assert.deepEqual(await extract('binary.txt', Buffer.from([0, 65])), { status: 'unreadable' });
  assert.deepEqual(await extract('invalid.txt', Buffer.from([0xff])), { status: 'unreadable' });
  assert.deepEqual(await extract('report.pdf', Buffer.from('plain text')), { status: 'unsupported' });
  assert.deepEqual(await extract('long.md', Buffer.from(`${'前'.repeat(15_999)}😀后`)), {
    status: 'readable', text: '前'.repeat(15_999), truncated: true,
  });
});

test('extracts named worksheets in order with cell addresses, rich strings, and formulas as cached data', async () => {
  const bytes = workbook(worksheet(`<row r="1"><c r="A1" t="s"><v>0</v></c>
    <c r="C1" t="inlineStr"><is><t>数量_x000A_单位</t></is></c>
    <c r="D1" t="b"><v>1</v></c>
    <c r="E1"><f>A1+10</f><v>24</v></c>
    <c r="F1"><f>UNAVAILABLE()</f></c><c r="G1" t="str"><f>EMPTY()</f><v/></c></row>
    <row r="5"><c r="A5" t="e"><v>#VALUE!</v></c><c><v>532.15</v></c></row>`));
  assert.deepEqual(await xlsx(bytes), {
    status: 'readable', truncated: false,
    text: '工作表 "汇总 & 明细"\nA1="产品名称"\tC1="数量\\n单位"\tD1=TRUE\tE1=24 [公式缓存值，公式 "=A1+10"]\tF1= [无公式缓存值，公式 "=UNAVAILABLE()"]\tG1="" [公式缓存值，公式 "=EMPTY()"]\nA5="#VALUE!"\tB5=532.15\n\n工作表 "其他"\nA42="第二张表"',
  });
});

test('marks bounded workbook excerpts while preserving complete reported cells', async () => {
  const rows = Array.from({ length: 500 }, (_, index) => `<row><c r="A${index + 1}" t="inlineStr"><is><t>${'内容'.repeat(750)}</t></is></c></row>`).join('');
  const result = await xlsx(workbook(worksheet(rows)));
  assert.equal(result.status, 'readable');
  if (result.status !== 'readable') return;
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 16_000);
  assert.match(result.text, /A1="内容.*…"/u);
  assert.match(result.text, /…"$/u);
  assert.doesNotMatch(result.text, /A500|第二张表/u);
});

test('rejects doctypes, escaped ZIP targets and malformed archive inputs', async () => {
  const cases = [
    Buffer.from('not an archive'),
    workbook(worksheet(''), { workbookTarget: 'https://unrelated.example/content.xml' }),
    workbook(worksheet(''), { workbookTarget: '../book/content.xml' }),
    workbook(`<!DOCTYPE worksheet [<!ENTITY secret SYSTEM "file:///private.txt">]>${worksheet('<row><c t="inlineStr"><is><t>&secret;</t></is></c></row>')}`),
    workbook(worksheet(''), { extraEntries: { ['a/'.repeat(32) + 'payload']: '' } }),
    workbook(worksheet(''), { extraEntries: { ['a'.repeat(600)]: '' } }),
  ];
  for (const bytes of cases) assert.deepEqual(await xlsx(bytes), { status: 'unreadable' });
});

test('skips a large part and refuses forged small ZIP sizes without affecting stored originals', async () => {
  const sheet = worksheet(`<row><c t="inlineStr"><is><t>${'a'.repeat(4 * 1024 * 1024)}</t></is></c></row>`);
  const bytes = workbook(sheet);
  const result = await xlsx(bytes);
  assert.deepEqual(result, { status: 'readable', truncated: true, text: '工作表 "其他"\nA42="第二张表"' });

  // Lower the declared size without changing the compressed data; the inflate itself must stop.
  const forged = Buffer.from(bytes);
  const end = forged.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  let offset = forged.readUInt32LE(end + 16);
  while (offset < end) {
    const nameLength = forged.readUInt16LE(offset + 28);
    const name = forged.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === 'book/tabs/a.xml') {
      const local = forged.readUInt32LE(offset + 42);
      forged.writeUInt32LE(0, local + 22);
      forged.writeUInt32LE(0, offset + 24);
      break;
    }
    offset += 46 + nameLength + forged.readUInt16LE(offset + 30) + forged.readUInt16LE(offset + 32);
  }
  assert.ok(offset < end, 'fixture ZIP header was updated');
  assert.deepEqual(await xlsx(forged), { status: 'unreadable' });
  assert.deepEqual(await xlsx(bytes), result);
});
