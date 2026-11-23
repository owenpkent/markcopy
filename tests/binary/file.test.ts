// @vitest-environment node
//
// src/binary/file.ts: the file access the file-information readers share. The
// digest is taken from an open handle, never a path, so that whoever read a
// file's metadata through that handle hashes the same file (see digestHandle).
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  digestBytes,
  digestHandle,
  fileSource,
  HASH_LIMIT,
  readRange,
} from '../../src/binary/file';

const dir = mkdtempSync(join(tmpdir(), 'markcopy-file-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let count = 0;
async function withFile<T>(
  bytes: Uint8Array,
  use: (handle: Awaited<ReturnType<typeof open>>, size: number) => Promise<T>,
): Promise<T> {
  const path = join(dir, `f${++count}.bin`);
  writeFileSync(path, bytes);
  const handle = await open(path, 'r');
  try {
    return await use(handle, (await handle.stat()).size);
  } finally {
    await handle.close();
  }
}

describe('digestHandle', () => {
  it('matches node:crypto for a file of several chunks', async () => {
    // Over the one-megabyte chunk, and not a multiple of it, so the last chunk is short.
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 123 }, (_, i) => (i * 31) % 251);

    const digest = await withFile(bytes, (handle, size) => digestHandle(handle, size));

    expect(digest).toEqual({ size: bytes.length, sha256: sha256(bytes) });
  });

  it('hashes an empty file', async () => {
    const digest = await withFile(new Uint8Array(0), (handle, size) => digestHandle(handle, size));

    expect(digest).toEqual({ size: 0, sha256: sha256(new Uint8Array(0)) });
  });

  it('does not hash a file over the limit, and says why', async () => {
    // The size is passed in, so no file of that size is needed.
    const size = HASH_LIMIT + 1;
    const digest = await withFile(Uint8Array.of(1, 2, 3), (handle) => digestHandle(handle, size));

    expect(digest.size).toBe(size);
    expect(digest.sha256).toBeUndefined();
    expect(digest.hashNote).toMatch(/^Not computed for files over /);
  });

  it('hashes a file of exactly the limit size argument', async () => {
    const digest = await withFile(Uint8Array.of(1, 2, 3), (handle) =>
      digestHandle(handle, HASH_LIMIT),
    );

    // Not over the limit, so it is hashed (here, of the three bytes there are).
    expect(digest.sha256).toBe(sha256(Uint8Array.of(1, 2, 3)));
  });
});

describe('digestBytes', () => {
  it('gives the size and SHA-256 of the bytes', () => {
    const bytes = new TextEncoder().encode('hello');

    expect(digestBytes(bytes)).toEqual({ size: 5, sha256: sha256(bytes) });
  });

  it('agrees with digestHandle for the same content', async () => {
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);

    const viaHandle = await withFile(bytes, (handle, size) => digestHandle(handle, size));

    expect(viaHandle).toEqual(digestBytes(bytes));
  });
});

describe('readRange and fileSource', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

  it('reads a range, and what there is when the file ends inside it', async () => {
    await withFile(bytes, async (handle) => {
      expect(await readRange(handle, 100, 50)).toEqual(bytes.subarray(100, 150));
      expect(await readRange(handle, 900, 500)).toEqual(bytes.subarray(900));
      expect(await readRange(handle, 1000, 8)).toHaveLength(0);
    });
  });

  it('is a ByteSource over the open file', async () => {
    await withFile(bytes, async (handle, size) => {
      const source = fileSource(handle, size);

      expect(source.size).toBe(1000);
      expect(await source.read(10, 20)).toEqual(bytes.subarray(10, 30));
    });
  });
});
