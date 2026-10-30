// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  base64ToBytes,
  dataUri,
  encodePathForLink,
  htmlImage,
  markdownImage,
  pngFileName,
  sniffImage,
  statusLine,
  stemOf,
  type ImageInfo,
} from '../src/webview/imageInfo';

const bytes = (...parts: Array<number[] | string>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => be32(n).reverse();
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const text = (s: string) => new TextEncoder().encode(s);

function png(w: number, h: number): Uint8Array {
  return bytes(
    [0x89],
    'PNG',
    [0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    'IHDR',
    be32(w),
    be32(h),
    [8, 6, 0, 0, 0],
  );
}

function jpeg(w: number, h: number, sof = 0xc0): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46], // APP0, length 4 (two payload bytes)
    [0xff, 0xc4, 0x00, 0x03, 0x00], // DHT: not a frame header
    [0xff, sof, 0x00, 0x0b, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 1, 1, 0x11, 0],
  );
}

describe('sniffImage', () => {
  it('reads a PNG', () => {
    expect(sniffImage(png(640, 480))).toEqual({
      format: 'png',
      mime: 'image/png',
      label: 'PNG',
      width: 640,
      height: 480,
    });
  });

  it('reads a JPEG past other markers, and any SOF but 4, 8 and 12', () => {
    expect(sniffImage(jpeg(300, 200))).toMatchObject({ format: 'jpeg', width: 300, height: 200 });
    expect(sniffImage(jpeg(300, 200, 0xc2))).toMatchObject({ width: 300, height: 200 });
    expect(sniffImage(jpeg(300, 200, 0xcf))).toMatchObject({ width: 300, height: 200 });
    for (const sof of [0xc4, 0xc8, 0xcc]) {
      const info = sniffImage(jpeg(300, 200, sof));
      expect(info?.format).toBe('jpeg');
      expect(info?.width).toBeUndefined();
    }
  });

  it('stops a JPEG at the start of scan', () => {
    const info = sniffImage(
      bytes([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xc0, 0, 11, 8, 0, 9, 0, 9]),
    );
    expect(info?.format).toBe('jpeg');
    expect(info?.width).toBeUndefined();
  });

  it('reads the three WebP flavours', () => {
    const riff = (chunk: string, body: number[]) =>
      bytes('RIFF', le32(body.length + 12), 'WEBP', chunk, le32(body.length), body);
    // VP8: 3-byte frame tag, start code, then 14-bit sizes.
    const lossy = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(320), ...le16(240)]);
    expect(sniffImage(lossy)).toMatchObject({ format: 'webp', width: 320, height: 240 });
    // VP8L: signature, then 14-bit (size - 1) fields.
    const bits = 100 - 1 + ((50 - 1) << 14);
    const lossless = riff('VP8L', [
      0x2f,
      bits & 255,
      (bits >> 8) & 255,
      (bits >> 16) & 255,
      (bits >> 24) & 255,
    ]);
    expect(sniffImage(lossless)).toMatchObject({ format: 'webp', width: 100, height: 50 });
    // VP8X: flags, three reserved bytes, then 24-bit (size - 1) fields.
    const ext = riff('VP8X', [0, 0, 0, 0, 0x2f, 0x04, 0, 0x0f, 0x03, 0]);
    expect(sniffImage(ext)).toMatchObject({ format: 'webp', width: 1072, height: 784 });
  });

  it('reads a BMP, a top-down one, and an OS/2 core header', () => {
    const file = (dib: number[]) => bytes('BM', le32(100), [0, 0, 0, 0], le32(54), dib);
    const v3 = (w: number, h: number) => [
      ...le32(40),
      ...le32(w),
      ...le32(h >>> 0),
      ...Array(28).fill(0),
    ];
    expect(sniffImage(file(v3(20, 10)))).toMatchObject({ format: 'bmp', width: 20, height: 10 });
    expect(sniffImage(file(v3(20, -10)))).toMatchObject({ width: 20, height: 10 });
    const core = [...le32(12), ...le16(30), ...le16(15), 1, 0, 24, 0];
    expect(sniffImage(file(core))).toMatchObject({ format: 'bmp', width: 30, height: 15 });
  });

  it('reads the largest ICO entry, with 0 meaning 256', () => {
    const entry = (w: number, h: number) => [w, h, 0, 0, 1, 0, 32, 0, ...le32(0), ...le32(0)];
    const ico = bytes([0, 0, 1, 0], le16(3), entry(16, 16), entry(0, 0), entry(32, 32));
    expect(sniffImage(ico)).toMatchObject({
      format: 'ico',
      mime: 'image/x-icon',
      width: 256,
      height: 256,
    });
    const small = bytes([0, 0, 1, 0], le16(2), entry(16, 16), entry(48, 48));
    expect(sniffImage(small)).toMatchObject({ width: 48, height: 48 });
  });

  it('copes with a directory that claims more entries than there are bytes', () => {
    const ico = bytes([0, 0, 1, 0], le16(1000), Array(16).fill(0), [0, 0, 0, 0, 0, 0]);
    expect(sniffImage(ico)?.format).toBe('ico');
  });

  describe('AVIF', () => {
    const box = (type: string, ...body: Array<number[] | Uint8Array>) => {
      const payload = body.flatMap((b) => [...b]);
      return bytes(be32(payload.length + 8), type, payload);
    };
    const ispe = (w: number, h: number) => box('ispe', [0, 0, 0, 0], be32(w), be32(h));
    const avif = (...ipcoChildren: Uint8Array[]) =>
      bytes(
        [...box('ftyp', text('avif'), be32(0), text('avif'))],
        [...box('meta', [0, 0, 0, 0], box('iprp', box('ipco', ...ipcoChildren)))],
      );

    it('reads ispe, preferring the largest', () => {
      expect(sniffImage(avif(ispe(64, 64), ispe(4000, 3000)))).toMatchObject({
        format: 'avif',
        mime: 'image/avif',
        width: 4000,
        height: 3000,
      });
    });

    it('accepts the avis brand', () => {
      const info = sniffImage(box('ftyp', text('avis'), be32(0)));
      expect(info?.format).toBe('avif');
      expect(info?.width).toBeUndefined();
    });

    it('gives no dimensions for a box that overruns or a size that goes nowhere', () => {
      const good = avif(ispe(8, 8));
      for (const n of [good.length - 1, good.length - 5, 30, 20]) {
        const info = sniffImage(good.subarray(0, n));
        expect(info?.format).toBe('avif');
        expect(info?.width).toBeUndefined();
      }
      const huge = bytes(
        [...box('ftyp', text('avif'), be32(0))],
        be32(1),
        'meta',
        be32(1),
        be32(5),
      );
      expect(sniffImage(huge)?.width).toBeUndefined();
    });
  });

  describe('SVG', () => {
    it('reads width, height and viewBox, ignoring non-pixel units', () => {
      expect(sniffImage(text('<svg width="24" height="12px" viewBox="0 0 24 12"></svg>'))).toEqual({
        format: 'svg',
        mime: 'image/svg+xml',
        label: 'SVG',
        width: 24,
        height: 12,
        viewBox: '0 0 24 12',
      });
      const units = sniffImage(text('<svg width="10cm" height="5em" viewBox="0 0 1 1"/>'));
      expect(units).toMatchObject({ format: 'svg', viewBox: '0 0 1 1' });
      expect(units?.width).toBeUndefined();
      expect(sniffImage(text('<svg width="100%" height="100%">'))?.width).toBeUndefined();
    });

    it('sees through a BOM, an XML declaration, comments and a DOCTYPE', () => {
      const src =
        '﻿  <?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d=""/></svg>';
      expect(sniffImage(text(src))).toMatchObject({ format: 'svg', viewBox: '0 0 24 24' });
    });

    it('reads an attribute whose value holds a >', () => {
      const info = sniffImage(text('<svg data-x="a>b" width="8" height="9">'));
      expect(info).toMatchObject({ width: 8, height: 9 });
    });

    it('leaves the viewBox out past the first 4 KiB, but still knows it is an SVG', () => {
      const pad = ' '.repeat(4200);
      const info = sniffImage(text(`<svg${pad}viewBox="0 0 24 24" width="5" height="5">`));
      expect(info?.format).toBe('svg');
      expect(info?.viewBox).toBeUndefined();
      expect(info?.width).toBeUndefined();
    });

    it('refuses markup that is not an SVG, and text that merely mentions one', () => {
      expect(sniffImage(text('<html><svg width="1" height="1"></svg></html>'))).toBeUndefined();
      expect(sniffImage(text('hello <svg width="1">'))).toBeUndefined();
      expect(sniffImage(text('<svgx width="1">'))).toBeUndefined();
      expect(sniffImage(text('<!-- unterminated <svg>'))).toBeUndefined();
    });
  });

  describe('unknown and damaged input', () => {
    it('answers undefined for nothing, noise and other formats', () => {
      expect(sniffImage(new Uint8Array(0))).toBeUndefined();
      expect(sniffImage(bytes([1, 2, 3, 4, 5]))).toBeUndefined();
      expect(sniffImage(bytes('GIF89a', Array(20).fill(0)))).toBeUndefined();
      expect(sniffImage(bytes('II*', [0], Array(20).fill(0)))).toBeUndefined();
    });

    it('never throws on any prefix of any fixture', () => {
      const fixtures = [
        png(3, 3),
        jpeg(3, 3),
        text('<svg width="1" height="1"/>'),
        bytes([0, 0, 1, 0], le16(1), [1, 1, 0, 0, 1, 0, 32, 0], le32(0), le32(0)),
        bytes('BM', le32(0), le32(0), le32(0), le32(40), le32(1), le32(1), Array(30).fill(0)),
        bytes('RIFF', le32(30), 'WEBPVP8X', le32(10), Array(10).fill(1)),
      ];
      for (const f of fixtures) {
        for (let n = 0; n <= f.length; n++) {
          expect(() => sniffImage(f.subarray(0, n))).not.toThrow();
        }
      }
    });

    it('reports a truncated PNG or JPEG by format, without dimensions', () => {
      const p = sniffImage(png(1, 1).subarray(0, 20));
      expect(p?.format).toBe('png');
      expect(p?.width).toBeUndefined();
      const j = sniffImage(jpeg(1, 1).subarray(0, 12));
      expect(j?.format).toBe('jpeg');
      expect(j?.width).toBeUndefined();
    });

    it('goes by content, not name: a JPEG stays a JPEG whatever it is called', () => {
      expect(sniffImage(jpeg(5, 6))?.mime).toBe('image/jpeg');
    });

    it('treats a zero or oversized dimension as unknown', () => {
      expect(sniffImage(png(0, 5))?.width).toBeUndefined();
      expect(sniffImage(png(0xffffffff, 5))?.width).toBeUndefined();
    });
  });
});

describe('base64ToBytes', () => {
  it('decodes, and gives nothing for bad input', () => {
    expect([...base64ToBytes('R0lG')]).toEqual([0x47, 0x49, 0x46]);
    expect(base64ToBytes('***').length).toBe(0);
    expect(base64ToBytes(5 as unknown as string).length).toBe(0);
  });
});

describe('statusLine', () => {
  const info = (extra: Partial<ImageInfo> = {}): ImageInfo => ({
    format: 'webp',
    mime: 'image/webp',
    label: 'WebP',
    ...extra,
  });
  const dot = ' · ';

  it('joins name, size, dimensions and format', () => {
    expect(statusLine('photo.webp', 1.2 * 1024 * 1024, info({ width: 1920, height: 1080 }))).toBe(
      ['photo.webp', '1.2 MB', '1920 x 1080', 'WebP'].join(dot),
    );
  });

  it('omits the dimensions when nobody knows them, and uses the natural size when given', () => {
    expect(statusLine('a.webp', 2048, info())).toBe(['a.webp', '2 KB', 'WebP'].join(dot));
    expect(statusLine('a.webp', 2048, info(), 30, 20)).toBe(
      ['a.webp', '2 KB', '30 x 20', 'WebP'].join(dot),
    );
  });

  it('shows the viewBox of an SVG that has no width', () => {
    const svg = info({ format: 'svg', label: 'SVG', viewBox: '0 0 24 24' });
    expect(statusLine('i.svg', 100, svg)).toBe(
      ['i.svg', '100 B', 'viewBox 0 0 24 24', 'SVG'].join(dot),
    );
    expect(statusLine('i.svg', 100, { ...svg, width: 24, height: 24 })).toBe(
      ['i.svg', '100 B', '24 x 24', 'SVG'].join(dot),
    );
  });
});

describe('link helpers', () => {
  it('percent-encodes spaces and characters a link cannot take, keeping slashes', () => {
    expect(encodePathForLink('my pics/a b#1 (2).png')).toBe('my%20pics/a%20b%231%20%282%29.png');
    expect(encodePathForLink('a%b?.png')).toBe('a%25b%3F.png');
  });

  it('turns backslashes into slashes and leaves non-ASCII names alone', () => {
    expect(encodePathForLink('docs\\img\\café.png')).toBe('docs/img/café.png');
  });

  it('writes a Markdown image', () => {
    expect(markdownImage('photo', 'img/my photo.png')).toBe('![photo](img/my%20photo.png)');
    expect(markdownImage('a [b]', 'x.png')).toBe('![a \\[b\\]](x.png)');
  });

  it('writes an HTML image with escaped attributes and optional size', () => {
    expect(htmlImage('say "hi" <b>', 'a b.png', 10, 20)).toBe(
      '<img src="a%20b.png" alt="say &quot;hi&quot; &lt;b&gt;" width="10" height="20">',
    );
    expect(htmlImage('x', 'x.png')).toBe('<img src="x.png" alt="x">');
    expect(htmlImage('x', 'x.png', undefined, 7)).toBe('<img src="x.png" alt="x" height="7">');
  });

  it('builds a data URI', () => {
    expect(dataUri('image/png', 'AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('names the PNG and the alt text', () => {
    expect(pngFileName('photo.webp')).toBe('photo.png');
    expect(pngFileName('photo.png')).toBe('photo.png');
    expect(pngFileName('photo')).toBe('photo.png');
    expect(pngFileName('a.b.jpeg')).toBe('a.b.png');
    expect(stemOf('photo.webp')).toBe('photo');
    expect(stemOf('a.b.svg')).toBe('a.b');
    expect(stemOf('.png')).toBe('.png');
  });
});
