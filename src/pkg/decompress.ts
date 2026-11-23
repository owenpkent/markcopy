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
export const TOO_MANY = 'it holds more compressed streams than MarkCopy will read.';

// Input is fed in small slices so one slice cannot expand into more than a few
// megabytes (deflate cannot beat about 1000:1) before the cap is checked again.
const GZIP_SLICE = 4 * 1024;
// Zstandard emits one callback per block of at most 128 KiB, and the cap is
// checked in each, so a bigger slice is safe.
const ZSTD_SLICE = 16 * 1024;
const XZ_SLICE = 16 * 1024;

// fzstd allocates the frame's window (or, for a single-segment frame, its declared
// content size) plus 12 bytes, and then moves the whole window on every block. A
// frame header may ask for gigabytes. Control archives are tiny and the encoder
// sizes the window to the content, so 16 MiB matches the largest control archive MarkCopy unpacks.
const ZSTD_MAX_WINDOW = 16 * 1024 * 1024;
// Frames a control archive may hold: one, in practice.
const ZSTD_MAX_FRAMES = 16;
// Blocks times window is the bytes fzstd shifts in total; this keeps that under 4 GiB.
const ZSTD_MAX_SHIFT = 4 * 1024 * 1024 * 1024;
const ZSTD_MAX_BLOCK = 128 * 1024;
// A deflate member is 20 bytes at the least, so a few hundred thousand empty ones fit
// in a few megabytes and cost time for no output. Real files have one to three.
const GZIP_MAX_MEMBERS = 64;

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
  let members = 1;
  gunzip.onmember = () => {
    if (++members > GZIP_MAX_MEMBERS) {
      throw new PackageError(TOO_MANY);
    }
  };
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

interface ZstdFrame {
  start: number;
  end: number;
}

/**
 * Walk every frame of the input, reading only headers, and return the data
 * frames. A check on the first frame is not a check: fzstd sizes its window from
 * each frame's own header, so each one is validated here before any reaches it.
 * Skippable frames are dropped. Throws when a frame asks for more than allowed.
 */
function zstdFrames(data: Uint8Array, max: number): ZstdFrame[] {
  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const frames: ZstdFrame[] = [];
  let pos = 0;
  let declared = 0;
  let shifted = 0;
  let seen = 0;
  while (pos < data.length) {
    if (++seen > ZSTD_MAX_FRAMES || pos + 4 > data.length) {
      throw new PackageError(seen > ZSTD_MAX_FRAMES ? TOO_MANY : DAMAGED);
    }
    const magic = view.getUint32(pos, true);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (pos + 8 > data.length) {
        throw new PackageError(DAMAGED);
      }
      pos += 8 + view.getUint32(pos + 4, true);
      continue;
    }
    if (magic !== 0xfd2fb528 || pos + 6 > data.length) {
      throw new PackageError(DAMAGED);
    }
    const start = pos;
    const descriptor = data[pos + 4];
    const single = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const sizeFlag = descriptor >> 6;
    // Bit 3 is reserved and a dictionary needs one we do not have.
    if ((descriptor & 0x08) !== 0 || (descriptor & 3) !== 0) {
      throw new PackageError(DAMAGED);
    }
    let at = pos + 5;
    let window = 0;
    if (!single) {
      const byte = data[at++];
      const base = 2 ** (10 + (byte >> 3));
      window = base + (base / 8) * (byte & 7);
    }
    const contentBytes = sizeFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][sizeFlag];
    if (at + contentBytes > data.length) {
      throw new PackageError(DAMAGED);
    }
    let content: number | undefined;
    if (contentBytes > 0) {
      content = 0;
      for (let i = contentBytes - 1; i >= 0; i--) {
        content = content * 256 + data[at + i];
      }
      if (sizeFlag === 1) {
        content += 256;
      }
      declared += content;
      if (content > max || declared > max) {
        throw new PackageError(TOO_BIG);
      }
      if (single) {
        window = content;
      }
    }
    at += contentBytes;
    if (window > ZSTD_MAX_WINDOW) {
      throw new PackageError('it uses a larger Zstandard window than MarkCopy will allocate.');
    }
    // Blocks: a 3-byte header (last flag, type, size), then the block's bytes.
    for (let last = false; !last;) {
      if (at + 3 > data.length) {
        // The frame is cut short; the decoder will say so. Nothing after it is read.
        at = data.length;
        break;
      }
      const header = data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
      last = (header & 1) !== 0;
      const type = (header >> 1) & 3;
      const size = header >> 3;
      if (type === 3 || size > ZSTD_MAX_BLOCK) {
        throw new PackageError(DAMAGED);
      }
      shifted += Math.max(window, 1);
      if (shifted > ZSTD_MAX_SHIFT) {
        throw new PackageError(TOO_BIG);
      }
      at += 3 + (type === 1 ? 1 : size);
    }
    if (checksum) {
      at += 4;
    }
    pos = Math.min(at, data.length);
    frames.push({ start, end: pos });
  }
  return frames;
}

export function unzstdBounded(data: Uint8Array, max: number): Uint8Array {
  if (data.length === 0) {
    throw new PackageError(DAMAGED);
  }
  const frames = zstdFrames(data, max);
  if (frames.length === 0) {
    throw new PackageError(DAMAGED);
  }
  const sink = new ByteSink();
  let total = 0;
  try {
    // One decoder per validated frame, so its window is the one that was checked.
    for (const frame of frames) {
      const decoder = new ZstdDecompress((chunk) => {
        total += chunk.length;
        if (total > max) {
          throw new PackageError(TOO_BIG);
        }
        sink.append(chunk);
      });
      for (let i = frame.start; i < frame.end; i += ZSTD_SLICE) {
        const end = Math.min(i + ZSTD_SLICE, frame.end);
        decoder.push(data.subarray(i, end), end === frame.end);
      }
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
