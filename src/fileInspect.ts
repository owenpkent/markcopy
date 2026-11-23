import * as vscode from 'vscode';
import { open } from 'node:fs/promises';
import { digestBytes, digestHandle, fileSource, type Digest } from './binary/file';
import { bytesSource, ReadError, type ByteSource } from './binary/reader';
import { formatBytesShort } from './binary/html';

export { readRange, type Digest } from './binary/file';

// The host's side of the file-information previews (src/fileInfoEditor.ts):
// what it does to the file itself, as opposed to what the readers make of it.
// That is the SHA-256, the size, and fetching a file that is not on a local
// disk. None of it interprets the file's contents.

// A file that is not on a local disk (a virtual or remote file system) can only
// be read whole, so it has to fit in memory to be read at all.
const WHOLE_FILE_LIMIT = 64 * 1024 * 1024;

export interface Inspected<T> extends Digest {
  result: T;
}

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
      return { result, ...(await digestHandle(handle, size)) };
    } finally {
      await handle.close();
    }
  }
  const bytes = (await remoteBytes(uri)) ?? new Uint8Array(0);
  return { result: await read(bytesSource(bytes)), ...digestBytes(bytes) };
}
