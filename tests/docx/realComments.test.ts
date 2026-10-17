// A document with comments written by a real tool.
//
// tests/fixtures/docx/comments.md is the source and comments.docx is pandoc's
// output for it, built with pandoc's comment spans, so the comments.xml and the
// range anchoring are what a real writer produces rather than hand-written XML.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDocxHtml } from '../../src/docx/read';

const dir = resolve(__dirname, '..', 'fixtures', 'docx');

describe('real document with comments: comments.docx', () => {
  const html = renderDocxHtml(new Uint8Array(readFileSync(resolve(dir, 'comments.docx')))).html;
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const marked = (id: string): string[] =>
    [...dom.querySelectorAll(`mark[data-mc-comment="${id}"]`)].map((m) => text(m));

  it('marks each commented range', () => {
    expect(marked('0')).toEqual(['launch date']);
    expect(marked('1')).toEqual(['budget covers two quarters of work']);
    expect(dom.querySelector('mark[data-mc-comment="1"] em')?.textContent).toBe('work');
  });

  it('marks the part in each paragraph of a range that crosses paragraphs', () => {
    expect(marked('2')).toEqual([
      'A paragraph that the comment reaches across.',
      'It ends in the second paragraph',
    ]);
  });

  it('lists the comments with author and date, in the order they appear', () => {
    const items = [...dom.querySelectorAll('section.mc-docx-comments > ol > li')];
    expect(items.map(text)).toEqual([
      expect.stringMatching(/^Ann Author 2026-10-16s*Is this date firm\?/),
      expect.stringMatching(/^Bob Reviewer 2026-10-17s*Check the number\./),
      expect.stringMatching(/^Ann Author 2026-10-18s*Spans two paragraphs\./),
    ]);
    expect(dom.querySelector('section.mc-docx-comments')?.hasAttribute('data-mc-ignore')).toBe(
      true,
    );
  });

  it('keeps the body text whole around the markers', () => {
    const paragraphs = [...dom.querySelectorAll('.mc-docx > p')].map((p) => {
      const clone = p.cloneNode(true) as Element;
      clone.querySelectorAll('[data-mc-ignore]').forEach((n) => n.remove());
      return text(clone);
    });
    expect(paragraphs[0]).toBe(
      'The launch date is fixed, and the budget covers two quarters of work.',
    );
  });
});
