// The contract between the XLSX custom editor and the shared preview bundle.
//
// The sheet preview ships no webview code of its own: src/xlsxEditor.ts serves the
// same htmlShell() as the Markdown/CSV preview and posts a `render` message that
// media/webview.js handles. Nothing else in the repo drives that bundle from a
// custom editor, so these tests stand in for the manual pass and pin the parts a
// refactor of main.ts could silently break.
import { describe, it, expect, beforeAll, vi } from 'vitest';

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

const SHEET =
  '<div class="mc-csv-wrap"><table class="mc-csv">' +
  '<colgroup><col class="mc-csv-gutter-col" /><col /><col /></colgroup>' +
  '<thead><tr><th class="mc-csv-gutter" data-mc-ignore="1" aria-hidden="true"></th>' +
  '<th scope="col"><span>name</span></th><th scope="col"><span>qty</span></th></tr></thead>' +
  '<tbody><tr><th class="mc-csv-gutter" data-mc-ignore="1" scope="row">1</th>' +
  '<td>Widget</td><td class="mc-csv-num">3</td></tr></tbody></table></div>';

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

  it('leaves the sheet read-only even when its rows are addressable', async () => {
    await renderSheet(addressable);
    const cell = document.querySelector('tbody td')!;
    expect(cell.classList.contains('mc-csv-cell')).toBe(false);
    expect(cell.getAttribute('tabindex')).toBeNull();
  });

  it('would wire that very same markup if it were marked editable', async () => {
    // The positive control. Without it, deleting the enableCsvEditing call from
    // render() outright would leave "read-only" green while breaking CSV editing.
    await renderSheet(
      addressable.replace('<table class="mc-csv"', '<table class="mc-csv" data-mc-editable="1"'),
    );
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
