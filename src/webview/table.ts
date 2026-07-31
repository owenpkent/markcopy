// Serialize a rendered HTML table to delimiter-separated values. Pass ',' for
// CSV or '\t' for TSV. CSV fields follow RFC 4180 quoting; TSV flattens tabs and
// newlines to spaces. Pure enough to unit-test with a jsdom table element.
//
// Cells marked `data-mc-ignore` are viewer chrome rather than data (today that
// is the CSV grid's row-number gutter), so they are left out. What you copy is
// what the document contains.
export function tableToDelimited(table: HTMLElement, delimiter: string): string {
  // A CSV grid shows the file's own fields, so its cell text is data: trimming
  // it would quietly drop significant leading and trailing spaces from a copy
  // that is otherwise a faithful round-trip. In a Markdown table the same
  // whitespace is incidental rendering, so it still goes.
  const verbatim = table.classList.contains('mc-csv');
  return (
    Array.from(table.querySelectorAll('tr'))
      .map((tr) =>
        Array.from(tr.querySelectorAll('th:not([data-mc-ignore]),td:not([data-mc-ignore])')).map(
          (c) => {
            const text = c.textContent ?? '';
            return escapeField(verbatim ? text : text.trim(), delimiter);
          },
        ),
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
 * Three things have to happen, and none of them are cosmetic:
 *
 *  1. Drop the viewer's chrome (`data-mc-ignore`): the row-number gutter, and a
 *     spreadsheet sheet's A/B/C header, which labels the grid rather than being
 *     part of the document. Either one left in shifts every column.
 *  2. Give the table a header. A GFM table cannot be headerless, and a sheet is
 *     one once its letters are stripped. Turndown's table rule sees no header,
 *     declines the table, and returns the raw HTML, so without this "Copy as
 *     Markdown" pastes `<table class=...>` into the reader's document. The first
 *     body row is promoted, which is what the first row of a sheet usually is.
 *  3. Pad that header out to the widest row. A merged title cell promoted from
 *     row 1 is one cell wide against a three-column body, and a GFM table with
 *     fewer header cells than body cells renders with the extra columns dropped.
 *
 * Returns a detached clone; the live table is never touched.
 */
export function prepareTableForMarkdown(table: HTMLElement): HTMLElement {
  const doc = table.ownerDocument;
  const clone = table.cloneNode(true) as HTMLElement;

  clone.querySelectorAll('[data-mc-ignore]').forEach((n) => n.remove());
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

  const rows = Array.from(clone.querySelectorAll('tr')) as HTMLTableRowElement[];
  const widest = rows.reduce((max, tr) => Math.max(max, tr.cells.length), 0);
  const headerRow = clone.querySelector('thead tr') as HTMLTableRowElement | null;
  if (headerRow) {
    for (let i = headerRow.cells.length; i < widest; i++) {
      headerRow.appendChild(doc.createElement('th'));
    }
  }
  return clone;
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
