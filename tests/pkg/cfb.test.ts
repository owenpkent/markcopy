import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader, ReadError } from '../../src/binary/reader';
import { openCfb, STORAGE, STREAM } from '../../src/pkg/cfb';
import { buildCfb, guidBytes } from './cfbFixture';

const open = (bytes: Uint8Array) => openCfb(new RangeReader(bytesSource(bytes)));

/** Bytes that differ from sector to sector, so a misplaced read shows up. */
function pattern(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (i * 31 + (i >> 8) * 7 + seed) & 0xff;
  }
  return out;
}

const CLSID = '{000C1084-0000-0000-C000-000000000046}';

function headerU32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
}

function setU32(bytes: Uint8Array, at: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, value, true);
}

describe('openCfb', () => {
  it('reads the root CLSID, streams and storages', async () => {
    const bytes = buildCfb({
      clsid: guidBytes(CLSID),
      streams: [
        { name: 'alpha', data: pattern(10) },
        { name: 'beta', data: pattern(9000) },
      ],
      storages: ['sub'],
    });
    const cfb = await open(bytes);
    expect(cfb.rootClsid).toBe(CLSID);
    expect(cfb.truncated).toBe(false);
    const byName = Object.fromEntries(cfb.entries.map((e) => [e.name, e]));
    expect(byName.alpha).toMatchObject({ type: STREAM, size: 10 });
    expect(byName.beta).toMatchObject({ type: STREAM, size: 9000 });
    expect(byName.sub).toMatchObject({ type: STORAGE, size: 0 });
  });

  it('reads small streams from the mini stream and large ones from the FAT', async () => {
    const small = pattern(100, 3);
    const edge = pattern(4095, 5);
    const exact = pattern(4096, 7);
    const big = pattern(70000, 9);
    const cfb = await open(
      buildCfb({
        streams: [
          { name: 'small', data: small },
          { name: 'edge', data: edge },
          { name: 'exact', data: exact },
          { name: 'big', data: big },
          { name: 'empty', data: new Uint8Array(0) },
        ],
      }),
    );
    const get = (name: string) => cfb.entries.find((e) => e.name === name)!;
    expect(await cfb.readStream(get('small'), 1 << 20)).toEqual(small);
    expect(await cfb.readStream(get('edge'), 1 << 20)).toEqual(edge);
    expect(await cfb.readStream(get('exact'), 1 << 20)).toEqual(exact);
    expect(await cfb.readStream(get('big'), 1 << 20)).toEqual(big);
    expect((await cfb.readStream(get('empty'), 10)).length).toBe(0);
  });

  it('reads a version 4 file with 4096 byte sectors', async () => {
    const small = pattern(300, 2);
    const big = pattern(20000, 4);
    const bytes = buildCfb({
      sectorShift: 12,
      clsid: guidBytes(CLSID),
      streams: [
        { name: 'small', data: small },
        { name: 'big', data: big },
      ],
    });
    const cfb = await open(bytes);
    expect(cfb.rootClsid).toBe(CLSID);
    expect(
      await cfb.readStream(
        cfb.entries.find((e) => e.name === 'small')!,
        1e6,
      ),
    ).toEqual(small);
    expect(
      await cfb.readStream(
        cfb.entries.find((e) => e.name === 'big')!,
        1e6,
      ),
    ).toEqual(big);
  });

  it('follows the DIFAT when the FAT is listed in more than 109 sectors', async () => {
    // 109 FAT sectors index 109 * 128 sectors of 512 bytes (7.1 MB); go past it.
    const big = pattern(7_400_000, 11);
    const bytes = buildCfb({ streams: [{ name: 'big', data: big }] });
    expect(headerU32(bytes, 0x48)).toBeGreaterThan(0);
    const cfb = await openCfb(
      new RangeReader(bytesSource(bytes), { maxPages: 512, maxRead: 1 << 24 }),
    );
    const data = await cfb.readStream(cfb.entries[0], 1 << 24);
    expect(data.length).toBe(big.length);
    expect(data.subarray(7_300_000, 7_300_100)).toEqual(big.subarray(7_300_000, 7_300_100));
  });

  it('ignores the high half of a version 3 stream size', async () => {
    const bytes = buildCfb({ streams: [{ name: 'a', data: pattern(10) }] });
    // The directory's first sector holds the root at +0 and the stream at +128; its size is at +120.
    const dirOffset = (headerU32(bytes, 0x30) + 1) * 512;
    setU32(bytes, dirOffset + 128 + 124, 5);
    const cfb = await open(bytes);
    expect(cfb.entries[0].size).toBe(10);
  });

  it('refuses a stream over the cap', async () => {
    const cfb = await open(buildCfb({ streams: [{ name: 'a', data: pattern(5000) }] }));
    await expect(cfb.readStream(cfb.entries[0], 4999)).rejects.toBeInstanceOf(ReadError);
    await expect(cfb.readStream(cfb.entries[0], 5000)).resolves.toHaveLength(5000);
  });

  it('refuses a storage as a stream', async () => {
    const cfb = await open(buildCfb({ storages: ['s'] }));
    await expect(cfb.readStream(cfb.entries[0], 100)).rejects.toBeInstanceOf(ReadError);
  });

  it('rejects files that are not compound files', async () => {
    await expect(open(new Uint8Array(2048))).rejects.toThrow(/not an OLE compound file/);
    await expect(open(new TextEncoder().encode('PK\x03\x04 hello'))).rejects.toBeInstanceOf(
      ReadError,
    );
  });

  it('rejects a damaged header', async () => {
    const make = () => buildCfb({ streams: [{ name: 'a', data: pattern(10) }] });
    const byteOrder = make();
    byteOrder[0x1c] = 0;
    await expect(open(byteOrder)).rejects.toThrow(/header is damaged/);
    const shift = make();
    shift[0x1e] = 20;
    await expect(open(shift)).rejects.toThrow(/header is damaged/);
    const version = make();
    version[0x1a] = 9;
    await expect(open(version)).rejects.toThrow(/header is damaged/);
    const mini = make();
    mini[0x20] = 7;
    await expect(open(mini)).rejects.toThrow(/header is damaged/);
    const fats = make();
    setU32(fats, 0x2c, 1 << 30);
    await expect(open(fats)).rejects.toBeInstanceOf(ReadError);
  });

  it('stops a directory chain that loops back on itself', async () => {
    const bytes = buildCfb({ streams: [{ name: 'a', data: pattern(10) }] });
    const dir = headerU32(bytes, 0x30);
    const fat = (headerU32(bytes, 0x4c) + 1) * 512;
    setU32(bytes, fat + dir * 4, dir);
    await expect(open(bytes)).rejects.toThrow(/loops back/);
  });

  it('rejects a chain that points outside the file', async () => {
    const data = pattern(5000);
    const bytes = buildCfb({ streams: [{ name: 'a', data }] });
    const fat = (headerU32(bytes, 0x4c) + 1) * 512;
    // The stream is the first allocation: sectors 0 to 9. Cut its chain off the end of the file.
    setU32(bytes, fat + 3 * 4, 0x00ffffff);
    const cfb = await open(bytes);
    await expect(cfb.readStream(cfb.entries[0], 1e6)).rejects.toThrow(/outside the file/);
  });

  it('rejects a stream whose chain ends before its declared size', async () => {
    const bytes = buildCfb({ streams: [{ name: 'a', data: pattern(5000) }] });
    const fat = (headerU32(bytes, 0x4c) + 1) * 512;
    setU32(bytes, fat + 3 * 4, 0xfffffffe);
    const cfb = await open(bytes);
    await expect(cfb.readStream(cfb.entries[0], 1e6)).rejects.toBeInstanceOf(ReadError);
  });

  it('rejects a mini stream whose chain points outside the mini FAT', async () => {
    const bytes = buildCfb({ streams: [{ name: 'a', data: pattern(100) }] });
    // The stream's start (offset 116 of its directory entry) moves past the mini FAT.
    const dirOffset = (headerU32(bytes, 0x30) + 1) * 512;
    setU32(bytes, dirOffset + 128 + 116, 100000);
    const cfb = await open(bytes);
    await expect(cfb.readStream(cfb.entries[0], 1e6)).rejects.toBeInstanceOf(ReadError);
  });

  it('survives a directory tree that points back at itself', async () => {
    const bytes = buildCfb({
      streams: [
        { name: 'a', data: pattern(10) },
        { name: 'b', data: pattern(10) },
      ],
    });
    const dirOffset = (headerU32(bytes, 0x30) + 1) * 512;
    // Entry 2 (b) names entry 1 (a) as its right sibling, and entry 1 names the root as its left.
    setU32(bytes, dirOffset + 256 + 72, 1);
    setU32(bytes, dirOffset + 128 + 68, 0);
    const cfb = await open(bytes);
    expect(cfb.entries.map((e) => e.name).sort()).toEqual(['a', 'b']);
  });

  it('caps the number of directory entries it lists', async () => {
    const streams = Array.from({ length: 66000 }, (_, i) => ({
      name: `s${i}`,
      data: new Uint8Array(0),
    }));
    const cfb = await open(buildCfb({ streams }));
    expect(cfb.truncated).toBe(true);
    expect(cfb.entries.length).toBeLessThanOrEqual(65535);
    expect(cfb.entries.length).toBeGreaterThan(60000);
  });

  it('never throws anything but a ReadError on a truncated file', async () => {
    const bytes = buildCfb({
      clsid: guidBytes(CLSID),
      streams: [
        { name: 'small', data: pattern(100) },
        { name: 'big', data: pattern(9000) },
      ],
    });
    const lengths: number[] = [];
    for (let n = 0; n <= 1024; n++) {
      lengths.push(n);
    }
    for (let n = 1024; n < bytes.length; n += 61) {
      lengths.push(n);
    }
    for (const n of lengths) {
      try {
        const cfb = await open(bytes.subarray(0, n));
        for (const entry of cfb.entries) {
          await cfb.readStream(entry, 1e6);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(ReadError);
      }
    }
  });
});
