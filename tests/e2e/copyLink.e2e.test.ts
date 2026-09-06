// Copying an address, driven through the menu a user drives.
//
// tests/links.test.ts already pins what comes off a link. What this adds is the
// part no unit test reaches: that right-clicking one actually puts the row on
// the menu, under the label the docs promise, attached to the action, and that
// the value lands on the clipboard. The two surfaces are here for the same
// reason they differ -- prose gets its address from an href the renderer built,
// a grid cell has no href at all -- so a change that fixes one and forgets the
// other fails here.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { boot, type Harness } from '../webview/harness';
import { createMarkdownIt } from '../../src/render';
import { renderCsvHtml } from '../../src/csv';

let h: Harness;

beforeAll(async () => {
  h = await boot();
});

beforeEach(() => {
  h.reset();
});

// A bare address and a bare URL, both of which the renderer autolinks, plus a
// titled link whose text is nothing like its target.
const PROSE_SOURCE = [
  'Mail bob@example.com about it.',
  '',
  'Or read <https://example.com/docs?q=1>.',
  '',
  'The [handbook](https://example.com/handbook) has more.',
  '',
].join('\n');
const PROSE_HTML = createMarkdownIt().render(PROSE_SOURCE);

const CSV_TEXT = 'name,contact,site\nBob,Bob Smith <bob@example.com>,www.example.com/bob\n';
const CSV_HTML = renderCsvHtml(CSV_TEXT).html;

/** The link whose href starts with `prefix`. */
function link(prefix: string): HTMLElement {
  const found = Array.from(h.content().querySelectorAll('a')).find((a) =>
    (a.getAttribute('href') ?? '').startsWith(prefix),
  );
  if (!found) {
    throw new Error(`no link with href starting ${prefix}`);
  }
  return found as HTMLElement;
}

/** The grid cell whose text is `text`. */
function cell(text: string): HTMLElement {
  const found = Array.from(h.content().querySelectorAll('td')).find(
    (td) => (td.textContent ?? '').trim() === text,
  );
  if (!found) {
    throw new Error(`no cell reading ${text}`);
  }
  return found as HTMLElement;
}

describe('copy an address out of the prose', () => {
  beforeEach(async () => {
    await h.render({ html: PROSE_HTML, source: PROSE_SOURCE, kind: 'markdown' });
  });

  it('leads with the address when you right-click an autolinked email', () => {
    const menu = h.rightClick(link('mailto:'));
    // Top level, not buried: this is the whole point of the row.
    expect(menu.labels()).toContain('Copy Email Address');
  });

  it('copies the address without its mailto: wrapper', async () => {
    const menu = h.rightClick(link('mailto:'));
    await menu.click('Copy Email Address');
    expect(h.lastClip()?.plain).toBe('bob@example.com');
  });

  it('offers the mailto: form one level down', async () => {
    const menu = h.rightClick(link('mailto:'));
    await menu.click('Copy as', 'Link Address');
    expect(h.lastClip()?.plain).toBe('mailto:bob@example.com');
  });

  it('leads with the URL when you right-click a link', () => {
    const menu = h.rightClick(link('https://example.com/handbook'));
    expect(menu.labels()).toContain('Copy Link');
  });

  it('copies a link target, not the words standing in for it', async () => {
    const menu = h.rightClick(link('https://example.com/handbook'));
    await menu.click('Copy Link');
    expect(h.lastClip()?.plain).toBe('https://example.com/handbook');
  });

  it('copies the words too, for the link that has its own', async () => {
    const menu = h.rightClick(link('https://example.com/handbook'));
    await menu.click('Copy as', 'Link Text');
    expect(h.lastClip()?.plain).toBe('handbook');
  });

  it('copies a link as Markdown', async () => {
    const menu = h.rightClick(link('https://example.com/handbook'));
    await menu.click('Copy as', 'Markdown');
    expect(h.lastClip()?.plain).toBe('[handbook](https://example.com/handbook)');
  });

  it('has no Link Text row for a link that shows its own target', async () => {
    // An autolinked URL's text and href are the same characters, so the row
    // would copy what "Copy Link" just copied.
    const menu = h.rightClick(link('https://example.com/docs'));
    await menu.click('Copy as');
    expect(menu.labels()).toContain('Markdown');
    expect(menu.labels()).not.toContain('Link Text');
  });
});

describe('copy an address out of a grid', () => {
  beforeEach(async () => {
    await h.render({ html: CSV_HTML, source: CSV_TEXT, kind: 'csv' });
  });

  it('leads with the address in a cell that holds one', () => {
    // Nothing linkifies a CSV cell, so without this the address comes out only
    // by dragging across part of the cell.
    const menu = h.rightClick(cell('Bob Smith <bob@example.com>'));
    expect(menu.labels()).toContain('Copy Email Address');
  });

  it('copies the address out of the text around it', async () => {
    const menu = h.rightClick(cell('Bob Smith <bob@example.com>'));
    await menu.click('Copy Email Address');
    expect(h.lastClip()?.plain).toBe('bob@example.com');
  });

  it('copies a URL out of a cell', async () => {
    const menu = h.rightClick(cell('www.example.com/bob'));
    await menu.click('Copy Link');
    expect(h.lastClip()?.plain).toBe('www.example.com/bob');
  });

  it('still leads with the table on an ordinary cell', async () => {
    // The signature row. A cell holding no address must not displace it.
    const menu = h.rightClick(cell('Bob'));
    expect(menu.labels()[0]).toBe('Copy Table');
    await menu.click('Copy as', 'Cell Text');
    expect(h.lastClip()?.plain).toBe('Bob');
  });

  it('offers no cell text for the row-number gutter', async () => {
    // Chrome, not data. It stays out of every other copy flavor, so a row that
    // put "3" on the clipboard would be the one place it leaked.
    const gutter = h.content().querySelector('th.mc-csv-gutter[scope="row"]');
    expect(gutter).not.toBeNull();
    const menu = h.rightClick(gutter as Element);
    await menu.click('Copy as');
    expect(menu.labels()).not.toContain('Cell Text');
  });

  it('keeps the whole cell reachable from an address cell', async () => {
    const menu = h.rightClick(cell('Bob Smith <bob@example.com>'));
    await menu.click('Copy as', 'Cell Text');
    expect(h.lastClip()?.plain).toBe('Bob Smith <bob@example.com>');
  });
});
