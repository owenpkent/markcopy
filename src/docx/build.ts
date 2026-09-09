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
  /** Inside an <a>: the run wears the link's appearance as well as its own. */
  hyperlink?: boolean;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  sup?: boolean;
  sub?: boolean;
  color?: string;
}

/**
 * The number or bullet owed to the first paragraph of a list item.
 *
 * A shared mutable object rather than a plain value, because a context is copied
 * (`{ ...ctx, style }`) on the way into almost every block. Marking the marker
 * spent has to be visible to the copy the caller kept, or a heading or a code
 * block inside a list item numbers every paragraph it produces.
 */
interface ListMarker {
  numId: number;
  ilvl: number;
  /**
   * The style in effect where the item began. A block inside the item that sets
   * its own style differs from it, and that style outranks ListParagraph.
   */
  baseStyle?: string;
  /** True until a paragraph has carried the marker. */
  pending: boolean;
}

interface BlockCtx {
  /** Paragraph style id applied to plain paragraphs in this container. */
  style?: string;
  /** Extra left indent in twips, for nested quotes and list continuations. */
  indent?: number;
  /** Owed to the first paragraph of a list item; see ListMarker. */
  marker?: ListMarker;
  /** Nesting depth of the enclosing list, for a nested list's level. */
  listDepth?: number;
  /** HTML id to anchor a bookmark on, so in-document links can reach it. */
  bookmarkId?: string;
  /** Justification for every paragraph in this container, for an aligned cell. */
  align?: 'center' | 'right';
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
    // An empty body is not a document at all. A body ending in a table, which
    // Word is equally unhappy with, cannot happen here: `table` writes the
    // paragraph that has to follow one.
    if (this.out.length === 0) {
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
        // Through paragraphProps rather than written out flat, so a rule inside
        // an aligned cell or a list item is not the one paragraph that misses
        // the container's justification or keeps its item's number alive.
        this.out.push(`<w:p>${this.paragraphProps({ ...ctx, style: 'HorizontalRule' })}</w:p>`);
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
  }

  /**
   * <w:pPr>, with children in the order the schema demands.
   *
   * CT_PPr is a sequence, not a bag: pStyle, then numPr, then ind, then jc. Word
   * validates the order and offers to repair a document that gets it wrong, so
   * this stays the only place a paragraph property is written.
   *
   * Emitting the numbering is also what spends the list marker, because this is
   * the single point at which it can be spent.
   */
  private paragraphProps(ctx: BlockCtx): string {
    const parts: string[] = [];
    const marker = ctx.marker?.pending === true ? ctx.marker : undefined;
    // A list item keeps its own indent from the numbering definition, so
    // ListParagraph stands in for the style the container asked for -- but only
    // while the item is still wearing that style. A heading, a code block or a
    // quote inside the item has chosen its own, and overriding it would cost
    // exactly the outline level and the shading this export exists to carry.
    const style = marker && ctx.style === marker.baseStyle ? 'ListParagraph' : ctx.style;
    if (style && style !== 'Normal') {
      parts.push(`<w:pStyle w:val="${style}"/>`);
    }
    if (marker) {
      parts.push(
        `<w:numPr><w:ilvl w:val="${marker.ilvl}"/><w:numId w:val="${marker.numId}"/></w:numPr>`,
      );
      marker.pending = false;
    }
    if (ctx.indent) {
      parts.push(`<w:ind w:left="${ctx.indent}"/>`);
    }
    if (ctx.align) {
      parts.push(`<w:jc w:val="${ctx.align}"/>`);
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
    lines.forEach((line) => {
      // The first line spends the item's marker; the rest see it already spent.
      const props = this.paragraphProps({ ...ctx, style: 'HTMLPreformatted' });
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
  }

  private list(el: DocxElement, ctx: BlockCtx): void {
    const ordered = el.name === 'ol';
    const depth = Math.min(ctx.listDepth ?? 0, MAX_LIST_LEVEL);
    // `|| 1` would be wrong here: `0.` is a legal markdown list start and zero
    // is falsy, so an explicit `<ol start="0">` would silently restart at one.
    const parsed = Number.parseInt(el.attrs.start ?? '1', 10);
    const start = Number.isFinite(parsed) ? parsed : 1;

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
      marker: { numId, ilvl: depth, baseStyle: ctx.style, pending: true },
      listDepth: depth + 1,
      align: ctx.align,
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

    const cols = columnCount(rows);
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
    // A table cannot carry a number, so a list item that opens with one spends
    // its marker on nothing rather than passing it to the paragraph after.
    if (ctx.marker) {
      ctx.marker.pending = false;
    }
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
      const rendered = this.capture(cell.el.children, {
        style: cell.header || headerRow ? 'TableHeader' : 'TableText',
        align: cell.align === 'left' ? undefined : cell.align,
      });
      if (rendered !== '') {
        body = rendered;
      }
    }

    return `<w:tc><w:tcPr>${props.join('')}</w:tcPr>${body}</w:tc>`;
  }

  /**
   * Render nodes into a fragment instead of into the body.
   *
   * A cell's contents are part of the same document as everything around them:
   * the same media, the same relationship ids, the same image dedup map, the
   * same report. Taking the tail of `out` keeps all of that shared, where a
   * second Builder per cell had to copy state in and out -- and got the media
   * part names wrong doing it, because a fresh builder numbers `image1.png` from
   * its own empty list and overwrites the one the body already stored there.
   */
  private capture(nodes: DocxNode[], ctx: BlockCtx): string {
    const start = this.out.length;
    this.blocks(nodes, ctx);
    return this.out.splice(start).join('');
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
    // The Hyperlink character style rides down with the run format rather than
    // being patched into the finished runs: `runProps` is where the schema's
    // ordering of <w:rPr> children is already understood, and it is the only
    // place that can see a run is both code and a link, which the schema allows
    // only one <w:rStyle> for.
    const inner = this.runs(el.children, { ...fmt, color: undefined, hyperlink: true });
    if (inner.xml === '') {
      return inner;
    }
    const styled = inner.xml;

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

/** <w:rPr>, children in schema order (rStyle, b, i, strike, color, u, vertAlign). */
function runProps(fmt: RunFmt): string {
  const parts: string[] = [];
  // CT_RPr allows one rStyle, so a code span inside a link cannot wear both
  // character styles. Code keeps the slot, because monospace and shading are the
  // more distinctive treatment and the <w:hyperlink> around the run is what
  // makes it clickable either way; the link's underline is added back below as
  // direct formatting so the run still reads as a link.
  if (fmt.code) {
    parts.push('<w:rStyle w:val="HTMLCode"/>');
  } else if (fmt.hyperlink) {
    parts.push('<w:rStyle w:val="Hyperlink"/>');
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
  if (fmt.code && fmt.hyperlink) {
    parts.push('<w:u w:val="single"/>');
  }
  if (fmt.sup) {
    parts.push('<w:vertAlign w:val="superscript"/>');
  } else if (fmt.sub) {
    parts.push('<w:vertAlign w:val="subscript"/>');
  }
  return parts.length === 0 ? '' : `<w:rPr>${parts.join('')}</w:rPr>`;
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

/**
 * The grid width of a table, in columns.
 *
 * The sum of a row's own colspans is not the answer: a rowspan from an earlier
 * row occupies a column in this row too, so a `<td rowspan="2">` above a row of
 * two cells makes a three-column table. Undercounting is not a layout nit -- the
 * placement loop stops at the width, so every cell past it is dropped from the
 * document entirely.
 *
 * A loop rather than `Math.max(...rows.map(...))`, because the spread passes one
 * argument per row and overflows the call stack somewhere north of a hundred
 * thousand of them, a size `markcopy.csv.maxRows` can be set to.
 */
export function columnCount(rows: TableRow[]): number {
  let cols = 1;
  // Rows still to come that each column owes to a rowspan above it.
  let carried: number[] = [];

  for (const row of rows) {
    let col = 0;
    for (const cell of row.cells) {
      while ((carried[col] ?? 0) > 0) {
        col++;
      }
      for (let i = 0; i < cell.colspan; i++) {
        carried[col + i] = Math.max(carried[col + i] ?? 0, cell.rowspan);
      }
      col += cell.colspan;
    }
    cols = Math.max(cols, col);
    carried = carried.map((left) => Math.max(0, left - 1));
  }
  return cols;
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
  // A header can report a zero side: a truncated GIF whose logical screen
  // descriptor never arrived, a PNG with a malformed IHDR. Dividing by it gives
  // Infinity, which Math.round and Math.max both pass straight through into a
  // wp:extent that is not a valid coordinate and that Word refuses to draw.
  const ratio =
    decoded.widthPx > 0 && decoded.heightPx > 0 ? decoded.widthPx / decoded.heightPx : undefined;
  // Only one given: keep the aspect ratio of the actual bytes.
  if (width) {
    return [width, ratio ? Math.max(1, Math.round(width / ratio)) : width];
  }
  if (height) {
    return [ratio ? Math.max(1, Math.round(height * ratio)) : height, height];
  }
  return [Math.max(1, decoded.widthPx), Math.max(1, decoded.heightPx)];
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
