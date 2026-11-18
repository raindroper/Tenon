export const MAX_DOCUMENT_SEARCH_MATCHES = 30;
const MAX_RESULT_CHARS = 9_000;
const MAX_MATCH_CHARS = 700;
const MAX_CELL_CHARS = 200;
const MAX_HEADER_CHARS = 420;
const MAX_HEADING_CHARS = 120;
const MAX_TABLE_COLUMNS = 4096;

interface DocumentLine { line: number; offset: number; text: string }
interface Cell { text: string; offset: number }
interface Table { header: DocumentLine; width: number; heading?: string; columnIndex?: number }
interface Match extends DocumentLine {
  matchOffset: number; truncated?: boolean; tableHeaderLine?: number; cell?: string; cellTruncated?: boolean;
}
interface TableContext {
  headerLine: number; headerOffset: number; header: string; heading?: string; headerTruncated?: boolean; columnIndex?: number;
}

function* documentLines(content: string): Generator<DocumentLine> {
  let offset = 0;
  let line = 1;
  while (offset < content.length) {
    const newline = content.indexOf('\n', offset);
    const end = newline === -1 ? content.length : newline;
    yield { line, offset, text: content.slice(offset, content[end - 1] === '\r' ? end - 1 : end) };
    if (newline === -1) break;
    offset = end + 1;
    line++;
  }
}

function tableCells(text: string): Cell[] | undefined {
  if (!text.includes('|') || /^(?: {4}|\t)/.test(text)) return;
  const end = text.trimEnd().length;
  const first = text.length - text.trimStart().length;
  const cells: Cell[] = [];
  let start = first;
  let delimiter = false;
  const push = (stop: number) => {
    const raw = text.slice(start, stop);
    cells.push({ text: raw.trim(), offset: start + raw.length - raw.trimStart().length });
  };
  for (let index = first; index < end; index++) {
    const char = text[index];
    if (char === '\\' && (text[index + 1] === '\\' || text[index + 1] === '|')) {
      index++;
      continue;
    }
    if (char !== '|') continue;
    delimiter = true;
    if (index !== first) {
      if (cells.length >= MAX_TABLE_COLUMNS) return;
      push(index);
    }
    start = index + 1;
  }
  if (!delimiter) return;
  if (start < end) {
    if (cells.length >= MAX_TABLE_COLUMNS) return;
    push(end);
  }
  return cells.length ? cells : undefined;
}

const decodeCell = (text: string) => text.replace(/\\([\\|])/g, '$1');

function findInCell(cell: Cell, query: string) {
  const text = decodeCell(cell.text);
  const index = text.indexOf(query);
  if (index < 0) return;
  let match = index;
  // The result offset addresses the original text, including any escape characters.
  for (const escape of cell.text.matchAll(/\\[\\|]/g)) {
    if (escape.index > match) break;
    match++;
  }
  return { text, index, offset: cell.offset + match };
}

function tableContext(table: Table): TableContext {
  return {
    headerLine: table.header.line, headerOffset: table.header.offset, header: table.header.text.slice(0, MAX_HEADER_CHARS),
    ...(table.heading ? { heading: table.heading } : {}),
    ...(table.header.text.length > MAX_HEADER_CHARS ? { headerTruncated: true } : {}),
    ...(table.columnIndex === undefined ? {} : { columnIndex: table.columnIndex + 1 }),
  };
}

/** Search only the returned document text. Column mode uses verified Markdown table rows, with no text-search fallback. */
export function searchDocument(content: string, query: string, offset: number, limit: number, column?: string) {
  const matches: Match[] = [];
  const tables = new Map<number, TableContext>();
  const coverage = column === undefined ? { mode: 'literal' as const }
    : { mode: 'column' as const, column, matchedTables: 0, ambiguousTables: 0, skippedMalformedRows: 0 };
  const start = Math.max(0, Math.min(offset, content.length));
  const maxMatches = Math.max(1, Math.min(limit, MAX_DOCUMENT_SEARCH_MATCHES));
  let totalMatches = 0;
  let nextOffset: number | null = null;
  // Reserve room for result fields and array punctuation in addition to serialized match and header objects.
  let chars = 350;
  let table: Table | undefined;
  let heading: string | undefined;
  let fence: string | undefined;
  const lines = documentLines(content);
  let next = lines.next();
  while (!next.done) {
    const row = next.value;
    next = lines.next();
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(row.text);
    let rowTable: Table | undefined;
    let targetCell: Cell | undefined;
    if (fence || fenceMatch) {
      table = undefined;
      if (!fence) fence = fenceMatch?.[1];
      else if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length
        && !row.text.slice(fenceMatch[0].length).trim()) {
        fence = undefined;
      }
    } else {
      const section = /^ {0,3}#{1,6}[ \t]+/.exec(row.text);
      if (section) {
        const headingStart = section[0].length;
        heading = row.text.slice(headingStart, headingStart + MAX_HEADING_CHARS).trimEnd().replace(/[ \t]+#+$/, '');
        table = undefined;
      } else {
        const cells = tableCells(row.text);
        const nextText = next.done ? '' : next.value.text;
        const separator = cells && /^[|:\- \t]+$/.test(nextText) ? tableCells(nextText) : undefined;
        const headerCandidate = separator?.every(cell => /^:?-+:?$/.test(cell.text)) ? separator : undefined;
        if (cells && headerCandidate?.length === cells.length) {
          let columnIndex: number | undefined;
          if (coverage.mode === 'column') {
            const namedColumns = cells.flatMap((cell, index) => decodeCell(cell.text) === coverage.column ? [index] : []);
            if (namedColumns.length === 1) {
              columnIndex = namedColumns[0];
              coverage.matchedTables++;
            } else if (namedColumns.length > 1) coverage.ambiguousTables++;
          }
          table = { header: row, width: cells.length, heading, columnIndex };
        } else if (headerCandidate) {
          // A malformed new table must not inherit the preceding table's column assignments.
          table = undefined;
        } else if (table && row.line !== table.header.line + 1) {
          if (!cells) table = undefined;
          else if (cells.length === table.width) {
            rowTable = table;
            if (table.columnIndex !== undefined) targetCell = cells[table.columnIndex];
          } else if (coverage.mode === 'column' && table.columnIndex !== undefined) coverage.skippedMalformedRows++;
        }
      }
    }

    if (!query) continue;
    const cellMatch = targetCell ? findInCell(targetCell, query) : undefined;
    let match = coverage.mode === 'literal' ? row.text.indexOf(query) : cellMatch?.offset ?? -1;
    if (match < 0) continue;
    totalMatches++;
    if (nextOffset !== null) continue;
    if (row.offset + match < start) {
      if (coverage.mode === 'column') continue;
      match = row.text.indexOf(query, start - row.offset);
      if (match < 0) continue;
    }
    const truncated = row.text.length > MAX_MATCH_CHARS;
    const from = truncated ? Math.max(0, match - Math.floor(MAX_MATCH_CHARS / 2)) : 0;
    const cellTruncated = cellMatch !== undefined && cellMatch.text.length > MAX_CELL_CHARS;
    const cellStart = cellTruncated ? Math.max(0, cellMatch.index - Math.max(0, Math.floor((MAX_CELL_CHARS - query.length) / 2))) : 0;
    const result: Match = { line: row.line, offset: row.offset, matchOffset: row.offset + match,
      text: row.text.slice(from, from + MAX_MATCH_CHARS), ...(truncated ? { truncated: true } : {}),
      ...(cellMatch ? { cell: cellMatch.text.slice(cellStart, cellStart + MAX_CELL_CHARS) } : {}),
      ...(cellTruncated ? { cellTruncated: true } : {}),
      ...(rowTable ? { tableHeaderLine: rowTable.header.line } : {}) };
    const context = rowTable && !tables.has(rowTable.header.line) ? tableContext(rowTable) : undefined;
    const size = JSON.stringify(result).length + 1 + (context ? JSON.stringify(context).length + 1 : 0);
    if (matches.length >= maxMatches || chars + size > MAX_RESULT_CHARS) {
      nextOffset = Math.max(start, row.offset);
      continue;
    }
    chars += size;
    matches.push(result);
    if (context) tables.set(context.headerLine, context);
  }
  return { matches, totalMatches, nextOffset, tables: [...tables.values()], coverage };
}
