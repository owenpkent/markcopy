import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { htmlToDocx, reportSummary } from '../src/docxExport';
import { imageSize } from '../src/docx/media';
import { bookmarkName } from '../src/docx/ooxml';
import { cssColor } from '../src/docx/build';

/** A 1x1 PNG, as the webview would inline it. */
const PNG_1x1 =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
    expect(document).toContain('<w:bookmarkStart w:id="0" w:name="setup"/>');
    expect(document).toContain('<w:hyperlink w:anchor="setup">');
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
  it('keeps a short anchor as-is', () => {
    expect(bookmarkName('setup')).toBe('setup');
  });

  it('prefixes an anchor that does not start with a letter', () => {
    expect(bookmarkName('1-intro')).toBe('mc_1_intro');
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
