// Serialize a rendered HTML table to delimiter-separated values. Pass ',' for
// CSV or '\t' for TSV. CSV fields follow RFC 4180 quoting; TSV flattens tabs and
// newlines to spaces. Pure enough to unit-test with a jsdom table element.
//
// Cells marked `data-mc-ignore` are viewer chrome rather than data (the CSV
// grid's row-number gutter, and a sheet's A/B/C column header), so they are left
// out. What you copy is what the document contains.

/**
 * The rows this table owns.
 *
 * `querySelectorAll('tr')` is not scoped: it also returns the rows of any nested
 * table, which then land in the outer table's output as extra rows and inflate
 * the column count everything else is padded to.
 */
function ownRows(table: HTMLElement): HTMLTableRowElement[] {
  return Array.from(
    table.querySelectorAll<HTMLTableRowElement>(
      ':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr',
    ),
  );
}

// A span wider than any real table is a malformed file rather than a document
// worth copying, and expanding it verbatim would allocate a cell per column it
// names. The sheet reader already clamps merges to the grid it built, so
// anything past this is out of contract before it reaches here.
const MAX_SPAN = 1000;

function spanOf(cell: Element, name: string): number {
  const raw = Number.parseInt(cell.getAttribute(name) ?? '1', 10);
  return Number.isFinite(raw) && raw > 1 ? Math.min(raw, MAX_SPAN) : 1;
}

/**
 * Replace every colspan/rowspan with the cells it stands for.
 *
 * A merged cell fills one slot in the DOM but several in the grid, and CSV, TSV
 * and GFM are all positional. Left alone, a `colspan="2"` emits one field where
 * the table shows two, so every column after it shifts left; a `rowspan` leaves
 * the rows beneath it short by however many columns it covers. None of the three
 * formats can express a span, so the only faithful copy is the expanded one.
 *
 * Mutates `table`, which is why both callers hand it a clone.
 */
function expandSpans(table: HTMLElement): void {
  const doc = table.ownerDocument;
  const rows = ownRows(table);
  // grid[r][c] is the element occupying that slot. Holes are positions no cell
  // reached, which become empty cells on the way out.
  const grid: (HTMLElement | undefined)[][] = rows.map(() => []);

  rows.forEach((tr, r) => {
    for (const cell of Array.from(tr.children) as HTMLElement[]) {
      // The first slot this row has not already had filled from above or to the
      // left. A rowspan two rows up owns its column here before this row starts.
      let c = 0;
      while (grid[r][c] !== undefined) {
        c++;
      }
      const across = spanOf(cell, 'colspan');
      const down = spanOf(cell, 'rowspan');
      cell.removeAttribute('colspan');
      cell.removeAttribute('rowspan');
      const tag = cell.tagName === 'TH' ? 'th' : 'td';
      for (let dr = 0; dr < down && r + dr < rows.length; dr++) {
        for (let dc = 0; dc < across; dc++) {
          grid[r + dr][c + dc] = dr === 0 && dc === 0 ? cell : doc.createElement(tag);
        }
      }
    }
  });

  rows.forEach((tr, r) => {
    while (tr.firstChild !== null) {
      tr.removeChild(tr.firstChild);
    }
    for (let c = 0; c < grid[r].length; c++) {
      tr.appendChild(grid[r][c] ?? doc.createElement('td'));
    }
  });
}

// Turndown builds a GFM row by joining cells with '|', and neither it nor its
// GFM plugin escapes a '|' inside a cell: one in the data closes the cell early
// and the row grows a column that nothing else has. Escaping it in the DOM does
// not survive either, because Turndown rewrites the backslash on the way out. So
// the character rides through the conversion as a private-use placeholder, which
// Turndown passes through untouched, and `tableToMarkdown` restores it after.
const PIPE_PLACEHOLDER = '\uE000';

/** Make every cell's text safe to sit inside one GFM table cell. */
function escapeCellText(root: HTMLElement): void {
  const doc = root.ownerDocument;
  // A line break inside a cell ends the Markdown row, splitting one row across
  // two lines and corrupting every column after it.
  root.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode(' ')));

  // Collected before editing: rewriting nodeValue while walking is undefined
  // behaviour for a TreeWalker.
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    texts.push(node as Text);
  }
  for (const text of texts) {
    const value = text.nodeValue ?? '';
    if (value.includes('|') || /[\r\n]/.test(value)) {
      text.nodeValue = value.replace(/\|/g, PIPE_PLACEHOLDER).replace(/\s*[\r\n]+\s*/g, ' ');
    }
  }
}

export function tableToDelimited(table: HTMLElement, delimiter: string): string {
  // A CSV grid shows the file's own fields, so its cell text is data: trimming
  // it would quietly drop significant leading and trailing spaces from a copy
  // that is otherwise a faithful round-trip. In a Markdown table the same
  // whitespace is incidental rendering, so it still goes.
  const verbatim = table.classList.contains('mc-csv');

  // Cloned because expanding spans rewrites the rows, and the table being copied
  // is the one on screen.
  const clone = table.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-mc-ignore]').forEach((n) => n.remove());
  expandSpans(clone);

  return (
    ownRows(clone)
      .map((tr) =>
        Array.from(tr.children).map((c) => {
          const text = c.textContent ?? '';
          return escapeField(verbatim ? text : text.trim(), delimiter);
        }),
      )
      // A row that contributes no data cells is entirely chrome, so it should not
      // become a blank line. A spreadsheet sheet has one: its header is the column
      // letters A, B, C, which label the grid rather than being part of it. A
      // Markdown table's empty row is unaffected, since its cells are real (empty)
      // cells and still serialize as delimiters.
      .filter((cells) => cells.length > 0)
      .map((cells) => cells.join(delimiter))
      .join('\r\n')
  );
}

/**
 * A copy of `table` reshaped into something Turndown will emit as a GFM table.
 *
 * Four things have to happen, and none of them are cosmetic:
 *
 *  1. Drop the viewer's chrome (`data-mc-ignore`): the row-number gutter, and a
 *     spreadsheet sheet's A/B/C header, which labels the grid rather than being
 *     part of the document. Either one left in shifts every column.
 *  2. Expand merged cells, which GFM has no way to express, so that each row
 *     carries one cell per column the table actually shows.
 *  3. Give the table a header. A GFM table cannot be headerless, and a sheet is
 *     one once its letters are stripped. Turndown's table rule sees no header,
 *     declines the table, and returns the raw HTML, so without this "Copy as
 *     Markdown" pastes `<table class=...>` into the reader's document. The first
 *     body row is promoted, which is what the first row of a sheet usually is.
 *  4. Pad that header out to the widest row. A merged title cell promoted from
 *     row 1 is one cell wide against a three-column body, and a GFM table with
 *     fewer header cells than body cells renders with the extra columns dropped.
 *
 * Returns a detached clone; the live table is never touched.
 */
export function prepareTableForMarkdown(table: HTMLElement): HTMLElement {
  const doc = table.ownerDocument;
  const clone = table.cloneNode(true) as HTMLElement;

  clone.querySelectorAll('[data-mc-ignore]').forEach((n) => n.remove());
  expandSpans(clone);
  escapeCellText(clone);
  clone.querySelectorAll('tr').forEach((tr) => {
    if ((tr as HTMLTableRowElement).cells.length === 0) {
      tr.remove();
    }
  });

  const head = clone.querySelector('thead');
  if (head && head.querySelectorAll('th,td').length === 0) {
    head.remove();
  }
  if (!clone.querySelector('thead')) {
    const first = clone.querySelector('tbody > tr') as HTMLTableRowElement | null;
    if (first) {
      // Cells become <th>: a first row of <td> renders without the separator line
      // that makes it a table rather than a run of pipes.
      Array.from(first.children).forEach((cell) => {
        const th = doc.createElement('th');
        th.textContent = cell.textContent;
        first.replaceChild(th, cell);
      });
      first.remove();
      const created = doc.createElement('thead');
      created.appendChild(first);
      clone.insertBefore(created, clone.firstChild);
    }
  }

  const rows = ownRows(clone);
  const widest = rows.reduce((max, tr) => Math.max(max, tr.cells.length), 0);
  const headerRow = clone.querySelector('thead tr') as HTMLTableRowElement | null;
  if (headerRow) {
    for (let i = headerRow.cells.length; i < widest; i++) {
      headerRow.appendChild(doc.createElement('th'));
    }
  }
  return clone;
}

/**
 * `table` as a GFM table, with the pipes in its data escaped.
 *
 * `convert` is the Turndown wrapper, injected so this stays testable without
 * pulling the lazy Turndown import into a unit test.
 */
export async function tableToMarkdown(
  table: HTMLElement,
  convert: (html: string) => Promise<string>,
): Promise<string> {
  const md = await convert(prepareTableForMarkdown(table).outerHTML);
  return md.split(PIPE_PLACEHOLDER).join('\\|');
}

export function escapeField(value: string, delimiter: string): string {
  if (delimiter === '\t') {
    return value.replace(/[\t\r\n]+/g, ' ');
  }
  // RFC 4180: quote the field if it contains the delimiter, a quote, or a newline.
  if (value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
