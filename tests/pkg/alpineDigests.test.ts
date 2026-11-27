// @vitest-environment node
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { readAlpineApk } from '../../src/pkg/alpine';
import type { PropertySection } from '../../src/pkg/model';
import { tar } from './debFixture';
import { buildApk, DATAHASH, PKGINFO } from './alpineFixture';
import { hex } from './rpmFixture';

const LIMITS = { maxPages: 512, maxRead: 16 * 1024 * 1024 };
const MATCH = 'The computed SHA-256 matches the stored digest.';
const DIFFER = 'The computed SHA-256 differs from the stored digest.';

const data = gzipSync(
  tar([
    { name: 'usr/', type: '5' },
    { name: 'usr/bin/curl', data: new Uint8Array(3000).fill(1) },
  ]),
);
const build = (datahash: string, signature?: string | null): Uint8Array =>
  buildApk({
    data,
    signature,
    pkginfo: PKGINFO.replace(`datahash = ${DATAHASH}`, `datahash = ${datahash}`),
  });
const rows = async (bytes: Uint8Array): Promise<Map<string, string>> => {
  const info = await readAlpineApk(new RangeReader(bytesSource(bytes), LIMITS));
  return new Map((info.sections.find((s) => s.heading === 'Package') as PropertySection).rows);
};
const check = async (bytes: Uint8Array): Promise<string | undefined> =>
  (await rows(bytes)).get('Data SHA-256 check');

describe('readAlpineApk: stored data digest', () => {
  it('says the digest matches, with and without a signature stream', async () => {
    expect(await check(build(hex('sha256', data)))).toBe(MATCH);
    expect(await check(build(hex('sha256', data).toUpperCase()))).toBe(MATCH);
    expect(await check(build(hex('sha256', data), null))).toBe(MATCH);
  });

  it('keeps the stored value row', async () => {
    expect((await rows(build(hex('sha256', data)))).get('Data SHA-256')).toBe(hex('sha256', data));
  });

  it('says the digest differs when a byte of the data archive changed', async () => {
    const bytes = build(hex('sha256', data));
    bytes[bytes.length - 20] ^= 1;
    expect(await check(bytes)).toBe(DIFFER);
  });

  it('says the digest differs when the file is cut short in the data archive', async () => {
    const bytes = build(hex('sha256', data));
    expect(await check(bytes.subarray(0, bytes.length - 30))).toBe(DIFFER);
  });

  it('does not check a stored value that is not a SHA-256 digest', async () => {
    expect(await check(build('abc'))).toBe(
      'Not checked: the stored value is not a SHA-256 digest.',
    );
  });

  it('does not check when the file ends before the data archive', async () => {
    const whole = build(hex('sha256', data));
    expect(await check(whole.subarray(0, whole.length - data.length))).toBe(
      'Not checked: MarkCopy did not find where the data archive starts.',
    );
  });

  it('adds no check row when the package stores no datahash', async () => {
    const bytes = buildApk({ pkginfo: PKGINFO.replace(/datahash = .*\n/, '') });
    expect((await rows(bytes)).has('Data SHA-256 check')).toBe(false);
  });
});
