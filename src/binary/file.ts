// Random access to a file on disk, for the file-information readers.
//
// Free of the `vscode` module: the readers run in a worker thread
// (src/fileInfoWorker.ts), which has no editor API, and open the file
// themselves by path.
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { formatBytesShort } from './html';
import type { ByteSource } from './reader';

/** What identifies a file's contents on its page: how large it is, and its hash. */
export interface Digest {
  size: number;
  /** Lowercase hex. Absent when the file was not hashed. */
  sha256?: string;
  /** Why there is no hash, to show in its place. */
  hashNote?: string;
}

// Hashing reads every byte, which the metadata does not: past this size the
// preview shows what it found at once rather than keep a disk busy for a number
// most readers of a multi-gigabyte installer did not open the file to get.
export const HASH_LIMIT = 256 * 1024 * 1024;

const HASH_CHUNK = 1024 * 1024;

/**
 * The size and SHA-256 of an open file, streamed a megabyte at a time so the
 * file's size never becomes the size of a buffer.
 *
 * It takes the handle, not a path, on purpose. Whoever reads the file's
 * metadata hashes through the same handle, so the two describe the same file
 * even when the path is replaced by another one between them: a rebuild or a
 * finished download renames a new file over the old name, and a page that
 * opened the path twice showed one version's details beside the other's hash.
 */
export async function digestHandle(handle: FileHandle, size: number): Promise<Digest> {
  if (size > HASH_LIMIT) {
    return { size, hashNote: `Not computed for files over ${formatBytesShort(HASH_LIMIT)}` };
  }
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK, Math.max(size, 1)));
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) {
      break;
    }
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { size, sha256: hash.digest('hex') };
}

/** The same for bytes already in memory. */
export function digestBytes(bytes: Uint8Array): Digest {
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Read `length` bytes at `offset`, or as many as the file has.
 *
 * One read may return fewer bytes than were asked for without being at the end
 * of the file, on a network share for one. A ByteSource promises a short
 * answer only at the end, and the reader caches what it gets as the whole
 * page, so a short read passed straight through would make a complete file
 * look truncated. This keeps reading until the range is full or a read
 * returns nothing.
 */
export async function readRange(
  handle: Pick<FileHandle, 'read'>,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** A ByteSource over an open file of `size` bytes. */
export function fileSource(handle: Pick<FileHandle, 'read'>, size: number): ByteSource {
  return { size, read: (offset, length) => readRange(handle, offset, length) };
}
