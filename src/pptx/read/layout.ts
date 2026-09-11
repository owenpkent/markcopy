// Placeholder inheritance: slide -> layout -> master.
//
// A placeholder shape on a slide routinely carries text and nothing else --
// no <a:xfrm> of its own -- because its position and size are meant to come
// from the layout, and failing that the master. This module builds that
// lookup once per layout/master pair and resolves a slide placeholder against
// it; src/pptx/read/shape.ts is the only caller.
import { attr, boolAttr, intAttr, walkXml } from '../../ooxml/xml';
import { partForRels, partText, resolveTarget, type Parts } from '../../ooxml/zip';
import { relsPathFor, type Rels } from '../../ooxml/rels';
import { child, children, deep, findDeep, parseXml, type XNode } from './xnode';
import { readClrMap, readTheme, type ClrMap, type Theme } from './theme';

export interface Geometry {
  x: number;
  y: number;
  cx: number;
  cy: number;
  /** 60000ths of a degree. */
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export interface PlaceholderRef {
  idx?: number;
  /** Absent means "body" -- ECMA-376 treats a <p:ph> with no type that way. */
  type?: string;
}

/** title/ctrTitle placeholders use the master's titleStyle; any other placeholder uses bodyStyle; a non-placeholder shape uses otherStyle. */
export type TextStyleKind = 'title' | 'body' | 'other';

interface PlaceholderShape {
  ref: PlaceholderRef;
  geom?: Geometry;
  /** This placeholder's own `<p:txBody>/<a:lstStyle>`, if it declares one. */
  lstStyle?: XNode;
}

/** `title` and `ctrTitle` are the same slot for matching purposes. */
function normalizeType(type: string | undefined): string {
  const t = type ?? 'body';
  return t === 'ctrTitle' ? 'title' : t;
}

/** The direct `<a:xfrm>` under a shape's `<p:spPr>` (or a graphicFrame's own `<p:xfrm>`). */
export function readXfrm(spPrOrFrame: XNode | undefined, xfrmName = 'xfrm'): Geometry | undefined {
  const xfrm = spPrOrFrame === undefined ? undefined : child(spPrOrFrame, xfrmName);
  if (xfrm === undefined) {
    return undefined;
  }
  const off = child(xfrm, 'off');
  const ext = child(xfrm, 'ext');
  if (off === undefined || ext === undefined) {
    return undefined;
  }
  const x = intAttr(off.attrs, 'x');
  const y = intAttr(off.attrs, 'y');
  const cx = intAttr(ext.attrs, 'cx');
  const cy = intAttr(ext.attrs, 'cy');
  if (x === undefined || y === undefined || cx === undefined || cy === undefined) {
    return undefined;
  }
  return {
    x,
    y,
    cx,
    cy,
    rot: intAttr(xfrm.attrs, 'rot') ?? 0,
    flipH: boolAttr(xfrm.attrs, 'flipH'),
    flipV: boolAttr(xfrm.attrs, 'flipV'),
  };
}

/**
 * A shape's `<p:ph>`, if it is a placeholder at all.
 *
 * The `<p:nvXxxPr>` wrapper name depends on the shape kind -- `nvSpPr` for a
 * `<p:sp>`, `nvPicPr` for a `<p:pic>`, `nvGraphicFramePr` for a
 * `<p:graphicFrame>` -- but `<p:ph>` sits at the same `.../nvPr/ph` depth
 * under all three, so trying each in turn covers every caller in shape.ts
 * without needing to know which kind of shape it was handed.
 */
export function readPlaceholderRef(shapeLike: XNode): PlaceholderRef | undefined {
  const ph =
    deep(shapeLike, 'nvSpPr', 'nvPr', 'ph') ??
    deep(shapeLike, 'nvPicPr', 'nvPr', 'ph') ??
    deep(shapeLike, 'nvGraphicFramePr', 'nvPr', 'ph');
  if (ph === undefined) {
    return undefined;
  }
  return { idx: intAttr(ph.attrs, 'idx'), type: ph.attrs['type'] };
}

/**
 * Every top-level placeholder `<p:sp>` in a layout or master's `<p:spTree>`,
 * with whatever geometry it declares directly.
 *
 * Layouts and masters do not nest their placeholders inside groups, so this
 * only looks at direct spTree children -- unlike the slide walk in shape.ts,
 * which has to handle grpSp because slide authors do use them.
 */
function readPlaceholderShapes(xml: string | undefined): PlaceholderShape[] {
  if (xml === undefined) {
    return [];
  }
  const root = parseXml(xml);
  const spTree = findDeep(root, 'spTree');
  if (spTree === undefined) {
    return [];
  }
  const out: PlaceholderShape[] = [];
  for (const sp of children(spTree, 'sp')) {
    const ref = readPlaceholderRef(sp);
    if (ref === undefined) {
      continue;
    }
    const txBody = child(sp, 'txBody');
    out.push({
      ref,
      geom: readXfrm(child(sp, 'spPr')),
      lstStyle: txBody === undefined ? undefined : child(txBody, 'lstStyle'),
    });
  }
  return out;
}

export interface LayoutChain {
  layoutPlaceholders: PlaceholderShape[];
  masterPlaceholders: PlaceholderShape[];
}

export function readLayoutChain(
  layoutXml: string | undefined,
  masterXml: string | undefined,
): LayoutChain {
  return {
    layoutPlaceholders: readPlaceholderShapes(layoutXml),
    masterPlaceholders: readPlaceholderShapes(masterXml),
  };
}

/** Match by idx first, then by type (title ~ ctrTitle), layout before master. */
export function resolvePlaceholderGeom(
  ref: PlaceholderRef,
  chain: LayoutChain,
): Geometry | undefined {
  return (
    findPlaceholderShape(ref, chain.layoutPlaceholders)?.geom ??
    findPlaceholderShape(ref, chain.masterPlaceholders)?.geom
  );
}

/** The one placeholder shape in `list` this ref names: by idx first, then by type. */
function findPlaceholderShape(
  ref: PlaceholderRef,
  list: PlaceholderShape[],
): PlaceholderShape | undefined {
  if (ref.idx !== undefined) {
    const byIdx = list.find((p) => p.ref.idx === ref.idx);
    if (byIdx !== undefined) {
      return byIdx;
    }
  }
  const wanted = normalizeType(ref.type);
  return list.find((p) => normalizeType(p.ref.type) === wanted);
}

/**
 * The target of the one relationship of a part's `.rels` whose declared Type
 * ends in `typeSuffix`.
 *
 * `src/ooxml/rels.ts`'s `readRels` deliberately keeps only id -> target, which
 * is all a `r:id`/`r:embed` lookup ever needs. Finding "the slide's layout" or
 * "the master's theme" instead means finding a relationship *by type*, with no
 * id to look up, so this reads the `.rels` XML itself the same way
 * findWorkbookPart/findPresentationPart do for the package root relationship.
 */
export function findRelByType(
  parts: Parts,
  relsPath: string,
  typeSuffix: string,
): string | undefined {
  const xml = partText(parts, relsPath);
  if (xml === undefined) {
    return undefined;
  }
  let found: string | undefined;
  walkXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship' || found !== undefined) {
        return;
      }
      const type = attr(attrs, 'Type') ?? '';
      const target = attr(attrs, 'Target');
      // Same reasoning as readRels: never follow a relationship that points
      // outside the package.
      if (target && type.endsWith(typeSuffix) && attr(attrs, 'TargetMode') !== 'External') {
        found = resolveTarget(partForRels(relsPath), target);
      }
    },
  });
  return found;
}

/** Everything index.ts needs out of one slide's own `.rels`. */
export interface SlideRelInfo {
  /** id -> target, for the picture/shape r:embed lookups in shape.ts. */
  rels: Rels;
  layoutPath?: string;
  notesPath?: string;
}

/**
 * The slide's own `.rels`, read in a single SAX pass for everything the
 * reader needs out of it: the id -> target map (the same one
 * `src/ooxml/rels.ts`'s `readRels` would produce) plus the slideLayout and
 * notesSlide relationship targets, which have no id to look up by and would
 * otherwise each cost `findRelByType` its own separate pass over this exact
 * XML. Before this, a slide's `.rels` was parsed up to four times: once here,
 * once more for the layout (to pick a resolveSlideContext cache key), again
 * inside resolveSlideContext, and again inside readSpeakerNotes -- on a
 * 100-slide deck that is 300-400 avoidable `strFromU8` + SAX passes over what
 * is usually a handful of relationships.
 */
export function readSlideRelInfo(parts: Parts, slidePath: string): SlideRelInfo {
  const relsPath = relsPathFor(slidePath);
  const rels: Rels = new Map();
  const info: SlideRelInfo = { rels };
  const xml = partText(parts, relsPath);
  if (xml === undefined) {
    return info;
  }
  walkXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship') {
        return;
      }
      const id = attr(attrs, 'Id');
      const target = attr(attrs, 'Target');
      // Same reasoning as readRels: never follow a relationship that points
      // outside the package.
      if (!id || !target || attr(attrs, 'TargetMode') === 'External') {
        return;
      }
      const resolved = resolveTarget(partForRels(relsPath), target);
      rels.set(id, resolved);
      const type = attr(attrs, 'Type') ?? '';
      if (info.layoutPath === undefined && type.endsWith('/slideLayout')) {
        info.layoutPath = resolved;
      }
      if (info.notesPath === undefined && type.endsWith('/notesSlide')) {
        info.notesPath = resolved;
      }
    },
  });
  return info;
}

/** The master's <p:txStyles>: the deck's own default formatting per placeholder category, by level. */
export interface MasterTextStyles {
  titleStyle?: XNode;
  bodyStyle?: XNode;
  otherStyle?: XNode;
}

function readMasterTextStyles(masterXml: string | undefined): MasterTextStyles {
  if (masterXml === undefined) {
    return {};
  }
  const txStyles = findDeep(parseXml(masterXml), 'txStyles');
  if (txStyles === undefined) {
    return {};
  }
  return {
    titleStyle: child(txStyles, 'titleStyle'),
    bodyStyle: child(txStyles, 'bodyStyle'),
    otherStyle: child(txStyles, 'otherStyle'),
  };
}

/** A level-styles container's entry for one 0-based level: `<a:lvl{level+1}pPr>`. */
function lstStyleLevel(container: XNode | undefined, level: number): XNode | undefined {
  return container === undefined ? undefined : child(container, `lvl${level + 1}pPr`);
}

export interface SlideContext {
  theme: Theme;
  clrMap: ClrMap;
  chain: LayoutChain;
  masterStyles: MasterTextStyles;
}

/**
 * The full slide -> layout -> master -> theme resolution, in one call.
 *
 * Takes the slide's layout path already resolved, rather than an
 * `r:id`/slide path to derive it from, because the caller (index.ts) has
 * always already resolved it by the time this runs -- once to pick this
 * context's cache key, and again for readSlideRelInfo's combined pass over
 * the slide's own `.rels`. Deriving it a third time here would mean a third
 * SAX pass over a `.rels` part this small deck may share across every slide.
 */
export function resolveSlideContext(parts: Parts, layoutPath: string | undefined): SlideContext {
  const layoutXml = layoutPath === undefined ? undefined : partText(parts, layoutPath);

  const masterPath =
    layoutPath === undefined
      ? undefined
      : findRelByType(parts, relsPathFor(layoutPath), '/slideMaster');
  const masterXml = masterPath === undefined ? undefined : partText(parts, masterPath);

  const themePath =
    masterPath === undefined ? undefined : findRelByType(parts, relsPathFor(masterPath), '/theme');
  const themeXml = themePath === undefined ? undefined : partText(parts, themePath);

  return {
    theme: readTheme(themeXml),
    clrMap: readClrMap(masterXml),
    chain: readLayoutChain(layoutXml, masterXml),
    masterStyles: readMasterTextStyles(masterXml),
  };
}

/**
 * The ordered, level-indexed fallback chain for a shape's text properties,
 * most specific first: the shape's own `<a:lstStyle>`, then the matching
 * placeholder's `<a:lstStyle>` on the layout, then on the master, then the
 * master's per-category `<p:txStyles>` entry, then the presentation's
 * `<p:defaultTextStyle>`. src/pptx/read/text.ts walks each of these (via
 * their `defRPr` for run properties, or their own attributes for `algn`)
 * looking for the first one that actually declares a given property -- the
 * run's own `<a:rPr>` and the paragraph's own `<a:pPr>`/`<a:defRPr>` are more
 * specific still, and are checked before this chain even starts.
 *
 * Built once per shape (`ref`/`kind`/`shapeLstStyle` do not vary by
 * paragraph), and returns a function of `level` because two paragraphs in the
 * same shape can sit at different outline levels.
 */
export function buildLevelProviders(
  ref: PlaceholderRef | undefined,
  kind: TextStyleKind,
  shapeLstStyle: XNode | undefined,
  chain: LayoutChain,
  masterStyles: MasterTextStyles,
  defaultTextStyle: XNode | undefined,
): (level: number) => (XNode | undefined)[] {
  const layoutLstStyle =
    ref === undefined ? undefined : findPlaceholderShape(ref, chain.layoutPlaceholders)?.lstStyle;
  const masterLstStyle =
    ref === undefined ? undefined : findPlaceholderShape(ref, chain.masterPlaceholders)?.lstStyle;
  const masterTextStyle =
    kind === 'title'
      ? masterStyles.titleStyle
      : kind === 'body'
        ? masterStyles.bodyStyle
        : masterStyles.otherStyle;

  return (level: number): (XNode | undefined)[] => [
    lstStyleLevel(shapeLstStyle, level),
    lstStyleLevel(layoutLstStyle, level),
    lstStyleLevel(masterLstStyle, level),
    lstStyleLevel(masterTextStyle, level),
    lstStyleLevel(defaultTextStyle, level),
  ];
}
