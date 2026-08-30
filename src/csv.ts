// Pure, VS Code-independent CSV/TSV support: an RFC 4180 parser, delimiter
// sniffing, and the HTML table the preview renders. Kept free of the `vscode`
// module so it unit-tests directly (see tests/csv.test.ts).
//
// Like Markdown, CSV is turned into HTML in the extension host and shipped to
// the webview as a `render` message. The webview stays document-agnostic: it
// sanitizes the HTML, wires up column resizing, and the existing right-click
// menu treats the result as an ordinary table (copy as rich text / CSV / TSV /
// PNG all work without knowing where the table came from).

import { escapeAttr, escapeHtml } from './render';

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
  // Whether the field in progress has consumed any character yet. Tracked apart
  // from `field` because past `maxRecords` we stop accumulating text, and the
  // "a quote only opens a field at its start" rule still has to hold so the
  // remaining records are counted correctly.
  let dirty = false;
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
    dirty = false;
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
          if (keeping()) {
            field += '"';
          }
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        // Count the same line terminators the document does, so `line` keeps
        // matching the editor's numbering: LF, and a CR that is not part of a
        // CRLF pair (the LF of a pair does the counting for both).
        if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) {
          scanLine++;
        }
        if (keeping()) {
          field += ch;
        }
      }
      continue;
    }

    if (ch === '"' && !dirty) {
      // Only a quote at the very start of a field opens a quoted field; anywhere
      // else it is literal data (`a"b`).
      inQuotes = true;
      open = true;
      dirty = true;
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
      if (open || dirty) {
        endRecord(eol, i + 1);
      } else {
        line = scanLine;
        fieldStart = i + 1;
      }
    } else {
      if (keeping()) {
        field += ch;
      }
      open = true;
      dirty = true;
    }
  }

  if (open || dirty) {
    endRecord(src.length, src.length);
  }

  return { records, dropped };
}

/**
 * The delimiter a document's own type implies, if any. A `.tsv` or `.tab` file
 * has already told us what separates its fields; nothing else has.
 */
export function delimiterHint(languageId: string, path = ''): Delimiter | undefined {
  return languageId === 'tsv' || /\.(tsv|tab)$/i.test(path) ? '\t' : undefined;
}

// How well one candidate delimiter splits a sample, or null if it does not
// split it into a table at all.
function scoreDelimiter(
  sample: string,
  delimiter: string,
): { columns: number; consistent: boolean } | null {
  const { records } = parseDelimited(sample, delimiter, 20);
  // The last record of a truncated sample is usually a partial line; drop it
  // so a clipped row does not read as an inconsistent one.
  const rows = records.length > 1 ? records.slice(0, -1) : records;
  if (rows.length === 0) {
    return null;
  }
  const widths = rows.map((r) => r.cells.length);
  const columns = widths[0];
  if (columns < 2) {
    return null;
  }
  return { columns, consistent: widths.every((w) => w === columns) };
}

// Guess which delimiter a document uses by parsing its first few kilobytes with
// each candidate and preferring the one that yields the most columns at a
// consistent width. Files with a single column (no delimiter at all) fall back
// to a comma, which renders them as a one-column table rather than nothing.
//
// `hint` is the delimiter the document's type implies (see delimiterHint). It is
// taken as long as it actually splits the file into consistent columns, because
// scoring alone gets a TSV wrong: fields holding commas score comma higher than
// tab, which would shred a two-column file into three and then write edits back
// with the wrong separator.
export function sniffDelimiter(text: string, hint?: Delimiter): Delimiter {
  const sample = text.slice(0, 64 * 1024);
  if (hint && scoreDelimiter(sample, hint)?.consistent) {
    return hint;
  }

  let best: Delimiter = ',';
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    const scored = scoreDelimiter(sample, delimiter);
    if (!scored) {
      continue;
    }
    // Consistency dominates: a file of clean 3-column rows beats one where a
    // stray character happens to split more fields on some lines.
    const score = (scored.consistent ? 1000 : 0) + scored.columns;
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

/**
 * A whole-row or whole-column change to the grid.
 *
 * Insertions name the side the new row or column lands on, so an operation
 * reads the same here as it does on the menu row that sends it.
 */
export type GridOp =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'deleteRow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteColumn';

const GRID_OPS: readonly string[] = [
  'insertRowAbove',
  'insertRowBelow',
  'deleteRow',
  'insertColumnLeft',
  'insertColumnRight',
  'deleteColumn',
];

/** Whether `value` is an operation gridEdits understands. */
export function isGridOp(value: unknown): value is GridOp {
  return typeof value === 'string' && GRID_OPS.includes(value);
}

// Where a record's own text starts and ends, quotes included and line
// terminator excluded. The parser never emits a record without a field, so
// there is always a first and last span to ask.
function recordStart(record: CsvRecord): number {
  return record.spans[0].start;
}

function recordEnd(record: CsvRecord): number {
  return record.spans[record.spans.length - 1].end;
}

// Work out the edits that insert or delete a whole row or column.
//
// Row operations address one record by the line it starts on, exactly as
// cellEdit does, so a row that spans several lines (a quoted field with a
// newline in it) is one row here too.
//
// Column operations have to touch every record in the document, including the
// ones past markcopy.csv.maxRows that the grid never rendered: a column belongs
// to the file rather than to the window onto it, and shifting only the rows on
// screen would shear the file in half at the truncation point.
//
// Returns non-overlapping edits in document order, so a caller can apply them as
// one atomic change and one undo stop. An operation with nothing to address (an
// unknown line, a column no record reaches) returns an empty list rather than
// guessing at what was meant.
export function gridEdits(
  text: string,
  delimiter: string,
  op: GridOp,
  ref: { line: number; column: number },
  eol = '\n',
): CsvCellEdit[] {
  const { records } = parseDelimited(text, delimiter);
  const edits =
    op === 'insertRowAbove' || op === 'insertRowBelow' || op === 'deleteRow'
      ? rowEdits(records, op, ref.line, delimiter, text, eol)
      : columnEdits(records, op, ref.column, delimiter);
  // Drop the edits that would change nothing: deleting an already-empty lone
  // field, say. Applied, they would still push an undo stop and re-render the
  // preview in exchange for no change at all.
  return edits.filter((edit) => edit.start !== edit.end || edit.text !== '');
}

function rowEdits(
  records: CsvRecord[],
  op: 'insertRowAbove' | 'insertRowBelow' | 'deleteRow',
  line: number,
  delimiter: string,
  text: string,
  eol: string,
): CsvCellEdit[] {
  const record = records.find((r) => r.line === line);
  if (!record) {
    return [];
  }
  if (op === 'deleteRow') {
    return [deleteRowEdit(record, text)];
  }
  // The blank row is as wide as the row it lands next to rather than as wide as
  // the widest row in the file: a ragged document stays exactly as ragged as it
  // was, and the grid never gains a column because an empty row was added to it.
  const blank = delimiter.repeat(Math.max(0, record.cells.length - 1));
  const above = op === 'insertRowAbove';
  // Below inserts at the end of the record's own text, before the terminator
  // that closes it, so the last row of a file that does not end in a newline
  // gains one exactly like any other row.
  const offset = above ? recordStart(record) : recordEnd(record);
  return [{ start: offset, end: offset, text: above ? blank + eol : eol + blank }];
}

// Take the record out along with the line terminator that ends it, so the rows
// below move up instead of leaving a blank line behind. The last record of a
// file that does not end in a newline has no terminator of its own; there the
// one in front of it goes instead, for the same reason.
function deleteRowEdit(record: CsvRecord, text: string): CsvCellEdit {
  let start = recordStart(record);
  let end = recordEnd(record);
  if (text[end] === '\r' && text[end + 1] === '\n') {
    end += 2;
  } else if (text[end] === '\n' || text[end] === '\r') {
    end += 1;
  } else if (text[start - 1] === '\n') {
    start -= text[start - 2] === '\r' ? 2 : 1;
  } else if (text[start - 1] === '\r') {
    start -= 1;
  }
  return { start, end, text: '' };
}

function columnEdits(
  records: CsvRecord[],
  op: 'insertColumnLeft' | 'insertColumnRight' | 'deleteColumn',
  column: number,
  delimiter: string,
): CsvCellEdit[] {
  if (column < 0) {
    return [];
  }

  if (op === 'deleteColumn') {
    return records.flatMap((record) => {
      const span = record.spans[column];
      if (!span) {
        return []; // a short row that never reached this column
      }
      const next = record.spans[column + 1];
      if (next) {
        // The field and the delimiter behind it, so everything to its right
        // slides one column left.
        return [{ start: span.start, end: next.start, text: '' }];
      }
      // The last column has no delimiter behind it to take, so the one in front
      // goes instead. A record of a single field has neither, and is left as an
      // empty row for the parser to drop.
      const previous = record.spans[column - 1];
      return [{ start: previous ? previous.end : span.start, end: span.end, text: '' }];
    });
  }

  // The index the new empty field takes; every field from there on shifts right.
  const at = op === 'insertColumnLeft' ? column : column + 1;
  return records.flatMap((record) => {
    // Past the end of a short row there is nothing to shift: its trailing
    // columns are already empty, and padding it out with delimiters would
    // rewrite rows the reader never touched. The row that is exactly `at` wide
    // is the exception, and is how a column gets appended to the right of the
    // last one at all: there the field is made by a trailing delimiter.
    if (at > record.spans.length) {
      return [];
    }
    const offset = at < record.spans.length ? record.spans[at].start : recordEnd(record);
    return [{ start: offset, end: offset, text: delimiter }];
  });
}

export interface CsvHtmlOptions {
  /** 'auto' sniffs the delimiter; anything else is used verbatim. */
  delimiter?: 'auto' | string;
  /** Delimiter the document's type implies, consulted only when sniffing. */
  hint?: Delimiter;
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
    !opts.delimiter || opts.delimiter === 'auto' ? sniffDelimiter(text, opts.hint) : opts.delimiter;

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
  // `data-mc-editable` is what makes the grid editable, and it is set here rather
  // than decided in the webview on purpose. The same markup renders a spreadsheet
  // sheet (src/xlsx/render.ts), which is read-only because there is no way to write
  // a cell back into a binary workbook. Keying the editor off the markup means a
  // sheet cannot become editable through a change to the webview wiring; keying it
  // off the preview kind would leave that one condition standing between a reader
  // and an edit that silently goes nowhere.
  parts.push(`<table class="mc-csv" data-mc-editable="1" data-source-line="${records[0].line}">`);

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
      parts.push(
        `<th scope="col" title="${escapeAttr(value)}"><span>${escapeHtml(value)}</span></th>`,
      );
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

function num(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
