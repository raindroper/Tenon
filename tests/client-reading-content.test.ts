import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { Markdown } from '../client/components/Markdown.js';
import { transformReadingContent, type ReadingContent } from '../client/lib/reading-content.js';

const table = ['| 维度 | 项目 A | 项目 B |', '| --- | --- | --- |', '| 环境 | 本地 | 云端 |', '| 接入 | 现有工作流 | 验证原型 |'].join('\n');
const reading = { messageId: 'message-one', onOpen() {} };
const render = (content: string, enabled = true) => renderToStaticMarkup(createElement(Markdown, { children: content, ...(enabled ? { reading } : {}) }));

function collect(source: string, messageId = 'message-one'): ReadingContent[] {
  let entries: ReadingContent[] = [];
  renderToStaticMarkup(createElement(ReactMarkdown, {
    children: source,
    remarkPlugins: [remarkGfm, () => (tree: Root) => { entries = [...transformReadingContent(tree, source, messageId).values()]; }],
  }));
  return entries;
}

test('reading entries use real GFM blocks and keep an exact source slice including the immediately preceding heading', () => {
  const selected = `## 两个项目的**核心差异**\r\n\r\n${table.replaceAll('\n', '\r\n')}`;
  const source = `开头说明。\r\n\r\n${selected}\r\n\r\n最后一句仍然公开。`;
  const entries = collect(source);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, selected);
  assert.equal(entries[0].title, '两个项目的核心差异');
  assert.equal(entries[0].kind, 'table');
  assert.equal(entries[0].description, '2 行 · 3 列 · 维度、项目 A、项目 B');
  assert.equal(entries[0].id, `message-one:reading:${source.indexOf(selected)}:${source.indexOf(selected) + selected.length}`);
  const html = render(source);
  assert.match(html, /开头说明/);
  assert.match(html, /最后一句仍然公开/);
  assert.match(html, /class="reading-inline text-link"/);
  assert.match(html, /aria-label="展开阅读：两个项目的核心差异"/);
  assert.match(html, /<h2>/);
  assert.match(html, /<table/);
});

test('larger tables still fold into a single reading entry', () => {
  const html = render(table + '\n| 项目 | 甲 | 乙 |\n| 其他 | 丙 | 丁 |');
  assert.match(html, /class="reading-entry"/);
  assert.doesNotMatch(html, /<table/);
});

test('multiple table identities are stable and bound to the originating message without consuming intervening prose', () => {
  const source = `## 对比一\n\n${table}\n\n中间的总结必须保留。\n\n${table}\n\n## 结尾\n\n仍然可见。`;
  const first = collect(source); const second = collect(source); const other = collect(source, 'another-message');
  assert.equal(first.length, 2);
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id));
  assert.notEqual(first[0].id, first[1].id);
  assert.notEqual(first[0].id, other[0].id);
  assert.equal(first[1].title, '内容表格');
  assert.equal(first[1].content, table);
  const html = render(source);
  assert.match(html, /中间的总结必须保留/);
  assert.match(html, /<h2>结尾<\/h2>/);
  assert.match(html, /仍然可见/);
});

test('fenced code, blockquotes and list-contained tables remain in their original context', () => {
  const source = ['```markdown', table, '```', '', table.split('\n').map(line => `> ${line}`).join('\n'), '',
    '- 列表内的表格', '', ...table.split('\n').map(line => `  ${line}`)].join('\n');
  assert.deepEqual(collect(source), []);
  const html = render(source);
  assert.match(html, /<pre><code/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<li>/);
  assert.doesNotMatch(html, /class="reading-entry"/);
});

test('only genuinely long multi-paragraph sections become documents, without swallowing the next peer section', () => {
  const long = `## 详细说明\n\n${'第一段原始正文。'.repeat(90)}\n\n### 细节\n\n${'第二段保留信息。'.repeat(90)}`;
  const source = `简短结论。\n\n${long}\n\n## 接下来\n\n这部分必须留在对话。`;
  const [entry] = collect(source);
  assert.equal(entry.kind, 'document');
  assert.equal(entry.title, '详细说明');
  assert.equal(entry.content, long);
  const html = render(source);
  assert.match(html, /简短结论/);
  assert.match(html, /<h2>接下来<\/h2>/);
  assert.match(html, /这部分必须留在对话/);
  assert.doesNotMatch(html, /第一段原始正文/);
  assert.deepEqual(collect('## 短说明\n\n第一段。\n\n第二段。'), []);
  assert.deepEqual(collect(`## 单一长段\n\n${'只是一个段落。'.repeat(180)}`), []);
});

test('reference links keep their external definitions and are not broken by source slicing', () => {
  const source = `## 引用表\n\n| 来源 | 说明 |\n| --- | --- |\n| [文档][docs] | 保留引用 |\n\n[docs]: https://example.com/document`;
  assert.deepEqual(collect(source), []);
  const html = render(source);
  assert.match(html, /<h2>引用表<\/h2>/);
  assert.match(html, /href="https:\/\/example.com\/document"/);
  assert.match(html, /<table/);
});

test('folding a long section cannot remove a later reference definition used by earlier visible prose', () => {
  const long = `## 长说明\n\n${'第一段保留原始内容。'.repeat(80)}\n\n${'第二段也有足够正文。'.repeat(80)}`;
  const source = `先看[原始文档][later]。\n\n${long}\n\n[later]: https://example.com/original\n\n## 后续\n\n继续交流。`;
  assert.deepEqual(collect(source), []);
  const html = render(source);
  assert.match(html, /href="https:\/\/example.com\/original"/);
  assert.match(html, /<h2>长说明<\/h2>/);
  assert.match(html, /<h2>后续<\/h2>/);
  assert.match(html, /继续交流/);
});

test('a long nested section ends before the next parent-level heading', () => {
  const long = `### 展开细节\n\n${'第一段详细内容。'.repeat(90)}\n\n${'第二段详细内容。'.repeat(90)}`;
  const source = `${long}\n\n## 回到整体\n\n这段不属于细节文档。`;
  const entries = collect(source);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, long);
  const html = render(source);
  assert.match(html, /<h2>回到整体<\/h2>/);
  assert.match(html, /这段不属于细节文档/);
});

test('ordinary Markdown and reading-panel Markdown retain semantic tables and the original security policy', () => {
  const html = render(`## 对比\n\n${table}`, false);
  assert.match(html, /<h2>对比<\/h2>/);
  assert.match(html, /<table/);
  assert.doesNotMatch(html, /class="reading-entry"/);
  const unsafe = render(['<div data-reading-id="message-one:reading:0:12">伪造入口</div>',
    '<script>alert(1)</script>', '[危险链接](javascript:alert%281%29)', '[安全链接](https://example.com/doc)',
    '![远程图](https://example.com/image.png)'].join('\n\n'));
  assert.doesNotMatch(unsafe, /<(?:script|iframe|img)\b/i);
  assert.doesNotMatch(unsafe, /href="(?:javascript|vbscript|data):/i);
  assert.doesNotMatch(unsafe, /class="reading-entry"/);
  assert.match(unsafe, /href="https:\/\/example.com\/doc"/);
  assert.match(unsafe, /rel="noopener noreferrer"/);
  assert.match(unsafe, /图片：远程图（未自动加载）/);
});

test('an active reader marks only its exact entry without changing the remaining rendered content', () => {
  const content = `## 对比\n\n${table}`;
  const [entry] = collect(content);
  const active = renderToStaticMarkup(createElement(Markdown, { children: content, reading: { ...reading, activeId: entry.id } }));
  assert.match(active, /data-active="true"/);
  assert.match(active, /aria-expanded="true"/);
  assert.doesNotMatch(active, /aria-haspopup="dialog"/);
});
