// Copying around a footnote, driven through the menu a user drives.
//
// render.test.ts already pins the HTML markdown-it produces. What only shows up
// here is the wiring the webview needs on top of it: right-clicking inside the
// footnotes section has to offer a copy action at all (data-source-line has to
// reach the <li>), and "Copy Block > Markdown" on the paragraph just above the
// footnotes section has to stop there instead of running off the end of the
// file and pulling every definition in with it.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { createMarkdownIt } from '../../src/render';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(() => {
  h.reset();
});

const SOURCE = [
  'Intro paragraph.',
  '',
  'Body with a note.[^note]',
  '',
  '[^note]: The footnote text.',
  '',
].join('\n');
const HTML = createMarkdownIt().render(SOURCE);

describe('copy around a footnote', () => {
  beforeEach(async () => {
    await h.render({ html: HTML, source: SOURCE, kind: 'markdown' });
  });

  it('offers a Block copy action inside the footnotes section', () => {
    // Before data-source-line reached the <li>, target.closest('[data-source-line]')
    // found nothing here and the menu had no copy rows at all.
    const menu = h.rightClick(h.find('.footnote-item'));
    expect(menu.labels()).toContain('Copy Block');
  });

  it('copies a footnote definition on its own, not the whole rest of the document', async () => {
    const menu = h.rightClick(h.find('.footnote-item'));
    await menu.click('Copy as', 'Markdown');
    expect(h.lastClip()?.plain).toBe('[^note]: The footnote text.');
  });

  it('stops the last paragraph before the footnotes section instead of running past it', async () => {
    // Excludes the footnote's own <p>, which (correctly) is also the last <p>
    // in the whole document.
    const paragraphs = Array.from(h.content().querySelectorAll('p')).filter(
      (p) => !p.closest('.footnotes'),
    );
    const last = paragraphs[paragraphs.length - 1];
    expect(last.textContent).toContain('Body with a note.');

    const menu = h.rightClick(last);
    await menu.click('Copy as', 'Markdown');
    // Before the footnotes <section> carried data-source-line, blockMarkdown
    // found no later marker and copied through to the end of the file, footnote
    // definition included.
    expect(h.lastClip()?.plain).toBe('Body with a note.[^note]');
    expect(h.lastClip()?.plain).not.toContain('The footnote text.');
  });
});
