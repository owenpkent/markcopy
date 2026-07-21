import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/webview/markdownConvert';

describe('htmlToMarkdown', () => {
  it('converts bold and inline links', async () => {
    expect(
      await htmlToMarkdown('text with <strong>bold</strong> and <a href="https://x.io">link</a>'),
    ).toBe('text with **bold** and [link](https://x.io)');
  });

  it('uses ATX-style headings', async () => {
    expect(await htmlToMarkdown('<h2>Notes</h2>')).toBe('## Notes');
  });

  it('restores inline LaTeX from a rendered KaTeX element', async () => {
    const md = await htmlToMarkdown(
      'sum <span class="mc-math" data-display="0" data-tex="a^2+b^2"><span class="katex">x</span></span> here',
    );
    expect(md).toBe('sum $a^2+b^2$ here');
  });

  it('restores display LaTeX as a $$ block', async () => {
    const md = await htmlToMarkdown(
      '<div class="mc-math" data-display="1" data-tex="\\int_0^1 x^2 dx"><span class="katex">x</span></div>',
    );
    expect(md).toContain('$$\n\\int_0^1 x^2 dx\n$$');
  });

  it('converts a GFM table', async () => {
    const md = await htmlToMarkdown(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect(md).toContain('| A | B |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('uses dash bullets for lists', async () => {
    const md = await htmlToMarkdown('<ul><li>one</li><li>two</li></ul>');
    expect(md).toMatch(/-\s+one/);
    expect(md).toMatch(/-\s+two/);
  });
});
