// theme1.xml: the twelve-colour scheme, and the arithmetic that turns a
// <a:schemeClr> reference plus a slide master's <p:clrMap> into an actual hex
// colour.
import { attr, walkXml } from '../../ooxml/xml';

export interface Theme {
  /** dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink -> "RRGGBB", uppercase. */
  colors: Record<string, string>;
}

const SLOTS = [
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
];

export function readTheme(xml: string | undefined): Theme {
  const colors: Record<string, string> = {};
  if (xml === undefined) {
    return { colors };
  }

  let inScheme = false;
  let slot: string | undefined;
  walkXml(xml, {
    open(name, attrs) {
      if (name === 'clrScheme') {
        inScheme = true;
        return;
      }
      if (!inScheme) {
        return;
      }
      if (SLOTS.includes(name)) {
        slot = name;
        return;
      }
      if (slot === undefined) {
        return;
      }
      if (name === 'srgbClr') {
        const val = normalizeHex(attr(attrs, 'val'));
        if (val !== undefined) {
          colors[slot] = val;
        }
      } else if (name === 'sysClr') {
        // dk1/lt1 are routinely a system colour (windowText/window) rather
        // than an explicit RGB. lastClr is the RGB PowerPoint last resolved it
        // to, which is the only value worth showing outside a running Windows
        // session.
        const last = normalizeHex(attr(attrs, 'lastClr'));
        if (last !== undefined) {
          colors[slot] = last;
        }
      }
    },
    close(name) {
      if (name === 'clrScheme') {
        inScheme = false;
      } else if (SLOTS.includes(name)) {
        slot = undefined;
      }
    },
  });

  return { colors };
}

/** bg1/tx1/bg2/tx2/accent1-6/hlink/folHlink -> theme colour slot name. */
export type ClrMap = Record<string, string>;

// Every named slot maps to itself except the four background/text pairs,
// which is what a <p:clrMap> declares even when a master leaves it out
// entirely (some do; the schema treats absence as "use the identity map").
const IDENTITY_CLR_MAP: ClrMap = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
};

/** <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/>, a direct child of <p:sldMaster>. */
export function readClrMap(masterXml: string | undefined): ClrMap {
  if (masterXml === undefined) {
    return IDENTITY_CLR_MAP;
  }
  let map: ClrMap | undefined;
  walkXml(masterXml, {
    open(name, attrs) {
      if (name !== 'clrMap' || map !== undefined) {
        return;
      }
      map = { ...IDENTITY_CLR_MAP };
      for (const slotName of Object.keys(IDENTITY_CLR_MAP)) {
        const v = attr(attrs, slotName);
        if (v) {
          map[slotName] = v;
        }
      }
    },
  });
  return map ?? IDENTITY_CLR_MAP;
}

/**
 * Resolve a `<a:schemeClr val="...">` name to a hex colour.
 *
 * bg1/tx1/bg2/tx2 go through the master's colour map first (a slide almost
 * always means "the theme colour this master currently calls text", not
 * literally "dk1"); accent1-6, hlink and folHlink are conventionally identity
 * mapped but are still looked up through the map, in case a master remaps
 * them too. A theme this reader could not resolve falls back to something
 * legible rather than throwing: white for the two background names, black for
 * everything else, which is what most authored decks actually use there.
 */
export function resolveSchemeColor(theme: Theme, clrMap: ClrMap, name: string): string {
  const slot = clrMap[name] ?? name;
  const hex = theme.colors[slot];
  if (hex !== undefined) {
    return hex;
  }
  return name === 'bg1' || name === 'lt1' ? 'FFFFFF' : '000000';
}

export interface ColorMods {
  /** All four are OOXML percentages in thousandths (60000 = 60%). */
  lumMod?: number;
  lumOff?: number;
  shade?: number;
  tint?: number;
}

/**
 * A cheap brightness adjustment for lumMod/lumOff/shade/tint.
 *
 * These are theme-color variants ("Accent 1, Lighter 60%") that PowerPoint
 * computes in HSLuv-ish colour space. Reproducing that exactly needs a real
 * HSL round trip; this does the adjustment per RGB channel instead, which is
 * wrong by a few percent on saturated colours but never wrong in hue, and for
 * a preview that is the trade the design doc asks for: "if cheap... otherwise
 * ignore them rather than getting the hue wrong."
 */
export function applyColorMods(hex: string, mods: ColorMods): string {
  if (
    mods.lumMod === undefined &&
    mods.lumOff === undefined &&
    mods.shade === undefined &&
    mods.tint === undefined
  ) {
    return hex;
  }
  let [r, g, b] = hexToRgb(hex);
  const frac = (v: number): number => v / 100000;

  if (mods.shade !== undefined) {
    const f = frac(mods.shade);
    r *= f;
    g *= f;
    b *= f;
  }
  if (mods.tint !== undefined) {
    const f = 1 - frac(mods.tint);
    r += (255 - r) * f;
    g += (255 - g) * f;
    b += (255 - b) * f;
  }
  if (mods.lumMod !== undefined || mods.lumOff !== undefined) {
    const m = mods.lumMod === undefined ? 1 : frac(mods.lumMod);
    const o = mods.lumOff === undefined ? 0 : frac(mods.lumOff) * 255;
    r = r * m + o;
    g = g * m + o;
    b = b * m + o;
  }
  return rgbToHex(r, g, b);
}

/**
 * An `RRGGBB` attribute, or undefined for anything else.
 *
 * Every colour in a deck is attacker-controlled text, and the reader's only
 * consumer for one is a CSS declaration: `color:#` plus whatever the file said.
 * A value of `ABC;background:url(https://example.invalid/x)` would therefore
 * close the declaration and open another, and the preview CSP allows `https:`
 * for images, so merely opening a file would fetch from a host it names. That
 * is the same leak src/ooxml/rels.ts refuses external relationships to prevent,
 * arriving through CSS instead of through a rel, so it is refused the same way:
 * at the boundary, by shape, rather than by escaping further downstream.
 */
export function normalizeHex(value: string | undefined): string | undefined {
  return value !== undefined && /^[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : undefined;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = /^[0-9a-f]{6}$/i.test(hex) ? hex : '000000';
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return [r, g, b]
    .map((c) => clamp255(c).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function clamp255(n: number): number {
  return Math.round(Math.min(255, Math.max(0, n)));
}
