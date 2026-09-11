import { describe, it, expect } from 'vitest';
import { createMarkdownIt } from '../src/render';
import { escapeAttr, escapeHtml } from '../src/escape';

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

  it('renders footnote references and their definitions', () => {
    const html = md.render(
      'Switch access is system-wide.[^apple][^android]\n\n' +
        '[^apple]: Apple Switch Control.\n' +
        '[^android]: Android Switch Access.\n',
    );

    expect(html).toContain('<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>');
    expect(html).toContain('<sup class="footnote-ref"><a href="#fn2" id="fnref2">[2]</a></sup>');
    // The section and each definition carry the source line they came from
    // (lines 2 and 3), so the webview's block copy, scroll-sync anchors, and
    // context menu all reach inside the footnotes section like they do
    // everywhere else in the document. See addFootnotes in src/render.ts.
    expect(html).toContain('<section class="footnotes" data-source-line="2">');
    expect(html).toContain('<li id="fn1" class="footnote-item" data-source-line="2">');
    expect(html).toContain('<li id="fn2" class="footnote-item" data-source-line="3">');
    expect(html).toContain('Apple Switch Control.');
    expect(html).toContain('Android Switch Access.');
    expect(html).toContain('<a href="#fnref1" class="footnote-backref">');
    expect(html).not.toContain('[^apple]');
    expect(html).not.toContain('[^android]');
  });

  it('keeps a repeated reference numbered like GitHub, not sub-indexed', () => {
    // The plugin's own default renders `[1]` then `[1:1]` for a second use of
    // the same label; footnote_caption is overridden to always show just the
    // number, matching what GitHub renders for the same Markdown.
    const html = md.render('Para A[^x] and again[^x].\n\n[^x]: Shared note.\n');
    expect(html).toContain('<a href="#fn1" id="fnref1">[1]</a>');
    expect(html).toContain('<a href="#fn1" id="fnref1:1">[1]</a>');
    expect(html).not.toContain('[1:1]');
    // The two backref anchors still have to stay distinct, or the second one
    // has nowhere of its own to point back to.
    expect(html).toContain('id="fnref1"');
    expect(html).toContain('id="fnref1:1"');
  });

  it('leaves an unreferenced footnote definition in place as ordinary text', () => {
    // Before this plugin, `[^orphan]: ...` was not special syntax at all and
    // rendered as a plain paragraph. footnote_tail (markdown-it-footnote's own
    // core rule) silently drops a definition that nothing ever references,
    // which in a live preview reads as the author's text vanishing off the
    // page for no visible reason. footnoteFixups re-parses it as if the
    // footnote plugin were not there, prefix and all, instead.
    const html = md.render('[^orphan]: This text has no reference.\n');
    // Still a top-level paragraph, so it carries data-source-line like any
    // other (addSourceLineMapping), rather than the level-1 wrapper the
    // footnote plugin would otherwise have left it nested inside.
    expect(html).toContain('<p data-source-line="0">[^orphan]: This text has no reference.</p>');
    expect(html).not.toContain('footnote');
  });

  it('keeps an unreferenced definition inline while a referenced one still moves to the footnotes section', () => {
    const html = md.render(
      'See the note.[^a]\n\n[^a]: Referenced note.\n\n[^b]: Never referenced.\n',
    );
    // [^a] is used, so it becomes a real footnote reference and definition.
    expect(html).toContain('<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>');
    expect(html).toContain('<section class="footnotes"');
    expect(html).toContain('Referenced note.');
    // [^b] is not, so its line stays a plain paragraph in place, exactly where
    // it sits in the source, rather than disappearing.
    expect(html).toContain('<p data-source-line="4">[^b]: Never referenced.</p>');
    expect(html).not.toContain('[^a]:');
  });

  it('leaves ^[...] inline footnote shorthand as literal text', () => {
    // markdown-it-footnote's `^[...]` inline syntax is not documented anywhere
    // in this repo (only [^note] is) and `^[` shows up constantly in prose
    // about regular expressions, so it is deliberately disabled.
    const html = md.render('The pattern ^[A-Z]+ matches capitals.\n');
    expect(html).toContain('^[A-Z]+ matches capitals.');
    expect(html).not.toContain('footnote');
  });

  it('disables the whole footnote feature when markcopy.footnotes is off', () => {
    const off = createMarkdownIt({ footnotes: false });
    const html = off.render('Body.[^note]\n\n[^note]: Definition text.\n');
    expect(html).toContain('[^note]');
    expect(html).not.toContain('footnote');
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
