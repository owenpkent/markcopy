// A Word document's pictures on the way out of the webview.
//
// On screen a picture is a `blob:` URL the host's `media` messages became
// (src/webview/ooxmlMedia.ts). That URL means nothing outside the webview and
// is revoked by the next render, so every copy and export path has to turn it
// back into a `data:` URI, from the pictures the document had when the copy
// began. These drive the real table menu and the real Save as Word path, with
// jsdom standing in for object URLs; the downscale itself needs a browser's
// createImageBitmap, which jsdom lacks, so the bytes pass through unchanged
// here and the manual checks in docs/TESTING.md cover the scaling.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { renderDocxHtml } from '../../src/docx/read';
import {
  buildDocx,
  cell,
  drawing,
  imageRel,
  para,
  row,
  run,
  table,
  PNG_1x1,
} from '../docx/fixture';

// The export path imports html-to-image lazily to rasterize equations and
// diagrams. Holding its promise is how a test keeps Save as Word open while
// the file is re-saved underneath it.
let releasePng: ((src: string) => void) | undefined;
vi.mock('html-to-image', () => ({
  toPng: () =>
    new Promise<string>((resolve) => {
      releasePng = resolve;
    }),
  toBlob: () => Promise.resolve(null),
}));

let h: Harness;
const originalRect = Element.prototype.getBoundingClientRect;

beforeAll(async () => {
  h = await boot();
  let n = 0;
  URL.createObjectURL = () => `blob:https://webview.test/${++n}`;
  URL.revokeObjectURL = () => undefined;
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

beforeEach(() => {
  h.reset();
  releasePng = undefined;
});

const DOC_KEY = 'file:///doc';
const PNG_A = PNG_1x1;
const PNG_B = Uint8Array.from(PNG_1x1);
PNG_B[PNG_B.length - 5] ^= 0xff;
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function postMedia(set: string, items: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'media', docKey: DOC_KEY, mediaSet: set, items },
      origin: window.origin,
    }),
  );
}

/** Render a Word document and deliver its pictures, the way src/ooxmlEditor.ts does. */
async function show(doc: ReturnType<typeof renderDocxHtml>, set: string): Promise<void> {
  await h.render({ html: doc.html, kind: 'docx', docKey: DOC_KEY, mediaSet: set });
  postMedia(set, doc.media);
  await h.settle();
}

describe('a picture in a Word table', () => {
  const doc = renderDocxHtml(
    buildDocx({
      rels: imageRel('rIdImg', 'media/image1.png'),
      media: { 'word/media/image1.png': PNG_A },
      body: table(
        row(cell(para('Caption')), true) +
          row(cell(para(run('Photo ') + drawing({ descr: 'photo' })))),
      ),
    }),
  );

  beforeEach(async () => {
    await show(doc, `${DOC_KEY}#1`);
  });

  it('shows the picture from an object URL', () => {
    expect(h.find('td img').getAttribute('src')).toMatch(/^blob:/);
  });

  it('Copy as > Markdown writes the picture as a data: URI, never the object URL', async () => {
    const menu = h.rightClick(h.find('table'));
    await menu.click('Copy as', 'Markdown');
    const md = h.lastClip()?.plain ?? '';
    expect(md).toContain(`![photo](data:image/png;base64,${b64(PNG_A)})`);
    expect(md).not.toContain('blob:');
    // The live table is untouched: its picture still comes from the object URL.
    expect(h.find('td img').getAttribute('src')).toMatch(/^blob:/);
  });

  it('Copy Table (rich text) carries the picture as a data: URI too', async () => {
    const menu = h.rightClick(h.find('table'));
    await menu.click('Copy Table');
    const html = h.lastClip()?.html ?? '';
    expect(html).toContain(`src="data:image/png;base64,${b64(PNG_A)}"`);
    expect(html).not.toContain('blob:');
  });
});

describe('Save as Word while the file is re-saved', () => {
  // An equation makes the export wait on rasterization, which is the window a
  // redraw can land in. A real one is upgraded by KaTeX on render; the class
  // is what the export looks for, and jsdom measures it as 0x0 unless told
  // otherwise, which would skip the rasterizer and close the window.
  const page = (pic: string) =>
    `<div class="mc-docx"><p>Alpha</p><p><span class="mc-math">x</span></p>` +
    `<p><img data-mc-media="m1" alt="${pic}"></p></div>`;

  it('exports the pictures the document had when the export began', async () => {
    Element.prototype.getBoundingClientRect = () =>
      ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0 }) as DOMRect;
    await h.render({
      html: page('first'),
      kind: 'docx',
      docKey: DOC_KEY,
      mediaSet: `${DOC_KEY}#1`,
    });
    postMedia(`${DOC_KEY}#1`, [{ id: 'm1', mime: 'image/png', base64: b64(PNG_A) }]);
    await h.settle();

    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'exportDocx' }, origin: window.origin }),
    );
    // Wait for the export to reach the rasterizer and stop there.
    for (let i = 0; i < 200 && releasePng === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(releasePng).toBeDefined();

    // The file is re-saved: a new render reuses m1 for a different picture.
    await h.render({
      html: page('second'),
      kind: 'docx',
      docKey: DOC_KEY,
      mediaSet: `${DOC_KEY}#2`,
    });
    postMedia(`${DOC_KEY}#2`, [{ id: 'm1', mime: 'image/png', base64: b64(PNG_B) }]);
    await h.settle();

    releasePng?.('data:image/png;base64,AAAA');
    await h.settle();

    const posted = h.posted.find((m) => m.type === 'docxXhtml');
    expect(posted).toBeDefined();
    const body = String(posted?.bodyXhtml);
    expect(body).toContain('Alpha');
    expect(body).toContain('alt="first"');
    expect(body).toContain(`src="data:image/png;base64,${b64(PNG_A)}"`);
    expect(body).not.toContain(b64(PNG_B));
    expect(body).not.toContain('blob:');
  });
});
