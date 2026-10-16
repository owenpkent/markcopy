// The seam between the two halves of Word support.
//
// The writer (src/docx/build.ts) and the reader (src/docx/read/) were built
// separately, and nothing else makes them meet: the writer's tests unzip its
// output and inspect the XML, the reader's feed it hand-built fixtures. What
// that leaves untested is the first thing a user can try: does a document this
// extension writes come back through its own preview with its structure intact.
import { describe, it, expect } from 'vitest';
import { htmlToDocx } from '../src/docxExport';
import { renderDocxHtml } from '../src/docx/read';
import { createMarkdownIt } from '../src/render';

const PNG =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SAMPLE = `# Project Plan

## Overview

Some **bold**, *italic*, and \`inline code\` text with a [link](https://example.com/docs?a=1&b=2).

### Tasks

- Fruit
  - Apple
  - Pear
- Vegetables

1. First
2. Second

| Name  | Role   |
| ----- | ------ |
| Ada   | Author |
| Grace | Editor |

\`\`\`js
const a = 1;
if (a < 2) {
  run();
}
\`\`\`

> A quoted remark.

![A tiny pixel](${PNG})
`;

/** Markdown -> HTML -> the XHTML the webview would serialize -> .docx -> the preview's HTML. */
function roundTrip(markdown: string): string {
  const rendered = createMarkdownIt().render(markdown);
  const doc = new DOMParser().parseFromString(`<div>${rendered}</div>`, 'text/html');
  const xhtml = new XMLSerializer().serializeToString(doc.body.firstElementChild!);
  const written = htmlToDocx(xhtml, { title: 'Round trip', now: new Date('2026-01-01T00:00:00Z') });
  return renderDocxHtml(written.bytes).html;
}

/** Each heading's tag and text, markup stripped. */
function headings(html: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of html.matchAll(/<(h[1-6])[^>]*>(.*?)<\/h[1-6]>/g)) {
    out.push([m[1], m[2].replace(/<[^>]*>/g, '')]);
  }
  return out;
}

describe('docx round trip', () => {
  const out = roundTrip(SAMPLE);

  it('keeps headings at their levels', () => {
    // The writer bookmarks each heading so a link to it can resolve, so the
    // reader puts that bookmark's id on a span at the start of the heading.
    expect(headings(out)).toEqual([
      ['h1', 'Project Plan'],
      ['h2', 'Overview'],
      ['h3', 'Tasks'],
    ]);
  });

  it('keeps inline formatting and links', () => {
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<code>inline code</code>');
    expect(out).toContain('<a href="https://example.com/docs?a=1&amp;b=2">link</a>');
  });

  it('keeps nested bullet and ordered lists as lists', () => {
    expect(out).toContain(
      '<ul><li>Fruit<ul><li>Apple</li><li>Pear</li></ul></li><li>Vegetables</li></ul>',
    );
    expect(out).toContain('<ol><li>First</li><li>Second</li></ol>');
  });

  it('keeps a table with its header row', () => {
    expect(out).toContain(
      '<thead><tr><th scope="col">Name</th><th scope="col">Role</th></tr></thead>',
    );
    expect(out).toContain('<tr><td>Ada</td><td>Author</td></tr>');
    expect(out).toContain('<tr><td>Grace</td><td>Editor</td></tr>');
  });

  it('keeps a code block as a code block', () => {
    expect(out).toContain('<pre><code>const a = 1;\nif (a &lt; 2) {\n  run();\n}</code></pre>');
  });

  it('keeps a block quote', () => {
    expect(out).toContain('<blockquote><p>A quoted remark.</p></blockquote>');
  });

  it('keeps an image with its alt text', () => {
    expect(out).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="A tiny pixel"/);
  });

  it('is stable: reading what it wrote back out and in again changes nothing structural', () => {
    expect(roundTrip(SAMPLE)).toBe(out);
  });
});
