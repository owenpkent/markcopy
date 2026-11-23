// Random access to a file on disk, for the file-information readers.
//
// Free of the `vscode` module: the readers run in a worker thread
// (src/fileInfoWorker.ts), which has no editor API, and open the file
// themselves by path.
import type { FileHandle } from 'node:fs/promises';
import type { ByteSource } from './reader';

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
