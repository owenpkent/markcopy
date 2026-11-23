// The file's icon, as a PNG the preview can show.
//
// An executable keeps its icon as two kinds of resource: a group, which lists
// the sizes on offer, and one image per size. Each image is either a PNG as is
// (what every 256 pixel icon since Windows Vista is) or a device-independent
// bitmap with a transparency mask after it. The PNG is passed through; the
// bitmap is decoded here and re-encoded as PNG, because the shared preview
// accepts ordinary image types only and its exports go through a canvas.
//
// Everything is bounded: an icon is at most 256 pixels square by the format's
// own limits, and anything that claims otherwise is not drawn.
import { zlibSync } from 'fflate';

export interface IconChoice {
  /** The resource id of the image the group names. */
  id: number;
  width: number;
  height: number;
  bitCount: number;
}

export interface PeIcon {
  width: number;
  height: number;
  png: Uint8Array;
}

const MAX_SIDE = 256;
// A PNG states its own size. One much larger than an icon can be is refused
// rather than handed to a decoder.
const MAX_PNG_SIDE = 1024;

/**
 * The best image in an icon group: the largest, and among equals the deepest.
 * `maxBytes` skips images too big to be worth reading.
 */
export function pickIcon(group: Uint8Array, maxBytes: number): IconChoice | undefined {
  if (group.length < 6) {
    return undefined;
  }
  const view = new DataView(group.buffer, group.byteOffset, group.byteLength);
  // Type 1 is an icon group; 2 is a cursor group, which has other fields here.
  if (view.getUint16(2, true) !== 1) {
    return undefined;
  }
  const count = Math.min(view.getUint16(4, true), 64);
  let best: IconChoice | undefined;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 14;
    if (at + 14 > group.length) {
      break;
    }
    const bytes = view.getUint32(at + 8, true);
    if (bytes === 0 || bytes > maxBytes) {
      continue;
    }
    // A zero in a one-byte size field means 256.
    const choice: IconChoice = {
      width: view.getUint8(at) || 256,
      height: view.getUint8(at + 1) || 256,
      bitCount: view.getUint16(at + 6, true),
      id: view.getUint16(at + 12, true),
    };
    if (
      !best ||
      choice.width > best.width ||
      (choice.width === best.width && choice.bitCount > best.bitCount)
    ) {
      best = choice;
    }
  }
  return best;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit RGBA pixels, top row first, as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  // Each row is prefixed with its filter type; 0 is "none".
  const rows = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(rows)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// An icon bitmap is a BITMAPINFOHEADER, an optional palette, the colour rows
// (bottom row first, each padded to four bytes), then a one-bit-per-pixel mask
// in the same layout where a set bit means transparent. Its header states
// twice the real height, to count the mask.
function bitmapToPng(data: Uint8Array): PeIcon | undefined {
  if (data.length < 40) {
    return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getInt32(4, true);
  const height = view.getInt32(8, true) / 2;
  const bitCount = view.getUint16(14, true);
  if (
    view.getUint32(0, true) !== 40 ||
    // Only uncompressed bitmaps: the compressed kinds are not used for icons.
    view.getUint32(16, true) !== 0 ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    ![1, 4, 8, 24, 32].includes(bitCount)
  ) {
    return undefined;
  }
  const paletteSize =
    bitCount <= 8 ? Math.min(view.getUint32(32, true) || 1 << bitCount, 1 << bitCount) : 0;
  const pixels = 40 + paletteSize * 4;
  const rowBytes = ((width * bitCount + 31) >>> 5) * 4;
  const maskRowBytes = ((width + 31) >>> 5) * 4;
  const mask = pixels + rowBytes * height;
  if (mask > data.length) {
    return undefined;
  }
  const hasMask = mask + maskRowBytes * height <= data.length;

  const rgba = new Uint8Array(width * height * 4);
  let sawAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixels + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (bitCount === 32 || bitCount === 24) {
        const at = row + x * (bitCount / 8);
        rgba[out] = data[at + 2];
        rgba[out + 1] = data[at + 1];
        rgba[out + 2] = data[at];
        rgba[out + 3] = bitCount === 32 ? data[at + 3] : 255;
        sawAlpha ||= bitCount === 32 && data[at + 3] !== 0;
      } else {
        const bit = x * bitCount;
        const index =
          (data[row + (bit >>> 3)] >>> (8 - bitCount - (bit & 7))) & ((1 << bitCount) - 1);
        const at = 40 + Math.min(index, paletteSize - 1) * 4;
        rgba[out] = data[at + 2];
        rgba[out + 1] = data[at + 1];
        rgba[out + 2] = data[at];
        rgba[out + 3] = 255;
      }
    }
  }
  // A 32-bit icon carries its own transparency. One whose alpha is zero
  // throughout was written by a tool that left the channel unused, and is
  // meant to be cut out by the mask like the shallower formats are.
  if (!sawAlpha) {
    for (let y = 0; y < height; y++) {
      const row = mask + (height - 1 - y) * maskRowBytes;
      for (let x = 0; x < width; x++) {
        const hidden = hasMask && (data[row + (x >>> 3)] & (0x80 >>> (x & 7))) !== 0;
        rgba[(y * width + x) * 4 + 3] = hidden ? 0 : 255;
      }
    }
  }
  return { width, height, png: encodePng(width, height, rgba) };
}

/** One icon image resource as a PNG, or undefined when it is not something to draw. */
export function iconToPng(data: Uint8Array): PeIcon | undefined {
  if (data.length >= 24 && PNG_SIGNATURE.every((byte, i) => data[i] === byte)) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width >= 1 && height >= 1 && width <= MAX_PNG_SIDE && height <= MAX_PNG_SIDE
      ? { width, height, png: data }
      : undefined;
  }
  return bitmapToPng(data);
}
