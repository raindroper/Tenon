import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../client/components/Markdown.js';

const parameterTable = [
  '| 项 | 选择 | 理由 |',
  '|---|---|---|',
  '| 模型 | Kling-Video-V3 | 支持文生视频，也能首尾帧控制 |',
  '| 画幅 | 9:16 竖屏 | 适合在手机上观看和分享 |',
  '| 时长 | 5 秒 | 短视频，先看画面效果 |',
  '| 分辨率 | 1080P | 再高对 5 秒短片来说提升有限 |',
  '| 声音 | 开 | 笑声才是重点 |',
].join('\n');

function render(content: string): string {
  return renderToStaticMarkup(createElement(Markdown, { children: content }));
}

test('Chinese GFM parameter tables render as semantic table headers and cells', () => {
  const html = render(`我选的参数：\n\n${parameterTable}\n\n画面内容：重点是**写实风格**。`);
  assert.match(html, /<table(?:\s[^>]*)?>/);
  assert.match(html, /<thead>/);
  assert.match(html, /<tbody>/);
  assert.equal((html.match(/<th(?:\s[^>]*)?>/g) ?? []).length, 3);
  assert.equal((html.match(/<td(?:\s[^>]*)?>/g) ?? []).length, 15);
  assert.match(html, /<th>选择<\/th>/);
  assert.match(html, /<td>Kling-Video-V3<\/td>/);
  assert.match(html, /<td>9:16 竖屏<\/td>/);
  assert.match(html, /<strong>写实风格<\/strong>/);
  assert.doesNotMatch(html, /\|---\|---\|---\|/);
});

test('table syntax inside a fenced code block stays literal code', () => {
  const html = render(['```markdown', parameterTable, '```'].join('\n'));
  assert.match(html, /<pre><code/);
  assert.match(html, /\| 项 \| 选择 \| 理由 \|/);
  assert.match(html, /\|---\|---\|---\|/);
  assert.doesNotMatch(html, /<table(?:\s|>)/);
});

test('extended Markdown preserves safe links without enabling raw HTML, script URLs or remote image loads', () => {
  const html = render([
    '<script>alert("unsafe")</script>',
    '<img src="https://example.com/raw.png" onerror="alert(1)">',
    '[危险链接](javascript:alert%281%29)',
    '[安全链接](https://example.com/doc)',
    '![站外图](https://example.com/image.png)',
  ].join('\n\n'));
  assert.doesNotMatch(html, /<(?:script|iframe|img)\b/i);
  assert.doesNotMatch(html, /href="(?:javascript|vbscript|data):/i);
  assert.match(html, /href="https:\/\/example\.com\/doc"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /图片：站外图（未自动加载）/);
});
