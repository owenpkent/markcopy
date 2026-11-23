import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng, iconToPng, pickIcon } from '../../src/pe';
import { iconBitmap, iconGroup, pngStub, type BitmapSpec, type IconSpec } from './fixture';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Decoded {
  width: number;
  height: number;
  /** One [r, g, b, a] per pixel, top row first. */
  pixels: number[][];
  chunks: string[];
}

/** A PNG decoder for what encodePng writes (8-bit RGBA, filter 0), verifying every CRC. */
function decodePng(png: Uint8Array): Decoded {
  expect(Array.from(png.subarray(0, 8))).toEqual(SIGNATURE);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: string[] = [];
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let at = 8;
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length), `CRC of ${type}`).toBe(
      crc32(png.subarray(at + 4, at + 8 + length)),
    );
    chunks.push(type);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      // 8 bits per channel, colour type 6 (RGBA), deflate, adaptive filtering, no interlace.
      expect(Array.from(body.subarray(8))).toEqual([8, 6, 0, 0, 0]);
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    at += 12 + length;
  }
  expect(at).toBe(png.length);
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((width * 4 + 1) * height);
  const pixels: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    expect(raw[row], `filter of row ${y}`).toBe(0);
    for (let x = 0; x < width; x++) {
      pixels.push(Array.from(raw.subarray(row + 1 + x * 4, row + 5 + x * 4)));
    }
  }
  return { width, height, pixels, chunks };
}

const decode = (spec: BitmapSpec): Decoded => {
  const icon = iconToPng(iconBitmap(spec));
  expect(icon).toBeDefined();
  expect(icon).toMatchObject({ width: spec.width, height: spec.height });
  return decodePng(icon!.png);
};

describe('encodePng', () => {
  it('writes a valid PNG whose rows inflate back to the pixels', () => {
    const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) & 0xff);
    const png = encodePng(3, 2, rgba);
    const decoded = decodePng(png);
    expect(decoded.chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect(decoded.pixels.flat()).toEqual(Array.from(rgba));
  });

  it('writes a 1x1 image', () => {
    expect(decodePng(encodePng(1, 1, Uint8Array.from([1, 2, 3, 4]))).pixels).toEqual([
      [1, 2, 3, 4],
    ]);
  });
});

describe('iconToPng: bitmap depths', () => {
  const red: [number, number, number, number] = [255, 0, 0, 255];
  const green: [number, number, number, number] = [0, 255, 0, 128];
  const blue: [number, number, number, number] = [0, 0, 255, 255];
  const white: [number, number, number, number] = [255, 255, 255, 255];

  it('decodes 32 bits per pixel, taking transparency from the alpha channel', () => {
    const decoded = decode({
      width: 2,
      height: 2,
      bitCount: 32,
      rgba: [red, green, blue, white],
      // A mask that hides everything is ignored when the image has alpha of its own.
      transparent: [true, true, true, true],
    });
    expect(decoded.pixels).toEqual([red, green, blue, white]);
  });

  it('cuts a 32-bit image whose alpha is all zero out by its mask', () => {
    const zero = (c: [number, number, number, number]): [number, number, number, number] => [
      c[0],
      c[1],
      c[2],
      0,
    ];
    const decoded = decode({
      width: 2,
      height: 2,
      bitCount: 32,
      rgba: [zero(red), zero(green), zero(blue), zero(white)],
      transparent: [false, true, true, false],
    });
    expect(decoded.pixels).toEqual([red, [0, 255, 0, 0], [0, 0, 255, 0], white]);
  });

  it('shows a 32-bit image with zero alpha as opaque when the mask is missing', () => {
    const decoded = decode({
      width: 2,
      height: 1,
      bitCount: 32,
      rgba: [
        [10, 20, 30, 0],
        [40, 50, 60, 0],
      ],
    });
    expect(decoded.pixels).toEqual([
      [10, 20, 30, 255],
      [40, 50, 60, 255],
    ]);
  });

  it('decodes 24 bits per pixel with its mask', () => {
    const decoded = decode({
      width: 2,
      height: 2,
      bitCount: 24,
      rgba: [red, green, blue, white],
      transparent: [false, false, false, true],
    });
    expect(decoded.pixels).toEqual([red, [0, 255, 0, 255], blue, [255, 255, 255, 0]]);
  });

  it('decodes an 8-bit palettized image with its mask', () => {
    const palette: [number, number, number][] = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
    const decoded = decode({
      width: 3,
      height: 2,
      bitCount: 8,
      palette,
      indices: [0, 1, 2, 2, 1, 0],
      transparent: [false, false, true, false, false, false],
    });
    expect(decoded.pixels).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 0],
      [0, 0, 255, 255],
      [0, 255, 0, 255],
      [255, 0, 0, 255],
    ]);
  });

  it('decodes a 4-bit image, two pixels to a byte, high nibble first', () => {
    const palette: [number, number, number][] = Array.from({ length: 16 }, (_, i) => [
      i * 16,
      0,
      255 - i * 16,
    ]);
    const indices = [0, 1, 2, 3, 15];
    const decoded = decode({
      width: 5,
      height: 1,
      bitCount: 4,
      palette,
      indices,
      transparent: [false, false, false, false, true],
    });
    expect(decoded.pixels).toEqual([
      [0, 0, 255, 255],
      [16, 0, 239, 255],
      [32, 0, 223, 255],
      [48, 0, 207, 255],
      [240, 0, 15, 0],
    ]);
  });

  it('decodes a 1-bit image, leftmost pixel in the high bit', () => {
    const palette: [number, number, number][] = [
      [0, 0, 0],
      [255, 255, 255],
    ];
    const indices = [1, 0, 0, 1, 1, 0, 1, 0, 1, 1];
    const decoded = decode({ width: 10, height: 1, bitCount: 1, palette, indices });
    expect(decoded.pixels.map((p) => p[0])).toEqual(indices.map((i) => i * 255));
    expect(decoded.pixels.every((p) => p[3] === 255)).toBe(true);
  });

  it('reads rows bottom-up and skips row padding at an odd width, 24 bits', () => {
    // 5 px at 24 bpp is 15 bytes, padded to 16: a reader that ignored the pad
    // would drift one byte per row and scramble every row after the first.
    const rgba = Array.from({ length: 5 * 3 }, (_, i): [number, number, number, number] => [
      i * 10,
      i * 5,
      255 - i,
      255,
    ]);
    const decoded = decode({
      width: 5,
      height: 3,
      bitCount: 24,
      rgba,
      transparent: rgba.map(() => false),
    });
    expect(decoded.pixels).toEqual(rgba);
  });

  it('reads rows bottom-up and skips row padding at an odd width, 1 bit', () => {
    // 5 px at 1 bpp is one byte, padded to four, in the colour rows and the mask alike.
    const indices = [1, 0, 1, 0, 1, /**/ 0, 0, 1, 1, 0, /**/ 1, 1, 1, 0, 0];
    const palette: [number, number, number][] = [
      [10, 10, 10],
      [200, 200, 200],
    ];
    const transparent = indices.map((_, i) => i % 7 === 0);
    const decoded = decode({ width: 5, height: 3, bitCount: 1, palette, indices, transparent });
    expect(decoded.pixels.map((p) => p[0])).toEqual(indices.map((i) => (i ? 200 : 10)));
    expect(decoded.pixels.map((p) => p[3])).toEqual(transparent.map((t) => (t ? 0 : 255)));
  });

  it('puts the first image row at the top', () => {
    const decoded = decode({
      width: 1,
      height: 2,
      bitCount: 24,
      rgba: [red, blue],
      transparent: [false, false],
    });
    expect(decoded.pixels).toEqual([red, blue]);
  });
});

describe('iconToPng: PNG images', () => {
  it('passes a PNG through as the same bytes', () => {
    const png = encodePng(2, 2, new Uint8Array(16));
    const icon = iconToPng(png);
    expect(icon?.width).toBe(2);
    expect(icon?.height).toBe(2);
    expect(icon?.png).toBe(png);
  });

  it('reads the size of a 256 pixel PNG from its header', () => {
    expect(iconToPng(pngStub(256, 256))).toMatchObject({ width: 256, height: 256 });
  });

  it('refuses a PNG that claims to be larger than an icon can be', () => {
    expect(iconToPng(pngStub(5000, 5000))).toBeUndefined();
    expect(iconToPng(pngStub(1025, 16))).toBeUndefined();
    expect(iconToPng(pngStub(0, 16))).toBeUndefined();
  });
});

describe('iconToPng: refused input', () => {
  const base: BitmapSpec = {
    width: 4,
    height: 4,
    bitCount: 24,
    transparent: Array(16).fill(false),
  };
  const refuses = (spec: BitmapSpec) => {
    expect(() => iconToPng(iconBitmap(spec))).not.toThrow();
    expect(iconToPng(iconBitmap(spec))).toBeUndefined();
  };

  it('accepts the baseline these cases break one field of', () => {
    expect(iconToPng(iconBitmap(base))).toBeDefined();
  });

  it('refuses a bitmap cut inside its colour rows, at every length, without throwing', () => {
    const bytes = iconBitmap(base);
    const colourEnd = 40 + 4 * 12; // header, then four rows of 12 bytes
    for (let n = 0; n < colourEnd; n++) {
      expect(() => iconToPng(bytes.subarray(0, n))).not.toThrow();
      expect(iconToPng(bytes.subarray(0, n)), `${n} bytes`).toBeUndefined();
    }
    // Cut inside the mask, the image is shown opaque instead.
    expect(iconToPng(bytes.subarray(0, colourEnd + 3))).toBeDefined();
  });

  it('refuses an empty input and a short one', () => {
    expect(iconToPng(new Uint8Array(0))).toBeUndefined();
    expect(iconToPng(new Uint8Array(39))).toBeUndefined();
  });

  it('refuses a width of zero, and one over 256', () => {
    refuses({ ...base, width: 0, statedWidth: 0 });
    refuses({ ...base, statedWidth: 300, width: 4 });
  });

  it('refuses a stated height over 256 or an odd one', () => {
    refuses({ ...base, statedHeight: 600 });
    refuses({ ...base, statedHeight: 9 });
    refuses({ ...base, statedHeight: 0 });
  });

  it('refuses a compressed bitmap', () => {
    refuses({ ...base, compression: 1 });
  });

  it('refuses a bit depth outside 1, 4, 8, 24 and 32', () => {
    refuses({ ...base, bitCount: 16 as never });
  });

  it('refuses a header that is not 40 bytes', () => {
    refuses({ ...base, headerSize: 124 });
  });
});

describe('pickIcon', () => {
  const group = (icons: IconSpec[], type = 1) => iconGroup(icons, type);
  const entry = (id: number, width: number, bitCount: number): IconSpec => ({
    id,
    width,
    height: width,
    bitCount,
    data: new Uint8Array(500),
  });

  it('picks the largest image', () => {
    const choice = pickIcon(group([entry(1, 16, 32), entry(2, 48, 8), entry(3, 32, 32)]), 1 << 20);
    expect(choice).toMatchObject({ id: 2, width: 48, height: 48 });
  });

  it('breaks a tie on size by the deeper bit count', () => {
    const choice = pickIcon(group([entry(1, 32, 4), entry(2, 32, 32), entry(3, 32, 8)]), 1 << 20);
    expect(choice).toMatchObject({ id: 2, bitCount: 32 });
  });

  it('reads a size byte of 0 as 256', () => {
    const choice = pickIcon(group([entry(1, 128, 32), entry(7, 256, 32)]), 1 << 20);
    expect(choice).toMatchObject({ id: 7, width: 256, height: 256 });
  });

  it('skips images over the byte limit and entries of no bytes', () => {
    const big: IconSpec = { ...entry(1, 256, 32), data: new Uint8Array(5000) };
    const empty: IconSpec = { ...entry(2, 128, 32), data: new Uint8Array(0) };
    const ok = entry(3, 32, 32);
    expect(pickIcon(group([big, empty, ok]), 1000)).toMatchObject({ id: 3 });
    expect(pickIcon(group([big, empty]), 1000)).toBeUndefined();
  });

  it('refuses a cursor group', () => {
    expect(pickIcon(group([entry(1, 32, 32)], 2), 1 << 20)).toBeUndefined();
  });

  it('refuses a group too short to have a header', () => {
    expect(pickIcon(new Uint8Array(0), 1 << 20)).toBeUndefined();
    expect(pickIcon(new Uint8Array(5), 1 << 20)).toBeUndefined();
  });

  it('uses the entries that are there when the list is cut short', () => {
    const bytes = group([entry(1, 16, 32), entry(2, 32, 32), entry(3, 48, 32)]);
    // Two whole entries and part of the third.
    expect(pickIcon(bytes.subarray(0, 6 + 14 * 2 + 5), 1 << 20)).toMatchObject({ id: 2 });
    expect(pickIcon(bytes.subarray(0, 6), 1 << 20)).toBeUndefined();
  });
});

// A PNG icon is handed to the webview's image decoder as it is, so the reader
// has to be sure it is one. It once checked the signature and the size alone.
describe('iconToPng: only passes through what a PNG icon is', () => {
  const patched = (change: (bytes: Uint8Array) => void): Uint8Array => {
    const bytes = pngStub(256, 256);
    change(bytes);
    return bytes;
  };

  it('accepts a whole header chunk at eight bits a channel', () => {
    expect(iconToPng(pngStub(256, 256))).toMatchObject({ width: 256, height: 256 });
    expect(iconToPng(patched((b) => (b[24] = 1)))).toBeDefined();
  });

  it('refuses sixteen bits a channel, which doubles what a decoder allocates', () => {
    expect(iconToPng(patched((b) => (b[24] = 16)))).toBeUndefined();
  });

  it('refuses a file whose first chunk is not the header', () => {
    // "IDAT" where "IHDR" belongs.
    expect(iconToPng(patched((b) => b.set([0x49, 0x44, 0x41, 0x54], 12)))).toBeUndefined();
    // A header chunk that claims a different length.
    expect(iconToPng(patched((b) => (b[11] = 14)))).toBeUndefined();
  });

  it('refuses a header cut short', () => {
    expect(iconToPng(pngStub(256, 256).subarray(0, 32))).toBeUndefined();
    expect(iconToPng(pngStub(256, 256).subarray(0, 24))).toBeUndefined();
  });

  it('refuses more bytes than an icon needs', () => {
    const header = pngStub(256, 256);
    const padded = new Uint8Array(512 * 1024 + 1);
    padded.set(header);
    expect(iconToPng(padded)).toBeUndefined();
    expect(iconToPng(padded.subarray(0, 512 * 1024))).toBeDefined();
  });
});

// A 24 or 32 bit bitmap needs no colour table and may carry one anyway
// (biClrUsed). The pixels start after it. Skipping none drew the table's first
// colour instead of the icon: Windows draws this file red, and the reader drew
// it green.
describe('iconToPng: a colour table in a direct-colour bitmap', () => {
  const rgbaOf = (png: Uint8Array): number[] => {
    const idat = png.subarray(8 + 25 + 8, png.length - 12 - 4);
    return [...inflateSync(idat)].slice(1, 5);
  };

  it('draws the pixel, not the palette entry before it, at 24 bits', () => {
    const icon = iconToPng(
      iconBitmap({
        width: 1,
        height: 1,
        bitCount: 24,
        palette: [[0, 255, 0]],
        rgba: [[255, 0, 0, 255]],
      }),
    );
    expect(icon).toMatchObject({ width: 1, height: 1 });
    expect(rgbaOf(icon!.png)).toEqual([255, 0, 0, 255]);
  });

  it('does the same at 32 bits, with several entries, and finds the mask after the pixels', () => {
    const icon = iconToPng(
      iconBitmap({
        width: 2,
        height: 1,
        bitCount: 32,
        palette: [
          [0, 255, 0],
          [0, 0, 255],
          [9, 9, 9],
        ],
        rgba: [
          [255, 0, 0, 255],
          [1, 2, 3, 128],
        ],
      }),
    );
    expect(
      [...inflateSync(icon!.png.subarray(8 + 25 + 8, icon!.png.length - 12 - 4))].slice(1, 9),
    ).toEqual([255, 0, 0, 255, 1, 2, 3, 128]);
  });

  it('refuses a colour table that runs past the end of the data', () => {
    const bytes = iconBitmap({ width: 1, height: 1, bitCount: 24, rgba: [[255, 0, 0, 255]] });
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(32, 200, true);
    expect(iconToPng(bytes)).toBeUndefined();
  });
});
