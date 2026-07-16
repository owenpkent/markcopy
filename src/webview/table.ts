// Serialize a rendered HTML table to delimiter-separated values. Pass ',' for
// CSV or '\t' for TSV. CSV fields follow RFC 4180 quoting; TSV flattens tabs and
// newlines to spaces. Pure enough to unit-test with a jsdom table element.
export function tableToDelimited(table: HTMLElement, delimiter: string): string {
  return Array.from(table.querySelectorAll('tr'))
    .map((tr) =>
      Array.from(tr.querySelectorAll('th,td'))
        .map((c) => escapeField((c.textContent ?? '').trim(), delimiter))
        .join(delimiter),
    )
    .join('\r\n');
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
