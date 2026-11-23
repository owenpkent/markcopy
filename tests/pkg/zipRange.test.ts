import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader, type ByteSource } from '../../src/binary/reader';
import { PackageError } from '../../src/pkg/model';
import { MAX_ZIP_ENTRIES, openZip, readTextEntry, type ZipArchive } from '../../src/pkg/zipRange';
import { buildZip } from './zipFixture';

const RLO = String.fromCharCode(0x202e);

const open = (bytes: Uint8Array): Promise<ZipArchive> =>
  openZip(new RangeReader(bytesSource(bytes)));

const sample = (): Uint8Array =>
  buildZip([
    { name: 'dir/' },
    { name: 'dir/a.txt', data: 'hello world' },
    { name: 'b.bin', data: new Uint8Array(1000).fill(7), method: 8 },
  ]);

describe('openZip: the directory', () => {
  it('lists every entry with its sizes, method and kind', async () => {
    const zip = await open(sample());
    expect(zip.entries.map((e) => e.name)).toEqual(['dir/', 'dir/a.txt', 'b.bin']);
    const [dir, a, b] = zip.entries;
    expect(dir.isDirectory).toBe(true);
    expect(a).toMatchObject({
      uncompressedSize: 11,
      compressedSize: 11,
      method: 0,
      encrypted: false,
    });
    expect(b.method).toBe(8);
    expect(b.uncompressedSize).toBe(1000);
    expect(b.compressedSize).toBeLessThan(100);
    expect(a.crc).not.toBe(0);
  });

  it('totals the sizes and says the list is complete', async () => {
    const zip = await open(sample());
    expect(zip.totalUncompressed).toBe(1011);
    expect(zip.totalCompressed).toBe(11 + zip.entries[2].compressedSize);
    expect(zip.complete).toBe(true);
    expect(zip.declaredEntries).toBe(3);
  });

  it('reads stored and deflated data', async () => {
    const zip = await open(sample());
    expect(new TextDecoder().decode(await zip.readEntry(zip.find('dir/a.txt')!, 100))).toBe(
      'hello world',
    );
    const b = await zip.readEntry(zip.find('b.bin')!, 2000);
    expect(b.length).toBe(1000);
    expect(b.every((v) => v === 7)).toBe(true);
  });

  it('finds the data through the local header when its extra field differs', async () => {
    const zip = await open(buildZip([{ name: 'a.txt', data: 'abc', localExtra: 13 }]));
    expect(new TextDecoder().decode(await zip.readEntry(zip.entries[0], 10))).toBe('abc');
  });

  it('decodes UTF-8 names when bit 11 is set and Latin-1 when it is not', async () => {
    const zip = await open(
      buildZip([
        { name: 'café.txt', data: 'x' },
        { name: 'café.txt', data: 'x', legacyName: true },
      ]),
    );
    expect(zip.entries.map((e) => e.name)).toEqual(['café.txt', 'café.txt']);
  });

  it('strips direction overrides and control characters from names', async () => {
    const zip = await open(
      buildZip([{ name: `a${RLO}fdp.exe${String.fromCharCode(7)}`, data: 'x' }]),
    );
    expect(zip.entries[0].name).toBe('afdp.exe');
  });

  it('cuts a very long name', async () => {
    const zip = await open(buildZip([{ name: 'n'.repeat(5000), data: 'x' }]));
    expect(zip.entries[0].name.length).toBe(1024);
  });

  it('finds the end record past a comment, and ignores a fake one inside it', async () => {
    const zip = await open(
      buildZip([{ name: 'a', data: 'x' }], { comment: `PK\u0005\u0006${'z'.repeat(30)}` }),
    );
    expect(zip.entries.map((e) => e.name)).toEqual(['a']);
  });

  it('reads an archive with bytes in front of it', async () => {
    const stub = new Uint8Array(1234).fill(0x90);
    const zip = await open(buildZip([{ name: 'a.txt', data: 'behind a stub' }], { prefix: stub }));
    expect(new TextDecoder().decode(await zip.readEntry(zip.entries[0], 100))).toBe(
      'behind a stub',
    );
  });

  it('reads ZIP64 sizes and offsets', async () => {
    const zip = await open(
      buildZip(
        [
          { name: 'a.txt', data: 'first' },
          { name: 'b.txt', data: 'second', method: 8 },
        ],
        { zip64: true },
      ),
    );
    expect(zip.entries.map((e) => e.uncompressedSize)).toEqual([5, 6]);
    expect(new TextDecoder().decode(await zip.readEntry(zip.entries[1], 100))).toBe('second');
  });

  it('reads ZIP64 with a prefix in front', async () => {
    const zip = await open(
      buildZip([{ name: 'a.txt', data: 'x' }], { zip64: true, prefix: new Uint8Array(77) }),
    );
    expect(new TextDecoder().decode(await zip.readEntry(zip.entries[0], 100))).toBe('x');
  });

  it('reads an empty archive', async () => {
    const zip = await open(buildZip([]));
    expect(zip.entries).toEqual([]);
    expect(zip.complete).toBe(true);
  });

  it('reports a directory that is shorter than the end record says', async () => {
    const zip = await open(buildZip([{ name: 'a', data: 'x' }], { declaredCount: 5 }));
    expect(zip.declaredEntries).toBe(5);
    expect(zip.complete).toBe(false);
  });
});

describe('openZip: caps and damage', () => {
  it('stops listing at the entry cap and says so', async () => {
    // A directory of bare 46-byte records, built directly: the point is the count.
    const count = MAX_ZIP_ENTRIES + 5;
    const bytes = new Uint8Array(count * 46 + 22);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) {
      view.setUint32(i * 46, 0x02014b50, true);
    }
    const eocd = count * 46;
    view.setUint32(eocd, 0x06054b50, true);
    view.setUint16(eocd + 10, 0xffff, true);
    view.setUint32(eocd + 12, count * 46, true);
    view.setUint32(eocd + 16, 0, true);
    const zip = await open(bytes);
    expect(zip.entries.length).toBe(MAX_ZIP_ENTRIES);
    expect(zip.complete).toBe(false);
  });

  it('lists what it can when the directory size is larger than the file', async () => {
    const bytes = buildZip([{ name: 'a', data: 'x' }]);
    new DataView(bytes.buffer).setUint32(bytes.length - 10, 0xfffff000, true);
    const zip = await open(bytes);
    expect(zip.entries.map((e) => e.name)).toEqual(['a']);
    expect(zip.complete).toBe(false);
  });

  it('rejects data that is not a zip archive', async () => {
    await expect(open(new Uint8Array(500).fill(1))).rejects.toBeInstanceOf(PackageError);
    await expect(open(new Uint8Array(5))).rejects.toBeInstanceOf(PackageError);
  });

  it('rejects a directory offset that points nowhere', async () => {
    const bytes = buildZip([{ name: 'a', data: 'x' }]);
    new DataView(bytes.buffer).setUint32(bytes.length - 6, 0x7fffffff, true);
    await expect(open(bytes)).rejects.toBeInstanceOf(PackageError);
  });

  it('refuses an encrypted entry and an unknown method', async () => {
    const zip = await open(
      buildZip([
        { name: 'e', data: 'secret', encrypted: true },
        { name: 'm', data: 'x', methodNumber: 14 },
      ]),
    );
    expect(zip.entries[0].encrypted).toBe(true);
    await expect(zip.readEntry(zip.entries[0], 100)).rejects.toBeInstanceOf(PackageError);
    await expect(zip.readEntry(zip.entries[1], 100)).rejects.toBeInstanceOf(PackageError);
  });

  it('refuses an entry declared over the cap before reading its data', async () => {
    const bytes = buildZip([{ name: 'big', data: new Uint8Array(5000) }]);
    let reads = 0;
    const source: ByteSource = {
      size: bytes.length,
      read: (offset, length) => {
        reads++;
        return bytesSource(bytes).read(offset, length);
      },
    };
    const zip = await openZip(new RangeReader(source));
    const before = reads;
    await expect(zip.readEntry(zip.entries[0], 100)).rejects.toBeInstanceOf(PackageError);
    expect(reads).toBe(before);
  });

  it('stops a bomb whose directory understates its size', async () => {
    // 8 MiB of zeros deflates to a few kilobytes; the directory claims 10 bytes.
    const bomb = deflateSync(new Uint8Array(8 * 1024 * 1024));
    const bytes = buildZip([{ name: 'bomb', data: bomb, declaredSize: 10, methodNumber: 8 }]);
    const zip = await open(bytes);
    await expect(zip.readEntry(zip.entries[0], 1024 * 1024)).rejects.toBeInstanceOf(PackageError);
    const head = await zip.readEntryHead(zip.entries[0], 16);
    expect(head).toEqual(new Uint8Array(16));
  });

  it('refuses a stream that is not deflate data', async () => {
    const zip = await open(
      buildZip([{ name: 'x', data: new Uint8Array(64).fill(0xff), methodNumber: 8 }]),
    );
    await expect(zip.readEntry(zip.entries[0], 1000)).rejects.toBeInstanceOf(PackageError);
  });

  it('rejects an entry whose local header is not where the directory says', async () => {
    const zip = await open(
      buildZip([
        { name: 'a', data: 'x', declaredOffset: 3 },
        { name: 'b', data: 'y', declaredOffset: 0x7ffffff0 },
      ]),
    );
    await expect(zip.readEntry(zip.entries[0], 100)).rejects.toBeInstanceOf(PackageError);
    await expect(zip.readEntry(zip.entries[1], 100)).rejects.toBeInstanceOf(PackageError);
  });

  it('turns an unreadable entry into a warning with readTextEntry', async () => {
    const zip = await open(buildZip([{ name: 'e', data: 'secret', encrypted: true }]));
    const warnings: string[] = [];
    expect(await readTextEntry(zip, zip.entries[0], 100, warnings, 'The file')).toBeUndefined();
    expect(warnings).toEqual(['The file could not be read.']);
  });
});

describe('openZip: the APK Signing Block', () => {
  it('lists the pair IDs just before the directory', async () => {
    const zip = await open(
      buildZip([{ name: 'a', data: 'x' }], { signingBlockIds: [0x7109871a, 0xf05368c0] }),
    );
    expect(await zip.signingBlockIds()).toEqual([0x7109871a, 0xf05368c0]);
  });

  it('is absent from an ordinary archive', async () => {
    expect(await (await open(sample())).signingBlockIds()).toBeUndefined();
  });

  it('is found when the archive has a prefix', async () => {
    const zip = await open(
      buildZip([{ name: 'a', data: 'x' }], {
        signingBlockIds: [0x7109871a],
        prefix: new Uint8Array(50),
      }),
    );
    expect(await zip.signingBlockIds()).toEqual([0x7109871a]);
  });
});

describe('openZip: hostile input', () => {
  it('only ever rejects with a PackageError when cut short', async () => {
    const bytes = buildZip(
      [
        { name: 'a.txt', data: 'alpha' },
        { name: 'b.txt', data: 'beta', method: 8 },
      ],
      { zip64: true, comment: 'c', signingBlockIds: [1] },
    );
    const stride = Math.max(1, Math.floor(bytes.length / 200));
    for (let n = 0; n < bytes.length; n += n < 1024 ? 1 : stride) {
      try {
        const zip = await open(bytes.subarray(0, n));
        for (const entry of zip.entries) {
          await zip.readEntry(entry, 100).catch((e: unknown) => {
            expect(e).toBeInstanceOf(PackageError);
          });
        }
      } catch (error) {
        expect(error).toBeInstanceOf(PackageError);
      }
    }
  });

  it('survives any single corrupted byte', async () => {
    const bytes = buildZip(
      [
        { name: 'a.txt', data: 'alpha' },
        { name: 'b.txt', data: 'beta', method: 8 },
      ],
      { zip64: true, signingBlockIds: [1] },
    );
    for (let i = 0; i < bytes.length; i++) {
      const copy = bytes.slice();
      copy[i] ^= 0xff;
      try {
        const zip = await open(copy);
        await zip.signingBlockIds();
        for (const entry of zip.entries) {
          await zip.readEntry(entry, 100).catch((e: unknown) => {
            expect(e).toBeInstanceOf(PackageError);
          });
        }
      } catch (error) {
        expect(error).toBeInstanceOf(PackageError);
      }
    }
  });
});
