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
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
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

// Which operations the coverage render runs, indexed like the operator list.
//
// - Inside a soft-mask group everything runs: those operations only build the
//   mask, never visible content, and dropping any of them (an image included)
//   would change what the mask lets through.
// - A path that paints is dropped, unless a clip is pending for it (`W f`): the
//   clip is applied by the painting operation, so it has to run. That fill then
//   counts as image coverage, which only keeps a patch in true colour, never
//   loses content.
// - Text and other non-image paints are dropped.
export function imageCoverageOps(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
): boolean[] {
  const keep: boolean[] = new Array(fnArray.length);
  // One entry per open group: whether it, or a group around it, builds a soft mask.
  const groups: boolean[] = [];
  let clipPending = false;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const inMask = groups.length > 0 && groups[groups.length - 1];
    if (fn === OPS.beginGroup) {
      const group = (argsArray[i] as unknown[] | null)?.[0] as { smask?: unknown } | undefined;
      groups.push(inMask || !!group?.smask);
      keep[i] = true;
      continue;
    }
    if (fn === OPS.endGroup) {
      groups.pop();
      keep[i] = true;
      continue;
    }
    if (inMask) {
      keep[i] = true;
      continue;
    }
    if (CLIP_OPS.has(fn)) {
      clipPending = true;
      keep[i] = true;
      continue;
    }
    if (fn === OPS.constructPath) {
      const paintOp = (argsArray[i] as unknown[] | null)?.[0];
      keep[i] = paintOp === OPS.endPath || clipPending;
      clipPending = false;
      continue;
    }
    if (NON_IMAGE_PAINTS.has(fn)) {
      keep[i] = clipPending;
      clipPending = false;
      continue;
    }
    keep[i] = true;
  }
  return keep;
}

// Above this share of covered pixels the page is treated as a scan: the image IS
// the text, so the whole page inverts like any other dark page.
export const SCAN_COVERAGE = 0.85;

export type Tint = 'inverted' | 'green';

// Recolour `page` (RGBA, opaque) in place using `coverage` (RGBA, the image-only
// render on a transparent canvas). Uncovered pixels become 255 - c, multiplied by
// `green` for the green theme; covered pixels keep their colour, and partly
// covered ones (antialiased or translucent image edges) blend between the two.
// Returns false, leaving `page` untouched, when images cover so much of the page
// that it should be inverted wholesale instead.
export function recolourKeepingImages(
  page: Uint8ClampedArray,
  coverage: Uint8ClampedArray,
  tint: Tint,
  green: readonly [number, number, number] = [0, 255, 0],
): boolean {
  const n = page.length;
  let covered = 0;
  for (let i = 3; i < n; i += 4) {
    if (coverage[i] !== 0) covered++;
  }
  if (covered > (n / 4) * SCAN_COVERAGE) {
    return false;
  }
  const [gr, gg, gb] = tint === 'green' ? green : [255, 255, 255];
  for (let i = 0; i < n; i += 4) {
    const a = coverage[i + 3];
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
