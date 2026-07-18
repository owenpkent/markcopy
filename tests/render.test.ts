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
