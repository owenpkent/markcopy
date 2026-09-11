// Assembling the OPC container a .pptx actually is.
//
// The sibling of src/docx/package.ts, and the reason the design doc calls out
// PowerPoint as the stricter reader: a .docx tolerates a part Word does not
// recognize, a .pptx does not tolerate a *missing* one. A slide with no master,
// a master with no clrMap, a relationship id nothing points at -- each of those
// is "PowerPoint found a problem with content" rather than a document that
// opens with something merely wrong on the page. So every part this writes is
// one the presentation actually needs, and every one of those is written.
import { strToU8, zipSync } from 'fflate';
import { escapeAttr, escapeXml, XML_DECL } from '../../ooxml/write';
import { SLIDE_SIZES, type BuiltSlide, type MediaPart, type SlideRel } from './build';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

export interface PackageInput {
  slides: BuiltSlide[];
  media: MediaPart[];
  title: string;
  /** ISO timestamp for the document properties. */
  created: string;
  slideSize: '16:9' | '4:3';
}

export function buildPackage(input: PackageInput): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(input.slides.length)),
    '_rels/.rels': strToU8(rootRels()),
    'docProps/core.xml': strToU8(coreProps(input.title, input.created)),
    'ppt/presentation.xml': strToU8(presentationXml(input.slides.length, input.slideSize)),
    'ppt/_rels/presentation.xml.rels': strToU8(presentationRels(input.slides.length)),
    'ppt/slideMasters/slideMaster1.xml': strToU8(SLIDE_MASTER_XML),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(slideMasterRels()),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(SLIDE_LAYOUT_XML),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(slideLayoutRels()),
    'ppt/theme/theme1.xml': strToU8(THEME_XML),
  };

  input.slides.forEach((slide, i) => {
    const n = i + 1;
    files[`ppt/slides/slide${n}.xml`] = strToU8(slideXml(slide.bodyXml));
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(slideRels(slide.rels));
  });
  for (const part of input.media) {
    files[`ppt/media/${part.name}`] = part.bytes;
  }

  return zipSync(files, { level: 6 });
}

// ---------------------------------------------------------------------------
// Content types, rels, properties
// ---------------------------------------------------------------------------

function contentTypes(slideCount: number): string {
  const slideOverrides = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml"` +
      ' ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
  ).join('');
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Default Extension="gif" ContentType="image/gif"/>' +
    '<Override PartName="/ppt/presentation.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    slideOverrides +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml"' +
    ' ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>'
  );
}

function rootRels(): string {
  return (
    XML_DECL +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="ppt/presentation.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"' +
    ' Target="docProps/core.xml"/>' +
    '</Relationships>'
  );
}

/** Same properties docx/package.ts writes; PowerPoint's Backstage reads them the same way Word's does. */
function coreProps(title: string, created: string): string {
  return (
    XML_DECL +
    '<cp:coreProperties' +
    ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    '<dc:creator>MarkCopy</dc:creator>' +
    '<cp:lastModifiedBy>MarkCopy</cp:lastModifiedBy>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(created)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(created)}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const NS =
  ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ` xmlns:r="${REL_NS}"` +
  ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function presentationXml(slideCount: number, slideSize: '16:9' | '4:3'): string {
  const { cx, cy } = SLIDE_SIZES[slideSize];
  const sldIds = Array.from(
    { length: slideCount },
    // Ids have to start at 256; PowerPoint accepts any value at or above that
    // as long as every one in the list is unique.
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`,
  ).join('');
  return (
    XML_DECL +
    `<p:presentation${NS}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${cx}" cy="${cy}"/>` +
    // The notes page size PowerPoint falls back to; nothing here emits notes,
    // but a presentation without a notesSz at all is not a value the schema
    // allows to be absent once other tools have touched the file, so this
    // stays fixed at PowerPoint's own default (a portrait Letter page).
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>'
  );
}

function presentationRels(slideCount: number): string {
  const slideRelsXml = Array.from(
    { length: slideCount },
    (_, i) =>
      `<Relationship Id="rId${i + 2}" Type="${REL_NS}/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join('');
  const themeId = slideCount + 2;
  return (
    XML_DECL +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    slideRelsXml +
    `<Relationship Id="rId${themeId}" Type="${REL_NS}/theme" Target="theme/theme1.xml"/>` +
    '</Relationships>'
  );
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

function slideXml(spTree: string): string {
  return (
    XML_DECL +
    `<p:sld${NS}>` +
    `<p:cSld>${spTree}</p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:sld>'
  );
}

function slideRels(rels: SlideRel[]): string {
  const extra = rels
    .map((rel) => {
      // A hyperlink target is an absolute URL the package does not own, so it
      // needs TargetMode="External" -- without it PowerPoint resolves the
      // href as a path inside the .pptx itself and the link goes nowhere.
      const mode = rel.external ? ' TargetMode="External"' : '';
      return (
        `<Relationship Id="${escapeAttr(rel.id)}" Type="${REL_NS}/${rel.kind}"` +
        ` Target="${escapeAttr(rel.target)}"${mode}/>`
      );
    })
    .join('');
  return (
    XML_DECL +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    extra +
    '</Relationships>'
  );
}

// ---------------------------------------------------------------------------
// Master, layout, theme -- fixed, so each is a single constant string
// ---------------------------------------------------------------------------

function slideMasterRels(): string {
  return (
    XML_DECL +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_NS}/theme" Target="../theme/theme1.xml"/>` +
    '</Relationships>'
  );
}

function slideLayoutRels(): string {
  return (
    XML_DECL +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
    '</Relationships>'
  );
}

const EMPTY_SP_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree>';

/**
 * <p:clrMap> is not decoration: CT_SlideMaster requires it, and it is what
 * tells every slide which theme color a placeholder's "background 1" or
 * "text 2" actually resolves to. Getting it wrong is invisible until a slide
 * that inherits colors from the master renders in the wrong ones.
 */
const SLIDE_MASTER_XML =
  XML_DECL +
  `<p:sldMaster${NS}>` +
  `<p:cSld>${EMPTY_SP_TREE}</p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"' +
  ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"' +
  ' hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '</p:sldMaster>';

const SLIDE_LAYOUT_XML =
  XML_DECL +
  `<p:sldLayout${NS} type="obj" preserve="1">` +
  `<p:cSld name="Title and Content">${EMPTY_SP_TREE}</p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
  '</p:sldLayout>';

/**
 * A complete theme, kept as one constant: PowerPoint rejects a partial
 * clrScheme/fontScheme/fmtScheme outright rather than filling in a default,
 * so there is no smaller version of this that still opens.
 */
const THEME_XML =
  XML_DECL +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MarkCopy">' +
  '<a:themeElements>' +
  '<a:clrScheme name="MarkCopy">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F2328"/></a:dk2>' +
  '<a:lt2><a:srgbClr val="D0D7DE"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="0969DA"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="CF222E"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="1A7F37"/></a:accent3>' +
  '<a:accent4><a:srgbClr val="9A6700"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="8250DF"/></a:accent5>' +
  '<a:accent6><a:srgbClr val="BF3989"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0969DA"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="8250DF"/></a:folHlink>' +
  '</a:clrScheme>' +
  '<a:fontScheme name="MarkCopy">' +
  '<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme>' +
  '<a:fmtScheme name="MarkCopy">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="110000"/></a:schemeClr></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="105000"/></a:schemeClr></a:solidFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/>' +
  '</a:ln>' +
  '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr">' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/>' +
  '</a:ln>' +
  '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr">' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/>' +
  '</a:ln>' +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="105000"/></a:schemeClr></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="102000"/></a:schemeClr></a:solidFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme>' +
  '</a:themeElements>' +
  '</a:theme>';
