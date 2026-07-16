import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/webview/markdownConvert';

describe('htmlToMarkdown', () => {
  it('converts bold and inline links', () => {
    expect(
      htmlToMarkdown('text with <strong>bold</strong> and <a href="https://x.io">link</a>'),
    ).toBe('text with **bold** and [link](https://x.io)');
  });

  it('uses ATX-style headings', () => {
    expect(htmlToMarkdown('<h2>Notes</h2>')).toBe('## Notes');
  });

  it('converts a GFM table', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect(md).toContain('| A | B |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('uses dash bullets for lists', () => {
    const md = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>');
    expect(md).toMatch(/-\s+one/);
    expect(md).toMatch(/-\s+two/);
  });
});
