// Pure, VS Code-independent CSV/TSV support: an RFC 4180 parser, delimiter
// sniffing, and the HTML table the preview renders. Kept free of the `vscode`
// module so it unit-tests directly (see tests/csv.test.ts).
//
// Like Markdown, CSV is turned into HTML in the extension host and shipped to
// the webview as a `render` message. The webview stays document-agnostic: it
// sanitizes the HTML, wires up column resizing, and the existing right-click
// menu treats the result as an ordinary table (copy as rich text / CSV / TSV /
// PNG all work without knowing where the table came from).

import { escapeHtml } from './render';

/** The delimiters we sniff for, in tie-break order. */
export const DELIMITERS = [',', '\t', ';', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/**
 * Where a field sits in the original document, quotes included. Offsets index
 * the text exactly as it was passed in (a stripped BOM does not shift them), so
 * a caller can turn one into a document range and rewrite that field alone.
 */
export interface FieldSpan {
  start: number;
  /** Offset just past the field's last character. */
  end: number;
}

export interface CsvRecord {
  cells: string[];
  /** One span per entry in `cells`, same order. */
  spans: FieldSpan[];
  /** 0-based line in the source text where this record starts. */
  line: number;
}

export interface ParseResult {
  records: CsvRecord[];
  /**
   * Records past `maxRecords` that were counted but not built. 0 when the whole
   * document was parsed.
   */
  dropped: number;
}

// Parse delimiter-separated text per RFC 4180, leniently:
//   - a quoted field may contain the delimiter, CR/LF, and `""` for a literal quote
//   - a bare quote inside an unquoted field is kept as data rather than rejected
//   - CRLF, LF, and lone CR all end a record
//   - a trailing newline does not produce a final empty record
//
// Stops building records after `maxRecords`, then keeps scanning (without
// allocating) to count what is left, so the caller can say exactly how many rows
// it is hiding. That keeps a 500k-row file cheap while still reporting a total.
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRecords = Number.POSITIVE_INFINITY,
): ParseResult {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const src = hasBom ? text.slice(1) : text;
  // Spans are reported against the caller's text, so a stripped BOM must not
  // shift every offset by one.
  const base = hasBom ? 1 : 0;

  const records: CsvRecord[] = [];
  let dropped = 0;

  let cells: string[] = [];
  let spans: FieldSpan[] = [];
  let field = '';
  let fieldStart = 0;
  let inQuotes = false;
  // Whether anything at all has been seen for the record in progress. Lets a
  // trailing newline close the last record without opening an empty one.
  let open = false;
  let line = 0; // line the record in progress started on
  let scanLine = 0; // line the cursor is on

  // Past `maxRecords` we stop building anything and just keep the scan going so
  // the remaining records can be counted.
  const keeping = (): boolean => records.length < maxRecords;

  const endField = (end: number): void => {
    if (keeping()) {
      cells.push(field);
      spans.push({ start: fieldStart + base, end: end + base });
    }
    field = '';
  };

  const endRecord = (end: number, nextStart: number): void => {
    endField(end);
    if (keeping()) {
      records.push({ cells, spans, line });
    } else {
      dropped++;
    }
    cells = [];
    spans = [];
    open = false;
    line = scanLine;
    fieldStart = nextStart;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') {
          scanLine++;
        }
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      // Only a quote at the very start of a field opens a quoted field; anywhere
      // else it is literal data (`a"b`).
      inQuotes = true;
      open = true;
    } else if (ch === delimiter) {
      endField(i);
      fieldStart = i + 1;
      open = true;
    } else if (ch === '\r' || ch === '\n') {
      // The field ends at the line terminator, before CRLF is consumed as one.
      const eol = i;
      if (ch === '\r' && src[i + 1] === '\n') {
        i++;
      }
      scanLine++;
      // A blank line between records is not a record.
      if (open || field !== '') {
        endRecord(eol, i + 1);
      } else {
        line = scanLine;
        fieldStart = i + 1;
      }
    } else {
      field += ch;
      open = true;
    }
  }

  if (open || field !== '') {
    endRecord(src.length, src.length);
  }

  return { records, dropped };
}

// Guess which delimiter a document uses by parsing its first few kilobytes with
// each candidate and preferring the one that yields the most columns at a
// consistent width. Files with a single column (no delimiter at all) fall back
// to a comma, which renders them as a one-column table rather than nothing.
export function sniffDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 64 * 1024);
  let best: Delimiter = ',';
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    const { records } = parseDelimited(sample, delimiter, 20);
    // The last record of a truncated sample is usually a partial line; drop it
    // so a clipped row does not read as an inconsistent one.
    const rows = records.length > 1 ? records.slice(0, -1) : records;
    if (rows.length === 0) {
      continue;
    }
    const widths = rows.map((r) => r.cells.length);
    const columns = widths[0];
    if (columns < 2) {
      continue;
    }
    const consistent = widths.every((w) => w === columns);
    // Consistency dominates: a file of clean 3-column rows beats one where a
    // stray character happens to split more fields on some lines.
    const score = (consistent ? 1000 : 0) + columns;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

// Quote a value for writing back into the document, per RFC 4180: wrap it only
// when it would otherwise be ambiguous, and double any inner quotes. The inverse
// of what the parser reads, so a value survives an edit round-trip unchanged.
export function formatField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** A single replacement to apply to the document, as offsets into its text. */
export interface CsvCellEdit {
  start: number;
  end: number;
  text: string;
}

// Work out the exact edit that sets one cell to `value`: which slice of the
// document to replace and what to put there. Only the edited field's own span is
// touched, so every other field keeps its original bytes, including any quoting
// style we would not have chosen ourselves.
//
// `line` identifies the record by the source line it starts on (records never
// share a starting line), which survives re-rendering better than a row index.
// Returns null when there is no such record, so a stale edit is dropped rather
// than applied to the wrong row.
export function cellEdit(
  text: string,
  delimiter: string,
  line: number,
  column: number,
  value: string,
): CsvCellEdit | null {
  const { records } = parseDelimited(text, delimiter);
  const record = records.find((r) => r.line === line);
  if (!record || column < 0) {
    return null;
  }

  const span = record.spans[column];
  if (span) {
    return { start: span.start, end: span.end, text: formatField(value, delimiter) };
  }

  // The row is shorter than the grid is wide (a ragged file). Grow it in place:
  // append enough delimiters to reach the edited column, then the value.
  const last = record.spans[record.spans.length - 1];
  if (!last) {
    return null;
  }
  return {
    start: last.end,
    end: last.end,
    text: delimiter.repeat(column - record.spans.length + 1) + formatField(value, delimiter),
  };
}

export interface CsvHtmlOptions {
  /** 'auto' sniffs the delimiter; anything else is used verbatim. */
  delimiter?: 'auto' | string;
  /** Treat the first record as column headers. Default true. */
  headerRow?: boolean;
  /** Body rows to render before truncating. Default 5000. */
  maxRows?: number;
}

export interface CsvHtmlResult {
  html: string;
  delimiter: string;
  rows: number;
  columns: number;
}

// A value that should sit flush right, the way a spreadsheet aligns numbers.
// Tolerates thousands separators, a leading currency symbol, a trailing percent,
// and accounting-style negatives like `(1,234.50)`.
export function isNumeric(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 32) {
    return false;
  }
  const bare = v
    .replace(/^\((.*)\)$/, '-$1')
    .replace(/^[-+]?\s*[$£€¥₹]\s*/, (m) => (m.trimStart().startsWith('-') ? '-' : ''))
    .replace(/,/g, '')
    .replace(/%$/, '');
  return bare !== '' && Number.isFinite(Number(bare));
}

// Render a whole CSV/TSV document as the preview's HTML table.
//
// The row-number gutter carries `data-mc-ignore` so the clipboard serializers
// skip it: what you copy out of the preview is the data you put in, not the
// viewer's chrome (see src/webview/table.ts).
export function renderCsvHtml(text: string, opts: CsvHtmlOptions = {}): CsvHtmlResult {
  const headerRow = opts.headerRow !== false;
  const maxRows = Math.max(1, opts.maxRows ?? 5000);
  const delimiter =
    !opts.delimiter || opts.delimiter === 'auto' ? sniffDelimiter(text) : opts.delimiter;

  // One extra record so the header does not eat into the body-row budget.
  const { records, dropped } = parseDelimited(text, delimiter, maxRows + (headerRow ? 1 : 0));

  if (records.length === 0) {
    return {
      html: `<div class="mc-csv-wrap"><p class="mc-csv-note">This file is empty.</p></div>`,
      delimiter,
      rows: 0,
      columns: 0,
    };
  }

  const columns = records.reduce((max, r) => Math.max(max, r.cells.length), 0);
  const header = headerRow ? records[0] : undefined;
  const body = headerRow ? records.slice(1) : records;

  const parts: string[] = [];
  parts.push('<div class="mc-csv-wrap">');
  parts.push(`<table class="mc-csv" data-source-line="${records[0].line}">`);

  // An explicit <col> per column is what the resize handles size; without it a
  // width set on one cell only lasts until the browser re-lays out the table.
  parts.push('<colgroup><col class="mc-csv-gutter-col" />');
  parts.push('<col />'.repeat(columns));
  parts.push('</colgroup>');

  if (header) {
    // `data-record-line` identifies the record for editing; `data-source-line`
    // is deliberately absent, because the header row is sticky and would then
    // always be the topmost mapped element, pinning preview -> editor scroll
    // sync to line 0 forever. The <table> above carries the header's line.
    parts.push(`<thead><tr data-record-line="${header.line}">`);
    parts.push('<th class="mc-csv-gutter" data-mc-ignore="1" aria-hidden="true"></th>');
    for (let c = 0; c < columns; c++) {
      const value = header.cells[c] ?? '';
      parts.push(`<th scope="col" title="${attr(value)}"><span>${escapeHtml(value)}</span></th>`);
    }
    parts.push('</tr></thead>');
  }

  parts.push('<tbody>');
  for (let r = 0; r < body.length; r++) {
    const record = body[r];
    parts.push(`<tr data-source-line="${record.line}" data-record-line="${record.line}">`);
    parts.push(`<th class="mc-csv-gutter" data-mc-ignore="1" scope="row">${r + 1}</th>`);
    for (let c = 0; c < columns; c++) {
      const value = record.cells[c] ?? '';
      const cls = isNumeric(value) ? ' class="mc-csv-num"' : '';
      parts.push(`<td${cls}>${escapeHtml(value)}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');

  // Outside the table, so copying the table never picks the notice up.
  if (dropped > 0) {
    const shown = num(body.length);
    const total = num(body.length + dropped);
    parts.push(
      `<p class="mc-csv-note">Showing the first ${shown} of ${total} rows. ` +
        `Raise <code>markcopy.csv.maxRows</code> to show more.</p>`,
    );
  }
  parts.push('</div>');

  return { html: parts.join(''), delimiter, rows: body.length, columns };
}

function attr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function num(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
