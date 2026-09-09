// Turning the data URIs the webview inlined into image parts for the package.
//
// The webview hands over every image as a `data:` URI in png, jpeg or gif form
// (it rasterizes anything else through a canvas first, because Word only takes
// an SVG alongside a raster fallback part and that is not worth the complexity).
// Dimensions are read from the bytes here rather than measured in the webview:
// the export needs a size for every image, including ones that never got layout,
// and sniffing a header is deterministic and testable in a way a `getBoundingClientRect`
// round trip is not.

/** English Metric Units per CSS pixel at 96 dpi: 914400 EMU/inch / 96. */
export const EMU_PER_PX = 9525;

/** Usable width of a Letter page at 1" margins, in CSS pixels (6.5in x 96). */
export const CONTENT_WIDTH_PX = 624;

export interface DecodedImage {
  bytes: Uint8Array;
  /** File extension for the part name, which is also the Content_Types key. */
  ext: 'png' | 'jpeg' | 'gif';
  widthPx: number;
  heightPx: number;
}

/**
 * Decode a `data:` URI into bytes plus intrinsic size.
 *
 * Returns undefined for anything this cannot embed: a remote `http(s):` src the
 * webview could not inline, a media type Word has no part for, or a payload
 * whose header does not parse. The caller reports those rather than failing the
 * export, so one broken image never costs the reader the other forty.
 */
export function decodeImage(src: string): DecodedImage | undefined {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(src.trim());
  if (!match) {
    return undefined;
  }
  const [, mime, isBase64, payload] = match;
  const ext = extensionFor(mime.toLowerCase());
  if (!ext) {
    return undefined;
  }

  let bytes: Uint8Array;
  try {
    bytes = isBase64
      ? new Uint8Array(Buffer.from(payload, 'base64'))
      : new Uint8Array(Buffer.from(decodeURIComponent(payload), 'binary'));
  } catch {
    return undefined;
  }

  const size = imageSize(bytes);
  return size ? { bytes, ext, widthPx: size.width, heightPx: size.height } : undefined;
}

function extensionFor(mime: string): DecodedImage['ext'] | undefined {
  if (mime === 'image/png') {
    return 'png';
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return 'jpeg';
  }
  if (mime === 'image/gif') {
    return 'gif';
  }
  return undefined;
}

/** Intrinsic pixel size, read from the header of a PNG, JPEG or GIF. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  return pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 24 || !PNG_MAGIC.every((byte, i) => b[i] === byte)) {
    return undefined;
  }
  // The first chunk of a PNG is required to be IHDR, whose width and height are
  // the first two big-endian uint32s of its data.
  return { width: readU32BE(b, 16), height: readU32BE(b, 20) };
}

function gifSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) {
    return undefined;
  }
  // Logical screen descriptor: two little-endian uint16s right after "GIF89a".
  return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    return undefined;
  }
  // Walk the marker segments to the frame header. Every segment but the
  // standalone ones carries a big-endian length that includes its own two bytes.
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      return undefined; // desynchronized; refuse rather than guess
    }
    const marker = b[i + 1];
    // Fill bytes (0xFF padding) and the standalone markers carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) {
      return undefined;
    }
    if (isFrameHeader(marker)) {
      // SOFn payload: precision byte, then height and width as uint16 BE.
      return i + 9 <= b.length
        ? { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] }
        : undefined;
    }
    i += 2 + length;
  }
  return undefined;
}

/**
 * Whether a marker is one of the SOFn frame headers.
 *
 * SOF0-SOF15 minus the three markers that squat in the same range and are not
 * frame headers: DHT (0xC4), JPG (0xC8) and DAC (0xCC).
 */
function isFrameHeader(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readU32BE(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

/**
 * Display size for an image, in EMU, shrunk to the text column when it is wider.
 *
 * Enlarging a small image is deliberately not done: a 24px icon blown up to the
 * column width is worse than a 24px icon.
 */
export function displayExtent(widthPx: number, heightPx: number): { cx: number; cy: number } {
  const scale = widthPx > CONTENT_WIDTH_PX ? CONTENT_WIDTH_PX / widthPx : 1;
  return {
    cx: Math.max(1, Math.round(widthPx * scale * EMU_PER_PX)),
    cy: Math.max(1, Math.round(heightPx * scale * EMU_PER_PX)),
  };
}
