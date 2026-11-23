import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader, type ByteSource } from '../../src/binary/reader';
import { looksLikeDmg, readDmg } from '../../src/pkg/dmg';
import { PackageError } from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import type { InfoSection, PackageInfo } from '../../src/pkg/model';
import { buildSignedData } from '../pe/fixture';
import {
  buildCodeSignature,
  buildDmg,
  buildEncryptedDmg,
  buildMish,
  type DmgSpec,
} from './dmgFixture';

const reader = (bytes: Uint8Array): RangeReader => new RangeReader(bytesSource(bytes));
const read = (spec: DmgSpec | Uint8Array = {}): Promise<PackageInfo> =>
  readDmg(reader(spec instanceof Uint8Array ? spec : buildDmg(spec)));
const RLO = String.fromCharCode(0x202e);

const section = (info: PackageInfo, heading: string): InfoSection | undefined =>
  info.sections.find((s) => s.heading === heading);
const rowsOf = (info: PackageInfo, heading: string): Record<string, string> => {
  const s = section(info, heading);
  return s?.kind === 'properties' ? Object.fromEntries(s.rows) : {};
};
const tableOf = (info: PackageInfo, heading: string): string[][] => {
  const s = section(info, heading);
  return s?.kind === 'table' ? s.rows : [];
};

describe('looksLikeDmg', () => {
  it('recognises the koly trailer, and the encrypted markers', async () => {
    expect(await looksLikeDmg(reader(buildDmg()))).toBe(true);
    expect(await looksLikeDmg(reader(buildEncryptedDmg(2)))).toBe(true);
    expect(await looksLikeDmg(reader(buildEncryptedDmg(1)))).toBe(true);
  });

  it('refuses other files without throwing', async () => {
    expect(await looksLikeDmg(reader(new Uint8Array(0)))).toBe(false);
    expect(await looksLikeDmg(reader(new Uint8Array(511)))).toBe(false);
    expect(await looksLikeDmg(reader(new Uint8Array(4096)))).toBe(false);
    const almost = buildDmg();
    almost[almost.length - 512] = 0x4b ^ 1;
    expect(await looksLikeDmg(reader(almost))).toBe(false);
  });

  it('returns false when the source fails', async () => {
    const broken: ByteSource = {
      size: 4096,
      read: () => Promise.reject(new Error('disk gone')),
    };
    expect(await looksLikeDmg(new RangeReader(broken))).toBe(false);
  });
});

describe('readDmg: disk image', () => {
  it('reads the trailer and the partition list', async () => {
    const info = await read({ checksumType: 2 });
    expect(info.format).toBe('Apple disk image');
    expect(info.warnings).toEqual([]);
    const image = rowsOf(info, 'Disk image');
    expect(image['Format']).toBe('Apple disk image (UDIF)');
    expect(image['Uncompressed size']).toContain('1,049,088 bytes');
    expect(image['Stored size']).toBe('1.00 KB (1,024 bytes)');
    expect(image['Compression']).toBe('zlib');
    expect(image['Checksum']).toBe('CRC-32');
    expect(image['Encrypted']).toBe('No');
    expect(image['Segment']).toBeUndefined();
    expect(image['Licence agreement']).toBeUndefined();
    expect(tableOf(info, 'Partitions')).toEqual([
      ['Protective Master Boot Record (MBR : 0)', '512 bytes', 'zlib'],
      ['Install App (Apple_HFS : 1)', '1.00 MB (1,048,576 bytes)', 'zlib'],
    ]);
  });

  it('takes the title from the largest partition that names a volume', async () => {
    expect((await read()).title).toBe('Install App');
    const generic = await read({
      partitions: [{ name: 'disk image (Apple_APFS : 1)', sectors: 100 }],
    });
    expect(generic.title).toBeUndefined();
  });

  it('names each compression kind the partitions use, ignoring comment and terminator chunks', async () => {
    const info = await read({
      partitions: [
        {
          name: 'A (Apple_HFS : 1)',
          sectors: 10,
          chunks: [
            { type: 0x7ffffffe },
            { type: 0x80000007, sectors: 4 },
            { type: 0x80000008, sectors: 4 },
            { type: 1, sectors: 1 },
            { type: 0, sectors: 1 },
            { type: 2 },
            { type: 0xffffffff },
          ],
        },
        {
          name: 'B (Apple_HFS : 2)',
          sectors: 2,
          chunks: [
            { type: 0x80000006, sectors: 1 },
            { type: 0x80000004, sectors: 1 },
            { type: 0x12345678 },
            { type: 0xffffffff },
          ],
        },
      ],
    });
    expect(rowsOf(info, 'Disk image')['Compression']).toBe(
      'Zero-fill, Uncompressed, LZFSE, LZMA, type 0x12345678, ADC, bzip2',
    );
    expect(tableOf(info, 'Partitions')[0][2]).toBe('Zero-fill, Uncompressed, LZFSE, LZMA');
  });

  it('shows segment, licence and checksum details', async () => {
    const info = await read({
      segmentNumber: 2,
      segmentCount: 3,
      licence: true,
      checksumType: 1,
      flags: 5,
    });
    const image = rowsOf(info, 'Disk image');
    expect(image['Segment']).toBe('2 of 3');
    expect(image['Licence agreement']).toContain('Yes');
    expect(image['Checksum']).toBe('CRC-28');
    expect(image['Internet-enabled']).toBe('Yes');
  });

  it('says plainly that the file system inside is not read', async () => {
    const info = await read();
    const text = section(info, 'Inside the image');
    expect(text?.kind).toBe('text');
    expect(text?.kind === 'text' && text.paragraphs[0]).toContain('does not read the file system');
  });

  it('reports a code signature and its signer, without verifying it', async () => {
    const cms = buildSignedData({
      subject: { commonName: 'Developer ID Application: Example', organization: 'Example' },
      issuer: { commonName: 'Developer ID Certification Authority' },
    });
    const info = await read({ codeSignature: buildCodeSignature(cms) });
    const sig = rowsOf(info, 'Signature');
    expect(sig['Status']).toContain('Apple code signing signature present, not verified');
    expect(sig['Signer']).toBe('Developer ID Application: Example');
    expect(sig['Issued by']).toBe('Developer ID Certification Authority');
  });

  it('keeps a signature whose blob it cannot walk, without a signer', async () => {
    const info = await read({ codeSignature: new Uint8Array(64).fill(7) });
    expect(rowsOf(info, 'Signature')['Status']).toContain('present');
    expect(rowsOf(info, 'Signature')['Signer']).toBeUndefined();
  });

  it('shows only the fact and the size for an encrypted image', async () => {
    for (const version of [1, 2] as const) {
      const info = await read(buildEncryptedDmg(version));
      expect(info.format).toBe('Apple disk image (encrypted)');
      expect(rowsOf(info, 'Disk image')['Encrypted']).toBe('Yes');
      expect(rowsOf(info, 'Disk image')['Stored size']).toContain('4,096 bytes');
      expect(section(info, 'Partitions')).toBeUndefined();
    }
  });
});

describe('readDmg: rejection and damage', () => {
  it('rejects files that are not disk images', async () => {
    await expect(read(new Uint8Array(100))).rejects.toThrow(PackageError);
    await expect(read(new Uint8Array(4096))).rejects.toThrow(PackageError);
  });

  it('warns when the property list lies outside the file', async () => {
    const info = await read({ xmlOffset: 2 ** 40 });
    expect(info.warnings.join(' ')).toContain('partition list');
    expect(info.format).toBe('Apple disk image');
    expect(section(info, 'Partitions')).toBeUndefined();
  });

  it('warns when the property list is larger than it will read', async () => {
    const info = await read({ xmlLength: 64 * 1024 * 1024 });
    expect(info.warnings.join(' ')).toContain('larger than MarkCopy will read');
  });

  it('warns on a property list that is not XML', async () => {
    const info = await read({ rawPlist: 'this is not xml <<<' });
    expect(info.warnings.join(' ')).toContain('partition list');
  });

  it('counts only the chunks a table really holds', async () => {
    const info = await read({
      partitions: [{ name: 'A (Apple_HFS : 1)', sectors: 2, declaredChunks: 0xffffffff }],
    });
    expect(info.warnings.join(' ')).toContain('cut short');
    expect(tableOf(info, 'Partitions')).toHaveLength(1);
  });

  it('skips a partition whose table does not start with mish', async () => {
    const info = await read({
      partitions: [
        { name: 'bad (Apple_HFS : 1)', sectors: 2, signature: 'xxxx' },
        { name: 'good (Apple_HFS : 2)', sectors: 2 },
      ],
    });
    expect(tableOf(info, 'Partitions').map((r) => r[0])).toEqual(['good (Apple_HFS : 2)']);
  });

  it('reads at most 64 partitions', async () => {
    const partitions = Array.from({ length: 70 }, (_, i) => ({
      name: `P${i} (Apple_HFS : ${i})`,
      sectors: 1,
    }));
    const info = await read({ partitions });
    expect(tableOf(info, 'Partitions')).toHaveLength(64);
    expect(info.warnings.join(' ')).toContain('first 64 of 70');
  });

  it('survives a hostile sector count', async () => {
    const info = await read({ sectorCount: 2 ** 52 });
    expect(info.format).toBe('Apple disk image');
    expect(rowsOf(info, 'Disk image')['Uncompressed size']).toBeUndefined();
  });

  it('survives a mish table that is much larger than any real one', () => {
    // 60,000 chunks is 2.4 MB: more than the table cap, and must be read as a prefix.
    const chunks = Array.from({ length: 60_000 }, () => ({ type: 0x80000005, sectors: 1 }));
    const mish = buildMish({ name: 'big', sectors: 60_000, chunks });
    expect(mish.length).toBeGreaterThan(2 * 1024 * 1024);
    return expect(
      read({ partitions: [{ name: 'Big (Apple_HFS : 1)', sectors: 60_000, chunks }] }),
    ).resolves.toMatchObject({ format: 'Apple disk image' });
  });

  it('never throws anything but PackageError when truncated', async () => {
    const cms = buildSignedData({ subject: { commonName: 'S' }, issuer: { commonName: 'I' } });
    const bytes = buildDmg({ codeSignature: buildCodeSignature(cms), licence: true });
    const cuts: number[] = [];
    for (let n = 0; n < Math.min(1024, bytes.length); n++) {
      cuts.push(n);
    }
    for (let n = 1024; n < bytes.length; n += 31) {
      cuts.push(n);
    }
    for (const n of cuts) {
      try {
        await read(bytes.subarray(0, n));
      } catch (e) {
        expect(e).toBeInstanceOf(PackageError);
      }
    }
  });

  it('never throws anything but PackageError when the trailer is scrambled', async () => {
    const good = buildDmg();
    for (let at = 4; at < 512; at += 8) {
      const bytes = good.slice();
      bytes.fill(0xff, bytes.length - 512 + at, bytes.length - 512 + Math.min(512, at + 8));
      try {
        await read(bytes);
      } catch (e) {
        expect(e).toBeInstanceOf(PackageError);
      }
    }
  });
});

describe('readDmg: rendering', () => {
  it('escapes partition names and strips direction overrides', async () => {
    const info = await read({
      partitions: [{ name: `<img src=x onerror=1> a${RLO}b (Apple_HFS : 1)`, sectors: 8 }],
    });
    const html = renderPackageHtml(info, { fileName: 'a.dmg', fileSize: 10 });
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain(RLO);
    expect(info.title).toBe('<img src=x onerror=1> ab');
  });
});
