// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { PackageError } from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { openZip, summariseEncryption, type ZipArchive } from '../../src/pkg/zipRange';
import { readZipPackage } from '../../src/pkg/zipFormats';
import { buildZip } from './zipFixture';

const open = (bytes: Uint8Array): Promise<ZipArchive> =>
  openZip(new RangeReader(bytesSource(bytes)));

/** A WinZip AES extra field (0x9901): version, "AE", strength, real method. */
function aesField(version: number, strength: number, method: number): Uint8Array {
  return Uint8Array.from([
    0x01,
    0x99,
    0x07,
    0x00,
    version & 0xff,
    version >> 8,
    0x41,
    0x45,
    strength,
    method & 0xff,
    method >> 8,
  ]);
}

const aes = (version: number, strength: number, method = 8) => ({
  name: 'a.txt',
  data: 'secret',
  encrypted: true,
  methodNumber: 99,
  centralExtra: aesField(version, strength, method),
});

describe('zip encryption labels', () => {
  it.each([
    [2, 3, 'AES-256 (WinZip AE-2)'],
    [1, 2, 'AES-192 (WinZip AE-1)'],
    [2, 1, 'AES-128 (WinZip AE-2)'],
    [2, 9, 'AES (WinZip, unknown key size)'],
    [2, 0, 'AES (WinZip, unknown key size)'],
  ])('AE-%i strength %i reads as %s', async (version, strength, label) => {
    const zip = await open(buildZip([aes(version, strength)]));
    expect(zip.entries[0].encrypted).toBe(true);
    expect(zip.entries[0].encryption).toBe(label);
  });

  it('uses the real compression method from the AES field, not 99', async () => {
    const zip = await open(buildZip([aes(2, 3, 8), { ...aes(2, 3, 0), name: 'b.txt' }]));
    expect(zip.entries.map((e) => e.method)).toEqual([8, 0]);
  });

  it('ignores a malformed AES field and still lists the entry', async () => {
    const short = Uint8Array.from([0x01, 0x99, 0x03, 0x00, 2, 0, 0x41]);
    const overrun = Uint8Array.from([0x01, 0x99, 0x40, 0x00, 2, 0]);
    const wrongVendor = Uint8Array.from([0x01, 0x99, 0x07, 0x00, 2, 0, 0x58, 0x58, 3, 8, 0]);
    for (const centralExtra of [short, overrun, wrongVendor]) {
      const zip = await open(
        buildZip([{ name: 'a', data: 'x', encrypted: true, methodNumber: 99, centralExtra }]),
      );
      expect(zip.entries).toHaveLength(1);
      expect(zip.entries[0].encryption).toBe('AES (WinZip, unknown key size)');
    }
  });

  it('labels PKWARE strong encryption and legacy ZipCrypto', async () => {
    const zip = await open(
      buildZip([
        { name: 'p', data: 'x', flagBits: 0x41 },
        { name: 'z', data: 'x', encrypted: true },
        { name: 'plain', data: 'x' },
      ]),
    );
    expect(zip.entries.map((e) => e.encryption)).toEqual([
      'PKWARE strong encryption',
      'ZipCrypto (legacy, easily broken)',
      undefined,
    ]);
  });

  it('names the method when an encrypted entry must be read', async () => {
    const zip = await open(buildZip([aes(2, 3)]));
    await expect(zip.readEntry(zip.entries[0], 1024)).rejects.toThrow(
      /AES-256 \(WinZip AE-2\).*does not ask for passwords/,
    );
    await expect(zip.readEntry(zip.entries[0], 1024)).rejects.toBeInstanceOf(PackageError);
  });

  it('summarises one method and a mix, and says nothing when nothing is encrypted', async () => {
    const one = await open(buildZip([aes(2, 3), { name: 'p', data: 'x' }]));
    expect(summariseEncryption(one.entries)).toBe('1 of 2 entries: AES-256 (WinZip AE-2)');
    const mixed = await open(
      buildZip([
        aes(2, 3),
        { ...aes(2, 3), name: 'b' },
        { name: 'z', data: 'x', encrypted: true },
        { name: 'p', data: 'x' },
      ]),
    );
    expect(summariseEncryption(mixed.entries)).toBe(
      '3 of 4 entries: AES-256 (WinZip AE-2) 2, ZipCrypto (legacy, easily broken) 1',
    );
    const none = await open(buildZip([{ name: 'p', data: 'x' }]));
    expect(summariseEncryption(none.entries)).toBeUndefined();
  });

  it('counts the entries read when the directory was read only in part', async () => {
    const partial = await open(buildZip([aes(2, 3)], { declaredCount: 2 }));
    expect(partial.complete).toBe(false);
    expect(summariseEncryption(partial.entries, partial.complete)).toBe(
      '1 of the 1 entry read: AES-256 (WinZip AE-2)',
    );
  });

  it('shows an Encryption row in the File section of the page', async () => {
    const bytes = buildZip([aes(2, 3), { name: 'p', data: 'x' }]);
    const info = await readZipPackage(new RangeReader(bytesSource(bytes)), 'a.zip');
    expect(info.fileRows).toEqual([['Encryption', '1 of 2 entries: AES-256 (WinZip AE-2)']]);
    const html = renderPackageHtml(info, { fileName: 'a.zip', fileSize: bytes.length });
    expect(html).toContain('Encryption');
    expect(html).toContain('AES-256 (WinZip AE-2)');
    const plain = await readZipPackage(
      new RangeReader(bytesSource(buildZip([{ name: 'p', data: 'x' }]))),
      'a.zip',
    );
    expect(plain.fileRows).toBeUndefined();
  });
});
