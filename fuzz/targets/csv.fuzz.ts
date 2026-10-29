import { parseDelimited, renderCsvHtml } from '../../src/csv';

const DELIMITERS = [',', ';', '\t', '|'];

// Neither function throws on bad input (the parser is lenient by design), so
// nothing is caught: any exception is a finding. The first byte picks the
// delimiter and the rest is the document.
export function fuzz(data: Buffer): void {
  const delimiter = DELIMITERS[(data[0] ?? 0) % DELIMITERS.length];
  const text = data.subarray(1).toString('utf8');
  parseDelimited(text, delimiter);
  renderCsvHtml(text, { delimiter: 'auto' });
  renderCsvHtml(text, { delimiter, headerRow: false, maxRows: 50, maxColumns: 8 });
}
