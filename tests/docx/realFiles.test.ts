// Documents written by real tools, not by this repo's fixtures.
//
// tests/fixtures/docx/sample.md is the source; pandoc.docx is pandoc's output
// for it, and lo.docx is that file round-tripped through LibreOffice. The
// latter matters most: it writes one list as several `w:num` instances of the
// same abstract numbering (the first with a restart override), which a reader
// that counts per `numId` splits into separate lists.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDocxHtml } from '../../src/docx/read';

const dir = resolve(__dirname, '..', 'fixtures', 'docx');

describe.each(['pandoc.docx', 'lo.docx'])('real document: %s', (name) => {
  const html = renderDocxHtml(new Uint8Array(readFileSync(resolve(dir, name)))).html;
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('has the headings at their levels', () => {
    expect(text(dom.querySelector('h1')!)).toBe('Quarterly report');
    expect([...dom.querySelectorAll('h2')].map(text)).toEqual(['Lists', 'Table']);
    expect(text(dom.querySelector('h3')!)).toBe('Sub heading');
  });

  it('keeps First, Second and Third in one ordered list', () => {
    const lists = [...dom.querySelectorAll('ol')];
    const top = lists.find((ol) => text(ol).startsWith('First'))!;
    const items = [...top.children].filter((c) => c.tagName === 'LI');
    expect(items.map((li) => li.firstChild?.textContent)).toEqual(['First', 'Second', 'Third']);
    expect(top.hasAttribute('start')).toBe(false);
    // No other top-level list begins with Second or Third.
    expect(lists.filter((ol) => /^(Second|Third)/.test(text(ol)))).toHaveLength(0);
  });

  it('keeps the nested bullets and the deep ordered list', () => {
    const second = [...dom.querySelectorAll('ol > li')].find((li) =>
      text(li).startsWith('Second'),
    )!;
    const bullets = [...second.querySelectorAll(':scope > ul > li')];
    expect(bullets.map((li) => li.firstChild?.textContent)).toEqual(['Nested bullet', 'Another']);
    expect(text(second.querySelector('ul ol li')!)).toBe('Deep ordered');
  });

  it('has the table with a header row', () => {
    expect([...dom.querySelectorAll('table thead th')].map(text)).toEqual(['Region', 'Q1', 'Q2']);
    expect(dom.querySelectorAll('table tbody tr')).toHaveLength(2);
  });

  it('has the image with its alt text', () => {
    expect(dom.querySelector('img')?.getAttribute('alt')).toBe('Company logo');
    expect(dom.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('keeps the safe link and reduces the javascript: one to plain text', () => {
    expect(dom.querySelector('a[href^="https://example.com"]')).not.toBeNull();
    expect(html).not.toContain('javascript:');
    expect(html).toContain('bad');
    expect([...dom.querySelectorAll('a')].some((a) => text(a) === 'bad')).toBe(false);
  });

  it('renders the footnote', () => {
    expect(dom.querySelector('sup.mc-docx-noteref a')).not.toBeNull();
    expect(text(dom.querySelector('.mc-docx-notes')!)).toContain('A footnote.');
  });

  it('shows script text as text, never as markup', () => {
    expect(html).not.toContain('<script');
  });
});
