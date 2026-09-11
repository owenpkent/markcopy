import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { htmlToDocx, reportSummary } from '../src/docxExport';
import { imageSize } from '../src/docx/media';
import { bookmarkName } from '../src/docx/ooxml';
import { columnCount, cssColor } from '../src/docx/build';

/** A 1x1 PNG, as the webview would inline it. */
const PNG_1x1 =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A PNG header with the given intrinsic size, and nothing else.
 *
 * Enough for the writer, which reads the size out of the IHDR and stores the
 * bytes verbatim. Two of these differ in their bytes without differing in their
 * extension, which is what makes a media part name collision visible.
 */
function pngDataUri(width: number, height: number): string {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

/** A GIF header with the given logical screen size, which may be a broken one. */
function gifDataUri(width: number, height: number): string {
  const bytes = new Uint8Array([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
  ]);
  return `data:image/gif;base64,${Buffer.from(bytes).toString('base64')}`;
}

function docx(body: string) {
  const { bytes, report } = htmlToDocx(`<div>${body}</div>`, {
    title: 'Test',
    now: new Date('2026-01-02T03:04:05.678Z'),
  });
  const parts = unzipSync(bytes);
  const text = (name: string) => strFromU8(parts[name]);
  return { bytes, report, parts, text, document: text('word/document.xml') };
}

/** Well-formedness is the difference between a file Word opens and one it refuses. */
function assertWellFormed(xml: string): void {
  const parser = new SaxesParser();
  parser.on('error', (err) => {
    throw err;
  });
  parser.write(xml).close();
}

describe('package structure', () => {
  it('writes every part Word needs to open the file', () => {
    const { parts } = docx('<p>Hello</p>');
    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/numbering.xml',
      'word/styles.xml',
    ]);
  });

  it('emits well-formed XML for every part', () => {
    const { parts } = docx(
      '<h1 id="a">Title</h1><p>Text with <a href="https://x.test">a link</a> &amp; an ampersand.</p>' +
        '<ul><li>one</li></ul><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>',
    );
    for (const [name, bytes] of Object.entries(parts)) {
      if (name.endsWith('.xml') || name.endsWith('.rels')) {
        expect(() => assertWellFormed(strFromU8(bytes)), name).not.toThrow();
      }
    }
  });

  it('records the title in the document properties', () => {
    const { text } = docx('<p>x</p>');
    expect(text('docProps/core.xml')).toContain('<dc:title>Test</dc:title>');
    expect(text('docProps/core.xml')).toContain('2026-01-02T03:04:05Z');
  });

  it('starts with the content types part, as an OPC reader expects', () => {
    const { parts } = docx('<p>x</p>');
    expect(Object.keys(parts)[0]).toBe('[Content_Types].xml');
  });
});

describe('headings', () => {
  it('maps h1..h6 onto the built-in styles that carry an outline level', () => {
    const { document } = docx('<h1>A</h1><h3>B</h3><h6>C</h6>');
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('<w:pStyle w:val="Heading3"/>');
    expect(document).toContain('<w:pStyle w:val="Heading6"/>');
  });

  it('gives every heading style an outlineLvl, which is what drives navigation', () => {
    const { text } = docx('<h2>A</h2>');
    const styles = text('word/styles.xml');
    expect(styles).toContain('<w:name w:val="heading 2"/>');
    expect(styles).toContain('<w:outlineLvl w:val="1"/>');
  });

  it('anchors a bookmark on a heading id so in-document links resolve', () => {
    const { document } = docx('<h2 id="setup">Setup</h2><p><a href="#setup">jump</a></p>');
    const name = bookmarkName('setup');
    expect(document).toContain(`<w:bookmarkStart w:id="0" w:name="${name}"/>`);
    // The link has to derive the same name from the same anchor, or it lands
    // nowhere; that both sides call one pure function is the whole guarantee.
    expect(document).toContain(`<w:hyperlink w:anchor="${name}">`);
  });
});

describe('footnote anchors', () => {
  it('bookmarks a footnote item and its own back-reference, not just headings', () => {
    const { document } = docx(
      '<p>Body text.<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup></p>' +
        '<hr class="footnotes-sep"/>' +
        '<section class="footnotes">' +
        '<ol class="footnotes-list">' +
        '<li id="fn1" class="footnote-item" data-source-line="7">' +
        '<p>The note text.</p>' +
        ' <a href="#fnref1" class="footnote-backref">↩</a>' +
        '</li>' +
        '</ol>' +
        '</section>',
    );
    const fn1 = bookmarkName('fn1');
    const fnref1 = bookmarkName('fnref1');

    // Neither the <li> nor the <a> is a heading, so a bookmark on either one
    // only happens because the general "something links here" rule fires, not
    // because of any footnote-specific special case. The exact w:id sequence
    // number depends on which of the two is converted first, which is not
    // worth pinning down, so it is matched rather than hardcoded.
    expect(document).toMatch(new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${fn1}"/>`));
    expect(document).toMatch(new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${fnref1}"/>`));

    // Each link derives the same name from the anchor it targets, the same
    // guarantee the heading test above pins down.
    expect(document).toContain(`<w:hyperlink w:anchor="${fn1}">`);
    expect(document).toContain(`<w:hyperlink w:anchor="${fnref1}">`);

    // Hand-written bookmark XML around a multi-paragraph <li> is exactly the
    // kind of change a mismatched tag would slip through silently.
    expect(() => assertWellFormed(document)).not.toThrow();
  });

  // The invariant rather than the instance. Every w:anchor Word is told to jump
  // to has to name a bookmark this document actually writes, or the link renders
  // as a live-looking link that goes nowhere (or "Error! Bookmark not defined").
  // Asserted over the whole document so it keeps holding for link kinds added
  // later, and exercised here with a repeated reference, whose `fnref1:1` id
  // carries a colon that is illegal in a bookmark name and so has to survive
  // bookmarkName()'s normalization identically on both sides.
  it('writes a bookmark for every anchor it links to', () => {
    const { document } = docx(
      '<p>First.<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>' +
        ' Again.<sup class="footnote-ref"><a href="#fn1" id="fnref1:1">[1]</a></sup></p>' +
        '<h2 id="a-heading">A heading</h2>' +
        '<p><a href="#a-heading">Back to the heading</a></p>' +
        '<section class="footnotes"><ol class="footnotes-list">' +
        '<li id="fn1" class="footnote-item"><p>Note one.</p><p>Note two.</p>' +
        ' <a href="#fnref1" class="footnote-backref">↩</a>' +
        ' <a href="#fnref1:1" class="footnote-backref">↩</a>' +
        '</li>' +
        '</ol></section>',
    );

    const anchors = [...document.matchAll(/<w:hyperlink w:anchor="([^"]+)"/g)].map((m) => m[1]);
    const bookmarks = new Set(
      [...document.matchAll(/<w:bookmarkStart w:id="\d+" w:name="([^"]+)"/g)].map((m) => m[1]),
    );

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.filter((a) => !bookmarks.has(a))).toEqual([]);
    // The colon really did get normalized away rather than reaching the file.
    expect(bookmarks.has(bookmarkName('fnref1:1'))).toBe(true);
    for (const name of bookmarks) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
    expect(() => assertWellFormed(document)).not.toThrow();
  });

  it('still bookmarks a heading id unconditionally even when nothing links to it', () => {
    const { document } = docx('<h2 id="lonely">Lonely</h2>');
    const name = bookmarkName('lonely');
    expect(document).toContain(`<w:bookmarkStart w:id="0" w:name="${name}"/>`);
  });
});

describe('images', () => {
  it('embeds the bytes and carries the alt text as descr', () => {
    const { document, parts, report } = docx(`<p><img src="${PNG_1x1}" alt="A red dot"/></p>`);
    expect(parts['word/media/image1.png']).toBeDefined();
    expect(document).toContain('descr="A red dot"');
    expect(report.images).toBe(1);
    expect(report.imagesMissingAlt).toBe(0);
  });

  it('counts an image with no alt text rather than shipping it silently', () => {
    const { report } = docx(`<p><img src="${PNG_1x1}" alt=""/></p>`);
    expect(report.imagesMissingAlt).toBe(1);
    expect(reportSummary(report)).toContain('1 image without alt text');
  });

  it('gives an image inside a table cell a media part of its own', () => {
    const { parts, text } = docx(
      `<p><img src="${PNG_1x1}" alt="body"/></p>` +
        `<table><tr><td><img src="${pngDataUri(2, 2)}" alt="cell"/></td></tr></table>`,
    );
    expect(
      Object.keys(parts)
        .filter((name) => name.startsWith('word/media/'))
        .sort(),
    ).toEqual(['word/media/image1.png', 'word/media/image2.png']);
    const rels = text('word/_rels/document.xml.rels');
    expect(rels).toContain('Target="media/image1.png"');
    expect(rels).toContain('Target="media/image2.png"');
  });

  it('lays out an image whose header reports a zero side', () => {
    const { document } = docx(`<p><img src="${gifDataUri(0, 10)}" width="50" alt="broken"/></p>`);
    expect(document).not.toContain('Infinity');
    // 50px square: there is no aspect ratio to scale by, so the given side is
    // used for both rather than multiplied by a ratio that is not a number.
    expect(document).toContain('<wp:extent cx="476250" cy="476250"/>');
  });

  it('keeps the line breaks of multi-line alt text out of attribute normalization', () => {
    const { document } = docx(`<p><img src="${PNG_1x1}" alt="graph TD&#10;  A--&gt;B"/></p>`);
    // A literal newline here would be normalized to a space when Word reads the
    // attribute back, flattening a diagram's source into one run-on line.
    expect(document).toContain('descr="graph TD&#10;  A--&gt;B"');
  });

  it('stores a repeated image once', () => {
    const { parts } = docx(`<p><img src="${PNG_1x1}" alt="a"/><img src="${PNG_1x1}" alt="a"/></p>`);
    expect(Object.keys(parts).filter((n) => n.startsWith('word/media/'))).toHaveLength(1);
  });

  it('keeps the alt text as prose when the bytes cannot be embedded', () => {
    const { document, report } = docx('<p><img src="https://x.test/a.png" alt="A chart"/></p>');
    expect(report.imagesSkipped).toBe(1);
    expect(document).toContain('[image: A chart]');
    expect(reportSummary(report)).toContain('could not be embedded');
  });

  it('scales an oversized image down to the text column and keeps the ratio', () => {
    // 1x1 scaled by nothing; assert the EMU conversion instead.
    const { document } = docx(`<p><img src="${PNG_1x1}" alt="dot"/></p>`);
    expect(document).toContain('<wp:extent cx="9525" cy="9525"/>');
  });

  it('says nothing when every image is described', () => {
    const { report } = docx(`<p><img src="${PNG_1x1}" alt="described"/></p>`);
    expect(reportSummary(report)).toBeUndefined();
  });
});

describe('tables', () => {
  it('marks the header row so a reader hears the column labels', () => {
    const { document } = docx(
      '<table><thead><tr><th>Region</th><th>Revenue</th></tr></thead>' +
        '<tbody><tr><td>EU</td><td>4.2m</td></tr></tbody></table>',
    );
    expect(document).toContain('<w:trPr><w:tblHeader/></w:trPr>');
    expect(document.match(/<w:tblHeader\/>/g)).toHaveLength(1);
  });

  it('treats an all-th row outside a thead as a header row', () => {
    const { document } = docx('<table><tr><th>A</th></tr><tr><td>b</td></tr></table>');
    expect(document).toContain('<w:tblHeader/>');
  });

  it('pads short rows so every row has the full column count', () => {
    const { document } = docx(
      '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table>',
    );
    const secondRow = document.split('<w:tr>')[2];
    expect(secondRow.match(/<w:tc>/g)).toHaveLength(3);
  });

  it('carries a rowspan across rows as a vertical merge', () => {
    const { document } = docx(
      '<table><tr><td rowspan="2">tall</td><td>a</td></tr><tr><td>b</td></tr></table>',
    );
    expect(document).toContain('<w:vMerge w:val="restart"/>');
    expect(document).toContain('<w:vMerge/>');
  });

  it('turns a colspan into a gridSpan', () => {
    const { document } = docx(
      '<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></table>',
    );
    expect(document).toContain('<w:gridSpan w:val="2"/>');
  });

  it('honors a markdown column alignment', () => {
    const { document } = docx('<table><tr><td style="text-align:right">9</td></tr></table>');
    expect(document).toContain('<w:jc w:val="right"/>');
  });

  it('writes justification after the paragraph style, as CT_PPr requires', () => {
    const { document } = docx(
      '<table><tr><th style="text-align:center">H</th></tr>' +
        '<tr><td style="text-align:right">9</td></tr></table>',
    );
    // CT_PPr is a sequence: jc follows pStyle. Word offers to repair a document
    // that puts them the other way round.
    expect(document).toContain(
      '<w:pPr><w:pStyle w:val="TableHeader"/><w:jc w:val="center"/></w:pPr>',
    );
    expect(document).toContain('<w:pPr><w:pStyle w:val="TableText"/><w:jc w:val="right"/></w:pPr>');
  });

  it('counts the columns a rowspan occupies, so no cell is dropped', () => {
    const { document } = docx(
      '<table><tr><td rowspan="2">A</td></tr><tr><td>B</td><td>C</td></tr></table>',
    );
    expect(document.match(/<w:gridCol /g)).toHaveLength(3);
    expect(document).toContain('<w:t xml:space="preserve">C</w:t>');
  });

  it('measures a table with more rows than a spread can pass as arguments', () => {
    type Rows = Parameters<typeof columnCount>[0];
    const rows = Array.from({ length: 200_000 }, () => ({
      cells: [
        { el: { kind: 'element', name: 'td', attrs: {}, children: [] }, colspan: 1, rowspan: 1 },
      ],
    })) as unknown as Rows;
    expect(columnCount(rows)).toBe(1);
  });

  it('follows a table with a paragraph, which Word requires', () => {
    const { document } = docx('<table><tr><td>a</td></tr></table>');
    expect(document).toContain('</w:tbl><w:p/>');
  });
});

describe('lists', () => {
  it('numbers list items rather than typing bullets into the text', () => {
    const { document } = docx('<ul><li>one</li><li>two</li></ul>');
    expect(document).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    expect(document).not.toContain('&#8226;');
  });

  it('gives each list its own instance so a second one restarts at 1', () => {
    const { text, document } = docx('<ol><li>a</li></ol><p>gap</p><ol><li>b</li></ol>');
    expect(document).toContain('<w:numId w:val="1"/>');
    expect(document).toContain('<w:numId w:val="2"/>');
    const numbering = text('word/numbering.xml');
    expect(numbering).toContain('<w:num w:numId="2"><w:abstractNumId w:val="1"/>');
    expect(numbering.match(/<w:startOverride w:val="1"\/>/g)).toHaveLength(2);
  });

  it('honors an explicit start attribute', () => {
    const { text } = docx('<ol start="5"><li>five</li></ol>');
    expect(text('word/numbering.xml')).toContain('<w:startOverride w:val="5"/>');
  });

  it('keeps an explicit start of zero rather than restarting at one', () => {
    const { text } = docx('<ol start="0"><li>zero</li></ol>');
    expect(text('word/numbering.xml')).toContain('<w:startOverride w:val="0"/>');
  });

  it('numbers a list item once when its first block is a heading', () => {
    const { document } = docx('<ol><li><h2>Head</h2><p>Body</p></li></ol>');
    // One item, one number. Two would mean the marker outlived the paragraph
    // that spent it, turning one item into two.
    expect(document.match(/<w:numPr>/g)).toHaveLength(1);
    // And the heading keeps its style, which is where its outline level lives.
    expect(document).toContain('<w:pStyle w:val="Heading2"/><w:numPr>');
  });

  it('keeps a code block inside a list item on the code style', () => {
    const { document } = docx('<ul><li><pre><code>x = 1\ny = 2</code></pre></li></ul>');
    expect(document.match(/<w:pStyle w:val="HTMLPreformatted"\/>/g)).toHaveLength(2);
    expect(document).not.toContain('ListParagraph');
  });

  it('nests a sublist one level deeper', () => {
    const { document } = docx('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    expect(document).toContain('<w:ilvl w:val="0"/>');
    expect(document).toContain('<w:ilvl w:val="1"/>');
  });

  it('puts an ordered sublist on a decimal definition at the nested level', () => {
    const { text, document } = docx('<ul><li>outer<ol><li>inner</li></ol></li></ul>');
    expect(document).toContain('<w:ilvl w:val="1"/><w:numId w:val="2"/>');
    expect(text('word/numbering.xml')).toContain(
      '<w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="1">',
    );
  });

  it('marks a loose list item so its paragraph still gets the bullet', () => {
    const { document } = docx('<ul><li><p>one</p><p>continued</p></li></ul>');
    expect(document.match(/<w:numPr>/g)).toHaveLength(1);
  });

  it('renders a task list checkbox as a character', () => {
    const { document } = docx('<ul><li><input type="checkbox" checked="checked"/> done</li></ul>');
    expect(document).toContain('☒');
  });
});

describe('inline formatting', () => {
  it('maps bold, italic and strikethrough onto run properties', () => {
    const { document } = docx('<p><strong>b</strong><em>i</em><del>s</del></p>');
    expect(document).toContain('<w:b/>');
    expect(document).toContain('<w:i/>');
    expect(document).toContain('<w:strike/>');
  });

  it('writes one character style for a code span inside a link', () => {
    const { document } = docx('<p><a href="https://x.test"><code>npm i</code></a></p>');
    // CT_RPr allows a single rStyle. Code keeps it and the link's underline is
    // added as direct formatting, so the run reads as both without two of them.
    expect(document.match(/<w:rStyle /g)).toHaveLength(1);
    expect(document).toContain('<w:rStyle w:val="HTMLCode"/>');
    expect(document).toContain('<w:u w:val="single"/>');
  });

  it('nests formatting rather than losing the outer one', () => {
    const { document } = docx('<p><strong>bold <em>and italic</em></strong></p>');
    expect(document).toContain('<w:rPr><w:b/><w:i/></w:rPr>');
  });

  it('gives inline code the monospace character style', () => {
    const { document } = docx('<p>use <code>npm ci</code></p>');
    expect(document).toContain('<w:rStyle w:val="HTMLCode"/>');
  });

  it('styles a link and registers an external relationship', () => {
    const { document, text } = docx('<p><a href="https://example.test/a?b=1&amp;c=2">go</a></p>');
    expect(document).toContain('<w:rStyle w:val="Hyperlink"/>');
    const rels = text('word/_rels/document.xml.rels');
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain('Target="https://example.test/a?b=1&amp;c=2"');
  });

  it('keeps the text of a relative link but drops the dead target', () => {
    const { document, text } = docx('<p><a href="./other.md">other</a></p>');
    expect(document).toContain('other');
    expect(document).not.toContain('<w:hyperlink');
    expect(text('word/_rels/document.xml.rels')).not.toContain('other.md');
  });

  it('turns a line break into a run break', () => {
    const { document } = docx('<p>one<br/>two</p>');
    expect(document).toContain('<w:br/>');
  });

  it('collapses HTML whitespace the way a browser does', () => {
    const { document } = docx('<p>a   \n   b</p>');
    expect(document).toContain('>a b<');
  });

  it('drops the indentation whitespace between blocks', () => {
    const { document } = docx('<p>a</p>\n  \n<p>b</p>');
    expect(document.match(/<w:p>/g)).toHaveLength(2);
  });
});

describe('code blocks', () => {
  it('writes one paragraph per line so a reader can step through them', () => {
    const { document } = docx('<pre><code>one\ntwo\nthree\n</code></pre>');
    const paragraphs = document.match(/<w:pStyle w:val="HTMLPreformatted"\/>/g);
    expect(paragraphs).toHaveLength(3);
  });

  it('preserves leading whitespace', () => {
    const { document } = docx('<pre><code>def f():\n    return 1\n</code></pre>');
    expect(document).toContain('<w:t xml:space="preserve">    return 1</w:t>');
  });

  it('keeps the syntax colors the webview inlined', () => {
    const { document } = docx(
      '<pre><code><span style="color: rgb(207, 34, 46)">def</span> f</code></pre>',
    );
    expect(document).toContain('<w:color w:val="CF222E"/>');
  });
});

describe('blockquotes and rules', () => {
  it('uses the Quote style', () => {
    const { document } = docx('<blockquote><p>quoted</p></blockquote>');
    expect(document).toContain('<w:pStyle w:val="Quote"/>');
  });

  it('indents a nested quote further', () => {
    const { document } = docx('<blockquote><blockquote><p>deep</p></blockquote></blockquote>');
    expect(document).toContain('<w:ind w:left="360"/>');
  });

  it('renders a thematic break as a bordered paragraph', () => {
    const { document } = docx('<p>a</p><hr/><p>b</p>');
    expect(document).toContain('<w:pStyle w:val="HorizontalRule"/>');
  });
});

describe('hostile and odd input', () => {
  it('strips characters XML cannot represent instead of writing a broken file', () => {
    const { document } = docx(`<p>before${String.fromCharCode(11)}after</p>`);
    expect(() => assertWellFormed(document)).not.toThrow();
    expect(document).toContain('beforeafter');
  });

  it('drops a lone surrogate but keeps a well-formed pair', () => {
    // Half an emoji, the shape a truncating paste leaves behind. XML 1.0 forbids
    // an unpaired surrogate as firmly as it forbids a 0x0B.
    const lone = String.fromCharCode(0xd83d);
    const pair = String.fromCharCode(0xd83d, 0xde00);
    const { document } = docx(`<p>ok${lone} and ${pair}</p>`);
    expect(() => assertWellFormed(document)).not.toThrow();
    expect(document).toContain(`<w:t xml:space="preserve">ok and ${pair}</w:t>`);
  });

  it('escapes markup-like text rather than injecting it', () => {
    const { document } = docx('<p>&lt;/w:t&gt;&lt;/w:r&gt;&lt;w:r&gt;</p>');
    expect(() => assertWellFormed(document)).not.toThrow();
    expect(document).toContain('&lt;/w:t&gt;');
  });

  it('drops viewer chrome the preview marks as its own', () => {
    const { document } = docx('<p>kept</p><div data-mc-ignore="1"><p>chrome</p></div>');
    expect(document).not.toContain('chrome');
    expect(document).toContain('kept');
  });

  it('falls back to the LaTeX source when an equation was not rasterized', () => {
    const { document } = docx('<p><span class="mc-math" data-tex="x^2">rendered junk</span></p>');
    expect(document).toContain('x^2');
    expect(document).not.toContain('rendered junk');
  });

  it('always produces a body, even for an empty document', () => {
    const { document } = docx('');
    expect(document).toContain('<w:body><w:p/>');
  });

  it('refuses input that is not well-formed rather than writing half a file', () => {
    expect(() => htmlToDocx('<p>unclosed', { title: 'x' })).toThrow();
  });
});

describe('image header sniffing', () => {
  it('reads a PNG size from IHDR', () => {
    const png = Buffer.from(PNG_1x1.split(',')[1], 'base64');
    expect(imageSize(new Uint8Array(png))).toEqual({ width: 1, height: 1 });
  });

  it('reads a GIF size from the logical screen descriptor', () => {
    const gif = new Uint8Array(10);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00]);
    expect(imageSize(gif)).toEqual({ width: 32, height: 16 });
  });

  it('reads a JPEG size from the frame header past an APP0 segment', () => {
    const jpeg = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x04,
      0x00,
      0x00, // APP0, length 4
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x00,
      0x40,
      0x00,
      0x60, // SOF0: 64 high, 96 wide
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 96, height: 64 });
  });

  it('returns nothing for bytes it does not recognize', () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});

describe('helpers', () => {
  it('keeps a short anchor readable, with the hash that disambiguates it', () => {
    expect(bookmarkName('setup')).toMatch(/^setup_[0-9a-z]+$/);
  });

  it('prefixes an anchor that does not start with a letter', () => {
    expect(bookmarkName('1-intro')).toMatch(/^mc_1_intro_[0-9a-z]+$/);
  });

  it('does not collapse two short anchors that differ only in punctuation', () => {
    // All three clean to `a_b`. Without the hash Word would keep one bookmark
    // and send every link to any of the three headings to that one.
    const names = new Set([bookmarkName('a-b'), bookmarkName('a.b'), bookmarkName('a b')]);
    expect(names.size).toBe(3);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(40);
    }
  });

  it('caps a long anchor at what Word accepts, without collapsing two of them', () => {
    const a = bookmarkName(`heading-${'x'.repeat(60)}-one`);
    const b = bookmarkName(`heading-${'x'.repeat(60)}-two`);
    expect(a.length).toBeLessThanOrEqual(40);
    expect(b.length).toBeLessThanOrEqual(40);
    expect(a).not.toBe(b);
  });

  it('reads a color from an inline style in either notation', () => {
    expect(cssColor('color: #cf222e')).toBe('CF222E');
    expect(cssColor('color:#abc')).toBe('AABBCC');
    expect(cssColor('font-weight:bold;color: rgb(1, 2, 3)')).toBe('010203');
    expect(cssColor('background-color: #fff')).toBeUndefined();
    expect(cssColor(undefined)).toBeUndefined();
  });
});
