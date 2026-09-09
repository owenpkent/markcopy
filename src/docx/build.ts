// The rendered preview's element tree -> the body of word/document.xml.
//
// This is where the accessibility of the export is actually decided, so a few
// mappings are load-bearing rather than cosmetic:
//
//   * headings become the built-in Heading1..6 styles, which carry an outline
//     level, which is what a screen reader and Word's Navigation Pane read to
//     let someone jump between sections instead of arrowing through the prose;
//   * a table's header row gets <w:tblHeader/>, which is how Word marks the row
//     that labels the columns, so a reader hears "Revenue, 4.2m" and not "4.2m";
//   * every image carries `descr` (its alt text) on wp:docPr, and images that
//     have none are counted and reported rather than silently shipped mute;
//   * list items get real numbering, not a bullet character typed into the text,
//     so the list is announced as a list with a position and a count.
//
// A fixed-layout export cannot do any of that, which is the whole reason this
// exists alongside Save as PDF rather than replacing it.
import { hasClass, isElement, textOf, type DocxElement, type DocxNode } from './parse';
import { decodeImage, displayExtent, type DecodedImage } from './media';
import { bookmarkName, CONTENT_WIDTH_TWIPS, escapeAttr, escapeXml } from './ooxml';

/** Elements that break a paragraph. Anything else is inline. */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Abstract numbering definitions declared in numbering.xml. */
const ABSTRACT_BULLET = 0;
const ABSTRACT_DECIMAL = 1;

/** Word ignores list levels past this; deeper nesting flattens onto the last. */
const MAX_LIST_LEVEL = 8;

export interface MediaPart {
  /** Part name inside word/media/, e.g. `image1.png`. */
  name: string;
  bytes: Uint8Array;
}

export interface DocRel {
  id: string;
  /** Relationship kind; the writer maps it to the full schema URI. */
  kind: 'image' | 'hyperlink';
  target: string;
  external?: boolean;
}

export interface NumInstance {
  numId: number;
  abstractNumId: number;
  /** Level the instance is used at, so its start override lands in the right place. */
  ilvl: number;
  start: number;
}

/** What the export learned about the document while converting it. */
export interface DocxReport {
  images: number;
  /** Images with no alt text: the reason a document stops being audible. */
  imagesMissingAlt: number;
  /** Images whose bytes could not be embedded (unreachable remote src, odd format). */
  imagesSkipped: number;
  headings: number;
  tables: number;
}

export interface BuildResult {
  bodyXml: string;
  media: MediaPart[];
  rels: DocRel[];
  nums: NumInstance[];
  report: DocxReport;
}

interface RunFmt {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  sup?: boolean;
  sub?: boolean;
  color?: string;
}

interface BlockCtx {
  /** Paragraph style id applied to plain paragraphs in this container. */
  style?: string;
  /** Extra left indent in twips, for nested quotes and list continuations. */
  indent?: number;
  /** Set on the first paragraph of a list item, then cleared. */
  marker?: { numId: number; ilvl: number };
  /** Nesting depth of the enclosing list, for a nested list's level. */
  listDepth?: number;
  /** HTML id to anchor a bookmark on, so in-document links can reach it. */
  bookmarkId?: string;
}

interface TableCell {
  el: DocxElement;
  colspan: number;
  rowspan: number;
  header: boolean;
  align?: 'left' | 'center' | 'right';
}

interface TableRow {
  cells: TableCell[];
  header: boolean;
}

export function buildDocument(root: DocxElement): BuildResult {
  const builder = new Builder();
  builder.blocks(root.children, {});
  return builder.finish();
}

class Builder {
  private readonly out: string[] = [];
  private readonly media: MediaPart[] = [];
  private readonly rels: DocRel[] = [];
  private readonly nums: NumInstance[] = [];
  /** Data URI -> relationship id, so the same image is stored once. */
  private readonly imageRels = new Map<string, string>();
  private relSeq = 0;
  private bookmarkSeq = 0;
  private drawingSeq = 0;
  private numSeq = 0;
  private readonly report: DocxReport = {
    images: 0,
    imagesMissingAlt: 0,
    imagesSkipped: 0,
    headings: 0,
    tables: 0,
  };

  finish(): BuildResult {
    // A body whose last element is a table confuses Word, and an empty body is
    // not a document at all. One trailing paragraph settles both.
    if (this.out.length === 0 || this.out[this.out.length - 1].startsWith('<w:tbl>')) {
      this.out.push('<w:p/>');
    }
    return {
      bodyXml: this.out.join(''),
      media: this.media,
      rels: this.rels,
      nums: this.nums,
      report: this.report,
    };
  }

  // -------------------------------------------------------------------------
  // Block level
  // -------------------------------------------------------------------------

  /**
   * Convert a run of sibling nodes.
   *
   * Inline nodes accumulate until a block-level element arrives, at which point
   * they are flushed as one paragraph. That is what turns the mixed content a
   * list item or a blockquote holds ("text, then a nested list") into the
   * paragraph-then-block sequence a docx body is made of.
   */
  blocks(nodes: DocxNode[], ctx: BlockCtx): void {
    let pending: DocxNode[] = [];
    const flush = () => {
      if (pending.length > 0) {
        this.paragraph(pending, ctx);
        pending = [];
      }
    };

    for (const node of nodes) {
      if (node.kind === 'text') {
        // Whitespace between two blocks is markup indentation, not content.
        if (pending.length > 0 || node.text.trim() !== '') {
          pending.push(node);
        }
        continue;
      }
      if (skip(node)) {
        continue;
      }
      if (!BLOCK_TAGS.has(node.name)) {
        pending.push(node);
        continue;
      }
      flush();
      this.block(node, ctx);
    }
    flush();
  }

  private block(el: DocxElement, ctx: BlockCtx): void {
    const heading = /^h([1-6])$/.exec(el.name);
    if (heading) {
      this.report.headings++;
      this.paragraph(el.children, {
        ...ctx,
        style: `Heading${heading[1]}`,
        bookmarkId: el.attrs.id,
      });
      return;
    }

    switch (el.name) {
      case 'p':
        this.paragraph(el.children, ctx);
        return;
      case 'pre':
        this.codeBlock(el, ctx);
        return;
      case 'blockquote':
        // The Quote style carries the border and the base indent; nesting adds
        // half an inch per level on top of it.
        this.blocks(el.children, {
          ...ctx,
          style: 'Quote',
          indent: (ctx.indent ?? 0) + (ctx.style === 'Quote' ? 360 : 0),
          marker: ctx.marker,
        });
        return;
      case 'ul':
      case 'ol':
        this.list(el, ctx);
        return;
      case 'li':
        // A stray <li> outside a list: render it as a plain paragraph rather
        // than dropping the text.
        this.blocks(el.children, ctx);
        return;
      case 'hr':
        this.out.push('<w:p><w:pPr><w:pStyle w:val="HorizontalRule"/></w:pPr></w:p>');
        return;
      case 'table':
        this.table(el, ctx);
        return;
      case 'dt':
        this.paragraph(el.children, { ...ctx, style: 'DefinitionTerm' });
        return;
      case 'dd':
        this.paragraph(el.children, { ...ctx, indent: (ctx.indent ?? 0) + 720 });
        return;
      case 'figcaption':
        this.paragraph(el.children, { ...ctx, style: 'Caption' });
        return;
      default:
        // Grouping elements (div, section, figure, details, thead outside a
        // table) contribute nothing of their own; their children are the
        // document.
        this.blocks(el.children, ctx);
    }
  }

  /** One <w:p> from a run of inline nodes, skipped when it would be blank. */
  private paragraph(nodes: DocxNode[], ctx: BlockCtx): void {
    const runs = this.runs(nodes, {});
    if (runs.visible === false && !ctx.bookmarkId) {
      return;
    }

    let inner = runs.xml;
    if (ctx.bookmarkId) {
      const id = this.bookmarkSeq++;
      const name = bookmarkName(ctx.bookmarkId);
      inner =
        `<w:bookmarkStart w:id="${id}" w:name="${escapeAttr(name)}"/>` +
        inner +
        `<w:bookmarkEnd w:id="${id}"/>`;
    }

    this.out.push(`<w:p>${this.paragraphProps(ctx)}${inner}</w:p>`);
    ctx.marker = undefined;
  }

  /** <w:pPr>, with children in the order the schema demands. */
  private paragraphProps(ctx: BlockCtx): string {
    const parts: string[] = [];
    // A list item keeps its own indent from the numbering definition, so the
    // ListParagraph style stands in for whatever style the container asked for.
    const style = ctx.marker ? 'ListParagraph' : ctx.style;
    if (style && style !== 'Normal') {
      parts.push(`<w:pStyle w:val="${style}"/>`);
    }
    if (ctx.marker) {
      parts.push(
        `<w:numPr><w:ilvl w:val="${ctx.marker.ilvl}"/><w:numId w:val="${ctx.marker.numId}"/></w:numPr>`,
      );
    }
    if (ctx.indent) {
      parts.push(`<w:ind w:left="${ctx.indent}"/>`);
    }
    return parts.length === 0 ? '' : `<w:pPr>${parts.join('')}</w:pPr>`;
  }

  /**
   * A fenced code block: one paragraph per line.
   *
   * One paragraph holding <w:br/>s would look identical and read worse; a screen
   * reader treats each paragraph as a stop, which is what makes stepping through
   * code line by line possible at all.
   */
  private codeBlock(el: DocxElement, ctx: BlockCtx): void {
    const lines = codeLines(el);
    lines.forEach((line, i) => {
      const props = this.paragraphProps({
        ...ctx,
        style: 'HTMLPreformatted',
        marker: i === 0 ? ctx.marker : undefined,
      });
      const runs =
        line.length === 0
          ? ''
          : line
              .map((piece) =>
                this.textRun(piece.text, {
                  code: true,
                  color: piece.color,
                }),
              )
              .join('');
      this.out.push(`<w:p>${props}${runs}</w:p>`);
    });
    if (lines.length > 0) {
      ctx.marker = undefined;
    }
  }

  private list(el: DocxElement, ctx: BlockCtx): void {
    const ordered = el.name === 'ol';
    const depth = Math.min(ctx.listDepth ?? 0, MAX_LIST_LEVEL);
    const start = Number.parseInt(el.attrs.start ?? '1', 10) || 1;

    // A fresh numbering instance per list element, not per document. Two lists
    // sharing one instance would number continuously across the prose between
    // them, and a nested <ol> inside a <ul> needs a decimal definition at the
    // nested level, which a single instance cannot express.
    const numId = ++this.numSeq;
    this.nums.push({
      numId,
      abstractNumId: ordered ? ABSTRACT_DECIMAL : ABSTRACT_BULLET,
      ilvl: depth,
      start: ordered ? start : 1,
    });

    for (const child of el.children) {
      if (!isElement(child) || skip(child)) {
        continue;
      }
      if (child.name === 'li') {
        this.listItem(child, ctx, numId, depth);
      } else {
        // Malformed list markup: keep the content rather than the structure.
        this.block(child, ctx);
      }
    }
  }

  private listItem(li: DocxElement, ctx: BlockCtx, numId: number, depth: number): void {
    const itemCtx: BlockCtx = {
      style: ctx.style,
      // Content after the first paragraph lines up under the marker rather than
      // falling back to the margin.
      indent: undefined,
      marker: { numId, ilvl: depth },
      listDepth: depth + 1,
    };
    this.blocks(li.children, itemCtx);
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  private table(el: DocxElement, ctx: BlockCtx): void {
    const rows = collectRows(el);
    if (rows.length === 0) {
      return;
    }
    this.report.tables++;

    const cols = Math.max(
      1,
      ...rows.map((row) => row.cells.reduce((sum, cell) => sum + cell.colspan, 0)),
    );
    const colWidth = Math.floor(CONTENT_WIDTH_TWIPS / cols);

    const parts: string[] = [
      '<w:tbl>',
      '<w:tblPr>',
      '<w:tblStyle w:val="TableGrid"/>',
      '<w:tblW w:w="0" w:type="auto"/>',
      '<w:tblLayout w:type="autofit"/>',
      // firstRow="1" is what tells Word's table style to band and bold the
      // header; it pairs with the <w:tblHeader/> written on the row itself.
      '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0"' +
        ' w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>',
      '</w:tblPr>',
      '<w:tblGrid>',
      ...Array.from({ length: cols }, () => `<w:gridCol w:w="${colWidth}"/>`),
      '</w:tblGrid>',
    ];

    // Cells that a rowspan carries into later rows, keyed by their start column.
    const carry = new Map<number, { left: number; span: number }>();

    for (const row of rows) {
      const cells: string[] = [];
      const queue = [...row.cells];
      let col = 0;

      while (col < cols) {
        const carried = carry.get(col);
        if (carried) {
          cells.push(this.tableCell(undefined, carried.span, colWidth, row.header, 'continue'));
          if (--carried.left === 0) {
            carry.delete(col);
          }
          col += carried.span;
          continue;
        }
        const cell = queue.shift();
        if (!cell) {
          cells.push(this.tableCell(undefined, 1, colWidth, row.header));
          col += 1;
          continue;
        }
        const span = Math.max(1, Math.min(cell.colspan, cols - col));
        if (cell.rowspan > 1) {
          carry.set(col, { left: cell.rowspan - 1, span });
        }
        cells.push(
          this.tableCell(
            cell,
            span,
            colWidth,
            row.header,
            cell.rowspan > 1 ? 'restart' : undefined,
          ),
        );
        col += span;
      }

      // <w:tblHeader/> is the accessibility bit: it marks the row as the one
      // that labels the columns, and Word repeats it across page breaks.
      const trPr = row.header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      parts.push(`<w:tr>${trPr}${cells.join('')}</w:tr>`);
    }

    parts.push('</w:tbl>');
    this.out.push(parts.join(''));
    // Word needs a paragraph between a table and whatever follows it.
    this.out.push('<w:p/>');
    ctx.marker = undefined;
  }

  private tableCell(
    cell: TableCell | undefined,
    span: number,
    colWidth: number,
    headerRow: boolean,
    vMerge?: 'restart' | 'continue',
  ): string {
    const props: string[] = [`<w:tcW w:w="${colWidth * span}" w:type="dxa"/>`];
    if (span > 1) {
      props.push(`<w:gridSpan w:val="${span}"/>`);
    }
    if (vMerge === 'restart') {
      props.push('<w:vMerge w:val="restart"/>');
    } else if (vMerge === 'continue') {
      props.push('<w:vMerge/>');
    }
    props.push('<w:vAlign w:val="top"/>');

    // Every <w:tc> must hold at least one paragraph, empty or not.
    let body = '<w:p/>';
    if (cell && vMerge !== 'continue') {
      const nested = new Builder();
      nested.adopt(this);
      nested.blocks(cell.el.children, {
        style: cell.header || headerRow ? 'TableHeader' : 'TableText',
      });
      const result = nested.finish();
      this.absorb(nested, result);
      body = result.bodyXml.trim() === '' ? '<w:p/>' : result.bodyXml;
      if (cell.align && cell.align !== 'left') {
        body = alignParagraphs(body, cell.align);
      }
    }

    return `<w:tc><w:tcPr>${props.join('')}</w:tcPr>${body}</w:tc>`;
  }

  /** Share the parent's id counters so a nested builder mints unique ids. */
  private adopt(parent: Builder): void {
    this.relSeq = parent.relSeq;
    this.bookmarkSeq = parent.bookmarkSeq;
    this.drawingSeq = parent.drawingSeq;
    this.numSeq = parent.numSeq;
    for (const [uri, id] of parent.imageRels) {
      this.imageRels.set(uri, id);
    }
  }

  /** Take back everything a nested builder created, counters included. */
  private absorb(child: Builder, result: BuildResult): void {
    this.relSeq = child.relSeq;
    this.bookmarkSeq = child.bookmarkSeq;
    this.drawingSeq = child.drawingSeq;
    this.numSeq = child.numSeq;
    for (const [uri, id] of child.imageRels) {
      this.imageRels.set(uri, id);
    }
    // A nested builder only ever holds relationships and media the parent has
    // not seen: `adopt` copied the image map across, so a repeat is deduped
    // there and never reaches this list.
    this.media.push(...result.media);
    this.rels.push(...result.rels);
    this.nums.push(...result.nums);
    this.report.images += result.report.images;
    this.report.imagesMissingAlt += result.report.imagesMissingAlt;
    this.report.imagesSkipped += result.report.imagesSkipped;
    this.report.headings += result.report.headings;
    this.report.tables += result.report.tables;
  }

  // -------------------------------------------------------------------------
  // Inline level
  // -------------------------------------------------------------------------

  private runs(nodes: DocxNode[], fmt: RunFmt): { xml: string; visible: boolean } {
    let xml = '';
    let visible = false;

    for (const node of nodes) {
      if (node.kind === 'text') {
        const text = collapse(node.text);
        if (text === '') {
          continue;
        }
        if (text.trim() !== '') {
          visible = true;
        }
        xml += this.textRun(text, fmt);
        continue;
      }
      if (skip(node)) {
        continue;
      }
      const piece = this.inlineElement(node, fmt);
      xml += piece.xml;
      visible = visible || piece.visible;
    }

    return { xml, visible };
  }

  private inlineElement(el: DocxElement, fmt: RunFmt): { xml: string; visible: boolean } {
    // KaTeX and Mermaid normally arrive as an <img> the webview rasterized. The
    // fallbacks below are for the case where that failed: show the source rather
    // than the rendered markup, whose text is a soup of duplicated MathML.
    if (hasClass(el, 'mc-math')) {
      const tex = el.attrs['data-tex'] ?? textOf(el);
      return { xml: this.textRun(tex, { ...fmt, code: true }), visible: tex.trim() !== '' };
    }
    if (hasClass(el, 'mc-mermaid')) {
      const src = el.attrs['data-mermaid-src'] ?? '';
      return { xml: this.textRun(src, { ...fmt, code: true }), visible: src.trim() !== '' };
    }

    switch (el.name) {
      case 'strong':
      case 'b':
        return this.runs(el.children, { ...fmt, bold: true });
      case 'em':
      case 'i':
      case 'cite':
      case 'var':
        return this.runs(el.children, { ...fmt, italic: true });
      case 'del':
      case 's':
      case 'strike':
        return this.runs(el.children, { ...fmt, strike: true });
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        return this.runs(el.children, { ...fmt, code: true });
      case 'sup':
        return this.runs(el.children, { ...fmt, sup: true, sub: false });
      case 'sub':
        return this.runs(el.children, { ...fmt, sub: true, sup: false });
      case 'br':
        return { xml: '<w:r><w:br/></w:r>', visible: false };
      case 'img':
        return this.image(el);
      case 'a':
        return this.hyperlink(el, fmt);
      case 'input':
        // A task-list checkbox. The box has to become a character: Word has no
        // inline checkbox a screen reader announces reliably, and the symbol at
        // least reads as "ballot box with check".
        if ((el.attrs.type ?? '').toLowerCase() === 'checkbox') {
          const checked = 'checked' in el.attrs;
          return { xml: this.textRun(checked ? '☒ ' : '☐ ', fmt), visible: true };
        }
        return { xml: '', visible: false };
      default:
        return this.runs(el.children, { ...fmt, color: cssColor(el.attrs.style) ?? fmt.color });
    }
  }

  private hyperlink(el: DocxElement, fmt: RunFmt): { xml: string; visible: boolean } {
    const href = el.attrs.href ?? '';
    const inner = this.runs(el.children, { ...fmt, color: undefined });
    if (inner.xml === '') {
      return inner;
    }
    const styled = withHyperlinkStyle(inner.xml);

    if (href.startsWith('#')) {
      // An in-document link (a table of contents, a footnote reference). It has
      // to become w:anchor rather than an external target, or Word opens a
      // browser at a URL that does not exist.
      const anchor = escapeAttr(bookmarkName(href.slice(1)));
      return {
        xml: `<w:hyperlink w:anchor="${anchor}">${styled}</w:hyperlink>`,
        visible: inner.visible,
      };
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      // A relative path: meaningless once the document leaves the workspace, so
      // the text stays and the dead link goes.
      return { xml: styled, visible: inner.visible };
    }

    const id = this.addRel({ kind: 'hyperlink', target: href, external: true });
    return { xml: `<w:hyperlink r:id="${id}">${styled}</w:hyperlink>`, visible: inner.visible };
  }

  private image(el: DocxElement): { xml: string; visible: boolean } {
    const alt = (el.attrs.alt ?? '').trim();
    const src = el.attrs.src ?? '';
    this.report.images++;

    const decoded = decodeImage(src);
    if (!decoded) {
      this.report.imagesSkipped++;
      // Keep the alt text as prose. It is the only thing left that carries what
      // the picture was for.
      return alt === ''
        ? { xml: '', visible: false }
        : { xml: this.textRun(`[image: ${alt}]`, { italic: true }), visible: true };
    }
    if (alt === '') {
      this.report.imagesMissingAlt++;
    }

    const relId = this.addImage(src, decoded);
    const { cx, cy } = displayExtent(...displaySize(el, decoded));
    const id = ++this.drawingSeq;
    const name = `Picture ${id}`;
    // `descr` is what Word's Read Aloud, the Accessibility Checker, and every
    // screen reader look at. It is written on both docPr and cNvPr because
    // different readers have historically consulted different ones.
    const descr = escapeAttr(alt);

    const xml =
      '<w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      `<wp:docPr id="${id}" name="${escapeAttr(name)}" descr="${descr}"/>` +
      '<wp:cNvGraphicFramePr>' +
      '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
      ' noChangeAspect="1"/>' +
      '</wp:cNvGraphicFramePr>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr>' +
      `<pic:cNvPr id="${id}" name="${escapeAttr(name)}" descr="${descr}"/>` +
      '<pic:cNvPicPr/>' +
      '</pic:nvPicPr>' +
      `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      '<pic:spPr>' +
      `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      '</pic:spPr>' +
      '</pic:pic>' +
      '</a:graphicData>' +
      '</a:graphic>' +
      '</wp:inline>' +
      '</w:drawing></w:r>';

    return { xml, visible: true };
  }

  private textRun(text: string, fmt: RunFmt): string {
    if (text === '') {
      return '';
    }
    // A newline inside preserved text is a line break, not a character Word can
    // store in a <w:t>.
    const segments = text.split('\n');
    const body = segments
      .map((segment, i) => {
        const br = i > 0 ? '<w:br/>' : '';
        return segment === '' ? br : `${br}<w:t xml:space="preserve">${escapeXml(segment)}</w:t>`;
      })
      .join('');
    return `<w:r>${runProps(fmt)}${body}</w:r>`;
  }

  private addImage(src: string, decoded: DecodedImage): string {
    const existing = this.imageRels.get(src);
    if (existing) {
      return existing;
    }
    const name = `image${this.media.length + 1}.${decoded.ext}`;
    this.media.push({ name, bytes: decoded.bytes });
    const id = this.addRel({ kind: 'image', target: `media/${name}` });
    this.imageRels.set(src, id);
    return id;
  }

  private addRel(rel: Omit<DocRel, 'id'>): string {
    // rId1 and rId2 are spoken for by styles.xml and numbering.xml, which the
    // writer emits first; see docx/package.ts.
    const id = `rId${this.relSeq + 3}`;
    this.relSeq++;
    this.rels.push({ id, ...rel });
    return id;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** <w:rPr>, children in schema order (rStyle, rFonts, b, i, strike, color, vertAlign). */
function runProps(fmt: RunFmt): string {
  const parts: string[] = [];
  if (fmt.code) {
    parts.push('<w:rStyle w:val="HTMLCode"/>');
  }
  if (fmt.bold) {
    parts.push('<w:b/>');
  }
  if (fmt.italic) {
    parts.push('<w:i/>');
  }
  if (fmt.strike) {
    parts.push('<w:strike/>');
  }
  if (fmt.color) {
    parts.push(`<w:color w:val="${fmt.color}"/>`);
  }
  if (fmt.sup) {
    parts.push('<w:vertAlign w:val="superscript"/>');
  } else if (fmt.sub) {
    parts.push('<w:vertAlign w:val="subscript"/>');
  }
  return parts.length === 0 ? '' : `<w:rPr>${parts.join('')}</w:rPr>`;
}

/**
 * Add the Hyperlink character style to every run in a link's contents.
 *
 * Applying it as a run format instead would fight the caller: a link's text can
 * already be bold or code, and those runs are built before we know they sit
 * inside an <a>.
 */
function withHyperlinkStyle(xml: string): string {
  return xml
    .replace(/<w:r><w:rPr>/g, '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/>')
    .replace(/<w:r>(?!<w:rPr>)/g, '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>');
}

/** Set justification on every paragraph in a fragment (used for aligned cells). */
function alignParagraphs(xml: string, align: 'center' | 'right'): string {
  const jc = `<w:jc w:val="${align}"/>`;
  return xml
    .replace(/<w:p><w:pPr>/g, `<w:p><w:pPr>${jc}`)
    .replace(/<w:p>(?!<w:pPr>)/g, `<w:p><w:pPr>${jc}</w:pPr>`)
    .replace(/<w:p\/>/g, `<w:p><w:pPr>${jc}</w:pPr></w:p>`);
}

/** Viewer furniture that is not part of the document. */
function skip(node: DocxNode): boolean {
  return node.kind === 'element' && 'data-mc-ignore' in node.attrs;
}

/** HTML whitespace collapsing: any run of whitespace is one space. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

interface CodePiece {
  text: string;
  color?: string;
}

/**
 * A code block's lines, keeping the per-token colors the webview inlined.
 *
 * highlight.js wraps tokens in spans whose color only exists in the stylesheet,
 * so the webview writes the computed color onto each span before serializing.
 * Without that the export would be correct and colorless, a visible regression
 * against Save as PDF.
 */
function codeLines(pre: DocxElement): CodePiece[][] {
  const lines: CodePiece[][] = [[]];
  const walk = (node: DocxNode, color?: string): void => {
    if (node.kind === 'text') {
      const segments = node.text.split('\n');
      segments.forEach((segment, i) => {
        if (i > 0) {
          lines.push([]);
        }
        if (segment !== '') {
          lines[lines.length - 1].push({ text: segment, color });
        }
      });
      return;
    }
    if (skip(node)) {
      return;
    }
    if (node.name === 'br') {
      lines.push([]);
      return;
    }
    const own = cssColor(node.attrs.style) ?? color;
    node.children.forEach((child) => walk(child, own));
  };
  pre.children.forEach((child) => walk(child));

  // A fence's closing newline leaves an empty trailing line that is not content.
  while (lines.length > 1 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines;
}

/** The `color` declaration of an inline style attribute, as `RRGGBB`. */
export function cssColor(style: string | undefined): string | undefined {
  if (!style) {
    return undefined;
  }
  const match = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
  if (!match) {
    return undefined;
  }
  const value = match[1].trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1];
    return (
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits
    ).toUpperCase();
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (rgb) {
    return [rgb[1], rgb[2], rgb[3]]
      .map((n) => clampByte(Number.parseFloat(n)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }
  return undefined;
}

function clampByte(n: number): number {
  return Number.isFinite(n) ? Math.min(255, Math.max(0, Math.round(n))) : 0;
}

/** Flatten a table's section elements into rows, marking which ones are headers. */
function collectRows(table: DocxElement): TableRow[] {
  const rows: TableRow[] = [];

  const visit = (el: DocxElement, inHead: boolean): void => {
    for (const child of el.children) {
      if (!isElement(child) || skip(child)) {
        continue;
      }
      if (child.name === 'thead') {
        visit(child, true);
      } else if (child.name === 'tbody' || child.name === 'tfoot') {
        visit(child, false);
      } else if (child.name === 'tr') {
        const cells = child.children
          .filter((c): c is DocxElement => isElement(c) && (c.name === 'td' || c.name === 'th'))
          .filter((c) => !skip(c))
          .map(toCell);
        if (cells.length > 0) {
          // A row of <th> is a header row even outside a <thead>, which is how
          // the CSV grid and hand-written HTML tables both mark one.
          rows.push({ cells, header: inHead || cells.every((cell) => cell.header) });
        }
      } else {
        visit(child, inHead);
      }
    }
  };

  visit(table, false);
  return rows;
}

function toCell(el: DocxElement): TableCell {
  return {
    el,
    colspan: positiveInt(el.attrs.colspan),
    rowspan: positiveInt(el.attrs.rowspan),
    header: el.name === 'th',
    align: cellAlign(el),
  };
}

/**
 * The size to lay an image out at, in CSS pixels.
 *
 * An explicit width/height wins over the intrinsic size of the bytes. The
 * webview relies on that: it rasterizes diagrams and equations at 2x so they
 * stay sharp in print, then pins the attributes back to the size they had on
 * screen. Without this an equation would arrive on the page at twice its size.
 */
function displaySize(el: DocxElement, decoded: DecodedImage): [number, number] {
  const width = pixelAttr(el.attrs.width);
  const height = pixelAttr(el.attrs.height);
  if (width && height) {
    return [width, height];
  }
  // Only one given: keep the aspect ratio of the actual bytes.
  if (width) {
    return [width, Math.max(1, Math.round((decoded.heightPx / decoded.widthPx) * width))];
  }
  if (height) {
    return [Math.max(1, Math.round((decoded.widthPx / decoded.heightPx) * height)), height];
  }
  return [decoded.widthPx, decoded.heightPx];
}

/** A bare-number HTML size attribute. A percentage or `auto` means "no answer". */
function pixelAttr(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) {
    return undefined;
  }
  const n = Math.round(Number.parseFloat(value));
  return n > 0 ? n : undefined;
}

function positiveInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function cellAlign(el: DocxElement): TableCell['align'] {
  const fromAttr = (el.attrs.align ?? '').toLowerCase();
  if (fromAttr === 'center' || fromAttr === 'right' || fromAttr === 'left') {
    return fromAttr;
  }
  const match = /text-align\s*:\s*(left|center|right)/i.exec(el.attrs.style ?? '');
  return match ? (match[1].toLowerCase() as TableCell['align']) : undefined;
}
