// The p:spTree walk: p:sp, p:pic, p:graphicFrame, p:grpSp (recursive).
// p:cxnSp (connectors) are skipped outright -- a deck's connectors are lines
// between shapes, not content of their own, and drawing them needs the same
// arrow/line rendering this reader deliberately leaves to "What it will not
// draw" in docs/PPTX-DESIGN.md.
//
// Everything here is *model* -- geometry in EMU, paragraphs, table cells,
// resolved image data URIs -- and nothing here builds HTML. src/pptx/read/render.ts
// does that, so a change to the markup never has to touch how a shape is found.
import { attr, boolAttr, intAttr } from '../../ooxml/xml';
import { relsPathFor, type Rels } from '../../ooxml/rels';
import { partText, type Parts } from '../../ooxml/zip';
import { child, children, findDeep, parseXml, type XNode } from './xnode';
import {
  buildLevelProviders,
  findRelByType,
  readPlaceholderRef,
  readXfrm,
  resolvePlaceholderGeom,
  type Geometry,
  type LayoutChain,
  type MasterTextStyles,
  type PlaceholderRef,
  type TextStyleKind,
} from './layout';
import { type ClrMap, type Theme } from './theme';
import { hasAnyText, notesLines, readTextBody, type Paragraph, type TextResolveCtx } from './text';

export interface ShapeGeometry {
  x: number;
  y: number;
  cx: number;
  cy: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export interface TableCell {
  paragraphs: Paragraph[];
  colspan: number;
  rowspan: number;
}

export interface TableModel {
  firstRowHeader: boolean;
  /** Relative widths (EMU, as declared) for a proportional <colgroup>. */
  columnWidths: number[];
  /** `undefined` marks a cell covered by hMerge/vMerge: skip it entirely. */
  rows: (TableCell | undefined)[][];
}

export type ShapeContent =
  | { kind: 'text'; paragraphs: Paragraph[] }
  | { kind: 'picture'; alt: string; dataUri: string }
  | { kind: 'table'; table: TableModel }
  // Chart / SmartArt / OLE / video / an image that did not fit the media
  // budget: a labelled box rather than a blank one.
  | { kind: 'unsupported'; label: string };

export interface RenderShape {
  geom: ShapeGeometry;
  isTitle: boolean;
  isPlaceholder: boolean;
  content: ShapeContent;
}

export interface MediaBudget {
  used: number;
  max: number;
}

export interface ShapeReadContext {
  parts: Parts;
  slideRels: Rels;
  theme: Theme;
  clrMap: ClrMap;
  chain: LayoutChain;
  masterStyles: MasterTextStyles;
  /** The presentation's <p:defaultTextStyle>, the last fallback below the master's txStyles. */
  defaultTextStyle?: XNode;
  media: MediaBudget;
}

/**
 * The text-property resolution context for one shape: the run/paragraph
 * inheritance chain (layout.ts's buildLevelProviders) plus theme/clrMap for
 * colour, bundled the way text.ts's readTextBody wants it.
 */
function textResolveCtx(
  ctx: ShapeReadContext,
  ref: PlaceholderRef | undefined,
  kind: TextStyleKind,
  shapeLstStyle: XNode | undefined,
): TextResolveCtx {
  return {
    theme: ctx.theme,
    clrMap: ctx.clrMap,
    levelProviders: buildLevelProviders(
      ref,
      kind,
      shapeLstStyle,
      ctx.chain,
      ctx.masterStyles,
      ctx.defaultTextStyle,
    ),
  };
}

/** How a group's child coordinate space (chOff/chExt) maps onto the slide. */
interface GroupFrame {
  scaleX: number;
  scaleY: number;
  originX: number;
  originY: number;
}

const IDENTITY_FRAME: GroupFrame = { scaleX: 1, scaleY: 1, originX: 0, originY: 0 };

export function readSlideShapes(slideXml: string, ctx: ShapeReadContext): RenderShape[] {
  const root = parseXml(slideXml);
  const spTree = findDeep(root, 'spTree');
  const out: RenderShape[] = [];
  if (spTree !== undefined) {
    walkTree(spTree, IDENTITY_FRAME, ctx, out);
  }
  sortForReadingOrder(out);
  return out;
}

/**
 * How deep a nest of groups is followed.
 *
 * A group holding a group is ordinary, and a dozen levels would already be an
 * unusual deck. A file is free to declare far more than that: `<p:grpSp>` is
 * eleven bytes, so the per-part inflate cap still leaves room for millions of
 * levels, and this walk recurses once per level. Past this depth the shapes
 * inside are dropped rather than followed, because the alternative is a stack
 * overflow that costs the whole preview rather than the contents of one
 * pathological group.
 */
const MAX_GROUP_DEPTH = 32;

function walkTree(
  container: XNode,
  frame: GroupFrame,
  ctx: ShapeReadContext,
  out: RenderShape[],
  depth = 0,
): void {
  for (const node of container.children) {
    if (node.name === 'sp') {
      const shape = buildSpShape(node, frame, ctx);
      if (shape !== undefined) {
        out.push(shape);
      }
    } else if (node.name === 'pic') {
      out.push(buildPicShape(node, frame, ctx));
    } else if (node.name === 'graphicFrame') {
      const shape = buildGraphicFrameShape(node, frame, ctx);
      if (shape !== undefined) {
        out.push(shape);
      }
    } else if (node.name === 'grpSp' && depth < MAX_GROUP_DEPTH) {
      walkTree(node, enterGroup(node, frame), ctx, out, depth + 1);
    }
    // cxnSp and anything else: not drawn, not even as a placeholder box.
  }
}

/**
 * A group's own absolute box, plus its <a:chOff>/<a:chExt>, define how its
 * children's coordinates (which are relative to that child space, not the
 * slide) map onto the slide: `parentOff + (childPos - chOff) * (ext / chExt)`.
 * Missing or degenerate transform data falls back to passing the parent frame
 * through unchanged, which is wrong only in the same way a missing <a:xfrm>
 * anywhere else is wrong -- better than discarding the shapes inside it.
 */
function enterGroup(grpSp: XNode, parentFrame: GroupFrame): GroupFrame {
  const grpSpPr = child(grpSp, 'grpSpPr');
  const xfrm = grpSpPr === undefined ? undefined : child(grpSpPr, 'xfrm');
  if (xfrm === undefined) {
    return parentFrame;
  }
  const off = child(xfrm, 'off');
  const ext = child(xfrm, 'ext');
  const chOff = child(xfrm, 'chOff');
  const chExt = child(xfrm, 'chExt');
  if (off === undefined || ext === undefined || chOff === undefined || chExt === undefined) {
    return parentFrame;
  }

  const rawX = intAttr(off.attrs, 'x') ?? 0;
  const rawY = intAttr(off.attrs, 'y') ?? 0;
  const rawCX = intAttr(ext.attrs, 'cx') ?? 0;
  const rawCY = intAttr(ext.attrs, 'cy') ?? 0;
  const absX = parentFrame.originX + rawX * parentFrame.scaleX;
  const absY = parentFrame.originY + rawY * parentFrame.scaleY;
  const absCX = rawCX * parentFrame.scaleX;
  const absCY = rawCY * parentFrame.scaleY;

  const chOffX = intAttr(chOff.attrs, 'x') ?? 0;
  const chOffY = intAttr(chOff.attrs, 'y') ?? 0;
  // A zero-width child space cannot be scaled from; treat it as 1:1 rather
  // than dividing by zero and turning every descendant's position into NaN.
  const chExtX = intAttr(chExt.attrs, 'cx') || 1;
  const chExtY = intAttr(chExt.attrs, 'cy') || 1;
  const scaleX = absCX / chExtX;
  const scaleY = absCY / chExtY;

  return {
    scaleX,
    scaleY,
    originX: absX - chOffX * scaleX,
    originY: absY - chOffY * scaleY,
  };
}

function transformGeom(raw: Geometry, frame: GroupFrame): ShapeGeometry {
  return {
    x: frame.originX + raw.x * frame.scaleX,
    y: frame.originY + raw.y * frame.scaleY,
    cx: raw.cx * frame.scaleX,
    cy: raw.cy * frame.scaleY,
    rot: raw.rot,
    flipH: raw.flipH,
    flipV: raw.flipV,
  };
}

function buildSpShape(
  sp: XNode,
  frame: GroupFrame,
  ctx: ShapeReadContext,
): RenderShape | undefined {
  const ref = readPlaceholderRef(sp);
  let raw = readXfrm(child(sp, 'spPr'));
  if (raw === undefined && ref !== undefined) {
    raw = resolvePlaceholderGeom(ref, ctx.chain);
  }
  // Nothing on the slide, the layout or the master says where this shape
  // goes. Rather than guess a position, leave it out: an invisible shape at
  // a wrong position is worse than a shape that is simply absent.
  if (raw === undefined) {
    return undefined;
  }

  const isTitle = ref !== undefined && (ref.type === 'title' || ref.type === 'ctrTitle');
  // Per the design doc: body placeholders bullet by default, title
  // placeholders never do. A plain (non-placeholder) text box gets neither
  // treatment -- it bullets only when its own <a:pPr> says so. The same
  // three-way split picks which of the master's titleStyle/bodyStyle/
  // otherStyle a run falls back to.
  const kind: TextStyleKind = isTitle ? 'title' : ref !== undefined ? 'body' : 'other';
  const defaultBullet = kind === 'body';

  const txBody = child(sp, 'txBody');
  const paragraphs =
    txBody === undefined
      ? []
      : readTextBody(
          txBody,
          textResolveCtx(ctx, ref, kind, child(txBody, 'lstStyle')),
          defaultBullet,
        );
  if (!hasAnyText(paragraphs)) {
    // An empty text box is usually a decorative rectangle or line that
    // happens to be an <p:sp>. Nothing to read here, and drawing an empty
    // positioned box would just be visual noise in a preview about content.
    return undefined;
  }

  return {
    geom: transformGeom(raw, frame),
    isTitle,
    isPlaceholder: ref !== undefined,
    content: { kind: 'text', paragraphs },
  };
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

function buildPicShape(pic: XNode, frame: GroupFrame, ctx: ShapeReadContext): RenderShape {
  const raw = readXfrm(child(pic, 'spPr'));
  // A picture with nothing to size it by cannot be drawn at all; render.ts
  // needs *some* box, so fall back to a zero box rather than crashing the
  // whole slide over one broken shape.
  const geom = transformGeom(
    raw ?? { x: 0, y: 0, cx: 0, cy: 0, rot: 0, flipH: false, flipV: false },
    frame,
  );

  const nvPicPr = child(pic, 'nvPicPr');
  const cNvPr = nvPicPr === undefined ? undefined : child(nvPicPr, 'cNvPr');
  const alt = (cNvPr && (attr(cNvPr.attrs, 'descr') || attr(cNvPr.attrs, 'name'))) || 'Picture';

  const nvPr = nvPicPr === undefined ? undefined : child(nvPicPr, 'nvPr');
  if (nvPr !== undefined && child(nvPr, 'videoFile') !== undefined) {
    return {
      geom,
      isTitle: false,
      isPlaceholder: false,
      content: { kind: 'unsupported', label: 'Video' },
    };
  }
  if (nvPr !== undefined && child(nvPr, 'audioFile') !== undefined) {
    return {
      geom,
      isTitle: false,
      isPlaceholder: false,
      content: { kind: 'unsupported', label: 'Embedded object' },
    };
  }

  const blip = child(child(pic, 'blipFill') ?? pic, 'blip');
  const embedId = blip === undefined ? undefined : attr(blip.attrs, 'r:embed');
  const dataUri = embedId === undefined ? undefined : resolveImageDataUri(embedId, ctx);

  return dataUri === undefined
    ? {
        geom,
        isTitle: false,
        isPlaceholder: false,
        content: { kind: 'unsupported', label: 'Image' },
      }
    : { geom, isTitle: false, isPlaceholder: false, content: { kind: 'picture', alt, dataUri } };
}

/** `r:embed` -> a `data:` URI, or undefined when it is unreadable, unsupported, or past the media budget. */
function resolveImageDataUri(embedId: string, ctx: ShapeReadContext): string | undefined {
  const target = ctx.slideRels.get(embedId);
  if (target === undefined) {
    return undefined;
  }
  const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  // EMF/WMF vector metafiles and anything else without a web-safe MIME type
  // are common in pasted-from-Office content but nothing a browser can show
  // as an <img>. A placeholder box is honest; a broken <img> is not.
  if (mime === undefined) {
    return undefined;
  }
  const bytes = ctx.parts.get(target);
  if (bytes === undefined) {
    return undefined;
  }
  if (ctx.media.used + bytes.length > ctx.media.max) {
    return undefined;
  }
  ctx.media.used += bytes.length;
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function buildGraphicFrameShape(
  gf: XNode,
  frame: GroupFrame,
  ctx: ShapeReadContext,
): RenderShape | undefined {
  // A graphicFrame's transform is its own direct <p:xfrm>, not nested under a
  // <p:spPr> the way a plain shape's is; readXfrm only needs the right parent
  // node to look under, which here is the frame itself.
  const raw = readXfrm(gf);
  if (raw === undefined) {
    return undefined;
  }
  const geom = transformGeom(raw, frame);

  const graphicData = child(child(gf, 'graphic') ?? gf, 'graphicData');
  const uri = graphicData === undefined ? '' : (attr(graphicData.attrs, 'uri') ?? '');

  if (uri.endsWith('/table')) {
    const tbl = graphicData === undefined ? undefined : child(graphicData, 'tbl');
    if (tbl === undefined) {
      return undefined;
    }
    return {
      geom,
      isTitle: false,
      isPlaceholder: false,
      content: { kind: 'table', table: readTable(tbl, ctx) },
    };
  }
  if (uri.endsWith('/chart')) {
    return {
      geom,
      isTitle: false,
      isPlaceholder: false,
      content: { kind: 'unsupported', label: 'Chart' },
    };
  }
  if (uri.endsWith('/diagram')) {
    return {
      geom,
      isTitle: false,
      isPlaceholder: false,
      content: { kind: 'unsupported', label: 'Diagram' },
    };
  }
  if (uri.endsWith('/ole')) {
    return {
      geom,
      isTitle: false,
      isPlaceholder: false,
      content: { kind: 'unsupported', label: 'Embedded object' },
    };
  }
  // An unrecognised graphicData kind: nothing sensible to draw or to name, so
  // skip it quietly rather than emitting a placeholder that names nothing.
  return undefined;
}

function readTable(tbl: XNode, ctx: ShapeReadContext): TableModel {
  const tblPr = child(tbl, 'tblPr');
  const firstRowHeader = tblPr !== undefined && boolAttr(tblPr.attrs, 'firstRow');

  const grid = child(tbl, 'tblGrid');
  const columnWidths =
    grid === undefined ? [] : children(grid, 'gridCol').map((c) => intAttr(c.attrs, 'w') ?? 0);

  const rows: (TableCell | undefined)[][] = children(tbl, 'tr').map((tr) =>
    children(tr, 'tc').map((tc) => {
      // hMerge/vMerge mark a cell covered by a merge anchored above or to the
      // left; the origin cell alone carries gridSpan/rowSpan, and these
      // covered cells contribute no <td> at all.
      if (boolAttr(tc.attrs, 'hMerge') || boolAttr(tc.attrs, 'vMerge')) {
        return undefined;
      }
      const txBody = child(tc, 'txBody');
      return {
        // Table cells do not bullet by default; nothing in the design doc
        // says they should, and a bulleted table cell is not how PowerPoint
        // shows one either. A cell is not a placeholder, so its fallback
        // chain skips straight past the layout/master placeholder lstStyle
        // and the titleStyle/bodyStyle split to the master's otherStyle.
        paragraphs:
          txBody === undefined
            ? []
            : readTextBody(
                txBody,
                textResolveCtx(ctx, undefined, 'other', child(txBody, 'lstStyle')),
                false,
              ),
        colspan: intAttr(tc.attrs, 'gridSpan') ?? 1,
        rowspan: intAttr(tc.attrs, 'rowSpan') ?? 1,
      };
    }),
  );

  return { firstRowHeader, columnWidths, rows };
}

/** Title first, then other placeholders, then everything else by top then left -- never z-order. */
function sortForReadingOrder(shapes: RenderShape[]): void {
  const rank = (s: RenderShape): number => (s.isTitle ? 0 : s.isPlaceholder ? 1 : 2);
  shapes.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) {
      return ra - rb;
    }
    if (a.geom.y !== b.geom.y) {
      return a.geom.y - b.geom.y;
    }
    return a.geom.x - b.geom.x;
  });
}

/**
 * Speaker notes for one slide: the notesSlide part's body placeholder, as
 * plain lines.
 *
 * notesSlide is a relationship *type* lookup with no id to go by, the same as
 * slideLayout/slideMaster/theme in layout.ts, so it goes through
 * findRelByType against the slide's own `.rels` rather than the id-only Rels
 * map a caller might otherwise have lying around for that slide.
 */
export function readSpeakerNotes(parts: Parts, slidePath: string): string[] | undefined {
  const notesPath = findRelByType(parts, relsPathFor(slidePath), '/notesSlide');
  const xml = notesPath === undefined ? undefined : partText(parts, notesPath);
  if (xml === undefined) {
    return undefined;
  }
  const root = parseXml(xml);
  const spTree = findDeep(root, 'spTree');
  if (spTree === undefined) {
    return undefined;
  }
  for (const sp of children(spTree, 'sp')) {
    const ph = readPlaceholderRef(sp);
    if (ph !== undefined && (ph.type === 'body' || ph.type === undefined)) {
      const txBody = child(sp, 'txBody');
      if (txBody === undefined) {
        continue;
      }
      // Notes render as plain text (see notesLines/render.ts), so nothing
      // here reads b/i/u/sz/colour: an empty theme and an empty fallback
      // chain are enough.
      const notesCtx: TextResolveCtx = {
        theme: { colors: {} },
        clrMap: {},
        levelProviders: () => [],
      };
      const paragraphs = readTextBody(txBody, notesCtx, false);
      if (hasAnyText(paragraphs)) {
        return notesLines(paragraphs);
      }
    }
  }
  return undefined;
}
