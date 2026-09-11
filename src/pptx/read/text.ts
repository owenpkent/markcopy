// p:txBody -> paragraphs, runs and bullets, and the HTML for all three.
//
// The property that makes this module non-trivial is that PowerPoint authors
// rarely put a size or a colour on a run at all: those live up the
// inheritance chain -- the paragraph's own defRPr, the shape's own lstStyle,
// the placeholder's lstStyle on the layout then the master, the master's
// per-category txStyles, and finally the presentation's defaultTextStyle.
// Reading only a run's own <a:rPr> (the shape this module started as) renders
// a run's true, inherited formatting as nothing: a title with no explicit
// size renders at whatever the browser defaults to, and a title with no
// explicit bold renders exactly as the file says (not bold), which is
// correct, but only by accident. Every property below is resolved by walking
// the whole chain and taking the first level that actually declares it.
//
// Colour resolution lives here rather than in theme.ts because the only place
// a colour is ever attached to something is an rPr/defRPr's <a:solidFill>:
// theme.ts owns the arithmetic (scheme lookup, clrMap, the lumMod/shade
// family), this module owns finding that XML at each level of the chain.
import { attr, intAttr } from '../../ooxml/xml';
import { escapeHtml } from '../../escape';
import { child, children, type XNode } from './xnode';
import {
  applyColorMods,
  normalizeHex,
  resolveSchemeColor,
  type ClrMap,
  type ColorMods,
  type Theme,
} from './theme';
import { clamp, fmtNum } from './format';

export type ListType = 'none' | 'bullet' | 'number';

export interface TextRun {
  kind: 'text';
  text: string;
  b: boolean;
  i: boolean;
  u: boolean;
  /** "RRGGBB", already resolved through any scheme reference. */
  color?: string;
  /** Hundredths of a point, resolved through the whole inheritance chain. */
  sz?: number;
}

export interface BreakRun {
  kind: 'break';
}

export type Run = TextRun | BreakRun;

export interface Paragraph {
  /** 0-based, clamped to 0-8. */
  level: number;
  listType: ListType;
  runs: Run[];
  /** Raw `algn` value ("l"/"ctr"/"r"/"just"/"dist"), resolved through the same chain. */
  align?: string;
}

/**
 * Everything needed to resolve a run or paragraph's inherited properties.
 *
 * `levelProviders(level)` is layout.ts's `buildLevelProviders` result: the
 * ordered, level-indexed fallback chain below the paragraph's own `<a:pPr>`
 * (shape lstStyle, then layout/master placeholder lstStyle, then the
 * master's txStyles, then the presentation's defaultTextStyle).
 */
export interface TextResolveCtx {
  theme: Theme;
  clrMap: ClrMap;
  levelProviders: (level: number) => (XNode | undefined)[];
}

/**
 * `<p:txBody>` -> paragraphs.
 *
 * `defaultBullet` is the placeholder's own default (body/obj placeholders
 * bullet unless told not to; titles and plain text boxes never do on their
 * own), applied to any paragraph whose `<a:pPr>` does not say one way or the
 * other.
 */
export function readTextBody(
  txBody: XNode,
  ctx: TextResolveCtx,
  defaultBullet: boolean,
): Paragraph[] {
  return children(txBody, 'p').map((p) => {
    const pPr = child(p, 'pPr');
    const level = clamp(intAttr(pPr?.attrs ?? {}, 'lvl') ?? 0, 0, 8);
    const fallbacks = ctx.levelProviders(level);
    return {
      level,
      listType: readListType(pPr, defaultBullet),
      align: resolveAlign(pPr, fallbacks),
      runs: readRuns(p, pPr, fallbacks, ctx),
    };
  });
}

function readListType(pPr: XNode | undefined, defaultBullet: boolean): ListType {
  if (pPr !== undefined) {
    if (child(pPr, 'buNone') !== undefined) {
      return 'none';
    }
    if (child(pPr, 'buAutoNum') !== undefined) {
      return 'number';
    }
    if (child(pPr, 'buChar') !== undefined) {
      return 'bullet';
    }
  }
  return defaultBullet ? 'bullet' : 'none';
}

/** `algn` lives on the pPr-shaped node itself, not on a defRPr, at every level. */
function resolveAlign(
  pPr: XNode | undefined,
  fallbacks: (XNode | undefined)[],
): string | undefined {
  const own = pPr === undefined ? undefined : attr(pPr.attrs, 'algn');
  if (own !== undefined) {
    return own;
  }
  for (const level of fallbacks) {
    const v = level === undefined ? undefined : attr(level.attrs, 'algn');
    if (v !== undefined) {
      return v;
    }
  }
  return undefined;
}

// <a:r>, <a:fld> (a field's cached <a:t> is what gets shown) and <a:br> can
// all sit directly inside <a:p>, in any order, so this reads the paragraph's
// own children in document order rather than filtering by one tag name.
function readRuns(
  p: XNode,
  pPr: XNode | undefined,
  fallbacks: (XNode | undefined)[],
  ctx: TextResolveCtx,
): Run[] {
  // The paragraph's own <a:pPr>/<a:defRPr> outranks every level in the
  // fallback chain but is still less specific than the run's own <a:rPr>.
  const paraDefRPr = pPr === undefined ? undefined : child(pPr, 'defRPr');
  const fallbackDefRPrs = fallbacks.map((level) =>
    level === undefined ? undefined : child(level, 'defRPr'),
  );

  const out: Run[] = [];
  for (const c of p.children) {
    if (c.name === 'r' || c.name === 'fld') {
      const rPr = child(c, 'rPr');
      out.push(buildTextRun(child(c, 't')?.text ?? '', [rPr, paraDefRPr, ...fallbackDefRPrs], ctx));
    } else if (c.name === 'br') {
      out.push({ kind: 'break' });
    }
  }
  return out;
}

/** `sources` is most-specific-first; each property independently takes the first level that declares it. */
function buildTextRun(text: string, sources: (XNode | undefined)[], ctx: TextResolveCtx): TextRun {
  return {
    kind: 'text',
    text,
    b: resolveBoolAttr(sources, 'b') ?? false,
    i: resolveBoolAttr(sources, 'i') ?? false,
    u: resolveUnderline(sources) ?? false,
    sz: resolveIntAttr(sources, 'sz'),
    color: resolveColor(sources, ctx),
  };
}

function resolveBoolAttr(sources: (XNode | undefined)[], name: string): boolean | undefined {
  for (const s of sources) {
    if (s === undefined) {
      continue;
    }
    const raw = attr(s.attrs, name);
    if (raw !== undefined) {
      return raw === '1' || raw === 'true';
    }
  }
  return undefined;
}

function resolveIntAttr(sources: (XNode | undefined)[], name: string): number | undefined {
  for (const s of sources) {
    if (s === undefined) {
      continue;
    }
    const v = intAttr(s.attrs, name);
    if (v !== undefined) {
      return v;
    }
  }
  return undefined;
}

function resolveUnderline(sources: (XNode | undefined)[]): boolean | undefined {
  for (const s of sources) {
    if (s === undefined) {
      continue;
    }
    const raw = attr(s.attrs, 'u');
    if (raw !== undefined) {
      return raw !== 'none';
    }
  }
  return undefined;
}

function resolveColor(sources: (XNode | undefined)[], ctx: TextResolveCtx): string | undefined {
  for (const s of sources) {
    const c = s === undefined ? undefined : resolveFillColor(s, ctx);
    if (c !== undefined) {
      return c;
    }
  }
  return undefined;
}

function resolveFillColor(rPrLike: XNode, ctx: TextResolveCtx): string | undefined {
  const fill = child(rPrLike, 'solidFill');
  if (fill === undefined) {
    return undefined;
  }
  const srgb = child(fill, 'srgbClr');
  if (srgb !== undefined) {
    const val = normalizeHex(attr(srgb.attrs, 'val'));
    return val === undefined ? undefined : applyColorMods(val, readColorMods(srgb));
  }
  const scheme = child(fill, 'schemeClr');
  if (scheme !== undefined) {
    const val = attr(scheme.attrs, 'val');
    if (val === undefined) {
      return undefined;
    }
    return applyColorMods(resolveSchemeColor(ctx.theme, ctx.clrMap, val), readColorMods(scheme));
  }
  return undefined;
}

function readColorMods(colorNode: XNode): ColorMods {
  const val = (name: string): number | undefined => {
    const c = child(colorNode, name);
    return c === undefined ? undefined : intAttr(c.attrs, 'val');
  };
  return { lumMod: val('lumMod'), lumOff: val('lumOff'), shade: val('shade'), tint: val('tint') };
}

/** The first resolved run size in the shape, used as its font-size baseline. */
export function firstDefinedSize(paragraphs: Paragraph[]): number | undefined {
  for (const p of paragraphs) {
    for (const r of p.runs) {
      if (r.kind === 'text' && r.sz !== undefined) {
        return r.sz;
      }
    }
  }
  return undefined;
}

/** The first resolved paragraph alignment in the shape (render.ts's title case, which has no per-block alignment of its own). */
export function firstDefinedAlign(paragraphs: Paragraph[]): string | undefined {
  for (const p of paragraphs) {
    if (p.align !== undefined) {
      return p.align;
    }
  }
  return undefined;
}

/** Whether any paragraph holds non-blank text, for deciding whether an empty shape is worth a box at all. */
export function hasAnyText(paragraphs: Paragraph[]): boolean {
  return paragraphs.some((p) => p.runs.some((r) => r.kind === 'text' && r.text.trim() !== ''));
}

/** Plain-text lines for speaker notes: a paragraph or an <a:br> each end a line. */
export function notesLines(paragraphs: Paragraph[]): string[] {
  const lines: string[] = [];
  for (const p of paragraphs) {
    let cur = '';
    for (const r of p.runs) {
      if (r.kind === 'break') {
        lines.push(cur);
        cur = '';
      } else {
        cur += r.text;
      }
    }
    lines.push(cur);
  }
  return lines;
}

export interface Block {
  tag: 'ul' | 'ol' | 'p';
  /** Inner HTML only; the caller decides how (or whether) to wrap it in `<tag>`. */
  html: string;
  /** CSS `text-align` value, only when the paragraph resolved one worth stating. */
  align?: string;
}

/** OOXML `algn` -> CSS `text-align`. `undefined` for the default ("l") so callers can skip the style. */
export function alignCss(raw: string | undefined): string | undefined {
  switch (raw) {
    case 'ctr':
      return 'center';
    case 'r':
      return 'right';
    case 'just':
    case 'justLow':
    case 'dist':
    case 'thaiDist':
      return 'justify';
    default:
      // "l" and anything unrecognised: left is the CSS default, not worth a style.
      return undefined;
  }
}

/**
 * Paragraphs -> block-level HTML: unbulleted paragraphs become `<p>`, and a
 * run of consecutive bulleted/numbered paragraphs becomes one nested list,
 * nested by `level` and grouped into `<ul>`/`<ol>` by `listType` at each
 * level. `baseSizeHundredths` is the shape's own font-size (from
 * firstDefinedSize); a run only gets its own inline font-size when it
 * disagrees with that, which is what keeps a plain, uniformly-sized shape
 * from wrapping every word in a `<span>`.
 */
export function paragraphsToBlocks(
  paragraphs: Paragraph[],
  baseSizeHundredths: number | undefined,
  slideWidthPt: number,
): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    if (paragraphs[i].listType === 'none') {
      blocks.push({
        tag: 'p',
        html: paragraphRunsHtml(paragraphs[i].runs, baseSizeHundredths, slideWidthPt),
        align: alignCss(paragraphs[i].align),
      });
      i++;
      continue;
    }
    const start = i;
    while (i < paragraphs.length && paragraphs[i].listType !== 'none') {
      i++;
    }
    blocks.push(...buildListBlocks(paragraphs.slice(start, i), baseSizeHundredths, slideWidthPt));
  }
  return blocks;
}

/**
 * A paragraph's runs as inline HTML, with no block wrapper of its own.
 *
 * Exported for render.ts's title case: a title never bullets, so its
 * paragraphs join with `<br>` inside one `<h2>` instead of becoming separate
 * `<p>` blocks the way a body placeholder's do.
 */
export function runsHtml(
  runs: Run[],
  baseSizeHundredths: number | undefined,
  slideWidthPt: number,
): string {
  return paragraphRunsHtml(runs, baseSizeHundredths, slideWidthPt);
}

interface ListNode {
  listType: 'bullet' | 'number';
  inner: string;
  align?: string;
  children: ListNode[];
}

function buildListBlocks(
  paras: Paragraph[],
  baseSizeHundredths: number | undefined,
  slideWidthPt: number,
): Block[] {
  const root: ListNode[] = [];
  // One open list per level; a jump straight from level 0 to level 2 nests
  // directly rather than inventing an empty level-1 list, which is the same
  // simplification most viewers make for a level a deck never actually uses.
  const stack: { level: number; arr: ListNode[] }[] = [{ level: -1, arr: root }];
  for (const p of paras) {
    while (stack[stack.length - 1].level >= p.level) {
      stack.pop();
    }
    const node: ListNode = {
      listType: p.listType === 'number' ? 'number' : 'bullet',
      inner: paragraphRunsHtml(p.runs, baseSizeHundredths, slideWidthPt),
      align: alignCss(p.align),
      children: [],
    };
    stack[stack.length - 1].arr.push(node);
    stack.push({ level: p.level, arr: node.children });
  }
  return renderListNodes(root);
}

/** Group consecutive siblings by listType so a run of bullets shares one <ul>. */
function renderListNodes(nodes: ListNode[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < nodes.length) {
    const type = nodes[i].listType;
    const tag: 'ul' | 'ol' = type === 'number' ? 'ol' : 'ul';
    let html = '';
    while (i < nodes.length && nodes[i].listType === type) {
      const n = nodes[i];
      const nested = renderListNodes(n.children)
        .map((b) => `<${b.tag}${styleAttr(b.align)}>${b.html}</${b.tag}>`)
        .join('');
      html += `<li${styleAttr(n.align)}>${n.inner}${nested}</li>`;
      i++;
    }
    out.push({ tag, html });
  }
  return out;
}

function styleAttr(align: string | undefined): string {
  return align === undefined ? '' : ` style="text-align:${align}"`;
}

function paragraphRunsHtml(
  runs: Run[],
  baseSizeHundredths: number | undefined,
  slideWidthPt: number,
): string {
  return runs
    .map((r) => (r.kind === 'break' ? '<br>' : runHtml(r, baseSizeHundredths, slideWidthPt)))
    .join('');
}

function runHtml(
  run: TextRun,
  baseSizeHundredths: number | undefined,
  slideWidthPt: number,
): string {
  let inner = escapeHtml(run.text);
  if (run.u) {
    inner = `<u>${inner}</u>`;
  }
  if (run.i) {
    inner = `<em>${inner}</em>`;
  }
  if (run.b) {
    inner = `<strong>${inner}</strong>`;
  }

  const style: string[] = [];
  if (run.color !== undefined) {
    style.push(`color:#${run.color}`);
  }
  if (run.sz !== undefined && run.sz !== baseSizeHundredths) {
    style.push(`font-size:${fmtNum(cqwFontSize(run.sz, slideWidthPt))}cqw`);
  }
  return style.length === 0 ? inner : `<span style="${style.join(';')}">${inner}</span>`;
}

/** `sz` (hundredths of a point) -> cqw against a slide `slideWidthPt` points wide. */
export function cqwFontSize(szHundredths: number, slideWidthPt: number): number {
  if (slideWidthPt <= 0) {
    return 0;
  }
  return clamp(szHundredths / slideWidthPt, 0, 500);
}
