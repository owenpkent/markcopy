// Copying a table, driven through the menu a user drives.
//
// Covers the "Copy as -> Markdown" rows of docs/TESTING.md across all three
// table surfaces (Markdown preview, CSV grid, sheet grid), plus the CSV and rich
// text flavors that share the same plumbing. The unit tests in tests/table.test.ts
// already cover the transforms; what these add is the wiring, which no unit test
// touches: the menu row has to exist, be labelled what the docs say, be attached
// to the action, and put the result on the clipboard.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { createMarkdownIt } from '../../src/render';
import { renderCsvHtml } from '../../src/csv';
import { renderWorkbookHtml } from '../../src/xlsx';
import { buildXlsx, row, sheetData } from '../xlsx/fixture';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(() => {
  h.reset();
});

const MARKDOWN_SOURCE = ['| product | qty |', '| --- | --- |', '| Widget | 3 |', ''].join('\n');
const MARKDOWN_TABLE = createMarkdownIt().render(MARKDOWN_SOURCE);

// Deliberately contains a pipe. A cell whose text is a pipe has to be escaped on
// the way into a Markdown table or it splits the row into an extra column, which
// is what the escaping fix on this branch was for.
const CSV_TEXT = 'product,notes\nWidget,a | b\n';
const CSV_TABLE = renderCsvHtml(CSV_TEXT).html;

const SHEET_TABLE = renderWorkbookHtml(
  buildXlsx({
    sheets: [
      {
        name: 'Sheet1',
        xml: sheetData([
          row(1, '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>'),
          row(2, '<c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c>'),
        ]),
      },
    ],
    sharedStrings: ['<t>product</t>', '<t>qty</t>', '<t>Widget</t>'],
  }),
).html;

describe('copy a Markdown preview table', () => {
  beforeEach(async () => {
    await h.render({ html: MARKDOWN_TABLE, source: MARKDOWN_SOURCE, kind: 'markdown' });
  });

  it('offers the documented rows when you right-click a table', () => {
    const menu = h.rightClick(h.find('table'));
    // docs/TESTING.md:44 promises Copy Table at the top level, with the rest of
    // the flavors one level down.
    expect(menu.labels()).toContain('Copy Table');
    expect(menu.labels()).toContain('Copy as');
  });

  it('puts a real Markdown table on the clipboard', async () => {
    const menu = h.rightClick(h.find('table'));
    await menu.click('Copy as', 'Markdown');

    const plain = h.lastClip()?.plain ?? '';
    expect(plain).toContain('Widget');
    // A GFM table needs a separator line. Without one, Turndown declined the
    // table and returned its HTML verbatim, which is the failure this catches.
    expect(plain).toMatch(/\|\s*-+/);
    expect(plain).not.toContain('<table');
  });

  it('copies the table as CSV', async () => {
    const menu = h.rightClick(h.find('table'));
    await menu.click('Copy as', 'CSV');
    // CRLF on purpose: it is what a spreadsheet expects of a pasted CSV, and
    // pinning it here means a refactor to '\n' has to be a deliberate choice.
    expect(h.lastClip()?.plain).toBe('product,qty\r\nWidget,3');
  });

  it('copies the table as rich text, with an HTML flavor', async () => {
    const menu = h.rightClick(h.find('table'));
    await menu.click('Copy Table');

    // The HTML flavor is what makes a table arrive as a table in Word rather
    // than as Markdown source (docs/TESTING.md:44). Its plain-text companion
    // comes from `innerText`, which jsdom does not implement, so what that
    // flavor reads as stays a manual check.
    expect(h.lastClip()?.html).toContain('<table');
    expect(h.lastClip()?.html).toContain('Widget');
  });
});

describe('copy a CSV grid', () => {
  beforeEach(async () => {
    await h.render({ html: CSV_TABLE, source: CSV_TEXT, kind: 'csv' });
  });

  it('escapes a pipe inside a cell rather than splitting the row', async () => {
    const menu = h.rightClick(h.find('tbody td'));
    await menu.click('Copy as', 'Markdown');

    const lines = (h.lastClip()?.plain ?? '').trim().split(/\r?\n/);
    const body = lines[lines.length - 1];
    expect(body).toContain('\\|');
    // Two columns means three pipes: leading, separating, trailing. An
    // unescaped pipe would make four and shift every column after it.
    expect(body.match(/(?<!\\)\|/g)).toHaveLength(3);
  });

  it('leaves the row-number gutter out of every flavor', async () => {
    const menu = h.rightClick(h.find('tbody td'));
    await menu.click('Copy as', 'CSV');
    // The gutter is viewer chrome, not data (docs/TESTING.md:147). Its cells
    // carry data-mc-ignore, and a copy that honors that starts at `product`.
    expect(h.lastClip()?.plain?.split(/\r?\n/)[0]).toBe('product,notes');
  });
});

// Copying out of a cell you are editing. The grid's own tests cover the editor;
// what only shows up here is the menu the right-click opens over it, which has to
// offer the value being typed rather than the table around it: a textarea's
// selection is invisible to window.getSelection(), so the generic Selection rows
// come out empty exactly when there is something selected.
describe('copy from a CSV cell being edited', () => {
  beforeEach(async () => {
    await h.render({ html: CSV_TABLE, source: CSV_TEXT, kind: 'csv' });
  });

  /** Double-click the first data cell, the way a reader starts editing. */
  function edit(): HTMLTextAreaElement {
    h.find('tbody td').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return h.find('.mc-csv-input') as HTMLTextAreaElement;
  }

  it('offers the value, not the table around it', () => {
    // Nothing is selected yet, so there is no selection row to offer: an edit
    // opens with the caret at the end of the value.
    const menu = h.rightClick(edit());
    expect(menu.labels()).toEqual(['Copy Cell', 'Select All']);
  });

  it('copies part of a cell', async () => {
    const editor = edit();
    editor.setSelectionRange(0, 3);
    const menu = h.rightClick(editor);
    expect(menu.labels()).toEqual(['Copy Selection', 'Copy Cell', 'Select All']);
    await menu.click('Copy Selection');
    expect(h.lastClip()?.plain).toBe('Wid');
  });

  it('takes the whole value on a second double-click', async () => {
    const editor = edit();
    editor.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const menu = h.rightClick(editor);
    // Selecting everything makes "Copy Cell" the same action under a second
    // name, so the menu drops it.
    expect(menu.labels()).toEqual(['Copy Selection', 'Select All']);
    await menu.click('Copy Selection');
    expect(h.lastClip()?.plain).toBe('Widget');
  });

  it('leaves the edit open, and the document untouched, to copy from', async () => {
    const editor = edit();
    const menu = h.rightClick(editor);
    await menu.click('Copy Cell');
    expect(h.lastClip()?.plain).toBe('Widget');
    expect(editor.isConnected).toBe(true);
    expect(h.posted.filter((m) => m.type === 'editCell')).toHaveLength(0);
  });
});

describe('copy a sheet', () => {
  beforeEach(async () => {
    await h.render({ html: SHEET_TABLE, kind: 'xlsx', supportsSync: false });
  });

  it('copies the sheet as a Markdown table without the A/B/C header', async () => {
    const menu = h.rightClick(h.find('tbody td'));
    await menu.click('Copy as', 'Markdown');

    const plain = h.lastClip()?.plain ?? '';
    expect(plain).toContain('Widget');
    expect(plain).toMatch(/\|\s*-+/);
    // The column letters label the grid; they are not a row of the document.
    // Either they or the row numbers leaking in shifts every column.
    expect(plain).not.toMatch(/\|\s*A\s*\|\s*B\s*\|/);
    expect(plain.split(/\r?\n/)[0]).not.toMatch(/^\|\s*1\s*\|/);
  });

  it('copies the sheet as CSV starting at the sheet own first row', async () => {
    const menu = h.rightClick(h.find('tbody td'));
    await menu.click('Copy as', 'CSV');
    expect(h.lastClip()?.plain?.split(/\r?\n/)[0]).toBe('product,qty');
  });
});
