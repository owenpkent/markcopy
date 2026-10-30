// Pure helpers for the image preview, kept out of src/webview/image.ts so they can
// be unit-tested without a DOM (same split as gifInfo.ts and stlInfo.ts).
//
// Every parser here is total: each read is bounds-checked, loops advance or stop,
// and nothing allocates in proportion to a size the file declares. Truncated or
// hostile input yields `undefined` dimensions, never an exception.
import { formatBytes as formatBytesImpl } from './videoInfo';

// The host reads the file whole and sends it as base64 (see src/imageEditor.ts),
// the same cost model and cap as the GIF viewer.
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** Above this, "Copy as Data URI" is refused: a string that long helps no one. */
export const MAX_DATA_URI_BYTES = 4 * 1024 * 1024;
/** The largest side an SVG is rasterised to when copied as PNG. */
export const MAX_SVG_RASTER_SIDE = 16384;

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'ico' | 'avif' | 'svg';

export interface ImageInfo {
  format: ImageFormat;
  mime: string;
  label: string;
  width?: number;
  height?: number;
  /** SVG only, e.g. "0 0 24 24". */
  viewBox?: string;
}

const META: Record<ImageFormat, { mime: string; label: string }> = {
  png: { mime: 'image/png', label: 'PNG' },
  jpeg: { mime: 'image/jpeg', label: 'JPEG' },
  webp: { mime: 'image/webp', label: 'WebP' },
  bmp: { mime: 'image/bmp', label: 'BMP' },
  ico: { mime: 'image/x-icon', label: 'ICO' },
  avif: { mime: 'image/avif', label: 'AVIF' },
  svg: { mime: 'image/svg+xml', label: 'SVG' },
};

const SVG_WINDOW = 4096;
const MAX_DIMENSION = 0x7fffffff;

type Dims = { width: number; height: number } | undefined;

function make(format: ImageFormat, dims?: Dims, viewBox?: string): ImageInfo {
  const info: ImageInfo = { format, ...META[format] };
  if (
    dims &&
    dims.width > 0 &&
    dims.height > 0 &&
    dims.width <= MAX_DIMENSION &&
    dims.height <= MAX_DIMENSION
  ) {
    info.width = dims.width;
    info.height = dims.height;
  }
  if (viewBox !== undefined) {
    info.viewBox = viewBox;
  }
  return info;
}

const u16le = (b: Uint8Array, p: number): number => b[p] | (b[p + 1] << 8);
const u16be = (b: Uint8Array, p: number): number => (b[p] << 8) | b[p + 1];
const u32le = (b: Uint8Array, p: number): number =>
  (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, p: number): number =>
  ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const i32le = (b: Uint8Array, p: number): number =>
  b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);

function ascii(b: Uint8Array, p: number, s: string): boolean {
  if (p < 0 || p + s.length > b.length) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    if (b[p + i] !== s.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function pngDims(b: Uint8Array): Dims {
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) {
    return undefined;
  }
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegDims(b: Uint8Array): Dims {
  let pos = 2;
  while (pos + 1 < b.length) {
    if (b[pos] !== 0xff) {
      pos++;
      continue;
    }
    while (pos < b.length && b[pos] === 0xff) {
      pos++; // fill bytes
    }
    if (pos >= b.length) {
      return undefined;
    }
    const marker = b[pos++];
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue; // no length field
    }
    if (marker === 0xd9 || marker === 0xda) {
      return undefined; // end of image, or start of scan: no frame header seen
    }
    if (pos + 2 > b.length) {
      return undefined;
    }
    const len = u16be(b, pos);
    if (len < 2) {
      return undefined;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8 || pos + 7 > b.length) {
        return undefined;
      }
      return { height: u16be(b, pos + 3), width: u16be(b, pos + 5) };
    }
    pos += len;
  }
  return undefined;
}

function webpDims(b: Uint8Array): Dims {
  if (ascii(b, 12, 'VP8 ')) {
    if (b.length < 30) {
      return undefined;
    }
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      return undefined;
    }
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b.length < 25 || b[20] !== 0x2f) {
      return undefined;
    }
    const width = 1 + (b[21] | ((b[22] & 0x3f) << 8));
    const height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
    return { width, height };
  }
  if (ascii(b, 12, 'VP8X')) {
    if (b.length < 30) {
      return undefined;
    }
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height };
  }
  return undefined;
}

const BMP_DIB_SIZES = [12, 40, 52, 56, 64, 108, 124];

function bmpDims(b: Uint8Array): Dims {
  if (b.length < 18) {
    return undefined;
  }
  if (u32le(b, 14) === 12) {
    // BITMAPCOREHEADER: unsigned 16-bit fields.
    return b.length < 22 ? undefined : { width: u16le(b, 18), height: u16le(b, 20) };
  }
  if (b.length < 26) {
    return undefined;
  }
  return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
}

function icoDims(b: Uint8Array): Dims {
  const count = Math.min(u16le(b, 4), Math.floor((b.length - 6) / 16), 256);
  let best: Dims;
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 16;
    const width = b[p] || 256;
    const height = b[p + 1] || 256;
    if (!best || width * height > best.width * best.height) {
      best = { width, height };
    }
  }
  return best;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

/** Child boxes of [start, end), at most `limit` of them; stops at anything odd. */
function boxes(b: Uint8Array, start: number, end: number, limit = 256): Box[] {
  const out: Box[] = [];
  let pos = start;
  const stop = Math.min(end, b.length);
  for (let i = 0; i < limit && pos + 8 <= stop; i++) {
    let size = u32be(b, pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > stop || u32be(b, pos + 8) !== 0) {
        break;
      }
      size = u32be(b, pos + 12);
      header = 16;
    } else if (size === 0) {
      size = stop - pos;
    }
    if (size < header || pos + size > stop) {
      break;
    }
    out.push({
      type: String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]),
      start: pos + header,
      end: pos + size,
    });
    pos += size;
  }
  return out;
}

function avifDims(b: Uint8Array): Dims {
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta');
  if (!meta) {
    return undefined;
  }
  // meta is a full box: four bytes of version and flags precede its children.
  const iprp = boxes(b, meta.start + 4, meta.end).find((x) => x.type === 'iprp');
  const ipco = iprp && boxes(b, iprp.start, iprp.end).find((x) => x.type === 'ipco');
  if (!ipco) {
    return undefined;
  }
  let best: Dims;
  for (const box of boxes(b, ipco.start, ipco.end)) {
    // ispe is a full box: version/flags, then width and height as u32.
    if (box.type !== 'ispe' || box.start + 12 > box.end) {
      continue;
    }
    const width = u32be(b, box.start + 4);
    const height = u32be(b, box.start + 8);
    if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) {
      best = { width, height };
    }
  }
  return best;
}

// Latin-1 view of the leading bytes: enough for markup, and total on any input.
function headText(bytes: Uint8Array, n: number): string {
  let s = '';
  const end = Math.min(bytes.length, n);
  for (let i = 0; i < end; i += 1024) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 1024, end)));
  }
  return s;
}

function parseSvg(bytes: Uint8Array): ImageInfo | undefined {
  let text = headText(bytes, SVG_WINDOW);
  // A UTF-8 byte order mark (EF BB BF) seen through the Latin-1 view.
  if (text.startsWith('ï»¿')) {
    text = text.slice(3);
  }
  // Skip what may precede the root element: whitespace, an XML declaration,
  // comments, a DOCTYPE (with a bounded internal subset).
  let pos = 0;
  for (let guard = 0; guard < 64; guard++) {
    const rest = text.slice(pos);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      pos += ws[0].length;
      continue;
    }
    if (rest.startsWith('<?')) {
      const e = rest.indexOf('?>');
      if (e < 0) {
        return undefined;
      }
      pos += e + 2;
    } else if (rest.startsWith('<!--')) {
      const e = rest.indexOf('-->');
      if (e < 0) {
        return undefined;
      }
      pos += e + 3;
    } else if (/^<!DOCTYPE/i.test(rest)) {
      const m = /^<!DOCTYPE[^[>]*(\[[^\]]*\])?\s*>/i.exec(rest);
      if (!m) {
        return undefined;
      }
      pos += m[0].length;
    } else {
      break;
    }
  }
  const rest = text.slice(pos);
  if (!/^<svg[\s/>]/.test(rest)) {
    return undefined;
  }
  // The opening tag, up to its closing '>' outside quotes (or the window's end).
  let quote = '';
  let end = rest.length;
  for (let i = 4; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === quote) {
        quote = '';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      end = i;
      break;
    }
  }
  const tag = rest.slice(4, end);
  const attrs = new Map<string, string>();
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    if (!attrs.has(m[1])) {
      attrs.set(m[1], m[2] ?? m[3] ?? '');
    }
  }
  const px = (v: string | undefined): number | undefined => {
    const m = v === undefined ? null : /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(v);
    const n = m ? Math.round(Number(m[1])) : 0;
    return n > 0 ? n : undefined;
  };
  const width = px(attrs.get('width'));
  const height = px(attrs.get('height'));
  const vb = attrs.get('viewBox')?.trim().replace(/\s+/g, ' ');
  const viewBox = vb && /^[-+\d.eE ,]+$/.test(vb) ? vb : undefined;
  return make('svg', width && height ? { width, height } : undefined, viewBox);
}

/**
 * Magic-byte sniff plus header dimensions. Undefined for unknown bytes. The
 * format comes from the bytes, never from the file name.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d) {
    return make('png', pngDims(b));
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return make('jpeg', jpegDims(b));
  }
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    return make('webp', webpDims(b));
  }
  if (b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d && BMP_DIB_SIZES.includes(u32le(b, 14))) {
    return make('bmp', bmpDims(b));
  }
  if (
    b.length >= 22 &&
    b[0] === 0 &&
    b[1] === 0 &&
    b[2] === 1 &&
    b[3] === 0 &&
    u16le(b, 4) >= 1 &&
    u16le(b, 4) <= 1024
  ) {
    return make('ico', icoDims(b));
  }
  if (b.length >= 12 && ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis'))) {
    return make('avif', avifDims(b));
  }
  return parseSvg(b);
}

/** Decode base64 to bytes; anything invalid gives an empty array. */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== 'string') {
    return new Uint8Array(0);
  }
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function formatBytes(n: number): string {
  return formatBytesImpl(n);
}

const positive = (n: number | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/** "photo.webp · 1.2 MB · 1920 x 1080 · WebP"; SVG with only a viewBox shows that instead. */
export function statusLine(
  name: string,
  size: number,
  info: ImageInfo,
  width?: number,
  height?: number,
): string {
  const given = positive(width) && positive(height);
  const w = given ? width : info.width;
  const h = given ? height : info.height;
  const parts = [name, formatBytes(size)];
  if (positive(w) && positive(h)) {
    parts.push(`${Math.round(w)} x ${Math.round(h)}`);
  } else if (info.format === 'svg' && info.viewBox) {
    parts.push(`viewBox ${info.viewBox}`);
  }
  parts.push(info.label);
  return parts.filter(Boolean).join(' · ');
}

/** A relative path made safe to paste into a Markdown link or an HTML attribute. */
export function encodePathForLink(relativePath: string): string {
  return (
    relativePath
      .replace(/\\/g, '/')
      // eslint-disable-next-line no-control-regex -- control characters are exactly what is escaped
      .replace(/[\s%#?()<>"'`[\]{}|^\u0000-\u001f\u007f]/g, (ch) =>
        ch.charCodeAt(0) < 128
          ? `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
          : encodeURIComponent(ch),
      )
  );
}

export function markdownImage(alt: string, relativePath: string): string {
  const safeAlt = alt.replace(/[\r\n]+/g, ' ').replace(/([\\[\]])/g, '\\$1');
  return `![${safeAlt}](${encodePathForLink(relativePath)})`;
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function htmlImage(
  alt: string,
  relativePath: string,
  width?: number,
  height?: number,
): string {
  let out = `<img src="${escapeAttr(encodePathForLink(relativePath))}" alt="${escapeAttr(alt)}"`;
  if (positive(width)) {
    out += ` width="${Math.round(width)}"`;
  }
  if (positive(height)) {
    out += ` height="${Math.round(height)}"`;
  }
  return `${out}>`;
}

export function dataUri(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** The file name without its last extension; a leading-dot name is kept whole. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** photo.webp -> photo.png; a name that is already .png stays. */
export function pngFileName(name: string): string {
  return /\.png$/i.test(name) && name.length > 4 ? name : `${stemOf(name)}.png`;
}
