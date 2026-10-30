import {
  decodeSvgText,
  encodePathForLink,
  htmlImage,
  markdownImage,
  sniffImage,
  statusLine,
  svgEncoding,
  type ImageFormat,
} from '../../src/webview/imageInfo';

// sniffImage answers anything it does not recognise with undefined and never
// throws on truncated or hostile headers, so nothing is wrapped. A result is then
// read the way the preview's status line reads it.
//
// FUZZ_IMAGE_FORMAT (png, jpeg, webp, bmp, ico, avif, svg) puts that format's
// fixed magic in front of the fuzzer's bytes, so every input reaches that
// format's header parser instead of failing the sniff in its first bytes. Unset
// is the catch-all. `node fuzz/run.js image-<format>` sets it. An input that
// already starts with the magic (a seed) is left as it is.

const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24];
const bytes = (...parts: Array<number[] | string | Buffer>): Buffer =>
  Buffer.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : [...p])),
  );

const FORMATS = ['png', 'jpeg', 'webp', 'bmp', 'ico', 'avif', 'svg'];
const FORMAT = process.env.FUZZ_IMAGE_FORMAT || undefined;
if (FORMAT !== undefined && !FORMATS.includes(FORMAT)) {
  throw new Error(`FUZZ_IMAGE_FORMAT must be one of ${FORMATS.join(', ')}; got ${FORMAT}`);
}

const startsWith = (data: Buffer, magic: number[]): boolean => magic.every((v, i) => data[i] === v);
const textAt = (data: Buffer, from: number, to: number): string =>
  data.subarray(from, to).toString('latin1');

function withMagic(format: string, data: Buffer): Buffer {
  switch (format) {
    case 'png':
      return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? data
        : bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], data);
    case 'jpeg':
      return startsWith(data, [0xff, 0xd8, 0xff]) ? data : bytes([0xff, 0xd8, 0xff], data);
    case 'webp':
      return textAt(data, 0, 4) === 'RIFF' && textAt(data, 8, 12) === 'WEBP'
        ? data
        : bytes('RIFF', u32(data.length + 4), 'WEBP', data);
    case 'bmp':
      return startsWith(data, [0x42, 0x4d]) ? data : bytes('BM', data);
    case 'ico':
      return startsWith(data, [0, 0, 1, 0]) ? data : bytes([0, 0, 1, 0], data);
    case 'avif':
      // An ftyp box of 16 bytes: size, type, major brand avif, minor version 0.
      return textAt(data, 4, 8) === 'ftyp'
        ? data
        : bytes([0, 0, 0, 16], 'ftypavif', [0, 0, 0, 0], data);
    default:
      return textAt(data, 0, 5) === '<svg ' ? data : bytes('<svg ', data);
  }
}

export function fuzz(input: Buffer): void {
  const data = FORMAT ? withMagic(FORMAT, input) : input;
  if (FORMAT === 'svg') {
    svgEncoding(data);
    decodeSvgText(data);
  }
  if (!FORMAT) {
    // The string helpers take any text: split the input into a name, a path and
    // an alt text, and read a size from its first byte.
    const [name = '', path = '', alt = ''] = data.toString('utf8').split('\u0000');
    const w = data.length > 0 ? data[0] * 7 - 3 : undefined;
    const png: { format: ImageFormat; mime: string; label: string } = {
      format: 'png',
      mime: 'image/png',
      label: 'PNG',
    };
    statusLine(name, data.byteLength, png, w, w);
    encodePathForLink(path);
    markdownImage(alt, path);
    htmlImage(alt, path, w, w);
  }
  const info = sniffImage(data);
  if (!info) {
    return;
  }
  statusLine('fuzz.img', data.byteLength, info, info.width, info.height);
  statusLine('fuzz.img', data.byteLength, info);
}
