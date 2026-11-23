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

export function table(headers: string[], rows: string[][], className?: string): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table${className ? ` class="${className}"` : ''}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// A table of facts keeps its "Property | Value" header in the markup, where a
// copy as CSV or Markdown wants it, and the stylesheet hides it on the page,
// where a header over every one of five tables is noise.
export const properties = (rows: Row[]): string =>
  table(['Property', 'Value'], rows, 'mc-info-props');

/** A grid longer than this is a list, and is given the page's full width. */
export const LONG_GRID_ROWS = 12;

/**
 * A grid of rows. A long one of one or two columns (file paths, exported
 * names, a path beside its size) is marked as a list: stretched across the
 * page as an ordinary table it is one short string per line and a screen of
 * nothing beside it, so the stylesheet lays its rows out several to a line.
 * It stays a table in the markup, which is what the table copies work on.
 */
export function grid(headers: string[], rows: string[][]): string {
  const list = headers.length <= 2 && rows.length > LONG_GRID_ROWS;
  return table(
    headers,
    rows,
    list ? (headers.length === 2 ? 'mc-info-list mc-info-pairs' : 'mc-info-list') : undefined,
  );
}

/** One headed part of the page. `wide` spans both of the page's columns. */
export function block(heading: string, body: string, wide = false): string {
  return `<div class="mc-info-section${wide ? ' mc-info-wide' : ''}"><h2>${escapeHtml(heading)}</h2>${body}</div>`;
}

/**
 * The top of the page: the file's name, then the lines that say what it is.
 * The name is escaped here. `lines` and `icon` are markup the caller built,
 * and the caller has already escaped what it put in them.
 */
export function pageHead(fileName: string, lines: string[], icon = ''): string {
  return `<div class="mc-info-head">${icon}<div class="mc-info-title"><h1>${escapeHtml(fileName)}</h1>${lines.join('')}</div></div>`;
}
