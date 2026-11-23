// What the file-information worker does: read one executable or package and
// hand back what it found.
//
// Free of the `vscode` module, because it runs in a worker thread
// (src/fileInfoWorker.ts) and, in unit tests, in the test process directly.
// Everything that parses bytes from the file happens inside runFileInfoTask;
// the extension host only starts it and renders what comes back.
import { open } from 'node:fs/promises';
import { fileSource } from './binary/file';
import { bytesSource, ReadError } from './binary/reader';
import { readPe, type PeInfo } from './pe';
import { readPackage, type PackageInfo } from './pkg';

export interface FileInfoRequest {
  kind: 'exe' | 'package';
  /** The file's own name, which decides how a gzip-compressed `.apk` is read. */
  fileName: string;
  /** A file on disk, opened here and read in ranges. */
  path?: string;
  /** A file that is not on a local disk, already read whole by the host. */
  bytes?: Uint8Array;
}

export type FileInfoResult =
  | { ok: true; kind: 'exe'; info: PeInfo }
  | { ok: true; kind: 'package'; info: PackageInfo }
  // `expected` is a ReadError: a message written to be shown as it is. Anything
  // else is a bug in a reader, and is shown with a generic lead-in.
  | { ok: false; expected: boolean; message: string };

export async function runFileInfoTask(request: FileInfoRequest): Promise<FileInfoResult> {
  try {
    if (request.path !== undefined) {
      const handle = await open(request.path, 'r');
      try {
        const size = (await handle.stat()).size;
        return await read(request, fileSource(handle, size));
      } finally {
        await handle.close();
      }
    }
    if (request.bytes !== undefined) {
      return await read(request, bytesSource(request.bytes));
    }
    throw new Error('the request named no file.');
  } catch (err) {
    return {
      ok: false,
      expected: err instanceof ReadError,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function read(
  request: FileInfoRequest,
  source: Parameters<typeof readPe>[0],
): Promise<FileInfoResult> {
  return request.kind === 'exe'
    ? { ok: true, kind: 'exe', info: await readPe(source) }
    : { ok: true, kind: 'package', info: await readPackage(source, request.fileName) };
}
