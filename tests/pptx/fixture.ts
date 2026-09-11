// Building .pptx fixtures as exact zip bytes.
//
// Hand-authored rather than produced by python-pptx or PowerPoint itself, the
// same reasoning as tests/xlsx/fixture.ts: the bugs this reader has to
// survive are the things a real writer normalizes away -- a shape with no
// <a:xfrm> that must inherit one, a merged table cell, a colour that only
// resolves through a master's <p:clrMap>, a slide order that disagrees with
// slide*.xml filenames. A library would never produce most of these.
import { strToU8, zipSync } from 'fflate';

const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Office's own default theme colours, so a test that does not care about
// colour still resolves every scheme name to something real.
const DEFAULT_THEME_COLORS =
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>';

const DEFAULT_CLR_MAP_ATTRS =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
  'hlink="hlink" folHlink="folHlink"';

export interface PptxSlideSpec {
  /** Inner XML of this slide's <p:spTree>, beyond the nvGrpSpPr/grpSpPr boilerplate this adds. */
  spTree?: string;
  /** Inner XML of this slide's notesSlide <p:spTree>, if it should have notes at all. */
  notes?: string;
  /** Extra raw <Relationship> entries for this slide's own .rels (an image embed, say). */
  extraRels?: string;
}

export interface PptxSpec {
  slides: PptxSlideSpec[];
  sldSz?: { cx: number; cy: number };
  /** Placeholder <p:sp> elements for the layout's spTree, verbatim. */
  layoutPlaceholders?: string;
  /** Placeholder <p:sp> elements for the master's spTree, verbatim. */
  masterPlaceholders?: string;
  clrMapAttrs?: string;
  /** Inner XML of <a:clrScheme>, verbatim. */
  themeColors?: string;
  /** Inner XML of the master's <p:txStyles> (its titleStyle/bodyStyle/otherStyle), verbatim. */
  masterTxStyles?: string;
  /** Inner XML of the presentation's <p:defaultTextStyle>, verbatim. */
  defaultTextStyle?: string;
  /** Media parts by full zip path, e.g. "ppt/media/image1.png". */
  media?: Record<string, Uint8Array>;
  /** Extra parts, or overrides, keyed by zip path. */
  extra?: Record<string, string>;
}

export function buildPptx(spec: PptxSpec): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string): void => {
    files[path] = strToU8(text);
  };

  put(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Default Extension="emf" ContentType="image/x-emf"/>' +
      '</Types>',
  );

  put(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
      '</Relationships>',
  );

  const sldSz = spec.sldSz ?? { cx: 12192000, cy: 6858000 };
  const sldIdEntries = spec.slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join('');
  const defaultTextStyle =
    spec.defaultTextStyle === undefined
      ? ''
      : `<p:defaultTextStyle>${spec.defaultTextStyle}</p:defaultTextStyle>`;
  put(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P_NS} ${R_NS}>` +
      `<p:sldIdLst>${sldIdEntries}</p:sldIdLst>` +
      `<p:sldSz cx="${sldSz.cx}" cy="${sldSz.cy}"/>` +
      defaultTextStyle +
      '</p:presentation>',
  );

  const presRels = spec.slides
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join('');
  put(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      presRels +
      '</Relationships>',
  );

  put(
    'ppt/theme/theme1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><a:theme ${A_NS} name="Test">` +
      `<a:themeElements><a:clrScheme name="Test">${spec.themeColors ?? DEFAULT_THEME_COLORS}</a:clrScheme></a:themeElements>` +
      '</a:theme>',
  );

  const txStyles =
    spec.masterTxStyles === undefined ? '' : `<p:txStyles>${spec.masterTxStyles}</p:txStyles>`;
  put(
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster ${P_NS} ${A_NS} ${R_NS}>` +
      '<p:cSld><p:spTree>' +
      spTreeBoilerplate() +
      (spec.masterPlaceholders ?? '') +
      '</p:spTree></p:cSld>' +
      `<p:clrMap ${spec.clrMapAttrs ?? DEFAULT_CLR_MAP_ATTRS}/>` +
      txStyles +
      '</p:sldMaster>',
  );
  put(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relsXml([rel('rId1', 'theme', '../theme/theme1.xml')]),
  );

  put(
    'ppt/slideLayouts/slideLayout1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout ${P_NS} ${A_NS} ${R_NS}>` +
      '<p:cSld><p:spTree>' +
      spTreeBoilerplate() +
      (spec.layoutPlaceholders ?? '') +
      '</p:spTree></p:cSld>' +
      '</p:sldLayout>',
  );
  put(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    relsXml([rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')]),
  );

  spec.slides.forEach((s, i) => {
    const n = i + 1;
    put(
      `ppt/slides/slide${n}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P_NS} ${A_NS} ${R_NS}>` +
        '<p:cSld><p:spTree>' +
        spTreeBoilerplate() +
        (s.spTree ?? '') +
        '</p:spTree></p:cSld>' +
        '</p:sld>',
    );

    const relEntries = [rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')];
    if (s.notes !== undefined) {
      relEntries.push(rel('rIdNotes', 'notesSlide', `../notesSlides/notesSlide${n}.xml`));
      put(
        `ppt/notesSlides/notesSlide${n}.xml`,
        `<?xml version="1.0" encoding="UTF-8"?><p:notes ${P_NS} ${A_NS} ${R_NS}>` +
          '<p:cSld><p:spTree>' +
          spTreeBoilerplate() +
          s.notes +
          '</p:spTree></p:cSld>' +
          '</p:notes>',
      );
    }
    put(`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(relEntries, s.extraRels ?? ''));
  });

  for (const [path, bytes] of Object.entries(spec.media ?? {})) {
    files[path] = bytes;
  }
  for (const [path, text] of Object.entries(spec.extra ?? {})) {
    put(path, text);
  }

  return zipSync(files);
}

function spTreeBoilerplate(): string {
  return (
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  );
}

interface RelEntry {
  id: string;
  type: string;
  target: string;
}

function rel(id: string, type: string, target: string): RelEntry {
  return { id, type, target };
}

function relsXml(entries: RelEntry[], extraRaw = ''): string {
  const body =
    entries
      .map((e) => `<Relationship Id="${e.id}" Type="${REL}/${e.type}" Target="${e.target}"/>`)
      .join('') + extraRaw;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    body +
    '</Relationships>'
  );
}

/** A raw external <Relationship> entry, for a slide's extraRels. */
export function extraRel(id: string, type: string, target: string): string {
  return `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;
}

// ---------------------------------------------------------------------------
// Shape XML fragments. Kept intentionally low-level (callers assemble a full
// <p:sp>/<p:pic>/<p:graphicFrame> themselves) the same way tests/xlsx/fixture.ts's
// row()/sheetData() only cover the repetitive boilerplate and leave the part
// under test spelled out at the call site.
// ---------------------------------------------------------------------------

export function xfrmXml(x: number, y: number, cx: number, cy: number, attrs = ''): string {
  return `<a:xfrm${attrs ? ' ' + attrs : ''}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

export function spShape(opts: {
  id?: number;
  name?: string;
  ph?: { type?: string; idx?: number };
  xfrm?: string;
  txBody?: string;
}): string {
  const phAttrs =
    (opts.ph?.type !== undefined ? ` type="${opts.ph.type}"` : '') +
    (opts.ph?.idx !== undefined ? ` idx="${opts.ph.idx}"` : '');
  const phXml = opts.ph !== undefined ? `<p:ph${phAttrs}/>` : '';
  return (
    '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${opts.id ?? 2}" name="${opts.name ?? 'Shape'}"/><p:cNvSpPr/>` +
    `<p:nvPr>${phXml}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${opts.xfrm ?? ''}</p:spPr>` +
    (opts.txBody ?? '') +
    '</p:sp>'
  );
}

export function txBodyXml(paragraphsXml: string, lstStyleXml = ''): string {
  return `<p:txBody><a:bodyPr/><a:lstStyle>${lstStyleXml}</a:lstStyle>${paragraphsXml}</p:txBody>`;
}

/** One level entry (1-based element name, 0-based `level` arg) for an `<a:lstStyle>` or `<p:titleStyle>`/`<p:bodyStyle>`/`<p:otherStyle>`/`<p:defaultTextStyle>`. */
export function lvlPPrXml(level: number, defRPrAttrs = ''): string {
  return `<a:lvl${level + 1}pPr><a:defRPr${defRPrAttrs ? ' ' + defRPrAttrs : ''}/></a:lvl${level + 1}pPr>`;
}

export function paraXml(opts: {
  lvl?: number;
  bullet?: 'none' | 'char' | 'autoNum';
  runs?: string;
}): string {
  const lvlAttr = opts.lvl ? ` lvl="${opts.lvl}"` : '';
  let buXml = '';
  if (opts.bullet === 'none') {
    buXml = '<a:buNone/>';
  } else if (opts.bullet === 'char') {
    buXml = '<a:buChar char="&#8226;"/>';
  } else if (opts.bullet === 'autoNum') {
    buXml = '<a:buAutoNum type="arabicPeriod"/>';
  }
  const pPr = lvlAttr || buXml ? `<a:pPr${lvlAttr}>${buXml}</a:pPr>` : '';
  return `<a:p>${pPr}${opts.runs ?? ''}</a:p>`;
}

export function runXml(text: string, rPrAttrs = '', rPrChildren = ''): string {
  const rPr =
    rPrAttrs || rPrChildren ? `<a:rPr${rPrAttrs ? ' ' + rPrAttrs : ''}>${rPrChildren}</a:rPr>` : '';
  return `<a:r>${rPr}<a:t>${text}</a:t></a:r>`;
}

export function picShape(opts: {
  name?: string;
  embedId: string;
  xfrm: string;
  descr?: string;
}): string {
  return (
    '<p:pic>' +
    `<p:nvPicPr><p:cNvPr id="3" name="${opts.name ?? 'Pic'}"${opts.descr ? ` descr="${opts.descr}"` : ''}/>` +
    '<p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${opts.embedId}"/><a:stretch/></p:blipFill>` +
    `<p:spPr>${opts.xfrm}</p:spPr>` +
    '</p:pic>'
  );
}

export function tcXml(opts: {
  gridSpan?: number;
  rowSpan?: number;
  hMerge?: boolean;
  vMerge?: boolean;
  text?: string;
}): string {
  const attrs =
    (opts.gridSpan ? ` gridSpan="${opts.gridSpan}"` : '') +
    (opts.rowSpan ? ` rowSpan="${opts.rowSpan}"` : '') +
    (opts.hMerge ? ' hMerge="1"' : '') +
    (opts.vMerge ? ' vMerge="1"' : '');
  const body = txBodyXml(paraXml({ runs: opts.text !== undefined ? runXml(opts.text) : '' }));
  return `<a:tc${attrs}>${body}</a:tc>`;
}

export function tableFrameXml(opts: { xfrm: string; tblXml: string }): string {
  return (
    '<p:graphicFrame>' +
    '<p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    opts.xfrm +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    opts.tblXml +
    '</a:graphicData></a:graphic>' +
    '</p:graphicFrame>'
  );
}
