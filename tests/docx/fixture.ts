// Building .docx fixtures as exact zip bytes.
//
// Hand-authored rather than produced by Word or the repo's own writer, for the
// reason tests/pptx/fixture.ts gives: the inputs this reader has to survive are
// the shapes real files take and a writer normalizes away (a heading known only
// through a basedOn chain, a field whose result is split across runs, a
// relationship id with no relationship). Each test spells out only the XML
// under test.
import { strToU8, unzipSync, zipSync } from 'fflate';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml"';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export interface DocxSpec {
  /** Inner XML of `<w:body>`. */
  body: string;
  /** Inner XML of `<w:styles>`. Omit for no styles part at all. */
  styles?: string;
  /** Inner XML of `<w:numbering>`. Omit for no numbering part at all. */
  numbering?: string;
  /** Raw `<Relationship>` entries for word/_rels/document.xml.rels. */
  rels?: string;
  /** Inner XML of `<w:footnotes>`, after the two separator notes. */
  footnotes?: string;
  /** Raw `<Relationship>` entries for word/_rels/footnotes.xml.rels. */
  footnoteRels?: string;
  /** Inner XML of `<w:endnotes>`. */
  endnotes?: string;
  /** Parts by full zip path; media bytes go here. */
  media?: Record<string, Uint8Array>;
  /** Extra or overriding text parts, by zip path. */
  extra?: Record<string, string>;
}

export function buildDocx(spec: DocxSpec): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string): void => {
    files[path] = strToU8(text);
  };

  put(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '</Types>',
  );
  put(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
      '</Relationships>',
  );
  put('word/document.xml', `${XML}<w:document ${NS}><w:body>${spec.body}</w:body></w:document>`);

  const relEntries: string[] = [];
  if (spec.styles !== undefined) {
    put('word/styles.xml', `${XML}<w:styles ${NS}>${spec.styles}</w:styles>`);
    relEntries.push(`<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`);
  }
  if (spec.numbering !== undefined) {
    put('word/numbering.xml', `${XML}<w:numbering ${NS}>${spec.numbering}</w:numbering>`);
    relEntries.push(`<Relationship Id="rIdNum" Type="${REL}/numbering" Target="numbering.xml"/>`);
  }
  if (spec.footnotes !== undefined) {
    put(
      'word/footnotes.xml',
      `${XML}<w:footnotes ${NS}>` +
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
        `${spec.footnotes}</w:footnotes>`,
    );
  }
  if (spec.footnoteRels !== undefined) {
    put(
      'word/_rels/footnotes.xml.rels',
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${spec.footnoteRels}</Relationships>`,
    );
  }
  if (spec.endnotes !== undefined) {
    put('word/endnotes.xml', `${XML}<w:endnotes ${NS}>${spec.endnotes}</w:endnotes>`);
  }
  put(
    'word/_rels/document.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      relEntries.join('') +
      (spec.rels ?? '') +
      '</Relationships>',
  );

  for (const [path, bytes] of Object.entries(spec.media ?? {})) {
    files[path] = bytes;
  }
  for (const [path, text] of Object.entries(spec.extra ?? {})) {
    put(path, text);
  }
  return zipSync(files);
}

/** Build a package, then delete one part outright. */
export function removePart(bytes: Uint8Array, path: string): Uint8Array {
  const files = unzipSync(bytes);
  delete files[path];
  return zipSync(files);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

/** A run holding text, with optional `<w:rPr>` children. */
export function run(text: string, rPr = ''): string {
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

/** A paragraph from run XML (or plain text), with optional `<w:pPr>` children. */
export function para(content: string, pPr = ''): string {
  const inner = content.startsWith('<') ? content : run(content);
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
}

export function style(
  id: string,
  opts: { name?: string; basedOn?: string; pPr?: string; rPr?: string; type?: string } = {},
): string {
  return (
    `<w:style w:type="${opts.type ?? 'paragraph'}" w:styleId="${id}">` +
    `<w:name w:val="${opts.name ?? id}"/>` +
    (opts.basedOn ? `<w:basedOn w:val="${opts.basedOn}"/>` : '') +
    (opts.pPr ? `<w:pPr>${opts.pPr}</w:pPr>` : '') +
    (opts.rPr ? `<w:rPr>${opts.rPr}</w:rPr>` : '') +
    '</w:style>'
  );
}

export function numPr(numId: number | string, ilvl = 0): string {
  return `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
}

/** A single `<w:lvl>`. */
export function lvl(ilvl: number, fmt: string, start = 1): string {
  return `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/></w:lvl>`;
}

/** An abstractNum plus a num that points at it. */
export function list(id: number, levels: string, numOverride = ''): string {
  return (
    `<w:abstractNum w:abstractNumId="${id}">${levels}</w:abstractNum>` +
    `<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/>${numOverride}</w:num>`
  );
}

export function externalRel(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="${REL}/hyperlink" Target="${target}" TargetMode="External"/>`;
}

export function imageRel(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="${REL}/image" Target="${target}"/>`;
}

/** An inline picture. `extent` is in EMU; 9525 EMU is one CSS pixel. */
export function drawing(opts: {
  embed?: string;
  link?: string;
  descr?: string;
  title?: string;
  cx?: number;
  cy?: number;
}): string {
  const blip = opts.link
    ? `<a:blip r:link="${opts.link}"/>`
    : `<a:blip r:embed="${opts.embed ?? 'rIdImg'}"/>`;
  return (
    '<w:r><w:drawing><wp:inline>' +
    `<wp:extent cx="${opts.cx ?? 952500}" cy="${opts.cy ?? 476250}"/>` +
    `<wp:docPr id="1" name="Picture 1"${opts.descr !== undefined ? ` descr="${opts.descr}"` : ''}${opts.title !== undefined ? ` title="${opts.title}"` : ''}/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>${blip}</pic:blipFill></pic:pic>` +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  );
}

/** A 1x1 PNG. */
export const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

export function cell(content: string, tcPr = ''): string {
  return `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${content}</w:tc>`;
}

export function row(cells: string, header = false): string {
  return `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
}

export function table(rows: string): string {
  return `<w:tbl><w:tblPr/><w:tblGrid/>${rows}</w:tbl>`;
}
