// Turning a workbook into the preview's HTML.
//
// Deliberately the CSV grid's markup, element for element: `div.mc-csv-wrap` >
// `table.mc-csv` with a leading gutter column. That is not cosmetic reuse. It is
// what makes the sheet inherit `tableToDelimited`'s copy flavors, the column
// resize handles in csvTable.ts, the zebra striping that survives a rich-text
// copy, and the viewport-tall scrolling layout, without any of them knowing a
// spreadsheet exists.
//
// Two attributes the CSV grid carries are deliberately absent:
//   - `data-mc-editable`, because a cell edit has nowhere to go: the document is
//     a binary workbook, not a text file with addressable lines.
//   - `data-source-line`, because there is no source text and no visible editor,
//     so the sheet must contribute nothing to scroll sync.
import { escapeAttr, escapeHtml } from '../render';
import { covered, type Sheet } from './sheet';
import type { SheetRef } from './workbook';

export interface RenderOptions {
  sheets: SheetRef[];
  activeIndex: number;
  sheet: Sheet;
  maxRows: number;
}

export function renderSheetHtml(o: RenderOptions): string {
  const parts: string[] = [];

  parts.push(tabStrip(o.sheets, o.activeIndex));
  parts.push('<div class="mc-csv-wrap">');

  const visibleRows = o.sheet.rows.filter((r) => !r.hidden);
  if (o.sheet.columns === 0 || visibleRows.length === 0) {
    parts.push('<p class="mc-csv-note">This sheet is empty.</p></div>');
    return parts.join('');
  }

  // Columns the file marks hidden are not rendered at all. A preview that shows
  // what the author deliberately hid is showing them something they chose to
  // suppress, which is worse than showing less.
  const columns: number[] = [];
  for (let c = 0; c < o.sheet.columns; c++) {
    if (!o.sheet.hiddenColumns.has(c)) {
      columns.push(c);
    }
  }

  parts.push('<table class="mc-csv mc-xlsx">');

  // One <col> per rendered column plus the gutter, which is what csvTable.ts
  // sizes when a divider is dragged. A count that disagrees with the header cells
  // disables resizing silently, with no error anywhere.
  parts.push('<colgroup><col class="mc-csv-gutter-col" />');
  for (const c of columns) {
    const width = o.sheet.widths[c];
    // OOXML column widths are in characters of the workbook's Normal font. The
    // usual approximation for the default Calibri 11 is 7px per character plus
    // 5px of padding; expect a pixel or two out for any other font.
    parts.push(
      width === undefined
        ? '<col />'
        : `<col style="width:${Math.max(24, Math.round(width * 7) + 5)}px" />`,
    );
  }
  parts.push('</colgroup>');

  // The header is the column letters, the way a spreadsheet labels its grid. It
  // is chrome, not data, so every cell carries data-mc-ignore and the whole row
  // drops out of a copy (see src/webview/table.ts).
  parts.push('<thead><tr>');
  parts.push('<th class="mc-csv-gutter" data-mc-ignore="1" aria-hidden="true"></th>');
  for (const c of columns) {
    parts.push(`<th scope="col" data-mc-ignore="1"><span>${columnName(c)}</span></th>`);
  }
  parts.push('</tr></thead><tbody>');

  for (const row of visibleRows) {
    parts.push('<tr>');
    parts.push(`<th class="mc-csv-gutter" data-mc-ignore="1" scope="row">${row.index}</th>`);
    const skip = covered(row);
    for (const c of columns) {
      if (skip.has(c)) {
        continue; // covered by a merge anchored above or to the left
      }
      const cell = row.cells[c];
      if (cell === undefined) {
        parts.push('<td></td>');
        continue;
      }
      const attrs: string[] = [];
      const classes: string[] = [];
      if (cell.numeric) {
        classes.push('mc-csv-num');
      }
      if (cell.notCalculated) {
        classes.push('mc-xlsx-nocalc');
      }
      if (classes.length > 0) {
        attrs.push(` class="${classes.join(' ')}"`);
      }
      if (cell.colspan && cell.colspan > 1) {
        attrs.push(` colspan="${cell.colspan}"`);
      }
      if (cell.rowspan && cell.rowspan > 1) {
        attrs.push(` rowspan="${cell.rowspan}"`);
      }
      if (cell.notCalculated) {
        // A formula the writer stored without a cached result. Blank would read
        // as lost data, so mark it and say why on hover.
        attrs.push(
          ' title="This formula has no stored result. Open the file in a spreadsheet application to calculate it."',
        );
      }
      parts.push(`<td${attrs.join('')}>${escapeHtml(cell.text)}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');

  // Outside the table, so copying the grid never picks the notice up.
  const notes: string[] = [];
  if (o.sheet.dropped > 0) {
    notes.push(
      `Showing the first ${num(visibleRows.length)} of ${num(visibleRows.length + o.sheet.dropped)} rows. ` +
        `Raise <code>markcopy.xlsx.maxRows</code> to show more.`,
    );
  }
  if (o.sheet.columnsTruncated) {
    notes.push(
      `Some columns are hidden. Raise <code>markcopy.xlsx.maxColumns</code> to show more.`,
    );
  }
  if (notes.length > 0) {
    parts.push(`<p class="mc-csv-note">${notes.join(' ')}</p>`);
  }

  parts.push('</div>');
  return parts.join('');
}

/**
 * The sheet tabs.
 *
 * `data-mc-ignore` keeps them out of every copy flavor and out of the PDF export,
 * which strips ignored chrome from its clone.
 */
function tabStrip(sheets: SheetRef[], activeIndex: number): string {
  const visible = sheets.filter((s) => !s.hidden);
  if (visible.length <= 1) {
    return '';
  }
  const buttons = visible
    .map((s) => {
      const index = sheets.indexOf(s);
      const active = index === activeIndex ? ' mc-xlsx-tab--active' : '';
      return (
        `<button type="button" class="mc-xlsx-tab${active}" data-mc-sheet="${index}"` +
        `${index === activeIndex ? ' aria-current="true"' : ''}` +
        ` title="${escapeAttr(s.name)}">${escapeHtml(s.name)}</button>`
      );
    })
    .join('');
  return `<nav class="mc-xlsx-tabs" data-mc-ignore="1" aria-label="Sheets">${buttons}</nav>`;
}

/** 0 -> A, 25 -> Z, 26 -> AA, matching the column headers a spreadsheet shows. */
export function columnName(index: number): string {
  let out = '';
  let n = index;
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

function num(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
