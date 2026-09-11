import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { htmlToPptx, reportSummary } from '../src/pptxExport';
import { walkXml } from '../src/ooxml/xml';

/** A 1x1 PNG, as the webview would inline it. */
const PNG_1x1 =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A PNG header with the given intrinsic size, and nothing else. */
function pngDataUri(width: number, height: number): string {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

function pptx(body: string, opts: { slideSize?: '16:9' | '4:3' } = {}) {
  const { bytes, report } = htmlToPptx(`<div>${body}</div>`, {
    title: 'Test',
    now: new Date('2026-01-02T03:04:05.678Z'),
    slideSize: opts.slideSize,
  });
  const parts = unzipSync(bytes);
  const text = (name: string) => strFromU8(parts[name]);
  const slide = (n: number) => text(`ppt/slides/slide${n}.xml`);
  const slideRels = (n: number) => text(`ppt/slides/_rels/slide${n}.xml.rels`);
  return { bytes, report, parts, text, slide, slideRels };
}

/** Well-formedness is the difference between a file PowerPoint opens and one it refuses. */
function assertWellFormed(xml: string): void {
  const parser = new SaxesParser();
  parser.on('error', (err) => {
    throw err;
  });
  parser.write(xml).close();
}

/** Every r:id / r:embed an element references, in document order. */
function relRefs(xml: string): string[] {
  const ids: string[] = [];
  walkXml(xml, {
    open(_name, attrs) {
      if (attrs['r:id']) {
        ids.push(attrs['r:id']);
      }
      if (attrs['r:embed']) {
        ids.push(attrs['r:embed']);
      }
    },
  });
  return ids;
}

/** Every relationship id a .rels part declares. */
function relIds(relsXml: string): Set<string> {
  const ids = new Set<string>();
  walkXml(relsXml, {
    open(name, attrs) {
      if (name === 'Relationship') {
        ids.add(attrs.Id);
      }
    },
  });
  return ids;
}

describe('package structure', () => {
  it('writes every part PowerPoint needs to open a one-slide deck', () => {
    const { parts } = pptx('<h1>Title</h1><p>Body</p>');
    expect(Object.keys(parts).sort()).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/core.xml',
        'ppt/_rels/presentation.xml.rels',
        'ppt/presentation.xml',
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
        'ppt/slideLayouts/slideLayout1.xml',
        'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        'ppt/slideMasters/slideMaster1.xml',
        'ppt/slides/_rels/slide1.xml.rels',
        'ppt/slides/slide1.xml',
        'ppt/theme/theme1.xml',
      ].sort(),
    );
  });

  it('emits well-formed XML for every part', () => {
    const { parts } = pptx(
      '<h1>Title</h1><p>Text with <strong>bold</strong> &amp; an ampersand.</p>' +
        `<ul><li>one</li></ul><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>` +
        `<img src="${PNG_1x1}" alt="a dot"/>`,
    );
    for (const [name, bytes] of Object.entries(parts)) {
      if (name.endsWith('.xml') || name.endsWith('.rels')) {
        expect(() => assertWellFormed(strFromU8(bytes)), name).not.toThrow();
      }
    }
  });

  it('starts with the content types part, as an OPC reader expects', () => {
    const { parts } = pptx('<h1>x</h1>');
    expect(Object.keys(parts)[0]).toBe('[Content_Types].xml');
  });

  it('records the title in the document properties', () => {
    const { text } = pptx('<h1>x</h1>');
    expect(text('docProps/core.xml')).toContain('<dc:title>Test</dc:title>');
    expect(text('docProps/core.xml')).toContain('2026-01-02T03:04:05Z');
  });

  it('sizes the slide for the requested aspect ratio', () => {
    const wide = pptx('<h1>x</h1>', { slideSize: '16:9' });
    expect(wide.text('ppt/presentation.xml')).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    const classic = pptx('<h1>x</h1>', { slideSize: '4:3' });
    expect(classic.text('ppt/presentation.xml')).toContain('<p:sldSz cx="9144000" cy="6858000"/>');
  });

  it('gives every emitted xml part a Content_Types Override', () => {
    const { parts, text } = pptx(
      '<h1>One</h1><p>a</p><hr/><h2>Two</h2><p>b</p><hr/><h2>Three</h2><p>c</p>',
    );
    const contentTypes = text('[Content_Types].xml');
    const overrides = new Set<string>();
    walkXml(contentTypes, {
      open(name, attrs) {
        if (name === 'Override') {
          overrides.add(attrs.PartName);
        }
      },
    });
    for (const name of Object.keys(parts)) {
      if (name.endsWith('.xml') && !name.endsWith('.rels') && name !== '[Content_Types].xml') {
        expect(overrides.has(`/${name}`), name).toBe(true);
      }
    }
  });

  it('closes every r:id a slide or presentation.xml references over its own .rels part', () => {
    const { parts, text, slide, slideRels } = pptx(
      `<h1>One</h1><p>a</p><img src="${PNG_1x1}" alt="dot"/><hr/>` + '<h2>Two</h2><p>b</p>',
    );
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    expect(slideCount).toBeGreaterThan(0);
    for (let n = 1; n <= slideCount; n++) {
      const refs = relRefs(slide(n));
      const ids = relIds(slideRels(n));
      for (const ref of refs) {
        expect(ids.has(ref), `slide${n} -> ${ref}`).toBe(true);
      }
    }
    const presRefs = relRefs(text('ppt/presentation.xml'));
    const presIds = relIds(text('ppt/_rels/presentation.xml.rels'));
    for (const ref of presRefs) {
      expect(presIds.has(ref), `presentation.xml -> ${ref}`).toBe(true);
    }
  });
});

describe('slide splitting', () => {
  it('starts a new slide on every thematic break', () => {
    const { parts } = pptx('<p>Intro</p><hr/><p>Middle</p><hr/><p>End</p>');
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    expect(slideCount).toBe(3);
  });

  it('splits on h1/h2 boundaries when there is no thematic break in the document', () => {
    const { parts, slide } = pptx('<h1>First</h1><p>a</p><h2>Second</h2><p>b</p>');
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    expect(slideCount).toBe(2);
    expect(slide(1)).toContain('<a:t>First</a:t>');
    expect(slide(2)).toContain('<a:t>Second</a:t>');
  });

  it('treats every hr and every h1/h2 as a boundary together, neither overriding the other', () => {
    const { parts, slide } = pptx('<h2>A</h2><p>x</p><h2>A2</h2><hr/><h2>B</h2><p>y</p>');
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    // Three boundaries fire (two h2s plus the hr), not one -- the old rule
    // where an <hr> anywhere in the document switched heading splitting off
    // entirely is exactly the bug this replaces.
    expect(slideCount).toBe(3);
    expect(slide(1)).toContain('<a:t>A</a:t>');
    expect(slide(1)).toContain('<a:t>x</a:t>');
    expect(slide(2)).toContain('<a:t>A2</a:t>');
    expect(slide(3)).toContain('<a:t>B</a:t>');
    expect(slide(3)).toContain('<a:t>y</a:t>');
  });

  it('splits a Marp-style deck (a heading immediately after every rule) the same either way', () => {
    const { parts, slide } = pptx(
      '<h1>Slide 1</h1><p>one</p><hr/><h2>Slide 2</h2><p>two</p><hr/><h2>Slide 3</h2><p>three</p>',
    );
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    // The hr and the heading that immediately follows it are two boundaries
    // back to back, which mint one slide, not two -- a deck already written
    // one heading per rule (Marp's convention) splits exactly as it did
    // before hr and heading became boundaries together.
    expect(slideCount).toBe(3);
    expect(slide(1)).toContain('<a:t>Slide 1</a:t>');
    expect(slide(2)).toContain('<a:t>Slide 2</a:t>');
    expect(slide(3)).toContain('<a:t>Slide 3</a:t>');
  });

  it('turns a thematic break immediately followed by a heading into one slide, not an empty one', () => {
    const { parts, slide } = pptx('<hr/><h2>H</h2><p>body</p>');
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    expect(slideCount).toBe(1);
    expect(slide(1)).toContain('<a:t>H</a:t>');
    expect(slide(1)).toContain('<a:t>body</a:t>');
  });

  it('makes a title-only slide of a lone heading before the first boundary', () => {
    const { slide } = pptx('<h1>Deck Title</h1><hr/><p>content</p>');
    expect(slide(1)).toContain('<a:t>Deck Title</a:t>');
    // The title-slide treatment centers the text; an ordinary slide's title
    // sits at the fixed top-of-slide position instead.
    expect(slide(1)).not.toContain('y="1825625"');
  });

  it('gives an h1 the title-slide treatment when it opens the document alone', () => {
    // h1/h2 are themselves boundaries, so a leading one only ever reaches the
    // title-only path when its own group is the first *emitted* segment: the
    // empty group in front of it, which the boundary it fired created, is
    // skipped without ever pushing one.
    const { slide } = pptx('<h1>Title</h1><hr/><h2>A</h2>');
    expect(slide(1)).toContain('<a:t>Title</a:t>');
    expect(slide(1)).not.toContain('y="1825625"');
  });

  it('does not give a lone h3 the title-slide treatment, matching splitOnBoundary', () => {
    // The "is this a title slide" check used to accept h1-h6 while
    // splitOnBoundary and extractLeadingTitle only ever treat h1/h2 as a
    // slide boundary/title -- so a document opening on a bare `### Preface`
    // got the full-bleed centered title only a boundary heading should earn.
    // An h3 here has to fall through to the same bold-lead body treatment
    // every other h3 in the deck gets, landing at the ordinary body position.
    const { slide } = pptx('<h3>Title</h3><hr/><h2>A</h2>');
    expect(slide(1)).toContain('<a:t>Title</a:t>');
    expect(slide(1)).not.toContain('<p:ph type="title"/>');
    expect(slide(1)).toContain('y="1825625"');
  });

  it('keeps a heading followed by a subtitle paragraph an ordinary content slide', () => {
    // Widening "only a heading" to "a heading plus only paragraphs" would be
    // guessing at intent; a title bar plus a body box is the correct reading
    // of a heading with a subtitle under it.
    const { slide } = pptx('<h1>Title</h1><p>Subtitle</p><hr/><h2>A</h2>');
    expect(slide(1)).toContain('<a:t>Title</a:t>');
    expect(slide(1)).toContain('<a:t>Subtitle</a:t>');
    expect(slide(1)).toContain('y="1825625"');
  });

  it('splits on headings even when a generated footnote separator is present', () => {
    const { parts, slide } = pptx(
      '<h2>One</h2><p>Body one.</p><h2>Two</h2><p>Body two.</p>' +
        '<hr class="footnotes-sep"/><section class="footnotes"><ol class="footnotes-list">' +
        '<li id="fn1"><p>Note text.</p></li></ol></section>',
    );
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    // Two slides, one per heading: markdown-it-footnote's own separator does
    // not count as a third boundary and does not collapse heading splitting
    // the way an ordinary <hr> anywhere in the document used to.
    expect(slideCount).toBe(2);
    expect(slide(1)).toContain('<a:t>One</a:t>');
    expect(slide(2)).toContain('<a:t>Two</a:t>');
  });

  it('never treats the footnote separator as a boundary, or lets it reach the output', () => {
    const { parts, slide } = pptx(
      '<p>Body.</p><hr class="footnotes-sep"/><section class="footnotes">' +
        '<ol class="footnotes-list"><li id="fn1"><p>Note.</p></li></ol></section>',
    );
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    expect(slideCount).toBe(1);
    expect(slide(1)).not.toContain('footnotes-sep');
  });

  it('makes an ordinary slide when content precedes the first boundary alongside a heading', () => {
    const { slide } = pptx('<h1>Not Alone</h1><p>intro text</p><hr/><p>next</p>');
    expect(slide(1)).toContain('<a:t>Not Alone</a:t>');
    expect(slide(1)).toContain('<a:t>intro text</a:t>');
  });

  it('makes an ordinary slide of content with no heading at all before the first boundary', () => {
    const { slide } = pptx('<p>just text</p><hr/><h2>Next</h2>');
    expect(slide(1)).not.toContain('<p:ph type="title"/>');
    expect(slide(1)).toContain('<a:t>just text</a:t>');
  });

  it('skips an empty boundary rather than emitting a blank slide', () => {
    const { parts } = pptx('<hr/><p>only content</p>');
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    expect(slideCount).toBe(1);
  });

  it('produces one slide for a document with no boundary at all', () => {
    const { parts, slide } = pptx('<p>a</p><p>b</p>');
    const slideCount = Object.keys(parts).filter((n) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(n),
    ).length;
    expect(slideCount).toBe(1);
    expect(slide(1)).toContain('<a:t>a</a:t>');
  });
});

describe('lists', () => {
  it('marks a bulleted list with a bullet character and levels nested items one deeper', () => {
    const { slide } = pptx('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    expect(slide(1)).toContain('<a:buChar char="•"/>');
    expect(slide(1)).toContain('lvl="0"');
    expect(slide(1)).toContain('lvl="1"');
  });

  it('numbers an ordered list with arabicPeriod rather than a bullet', () => {
    const { slide } = pptx('<ol><li>one</li><li>two</li></ol>');
    expect(slide(1)).toContain('<a:buAutoNum type="arabicPeriod"/>');
    expect(slide(1)).not.toContain('<a:buChar');
  });

  it('gives each list item exactly one bullet even when it holds more than one paragraph', () => {
    const { slide } = pptx('<ul><li><p>one</p><p>continued</p></li></ul>');
    expect(slide(1).match(/<a:buChar/g)).toHaveLength(1);
  });

  it('honors an explicit start attribute on an ordered list', () => {
    const { slide } = pptx('<ol start="5"><li>five</li><li>six</li></ol>');
    expect(slide(1)).toContain('<a:buAutoNum type="arabicPeriod" startAt="5"/>');
    // Only the item that spends the marker carries it; a second startAt would
    // restart the list at 5 again on its second item instead of continuing.
    expect(slide(1).match(/startAt=/g)).toHaveLength(1);
  });

  it('omits startAt for the default start of one', () => {
    const { slide } = pptx('<ol><li>one</li></ol>');
    expect(slide(1)).toContain('<a:buAutoNum type="arabicPeriod"/>');
    expect(slide(1)).not.toContain('startAt');
  });

  it('clamps a zero start to the minimum DrawingML allows, unlike the docx writer', () => {
    // ST_TextBulletStartAtNum has no representation for 0 the way a Word
    // numbering override does; the closest valid value is 1, i.e. the default.
    const { slide } = pptx('<ol start="0"><li>zero</li></ol>');
    expect(slide(1)).not.toContain('startAt="0"');
  });
});

describe('blockquotes', () => {
  it('clamps nesting depth to what ST_TextIndentLevelType allows', () => {
    // Every list path already clamps to MAX_LIST_LEVEL (8) before writing
    // <a:pPr lvl="...">; ten nested blockquotes with no clamp of their own
    // would reach lvl="10", outside the schema's 0..8 range and exactly the
    // shape of error that makes PowerPoint offer to repair the file.
    let html = '<p>deep</p>';
    for (let i = 0; i < 10; i++) {
      html = `<blockquote>${html}</blockquote>`;
    }
    const { slide } = pptx(html);
    const levels: number[] = [];
    walkXml(slide(1), {
      open(name, attrs) {
        if (name === 'pPr' && attrs.lvl !== undefined) {
          levels.push(Number.parseInt(attrs.lvl, 10));
        }
      },
    });
    expect(levels.length).toBeGreaterThan(0);
    expect(Math.max(...levels)).toBeLessThanOrEqual(8);
  });
});

describe('tables', () => {
  it('marks a header row with firstRow so it can be styled as one', () => {
    const { slide } = pptx(
      '<table><thead><tr><th>Region</th><th>Revenue</th></tr></thead>' +
        '<tbody><tr><td>EU</td><td>4.2m</td></tr></tbody></table>',
    );
    expect(slide(1)).toContain('<a:tblPr firstRow="1"/>');
    expect(slide(1)).toContain('<a:t>Region</a:t>');
    expect(slide(1)).toContain('<a:t>4.2m</a:t>');
  });

  it('omits firstRow for a table with no header', () => {
    const { slide } = pptx('<table><tr><td>a</td></tr></table>');
    expect(slide(1)).toContain('<a:tblPr/>');
  });

  it('turns a colspan into a gridSpan with an hMerge continuation cell', () => {
    const { slide } = pptx(
      '<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></table>',
    );
    expect(slide(1)).toContain('gridSpan="2"');
    expect(slide(1)).toContain('hMerge="1"');
  });

  it('carries a rowspan into the next row as a vertical merge', () => {
    const { slide } = pptx(
      '<table><tr><td rowspan="2">tall</td><td>a</td></tr><tr><td>b</td></tr></table>',
    );
    expect(slide(1)).toContain('rowSpan="2"');
    expect(slide(1)).toContain('vMerge="1"');
  });

  it('clamps a rowspan to the rows actually remaining', () => {
    // colspan was already clamped to the columns remaining; rowspan was not,
    // so rowSpan="9" over a two-row table left too few vMerge continuation
    // cells to match it -- internally inconsistent merge geometry PowerPoint
    // refuses to open.
    const { slide } = pptx(
      '<table><tr><td rowspan="9">a</td><td>b</td></tr><tr><td>c</td></tr></table>',
    );
    const xml = slide(1);
    const rowSpans = [...xml.matchAll(/rowSpan="(\d+)"/g)].map((m) => Number(m[1]));
    expect(rowSpans).toEqual([2]);
    // One row remains under the clamped span, so exactly one vMerge
    // continuation cell should claim it.
    expect(xml.match(/vMerge="1"/g)).toHaveLength(1);
  });

  it('carries the header fill onto a vMerge continuation cell inside a header row', () => {
    // The carry branch hardcoded `header: false` for a vMerge continuation
    // cell while the neighbouring missing-cell branch correctly passed
    // row.header, so a <th rowspan="2"> in a two-row thead left row 2's
    // covered cell without the header shading.
    const { slide } = pptx(
      '<table><thead>' +
        '<tr><th rowspan="2">R</th><th>Col</th></tr>' +
        '<tr><th>Col2</th></tr>' +
        '</thead></table>',
    );
    const xml = slide(1);
    // `<a:tc[ >]` rather than `<a:tc` alone, or every <a:tcPr> child would be
    // double-counted as a cell of its own.
    const tcCount = (xml.match(/<a:tc[ >]/g) ?? []).length;
    const fillCount = (xml.match(/<a:solidFill><a:srgbClr val="F6F8FA"\/><\/a:solidFill>/g) ?? [])
      .length;
    expect(tcCount).toBe(4);
    expect(fillCount).toBe(4);
  });
});

describe('images', () => {
  it('embeds the bytes and carries the alt text as the shape description', () => {
    const { parts, slide, report } = pptx(`<p><img src="${PNG_1x1}" alt="A red dot"/></p>`);
    expect(parts['ppt/media/image1.png']).toBeDefined();
    expect(slide(1)).toContain('descr="A red dot"');
    expect(report.images).toBe(1);
    expect(report.imagesMissingAlt).toBe(0);
  });

  it('counts an image with no alt text rather than shipping it silently', () => {
    const { report } = pptx(`<p><img src="${PNG_1x1}" alt=""/></p>`);
    expect(report.imagesMissingAlt).toBe(1);
    expect(reportSummary(report)).toContain('1 image without alt text');
  });

  it('keeps the alt text as prose when the bytes cannot be embedded', () => {
    const { slide, report } = pptx('<p><img src="https://x.test/a.png" alt="A chart"/></p>');
    expect(report.imagesSkipped).toBe(1);
    expect(slide(1)).toContain('[image: A chart]');
    expect(reportSummary(report)).toContain('could not be embedded');
  });

  it('gives an image its own relationship distinct from the slide layout rel', () => {
    const { slideRels } = pptx(`<p><img src="${pngDataUri(2, 2)}" alt="x"/></p>`);
    const rels = slideRels(1);
    expect(rels).toContain('Target="../slideLayouts/slideLayout1.xml"');
    expect(rels).toContain('Target="../media/image1.png"');
  });

  it('stores a repeated image once, even across slides', () => {
    const { parts, slide, slideRels } = pptx(
      `<p><img src="${PNG_1x1}" alt="a"/></p><p><img src="${PNG_1x1}" alt="a"/></p>` +
        `<hr/><p><img src="${PNG_1x1}" alt="a"/></p>`,
    );
    // One media part for all three <img>s, on two different slides.
    expect(Object.keys(parts).filter((n) => n.startsWith('ppt/media/'))).toEqual([
      'ppt/media/image1.png',
    ]);
    // Slide 1 repeats the image twice but needs only one relationship to it.
    expect(slideRels(1).match(/Target="\.\.\/media\/image1\.png"/g)).toHaveLength(1);
    expect(slide(1).match(/r:embed=/g)).toHaveLength(2);
    // Slide 2's own .rels part still needs its own relationship to that part:
    // relationships are file-scoped even though the media they point at isn't.
    expect(slideRels(2)).toContain('Target="../media/image1.png"');
  });

  it('turns a linked image into a real picture with the hyperlink on it', () => {
    // `[![Chart](chart.png)](https://example.test)` used to disappear
    // entirely: the paragraph's only child is `a`, not `img`, so it never
    // reached the picture path, and inlineElement's own `[image: alt]` bracket
    // fallback for a *genuinely inline* image doesn't apply to a whole
    // paragraph that is nothing but a link around one.
    const { parts, slide, slideRels, report } = pptx(
      `<p><a href="https://example.test"><img src="${PNG_1x1}" alt="Chart"/></a></p>`,
    );
    expect(parts['ppt/media/image1.png']).toBeDefined();
    expect(slide(1)).toContain('<p:pic>');
    expect(slide(1)).toContain('descr="Chart"');
    const match = /<a:hlinkClick r:id="(rId\d+)"\/>/.exec(slide(1));
    expect(match).not.toBeNull();
    expect(slideRels(1)).toContain(`Id="${match?.[1]}"`);
    expect(report.images).toBe(1);
  });

  it('keeps a linked image with no alt text a real picture instead of dropping it', () => {
    // With alt="" the old [image: alt] fallback run was `{xml: '', visible:
    // false}`, which made the whole paragraph invisible and dropped it --
    // pics=0, media=0, report.images=0. A standalone image is worth keeping
    // as a picture regardless of whether its alt text is empty.
    const { parts, slide, report } = pptx(
      `<p><a href="https://example.test"><img src="${PNG_1x1}" alt=""/></a></p>`,
    );
    expect(parts['ppt/media/image1.png']).toBeDefined();
    expect(slide(1)).toContain('<p:pic>');
    expect(report.images).toBe(1);
    expect(report.imagesMissingAlt).toBe(1);
  });
});

describe('hyperlinks', () => {
  it('gives an http(s) link a clickable run and an external relationship', () => {
    const { slide, slideRels } = pptx('<p><a href="https://example.test/a?b=1&amp;c=2">go</a></p>');
    const rels = slideRels(1);
    expect(rels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"',
    );
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain('Target="https://example.test/a?b=1&amp;c=2"');
    const match = /<a:hlinkClick r:id="(rId\d+)"\/>/.exec(slide(1));
    expect(match).not.toBeNull();
    expect(rels).toContain(`Id="${match?.[1]}"`);
    expect(slide(1)).toContain('<a:t>go</a:t>');
  });

  it('gives a mailto link the same treatment as http(s)', () => {
    const { slide, slideRels } = pptx('<p><a href="mailto:a@example.test">mail</a></p>');
    expect(slide(1)).toContain('<a:hlinkClick');
    expect(slideRels(1)).toContain('Target="mailto:a@example.test"');
  });

  it('refuses a scheme that would not mean anything on another machine, but keeps the text', () => {
    const { slide, slideRels } = pptx(
      '<p><a href="vscode-webview-resource://x/y">one</a> ' +
        '<a href="javascript:alert(1)">two</a> <a href="#frag">three</a></p>',
    );
    expect(slide(1)).not.toContain('<a:hlinkClick');
    expect(slideRels(1)).not.toContain('hyperlink');
    expect(slide(1)).toContain('<a:t>one</a:t>');
    expect(slide(1)).toContain('<a:t>two</a:t>');
    expect(slide(1)).toContain('<a:t>three</a:t>');
  });

  it("places hlinkClick after the run's typeface, as CT_TextCharacterProperties requires", () => {
    const { slide } = pptx('<p><a href="https://x.test"><code>npm i</code></a></p>');
    expect(slide(1)).toContain('<a:latin typeface="Consolas"/><a:hlinkClick');
  });

  it('does not leave an orphan hyperlink relationship when the link has nothing visible in it', () => {
    // addHyperlinkRel used to run before the anchor's children were converted,
    // so a link around content that resolves to nothing left a relationship
    // in the slide's .rels with nothing in bodyXml pointing at it -- exactly
    // the shape of orphan package.ts's own header comment warns about.
    const { slide, slideRels } = pptx('<p><a href="https://x.test"></a></p>');
    expect(slide(1)).not.toContain('<a:hlinkClick');
    expect(slideRels(1)).not.toContain('hyperlink');
  });
});

describe('code blocks', () => {
  it('writes one paragraph per line with no bullet, in a monospace run', () => {
    const { slide } = pptx('<pre><code>one\ntwo\nthree</code></pre>');
    expect(slide(1).match(/<a:latin typeface="Consolas"\/>/g)).toHaveLength(3);
    expect(slide(1)).not.toContain('<a:buChar');
  });

  it('keeps the syntax colors the webview inlined', () => {
    const { slide } = pptx(
      '<pre><code><span style="color: rgb(207, 34, 46)">def</span> f</code></pre>',
    );
    expect(slide(1)).toContain('<a:srgbClr val="CF222E"/>');
  });
});

describe('inline formatting', () => {
  it('maps strong, em and code onto run properties', () => {
    const { slide } = pptx('<p><strong>b</strong><em>i</em><code>c</code></p>');
    expect(slide(1)).toContain('b="1"');
    expect(slide(1)).toContain('i="1"');
    expect(slide(1)).toContain('<a:latin typeface="Consolas"/>');
  });
});

describe('hostile and odd input', () => {
  it('strips characters XML cannot represent instead of writing a broken file', () => {
    const { slide } = pptx(`<p>before${String.fromCharCode(11)}after</p>`);
    expect(() => assertWellFormed(slide(1))).not.toThrow();
    expect(slide(1)).toContain('beforeafter');
  });

  it('drops a lone surrogate but keeps a well-formed pair', () => {
    const lone = String.fromCharCode(0xd83d);
    const pair = String.fromCharCode(0xd83d, 0xde00);
    const { slide } = pptx(`<p>ok${lone} and ${pair}</p>`);
    expect(() => assertWellFormed(slide(1))).not.toThrow();
    expect(slide(1)).toContain(`ok and ${pair}`);
  });

  it('escapes markup-like text rather than injecting it', () => {
    const { slide } = pptx('<p>&lt;/a:t&gt;&lt;/a:r&gt;&lt;a:r&gt;</p>');
    expect(() => assertWellFormed(slide(1))).not.toThrow();
    expect(slide(1)).toContain('&lt;/a:t&gt;');
  });

  it('drops viewer chrome the preview marks as its own', () => {
    const { slide } = pptx('<p>kept</p><div data-mc-ignore="1"><p>chrome</p></div>');
    expect(slide(1)).not.toContain('chrome');
    expect(slide(1)).toContain('kept');
  });

  it('refuses input that is not well-formed rather than writing half a file', () => {
    expect(() => htmlToPptx('<p>unclosed', { title: 'x' })).toThrow();
  });
});

describe('reportSummary', () => {
  it('says nothing when there is nothing to report', () => {
    const { report } = pptx(`<p><img src="${PNG_1x1}" alt="described"/></p>`);
    expect(reportSummary(report)).toBeUndefined();
  });
});
