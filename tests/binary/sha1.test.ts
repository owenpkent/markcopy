import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha1Hex } from '../../src/binary/sha1';

const reference = (bytes: Uint8Array): string =>
  createHash('sha1').update(bytes).digest('hex').toUpperCase();

describe('sha1Hex', () => {
  it('matches the published vectors', () => {
    expect(sha1Hex(new Uint8Array(0))).toBe('DA39A3EE5E6B4B0D3255BFEF95601890AFD80709');
    expect(sha1Hex(new TextEncoder().encode('abc'))).toBe(
      'A9993E364706816ABA3E25717850C26C9CD0D89D',
    );
  });

  it('agrees with node:crypto around every padding boundary', () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) & 0xff);
      expect(sha1Hex(bytes)).toBe(reference(bytes));
    }
  });

  it('agrees with node:crypto on a megabyte, and on a view into a larger buffer', () => {
    const big = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 31 + (i >> 8)) & 0xff);
    expect(sha1Hex(big)).toBe(reference(big));
    const part = big.subarray(5, 1000);
    expect(sha1Hex(part)).toBe(reference(part));
  });
});
