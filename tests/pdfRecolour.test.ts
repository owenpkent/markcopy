import { OPS } from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { hasImageOps, recolourKeepingImages } from '../src/webview/pdfRecolour';

// One RGBA pixel per entry.
function px(...pixels: [number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flatMap(([r, g, b]) => [r, g, b, 255]));
}

describe('hasImageOps', () => {
  it('finds raster image paints but not image masks', () => {
    expect(hasImageOps([OPS.save, OPS.paintImageXObject, OPS.restore])).toBe(true);
    expect(hasImageOps([OPS.save, OPS.paintImageMaskXObject, OPS.restore])).toBe(false);
    expect(hasImageOps([])).toBe(false);
  });
});

describe('recolourKeepingImages', () => {
  it('inverts page pixels and keeps image pixels in true colour', () => {
    // white background, black text, a red photo pixel, white background
    const full = px([255, 255, 255], [0, 0, 0], [200, 30, 40], [255, 255, 255]);
    const bare = px([255, 255, 255], [0, 0, 0], [255, 255, 255], [255, 255, 255]);
    expect(recolourKeepingImages(full, bare, 'inverted')).toBe(true);
    expect(Array.from(full)).toEqual(
      Array.from(px([0, 0, 0], [255, 255, 255], [200, 30, 40], [0, 0, 0])),
    );
  });

  it('tints the inverted page green but leaves images alone', () => {
    const full = px([255, 255, 255], [0, 0, 0], [10, 20, 30], [255, 255, 255]);
    const bare = px([255, 255, 255], [0, 0, 0], [255, 255, 255], [255, 255, 255]);
    expect(recolourKeepingImages(full, bare, 'green', [0, 255, 0])).toBe(true);
    expect(Array.from(full)).toEqual(
      Array.from(px([0, 0, 0], [0, 255, 0], [10, 20, 30], [0, 0, 0])),
    );
  });

  it('declines a scan, where an image covers nearly the whole page', () => {
    const full = px([250, 250, 250], [10, 10, 10], [250, 250, 250], [250, 250, 250]);
    const bare = px([255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255]);
    const before = Array.from(full);
    expect(recolourKeepingImages(full, bare, 'inverted')).toBe(false);
    expect(Array.from(full)).toEqual(before);
  });
});
