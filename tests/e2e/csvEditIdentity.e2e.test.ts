// A CSV grid edit has to name the document the grid was drawn from. The side
// preview can be retargeted before a queued edit reaches the host, and the host
// refuses any edit whose document no longer matches.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { renderCsvHtml } from '../../src/csv';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(() => {
  h.reset();
});

const CSV_TEXT = 'product,notes\nWidget,x\n';
const DOC = 'file:///a.csv';

describe('CSV edits carry the document they were drawn from', () => {
  beforeEach(async () => {
    await h.render({
      html: renderCsvHtml(CSV_TEXT).html,
      source: CSV_TEXT,
      kind: 'csv',
      docKey: DOC,
      docVersion: 3,
    });
  });

  it('stamps an edited cell with the document URI', () => {
    h.find('tbody td').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const editor = h.find('.mc-csv-input') as HTMLTextAreaElement;
    editor.value = 'Gadget';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const posted = h.posted.filter((m) => m.type === 'editCell');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ docVersion: 3, docKey: DOC });
  });

  it('stamps a grid operation with the document URI', async () => {
    const menu = h.rightClick(h.find('tbody td'));
    await menu.click('Insert', 'Row Below');
    const posted = h.posted.filter((m) => m.type === 'gridOp');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ docVersion: 3, docKey: DOC });
  });
});
