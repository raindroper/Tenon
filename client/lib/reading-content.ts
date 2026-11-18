import type { Root, RootContent } from 'mdast';

export interface ReadingContent {
  id: string;
  title: string;
  description: string;
  content: string;
  kind: 'table' | 'document' | 'sources';
}

type TextNode = { type: string; value?: string; children?: readonly TextNode[] };

function plainText(node: TextNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  return node.children?.map(plainText).join('') ?? '';
}

// A source slice cannot resolve reference definitions located outside the slice.
// Keep these blocks in place rather than silently changing their links in the reader.
function needsReferenceContext(node: TextNode): boolean {
  return node.type === 'linkReference' || node.type === 'imageReference' || node.type === 'footnoteReference'
    || node.type === 'definition' || node.type === 'footnoteDefinition'
    || Boolean(node.children?.some(needsReferenceContext));
}

function sourceRange(nodes: readonly RootContent[], source: string): { start: number; end: number } | undefined {
  const start = nodes[0]?.position?.start.offset;
  const end = nodes.at(-1)?.position?.end.offset;
  return start !== undefined && end !== undefined && start >= 0 && end > start && end <= source.length ? { start, end } : undefined;
}

/** Reuses the already parsed remark tree; only top-level, self-contained blocks become entries. */
export function transformReadingContent(tree: Root, source: string, messageId: string): Map<string, ReadingContent> {
  const entries = new Map<string, ReadingContent>();
  const original = tree.children;
  const children: RootContent[] = [];

  const replace = (nodes: readonly RootContent[], kind: ReadingContent['kind'], title: string, description: string, inline = false): boolean => {
    const range = sourceRange(nodes, source);
    if (!range || nodes.some(needsReferenceContext)) return false;
    const id = `${messageId}:reading:${range.start}:${range.end}`;
    entries.set(id, { id, kind, title, description, content: source.slice(range.start, range.end) });
    if (inline) children.push(...nodes);
    children.push({ type: 'paragraph', children: [],
      position: { start: nodes[0]!.position!.start, end: nodes.at(-1)!.position!.end },
      data: { hName: 'div', hProperties: { 'data-reading-id': id, ...(inline ? { 'data-reading-inline': 'true' } : {}) } },
    });
    return true;
  };

  for (let index = 0; index < original.length; index++) {
    const node = original[index]!;
    if (node.type === 'heading') {
      let end = index + 1;
      while (end < original.length) {
        const next = original[end]!;
        if (next.type === 'heading' && next.depth <= node.depth) break;
        end++;
      }
      const section = original.slice(index, end);
      const paragraphs = section.filter(item => item.type === 'paragraph').length;
      const range = sourceRange(section, source);
      if (range && range.end - range.start >= 1200 && paragraphs >= 2
        && replace(section, 'document', plainText(node).trim() || '详细说明', `说明文档 · ${paragraphs} 段正文`)) {
        index = end - 1;
        continue;
      }
    }
    if (node.type === 'table') {
      const previous = original[index - 1];
      const heading = previous?.type === 'heading' && children.at(-1) === previous ? previous : undefined;
      const columns = node.children[0]?.children.length ?? 0;
      const rows = Math.max(0, node.children.length - 1);
      const headers = node.children[0]?.children.map(plainText).filter(Boolean).join('、') ?? '';
      const description = `${rows} 行 · ${columns} 列${headers ? ` · ${headers}` : ''}`;
      const nodes = heading ? [heading, node] : [node];
      if (heading) children.pop();
      const inline = rows <= 3 && columns <= 4 && plainText(node).length <= 400;
      if (replace(nodes, 'table', heading ? plainText(heading).trim() || '内容表格' : '内容表格', description, inline)) continue;
      if (heading) children.push(heading);
    }
    children.push(node);
  }
  tree.children = children;
  return entries;
}
