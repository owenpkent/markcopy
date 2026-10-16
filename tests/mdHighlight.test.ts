import { describe, it, expect } from 'vitest';
import { highlightMarkdown } from '../src/webview/mdHighlight';

// Strip tags and decode the five entities the highlighter emits.
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('highlightMarkdown', () => {
  const samples = [
    '# Heading with **bold** and `code`',
    '> quote with [a link](http://x.test/?a=1&b=2)',
    '- item ~~gone~~ and *em* and __bold__',
    '1. first\n2) second\n- [x] task',
    '```ts\nconst a = "<b>" && 1;\n```',
    '![img](a.png) <script>alert(1)</script>',
    'plain **unclosed and _also',
    '',
    '---',
  ];

  it('keeps the text identical, plus one trailing newline guard', () => {
    for (const sample of samples) {
      expect(textOf(highlightMarkdown(sample))).toBe(sample + '\n');
    }
  });

  it('escapes HTML so source markup stays text', () => {
    const html = highlightMarkdown('<script>alert(1)</script> & "q" \'s\'');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
  });

  it('keeps a script tag inside a link text or url as text', () => {
    const html = highlightMarkdown('[<script>x</script>](<img onerror=1>)');
    expect(html).not.toMatch(/<(script|img)/);
  });

  it('dims syntax markers', () => {
    const dim = (s: string) => `<span class="mc-hl-dim">${s}</span>`;
    expect(highlightMarkdown('**b**')).toContain(
      dim('**') + '<span class="mc-hl-bold">b</span>' + dim('**'),
    );
    expect(highlightMarkdown('# T')).toContain(dim('#'));
    expect(highlightMarkdown('> q')).toContain(dim('&gt; '));
    expect(highlightMarkdown('- item')).toContain(dim('-'));
    expect(highlightMarkdown('1. item')).toContain(dim('1.'));
    expect(highlightMarkdown('`c`')).toContain(dim('`') + 'c' + dim('`'));
    expect(highlightMarkdown('~~s~~')).toContain(dim('~~'));
    expect(highlightMarkdown('[t](u)')).toContain(dim('[') + 't' + dim(']('));
    expect(highlightMarkdown('[t](u)')).toContain('<span class="mc-hl-url">u</span>');
  });

  it('never uses font-weight or italics markup', () => {
    const html = highlightMarkdown('**b** *i* _i_');
    expect(html).not.toMatch(/font-weight|font-style|<b>|<i>|<em>|<strong>/);
  });

  it('does not highlight inside a fenced block', () => {
    const html = highlightMarkdown('```\n# not a heading **x**\n```');
    expect(html).not.toContain('mc-hl-bold');
    expect(html).toContain('# not a heading **x**');
  });
});
