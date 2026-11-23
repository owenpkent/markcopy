// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import { listAr } from '../../src/pkg/ar';
import { readTar, tarData, TAR_MAX_ENTRIES } from '../../src/pkg/tar';
import { ar, concat, paxRecord, tar, tarHeader } from './debFixture';

const reader = (bytes: Uint8Array): RangeReader => new RangeReader(bytesSource(bytes));
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('listAr', () => {
  it('lists members with their data offsets, padding odd sizes to an even offset', async () => {
    const bytes = ar([
      { name: 'debian-binary', data: '2.0\n' },
      { name: 'odd.txt', data: 'abc' },
      { name: 'last', data: 'zz' },
    ]);
    const listing = await listAr(reader(bytes));
    expect(listing?.members.map((m) => [m.name, m.size, m.offset, m.truncated])).toEqual([
      ['debian-binary', 4, 8 + 60, false],
      ['odd.txt', 3, 8 + 60 + 4 + 60, false],
      ['last', 2, 8 + 60 + 4 + 60 + 4 + 60, false],
    ]);
    expect(listing?.capped).toBe(false);
  });

  it('strips the GNU slash terminator from names', async () => {
    const listing = await listAr(reader(ar([{ name: 'file/', data: 'x' }])));
    expect(listing?.members[0].name).toBe('file');
  });

  it('returns null for a file that is not ar', async () => {
    expect(await listAr(reader(utf8('not an archive')))).toBeNull();
    expect(await listAr(reader(new Uint8Array(3)))).toBeNull();
  });

  it('stops at a damaged header and keeps the members before it', async () => {
    const bytes = ar([
      { name: 'a', data: 'xx' },
      { name: 'b', data: 'yy' },
    ]);
    bytes[8 + 60 + 2 + 58] = 0x41;
    expect((await listAr(reader(bytes)))?.members.map((m) => m.name)).toEqual(['a']);
    const sizeless = ar([{ name: 'a', data: 'xx' }]);
    sizeless.set(utf8('12ab      '), 8 + 48);
    expect((await listAr(reader(sizeless)))?.members).toEqual([]);
  });

  it('marks a member whose data runs past the end of the file', async () => {
    const bytes = ar([{ name: 'a', data: 'xx', declaredSize: 5000 }]);
    const listing = await listAr(reader(bytes));
    expect(listing?.members[0].truncated).toBe(true);
  });

  it('caps the number of members it walks', async () => {
    const bytes = ar(Array.from({ length: 100 }, (_, i) => ({ name: `m${i}`, data: '' })));
    const listing = await listAr(reader(bytes));
    expect(listing?.members).toHaveLength(64);
    expect(listing?.capped).toBe(true);
  });
});

describe('readTar', () => {
  it('lists entries and removes the leading ./', () => {
    const bytes = tar([
      { name: './control', data: 'Package: x\n' },
      { name: './md5sums', data: '' },
      { name: './dir/', type: '5' },
    ]);
    const result = readTar(bytes);
    expect(result.stop).toBe('end');
    expect(result.entries.map((e) => [e.name, e.size, e.type])).toEqual([
      ['control', 11, '0'],
      ['md5sums', 0, '0'],
      ['dir/', 0, '5'],
    ]);
    expect(new TextDecoder().decode(tarData(bytes, result.entries[0]))).toBe('Package: x\n');
  });

  it('reads a GNU long name (type L)', () => {
    const long = `${'d/'.repeat(80)}file`;
    const bytes = tar([
      { name: '././@LongLink', type: 'L', data: `${long}\0` },
      { name: 'short', data: 'x' },
    ]);
    expect(readTar(bytes).entries.map((e) => e.name)).toEqual([long]);
  });

  it('reads a pax path record (type x) and skips a global one (type g)', () => {
    const long = `${'p/'.repeat(80)}file`;
    const bytes = tar([
      { name: 'global', type: 'g', data: paxRecord('comment', 'hi') },
      {
        name: './PaxHeaders/x',
        type: 'x',
        data: paxRecord('mtime', '0') + paxRecord('path', long),
      },
      { name: 'short', data: 'x' },
    ]);
    expect(readTar(bytes).entries.map((e) => e.name)).toEqual([long]);
  });

  it('joins the ustar prefix and name', () => {
    const bytes = concat(tarHeader('file.txt', 0, '0', 'usr/share/doc'), new Uint8Array(1024));
    expect(readTar(bytes).entries[0].name).toBe('usr/share/doc/file.txt');
  });

  it('stops at a header whose checksum is wrong or whose size is not a number', () => {
    const bad = tar([{ name: 'a', data: 'x' }], false);
    bad[0] ^= 1;
    expect(readTar(bad).stop).toBe('invalid');
    const sized = tar([{ name: 'a', data: 'x' }], false);
    sized.set(utf8('zzzzzzzzzzz\0'), 124);
    expect(readTar(sized).stop).toBe('invalid');
  });

  it('reports an entry whose data is not all in the buffer, and says more is needed', () => {
    const bytes = tar([{ name: 'big', data: new Uint8Array(2000) }], false);
    const cut = readTar(bytes.subarray(0, 1000));
    expect(cut.entries[0].complete).toBe(false);
    expect(cut.stop).toBe('more');
    expect(tarData(bytes.subarray(0, 1000), cut.entries[0])).toBeUndefined();
    expect(readTar(bytes.subarray(0, 100)).stop).toBe('more');
  });

  it('waits for a long-name record that is not all there yet', () => {
    const bytes = tar(
      [{ name: '././@LongLink', type: 'L', data: 'x'.repeat(300) }, { name: 'a' }],
      false,
    );
    expect(readTar(bytes.subarray(0, 600)).stop).toBe('more');
  });

  it('refuses a name record far larger than any path', () => {
    const header = tarHeader('././@LongLink', 10 * 1024 * 1024, 'L');
    expect(readTar(concat(header, new Uint8Array(1024))).stop).toBe('invalid');
  });

  it('reads a base-256 size', () => {
    const header = tarHeader('big', 0);
    header.fill(0, 124, 136);
    header[124] = 0x80;
    header[135] = 0x10;
    // Recompute the checksum after editing the size field.
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of header) {
      sum += b;
    }
    header.set(utf8(`${sum.toString(8).padStart(6, '0')}\0`), 148);
    const result = readTar(concat(header, new Uint8Array(1024)));
    expect(result.entries[0].size).toBe(16);
  });

  it('stops at the entry cap instead of walking an endless list of empty headers', () => {
    const headers = Array.from({ length: TAR_MAX_ENTRIES + 50 }, (_, i) => tarHeader(`f${i}`, 0));
    const result = readTar(concat(...headers));
    expect(result.entries).toHaveLength(TAR_MAX_ENTRIES);
    expect(result.stop).toBe('cap');
  });

  it('points past the buffer for an entry that declares a huge size, without allocating', () => {
    const result = readTar(tarHeader('huge', 0o7777777777));
    expect(result.entries[0].complete).toBe(false);
    expect(result.next).toBeGreaterThan(1e9);
  });

  it('can be resumed from where it stopped', () => {
    const bytes = tar(
      [
        { name: 'a', data: 'x' },
        { name: 'b', data: 'y' },
      ],
      false,
    );
    const first = readTar(bytes.subarray(0, 1024));
    expect(first.entries.map((e) => e.name)).toEqual(['a']);
    const rest = readTar(bytes, first.next);
    expect(rest.entries.map((e) => e.name)).toEqual(['b']);
  });
});
