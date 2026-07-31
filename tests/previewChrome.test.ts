// What leaves the preview when the document does: the PDF export page and the
// rich-text clipboard payload.
//
// Both are built from a clone of the rendered content, and both have to drop the
// viewer's own furniture on the way out. That furniture is real markup in the
// live DOM (the CSV grid's row-number gutter), so nothing but driving the actual
// bundle proves it is gone.
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
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView = vi.fn();
  await import('../src/webview/main');
});

/** A CSV grid the way src/csv.ts emits one: gutter col, gutter cells, data. */
const GRID =
  '<div class="mc-csv-wrap"><table class="mc-csv">' +
  '<colgroup><col class="mc-csv-gutter-col" /><col /><col /></colgroup>' +
  '<thead><tr>' +
  '<th class="mc-csv-gutter" data-mc-ignore="1" aria-hidden="true"></th>' +
  '<th>Name</th><th>Qty</th>' +
  '</tr></thead><tbody><tr>' +
  '<th class="mc-csv-gutter" data-mc-ignore="1" scope="row">1</th>' +
  '<td>Widget</td><td>3</td>' +
  '</tr></tbody></table></div>';

async function render(html: string, kind: string): Promise<void> {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: 'render',
        kind,
        html,
        source: 'Name,Qty\nWidget,3',
        docKey: 'file:///book.csv',
        docVersion: 1,
        syncScroll: true,
        theme: 'auto',
        styleProfile: 'github',
        mermaidConfig: {},
        math: false,
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 0));
}

/** Drive `exportPdf` and return the body HTML it hands the host. */
async function exportedBody(): Promise<string> {
  posted.length = 0;
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'exportPdf' } }));
  await new Promise((r) => setTimeout(r, 0));
  const msg = posted.find((m) => (m as { type?: string }).type === 'pdfHtml') as
    { bodyHtml: string } | undefined;
  expect(msg, 'exportPdf posted no pdfHtml').toBeDefined();
  return msg!.bodyHtml;
}

describe('PDF export page', () => {
  it('leaves the row-number gutter out of the printed document', async () => {
    await render(GRID, 'csv');
    const body = await exportedBody();
    // The gutter is the viewer labelling the grid, not the file's own data, and
    // three docs say the export is the document rather than the viewer.
    expect(body).not.toContain('data-mc-ignore');
    expect(body).not.toContain('mc-csv-gutter');
    // The data survives it.
    expect(body).toContain('Widget');
    expect(body).toContain('Name');
  });

  it('drops the gutter column with the gutter cells', async () => {
    await render(GRID, 'csv');
    const body = await exportedBody();
    // A colgroup left one <col> longer than every row renders as a blank column
    // down the left edge of every page, which is the gutter reappearing as a gap.
    expect(body).not.toContain('mc-csv-gutter-col');
    const holder = document.createElement('div');
    holder.innerHTML = body;
    const cols = holder.querySelectorAll('colgroup > col').length;
    const headers = holder.querySelectorAll('thead th').length;
    expect(cols).toBe(headers);
  });

  it('still strips the source-line markers it always did', async () => {
    await render('<p data-source-line="0">hello</p>', 'markdown');
    const body = await exportedBody();
    expect(body).not.toContain('data-source-line');
    expect(body).toContain('hello');
  });
});
