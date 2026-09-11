import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { DeckError, renderDeckHtml } from '../../src/pptx/read';
import { runsHtml } from '../../src/pptx/read/text';
import {
  buildPptx,
  extraRel,
  lvlPPrXml,
  paraXml,
  picShape,
  removePart,
  runXml,
  spShape,
  tableFrameXml,
  tcXml,
  txBodyXml,
  xfrmXml,
} from './fixture';

// 12192000 EMU wide (the default 16:9 slide) is 960pt, so sz/960 is the cqw a
// run's resolved size should show up as -- used throughout the inheritance
// tests below to pick sizes that land on clean numbers.
const SLIDE_WIDTH_PT = 960;

describe('slide order', () => {
  it('follows sldIdLst, not the order slideN.xml happens to sit in the zip', () => {
    const title = (id: string, name: string) =>
      spShape({
        ph: { type: 'title' },
        xfrm: xfrmXml(0, 0, 6000000, 1000000),
        txBody: txBodyXml(paraXml({ runs: runXml(name) })),
      });

    const bytes = buildPptx({
      slides: [
        { spTree: title('1', 'First') }, // slide1.xml
        { spTree: title('2', 'Second') }, // slide2.xml
        { spTree: title('3', 'Third') }, // slide3.xml
      ],
      extra: {
        // Reorders the deck to Third, First, Second while the underlying
        // slide1.xml/slide2.xml/slide3.xml files (and their content) stay
        // exactly as buildPptx laid them out. A reader that sorted by
        // filename instead of walking this list would show them in the
        // filename order (First, Second, Third).
        'ppt/presentation.xml':
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<p:sldIdLst>' +
          '<p:sldId id="256" r:id="rId3"/>' +
          '<p:sldId id="257" r:id="rId1"/>' +
          '<p:sldId id="258" r:id="rId2"/>' +
          '</p:sldIdLst>' +
          '<p:sldSz cx="12192000" cy="6858000"/>' +
          '</p:presentation>',
      },
    });

    const deck = renderDeckHtml(bytes);
    expect(deck.slides).toBe(3);
    expect(deck.rendered).toBe(3);
    const titles = [...deck.html.matchAll(/mc-pptx-title[^>]*>([^<]*)/g)].map((m) => m[1]);
    expect(titles).toEqual(['Third', 'First', 'Second']);
  });
});

describe('placeholder geometry inheritance', () => {
  it('inherits from the layout, and falls back to the master when the layout has no match', () => {
    // The layout defines a title placeholder's geometry; the slide's title
    // shape carries no <a:xfrm> of its own and must pick it up from there.
    const layoutPlaceholders = spShape({
      ph: { type: 'title' },
      xfrm: xfrmXml(1219200, 685800, 6096000, 3429000), // 10%, 10%, 50%, 50%
    });
    // The layout has no body placeholder at all, so a body placeholder on the
    // slide has to fall through to the master's.
    const masterPlaceholders = spShape({
      ph: { type: 'body' },
      xfrm: xfrmXml(2438400, 1371600, 7315200, 2743200), // 20%, 20%, 60%, 40%
    });

    const titleOnSlide = spShape({
      ph: { type: 'title' },
      txBody: txBodyXml(paraXml({ runs: runXml('Title') })),
    });
    const bodyOnSlide = spShape({
      ph: { type: 'body', idx: 1 },
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml('Body') })),
    });

    const bytes = buildPptx({
      slides: [{ spTree: titleOnSlide + bodyOnSlide }],
      layoutPlaceholders,
      masterPlaceholders,
    });

    const html = renderDeckHtml(bytes).html;
    expect(html).toContain('left:10%;top:10%;width:50%;height:50%');
    expect(html).toContain('left:20%;top:20%;width:60%;height:40%');
  });
});

describe('EMU to percent, and font size to cqw', () => {
  it('converts EMU offsets to percentages of the slide box, rounded to two places', () => {
    // 1015997 / 12192000 * 100 = 8.3333...% ; 829818 / 6858000 * 100 = 12.1%
    // exactly, which is what proves trailing zeros get dropped (12.10 -> 12.1)
    // rather than just proving the rounding.
    const shape = spShape({
      xfrm: xfrmXml(1015997, 829818, 1000000, 1000000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml('Box') })),
    });
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree: shape }] })).html;
    expect(html).toContain('left:8.33%');
    expect(html).toContain('top:12.1%');
  });

  it('turns a run size (hundredths of a point) into a cqw font size', () => {
    // A 960pt-wide slide (12192000 EMU) with a 44pt run: 4400 / 960 = 4.5833...,
    // which is also PowerPoint's own default title size on a 16:9 layout.
    const title = spShape({
      ph: { type: 'title' },
      xfrm: xfrmXml(0, 0, 6000000, 1000000),
      txBody: txBodyXml(paraXml({ runs: runXml('Title', 'sz="4400"') })),
    });
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree: title }] })).html;
    expect(html).toContain('font-size:4.58cqw');
  });

  it('reports the aspect ratio the presentation declares', () => {
    const shape = spShape({
      xfrm: xfrmXml(0, 0, 1000, 1000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml('x') })),
    });
    const wide = renderDeckHtml(
      buildPptx({ slides: [{ spTree: shape }], sldSz: { cx: 12192000, cy: 6858000 } }),
    ).html;
    expect(wide).toContain('aspect-ratio:1.7778');
    const standard = renderDeckHtml(
      buildPptx({ slides: [{ spTree: shape }], sldSz: { cx: 9144000, cy: 6858000 } }),
    ).html;
    expect(standard).toContain('aspect-ratio:1.3333');
  });
});

describe('text property inheritance', () => {
  // PowerPoint authors rarely put sz/b/i/u on a run at all -- those live up
  // the chain: run rPr, paragraph defRPr, the shape's own lstStyle, the
  // matching placeholder's lstStyle on the layout then the master, the
  // master's titleStyle/bodyStyle/otherStyle, and finally the presentation's
  // defaultTextStyle. Each of these picks a size that lands on a clean cqw
  // number against the default 960pt-wide slide, so a wrong level in the
  // chain shows up as the wrong number rather than a rounding coincidence.

  it('falls back to the master titleStyle size when a title run has no rPr at all', () => {
    const title = spShape({
      ph: { type: 'title' },
      xfrm: xfrmXml(0, 0, 6000000, 1000000),
      txBody: txBodyXml(paraXml({ runs: runXml('Title') })), // no <a:rPr> on the run
    });
    const bytes = buildPptx({
      slides: [{ spTree: title }],
      masterTxStyles: `<p:titleStyle>${lvlPPrXml(0, 'sz="4000"')}</p:titleStyle>`,
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain(`font-size:${fmt(4000)}cqw`);
  });

  it("prefers the shape's own lstStyle over the master's bodyStyle", () => {
    const body = spShape({
      ph: { type: 'body', idx: 1 },
      xfrm: xfrmXml(0, 0, 6000000, 3000000),
      txBody: txBodyXml(
        paraXml({ bullet: 'none', runs: runXml('Body') }),
        lvlPPrXml(0, 'sz="2880"'),
      ),
    });
    const bytes = buildPptx({
      slides: [{ spTree: body }],
      masterTxStyles: `<p:bodyStyle>${lvlPPrXml(0, 'sz="4800"')}</p:bodyStyle>`,
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain(`font-size:${fmt(2880)}cqw`);
    expect(html).not.toContain(`font-size:${fmt(4800)}cqw`);
  });

  it("prefers a run's own sz over both the shape's lstStyle and the master", () => {
    const body = spShape({
      ph: { type: 'body', idx: 1 },
      xfrm: xfrmXml(0, 0, 6000000, 3000000),
      txBody: txBodyXml(
        paraXml({ bullet: 'none', runs: runXml('Body', 'sz="1200"') }),
        lvlPPrXml(0, 'sz="2880"'),
      ),
    });
    const bytes = buildPptx({
      slides: [{ spTree: body }],
      masterTxStyles: `<p:bodyStyle>${lvlPPrXml(0, 'sz="4800"')}</p:bodyStyle>`,
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain(`font-size:${fmt(1200)}cqw`);
    expect(html).not.toContain(`font-size:${fmt(2880)}cqw`);
    expect(html).not.toContain(`font-size:${fmt(4800)}cqw`);
  });

  it('reads level N from the 1-based <a:lvl{N+1}pPr>, not <a:lvl{N}pPr>', () => {
    // lvl="1" is 0-based (the second outline level), which the format stores
    // as <a:lvl2pPr>. Reading <a:lvl1pPr> instead is the easy off-by-one.
    const body = spShape({
      ph: { type: 'body', idx: 1 },
      xfrm: xfrmXml(0, 0, 6000000, 3000000),
      txBody: txBodyXml(paraXml({ lvl: 1, bullet: 'none', runs: runXml('Nested') })),
    });
    const bytes = buildPptx({
      slides: [{ spTree: body }],
      masterTxStyles: `<p:bodyStyle>${lvlPPrXml(0, 'sz="4400"')}${lvlPPrXml(1, 'sz="1920"')}</p:bodyStyle>`,
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain(`font-size:${fmt(1920)}cqw`);
    expect(html).not.toContain(`font-size:${fmt(4400)}cqw`);
  });

  it('renders a title with no resolved bold as plain text, and one with explicit bold as <strong>', () => {
    const plain = spShape({
      ph: { type: 'title' },
      xfrm: xfrmXml(0, 0, 6000000, 1000000),
      txBody: txBodyXml(paraXml({ runs: runXml('Plain Title') })),
    });
    const htmlPlain = renderDeckHtml(buildPptx({ slides: [{ spTree: plain }] })).html;
    expect(htmlPlain).toContain('>Plain Title<');
    expect(htmlPlain).not.toContain('<strong>');

    const bold = spShape({
      ph: { type: 'title' },
      xfrm: xfrmXml(0, 0, 6000000, 1000000),
      txBody: txBodyXml(paraXml({ runs: runXml('Bold Title', 'b="1"') })),
    });
    const htmlBold = renderDeckHtml(buildPptx({ slides: [{ spTree: bold }] })).html;
    expect(htmlBold).toContain('<strong>Bold Title</strong>');
  });
});

/** `sz` (hundredths of a point) -> the cqw string render.ts should emit against the default 960pt-wide slide. */
function fmt(szHundredths: number): string {
  const cqw = Math.round((szHundredths / SLIDE_WIDTH_PT) * 100) / 100;
  return String(cqw);
}

describe('bullets', () => {
  it('nests a deeper level inside the <li> of its parent', () => {
    const body = spShape({
      ph: { type: 'body', idx: 1 },
      xfrm: xfrmXml(0, 0, 6000000, 3000000),
      txBody: txBodyXml(
        paraXml({ lvl: 0, bullet: 'char', runs: runXml('Top') }) +
          paraXml({ lvl: 1, bullet: 'char', runs: runXml('Nested') }) +
          paraXml({ lvl: 0, bullet: 'char', runs: runXml('Second top') }),
      ),
    });
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree: body }] })).html;
    expect(html).toContain('<ul class="mc-pptx-shape mc-pptx-body"');
    expect(html).toContain('<li>Top<ul><li>Nested</li></ul></li><li>Second top</li>');
  });

  it('renders a numbered list as <ol>, and an unbulleted paragraph as <p>', () => {
    const body = spShape({
      ph: { type: 'body', idx: 1 },
      xfrm: xfrmXml(0, 0, 6000000, 3000000),
      txBody: txBodyXml(
        paraXml({ bullet: 'autoNum', runs: runXml('One') }) +
          paraXml({ bullet: 'none', runs: runXml('Plain line') }),
      ),
    });
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree: body }] })).html;
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>One</li>');
    expect(html).toContain('<p>Plain line</p>');
  });
});

describe('tables', () => {
  it('renders a header row as <thead>/<th> and a merged cell as colspan, skipping its continuation', () => {
    const tbl =
      '<a:tbl>' +
      '<a:tblPr firstRow="1"/>' +
      '<a:tblGrid><a:gridCol w="1000000"/><a:gridCol w="1000000"/></a:tblGrid>' +
      '<a:tr h="300000">' +
      tcXml({ text: 'Name' }) +
      tcXml({ text: 'Value' }) +
      '</a:tr>' +
      '<a:tr h="300000">' +
      tcXml({ gridSpan: 2, text: 'Merged' }) +
      tcXml({ hMerge: true }) +
      '</a:tr>' +
      '</a:tbl>';
    const frame = tableFrameXml({ xfrm: xfrmXml(0, 0, 6000000, 2000000), tblXml: tbl });
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree: frame }] })).html;

    expect(html).toContain('<table class="mc-pptx-shape mc-pptx-table"');
    expect(html).toMatch(/<thead><tr><th[^>]*>Name<\/th><th[^>]*>Value<\/th><\/tr><\/thead>/);
    expect(html).toContain('colspan="2"');
    expect(html).toContain('<td colspan="2">Merged</td>');
    // The hMerge continuation contributes no cell of its own.
    expect(html).not.toContain('<td></td></tr>');
  });
});

describe('pictures', () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  it('inlines an embedded image as a data: URI', () => {
    const pic = picShape({
      embedId: 'rIdImg',
      xfrm: xfrmXml(0, 0, 1000000, 1000000),
      descr: 'A test image',
    });
    const bytes = buildPptx({
      slides: [
        {
          spTree: pic,
          extraRels: extraRel('rIdImg', 'image', '../media/image1.png'),
        },
      ],
      media: { 'ppt/media/image1.png': PNG_BYTES },
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain('<img class="mc-pptx-shape mc-pptx-pic"');
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain('alt="A test image"');
  });

  it('falls back to a placeholder box once the media budget is spent', () => {
    const pic = picShape({ embedId: 'rIdImg', xfrm: xfrmXml(0, 0, 1000000, 1000000) });
    const bytes = buildPptx({
      slides: [{ spTree: pic, extraRels: extraRel('rIdImg', 'image', '../media/image1.png') }],
      media: { 'ppt/media/image1.png': PNG_BYTES },
    });
    const html = renderDeckHtml(bytes, { maxMediaBytes: 4 }).html;
    expect(html).not.toContain('data:image');
    expect(html).toContain('mc-pptx-placeholder');
    expect(html).toContain('Image');
  });
});

describe('colour', () => {
  it('stops following groups past a sane nesting depth', () => {
    // A group inside a group is ordinary; a few thousand of them is a file
    // built to overflow the stack, since the walk recurses once per level and
    // the element is eleven bytes. Dropping what is buried down there costs one
    // pathological group; following it costs the whole preview.
    const depth = 5000;
    const buried = spShape({
      xfrm: xfrmXml(0, 0, 1000000, 1000000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml('Buried') })),
    });
    const spTree = '<p:grpSp>'.repeat(depth) + buried + '</p:grpSp>'.repeat(depth);
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree }] })).html;
    expect(html).toContain('mc-pptx-slide');
    expect(html).not.toContain('Buried');
  });

  it('refuses a colour attribute that is not six hex digits', () => {
    // A colour is attacker-controlled text whose only consumer is a CSS
    // declaration, so a value carrying its own semicolon would close
    // `color:#...` and open whatever it liked. The preview CSP allows `https:`
    // for images, so a background url() smuggled in this way would fetch from a
    // host the file names, on nothing more than opening it.
    const evil = 'ABCDEF;background:url(https://example.invalid/x)';
    const run = runXml('Text', '', `<a:solidFill><a:srgbClr val="${evil}"/></a:solidFill>`);
    const bytes = buildPptx({
      slides: [
        {
          spTree: spShape({
            xfrm: xfrmXml(0, 0, 1000000, 1000000),
            txBody: txBodyXml(paraXml({ bullet: 'none', runs: run })),
          }),
        },
      ],
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).not.toContain('example.invalid');
    expect(html).not.toContain('background:url');
    // Refused outright rather than half-applied: no colour at all beats a
    // colour we had to launder.
    expect(html).not.toContain('color:#ABCDEF');
    expect(html).toContain('Text');
  });

  it('resolves a scheme colour through the master colour map, not the scheme name itself', () => {
    // tx1 is remapped to dk2 here, so a correct reader renders dk2's colour
    // (44546A, from the default theme) rather than dk1's (000000) or bg1's.
    const run = runXml('Coloured', '', '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>');
    const shape = spShape({
      xfrm: xfrmXml(0, 0, 1000000, 1000000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: run })),
    });
    const bytes = buildPptx({
      slides: [{ spTree: shape }],
      clrMapAttrs:
        'bg1="lt1" tx1="dk2" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
        'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
        'hlink="hlink" folHlink="folHlink"',
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain('color:#44546A');
    expect(html).not.toContain('color:#000000');
  });

  it('does not let an extra colour scheme clobber the real one under <a:themeElements>', () => {
    // <a:extraClrSchemeLst><a:extraClrScheme><a:clrScheme> is routine in
    // theme1.xml converted from .ppt or authored in LibreOffice: an alternate
    // palette PowerPoint's "Colors" gallery offers but the deck isn't using.
    // A reader matching on local name alone would let this one, read last,
    // overwrite the real scheme's accent1 (4472C4, the default theme's).
    const run = runXml('Coloured', '', '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>');
    const shape = spShape({
      xfrm: xfrmXml(0, 0, 1000000, 1000000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: run })),
    });
    const bytes = buildPptx({
      slides: [{ spTree: shape }],
      extraClrScheme: '<a:accent1><a:srgbClr val="FF0000"/></a:accent1>',
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain('color:#4472C4');
    expect(html).not.toContain('color:#FF0000');
  });

  it('refuses a colour map value that resolves through Object.prototype instead of coming back a miss', () => {
    // <p:clrMap tx1="constructor"> is a legitimate-looking (if useless) value
    // for the attribute; the attack is that a plain object indexed by it
    // would resolve theme.colors['constructor'] to the Object constructor
    // itself rather than undefined, handing back a function where a hex
    // colour was expected.
    const run = runXml('Coloured', '', '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>');
    const shape = spShape({
      xfrm: xfrmXml(0, 0, 1000000, 1000000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: run })),
    });
    const bytes = buildPptx({
      slides: [{ spTree: shape }],
      clrMapAttrs:
        'bg1="lt1" tx1="constructor" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
        'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
        'hlink="hlink" folHlink="folHlink"',
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).not.toContain('function');
    expect(html).not.toContain('[native code]');
    // theme.colors has no "constructor" entry of its own, so this is an
    // unresolved colour, and slot "constructor" isn't one of the light
    // slots -- the fallback is black.
    expect(html).toContain('color:#000000');
  });

  it('judges the unresolved-colour fallback on the mapped slot, not the pre-map name, and covers lt2/bg2', () => {
    // tx1 is mapped to lt1 -- a *light* slot -- and bg2 to lt2, its usual
    // identity target; an empty theme resolves neither, so both runs exercise
    // the fallback. Judging by the pre-map name (tx1, bg2) instead of the
    // slot they actually resolve to would call both dark.
    const runTx1 = runXml('TX1', '', '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>');
    const runBg2 = runXml('BG2', '', '<a:solidFill><a:schemeClr val="bg2"/></a:solidFill>');
    const shape = spShape({
      xfrm: xfrmXml(0, 0, 1000000, 1000000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runTx1 + runBg2 })),
    });
    const bytes = buildPptx({
      slides: [{ spTree: shape }],
      themeColors: '', // an empty <a:clrScheme>: nothing resolves, every slot falls through
      clrMapAttrs:
        'bg1="lt1" tx1="lt1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
        'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
        'hlink="hlink" folHlink="folHlink"',
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain('color:#FFFFFF');
    expect(html).not.toContain('color:#000000');
  });
});

describe('run colour escaping', () => {
  it('escapes a run colour before it reaches a style attribute', () => {
    // Every colour reaching runHtml today is already-validated hex (see the
    // theme colour tests above), but this is the one place in the reader that
    // builds a style attribute without going through escapeAttr the way every
    // other style attribute in render.ts does, so it is pinned directly here
    // rather than relying on every upstream caller staying honest forever.
    const html = runsHtml(
      [
        {
          kind: 'text',
          text: 'x',
          b: false,
          i: false,
          u: false,
          color: '000000"><script>evil</script',
        },
      ],
      undefined,
      960,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;');
  });
});

describe('speaker notes', () => {
  it('extracts the notesSlide body placeholder as plain text under the slide', () => {
    const shape = spShape({
      xfrm: xfrmXml(0, 0, 1000000, 1000000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml('Slide content') })),
    });
    const notesBody = spShape({
      ph: { type: 'body' },
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml('Speaker notes text') })),
    });
    const bytes = buildPptx({ slides: [{ spTree: shape, notes: notesBody }] });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain('<p class="mc-pptx-notes">Speaker notes text</p>');
  });

  it('omits notes entirely when showNotes is false', () => {
    const shape = spShape({
      xfrm: xfrmXml(0, 0, 1000000, 1000000),
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml('Slide content') })),
    });
    const notesBody = spShape({
      ph: { type: 'body' },
      txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml('Hidden notes') })),
    });
    const bytes = buildPptx({ slides: [{ spTree: shape, notes: notesBody }] });
    const html = renderDeckHtml(bytes, { showNotes: false }).html;
    expect(html).not.toContain('Hidden notes');
  });
});

describe('maxSlides', () => {
  it('renders only the cap and says how many slides it is hiding', () => {
    const shapeFor = (text: string) =>
      spShape({
        xfrm: xfrmXml(0, 0, 1000000, 1000000),
        txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml(text) })),
      });
    const bytes = buildPptx({
      slides: [
        { spTree: shapeFor('One') },
        { spTree: shapeFor('Two') },
        { spTree: shapeFor('Three') },
      ],
    });
    const deck = renderDeckHtml(bytes, { maxSlides: 2 });
    expect(deck.slides).toBe(3);
    expect(deck.rendered).toBe(2);
    expect(deck.html).toContain('markcopy.pptx.maxSlides');
    expect(deck.html).not.toContain('Three');
  });
});

describe('missing slide parts', () => {
  it('reports slides that could not be read without blaming maxSlides for it', () => {
    // The middle slide's part is missing outright, not merely absent from
    // sldIdLst -- a corrupt or truncated package, distinct from maxSlides
    // cutting the deck short. Blaming the setting here used to be actively
    // misleading, since raising it changes nothing for a missing part, and
    // "showing the first N" is simply wrong once the gap is in the middle.
    const shapeFor = (text: string) =>
      spShape({
        xfrm: xfrmXml(0, 0, 1000000, 1000000),
        txBody: txBodyXml(paraXml({ bullet: 'none', runs: runXml(text) })),
      });
    const bytes = removePart(
      buildPptx({
        slides: [
          { spTree: shapeFor('One') },
          { spTree: shapeFor('Two') },
          { spTree: shapeFor('Three') },
        ],
      }),
      'ppt/slides/slide2.xml',
    );
    const deck = renderDeckHtml(bytes);
    expect(deck.slides).toBe(3);
    expect(deck.rendered).toBe(2);
    expect(deck.html).toContain('One');
    expect(deck.html).not.toContain('Two');
    expect(deck.html).toContain('Three');
    expect(deck.html).toContain('1 slide could not be read and was skipped.');
    expect(deck.html).not.toContain('markcopy.pptx.maxSlides');
    expect(deck.html).not.toContain('Showing the first');
  });
});

describe('relationship-namespaced attributes', () => {
  // Every other test in this file uses the conventional "r:" prefix (via
  // fixture.ts's default xmlns:r binding) for both <p:sldId r:id> and
  // <a:blip r:embed>, so the whole rest of the suite already covers that
  // case passing. This one covers a package binding the relationships
  // namespace to something else instead, which a reader matching the literal
  // string "r:id"/"r:embed" cannot see at all.
  it('resolves r:id and r:embed under an unconventional namespace prefix', () => {
    const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const pic =
      `<p:pic xmlns:rel="${REL}">` +
      '<p:nvPicPr><p:cNvPr id="3" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip rel:embed="rIdImg"/><a:stretch/></p:blipFill>' +
      `<p:spPr>${xfrmXml(0, 0, 1000000, 1000000)}</p:spPr>` +
      '</p:pic>';
    const bytes = buildPptx({
      slides: [{ spTree: pic, extraRels: extraRel('rIdImg', 'image', '../media/image1.png') }],
      media: { 'ppt/media/image1.png': PNG_BYTES },
      extra: {
        'ppt/presentation.xml':
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
          `xmlns:rel="${REL}">` +
          '<p:sldIdLst><p:sldId id="256" rel:id="rId1"/></p:sldIdLst>' +
          '<p:sldSz cx="12192000" cy="6858000"/>' +
          '</p:presentation>',
      },
    });
    const deck = renderDeckHtml(bytes);
    expect(deck.slides).toBe(1);
    expect(deck.rendered).toBe(1);
    expect(deck.html).toContain('src="data:image/png;base64,');
  });
});

describe('picture and table placeholder geometry', () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  it("inherits a picture placeholder's geometry from the layout when the slide's <p:pic> has none of its own", () => {
    const layoutPlaceholders = spShape({
      ph: { type: 'pic', idx: 1 },
      xfrm: xfrmXml(1219200, 685800, 6096000, 3429000), // 10%, 10%, 50%, 50%
    });
    const pic = picShape({ embedId: 'rIdImg', ph: { type: 'pic', idx: 1 } }); // no xfrm at all
    const bytes = buildPptx({
      slides: [{ spTree: pic, extraRels: extraRel('rIdImg', 'image', '../media/image1.png') }],
      layoutPlaceholders,
      media: { 'ppt/media/image1.png': PNG_BYTES },
    });
    const html = renderDeckHtml(bytes).html;
    expect(html).toContain('left:10%;top:10%;width:50%;height:50%');
    expect(html).not.toContain('width:0%');
  });

  it("inherits a table placeholder's geometry from the layout when the <p:graphicFrame> has no <p:xfrm>", () => {
    const layoutPlaceholders = spShape({
      ph: { type: 'body', idx: 1 },
      xfrm: xfrmXml(1219200, 685800, 6096000, 3429000), // 10%, 10%, 50%, 50%
    });
    const tbl =
      '<a:tbl>' +
      '<a:tblGrid><a:gridCol w="1000000"/></a:tblGrid>' +
      `<a:tr h="300000">${tcXml({ text: 'Cell' })}</a:tr>` +
      '</a:tbl>';
    const frame = tableFrameXml({ tblXml: tbl, ph: { type: 'body', idx: 1 } }); // no xfrm at all
    const bytes = buildPptx({ slides: [{ spTree: frame }], layoutPlaceholders });
    const html = renderDeckHtml(bytes).html;
    // The table must still exist at all -- the old bug dropped it entirely,
    // with no placeholder box and nothing to show for it.
    expect(html).toContain('<table class="mc-pptx-shape mc-pptx-table"');
    expect(html).toContain('left:10%;top:10%;width:50%;height:50%');
  });
});

describe('image caching', () => {
  it('renders a media part reused across many slides on every slide, not just until the budget runs out once', () => {
    const LOGO_BYTES = new Uint8Array(200).fill(7);
    const pic = picShape({ embedId: 'rIdImg', xfrm: xfrmXml(0, 0, 500000, 500000) });
    const slideCount = 8;
    const bytes = buildPptx({
      slides: Array.from({ length: slideCount }, () => ({
        spTree: pic,
        extraRels: extraRel('rIdImg', 'image', '../media/logo.png'),
      })),
      media: { 'ppt/media/logo.png': LOGO_BYTES },
    });
    // Enough budget for one encoded copy of the logo but nowhere near eight:
    // without a cache keyed by the target part, each slide re-encodes and
    // re-charges the same bytes, so only the first slide or two would render
    // it before the budget looked spent.
    const html = renderDeckHtml(bytes, { maxMediaBytes: LOGO_BYTES.length + 50 }).html;
    const imgCount = (html.match(/data:image\/png;base64,/g) ?? []).length;
    expect(imgCount).toBe(slideCount);
  });
});

describe('table cell font size', () => {
  it('emits a cell-wide font size when every run in the cell resolves to the same declared size', () => {
    const tc = `<a:tc>${txBodyXml(paraXml({ bullet: 'none', runs: runXml('Cell', 'sz="2800"') }))}</a:tc>`;
    const tbl =
      '<a:tbl>' +
      '<a:tblGrid><a:gridCol w="1000000"/></a:tblGrid>' +
      `<a:tr h="300000">${tc}</a:tr>` +
      '</a:tbl>';
    const frame = tableFrameXml({ xfrm: xfrmXml(0, 0, 6000000, 2000000), tblXml: tbl });
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree: frame }] })).html;
    // 2800 hundredths-of-a-point over the default 960pt-wide slide: 2.9166...cqw.
    // The run itself carries no inline font-size (it agrees with the cell's
    // base size), so the only place this can show up is on the <td> itself.
    expect(html).toContain('<td style="font-size:2.92cqw">Cell</td>');
  });
});

describe('list alignment', () => {
  it("keeps a nested bulleted list's own alignment on its <ul>, not just on each <li>", () => {
    const body = spShape({
      ph: { type: 'body', idx: 1 },
      xfrm: xfrmXml(0, 0, 6000000, 3000000),
      txBody: txBodyXml(
        paraXml({ lvl: 0, bullet: 'char', runs: runXml('Top') }) +
          paraXml({ lvl: 1, bullet: 'char', algn: 'ctr', runs: runXml('Nested') }),
      ),
    });
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree: body }] })).html;
    expect(html).toContain(
      '<li>Top<ul style="text-align:center"><li style="text-align:center">Nested</li></ul></li>',
    );
  });

  it("applies a centred top-level bulleted list's alignment to its own wrapping <ul>", () => {
    const body = spShape({
      ph: { type: 'body', idx: 1 },
      xfrm: xfrmXml(0, 0, 6000000, 3000000),
      txBody: txBodyXml(paraXml({ bullet: 'char', algn: 'ctr', runs: runXml('Item') })),
    });
    const html = renderDeckHtml(buildPptx({ slides: [{ spTree: body }] })).html;
    // The shape collapses to exactly one block, so render.ts's renderTextShape
    // carries the block's own alignment onto the <ul> it wraps the list in,
    // not just onto the <li> inside it.
    expect(html).toMatch(
      /<ul class="mc-pptx-shape mc-pptx-body" style="[^"]*text-align:center[^"]*">/,
    );
  });
});

describe('hostile and malformed input', () => {
  it('refuses a file that is not a zip, naming the older format', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => renderDeckHtml(ole)).toThrow(DeckError);
    expect(() => renderDeckHtml(ole)).toThrow(/\.ppt/);
  });

  it('reports a presentation with no slides rather than rendering nothing', () => {
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      '_rels/.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
          '</Relationships>',
      ),
      'ppt/presentation.xml': strToU8(
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
          '<p:sldIdLst/></p:presentation>',
      ),
    });
    expect(() => renderDeckHtml(bytes)).toThrow(DeckError);
    expect(() => renderDeckHtml(bytes)).toThrow(/no slides/);
  });
});
