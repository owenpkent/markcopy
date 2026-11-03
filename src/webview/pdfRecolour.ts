// Dark and green PDF pages invert the rasterised page so text reads light on
// dark. Inverting photos and figures as well turns them into negatives, so the
// viewer renders image-bearing pages twice: once in full, once with the raster
// image paint operations filtered out. Any pixel the two renders disagree on was
// touched by an image and keeps its true colour; every other pixel is inverted.
// Comparing renders, rather than restoring image rectangles, keeps transparent
// logos and rotated or clipped pictures exact.

import { OPS } from 'pdfjs-dist';

// Raster image paints. Image masks (stencils painted in the fill colour, like
// glyphs) are left out so they invert with the text.
export const IMAGE_OPS: ReadonlySet<number> = new Set([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
]);

export function hasImageOps(fnArray: ArrayLike<number>): boolean {
  for (let i = 0; i < fnArray.length; i++) {
    if (IMAGE_OPS.has(fnArray[i])) return true;
  }
  return false;
}

// Above this share of image pixels the page is treated as a scan: the image IS
// the text, so the whole page inverts like any other dark page.
export const SCAN_COVERAGE = 0.85;

export type Tint = 'inverted' | 'green';

// Recolour `full` in place. `noImages` is the same page rendered without image
// paints. Inverted pixels are 255 - c; green multiplies that by `green` (RGB).
// Returns false, leaving `full` untouched, when images cover so much of the page
// that it should be inverted wholesale instead.
export function recolourKeepingImages(
  full: Uint8ClampedArray,
  noImages: Uint8ClampedArray,
  tint: Tint,
  green: readonly [number, number, number] = [0, 255, 0],
): boolean {
  const n = full.length;
  let imagePixels = 0;
  for (let i = 0; i < n; i += 4) {
    if (
      full[i] !== noImages[i] ||
      full[i + 1] !== noImages[i + 1] ||
      full[i + 2] !== noImages[i + 2] ||
      full[i + 3] !== noImages[i + 3]
    ) {
      imagePixels++;
    }
  }
  if (imagePixels > (n / 4) * SCAN_COVERAGE) {
    return false;
  }
  const [gr, gg, gb] = tint === 'green' ? green : [255, 255, 255];
  for (let i = 0; i < n; i += 4) {
    if (
      full[i] !== noImages[i] ||
      full[i + 1] !== noImages[i + 1] ||
      full[i + 2] !== noImages[i + 2] ||
      full[i + 3] !== noImages[i + 3]
    ) {
      continue;
    }
    full[i] = ((255 - full[i]) * gr) / 255;
    full[i + 1] = ((255 - full[i + 1]) * gg) / 255;
    full[i + 2] = ((255 - full[i + 2]) * gb) / 255;
  }
  return true;
}
