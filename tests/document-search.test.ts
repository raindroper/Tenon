import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchDocument } from '../server/v2/document-search.js';

test('document column search reads only verified table rows across tables with different widths', () => {
  const content = [
    '## A 组',
    String.raw`| 业务 | 研\|发 |||`,
    '| --- | :---: | --- | --- |',
    String.raw`| 小雨 | 接口\|平台 |||`,
    String.raw`| 财务 | 小雨\|接口 |||`,
    '| 小雨 | 小雨 | 错误列数 |',
    '',
    '## B 组',
    String.raw`| 研\|发 | 业务 | 状态 |`,
    '| --- | --- | --- |',
    '| 小雨 | 销售 | 开启 |',
    String.raw`| 业务 | 研\|发 | 状态 |`,
    '| --- | --- |',
    '| 小雨 | 偏移错配 | 开启 |',
    '',
    String.raw`| 研\|发 | 研\|发 |`,
    '| --- | --- |',
    '| 小雨 | 小雨 |',
    '',
    '```',
    String.raw`| 研\|发 | 业务 |`,
    '| --- | --- |',
    '| 小雨 | 文档示例 |',
    '```',
    '无关文字 小雨',
  ].join('\r\n');

  const first = searchDocument(content, '小雨', 0, 1, '研|发');
  assert.equal(first.totalMatches, 2);
  assert.deepEqual(first.coverage, { mode: 'column', column: '研|发', matchedTables: 2, ambiguousTables: 1, skippedMalformedRows: 1 });
  assert.deepEqual(first.matches.map(match => match.line), [5]);
  assert.equal(first.matches[0].tableHeaderLine, 2);
  assert.equal(first.matches[0].cell, '小雨|接口');
  assert.equal(content.slice(first.matches[0].matchOffset, first.matches[0].matchOffset + 2), '小雨');
  assert.deepEqual(first.tables.map(table => [table.heading, table.columnIndex]), [['A 组', 2]]);

  const second = searchDocument(content, '小雨', first.nextOffset!, 1, '研|发');
  assert.equal(second.totalMatches, 2);
  assert.deepEqual(second.matches.map(match => match.line), [11]);
  assert.equal(second.matches[0].cell, '小雨');
  assert.deepEqual(second.tables.map(table => [table.heading, table.columnIndex]), [['B 组', 1]]);
  assert.equal(second.nextOffset, null);

  const escapedMatch = searchDocument(content, '小雨|接口', 0, 30, '研|发');
  assert.equal(escapedMatch.totalMatches, 1);
  assert.equal(escapedMatch.matches[0].line, 5);
  const missingColumn = searchDocument(content, '小雨', 0, 30, '不存在');
  assert.deepEqual(missingColumn.matches, []);
  assert.equal(missingColumn.coverage.matchedTables, 0);

  const longCell = searchDocument(`| 研发 | 业务 |\n| --- | --- |\n| ${'x'.repeat(400)}小雨 | 无关 |`, '小雨', 0, 1, '研发').matches[0];
  assert.equal(longCell.cellTruncated, true);
  assert.ok(longCell.cell!.length <= 200);
  assert.match(longCell.cell!, /小雨/);
});

test('literal document search bounds encoded output and returns offsets for actual remaining hits', () => {
  const firstLine = 'x'.repeat(7000) + '负责人小雨';
  const rows = Array.from({ length: 31 }, () => '"'.repeat(320) + '小雨' + '"'.repeat(330));
  const content = [firstLine, ...rows, '未命中的末尾'].join('\n');
  const first = searchDocument(content, '小雨', 0, 100);
  assert.equal(first.totalMatches, 32);
  assert.ok(JSON.stringify(first).length <= 9000);
  assert.equal(first.matches[0].matchOffset, firstLine.indexOf('小雨'));
  assert.equal(first.matches[0].truncated, true);
  assert.match(first.matches[0].text, /小雨/);
  assert.equal(first.matches.at(-1)!.line + 1, content.slice(0, first.nextOffset!).split('\n').length);

  const lastHit = content.lastIndexOf('\n', content.lastIndexOf('小雨')) + 1;
  const last = searchDocument(content, '小雨', lastHit, 1);
  assert.equal(last.totalMatches, 32);
  assert.deepEqual(last.matches.map(match => match.line), [32]);
  assert.equal(last.nextOffset, null);

  const shortRows = searchDocument('小雨\n'.repeat(35), '小雨', 0, 100);
  assert.equal(shortRows.totalMatches, 35);
  assert.equal(shortRows.matches.length, 30);
  assert.equal(shortRows.nextOffset, '小雨\n'.length * 30);
});
