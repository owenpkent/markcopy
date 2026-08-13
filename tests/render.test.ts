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

  it('autolinks schemeless URLs and emails', () => {
    const html = md.render('See www.example.com, example.com, and mail@example.com.\n');
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(html).toContain('<a href="http://example.com">example.com</a>');
    expect(html).toContain('<a href="mailto:mail@example.com">mail@example.com</a>');
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
});

describe('escape helpers', () => {
  it('escapeHtml escapes angle brackets and ampersands', () => {
    expect(escapeHtml('<a> & <b>')).toBe('&lt;a&gt; &amp; &lt;b&gt;');
  });

  it('escapeAttr also escapes double quotes', () => {
    expect(escapeAttr('say "hi" <x>')).toBe('say &quot;hi&quot; &lt;x&gt;');
  });
});
