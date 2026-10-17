// word/styles.xml: just enough to answer "what is this paragraph or run?".
//
// A Word style is a name plus a pile of properties, and styles inherit through
// `w:basedOn`. The reader asks a handful of things of that graph and nothing
// else: is a paragraph a heading (or the title), does it carry a list, and
// which character-level flags (bold, italic, a monospace font) a run inherits
// from its character style. Colours, sizes, spacing and table styles are not
// read.
import { attr, intAttr } from '../../ooxml/xml';
import { child, parseXml, type XNode } from '../../ooxml/xnode';

/** The run flags the preview renders. `undefined` means "not stated here". */
export interface RunProps {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  sup?: boolean;
  sub?: boolean;
  mono?: boolean;
  vanish?: boolean;
  mark?: boolean;
}

interface StyleDef {
  id: string;
  name: string;
  basedOn?: string;
  outlineLvl?: number;
  numId?: string;
  ilvl?: number;
  jc?: string;
  run: RunProps;
}

export interface HeadingInfo {
  /** 1 to 6. */
  level: number;
  /** The `Title` style, which maps to the same level as Heading 1. */
  title: boolean;
}

// Fonts whose only job is fixed-width text. A style or run set in one of these
// is code as far as a reader of the preview is concerned.
const MONO_FONT =
  /^(consolas|courier|courier new|lucida console|lucida sans typewriter|monaco|menlo|andale mono|monospace|source code pro|cascadia (code|mono)|fira (code|mono)|dejavu sans mono|liberation mono|jetbrains mono|roboto mono|ubuntu mono|sf mono|inconsolata|hack)$|\bmono$/i;

export function isMonoFont(font: string | undefined): boolean {
  return font !== undefined && MONO_FONT.test(font.trim());
}

/** An on/off property: present with no value means on; `0`, `false` and `off` mean off. */
function onOff(node: XNode | undefined): boolean | undefined {
  if (node === undefined) {
    return undefined;
  }
  const v = attr(node.attrs, 'val');
  return v === undefined ? true : !(v === '0' || v === 'false' || v === 'off');
}

/** The run flags written directly in an `<w:rPr>`. */
export function readRunProps(rPr: XNode | undefined): RunProps {
  const out: RunProps = {};
  if (rPr === undefined) {
    return out;
  }
  out.b = onOff(child(rPr, 'b'));
  out.i = onOff(child(rPr, 'i'));
  const u = child(rPr, 'u');
  out.u = u === undefined ? undefined : attr(u.attrs, 'val') !== 'none';
  const strike = onOff(child(rPr, 'strike'));
  const dstrike = onOff(child(rPr, 'dstrike'));
  out.strike = strike === undefined && dstrike === undefined ? undefined : !!(strike || dstrike);
  const va = child(rPr, 'vertAlign');
  if (va !== undefined) {
    const v = attr(va.attrs, 'val');
    out.sup = v === 'superscript';
    out.sub = v === 'subscript';
  }
  const fonts = child(rPr, 'rFonts');
  if (fonts !== undefined) {
    const face =
      attr(fonts.attrs, 'ascii') ?? attr(fonts.attrs, 'hAnsi') ?? attr(fonts.attrs, 'cs');
    if (face !== undefined) {
      out.mono = isMonoFont(face);
    }
  }
  out.vanish = onOff(child(rPr, 'vanish'));
  const hl = child(rPr, 'highlight');
  out.mark = hl === undefined ? undefined : attr(hl.attrs, 'val') !== 'none';
  return out;
}

/** `over` wins wherever it states something. */
export function mergeRunProps(base: RunProps, over: RunProps): RunProps {
  const out: RunProps = { ...base };
  for (const key of Object.keys(over) as (keyof RunProps)[]) {
    if (over[key] !== undefined) {
      out[key] = over[key];
    }
  }
  return out;
}

const MAX_CHAIN = 32;

export class Styles {
  private readonly byId = new Map<string, StyleDef>();

  constructor(xml: string | undefined) {
    if (xml === undefined) {
      return;
    }
    const root = parseXml(xml).children[0];
    for (const s of root?.children ?? []) {
      if (s.name !== 'style') {
        continue;
      }
      const id = attr(s.attrs, 'styleId');
      if (!id) {
        continue;
      }
      const pPr = child(s, 'pPr');
      const numPr = pPr && child(pPr, 'numPr');
      const numId = numPr && child(numPr, 'numId');
      const ilvl = numPr && child(numPr, 'ilvl');
      const outline = pPr && child(pPr, 'outlineLvl');
      const jc = pPr && child(pPr, 'jc');
      this.byId.set(id, {
        id,
        name: attr(child(s, 'name')?.attrs ?? {}, 'val') ?? id,
        basedOn: attr(child(s, 'basedOn')?.attrs ?? {}, 'val'),
        outlineLvl: outline && intAttr(outline.attrs, 'val'),
        numId: numId && attr(numId.attrs, 'val'),
        ilvl: ilvl && intAttr(ilvl.attrs, 'val'),
        jc: jc && attr(jc.attrs, 'val'),
        run: readRunProps(child(s, 'rPr')),
      });
    }
  }

  /** The style and everything it is based on, nearest first. Cycle-safe. */
  private chain(id: string | undefined): StyleDef[] {
    const out: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = id;
    while (cur !== undefined && !seen.has(cur) && out.length < MAX_CHAIN) {
      seen.add(cur);
      const def = this.byId.get(cur);
      if (def === undefined) {
        break;
      }
      out.push(def);
      cur = def.basedOn;
    }
    return out;
  }

  /** A character style's flags, with its `basedOn` chain folded in. */
  runStyle(id: string | undefined): RunProps {
    let props: RunProps = {};
    for (const def of this.chain(id).reverse()) {
      props = mergeRunProps(props, def.run);
    }
    return props;
  }

  /** Heading level for a paragraph, from its own outline level or its style chain. */
  heading(styleId: string | undefined, directOutline: number | undefined): HeadingInfo | undefined {
    if (directOutline !== undefined) {
      return outlineToHeading(directOutline);
    }
    for (const def of this.chain(styleId)) {
      if (def.outlineLvl !== undefined) {
        // A style that explicitly says "body text" (9) ends the search; it is
        // not a heading, whatever it is based on.
        return outlineToHeading(def.outlineLvl);
      }
      for (const key of [def.id, def.name]) {
        const m = /^heading\s*([1-9])$/i.exec(key.trim());
        if (m) {
          return { level: Math.min(6, Number(m[1])), title: false };
        }
        if (/^title$/i.test(key.trim())) {
          return { level: 1, title: true };
        }
      }
    }
    return undefined;
  }

  /** Whether the style (or one it is based on) is a block quote. */
  isQuote(styleId: string | undefined): boolean {
    return this.chain(styleId).some((def) =>
      [def.id, def.name].some((k) => /^(quote|intense\s*quote|block\s*text)$/i.test(k.trim())),
    );
  }

  /** The paragraph style's own monospace-ness (a "Code" or "Preformatted" style). */
  isMono(styleId: string | undefined): boolean {
    for (const def of this.chain(styleId)) {
      if (def.run.mono !== undefined) {
        return def.run.mono;
      }
    }
    return false;
  }

  /** The list a paragraph style carries, if any. */
  numbering(styleId: string | undefined): { numId?: string; ilvl?: number } {
    let numId: string | undefined;
    let ilvl: number | undefined;
    for (const def of this.chain(styleId)) {
      numId ??= def.numId;
      ilvl ??= def.ilvl;
    }
    return { numId, ilvl };
  }

  /** Inherited paragraph alignment. */
  jc(styleId: string | undefined): string | undefined {
    for (const def of this.chain(styleId)) {
      if (def.jc !== undefined) {
        return def.jc;
      }
    }
    return undefined;
  }
}

function outlineToHeading(outline: number): HeadingInfo | undefined {
  // 0 to 8 are outline levels 1 to 9; 9 is "body text". HTML stops at h6.
  if (outline < 0 || outline > 8) {
    return undefined;
  }
  return { level: Math.min(6, outline + 1), title: false };
}
