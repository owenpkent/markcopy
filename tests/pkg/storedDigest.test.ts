// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { checkStoredDigest, SHA256 } from '../../src/pkg/storedDigest';
import { hex } from './rpmFixture';

const bytes = new Uint8Array(3000).map((_, i) => i % 251);
const reader = (data: Uint8Array = bytes): RangeReader => new RangeReader(bytesSource(data));

describe('checkStoredDigest', () => {
  const stored = hex('sha256', bytes.subarray(100, 2000));

  it('says the computed digest matches, ignoring hex case', async () => {
    expect(await checkStoredDigest(reader(), SHA256, stored, 100, 2000)).toBe(
      'The computed SHA-256 matches the stored digest.',
    );
    expect(await checkStoredDigest(reader(), SHA256, stored.toUpperCase(), 100, 2000)).toBe(
      'The computed SHA-256 matches the stored digest.',
    );
  });

  it('says the computed digest differs, and gives no cause', async () => {
    const changed = bytes.slice();
    changed[1500] ^= 1;
    const result = await checkStoredDigest(reader(changed), SHA256, stored, 100, 2000);
    expect(result).toBe('The computed SHA-256 differs from the stored digest.');
    expect(result).not.toMatch(/tamper|corrupt|modif|valid|verified|trusted/i);
  });

  it('does not check a stored value of the wrong shape', async () => {
    for (const value of ['', 'ab', 'z'.repeat(64), stored.slice(1)]) {
      expect(await checkStoredDigest(reader(), SHA256, value, 0, 10)).toBe(
        'Not checked: the stored value is not a SHA-256 digest.',
      );
    }
  });

  it('does not check a range the file does not hold', async () => {
    expect(await checkStoredDigest(reader(), SHA256, stored, 100, 5000)).toBe(
      'Not checked: the file ends before the data the digest covers.',
    );
  });

  it('does not check when the file cannot be read', async () => {
    const failing = new RangeReader({
      size: 3000,
      read: () => Promise.reject(new Error('disk gone')),
    });
    expect(await checkStoredDigest(failing, SHA256, stored, 0, 100)).toBe(
      'Not checked: the file could not be read to the end of the data the digest covers.',
    );
  });

  it('reads a large range in pieces, past the page budget', async () => {
    const big = new Uint8Array(20 * 1024 * 1024).fill(7);
    const small = new RangeReader(bytesSource(big), { maxPages: 4 });
    expect(await checkStoredDigest(small, SHA256, hex('sha256', big), 0, big.length)).toBe(
      'The computed SHA-256 matches the stored digest.',
    );
  });
});
