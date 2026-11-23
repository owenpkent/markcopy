// @vitest-environment node
//
// Node, not jsdom: the tests decode bytes a TextEncoder produced, and under jsdom
// those come from another realm.
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader, ReadError, type ByteSource } from '../../src/binary/reader';

const PAGE = 0x10000;

// A file whose byte at i is i % 251, so a wrong offset shows as a wrong value.
const pattern = (length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => i % 251);

function counting(bytes: Uint8Array): ByteSource & { calls: [number, number][] } {
  const inner = bytesSource(bytes);
  const calls: [number, number][] = [];
  return {
    size: inner.size,
    calls,
    read: (offset, length) => {
      calls.push([offset, length]);
      return inner.read(offset, length);
    },
  };
}

describe('RangeReader.bytes', () => {
  it('reads inside one page', async () => {
    const bytes = pattern(1000);
    const reader = new RangeReader(bytesSource(bytes));
    expect(reader.size).toBe(1000);
    expect(await reader.bytes(10, 20)).toEqual(bytes.subarray(10, 30));
  });

  it('reads across a page boundary and across several pages', async () => {
    const bytes = pattern(PAGE * 3 + 500);
    const reader = new RangeReader(bytesSource(bytes));
    expect(await reader.bytes(PAGE - 5, 10)).toEqual(bytes.subarray(PAGE - 5, PAGE + 5));
    expect(await reader.bytes(PAGE - 1, PAGE + 2)).toEqual(bytes.subarray(PAGE - 1, PAGE * 2 + 1));
    expect(await reader.bytes(0, bytes.length)).toEqual(bytes);
  });

  it('reads the whole of a file, to its last byte', async () => {
    const bytes = pattern(PAGE + 7);
    const reader = new RangeReader(bytesSource(bytes));
    expect(await reader.bytes(PAGE, 7)).toEqual(bytes.subarray(PAGE));
    expect(await reader.bytes(bytes.length, 0)).toHaveLength(0);
  });

  it('throws a ReadError for a read past the end', async () => {
    const reader = new RangeReader(bytesSource(pattern(100)));
    await expect(reader.bytes(90, 11)).rejects.toBeInstanceOf(ReadError);
    await expect(reader.bytes(101, 0)).rejects.toBeInstanceOf(ReadError);
    await expect(reader.bytes(100, 1)).rejects.toBeInstanceOf(ReadError);
  });

  it('throws a ReadError for a negative, fractional, NaN or infinite argument', async () => {
    const reader = new RangeReader(bytesSource(pattern(100)));
    for (const [offset, length] of [
      [-1, 1],
      [0, -1],
      [1.5, 1],
      [0, 1.5],
      [NaN, 1],
      [0, NaN],
      [Infinity, 1],
      [0, Infinity],
      [Number.MAX_SAFE_INTEGER + 2, 1],
    ]) {
      await expect(reader.bytes(offset, length)).rejects.toBeInstanceOf(ReadError);
    }
  });

  it('throws a ReadError for a read over the limit, and honours a custom limit', async () => {
    const bytes = pattern(100);
    const small = new RangeReader(bytesSource(bytes), { maxRead: 10 });
    expect(await small.bytes(0, 10)).toHaveLength(10);
    await expect(small.bytes(0, 11)).rejects.toBeInstanceOf(ReadError);

    // The default limit is far above any metadata read but still finite.
    const big = new RangeReader({
      size: 64 * 1024 * 1024,
      read: () => Promise.resolve(new Uint8Array(0)),
    });
    await expect(big.bytes(0, 8 * 1024 * 1024)).rejects.toBeInstanceOf(ReadError);
  });
});

describe('RangeReader paging', () => {
  it('fetches each page from the source once', async () => {
    const source = counting(pattern(PAGE * 2 + 10));
    const reader = new RangeReader(source);
    await reader.bytes(0, 10);
    await reader.bytes(5, 10);
    await reader.bytes(PAGE - 2, 4);
    await reader.bytes(PAGE, 4);
    await reader.bytes(PAGE * 2, 10);
    await reader.bytes(0, PAGE * 2 + 10);
    expect(source.calls).toEqual([
      [0, PAGE],
      [PAGE, PAGE],
      [PAGE * 2, 10],
    ]);
  });

  it('asks the source for no more than is left of the file in the last page', async () => {
    const source = counting(pattern(PAGE + 3));
    await new RangeReader(source).bytes(PAGE, 3);
    expect(source.calls).toEqual([[PAGE, 3]]);
  });

  it('throws a ReadError once the page budget is spent, and not before', async () => {
    const reader = new RangeReader(bytesSource(pattern(PAGE * 4)), { maxPages: 2 });
    await reader.bytes(0, 1);
    await reader.bytes(PAGE, 1);
    // Pages already held are free.
    await reader.bytes(5, 1);
    await reader.bytes(PAGE + 5, 1);
    await expect(reader.bytes(PAGE * 2, 1)).rejects.toBeInstanceOf(ReadError);
    // The failure does not poison the pages that were read.
    expect(await reader.bytes(0, 1)).toHaveLength(1);
  });

  it('counts a read that spans pages as one page per page touched', async () => {
    const reader = new RangeReader(bytesSource(pattern(PAGE * 4)), { maxPages: 2 });
    await expect(reader.bytes(0, PAGE * 2 + 1)).rejects.toBeInstanceOf(ReadError);
    const ok = new RangeReader(bytesSource(pattern(PAGE * 4)), { maxPages: 2 });
    expect(await ok.bytes(0, PAGE * 2)).toHaveLength(PAGE * 2);
  });

  it('throws a ReadError, not a loop, when the source returns less than its size', async () => {
    const lying: ByteSource = {
      size: PAGE * 2,
      read: () => Promise.resolve(new Uint8Array(0)),
    };
    await expect(new RangeReader(lying).bytes(0, 10)).rejects.toBeInstanceOf(ReadError);

    const short: ByteSource = {
      size: PAGE * 2,
      read: (offset) => Promise.resolve(new Uint8Array(offset === 0 ? 4 : 0)),
    };
    const reader = new RangeReader(short);
    expect(await reader.bytes(0, 4)).toHaveLength(4);
    await expect(reader.bytes(0, 8)).rejects.toBeInstanceOf(ReadError);
  });
});

describe('RangeReader.view', () => {
  it('reads little and big endian values at the offset', async () => {
    const reader = new RangeReader(bytesSource(Uint8Array.of(0, 0, 1, 2, 3, 4)));
    const view = await reader.view(2, 4);
    expect(view.getUint32(0, true)).toBe(0x04030201);
    expect(view.getUint32(0, false)).toBe(0x01020304);
  });

  it('throws a ReadError past the end', async () => {
    const reader = new RangeReader(bytesSource(new Uint8Array(4)));
    await expect(reader.view(2, 4)).rejects.toBeInstanceOf(ReadError);
  });
});

describe('RangeReader.upTo', () => {
  const reader = new RangeReader(bytesSource(pattern(100)));

  it('returns the full length when the file has it', async () => {
    expect(await reader.upTo(10, 5)).toEqual(pattern(100).subarray(10, 15));
  });

  it('clamps at the end of the file', async () => {
    expect(await reader.upTo(90, 50)).toEqual(pattern(100).subarray(90));
    expect(await reader.upTo(99, 1000)).toHaveLength(1);
  });

  it('throws a ReadError at or past the end', async () => {
    await expect(reader.upTo(100, 1)).rejects.toBeInstanceOf(ReadError);
    await expect(reader.upTo(500, 1)).rejects.toBeInstanceOf(ReadError);
    await expect(reader.upTo(-1, 1)).rejects.toBeInstanceOf(ReadError);
    await expect(reader.upTo(0.5, 1)).rejects.toBeInstanceOf(ReadError);
    await expect(reader.upTo(NaN, 1)).rejects.toBeInstanceOf(ReadError);
  });

  it('throws on an empty file even at offset 0', async () => {
    await expect(new RangeReader(bytesSource(new Uint8Array(0))).upTo(0, 4)).rejects.toBeInstanceOf(
      ReadError,
    );
  });
});

describe('RangeReader.cstr', () => {
  const text = (s: string): RangeReader =>
    new RangeReader(bytesSource(new TextEncoder().encode(s)));

  it('stops at the NUL', async () => {
    expect(await text('libc.so.6\0junk after').cstr(0)).toBe('libc.so.6');
  });

  it('reads to the end of the file when there is no NUL', async () => {
    expect(await text('no terminator').cstr(3)).toBe('terminator');
  });

  it('stops at max', async () => {
    expect(await text('abcdefgh\0').cstr(0, 3)).toBe('abc');
    expect(await text('abcdefgh\0').cstr(2, 4)).toBe('cdef');
  });

  it('strips control and bidirectional characters', async () => {
    const rlo = String.fromCharCode(0x202e);
    expect(await text(`a\x01b\x1bc${rlo}d\ne\tf`).cstr(0)).toBe('abcdef');
  });

  it('returns an empty string for a NUL at the offset', async () => {
    expect(await text('\0abc').cstr(0)).toBe('');
  });

  it('throws a ReadError for an offset outside the file', async () => {
    await expect(text('abc').cstr(3)).rejects.toBeInstanceOf(ReadError);
  });
});
