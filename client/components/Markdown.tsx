import { createContext, memo, useContext, type ComponentProps } from 'react';
import { ArrowUpRight, Columns3, FileText } from 'lucide-react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { transformReadingContent, type ReadingContent } from '../lib/reading-content';

interface ReadingOptions {
  messageId: string;
  activeId?: string;
  onOpen(content: ReadingContent, opener: HTMLButtonElement): void;
}

const ReadingContext = createContext<{ entries: ReadonlyMap<string, ReadingContent>; options: ReadingOptions } | null>(null);

// These renderers keep their identity across active-reader and streaming updates,
// so a clicked entry remains the same element for focus restoration.
function ReadingDiv({ node, children, ...props }: ComponentProps<'div'> & ExtraProps) {
  const reading = useContext(ReadingContext);
  const id = node?.properties['data-reading-id'];
  const content = typeof id === 'string' ? reading?.entries.get(id) : undefined;
  if (!content || !reading) return <div {...props}>{children}</div>;
  const Icon = content.kind === 'table' ? Columns3 : FileText;
  const active = reading.options.activeId === content.id;
  if (node?.properties['data-reading-inline'] === 'true') return <button type="button" className="reading-inline text-link"
    aria-label={`展开阅读：${content.title}`} aria-expanded={active} data-active={active || undefined}
    onClick={event => reading.options.onOpen(content, event.currentTarget)}>
    <ArrowUpRight size={14} aria-hidden="true" />展开表格
  </button>;
  return <button type="button" className="reading-entry" data-active={active || undefined} data-kind={content.kind}
    aria-label={`展开阅读：${content.title}`} aria-expanded={active}
    onClick={event => reading.options.onOpen(content, event.currentTarget)}>
    <span className="reading-entry-icon"><Icon size={25} strokeWidth={1.65} aria-hidden="true" /></span>
    <span className="reading-entry-copy"><span className="reading-entry-title">{content.title}</span>
      <span className="reading-entry-description">{content.description}</span></span>
    <span className="reading-entry-action">阅读 <ArrowUpRight size={18} strokeWidth={1.65} aria-hidden="true" /></span>
  </button>;
}

const components: Components = {
  div: ReadingDiv,
  table: ({ children: rows }) => <div className="markdown-table" role="region" aria-label="表格，可横向滚动" tabIndex={0}><table>{rows}</table></div>,
  img: ({ alt }) => <span className="image-notice">图片：{alt || '未提供说明'}（未自动加载）</span>,
  a: ({ href, children: label }) => <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>,
};

export const Markdown = memo(function Markdown({ children, reading }: { children: string; reading?: ReadingOptions }) {
  const entries = new Map<string, ReadingContent>();
  const readingPlugin = () => (tree: Root) => {
    for (const [id, content] of transformReadingContent(tree, children, reading!.messageId)) entries.set(id, content);
  };
  return <ReadingContext.Provider value={reading ? { entries, options: reading } : null}>
    <div className="markdown"><ReactMarkdown remarkPlugins={reading ? [remarkGfm, readingPlugin] : [remarkGfm]} components={components}>
      {children}
    </ReactMarkdown></div>
  </ReadingContext.Provider>;
}, (previous, next) => {
  if (previous.children !== next.children) return false;
  if (previous.reading === next.reading) return true;
  if (!previous.reading || !next.reading) return false;
  return previous.reading.messageId === next.reading.messageId
    && previous.reading.activeId === next.reading.activeId
    && previous.reading.onOpen === next.reading.onOpen;
});
