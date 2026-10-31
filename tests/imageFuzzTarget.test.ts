import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sniffImage, svgEncoding } from '../src/webview/imageInfo';
import { withMagic } from '../fuzz/targets/image.fuzz';

const dir = join(__dirname, '..', 'fuzz', 'corpus', 'image');

describe('image fuzz target seed handling', () => {
  const svgSeeds = readdirSync(dir).filter((n) => n.endsWith('.svg'));
  it('finds the five SVG seeds', () => {
    expect(svgSeeds).toHaveLength(5);
  });
  for (const name of svgSeeds) {
    it('keeps ' + name + ' intact in the svg variant', () => {
      const data = readFileSync(join(dir, name));
      const out = withMagic('svg', data);
      expect(out.equals(data)).toBe(true);
      const a = sniffImage(data);
      const b = sniffImage(out);
      expect(b?.format).toBe('svg');
      expect(b?.width).toBe(a?.width);
      expect(b?.height).toBe(a?.height);
      expect(b?.viewBox).toBe(a?.viewBox);
      expect(svgEncoding(out)).toBe(svgEncoding(data));
    });
  }
  it('prefixes unrecognised input with the svg root', () => {
    expect(withMagic('svg', Buffer.from('junk')).toString()).toBe('<svg junk');
  });
  it('leaves real raster seeds alone', () => {
    const seeds: Array<[string, string]> = [
      ['png', 'png-ihdr.png'],
      ['jpeg', 'jpeg-sof.jpg'],
      ['webp', 'webp-vp8x.webp'],
      ['bmp', 'bmp-v3.bmp'],
      ['ico', 'ico-two.ico'],
      ['avif', 'avif-ispe.avif'],
    ];
    for (const [fmt, file] of seeds) {
      const data = readFileSync(join(dir, file));
      expect(withMagic(fmt, data).equals(data)).toBe(true);
    }
  });
});
