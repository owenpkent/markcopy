// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import type { PackageInfo, PropertySection } from '../../src/pkg/model';
import { readRpm } from '../../src/pkg/rpm';
import { buildRpm, hex, int32, str, strings, type RpmSpec } from './rpmFixture';

const LIMITS = { maxPages: 512, maxRead: 16 * 1024 * 1024 };
const read = (bytes: Uint8Array): Promise<PackageInfo> =>
  readRpm(new RangeReader(bytesSource(bytes), LIMITS));
const readSpec = (spec: RpmSpec = {}): Promise<PackageInfo> => read(buildRpm(spec));
const pkgRows = (info: PackageInfo): Map<string, string> => {
  const section = info.sections.find((s) => s.heading === 'Package') as PropertySection;
  return new Map(section.rows);
};

const MATCH = (name: string): string => `The computed ${name} matches the stored digest.`;
const DIFFER = (name: string): string => `The computed ${name} differs from the stored digest.`;
const NOT_DIGEST = (name: string): string =>
  `Not checked: the stored value is not a ${name} digest.`;

// Flip one byte of the first occurrence of `word`, which sits in the main header.
const flip = (bytes: Uint8Array, word: string): Uint8Array => {
  const at = Buffer.from(bytes).indexOf(word);
  expect(at).toBeGreaterThan(0);
  const copy = bytes.slice();
  copy[at] ^= 0x20;
  return copy;
};

describe('readRpm: stored digests', () => {
  it('says each digest of an intact package matches', async () => {
    const pkg = pkgRows(await readSpec({ digests: true }));
    expect(pkg.get('Header SHA-1 check')).toBe(MATCH('SHA-1'));
    expect(pkg.get('Header SHA-256 check')).toBe(MATCH('SHA-256'));
    expect(pkg.get('Header SHA3-256 check')).toBe(MATCH('SHA3-256'));
    expect(pkg.get('Payload SHA-256 check')).toBe(MATCH('SHA-256'));
    expect(pkg.get('Header SHA-256')).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.get('Header SHA-1')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('compares hex without regard to case', async () => {
    const real = pkgRows(await readSpec({ digests: true })).get('Header SHA-256') ?? '';
    const upper = await readSpec({ digests: true, signature: [str(273, real.toUpperCase())] });
    expect(pkgRows(upper).get('Header SHA-256 check')).toBe(MATCH('SHA-256'));
  });

  it('says the header digests differ when a byte of the main header changed', async () => {
    const pkg = pkgRows(await read(flip(buildRpm({ digests: true }), 'transferring')));
    expect(pkg.get('Header SHA-1 check')).toBe(DIFFER('SHA-1'));
    expect(pkg.get('Header SHA-256 check')).toBe(DIFFER('SHA-256'));
    expect(pkg.get('Header SHA3-256 check')).toBe(DIFFER('SHA3-256'));
    // The payload follows the header, so its digest is untouched.
    expect(pkg.get('Payload SHA-256 check')).toBe(MATCH('SHA-256'));
  });

  it('says the payload digest differs when a byte of the payload changed', async () => {
    const bytes = buildRpm({ digests: true, payload: new Uint8Array(500).fill(9) });
    bytes[bytes.length - 10] ^= 1;
    const pkg = pkgRows(await read(bytes));
    expect(pkg.get('Payload SHA-256 check')).toBe(DIFFER('SHA-256'));
    expect(pkg.get('Header SHA-256 check')).toBe(MATCH('SHA-256'));
  });

  it('computes over what is there when the file is cut short in the payload', async () => {
    const bytes = buildRpm({ digests: true });
    const pkg = pkgRows(await read(bytes.subarray(0, bytes.length - 100)));
    expect(pkg.get('Payload SHA-256 check')).toBe(DIFFER('SHA-256'));
    expect(pkg.get('Header SHA-256 check')).toBe(MATCH('SHA-256'));
  });

  it('does not check a stored value that is not a digest of that algorithm', async () => {
    const info = await readSpec({
      digests: true,
      signature: [str(273, 'abc'), str(269, 'a'.repeat(64)), str(279, 'not hex')],
      main: [strings(5092, ['a'.repeat(63)])],
    });
    const pkg = pkgRows(info);
    expect(pkg.get('Header SHA-256')).toBe('abc');
    expect(pkg.get('Header SHA-256 check')).toBe(NOT_DIGEST('SHA-256'));
    expect(pkg.get('Header SHA-1 check')).toBe(NOT_DIGEST('SHA-1'));
    expect(pkg.get('Header SHA3-256 check')).toBe(NOT_DIGEST('SHA3-256'));
    expect(pkg.get('Payload SHA-256 check')).toBe(NOT_DIGEST('SHA-256'));
  });

  it('does not check a payload digest whose algorithm it does not compute', async () => {
    const info = await readSpec({ digests: true, main: [int32(5093, 99)] });
    const pkg = pkgRows(info);
    expect(pkg.get('Payload digest')).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.get('Payload digest check')).toBe(
      'Not checked: MarkCopy does not compute the digest algorithm the package names (OpenPGP hash number 99).',
    );
    expect(info.warnings).toEqual([]);
  });

  it('does not check a payload digest that names no algorithm', async () => {
    const info = await readSpec({ digests: true, without: [5093] });
    expect(pkgRows(info).get('Payload digest check')).toBe(
      'Not checked: the package does not name the digest algorithm.',
    );
  });

  it('ignores the digest of the unpacked payload', async () => {
    const info = await readSpec({ main: [strings(5097, [hex('sha256', new Uint8Array(1))])] });
    expect(pkgRows(info).has('Payload digest')).toBe(false);
  });

  it('adds no check row to a package that stores no digest', async () => {
    const pkg = pkgRows(await readSpec({ without: [273] }));
    expect([...pkg.keys()].filter((k) => k.endsWith('check'))).toEqual([]);
  });
});
