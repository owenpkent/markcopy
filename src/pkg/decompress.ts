// Bounded decompression for package readers.
//
// A package's metadata lives inside compressed archives (a .deb's control.tar.xz,
// an Alpine .apk's first gzip stream). Those are untrusted, so every helper here
// takes the largest output it will produce and throws as soon as the stream goes
// past it, while it is still inflating. A few kilobytes that expand to gigabytes
// therefore end in a PackageError and never in an out-of-memory.
//
// No `vscode` import: the helpers are pure and unit-tested.
import { Gunzip } from 'fflate';
import { Decompress as ZstdDecompress } from 'fzstd';
import { XzReadableStream } from 'xz-decompress';
import type { RangeReader } from '../binary/reader';
import { PackageError } from './model';

export const TOO_BIG = 'it expands to more data than MarkCopy will unpack.';
export const DAMAGED = 'its compressed data is damaged.';

// Input is fed in small slices so one slice cannot expand into more than a few
// megabytes (deflate cannot beat about 1000:1) before the cap is checked again.
const GZIP_SLICE = 4 * 1024;
// Zstandard emits one callback per block of at most 128 KiB, and the cap is
// checked in each, so a bigger slice is safe.
const ZSTD_SLICE = 16 * 1024;
const XZ_SLICE = 16 * 1024;

// The largest back-reference window we will allocate for a Zstandard frame. A
// frame header may ask for gigabytes; real packages use 1 to 8 MiB (dpkg's default).
const ZSTD_MAX_WINDOW = 32 * 1024 * 1024;

// After the xz input is used up, a healthy stream finishes within a pull or two.
// A truncated one makes the decoder return empty output forever, so a run of
// empty chunks past the end of the input is how that is told apart.
const XZ_MAX_IDLE_PULLS = 4;

/** An append-only byte buffer that grows by doubling, so a long inflate does not copy per chunk. */
export class ByteSink {
  private buffer = new Uint8Array(16 * 1024);
  length = 0;

  append(chunk: Uint8Array): void {
    const needed = this.length + chunk.length;
    if (needed > this.buffer.length) {
      let size = this.buffer.length;
      while (size < needed) {
        size *= 2;
      }
      const grown = new Uint8Array(size);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(chunk, this.length);
    this.length = needed;
  }

  /** The bytes so far. Valid until the next append. */
  bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

/**
 * A slice of the file's bytes that will be decompressed, read in pieces so the
 * reader's single-read limit does not matter. `max` is the most that is worth
 * reading for what the caller expects; a larger declared size is refused before
 * any byte of it is read.
 */
export async function readCompressed(
  reader: RangeReader,
  offset: number,
  length: number,
  max: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new PackageError('its compressed data is larger than MarkCopy will read.');
  }
  const PIECE = 1024 * 1024;
  const out = new Uint8Array(length);
  for (let done = 0; done < length; done += PIECE) {
    const piece = await reader.bytes(offset + done, Math.min(PIECE, length - done));
    out.set(piece, done);
  }
  return out;
}

/** Called with each piece of output. Return true to stop early. */
export type ChunkHandler = (chunk: Uint8Array) => boolean | void;

class Stop extends Error {}

function contain(error: unknown): never {
  if (error instanceof PackageError) {
    throw error;
  }
  throw new PackageError(DAMAGED);
}

/**
 * Inflate gzip (all members, concatenated) and hand each piece to `onChunk`,
 * stopping when it returns true. Throws when more than `max` bytes come out.
 */
export function gunzipUntil(data: Uint8Array, max: number, onChunk: ChunkHandler): void {
  if (data.length === 0) {
    throw new PackageError(DAMAGED);
  }
  let total = 0;
  const gunzip = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > max) {
      throw new PackageError(TOO_BIG);
    }
    if (onChunk(chunk) === true) {
      throw new Stop();
    }
  });
  try {
    for (let i = 0; i < data.length; i += GZIP_SLICE) {
      const end = Math.min(i + GZIP_SLICE, data.length);
      gunzip.push(data.subarray(i, end), end === data.length);
    }
  } catch (error) {
    if (error instanceof Stop) {
      return;
    }
    contain(error);
  }
}

export function gunzipBounded(data: Uint8Array, max: number): Uint8Array {
  const sink = new ByteSink();
  gunzipUntil(data, max, (chunk) => {
    sink.append(chunk);
  });
  return sink.bytes();
}

/** Refuse a Zstandard frame whose header declares more than we would unpack or allocate. */
function checkZstdHeader(data: Uint8Array, max: number): void {
  let pos = 0;
  // Skippable frames (magic 0x184D2A50 to 0x184D2A5F) may come first.
  for (let skipped = 0; skipped < 8 && pos + 8 <= data.length; skipped++) {
    const magic = new DataView(data.buffer, data.byteOffset + pos, 8).getUint32(0, true);
    if ((magic & 0xfffffff0) !== 0x184d2a50) {
      break;
    }
    pos += 8 + new DataView(data.buffer, data.byteOffset + pos, 8).getUint32(4, true);
  }
  if (pos + 6 > data.length) {
    return; // too short to say; the decoder will report it
  }
  const view = new DataView(data.buffer, data.byteOffset + pos, data.length - pos);
  if (view.getUint32(0, true) !== 0xfd2fb528) {
    return;
  }
  const descriptor = view.getUint8(4);
  const single = (descriptor & 0x20) !== 0;
  const sizeFlag = descriptor >> 6;
  const dictBytes = [0, 1, 2, 4][descriptor & 3];
  let at = 5;
  let window = 0;
  if (!single) {
    const byte = view.getUint8(at++);
    const base = 2 ** (10 + (byte >> 3));
    window = base + (base / 8) * (byte & 7);
  }
  at += dictBytes;
  const contentBytes = sizeFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][sizeFlag];
  if (contentBytes > 0 && at + contentBytes <= view.byteLength) {
    let content = 0;
    for (let i = contentBytes - 1; i >= 0; i--) {
      content = content * 256 + view.getUint8(at + i);
    }
    if (sizeFlag === 1) {
      content += 256;
    }
    if (content > max) {
      throw new PackageError(TOO_BIG);
    }
    if (single) {
      window = content;
    }
  }
  if (window > ZSTD_MAX_WINDOW) {
    throw new PackageError('it uses a larger Zstandard window than MarkCopy will allocate.');
  }
}

export function unzstdBounded(data: Uint8Array, max: number): Uint8Array {
  if (data.length === 0) {
    throw new PackageError(DAMAGED);
  }
  const sink = new ByteSink();
  checkZstdHeader(data, max);
  let total = 0;
  try {
    const decoder = new ZstdDecompress((chunk) => {
      total += chunk.length;
      if (total > max) {
        throw new PackageError(TOO_BIG);
      }
      sink.append(chunk);
    });
    for (let i = 0; i < data.length; i += ZSTD_SLICE) {
      const end = Math.min(i + ZSTD_SLICE, data.length);
      decoder.push(data.subarray(i, end), end === data.length);
    }
  } catch (error) {
    contain(error);
  }
  return sink.bytes();
}

export async function unxzBounded(data: Uint8Array, max: number): Promise<Uint8Array> {
  let offset = 0;
  let exhausted = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        exhausted = true;
        controller.close();
        return;
      }
      controller.enqueue(data.subarray(offset, offset + XZ_SLICE));
      offset += XZ_SLICE;
    },
  });
  const sink = new ByteSink();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = new XzReadableStream(source).getReader();
    let idle = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (sink.length + value.length > max) {
        throw new PackageError(TOO_BIG);
      }
      sink.append(value);
      idle = value.length === 0 && exhausted ? idle + 1 : 0;
      if (idle > XZ_MAX_IDLE_PULLS) {
        throw new PackageError(DAMAGED);
      }
    }
  } catch (error) {
    // Cancelling releases the decoder, which holds a lock shared by every xz stream.
    await reader?.cancel().catch(() => undefined);
    contain(error);
  }
  return sink.bytes();
}
