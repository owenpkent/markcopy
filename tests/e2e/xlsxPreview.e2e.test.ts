// The sheet preview, driven through the bundle the host serves it to.
//
// Automates the reachable half of the spreadsheet checklist (docs/TESTING.md:74).
// The rows about legibility under each theme stay manual: jsdom loads no
// stylesheet, so nothing here can tell green-on-black from black-on-black.
//
// The fixture mirrors sample.xlsx, which is what the checklist tells a human to
// open: three sheets with one hidden, a merged title, a date, currency, a
// percentage, a formula with a stored result and one without.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { renderWorkbookHtml } from '../../src/xlsx';
import { buildXlsx, row, sheetData } from '../xlsx/fixture';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

// Style indexes: 0 plain, 1 date, 2 currency, 3 percent.
//
// The date carries an explicit `yyyy-mm-dd` rather than the builtin id 14, which
// is the locale-dependent `mm-dd-yy` and renders `03-15-23`. sample.xlsx, which
// the checklist has a human open, uses the explicit code, so the fixture does
// too rather than asserting whatever the builtin happens to produce.
const CELL_XFS = [0, 166, 164, 165];
const NUM_FMTS = [
  { id: 164, code: '#,##0.00' },
  { id: 165, code: '0.0%' },
  { id: 166, code: 'yyyy-mm-dd' },
];

const SUMMARY = sheetData([
  // Row 1 is a merged title across A:C. Rows jump from 1 to 3, the way a sheet
  // with a spacer row does, so the gutter has something to get wrong.
  row(1, '<c r="A1" t="s"><v>0</v></c>'),
  row(
    3,
    '<c r="A3" t="s"><v>1</v></c>' +
      '<c r="B3" s="1"><v>45000</v></c>' +
      '<c r="C3" s="2"><v>1234.5</v></c>',
  ),
  row(
    4,
    '<c r="A4" t="s"><v>2</v></c>' +
      '<c r="B4" s="3"><v>0.153</v></c>' +
      // A formula with its last computed value stored beside it.
      '<c r="C4"><f>SUM(C3:C3)</f><v>11110.75</v></c>',
  ),
  // A formula the writer never stored a result for. Excel would compute it on
  // open; a reader cannot, so the preview has to say so rather than show blank.
  row(5, '<c r="A5" t="s"><v>3</v></c><c r="B5"><f>AVERAGE(B3:B4)</f></c>'),
]);

const WORKBOOK = buildXlsx({
  sheets: [
    {
      name: 'Summary',
      xml: SUMMARY + '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>',
    },
    { name: 'Notes', xml: sheetData([row(1, '<c r="A1" t="s"><v>4</v></c>')]) },
    { name: 'Scratch', xml: sheetData([row(1, '<c r="A1"><v>1</v></c>')]), hidden: true },
  ],
  sharedStrings: [
    '<t>Quarterly summary</t>',
    '<t>Widget</t>',
    '<t>Margin</t>',
    '<t>Average</t>',
    '<t>A note</t>',
  ],
  numFmts: NUM_FMTS,
  cellXfs: CELL_XFS,
});

const SHEET = renderWorkbookHtml(WORKBOOK).html;

async function renderSheet(): Promise<void> {
  h.reset();
  await h.render({ html: SHEET, kind: 'xlsx', supportsSync: false });
}

describe('the sheet grid', () => {
  beforeEach(renderSheet);

  it('opens as a grid, not as text', () => {
    expect(h.content().querySelector('table.mc-csv')).not.toBeNull();
    // preview.css keys the viewport-tall, self-scrolling layout off this.
    expect(document.body.dataset.mcKind).toBe('xlsx');
  });

  it('numbers rows the way the sheet does, jumping 1 to 3', () => {
    const gutter = Array.from(h.content().querySelectorAll('tbody tr th, tbody tr td'))
      .filter((cell) => cell.hasAttribute('data-mc-ignore'))
      .map((cell) => cell.textContent?.trim());
    // Renumbering 1,2,3 is the failure this catches: the sheet's own numbers are
    // what let someone match the preview against the file open in Excel.
    expect(gutter.slice(0, 3)).toEqual(['1', '3', '4']);
  });

  it('spans the merged title across its three columns', () => {
    const title = h.find('tbody td');
    expect(title.textContent).toContain('Quarterly summary');
    expect(title.getAttribute('colspan')).toBe('3');
  });

  it('formats dates, currency, and percentages rather than showing serials', () => {
    const text = h.content().textContent ?? '';
    // 45000 is a date serial and 0.153 a fraction. Either showing through means
    // the number format was dropped somewhere between the reader and the DOM.
    expect(text).toContain('2023-03-15');
    expect(text).toContain('1,234.50');
    expect(text).toContain('15.3%');
    expect(text).not.toContain('45000');
    expect(text).not.toContain('0.153');
  });

  it('shows a stored formula result, and marks the one with none', () => {
    const text = h.content().textContent ?? '';
    expect(text).toContain('11110.75');
    // AVERAGE has no cached value. A blank cell would read as "the sheet says
    // nothing here"; the marker plus its tooltip say why it is empty instead.
    const marker = h.content().querySelector('.mc-xlsx-nocalc');
    expect(marker, 'expected a marker for the uncomputed formula').not.toBeNull();
    // The tooltip has to survive DOMPurify, or the marker is an unexplained
    // glyph. Asserting the class alone would pass with the title stripped.
    expect(marker?.getAttribute('title')).toMatch(/no stored result/i);
  });
});

describe('the sheet tab strip', () => {
  beforeEach(renderSheet);

  it('lists the visible sheets and hides the hidden one', () => {
    const tabs = Array.from(document.querySelectorAll('[data-mc-sheet]')).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toEqual(['Summary', 'Notes']);
  });

  it('asks the host to switch sheets when a tab is clicked', () => {
    const notes = document.querySelectorAll<HTMLElement>('[data-mc-sheet]')[1];
    notes.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // The bundle holds one sheet at a time; re-reading the workbook is the
    // host's job, so the click has to leave the webview to have any effect.
    expect(h.posted).toContainEqual({ type: 'selectSheet', index: 1 });
  });
});

describe('exporting a sheet to PDF', () => {
  beforeEach(renderSheet);

  it('sends the grid without the tab strip or the row-number gutter', async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'exportPdf' } }));
    await h.settle();

    const posted = h.posted.find((message) => message.type === 'pdfHtml');
    expect(posted, 'expected the webview to hand the host a body to print').toBeTruthy();
    const body = String(posted?.bodyHtml ?? '');

    // Both are viewer furniture. On paper the tab strip is a row of dead
    // buttons and the gutter is a column of numbers that are not in the file
    // (docs/TESTING.md:88).
    expect(body).toContain('Quarterly summary');
    expect(body).not.toContain('data-mc-sheet');
    expect(body).not.toContain('data-mc-ignore');
  });
});
