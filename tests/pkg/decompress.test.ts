// @vitest-environment node
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import {
  ByteSink,
  gunzipBounded,
  gunzipUntil,
  readCompressed,
  unxzBounded,
  unzstdBounded,
} from '../../src/pkg/decompress';
import { PackageError } from '../../src/pkg/model';
import {
  b64,
  concat,
  VECTOR_CONTROL,
  VECTOR_XZ,
  VECTOR_XZ_ZEROS,
  VECTOR_ZST,
  VECTOR_ZST_ZEROS,
} from './debFixture';

const MIB = 1024 * 1024;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('gunzipBounded', () => {
  it('inflates a gzip stream', () => {
    expect(text(gunzipBounded(gzipSync(utf8('hello hello hello')), MIB))).toBe('hello hello hello');
  });

  it('inflates concatenated members', () => {
    const data = concat(gzipSync(utf8('one ')), gzipSync(utf8('two')));
    expect(text(gunzipBounded(data, MIB))).toBe('one two');
  });

  it('stops at the cap instead of inflating a bomb', () => {
    const bomb = gzipSync(new Uint8Array(32 * MIB));
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(() => gunzipBounded(bomb, MIB)).toThrow(PackageError);
    expect(() => gunzipBounded(bomb, MIB)).toThrow('more data than MarkCopy will unpack');
  });

  it('turns empty and damaged input into a PackageError', () => {
    expect(() => gunzipBounded(new Uint8Array(0), MIB)).toThrow(PackageError);
    expect(() => gunzipBounded(utf8('plainly not gzip'), MIB)).toThrow(PackageError);
  });
});

describe('gunzipUntil', () => {
  it('stops early without inflating the rest, even if the rest is a bomb', () => {
    const data = concat(gzipSync(utf8('head')), gzipSync(new Uint8Array(32 * MIB)));
    let seen = 0;
    gunzipUntil(data, MIB, (chunk) => {
      seen += chunk.length;
      return true;
    });
    expect(seen).toBe(4);
  });
});

describe('unxzBounded', () => {
  it('inflates an xz stream made by lzma', async () => {
    const out = await unxzBounded(b64(VECTOR_XZ), MIB);
    expect(out.length).toBe(10240);
    expect(text(out)).toContain(VECTOR_CONTROL.split('\n')[0]);
  });

  it('stops at the cap while streaming, and the next call still works', async () => {
    const bomb = b64(VECTOR_XZ_ZEROS);
    expect(bomb.length).toBeLessThan(1000);
    await expect(unxzBounded(bomb, MIB)).rejects.toThrow('more data than MarkCopy will unpack');
    expect((await unxzBounded(b64(VECTOR_XZ), MIB)).length).toBe(10240);
  });

  it('accepts output exactly at the cap and refuses one byte past it', async () => {
    const bomb = b64(VECTOR_XZ_ZEROS);
    expect((await unxzBounded(bomb, 4 * MIB)).length).toBe(4 * MIB);
    await expect(unxzBounded(bomb, 4 * MIB - 1)).rejects.toThrow(PackageError);
  });

  it('rejects truncated, empty and garbage input without hanging', async () => {
    const good = b64(VECTOR_XZ);
    await expect(unxzBounded(good.subarray(0, 200), MIB)).rejects.toThrow(PackageError);
    await expect(unxzBounded(new Uint8Array(0), MIB)).rejects.toThrow(PackageError);
    await expect(unxzBounded(new Uint8Array(3000).fill(0x41), MIB)).rejects.toThrow(PackageError);
    expect((await unxzBounded(good, MIB)).length).toBe(10240);
  });
});

describe('unzstdBounded', () => {
  it('inflates a Zstandard stream', () => {
    const out = unzstdBounded(b64(VECTOR_ZST), MIB);
    expect(out.length).toBe(10240);
    expect(text(out)).toContain('Package: vectorpkg');
  });

  it('stops at the cap', () => {
    const bomb = b64(VECTOR_ZST_ZEROS);
    expect(bomb.length).toBeLessThan(300);
    expect(() => unzstdBounded(bomb, MIB)).toThrow('more data than MarkCopy will unpack');
    expect(unzstdBounded(bomb, 4 * MIB).length).toBe(4 * MIB);
  });

  it('refuses a frame that declares a huge content size before decoding it', () => {
    // Magic, descriptor 0xE0 (single segment, 8-byte content size), size 2^40, one empty block.
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xe0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
    expect(() => unzstdBounded(frame, MIB)).toThrow('more data than MarkCopy will unpack');
  });

  it('refuses a frame that asks for a huge window', () => {
    // Descriptor 0 (no single segment, no content size), window byte 0xF8 (2^41 bytes).
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xf8, 0x01, 0x00, 0x00]);
    expect(() => unzstdBounded(frame, 64 * MIB)).toThrow('larger Zstandard window');
  });

  it('turns truncated and garbage input into a PackageError', () => {
    const good = b64(VECTOR_ZST);
    expect(() => unzstdBounded(good.subarray(0, 100), MIB)).toThrow(PackageError);
    expect(() => unzstdBounded(new Uint8Array(0), MIB)).toThrow(PackageError);
    expect(() => unzstdBounded(new Uint8Array(500).fill(0x41), MIB)).toThrow(PackageError);
  });
});

describe('readCompressed', () => {
  const data = new Uint8Array(3 * MIB + 5).map((_, i) => i % 251);
  const reader = new RangeReader(bytesSource(data), { maxPages: 512, maxRead: 16 * MIB });

  it('reads a range larger than one piece', async () => {
    const out = await readCompressed(reader, 7, 2 * MIB + 100, 8 * MIB);
    // Compared as buffers: toEqual walks two megabytes element by element,
    // which took over six seconds on a CI runner and timed the test out.
    const expected = data.subarray(7, 7 + 2 * MIB + 100);
    expect(out).toHaveLength(expected.length);
    expect(Buffer.compare(out, expected)).toBe(0);
  });

  it('refuses a length over the cap before reading anything', async () => {
    await expect(readCompressed(reader, 0, 4 * MIB, 3 * MIB)).rejects.toThrow(PackageError);
    await expect(readCompressed(reader, 0, -1, 3 * MIB)).rejects.toThrow(PackageError);
    await expect(readCompressed(reader, 0, Number.NaN, 3 * MIB)).rejects.toThrow(PackageError);
  });

  it('reports a range that runs past the file', async () => {
    await expect(readCompressed(reader, 3 * MIB, 100, MIB)).rejects.toThrow(PackageError);
  });
});

describe('ByteSink', () => {
  it('keeps what was appended across growth', () => {
    const sink = new ByteSink();
    const piece = new Uint8Array(10000).fill(3);
    for (let i = 0; i < 20; i++) {
      sink.append(piece);
    }
    expect(sink.length).toBe(200000);
    expect(sink.bytes().every((b) => b === 3)).toBe(true);
  });
});
