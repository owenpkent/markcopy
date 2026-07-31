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
