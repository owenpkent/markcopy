// The contract between the XLSX custom editor and the shared preview bundle.
//
// The sheet preview ships no webview code of its own: src/xlsxEditor.ts serves the
// same htmlShell() as the Markdown/CSV preview and posts a `render` message that
// media/webview.js handles. Nothing else in the repo drives that bundle from a
// custom editor, so these tests stand in for the manual pass and pin the parts a
// refactor of main.ts could silently break.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { renderWorkbookHtml } from '../src/xlsx';
import { buildXlsx, row, sheetData } from './xlsx/fixture';

const posted: unknown[] = [];

beforeAll(async () => {
  // main.ts calls these at module scope, so both have to exist before it loads.
  document.body.innerHTML =
    '<div id="content" class="markdown-body"></div>' +
    '<div id="mc-menu" class="mc-menu" role="menu" hidden></div>' +
    '<div id="mc-toast" class="mc-toast" hidden></div>';
  (globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => posted.push(m),
    getState: () => undefined,
    setState: () => undefined,
  });
  // jsdom has no layout; the grid measures cells when it attaches resize handles.
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView = vi.fn();
  await import('../src/webview/main');
});

/** Post a `render` the way src/xlsxEditor.ts does, and let its awaits settle. */
async function renderSheet(html: string): Promise<void> {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'render',
        kind: 'xlsx',
        html,
        source: '',
        docKey: 'file:///book.xlsx',
        docVersion: -1,
        syncScroll: false,
        theme: 'auto',
        styleProfile: 'github',
        mermaidConfig: {},
        math: false,
      },
    }),
  );
  // render() is async (KaTeX and Mermaid upgrades are awaited inside it).
  await new Promise((r) => setTimeout(r, 0));
}

// Produced by the real reader rather than hand-written, so this cannot drift away
// from what src/xlsx/render.ts actually emits. A hand-copied fixture is how a
// contract test quietly stops testing the contract: an earlier version of this one
// omitted `data-mc-ignore` from the header and its "no A/B/C column" assertion
// passed for the wrong reason.
const SHEET = renderWorkbookHtml(
  buildXlsx({
    sheets: [
      {
        name: 'Sheet1',
        xml: sheetData([row(1, '<c r="A1" t="s"><v>0</v></c><c r="B1"><v>3</v></c>')]),
      },
    ],
    sharedStrings: ['<t>Widget</t>'],
  }),
).html;

describe('xlsx render contract', () => {
  it('renders the sheet into the shared preview bundle', async () => {
    await renderSheet(SHEET);
    const content = document.getElementById('content')!;
    expect(content.querySelector('table.mc-csv')).not.toBeNull();
    expect(content.querySelectorAll('tbody td')).toHaveLength(2);
  });

  it('takes the grid layout, not the Markdown one', async () => {
    await renderSheet(SHEET);
    // preview.css keys the viewport-tall, self-scrolling grid off this attribute.
    expect(document.body.dataset.mcKind).toBe('xlsx');
  });

  it('survives DOMPurify with the grid structure intact', async () => {
    await renderSheet(SHEET);
    const table = document.querySelector('table.mc-csv')!;
    // The gutter marker is what keeps row numbers out of every copy flavor, and
    // the colgroup is what the column-resize handles size against. DOMPurify's
    // defaults have to leave both alone.
    expect(table.querySelectorAll('[data-mc-ignore]').length).toBeGreaterThan(0);
    expect(table.querySelectorAll('colgroup col')).toHaveLength(3);
  });

  // csvEdit needs both `data-mc-editable` on the table and `data-record-line` on
  // the row. A sheet supplies neither, so these two isolate the attribute that is
  // actually carrying the read-only guarantee, rather than passing for the
  // incidental reason that the rows are unaddressable too.
  // Both rows carry it, mirroring what src/csv.ts emits: the editor walks
  // `tr[data-record-line]` and treats the first as the header.
  const addressable = SHEET.replace('<thead><tr>', '<thead><tr data-record-line="0">').replace(
    '<tbody><tr>',
    '<tbody><tr data-record-line="1">',
  );
  // Matches whatever classes the renderer emits, rather than a literal that goes
  // stale the moment render.ts adds one (it added `mc-xlsx`, and this silently
  // stopped adding the attribute, which made the positive control fail).
  const editable = addressable.replace(
    /<table class="([^"]*)"/,
    '<table class="$1" data-mc-editable="1"',
  );

  it('leaves the sheet read-only even when its rows are addressable', async () => {
    await renderSheet(addressable);
    const cell = document.querySelector('tbody td')!;
    expect(cell.classList.contains('mc-csv-cell')).toBe(false);
    expect(cell.getAttribute('tabindex')).toBeNull();
  });

  it('would wire that very same markup if it were marked editable', async () => {
    // The positive control. Without it, deleting the enableCsvEditing call from
    // render() outright would leave "read-only" green while breaking CSV editing.
    await renderSheet(editable);
    const cell = document.querySelector('tbody td')!;
    expect(cell.classList.contains('mc-csv-cell')).toBe(true);
  });

  it('stays out of scroll sync, which has no editor to reveal into', async () => {
    posted.length = 0;
    await renderSheet(SHEET);
    // No row carries data-source-line, so there is nothing for the sync to anchor
    // to and nothing is ever reported back to a text editor that does not exist.
    expect(document.querySelectorAll('[data-source-line]')).toHaveLength(0);
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(posted.filter((m) => (m as { type: string }).type === 'revealLine')).toHaveLength(0);
  });
});

// Copying a sheet as a Markdown table is the thing no other extension offers, and
// the reason to reach for MarkCopy over a spreadsheet viewer. What makes it work
// is that the viewer's chrome is excluded: the row-number gutter and the A/B/C
// header both carry data-mc-ignore, and either one leaking in shifts every column.
describe('sheet to Markdown', () => {
  it('produces a real Markdown table, not the raw HTML Turndown declines', async () => {
    await renderSheet(SHEET);
    const md = await copyTableMarkdownFor(document.querySelector('table.mc-csv')!);

    expect(md).toContain('Widget');
    // A GFM table needs a header row and a separator line. Without the header
    // promotion, Turndown returns the table's HTML verbatim and this is the
    // assertion that catches it.
    expect(md).toContain('|');
    expect(md).not.toContain('<table');
    expect(md).toMatch(/\|\s*-+/);
  });

  it('leaves the viewer’s chrome out of the table', async () => {
    await renderSheet(SHEET);
    const md = await copyTableMarkdownFor(document.querySelector('table.mc-csv')!);
    // The A/B/C letters label the grid rather than being part of the document,
    // and the row number is not a column of data. Either leaking in shifts every
    // column of the pasted table.
    expect(md).not.toMatch(/\|\s*A\s*\|\s*B\s*\|/);
    expect(md.split(/\r?\n/)[0]).not.toMatch(/^\|\s*1\s*\|/);
  });
});

/** The exact transform main.ts applies before handing a table to Turndown. */
async function copyTableMarkdownFor(table: HTMLElement): Promise<string> {
  const { htmlToMarkdown } = await import('../src/webview/markdownConvert');
  const { prepareTableForMarkdown } = await import('../src/webview/table');
  return (await htmlToMarkdown(prepareTableForMarkdown(table).outerHTML)).trim();
}
