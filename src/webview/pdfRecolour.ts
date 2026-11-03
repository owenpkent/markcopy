// Dark and green PDF pages invert the rasterised page so text reads light on
// dark. Inverting photos and figures as well turns them into negatives, so a
// page that paints raster images gets a second, "coverage" render: the same
// operator list on a transparent canvas with text and vector paints filtered
// out. Its alpha channel is exactly where visible images landed (after clips,
// soft masks, and the images' own transparency), whatever their colours, so a
// white region of a photo is told apart from the white paper beside it. Pixels
// the coverage marks keep their true colour; every other pixel is inverted.

import { OPS } from 'pdfjs-dist';

// Raster image paints. Image masks (stencils painted in the fill colour, like
// glyphs) are not here: they invert with the text.
export const IMAGE_OPS: ReadonlySet<number> = new Set([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
]);

// Operations that paint page content other than raster images. Everything else
// (graphics state, transforms, clips, groups, forms, annotations) is kept so the
// images in the coverage render land exactly where they do on the page.
const NON_IMAGE_PAINTS: ReadonlySet<number> = new Set([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
  OPS.shadingFill,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintSolidColorImageMask,
  OPS.rawFillPath,
]);

const CLIP_OPS: ReadonlySet<number> = new Set([OPS.clip, OPS.eoClip]);

export function hasImageOps(fnArray: ArrayLike<number>): boolean {
  for (let i = 0; i < fnArray.length; i++) {
    if (IMAGE_OPS.has(fnArray[i])) return true;
  }
  return false;
}

const TEXT_SHOW_OPS: ReadonlySet<number> = new Set([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
]);

// Operations that save or restore the graphics state, which carries the text
// rendering mode.
const STATE_PUSH: ReadonlySet<number> = new Set([
  OPS.save,
  OPS.paintFormXObjectBegin,
  OPS.beginGroup,
  OPS.beginAnnotation,
]);
const STATE_POP: ReadonlySet<number> = new Set([
  OPS.restore,
  OPS.paintFormXObjectEnd,
  OPS.endGroup,
  OPS.endAnnotation,
]);

// Text rendering modes 4 to 7 add the glyphs to the clipping path; 7 paints
// nothing else.
const TEXT_CLIP_FIRST = 4;
const TEXT_CLIP_ONLY = 7;

export interface CoveragePlan {
  // Operations the coverage render runs, indexed like the operator list.
  coverage: boolean[];
  // Operations for a second, image-free render of the paints the coverage render
  // could not drop (see below), or null when it ran none.
  paints: boolean[] | null;
}

// Plan the coverage render. Graphics state, transforms, clips, groups, forms,
// and annotations run so each image lands exactly where it does on the page;
// text and vector paints are dropped, with these exceptions:
//
// - Inside a soft-mask group everything runs: those operations only build the
//   mask, never visible content, and dropping any of them (an image included)
//   would change what the mask lets through.
// - A painting path with a pending clip (`W f`, `W S`) runs, because pdf.js
//   applies the clip in the painting operation.
// - Text in a clipping render mode (4 to 7) runs, because showing it is what
//   builds the glyph clip that `endText` applies.
//
// The last two can paint (all but mode 7 do). Their paint is not an image, so
// `paints` replays the same plan without the images, and the recolour discounts
// what that render painted.
export function imageCoverageOps(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
): CoveragePlan {
  const coverage: boolean[] = new Array(fnArray.length);
  // Whether each operation is a visible image paint (one outside a mask group).
  const visibleImage: boolean[] = new Array(fnArray.length).fill(false);
  let painted = false;
  // One entry per open group: whether it, or a group around it, builds a soft mask.
  const groups: boolean[] = [];
  const textModes: number[] = [];
  let textMode = 0;
  let clipPending = false;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null | undefined;
    const inMask = groups.length > 0 && groups[groups.length - 1];
    coverage[i] = true;

    if (STATE_PUSH.has(fn)) {
      textModes.push(textMode);
      if (fn === OPS.beginAnnotation) textMode = 0;
    } else if (STATE_POP.has(fn)) {
      textMode = textModes.pop() ?? 0;
    } else if (fn === OPS.setTextRenderingMode) {
      textMode = Number(args?.[0]) || 0;
    }
    if (fn === OPS.beginGroup) {
      const group = args?.[0] as { smask?: unknown } | undefined;
      groups.push(inMask || !!group?.smask);
      continue;
    }
    if (fn === OPS.endGroup) {
      groups.pop();
      continue;
    }
    if (inMask) {
      continue;
    }
    if (IMAGE_OPS.has(fn)) {
      visibleImage[i] = true;
      continue;
    }
    if (CLIP_OPS.has(fn)) {
      clipPending = true;
      continue;
    }
    if (fn === OPS.constructPath) {
      const paints = args?.[0] !== OPS.endPath;
      coverage[i] = !paints || clipPending;
      painted ||= paints && clipPending;
      clipPending = false;
      continue;
    }
    if (TEXT_SHOW_OPS.has(fn)) {
      coverage[i] = textMode >= TEXT_CLIP_FIRST;
      painted ||= textMode >= TEXT_CLIP_FIRST && textMode !== TEXT_CLIP_ONLY;
      continue;
    }
    if (NON_IMAGE_PAINTS.has(fn)) {
      coverage[i] = clipPending;
      painted ||= clipPending;
      clipPending = false;
    }
  }
  const paints = painted ? coverage.map((run, i) => run && !visibleImage[i]) : null;
  return { coverage, paints };
}

// Above this share of covered pixels the page is treated as a scan: the image IS
// the text, so the whole page inverts like any other dark page.
export const SCAN_COVERAGE = 0.85;

export type Tint = 'inverted' | 'green';

// How strongly an image covers pixel `i` (the index of its red byte), 0 to 255.
// Where the image-free `paints` render painted too, the pixel is image only if
// the image changed it.
function imageAlpha(
  coverage: Uint8ClampedArray,
  paints: Uint8ClampedArray | undefined,
  i: number,
): number {
  const a = coverage[i + 3];
  if (a === 0 || !paints || paints[i + 3] === 0) return a;
  return coverage[i] === paints[i] &&
    coverage[i + 1] === paints[i + 1] &&
    coverage[i + 2] === paints[i + 2] &&
    a === paints[i + 3]
    ? 0
    : a;
}

// Recolour `page` (RGBA, opaque) in place using `coverage` (RGBA, the coverage
// render on a transparent canvas) and, when the plan has one, `paints` (the
// image-free render of its paints). Uncovered pixels become 255 - c, multiplied
// by `green` for the green theme; covered pixels keep their colour, and partly
// covered ones (antialiased or translucent image edges) blend between the two.
// Returns false, leaving `page` untouched, when images cover so much of the page
// that it should be inverted wholesale instead.
export function recolourKeepingImages(
  page: Uint8ClampedArray,
  coverage: Uint8ClampedArray,
  tint: Tint,
  green: readonly [number, number, number] = [0, 255, 0],
  paints?: Uint8ClampedArray,
): boolean {
  const n = page.length;
  const alpha = new Uint8Array(n / 4);
  let covered = 0;
  for (let i = 0, p = 0; i < n; i += 4, p++) {
    const a = imageAlpha(coverage, paints, i);
    alpha[p] = a;
    if (a !== 0) covered++;
  }
  if (covered > (n / 4) * SCAN_COVERAGE) {
    return false;
  }
  const [gr, gg, gb] = tint === 'green' ? green : [255, 255, 255];
  for (let i = 0, p = 0; i < n; i += 4, p++) {
    const a = alpha[p];
    if (a === 255) continue;
    const r = ((255 - page[i]) * gr) / 255;
    const g = ((255 - page[i + 1]) * gg) / 255;
    const b = ((255 - page[i + 2]) * gb) / 255;
    if (a === 0) {
      page[i] = r;
      page[i + 1] = g;
      page[i + 2] = b;
    } else {
      const k = a / 255;
      page[i] = r + (page[i] - r) * k;
      page[i + 1] = g + (page[i + 1] - g) * k;
      page[i + 2] = b + (page[i + 2] - b) * k;
    }
  }
  return true;
}
