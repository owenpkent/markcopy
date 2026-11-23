// The markup the file-information previews share: a page of ordinary headings
// and tables inside the shared shell, so the context menu's copies and the
// three exports work on it as they do on a Word document.
//
// Every cell is escaped here. The strings come out of files that may be
// hostile, and the webview sanitizes the result again on arrival.
import { escapeHtml } from '../escape';

export type Row = [label: string, value: string];

export const formatNumber = (value: number): string => value.toLocaleString('en-US');

export function formatBytes(bytes: number): string {
  const exact = `${formatNumber(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = '';
  for (const next of units) {
    if (value < 1024) {
      break;
    }
    value /= 1024;
    unit = next;
  }
  return unit ? `${value.toFixed(value < 10 ? 2 : 1)} ${unit} (${exact})` : exact;
}

/** The short form alone, "1.23 MB", for a sentence rather than a table cell. */
export function formatBytesShort(bytes: number): string {
  return formatBytes(bytes).split(' (')[0];
}

export function table(headers: string[], rows: string[][]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export const properties = (rows: Row[]): string => table(['Property', 'Value'], rows);
