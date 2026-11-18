import { posix as path } from 'node:path';
import AdmZip from 'adm-zip';
import sax, { type QualifiedTag } from 'sax';

const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml', '.yaml', '.yml', '.toml']);
const maxFileTextLength = 16_000;
const maxCellLength = 1_000;
const maxArchiveEntries = 1_024;
const maxPartBytes = 4 * 1024 * 1024;
const maxExpandedBytes = 8 * 1024 * 1024;
const maxSheets = 32;
const spreadsheetNamespaces = [
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
];
const officeRelationshipNamespaces = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
];
const packageRelationshipNamespaces = ['http://schemas.openxmlformats.org/package/2006/relationships'];

export type ChatFileExtraction =
  | { status: 'readable'; text: string; truncated: boolean }
  | { status: 'unsupported' | 'unreadable' };

class ExtractionLimit extends Error {}

function prefix(text: string, length: number): string {
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

function readPlainText(bytes: Buffer, maxTextLength: number): ChatFileExtraction {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Reject binary masquerading as text. Tabs, line endings and form feeds are ordinary text.
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) return { status: 'unreadable' };
  const truncated = text.length > maxTextLength;
  return { status: 'readable', text: truncated ? prefix(text, maxTextLength) : text, truncated };
}

function workbookParts(bytes: Buffer) {
  const archive = new AdmZip(bytes, { decoder: {
    encode: (name: string) => Buffer.from(name, 'utf8'),
    decode: (entry: Buffer) => {
      // adm-zip constructs parent directory entries while indexing the central directory.
      if (entry.length > 512) throw new Error('Workbook part name is too long');
      const name = entry.toString('utf8');
      if (name.split('/').length > 16) throw new Error('Workbook part path is too deep');
      return name;
    },
  } });
  if (archive.getEntryCount() > maxArchiveEntries) throw new Error('Workbook has too many archive entries');
  let expanded = 0;
  return (part: string): Buffer => {
    const entry = archive.getEntry(part);
    if (!entry || entry.isDirectory || entry.header.encrypted) throw new Error('Workbook part is unavailable');
    const { size, compressedSize } = entry.header;
    if (size > maxPartBytes || compressedSize > maxPartBytes || expanded + size > maxExpandedBytes) {
      throw new ExtractionLimit('Workbook expansion limit reached');
    }
    // This pinned adm-zip release caps sync inflate at the declared size, including forged zero sizes.
    const data: Buffer = entry.getData();
    if (data.length !== size) throw new Error('Workbook part size does not match the archive');
    expanded += data.length;
    return data;
  };
}

interface XmlEvents {
  open?(tag: QualifiedTag, names: readonly string[]): void;
  close?(names: readonly string[]): void;
  text?(text: string, names: readonly string[]): void;
}

function parseXml(bytes: Buffer, root: string, namespaces: readonly string[], events: XmlEvents): void {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const options = { xmlns: true, strictEntities: true };
  const xml = sax.parser(true, options);
  const names: string[] = [];
  let rootSeen = false;
  const reject = () => { throw new Error('Unsupported workbook XML'); };
  xml.onerror = error => { throw error; };
  xml.ondoctype = xml.onsgmldeclaration = reject;
  xml.onopentag = rawTag => {
    const tag = rawTag as QualifiedTag;
    const name = namespaces.includes(tag.uri) ? tag.local : '';
    if (names.length === 0) {
      if (rootSeen || name !== root) reject();
      rootSeen = true;
    }
    if (names.length >= 64) reject();
    names.push(name);
    events.open?.(tag, names);
  };
  xml.onclosetag = () => { events.close?.(names); names.pop(); };
  xml.ontext = xml.oncdata = value => events.text?.(value, names);
  for (let offset = 0; offset < text.length; offset += 32_768) xml.write(text.slice(offset, offset + 32_768));
  xml.close();
  if (!rootSeen) reject();
}

function attribute(tag: QualifiedTag, name: string): string | undefined {
  return Object.hasOwn(tag.attributes, name) ? tag.attributes[name].value : undefined;
}

function decodeCellText(text: string): string {
  return text.replace(/_x([\da-f]{4})_/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

function partTarget(source: string, target: string): string {
  if (!target || target.startsWith('//') || /[\\:#?\u0000-\u001f]/u.test(target)) throw new Error('Invalid workbook relationship');
  const resolved = target.startsWith('/') ? path.normalize(target.slice(1)) : path.join(path.dirname(source), target);
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) throw new Error('Relationship escapes workbook');
  return resolved;
}

function readRelationships(xml: Buffer, source: string): Map<string, { type: string; part: string }> {
  const relations = new Map<string, { type: string; part: string }>();
  parseXml(xml, 'Relationships', packageRelationshipNamespaces, {
    open(tag, names) {
      if (names.length !== 2 || names[1] !== 'Relationship' || attribute(tag, 'TargetMode') === 'External') return;
      const id = attribute(tag, 'Id');
      const type = attribute(tag, 'Type');
      const target = attribute(tag, 'Target');
      const namespace = officeRelationshipNamespaces.find(uri => type?.startsWith(`${uri}/`));
      if (!id || !type || !target || !namespace) return;
      const kind = type.slice(namespace.length + 1);
      if (!['officeDocument', 'worksheet', 'sharedStrings'].includes(kind)) return;
      if (relations.has(id)) throw new Error('Duplicate workbook relationship');
      if (relations.size >= maxArchiveEntries) throw new Error('Workbook has too many relationships');
      relations.set(id, { type: kind, part: partTarget(source, target) });
    },
  });
  return relations;
}

function readSheetList(xml: Buffer): { sheets: Array<{ name: string; id: string }>; truncated: boolean } {
  const sheets: Array<{ name: string; id: string }> = [];
  let truncated = false;
  parseXml(xml, 'workbook', spreadsheetNamespaces, {
    open(tag, names) {
      if (names.length !== 3 || names[1] !== 'sheets' || names[2] !== 'sheet') return;
      const name = attribute(tag, 'name');
      const id = Object.values(tag.attributes).find(item => item.local === 'id' && officeRelationshipNamespaces.includes(item.uri))?.value;
      if (!name || !id) return;
      if (sheets.length === maxSheets) { truncated = true; return; }
      sheets.push({ name: decodeCellText(name), id });
    },
  });
  return { sheets, truncated };
}

function readSharedStrings(xml: Buffer): string[] {
  const strings: string[] = [];
  let text = '';
  parseXml(xml, 'sst', spreadsheetNamespaces, {
    text(value, names) {
      if (names[1] === 'si' && (names.length === 3 && names[2] === 't'
          || names.length === 4 && names[2] === 'r' && names[3] === 't')) text += value;
    },
    close(names) {
      if (names.length === 2 && names[1] === 'si') {
        strings.push(decodeCellText(text));
        text = '';
      }
    },
  });
  return strings;
}

interface Cell {
  address: string;
  type?: string;
  value?: string;
  formula?: string;
}

function columnNumber(letters: string): number {
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function columnLetters(number: number): string {
  let result = '';
  while (number > 0) {
    number--;
    result = String.fromCharCode(65 + number % 26) + result;
    number = Math.floor(number / 26);
  }
  return result;
}

function readSheet(xml: Buffer, add: (cell: Cell, startsRow: boolean) => void): void {
  let row = 0;
  let column = 0;
  let startsRow = true;
  let cell: Cell | undefined;
  parseXml(xml, 'worksheet', spreadsheetNamespaces, {
    open(tag, names) {
      if (names[1] !== 'sheetData' || names[2] !== 'row') return;
      if (names.length === 3) {
        const number = attribute(tag, 'r');
        row = number && /^[1-9]\d{0,6}$/u.test(number) ? Number(number) : row + 1;
        column = 0;
        startsRow = true;
      }
      if (names.length === 4 && names[3] === 'c') {
        const address = /^([A-Z]{1,3})[1-9]\d{0,6}$/u.exec(attribute(tag, 'r') ?? '');
        column = address ? columnNumber(address[1]) : column + 1;
        const type = attribute(tag, 't');
        cell = { address: address?.[0] ?? `${columnLetters(column)}${row}`, type,
          ...(type === 'inlineStr' ? { value: '' } : {}) };
      }
      if (!cell || names.length !== 5) return;
      if (names[4] === 'f') cell.formula = '';
      if (names[4] === 'v') cell.value = '';
    },
    text(value, names) {
      if (!cell) return;
      if (names.length === 5 && names[4] === 'f' && cell.formula !== undefined) cell.formula += value;
      const cached = names.length === 5 && names[4] === 'v';
      const inline = names[4] === 'is' && (names.length === 6 && names[5] === 't'
        || names.length === 7 && names[5] === 'r' && names[6] === 't');
      if (cached || inline) cell.value = (cell.value ?? '') + value;
    },
    close(names) {
      if (!cell || names.length !== 4 || names[3] !== 'c') return;
      const emptyText = cell.value === '' && (cell.type === 'inlineStr' || cell.type === 'str');
      if (cell.value || cell.formula !== undefined || emptyText) {
        add(cell, startsRow);
        startsRow = false;
      }
      cell = undefined;
    },
  });
}

function readWorkbook(bytes: Buffer, maxTextLength: number): ChatFileExtraction {
  const read = workbookParts(bytes);
  const main = [...readRelationships(read('_rels/.rels'), '').values()].find(relation => relation.type === 'officeDocument');
  if (!main) return { status: 'unreadable' };
  const workbook = main.part;
  const relationships = readRelationships(read(path.join(path.dirname(workbook), '_rels', `${path.basename(workbook)}.rels`)), workbook);
  const { sheets, truncated: sheetLimitReached } = readSheetList(read(workbook));
  const stringsPart = [...relationships.values()].find(relation => relation.type === 'sharedStrings');
  let truncated = sheetLimitReached;
  let sharedStrings: string[] = [];
  if (stringsPart) {
    try { sharedStrings = readSharedStrings(read(stringsPart.part)); }
    catch (error) {
      if (!(error instanceof ExtractionLimit)) throw error;
      truncated = true;
    }
  }
  let text = '';
  let sheetsRead = 0;
  function add(part: string) {
    if (text.length + part.length > maxTextLength) throw new ExtractionLimit('Workbook text limit reached');
    text += part;
  }
  function limited(value: string) {
    if (value.length <= maxCellLength) return value;
    truncated = true;
    return `${prefix(value, maxCellLength)}…`;
  }
  for (const sheet of sheets) {
    const relationship = relationships.get(sheet.id);
    if (relationship?.type !== 'worksheet') { truncated = true; continue; }
    const before = text.length;
    try {
      const xml = read(relationship.part);
      add(`${text ? '\n\n' : ''}工作表 ${JSON.stringify(limited(sheet.name))}`);
      readSheet(xml, (cell, startsRow) => {
        const { type, formula, address } = cell;
        const value = cell.value ?? '';
        let result: string;
        if (type === 's') {
          const shared = /^\d+$/u.test(value) ? sharedStrings[Number(value)] : undefined;
          if (shared === undefined) truncated = true;
          result = shared === undefined ? '[共享字符串未读取]' : JSON.stringify(limited(shared));
        } else if (type === 'b' && (value === '0' || value === '1')) result = value === '1' ? 'TRUE' : 'FALSE';
        else if ((type === undefined || type === 'n') && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][-+]?\d+)?$/u.test(value)) result = limited(value);
        else result = value || type === 'inlineStr' || type === 'str' && cell.value !== undefined
          ? JSON.stringify(limited(decodeCellText(value))) : '';
        const formulaLabel = formula === undefined ? ''
          : ` [${result ? '公式缓存值' : '无公式缓存值'}${formula ? `，公式 ${JSON.stringify(`=${limited(formula)}`)}` : ''}]`;
        add(`${startsRow ? '\n' : '\t'}${address}=${result}${formulaLabel}`);
      });
      sheetsRead++;
    } catch (error) {
      if (error instanceof ExtractionLimit) {
        truncated = true;
        if (text.length > before) { sheetsRead++; break; }
        continue;
      }
      throw error;
    }
  }
  return sheetsRead ? { status: 'readable', text, truncated } : { status: 'unreadable' };
}

export function extractChatFileText(file: { name: string; bytes: Buffer }, textLimit = maxFileTextLength): ChatFileExtraction {
  const extension = path.extname(file.name).toLowerCase();
  const maxTextLength = Math.min(textLimit, maxFileTextLength);
  try {
    if (extension === '.xlsx') return readWorkbook(file.bytes, maxTextLength);
    if (textExtensions.has(extension)) return readPlainText(file.bytes, maxTextLength);
    return { status: 'unsupported' };
  } catch {
    return { status: 'unreadable' };
  }
}
