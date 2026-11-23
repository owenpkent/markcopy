import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { bytesSource, ReadError, type ByteSource } from './binary/reader';
import { formatBytesShort } from './binary/html';

// Opening a file for the previews that describe it without loading it: the
// executable info page (src/exeEditor.ts) and the package info page
// (src/packageEditor.ts). Both want the same two things from the host: random
// access to the bytes, and the file's SHA-256.

// Hashing reads every byte, which the metadata does not: past this size the
// preview shows what it found at once rather than keep a disk busy for a number
// most readers of a multi-gigabyte installer did not open the file to get.
const HASH_LIMIT = 256 * 1024 * 1024;

// A file that is not on a local disk (a virtual or remote file system) can only
// be read whole, so it has to fit in memory to be read at all.
const WHOLE_FILE_LIMIT = 64 * 1024 * 1024;

const HASH_CHUNK = 1024 * 1024;

export interface Inspected<T> {
  result: T;
  size: number;
  /** Lowercase hex. Absent when the file was too large to hash. */
  sha256?: string;
  /** Why there is no hash, to show in its place. */
  hashNote?: string;
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

async function hashFile(handle: FileHandle, size: number): Promise<string> {
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
  return hash.digest('hex');
}

/**
 * Run `read` over the file at `uri` and hash the file.
 *
 * A file on disk is read in ranges through a file handle, so the size of the
 * file never becomes the size of a buffer. Nothing here runs or loads it.
 */
export async function inspectFile<T>(
  uri: vscode.Uri,
  read: (source: ByteSource) => Promise<T>,
): Promise<Inspected<T>> {
  if (uri.scheme === 'file') {
    const handle = await open(uri.fsPath, 'r');
    try {
      const size = (await handle.stat()).size;
      const result = await read({
        size,
        read: (offset, length) => readRange(handle, offset, length),
      });
      return size <= HASH_LIMIT
        ? { result, size, sha256: await hashFile(handle, size) }
        : {
            result,
            size,
            hashNote: `Not computed for files over ${formatBytesShort(HASH_LIMIT)}`,
          };
    } finally {
      await handle.close();
    }
  }
  const { size } = await vscode.workspace.fs.stat(uri);
  if (size > WHOLE_FILE_LIMIT) {
    throw new ReadError(
      `it is ${formatBytesShort(size)} and not on a local disk, where MarkCopy reads files of up to ${formatBytesShort(WHOLE_FILE_LIMIT)}.`,
    );
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    result: await read(bytesSource(bytes)),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
