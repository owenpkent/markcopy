import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { fileSource } from './binary/file';
import { bytesSource, ReadError, type ByteSource } from './binary/reader';
import { formatBytesShort } from './binary/html';

export { readRange } from './binary/file';

// The host's side of the file-information previews (src/fileInfoEditor.ts):
// what it does to the file itself, as opposed to what the readers make of it.
// That is the SHA-256, the size, and fetching a file that is not on a local
// disk. None of it interprets the file's contents.

// Hashing reads every byte, which the metadata does not: past this size the
// preview shows what it found at once rather than keep a disk busy for a number
// most readers of a multi-gigabyte installer did not open the file to get.
const HASH_LIMIT = 256 * 1024 * 1024;

// A file that is not on a local disk (a virtual or remote file system) can only
// be read whole, so it has to fit in memory to be read at all.
const WHOLE_FILE_LIMIT = 64 * 1024 * 1024;

const HASH_CHUNK = 1024 * 1024;

export interface Digest {
  size: number;
  /** Lowercase hex. Absent when the file was too large to hash. */
  sha256?: string;
  /** Why there is no hash, to show in its place. */
  hashNote?: string;
}

export interface Inspected<T> extends Digest {
  result: T;
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

const tooLargeToHash = (): string => `Not computed for files over ${formatBytesShort(HASH_LIMIT)}`;

/**
 * The bytes of a file that is not on a local disk, which the worker cannot
 * open by path. Refused, before any of it is fetched, when it is too large to
 * hold in memory. Undefined for a file on disk.
 */
export async function remoteBytes(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  if (uri.scheme === 'file') {
    return undefined;
  }
  const { size } = await vscode.workspace.fs.stat(uri);
  if (size > WHOLE_FILE_LIMIT) {
    throw new ReadError(
      `it is ${formatBytesShort(size)} and not on a local disk, where MarkCopy reads files of up to ${formatBytesShort(WHOLE_FILE_LIMIT)}.`,
    );
  }
  return vscode.workspace.fs.readFile(uri);
}

/**
 * The file's size and SHA-256. `bytes` is what remoteBytes returned for it.
 *
 * A file on disk is hashed through a file handle a megabyte at a time, so its
 * size never becomes the size of a buffer.
 */
export async function digestFile(uri: vscode.Uri, bytes?: Uint8Array): Promise<Digest> {
  if (bytes) {
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const handle = await open(uri.fsPath, 'r');
  try {
    const size = (await handle.stat()).size;
    return size <= HASH_LIMIT
      ? { size, sha256: await hashFile(handle, size) }
      : { size, hashNote: tooLargeToHash() };
  } finally {
    await handle.close();
  }
}

/**
 * Run `read` over the file at `uri`, in this process, and hash the file.
 *
 * The previews do not use this: they read in a worker (src/isolate.ts). It is
 * the same access without the isolation, for callers that hold a reader they
 * trust with the process, and for tests of the readers against a real file.
 */
export async function inspectFile<T>(
  uri: vscode.Uri,
  read: (source: ByteSource) => Promise<T>,
): Promise<Inspected<T>> {
  if (uri.scheme === 'file') {
    const handle = await open(uri.fsPath, 'r');
    try {
      const size = (await handle.stat()).size;
      const result = await read(fileSource(handle, size));
      return size <= HASH_LIMIT
        ? { result, size, sha256: await hashFile(handle, size) }
        : { result, size, hashNote: tooLargeToHash() };
    } finally {
      await handle.close();
    }
  }
  const bytes = (await remoteBytes(uri)) ?? new Uint8Array(0);
  return {
    result: await read(bytesSource(bytes)),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
