// Assembling the OPC container a .docx actually is.
//
// A .docx is a zip of XML parts wired together by relationship files. Nothing
// here is generated from the document except document.xml, its relationships,
// the numbering instances and the media: styles.xml is a fixed stylesheet chosen
// to land close to the preview's GitHub palette, so what someone reads in the
// tab and what they open in Word look like the same document.
//
// fflate writes the zip. It is already a dependency for reading .xlsx
// (src/xlsx/zip.ts), and an OOXML package is the same container in the other
// direction, so the export adds no new one.
import { strToU8, zipSync } from 'fflate';
import { escapeAttr, escapeXml, XML_DECL } from './ooxml';
import type { DocRel, MediaPart, NumInstance } from './build';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

export interface PackageInput {
  bodyXml: string;
  media: MediaPart[];
  rels: DocRel[];
  nums: NumInstance[];
  title: string;
  /** ISO timestamp for the document properties. */
  created: string;
}

export function buildPackage(input: PackageInput): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes()),
    '_rels/.rels': strToU8(rootRels()),
    'docProps/core.xml': strToU8(coreProps(input.title, input.created)),
    'word/document.xml': strToU8(documentXml(input.bodyXml)),
    'word/_rels/document.xml.rels': strToU8(documentRels(input.rels)),
    'word/styles.xml': strToU8(STYLES_XML),
    'word/numbering.xml': strToU8(numberingXml(input.nums)),
  };
  for (const part of input.media) {
    files[`word/media/${part.name}`] = part.bytes;
  }
  return zipSync(files, { level: 6 });
}

function contentTypes(): string {
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Default Extension="gif" ContentType="image/gif"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>'
  );
}

function rootRels(): string {
  return (
    XML_DECL +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"' +
    ' Target="docProps/core.xml"/>' +
    '</Relationships>'
  );
}

/**
 * Document properties.
 *
 * The title is not decoration: Word's Accessibility Checker flags a document
 * without one, and assistive software reads it when announcing the file.
 */
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

function documentXml(body: string): string {
  return (
    XML_DECL +
    '<w:document' +
    ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ` xmlns:r="${REL_NS}"` +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' +
    body +
    // Letter portrait, 1" margins. The builder sizes images and table grids
    // against the 9360-twip text column this produces.
    '<w:sectPr>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"' +
    ' w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr>' +
    '</w:body>' +
    '</w:document>'
  );
}

function documentRels(rels: DocRel[]): string {
  // rId1 and rId2 are reserved for the two fixed parts; the builder mints
  // everything else from rId3 up.
  const fixed =
    `<Relationship Id="rId1" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_NS}/numbering" Target="numbering.xml"/>`;
  const rest = rels
    .map((rel) => {
      const mode = rel.external ? ' TargetMode="External"' : '';
      return (
        `<Relationship Id="${escapeAttr(rel.id)}" Type="${REL_NS}/${rel.kind}"` +
        ` Target="${escapeAttr(rel.target)}"${mode}/>`
      );
    })
    .join('');
  return XML_DECL + `<Relationships xmlns="${PKG_REL_NS}">${fixed}${rest}</Relationships>`;
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

/** Word's default bullet cycle, with the font each glyph belongs to. */
const BULLETS = [
  { char: '\uF0B7', font: 'Symbol' },
  { char: 'o', font: 'Courier New' },
  { char: '\uF0A7', font: 'Wingdings' },
];

/** Word's default ordered cycle. */
const ORDERED = ['decimal', 'lowerLetter', 'lowerRoman'];

function numberingXml(nums: NumInstance[]): string {
  const levels = (build: (lvl: number) => string): string =>
    Array.from({ length: 9 }, (_, lvl) => build(lvl)).join('');

  const bulletLevels = levels((lvl) => {
    const bullet = BULLETS[lvl % BULLETS.length];
    return (
      `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
      `<w:lvlText w:val="${escapeAttr(bullet.char)}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 * (lvl + 1)}" w:hanging="360"/></w:pPr>` +
      `<w:rPr><w:rFonts w:ascii="${bullet.font}" w:hAnsi="${bullet.font}" w:hint="default"/></w:rPr>` +
      '</w:lvl>'
    );
  });

  const decimalLevels = levels((lvl) => {
    const format = ORDERED[lvl % ORDERED.length];
    return (
      `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
      `<w:lvlText w:val="%${lvl + 1}."/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 * (lvl + 1)}" w:hanging="360"/></w:pPr>` +
      '</w:lvl>'
    );
  });

  // One <w:num> per list in the document. Numbering state belongs to the
  // instance, not the abstract definition, so an explicit startOverride is what
  // makes the second ordered list on a page begin at 1 again instead of
  // continuing from where the first left off.
  const instances = nums
    .map((num) => {
      const override =
        num.abstractNumId === 1
          ? `<w:lvlOverride w:ilvl="${num.ilvl}"><w:startOverride w:val="${num.start}"/></w:lvlOverride>`
          : '';
      return (
        `<w:num w:numId="${num.numId}">` +
        `<w:abstractNumId w:val="${num.abstractNumId}"/>${override}</w:num>`
      );
    })
    .join('');

  return (
    XML_DECL +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    bulletLevels +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    decimalLevels +
    '</w:abstractNum>' +
    instances +
    '</w:numbering>'
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
//
// Sizes are half-points (sz 22 = 11pt), spacing is twentieths of a point. The
// palette is the preview's GitHub-light one, so the exported document is
// recognizably the same document that was on screen.
//
// The `w:name` of each style is the *built-in* Word name ("heading 1", not
// "Heading 1"). That is what makes Word treat these as its own styles rather
// than as look-alikes, which in turn is what puts headings in the Navigation
// Pane and lets a screen reader offer heading-to-heading movement.

const FG = '1F2328';
const MUTED = '59636E';
const BORDER = 'D0D7DE';
const CODE_BG = 'F6F8FA';
const LINK = '0969DA';
const MONO = 'Consolas';

function heading(level: number, size: number, rule: boolean): string {
  const border = rule
    ? `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="${BORDER}"/></w:pBdr>`
    : '';
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
    '<w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:keepLines/>' +
    border +
    '<w:spacing w:before="480" w:after="160"/>' +
    `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:color w:val="${level === 6 ? MUTED : FG}"/><w:sz w:val="${size}"/></w:rPr>` +
    '</w:style>'
  );
}

const STYLES_XML =
  XML_DECL +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  // Document defaults. The language tag is here rather than per-run because a
  // screen reader picks its voice from it, and getting it wrong makes an entire
  // document unintelligible.
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
  `<w:color w:val="${FG}"/><w:sz w:val="22"/><w:szCs w:val="22"/>` +
  '<w:lang w:val="en-US"/>' +
  '</w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
  '<w:name w:val="Normal"/><w:qFormat/></w:style>' +
  heading(1, 40, true) +
  heading(2, 32, true) +
  heading(3, 26, false) +
  heading(4, 22, false) +
  heading(5, 21, false) +
  heading(6, 20, false) +
  // Blockquote: GitHub's left rule and muted text.
  '<w:style w:type="paragraph" w:styleId="Quote">' +
  '<w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  `<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="${BORDER}"/></w:pBdr>` +
  '<w:ind w:left="360"/></w:pPr>' +
  `<w:rPr><w:color w:val="${MUTED}"/></w:rPr></w:style>` +
  // Code block: one paragraph per line, so the shading has to be per paragraph.
  // Consecutive lines then read as a single block.
  '<w:style w:type="paragraph" w:styleId="HTMLPreformatted">' +
  '<w:name w:val="HTML Preformatted"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
  `<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="${CODE_BG}"/>` +
  '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr>' +
  `<w:rPr><w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:cs="${MONO}"/>` +
  '<w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:styleId="HTMLCode">' +
  '<w:name w:val="HTML Code"/><w:qFormat/>' +
  `<w:rPr><w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:cs="${MONO}"/>` +
  `<w:sz w:val="20"/><w:szCs w:val="20"/>` +
  `<w:shd w:val="clear" w:color="auto" w:fill="${CODE_BG}"/></w:rPr></w:style>` +
  '<w:style w:type="character" w:styleId="Hyperlink">' +
  '<w:name w:val="Hyperlink"/>' +
  `<w:rPr><w:color w:val="${LINK}"/><w:u w:val="single"/></w:rPr></w:style>` +
  '<w:style w:type="paragraph" w:styleId="ListParagraph">' +
  '<w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="0"/><w:contextualSpacing/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Caption">' +
  '<w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:before="0" w:after="200"/><w:jc w:val="center"/></w:pPr>' +
  `<w:rPr><w:i/><w:color w:val="${MUTED}"/><w:sz w:val="18"/></w:rPr></w:style>` +
  // A thematic break has no element of its own in WordprocessingML; the
  // convention is an empty paragraph wearing a bottom border.
  '<w:style w:type="paragraph" w:styleId="HorizontalRule">' +
  '<w:name w:val="Horizontal Rule"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
  `<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${BORDER}"/></w:pBdr>` +
  '<w:spacing w:before="240" w:after="240"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="DefinitionTerm">' +
  '<w:name w:val="Definition Term"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
  '<w:pPr><w:keepNext/><w:spacing w:after="0"/></w:pPr>' +
  '<w:rPr><w:b/></w:rPr></w:style>' +
  // Table cell paragraphs: no space after, or every row grows by 8pt.
  '<w:style w:type="paragraph" w:styleId="TableText">' +
  '<w:name w:val="Table Text"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="TableHeader">' +
  '<w:name w:val="Table Header"/><w:basedOn w:val="TableText"/>' +
  '<w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/></w:rPr></w:style>' +
  '<w:style w:type="table" w:styleId="TableGrid">' +
  '<w:name w:val="Table Grid"/>' +
  '<w:tblPr><w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="${BORDER}"/>`)
    .join('') +
  '</w:tblBorders>' +
  '<w:tblCellMar>' +
  '<w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
  '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>' +
  '</w:tblCellMar></w:tblPr>' +
  // Shade the header row through the style's conditional formatting, so it
  // follows the <w:tblLook w:firstRow="1"> the builder writes.
  '<w:tblStylePr w:type="firstRow"><w:tcPr>' +
  `<w:shd w:val="clear" w:color="auto" w:fill="${CODE_BG}"/>` +
  '</w:tcPr></w:tblStylePr>' +
  '</w:style>' +
  '</w:styles>';
