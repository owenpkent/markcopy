import { describe, it, expect } from 'vitest';
import { createMarkdownIt, escapeHtml, escapeAttr } from '../src/render';

describe('createMarkdownIt', () => {
  const md = createMarkdownIt();

  it('tags top-level blocks with data-source-line', () => {
    const html = md.render('# Title\n\nA paragraph.\n');
    expect(html).toContain('data-source-line="0"');
    expect(html).toContain('data-source-line="2"');
  });

  it('turns a mermaid fence into a placeholder, not a code block', () => {
    const html = md.render('```mermaid\nflowchart LR\n  A --> B\n```\n');
    expect(html).toContain('class="mermaid-src"');
    expect(html).toContain('flowchart LR');
  });

  it('highlights a fenced code block with highlight.js', () => {
    const html = md.render('```ts\nconst x = 1;\n```\n');
    expect(html).toContain('class="hljs"');
    expect(html).toContain('data-lang="ts"');
  });

  it('renders GFM tables', () => {
    const html = md.render('| A | B |\n| - | - |\n| 1 | 2 |\n');
    // The table is a top-level block, so it carries a source-line attribute.
    expect(html).toContain('<table data-source-line="0"');
    expect(html).toContain('<th>A</th>');
  });

  it('turns inline $...$ into a non-display math placeholder', () => {
    const html = md.render('Euler: $e^{i\\pi}+1=0$ done.\n');
    expect(html).toContain('<span class="mc-math" data-display="0">');
    expect(html).toContain('e^{i\\pi}+1=0');
    // The webview renders KaTeX client-side; the host only emits the placeholder.
    expect(html).not.toContain('class="katex"');
  });

  it('turns a $$...$$ block into a display math placeholder with a source line', () => {
    const html = md.render('$$\n\\int_0^1 x^2 dx\n$$\n');
    expect(html).toContain('<div class="mc-math" data-display="1"');
    expect(html).toContain('data-source-line="0"');
    expect(html).toContain('\\int_0^1 x^2 dx');
  });

  it('escapes HTML metacharacters inside math', () => {
    const html = md.render('$a < b & c$\n');
    expect(html).toContain('a &lt; b &amp; c');
    expect(html).not.toContain('a < b & c');
  });

  it('leaves dollar signs untouched when math is disabled', () => {
    const off = createMarkdownIt({ math: false });
    const html = off.render('Euler: $e^{i\\pi}+1=0$ done.\n');
    expect(html).not.toContain('mc-math');
    expect(html).toContain('$e^{i\\pi}+1=0$');
  });

  it('routes image src through env.resolveImage when provided', () => {
    const html = md.render('![alt](media/x.png)', {
      resolveImage: (src: string) => `webview:${src}`,
    });
    expect(html).toContain('src="webview:media/x.png"');
  });

  it('leaves image src unchanged when no resolver is supplied', () => {
    const html = md.render('![alt](media/x.png)');
    expect(html).toContain('src="media/x.png"');
  });

  it('autolinks URLs that carry a scheme, and emails', () => {
    expect(md.render('See https://example.com/a for more.\n')).toContain(
      '<a href="https://example.com/a">',
    );
    expect(md.render('Mail bob@example.com today.\n')).toContain(
      '<a href="mailto:bob@example.com">',
    );
  });

  it('leaves schemeless text alone so filenames do not become dead links', () => {
    // linkify-it 6 (markdown-it 15) dropped fuzzy links. `.md`, `.io` and `.ts`
    // are real TLDs, so fuzzy matching used to render a bare filename mention as
    // `http://RELEASING.md` -- a link openExternal would fire at a dead domain.
    for (const src of ['RELEASING.md', 'see README.md first', 'src/render.ts']) {
      expect(md.render(`${src}\n`)).not.toContain('<a href=');
    }
    // Bare hostnames are plain text too; this is the cost of the rule above.
    expect(md.render('Visit github.com today.\n')).not.toContain('<a href=');
    expect(md.render('Visit www.example.com today.\n')).not.toContain('<a href=');
  });

  it('links a schemeless host once the author supplies a scheme', () => {
    // The escape hatch for authors who want the link back. A bare `<www.foo.com>`
    // is NOT one: CommonMark autolinks require a scheme, so it stays literal text.
    expect(md.render('<http://www.example.com>\n')).toContain('<a href="http://www.example.com">');
    expect(md.render('[www.example.com](http://www.example.com)\n')).toContain(
      '<a href="http://www.example.com">',
    );
    expect(md.render('<www.example.com>\n')).toContain('&lt;www.example.com&gt;');
  });
});

describe('escape helpers', () => {
  it('escapeHtml escapes angle brackets and ampersands', () => {
    expect(escapeHtml('<a> & <b>')).toBe('&lt;a&gt; &amp; &lt;b&gt;');
  });

  it('escapeAttr also escapes double quotes', () => {
    expect(escapeAttr('say "hi" <x>')).toBe('say &quot;hi&quot; &lt;x&gt;');
  });
});
