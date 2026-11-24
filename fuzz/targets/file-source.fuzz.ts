import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { fileSource } from '../../src/binary/file';
import { bytesSource, ReadError, type ByteSource } from '../../src/binary/reader';
import { runFileInfoTask, type FileInfoResult } from '../../src/fileInfoTask';
import { readPe } from '../../src/pe';
import { readPackage } from '../../src/pkg';
import { withHeader } from './pe.fuzz';
import { shaped } from './pkg.fuzz';

// The pe and pkg targets read from memory (bytesSource). The preview reads a
// file on disk, in a worker, through runFileInfoTask: fileSource over an open
// handle, whose reads may come back short, behind the same RangeReader. This
// target checks the two agree, so the code only the real path runs
// (src/binary/file.ts, src/fileInfoTask.ts, the digest) is fuzzed too, and so
// is the reader's page logic under reads that end early.
//
// The first input byte picks executable (0xf0 and up) or package; a package
// input is then shaped exactly as the pkg target shapes it (that byte also picks
// its format), an executable's remaining bytes as the pe target shapes them. Each file is then read:
//   1. by runFileInfoTask from bytes in memory,
//   2. by runFileInfoTask from the same bytes written to a real file,
//   3. through fileSource over a handle that answers every read in pieces of
//      sizes drawn from the input, as a network share may,
//   4. from memory a second time, so a reader that keeps state between files
//      shows up as a difference.
// All four must give the same answer: the same description, or the same
// refusal. Anything else is a finding.

const dir = mkdtempSync(join(tmpdir(), 'markcopy-fuzz-'));
const file = join(dir, 'input.bin');
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));

/** A handle over `bytes` whose reads return at most a few bytes more than nothing each time. */
export function choppyHandle(bytes: Uint8Array, seed: number): Pick<FileHandle, 'read'> {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    // xorshift32: cheap, deterministic, and enough to vary the piece sizes.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const read = (buffer: Uint8Array, offset: number, length: number, position: number) => {
    const available = Math.max(0, Math.min(length, bytes.length - position));
    // Never zero before the end: a real handle returns 0 only at end of file.
    const take = available === 0 ? 0 : 1 + (next() % Math.min(available, 4099));
    buffer.set(bytes.subarray(position, position + take), offset);
    return Promise.resolve({ bytesRead: take, buffer });
  };
  return { read: read as unknown as FileHandle['read'] };
}

type Kind = 'exe' | 'package';

async function viaSource(kind: Kind, source: ByteSource, fileName: string): Promise<unknown> {
  try {
    return kind === 'exe'
      ? { ok: true, info: await readPe(source) }
      : { ok: true, info: await readPackage(source, fileName) };
  } catch (err) {
    if (!(err instanceof ReadError)) {
      throw err;
    }
    return { ok: false, message: err.message };
  }
}

/** The part of a task's answer that must not depend on how the file was read. */
function answer(result: FileInfoResult): unknown {
  if (!result.ok) {
    if (!result.expected) {
      // A reader threw something other than its documented error: the pe and
      // pkg targets report the same input, with its stack.
      throw new Error(`reader failed: ${result.message}`);
    }
    return { ok: false, message: result.message };
  }
  return { ok: true, info: result.info, sha256: result.digest.sha256, size: result.digest.size };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function fuzz(data: Buffer): Promise<void> {
  if (data.length === 0) {
    return;
  }
  const kind: Kind = data[0] >= 0xf0 ? 'exe' : 'package';
  // For a package the same byte also picks its shape, as in the pkg target, so
  // a pkg seed means the same file here.
  const { bytes, name } =
    kind === 'exe' ? { bytes: withHeader(data.subarray(1)), name: 'fuzz.exe' } : shaped(data);

  const fromBytes = answer(await runFileInfoTask({ kind, fileName: name, bytes }));
  writeFileSync(file, bytes);
  const fromFile = answer(await runFileInfoTask({ kind, fileName: name, path: file }));
  if (!same(fromBytes, fromFile)) {
    throw new Error(`${name}: reading from a file and from memory disagree`);
  }

  const seed = data.length * 2654435761 + (data[data.length - 1] ?? 0);
  const choppy = await viaSource(kind, fileSource(choppyHandle(bytes, seed), bytes.length), name);
  const again = await viaSource(kind, bytesSource(bytes), name);
  const { sha256: _sha, size: _size, ...direct } = fromBytes as Record<string, unknown>;
  if (!same(direct, choppy)) {
    throw new Error(`${name}: reads that come back in pieces change the answer`);
  }
  if (!same(direct, again)) {
    throw new Error(`${name}: reading the same file twice gives different answers`);
  }
}
