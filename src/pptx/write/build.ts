// The rendered preview's element tree -> per-slide DrawingML.
//
// This is the sibling of src/docx/build.ts, retargeted at a format that has no
// flow layout at all: a .docx page reflows around whatever is on it, a .pptx
// slide is a fixed canvas of absolutely positioned shapes. So where the docx
// builder writes one continuous body, this one first decides where the slide
// breaks are (segmentSlides), then lays each slide's shapes out top to bottom
// with a running cursor and simply notes when that cursor runs past the bottom
// of the slide -- see the design doc's "never repaginate overflow".
import { hasClass, isElement, textOf, type XhtmlElement, type XhtmlNode } from '../../ooxml/xhtml';
import { escapeAttr, escapeXml } from '../../ooxml/write';
import { cssColor } from '../../docx/build';
import { decodeImage, EMU_PER_PX, type DecodedImage } from '../../docx/media';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Slide height is the same for both aspect ratios the design doc lists. */
const SLIDE_CY = 6858000;
export const SLIDE_SIZES = {
  '16:9': { cx: 12192000, cy: SLIDE_CY },
  '4:3': { cx: 9144000, cy: SLIDE_CY },
} as const;

const MARGIN_X = 838200;
const TITLE_Y = 365126;
const TITLE_CY = 1325563;
const BODY_Y = 1825625;
const BODY_CY = 4351338;
/** The centered box a title-only slide's heading sits in. */
const TITLE_SLIDE_CY = 2163762;
/** Vertical gap between stacked shapes on the same slide. */
const GAP_Y = 91440;
/** Fixed row height for a table; content is not measured, only counted. */
const ROW_H = 370840;

/** Word ignores list levels past this; pptx's own lvl attribute tops out here too. */
const MAX_LIST_LEVEL = 8;

// Hundredths of a point, which is what CT_TextCharacterProperties.sz expects.
const SZ_TITLE_BIG = 5400;
const SZ_TITLE = 4000;
const SZ_BODY = 1800;
const SZ_CODE = 1600;
const LEAD_SZ: Record<number, number> = { 3: 2400, 4: 2200, 5: 2000, 6: 1800 };

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface MediaPart {
  /** Part name inside ppt/media/, e.g. `image1.png`. */
  name: string;
  bytes: Uint8Array;
}

export interface SlideRel {
  id: string;
  kind: 'image' | 'hyperlink';
  /** An image target is relative (`../media/imageN.png`); a hyperlink's is its own href. */
  target: string;
  external?: boolean;
}

export interface BuiltSlide {
  /** The inner content of <p:spTree>, everything but the group shape's own props. */
  bodyXml: string;
  rels: SlideRel[];
}

/** What the export learned about the deck while converting it. */
export interface PptxReport {
  slides: number;
  images: number;
  /** Images with no alt text: the reason a slide stops being audible. */
  imagesMissingAlt: number;
  /** Images whose bytes could not be embedded (unreachable remote src, odd format). */
  imagesSkipped: number;
  tables: number;
  /** Slides whose stacked content is estimated to run past the bottom edge. */
  overflowed: number;
}

export interface BuildResult {
  slides: BuiltSlide[];
  media: MediaPart[];
  report: PptxReport;
}

export function buildDeck(root: XhtmlElement, options: { slideSize: '16:9' | '4:3' }): BuildResult {
  const { cx } = SLIDE_SIZES[options.slideSize];
  const builder = new Builder(cx - 2 * MARGIN_X);
  const segments = segmentSlides(root);
  // An empty deck is not a deck PowerPoint will open; one blank slide at least
  // opens, the same fallback docx/build.ts takes for an empty body.
  for (const segment of segments.length > 0 ? segments : [emptySegment()]) {
    builder.finalizeSlide(segment);
  }
  return builder.finish();
}

function emptySegment(): Segment {
  return { body: [], kind: 'content' };
}

// ---------------------------------------------------------------------------
// Slide splitting
// ---------------------------------------------------------------------------
//
// From the design doc: a boundary is an <hr> OR an h1/h2, not one falling back
// to the other. A deck actually written for Marp splits the same either way,
// since its headings already sit one to a section; a deck that merely has a
// footnote somewhere does not have its heading structure silently switched
// off by a separator nobody typed. Content before the first boundary is its
// own slide, a title slide when it is only a heading, an ordinary one
// otherwise. Consecutive boundaries mint no slide between them.
//
// All of this only looks at the top-level flow, which is why flattenFlow
// exists: a wrapping <div> or <section> is not a boundary, it is scaffolding,
// and unwrapping it is what lets the same rule apply whether the webview
// wrapped the whole preview in one container or not.

interface Segment {
  /** The heading text this slide opens on, if any. */
  title?: string;
  body: XhtmlNode[];
  /** 'title' gets the big centered treatment; every other slide is 'content'. */
  kind: 'title' | 'content';
}

/** Grouping elements transparent to slide flow: their children are the document. */
const TRANSPARENT = new Set([
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'figure',
  'details',
]);

function flattenFlow(nodes: XhtmlNode[]): XhtmlNode[] {
  const out: XhtmlNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      out.push(node);
      continue;
    }
    if (skip(node)) {
      continue;
    }
    if (isElement(node) && node.name === 'hr' && hasClass(node, 'footnotes-sep')) {
      // markdown-it-footnote's own separator above the footnote list, not
      // anything the author typed. It is generated chrome the same way a
      // viewer-only wrapper is, so it is dropped here on its class rather
      // than trusted to sit at some particular position: it must neither
      // split a slide nor render onto one.
      continue;
    }
    if (TRANSPARENT.has(node.name)) {
      out.push(...flattenFlow(node.children));
      continue;
    }
    out.push(node);
  }
  return out;
}

/** Drop text nodes that are pure inter-element whitespace. */
function meaningful(nodes: XhtmlNode[]): XhtmlNode[] {
  return nodes.filter((n) => n.kind !== 'text' || n.text.trim() !== '');
}

function segmentSlides(root: XhtmlElement): Segment[] {
  const flow = flattenFlow(root.children);
  const groups = splitOnBoundary(flow);

  const segments: Segment[] = [];
  for (const group of groups) {
    const content = meaningful(group);
    if (content.length === 0) {
      // An empty boundary (a document that opens with `---`, two boundaries
      // back to back) produces no slide rather than a blank one nobody asked
      // for.
      continue;
    }
    // "Content before the first boundary" means the first *emitted* segment,
    // not the first group: when the document opens on a boundary (an h1, most
    // commonly), the group before it is empty and skipped above without ever
    // reaching this push, which would leave the heading's own group sitting
    // at index 1 with nothing to tell it apart from any other boundary. Since
    // an h1/h2 is always itself a boundary, it can only ever be "content
    // before the first boundary" when nothing has been emitted yet either way.
    if (
      segments.length === 0 &&
      content.length === 1 &&
      isElement(content[0]) &&
      // Only h1/h2, matching splitOnBoundary's own idea of a boundary heading
      // below: extractLeadingTitle (h1/h2 only) would never hand an h3-h6 the
      // title-slide treatment, so this check must not either, or a lone h3
      // opening the document gets the full-bleed centered title no ordinary
      // h3 anywhere else in the deck ever gets.
      /^h[12]$/.test(content[0].name)
    ) {
      segments.push({ title: textOf(content[0]).trim(), body: [], kind: 'title' });
      continue;
    }
    const { title, body } = extractLeadingTitle(group);
    segments.push({ title, body, kind: 'content' });
  }
  return segments;
}

/**
 * Split the flow at every <hr> and every h1/h2, in one pass -- a boundary is
 * either one, not an <hr> switching heading-based splitting off. An <hr>
 * itself is a separator and never becomes content; a boundary heading opens
 * its own new group and is carried into it, so extractLeadingTitle can still
 * find it there.
 */
function splitOnBoundary(flow: XhtmlNode[]): XhtmlNode[][] {
  const groups: XhtmlNode[][] = [[]];
  for (const node of flow) {
    if (isElement(node) && node.name === 'hr') {
      groups.push([]);
      continue;
    }
    if (isElement(node) && /^h[12]$/.test(node.name)) {
      groups.push([]);
    }
    groups[groups.length - 1].push(node);
  }
  return groups;
}

/** If a group opens on h1/h2, that heading is the slide's title, not its body. */
function extractLeadingTitle(nodes: XhtmlNode[]): { title?: string; body: XhtmlNode[] } {
  const idx = nodes.findIndex((n) => n.kind !== 'text' || n.text.trim() !== '');
  if (idx === -1) {
    return { body: nodes };
  }
  const first = nodes[idx];
  if (isElement(first) && /^h[12]$/.test(first.name)) {
    return {
      title: textOf(first).trim(),
      body: [...nodes.slice(0, idx), ...nodes.slice(idx + 1)],
    };
  }
  return { body: nodes };
}

// ---------------------------------------------------------------------------
// Per-slide content model
// ---------------------------------------------------------------------------

interface ParaRecord {
  xml: string;
  /** Font size in hundredths of a point, for the overflow height estimate. */
  sz: number;
}

type ShapeItem =
  | { kind: 'text'; paragraphs: ParaRecord[] }
  | {
      kind: 'image';
      src: string;
      decoded: DecodedImage;
      alt: string;
      sizePx: [number, number];
      /** The rId of a hyperlink relationship this picture should be clickable through. */
      hlink?: string;
    }
  | { kind: 'table'; rows: TableRow[] };

interface RunFmt {
  sz: number;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
  color?: string;
  /** The rId of a hyperlink relationship this run should be clickable through. */
  hlink?: string;
}

interface ListMarker {
  pending: boolean;
}

interface BodyCtx {
  sz?: number;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  lvl?: number;
  bullet?: 'char' | 'auto' | 'none';
  listMarker?: ListMarker;
  listDepth?: number;
  /** Owed to the very first paragraph of an <ol> that overrides where it starts. */
  startAt?: number;
}

const BODY_BLOCK_TAGS = new Set([
  'blockquote',
  'dd',
  'dl',
  'dt',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'table',
  'ul',
]);

class Builder {
  private readonly slides: BuiltSlide[] = [];
  private readonly media: MediaPart[] = [];
  private readonly report: PptxReport = {
    slides: 0,
    images: 0,
    imagesMissingAlt: 0,
    imagesSkipped: 0,
    tables: 0,
    overflowed: 0,
  };

  // Reset at the start of every slide; a rels file and an id space belong to
  // one slide part, not to the deck.
  private rels: SlideRel[] = [];
  private relSeq = 0;
  private idSeq = 1;
  private mediaSeq = 0;
  /** src -> rId, reset per slide: rels are file-scoped even when the media isn't. */
  private slideImageRels = new Map<string, string>();
  /**
   * src -> media part name, package-wide and never reset. A logo repeated on
   * every slide is one part with a relationship per slide pointing at it,
   * not ten copies of the same bytes -- the same reasoning docx/build.ts's
   * imageRels dedup applies, just split across two maps because a pptx
   * slide's relationships are private to that slide's own .rels part.
   */
  private readonly mediaByDataUri = new Map<string, string>();

  private shapeQueue: ShapeItem[] = [];
  private textBuf: ParaRecord[] = [];

  constructor(private readonly contentCx: number) {}

  finish(): BuildResult {
    return { slides: this.slides, media: this.media, report: this.report };
  }

  finalizeSlide(segment: Segment): void {
    this.rels = [];
    this.relSeq = 0;
    this.idSeq = 1;
    this.slideImageRels = new Map();
    this.shapeQueue = [];
    this.textBuf = [];

    const parts: string[] = [];
    if (segment.title !== undefined) {
      parts.push(this.titleShapeXml(segment.title, segment.kind));
    }

    this.buildBody(segment.body, {});
    this.flushText();
    const { xml: shapesXml, overflowed } = this.layoutShapes();
    parts.push(shapesXml);
    if (overflowed) {
      this.report.overflowed++;
    }

    const spTree =
      '<p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr/>' +
      parts.join('') +
      '</p:spTree>';
    this.slides.push({ bodyXml: spTree, rels: this.rels });
    this.report.slides++;
  }

  // -------------------------------------------------------------------------
  // Shape stacking
  // -------------------------------------------------------------------------

  private flushText(): void {
    if (this.textBuf.length > 0) {
      this.shapeQueue.push({ kind: 'text', paragraphs: this.textBuf });
      this.textBuf = [];
    }
  }

  /**
   * Lay the queued shapes out top to bottom from the body's top margin.
   *
   * Text height is estimated from font size and line count rather than
   * measured -- there is no layout engine here to measure with -- so this is
   * an estimate the report can act on, not a guarantee PowerPoint's own
   * rendering will clip at exactly this point.
   */
  private layoutShapes(): { xml: string; overflowed: boolean } {
    let y = BODY_Y;
    const bottom = BODY_Y + BODY_CY;
    let overflowed = false;
    const parts: string[] = [];

    for (const item of this.shapeQueue) {
      if (item.kind === 'text') {
        const cy = Math.max(
          1,
          item.paragraphs.reduce((sum, p) => sum + lineHeight(p.sz), 0),
        );
        if (y + cy > bottom) {
          overflowed = true;
        }
        parts.push(
          textShapeXml(
            this.nextId(),
            MARGIN_X,
            y,
            this.contentCx,
            cy,
            item.paragraphs.map((p) => p.xml).join(''),
          ),
        );
        y += cy + GAP_Y;
      } else if (item.kind === 'image') {
        const { cx, cy } = fitImageExtent(item.sizePx[0], item.sizePx[1], this.contentCx);
        if (y + cy > bottom) {
          overflowed = true;
        }
        const relId = this.addImageRel(item.src, item.decoded);
        parts.push(
          pictureShapeXml(this.nextId(), relId, item.alt, MARGIN_X, y, cx, cy, item.hlink),
        );
        y += cy + GAP_Y;
      } else {
        const { xml, cy } = this.tableShapeXml(this.nextId(), item.rows, MARGIN_X, y);
        if (y + cy > bottom) {
          overflowed = true;
        }
        parts.push(xml);
        y += cy + GAP_Y;
      }
    }

    return { xml: parts.join(''), overflowed };
  }

  private nextId(): number {
    return ++this.idSeq;
  }

  private addImageRel(src: string, decoded: DecodedImage): string {
    // The rel is per slide (a repeat of the same image within one slide
    // reuses it), but the media part it points at is per deck: a logo on
    // every slide is stored once and given a fresh relationship each time.
    const existingRel = this.slideImageRels.get(src);
    if (existingRel) {
      return existingRel;
    }
    let name = this.mediaByDataUri.get(src);
    if (!name) {
      name = `image${++this.mediaSeq}.${decoded.ext}`;
      this.mediaByDataUri.set(src, name);
      this.media.push({ name, bytes: decoded.bytes });
    }
    const id = this.addRel('image', `../media/${name}`, false);
    this.slideImageRels.set(src, id);
    return id;
  }

  /**
   * A relationship for an external link. Only http(s) and mailto are worth
   * one: a deck travels to other machines, and a vscode-webview-resource: or
   * file: target that resolved on this one is either dead or a surprise on
   * the next -- the link text survives either way, only the click-through
   * doesn't.
   */
  private addHyperlinkRel(href: string): string {
    return this.addRel('hyperlink', href, true);
  }

  private addRel(kind: SlideRel['kind'], target: string, external: boolean): string {
    const id = `rId${this.relSeq + 2}`;
    this.relSeq++;
    this.rels.push({ id, kind, target, external });
    return id;
  }

  // -------------------------------------------------------------------------
  // Title
  // -------------------------------------------------------------------------

  private titleShapeXml(title: string, kind: Segment['kind']): string {
    const id = this.nextId();
    const big = kind === 'title';
    const cy = big ? TITLE_SLIDE_CY : TITLE_CY;
    const y = big ? Math.round((SLIDE_CY - TITLE_SLIDE_CY) / 2) : TITLE_Y;
    const sz = big ? SZ_TITLE_BIG : SZ_TITLE;
    const pPr = big ? '<a:pPr algn="ctr"><a:buNone/></a:pPr>' : '<a:pPr><a:buNone/></a:pPr>';
    const bodyPr = big ? '<a:bodyPr wrap="square" anchor="ctr"/>' : '<a:bodyPr wrap="square"/>';
    return (
      '<p:sp>' +
      `<p:nvSpPr><p:cNvPr id="${id}" name="Title ${id}"/>` +
      '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
      '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
      `<p:spPr><a:xfrm><a:off x="${MARGIN_X}" y="${clampInt(y)}"/>` +
      `<a:ext cx="${this.contentCx}" cy="${clampInt(cy)}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      `<p:txBody>${bodyPr}<a:lstStyle/>` +
      `<a:p>${pPr}<a:r><a:rPr sz="${sz}" b="1"/><a:t>${escapeXml(title)}</a:t></a:r></a:p>` +
      '</p:txBody></p:sp>'
    );
  }

  // -------------------------------------------------------------------------
  // Block level
  // -------------------------------------------------------------------------

  private buildBody(nodes: XhtmlNode[], ctx: BodyCtx): void {
    let pending: XhtmlNode[] = [];
    const flush = () => {
      if (pending.length > 0) {
        this.paragraphFromInline(pending, ctx);
        pending = [];
      }
    };

    for (const node of nodes) {
      if (node.kind === 'text') {
        if (pending.length > 0 || node.text.trim() !== '') {
          pending.push(node);
        }
        continue;
      }
      if (skip(node)) {
        continue;
      }
      if (isBlockImage(node)) {
        flush();
        this.emitImage(node, ctx);
        continue;
      }
      if (node.name === 'table') {
        flush();
        this.emitTable(node);
        continue;
      }
      if (!BODY_BLOCK_TAGS.has(node.name)) {
        pending.push(node);
        continue;
      }
      flush();
      this.block(node, ctx);
    }
    flush();
  }

  private block(el: XhtmlElement, ctx: BodyCtx): void {
    const heading = /^h([1-6])$/.exec(el.name);
    if (heading) {
      // A boundary heading (h1/h2) reaching here means segmentSlides did not
      // consume it as a title -- a heading buried inside a list item or a
      // blockquote, say. Rather than drop it, it gets the same bold-lead
      // treatment a h3-h6 gets everywhere else.
      const sz = LEAD_SZ[Number(heading[1])] ?? SZ_BODY;
      this.paragraphFromInline(el.children, { ...ctx, sz, bold: true, bullet: 'none' });
      return;
    }
    switch (el.name) {
      case 'p':
        this.paragraphFromInline(el.children, ctx);
        return;
      case 'pre':
        this.codeBlock(el, ctx);
        return;
      case 'blockquote':
        this.buildBody(el.children, {
          ...ctx,
          // Every list path clamps to MAX_LIST_LEVEL before it reaches <a:pPr
          // lvl="...">; a nested blockquote (or one inside a deep list item)
          // has to clamp the same way, or ten of them in a row mints lvl="10",
          // which is outside ST_TextIndentLevelType's 0..8 and is exactly the
          // shape of error that makes PowerPoint refuse to open the file.
          lvl: Math.min((ctx.lvl ?? 0) + 1, MAX_LIST_LEVEL),
          italic: true,
          bullet: 'none',
          listMarker: undefined,
        });
        return;
      case 'ul':
      case 'ol':
        this.list(el, ctx);
        return;
      case 'li':
        this.buildBody(el.children, ctx);
        return;
      case 'hr':
        // A rule nested inside body content (a blockquote, typically) carries
        // no slide-boundary meaning once it is inside one; nothing to draw.
        return;
      default:
        this.buildBody(el.children, ctx);
    }
  }

  private paragraphFromInline(nodes: XhtmlNode[], ctx: BodyCtx): void {
    const sz = ctx.sz ?? SZ_BODY;
    const { xml, visible } = this.runs(nodes, {
      sz,
      bold: ctx.bold,
      italic: ctx.italic,
      mono: ctx.mono,
    });
    if (!visible) {
      return;
    }
    const spend = ctx.listMarker?.pending === true;
    const bullet = spend ? (ctx.bullet ?? 'none') : 'none';
    if (ctx.listMarker) {
      ctx.listMarker.pending = false;
    }
    const startAt = spend ? ctx.startAt : undefined;
    this.textBuf.push({ xml: paragraph(xml, { lvl: ctx.lvl ?? 0, bullet, startAt }), sz });
  }

  private codeBlock(el: XhtmlElement, ctx: BodyCtx): void {
    void ctx;
    for (const line of codeLines(el)) {
      const runsXml = line
        .map((piece) => textRun(piece.text, { sz: SZ_CODE, mono: true, color: piece.color }))
        .join('');
      this.textBuf.push({ xml: paragraph(runsXml, { lvl: 0, bullet: 'none' }), sz: SZ_CODE });
    }
  }

  private list(el: XhtmlElement, ctx: BodyCtx): void {
    const ordered = el.name === 'ol';
    const lvl = Math.min(ctx.listDepth ?? 0, MAX_LIST_LEVEL);
    // Only the very first item's first paragraph is where a start override
    // can land -- it is the paragraph that spends the marker, and PowerPoint
    // auto-numbers every buAutoNum paragraph after it consecutively from
    // there with no separate "instance" to attach a restart to.
    const startAt = ordered ? parseListStart(el.attrs.start) : 1;
    let first = true;
    for (const child of el.children) {
      if (!isElement(child) || skip(child) || child.name !== 'li') {
        continue;
      }
      const marker: ListMarker = { pending: true };
      this.buildBody(child.children, {
        ...ctx,
        lvl,
        bullet: ordered ? 'auto' : 'char',
        listMarker: marker,
        listDepth: lvl + 1,
        startAt: first && startAt !== 1 ? startAt : undefined,
      });
      first = false;
    }
  }

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  private emitImage(node: XhtmlElement, ctx: BodyCtx): void {
    void ctx;
    const found = blockImage(node);
    if (!found) {
      return;
    }
    const { img, href } = found;
    const alt = (img.attrs.alt ?? '').trim();
    const src = img.attrs.src ?? '';
    this.report.images++;

    const decoded = decodeImage(src);
    if (!decoded) {
      this.report.imagesSkipped++;
      if (alt !== '') {
        this.textBuf.push({
          xml: paragraph(textRun(`[image: ${alt}]`, { sz: SZ_BODY, italic: true }), {
            lvl: 0,
            bullet: 'none',
          }),
          sz: SZ_BODY,
        });
      }
      return;
    }
    if (alt === '') {
      this.report.imagesMissingAlt++;
    }
    this.flushText();
    // The hyperlink relationship is only worth minting once the picture that
    // will carry it is actually about to be queued -- see addHyperlinkRel's
    // other caller in inlineElement for why an unreferenced rel is a problem
    // PowerPoint's opener notices.
    const hlink = href ? this.addHyperlinkRel(href) : undefined;
    this.shapeQueue.push({
      kind: 'image',
      src,
      decoded,
      alt,
      sizePx: displaySizePx(img, decoded),
      hlink,
    });
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  private emitTable(el: XhtmlElement): void {
    const rows = collectRows(el);
    if (rows.length === 0) {
      return;
    }
    this.report.tables++;
    this.flushText();
    this.shapeQueue.push({ kind: 'table', rows });
  }

  private tableShapeXml(
    id: number,
    rows: TableRow[],
    x: number,
    y: number,
  ): { xml: string; cy: number } {
    const cols = tableColumnCount(rows);
    const colWidth = Math.floor(this.contentCx / cols);
    const hasHeader = rows.some((r) => r.header);

    const carry = new Map<number, { left: number; span: number }>();
    const trXml: string[] = [];
    rows.forEach((row, rowIndex) => {
      const cellsXml: string[] = [];
      const queue = [...row.cells];
      let col = 0;
      while (col < cols) {
        const carried = carry.get(col);
        if (carried) {
          for (let i = 0; i < carried.span; i++) {
            // A vMerge continuation cell covers whatever the merged cell
            // would have covered, header shading included -- hardcoding
            // `false` here left a rowspan inside a <thead> losing its fill on
            // every row after the first, so this has to carry the same
            // row.header the missing-cell branch below it already does.
            cellsXml.push(
              this.tcXml(undefined, row.header, i === 0 ? ' vMerge="1"' : ' hMerge="1" vMerge="1"'),
            );
          }
          if (--carried.left === 0) {
            carry.delete(col);
          }
          col += carried.span;
          continue;
        }
        const cell = queue.shift();
        if (!cell) {
          cellsXml.push(this.tcXml(undefined, row.header, ''));
          col += 1;
          continue;
        }
        const span = Math.max(1, Math.min(cell.colspan, cols - col));
        // colspan is clamped to the columns actually remaining; rowspan has to
        // be clamped the same way to the rows actually remaining, or a
        // rowspan larger than what is left below produces a <a:tc rowSpan="n">
        // with too few vMerge continuation cells to match -- internally
        // inconsistent merge geometry PowerPoint refuses to open.
        const rowSpan = Math.max(1, Math.min(cell.rowspan, rows.length - rowIndex));
        if (rowSpan > 1) {
          carry.set(col, { left: rowSpan - 1, span });
        }
        const attrs =
          (span > 1 ? ` gridSpan="${span}"` : '') + (rowSpan > 1 ? ` rowSpan="${rowSpan}"` : '');
        cellsXml.push(this.tcXml(cell, row.header, attrs));
        for (let i = 1; i < span; i++) {
          cellsXml.push(this.tcXml(undefined, row.header, ' hMerge="1"'));
        }
        col += span;
      }
      trXml.push(`<a:tr h="${ROW_H}">${cellsXml.join('')}</a:tr>`);
    });

    const cy = ROW_H * rows.length;
    const gridCols = Array.from({ length: cols }, () => `<a:gridCol w="${colWidth}"/>`).join('');
    const xml =
      '<p:graphicFrame>' +
      `<p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>` +
      '<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      `<p:xfrm><a:off x="${x}" y="${clampInt(y)}"/><a:ext cx="${this.contentCx}" cy="${cy}"/></p:xfrm>` +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      `<a:tbl><a:tblPr${hasHeader ? ' firstRow="1"' : ''}/><a:tblGrid>${gridCols}</a:tblGrid>` +
      trXml.join('') +
      '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    return { xml, cy };
  }

  private tcXml(cell: TableCell | undefined, headerRow: boolean, attrs: string): string {
    const header = headerRow || (cell?.header ?? false);
    const fill = header ? '<a:solidFill><a:srgbClr val="F6F8FA"/></a:solidFill>' : '';
    let inner = '<a:p><a:pPr><a:buNone/></a:pPr></a:p>';
    if (cell) {
      const { xml } = this.runs(cell.el.children, { sz: SZ_BODY, bold: header });
      const align = cell.align === 'center' ? 'ctr' : cell.align === 'right' ? 'r' : undefined;
      inner = paragraph(xml, { lvl: 0, bullet: 'none', align });
    }
    return (
      `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${inner}</a:txBody>` +
      `<a:tcPr marL="45720" marR="45720" marT="22860" marB="22860">${fill}</a:tcPr></a:tc>`
    );
  }

  // -------------------------------------------------------------------------
  // Inline level
  // -------------------------------------------------------------------------

  private runs(nodes: XhtmlNode[], fmt: RunFmt): { xml: string; visible: boolean } {
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
        xml += textRun(text, fmt);
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

  private inlineElement(el: XhtmlElement, fmt: RunFmt): { xml: string; visible: boolean } {
    // Mirrors docx/build.ts's fallback: if the webview could not rasterize a
    // diagram or an equation, show the source rather than a soup of MathML.
    if (hasClass(el, 'mc-math')) {
      const tex = el.attrs['data-tex'] ?? textOf(el);
      return { xml: textRun(tex, { ...fmt, mono: true }), visible: tex.trim() !== '' };
    }
    if (hasClass(el, 'mc-mermaid')) {
      const src = el.attrs['data-mermaid-src'] ?? '';
      return { xml: textRun(src, { ...fmt, mono: true }), visible: src.trim() !== '' };
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
        return this.runs(el.children, { ...fmt, mono: true });
      case 'br':
        return { xml: '<a:br/>', visible: false };
      case 'a': {
        const href = el.attrs.href ?? '';
        if (!HYPERLINK_SCHEME.test(href)) {
          // vscode-webview-resource:, file:, javascript:, a bare #fragment --
          // nothing this machine's link would still mean on another one. The
          // text survives; only the click-through doesn't.
          return this.runs(el.children, fmt);
        }
        // Convert the children before minting a relationship for them: an
        // anchor whose content collapses to nothing (an empty <a>, one
        // wrapping only whitespace) must not leave a hyperlink relationship
        // sitting in the slide's .rels with nothing in bodyXml pointing at it
        // -- package.ts's own header comment names that shape of orphan as a
        // "PowerPoint found a problem with content" trigger. src/docx/build.ts's
        // `hyperlink` runs the identical check before its own addRel.
        const probe = this.runs(el.children, fmt);
        if (!probe.visible) {
          return probe;
        }
        const rId = this.addHyperlinkRel(href);
        return this.runs(el.children, { ...fmt, hlink: rId });
      }
      case 'img': {
        // A genuinely inline image (mixed with text rather than its own
        // paragraph) cannot become a positioned <p:pic> without breaking the
        // run of text around it; the alt text survives as a bracket instead.
        const alt = (el.attrs.alt ?? '').trim();
        return alt === ''
          ? { xml: '', visible: false }
          : { xml: textRun(`[image: ${alt}]`, { ...fmt, italic: true }), visible: true };
      }
      case 'input':
        if ((el.attrs.type ?? '').toLowerCase() === 'checkbox') {
          const checked = 'checked' in el.attrs;
          return { xml: textRun(checked ? '☑ ' : '☐ ', fmt), visible: true };
        }
        return { xml: '', visible: false };
      default:
        return this.runs(el.children, fmt);
    }
  }
}

// ---------------------------------------------------------------------------
// XML fragments (pure; no builder state)
// ---------------------------------------------------------------------------

interface BulletOpts {
  lvl: number;
  bullet: 'char' | 'auto' | 'none';
  align?: 'ctr' | 'r';
  /** Where an <ol start="n"> restarts its auto-numbering; see parseListStart. */
  startAt?: number;
}

/**
 * <a:p>, with its properties' children in the schema's required order:
 * lnSpc/spcBef/spcAft, buClr, buSzTx, buFont, then the bullet kind itself.
 * Only the pieces this writer uses are here, in that relative order.
 */
function paragraph(runsXml: string, opts: BulletOpts): string {
  const attrs = [`lvl="${opts.lvl}"`];
  if (opts.lvl > 0) {
    attrs.push(`marL="${opts.lvl * 457200}"`, 'indent="-457200"');
  }
  if (opts.align) {
    attrs.push(`algn="${opts.align}"`);
  }
  const startAt = opts.startAt !== undefined ? ` startAt="${opts.startAt}"` : '';
  const bullet =
    opts.bullet === 'auto'
      ? `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"${startAt}/>`
      : opts.bullet === 'char'
        ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>'
        : '<a:buNone/>';
  return `<a:p><a:pPr ${attrs.join(' ')}>${bullet}</a:pPr>${runsXml}</a:p>`;
}

/**
 * <a:rPr>, children in schema order: fill (solidFill for a syntax color), the
 * typeface (latin, for monospace runs), then hlinkClick -- CT_TextCharacterProperties
 * puts the click action after the font, not before.
 */
function runProps(fmt: RunFmt): string {
  const attrs = [`sz="${fmt.sz}"`];
  if (fmt.bold) {
    attrs.push('b="1"');
  }
  if (fmt.italic) {
    attrs.push('i="1"');
  }
  if (fmt.strike) {
    attrs.push('strike="sngStrike"');
  }
  const children =
    (fmt.color ? `<a:solidFill><a:srgbClr val="${fmt.color}"/></a:solidFill>` : '') +
    (fmt.mono ? '<a:latin typeface="Consolas"/>' : '') +
    (fmt.hlink ? `<a:hlinkClick r:id="${fmt.hlink}"/>` : '');
  return children ? `<a:rPr ${attrs.join(' ')}>${children}</a:rPr>` : `<a:rPr ${attrs.join(' ')}/>`;
}

function textRun(text: string, fmt: RunFmt): string {
  if (text === '') {
    return '';
  }
  // A newline inside preserved text (a code line, multi-line alt text pulled
  // in as a fallback) is a manual line break, not a character <a:t> can hold.
  return text
    .split('\n')
    .map((segment, i) => {
      const br = i > 0 ? '<a:br/>' : '';
      return segment === ''
        ? br
        : `${br}<a:r>${runProps(fmt)}<a:t>${escapeXml(segment)}</a:t></a:r>`;
    })
    .join('');
}

function textShapeXml(
  id: number,
  x: number,
  y: number,
  cx: number,
  cy: number,
  innerParas: string,
): string {
  return (
    '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="Content ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${clampInt(y)}"/><a:ext cx="${cx}" cy="${clampInt(cy)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${innerParas}</p:txBody>` +
    '</p:sp>'
  );
}

function pictureShapeXml(
  id: number,
  relId: string,
  alt: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  hlink?: string,
): string {
  const descr = escapeAttr(alt);
  // <p:cNvPr> shares CT_NonVisualDrawingProps with a run's <a:rPr>: the click
  // action is a child, not an attribute, and (per that same schema) has to
  // come before the sibling nvPicPr elements are even reachable -- there is
  // nothing after it to order against here, unlike runProps's rPr.
  const hlinkXml = hlink ? `<a:hlinkClick r:id="${hlink}"/>` : '';
  return (
    '<p:pic>' +
    `<p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${descr}">${hlinkXml}</p:cNvPr>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${clampInt(y)}"/><a:ext cx="${clampInt(cx)}" cy="${clampInt(cy)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '</p:pic>'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Viewer furniture that is not part of the document. */
function skip(node: XhtmlNode): boolean {
  return node.kind === 'element' && 'data-mc-ignore' in node.attrs;
}

/** HTML whitespace collapsing: any run of whitespace is one space. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** A bare-number HTML size attribute. A percentage or `auto` means "no answer". */
function pixelAttr(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) {
    return undefined;
  }
  const n = Math.round(Number.parseFloat(value));
  return n > 0 ? n : undefined;
}

/**
 * The pixel size to lay an image out at.
 *
 * An explicit width/height wins over the intrinsic size, the same rule
 * docx/media.ts's caller applies and for the same reason: a rasterized diagram
 * carries the size it had on screen, and using the bytes' own (2x) size would
 * draw it twice as large as everything around it.
 */
function displaySizePx(el: XhtmlElement, decoded: DecodedImage): [number, number] {
  const width = pixelAttr(el.attrs.width);
  const height = pixelAttr(el.attrs.height);
  if (width && height) {
    return [width, height];
  }
  const ratio =
    decoded.widthPx > 0 && decoded.heightPx > 0 ? decoded.widthPx / decoded.heightPx : undefined;
  if (width) {
    return [width, ratio ? Math.max(1, Math.round(width / ratio)) : width];
  }
  if (height) {
    return [ratio ? Math.max(1, Math.round(height * ratio)) : height, height];
  }
  return [Math.max(1, decoded.widthPx), Math.max(1, decoded.heightPx)];
}

/** Display extent in EMU, shrunk to the content box when it is wider. Never enlarged. */
function fitImageExtent(
  widthPx: number,
  heightPx: number,
  maxCx: number,
): { cx: number; cy: number } {
  const nativeCx = Math.max(1, Math.round(widthPx * EMU_PER_PX));
  const nativeCy = Math.max(1, Math.round(heightPx * EMU_PER_PX));
  if (nativeCx <= maxCx) {
    return { cx: nativeCx, cy: nativeCy };
  }
  const scale = maxCx / nativeCx;
  return { cx: clampInt(maxCx), cy: Math.max(1, Math.round(nativeCy * scale)) };
}

/** Rough line height in EMU for a font size given in hundredths of a point. */
function lineHeight(szHundredths: number): number {
  return Math.round(((szHundredths / 100) * 12700 * 1.2) / 100) * 100;
}

/** Every EMU value written out is clamped so a malformed input cannot mint a non-finite coordinate. */
function clampInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** Schemes worth a relationship: the ones still meaningful on a machine other than this one. */
const HYPERLINK_SCHEME = /^(https?:|mailto:)/i;

/**
 * The value an <ol start="n"> restarts auto-numbering at.
 *
 * Clamped to ST_TextBulletStartAtNum's own range (1..32767): unlike Word's
 * numbering instances, DrawingML has no representation for a zero- or
 * negative-based list at all, so a `start="0"` cannot round-trip the way it
 * does through docx/build.ts -- it lands on 1, the same as omitting start.
 */
function parseListStart(value: string | undefined): number {
  const n = Number.parseInt(value ?? '1', 10);
  const finite = Number.isFinite(n) ? n : 1;
  return Math.max(1, Math.min(32767, finite));
}

// ---------------------------------------------------------------------------
// Whether a node is a standalone (block-level) image, and whether it is
// wrapped in a link worth carrying onto the picture
// ---------------------------------------------------------------------------

function isBlockImage(node: XhtmlElement): boolean {
  return blockImage(node) !== undefined;
}

/**
 * The image a standalone paragraph resolves to, and the href to hang off its
 * picture when the whole paragraph is nothing but a link around that image.
 *
 * `[![Chart](chart.png)](https://example.test)` serializes to
 * `<p><a href="..."><img .../></a></p>`: the paragraph's only child is `a`,
 * not `img`, so without unwrapping the link here isBlockImage would say no
 * and inlineElement's own `img` case would take over instead -- and that case
 * exists to keep a *genuinely* inline image (mixed with running text) from
 * becoming a positioned shape that would break the line around it, so its
 * fallback is text, not a picture. A standalone linked image has no such
 * surrounding text to preserve, and PowerPoint has no inline flow to put a
 * linked picture inside anyway, so it becomes its own <p:pic> instead, with
 * the link riding on the picture itself (see pictureShapeXml's hlinkClick).
 */
function blockImage(node: XhtmlElement): { img: XhtmlElement; href?: string } | undefined {
  if (node.name === 'img') {
    return { img: node };
  }
  if (node.name === 'a') {
    const kids = node.children.filter((c) => c.kind !== 'text' || c.text.trim() !== '');
    if (kids.length !== 1 || !isElement(kids[0]) || kids[0].name !== 'img') {
      return undefined;
    }
    const href = node.attrs.href ?? '';
    return { img: kids[0], href: HYPERLINK_SCHEME.test(href) ? href : undefined };
  }
  if (node.name === 'p') {
    const kids = node.children.filter((c) => c.kind !== 'text' || c.text.trim() !== '');
    return kids.length === 1 && isElement(kids[0]) ? blockImage(kids[0]) : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

interface CodePiece {
  text: string;
  color?: string;
}

/** A fenced code block's lines, keeping the per-token colors the webview inlined. */
function codeLines(pre: XhtmlElement): CodePiece[][] {
  const lines: CodePiece[][] = [[]];
  const walk = (node: XhtmlNode, color?: string): void => {
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

  while (lines.length > 1 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface TableCell {
  el: XhtmlElement;
  colspan: number;
  rowspan: number;
  header: boolean;
  align?: 'left' | 'center' | 'right';
}

interface TableRow {
  cells: TableCell[];
  header: boolean;
}

function collectRows(table: XhtmlElement): TableRow[] {
  const rows: TableRow[] = [];
  const visit = (el: XhtmlElement, inHead: boolean): void => {
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
          .filter((c): c is XhtmlElement => isElement(c) && (c.name === 'td' || c.name === 'th'))
          .filter((c) => !skip(c))
          .map(toCell);
        if (cells.length > 0) {
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

function toCell(el: XhtmlElement): TableCell {
  return {
    el,
    colspan: positiveInt(el.attrs.colspan),
    rowspan: positiveInt(el.attrs.rowspan),
    header: el.name === 'th',
    align: cellAlign(el),
  };
}

function positiveInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function cellAlign(el: XhtmlElement): TableCell['align'] {
  const fromAttr = (el.attrs.align ?? '').toLowerCase();
  if (fromAttr === 'center' || fromAttr === 'right' || fromAttr === 'left') {
    return fromAttr;
  }
  const match = /text-align\s*:\s*(left|center|right)/i.exec(el.attrs.style ?? '');
  return match ? (match[1].toLowerCase() as TableCell['align']) : undefined;
}

/**
 * The grid width of a table, in columns; see docx/build.ts's columnCount for
 * why a rowspan from an earlier row has to be counted here too. Duplicated
 * rather than imported: it is a private helper there, and the two tables are
 * shaped too differently (attributes vs child elements for a span) to share
 * the cell-emission code around it.
 */
function tableColumnCount(rows: TableRow[]): number {
  let cols = 1;
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
