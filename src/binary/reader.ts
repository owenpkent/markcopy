// Reading a binary file in ranges, for the previews that describe a file
// without loading it: executables (src/pe) and packages (src/pkg).
//
// A 2 GB installer has a few hundred kilobytes of headers and tables worth
// reading. A ByteSource gives random access to the file, and a RangeReader on
// top of it caches 64 KiB pages, checks every offset against the file's real
// size, and stops when a budget of distinct pages is spent. A file built to
// send the reader all over itself therefore runs out of budget instead of out
// of memory, and a truncated one produces a message instead of a RangeError.
//
// No `vscode` import: everything built on this is pure, unit-tested and fuzzed.
import { printable } from './text';

/**
 * A file we will not or cannot describe, with a message written to be shown.
 *
 * One class for every format on purpose, as OpcError is for the Office
 * formats: each reader re-exports it under its own noun (`PeError`,
 * `PackageError`), so an `instanceof` check at the top of a preview reads the
 * way its feature does while a failure inside this shared reader still counts.
 */
export class ReadError extends Error {}

/** Random access to the file. `read` may return fewer bytes only at the end of the file. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A ByteSource over bytes already in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

const PAGE = 0x10000;
const SCAN_CHUNK = 1024 * 1024;

export interface ReaderLimits {
  /** Distinct 64 KiB pages that may be read before the reader refuses to go on. */
  maxPages: number;
  /** The largest single read. */
  maxRead: number;
}

// 16 MiB of distinct pages. A real file's metadata needs well under one.
export const DEFAULT_READER_LIMITS: ReaderLimits = {
  maxPages: 256,
  maxRead: 4 * 1024 * 1024,
};

export const TRUNCATED = 'the file ends before the data its headers point to.';

export class RangeReader {
  private readonly pages = new Map<number, Uint8Array>();
  private readonly limits: ReaderLimits;

  constructor(
    private readonly source: ByteSource,
    limits: Partial<ReaderLimits> = {},
  ) {
    this.limits = { ...DEFAULT_READER_LIMITS, ...limits };
  }

  get size(): number {
    return this.source.size;
  }

  private async page(index: number): Promise<Uint8Array> {
    let page = this.pages.get(index);
    if (!page) {
      if (this.pages.size >= this.limits.maxPages) {
        throw new ReadError('its tables point to more of the file than MarkCopy will read.');
      }
      const start = index * PAGE;
      page = await this.source.read(start, Math.min(PAGE, this.size - start));
      this.pages.set(index, page);
    }
    return page;
  }

  /** Exactly `length` bytes at `offset`, or a ReadError when the file does not hold them. */
  async bytes(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > this.limits.maxRead ||
      offset + length > this.size
    ) {
      throw new ReadError(TRUNCATED);
    }
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const pos = offset + done;
      const index = Math.floor(pos / PAGE);
      const page = await this.page(index);
      const within = pos - index * PAGE;
      const take = Math.min(length - done, page.length - within);
      if (take <= 0) {
        // The source returned less than the size it reported.
        throw new ReadError(TRUNCATED);
      }
      out.set(page.subarray(within, within + take), done);
      done += take;
    }
    return out;
  }

  /**
   * Hand `length` bytes at `offset` to `onChunk` a megabyte at a time, for work that
   * must see a whole range (a hash) rather than keep it. It reads past the page cache
   * and its budget, so a large range costs time and not memory; a range the file does
   * not hold is a ReadError before the first byte is read.
   */
  async scan(offset: number, length: number, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    ) {
      throw new ReadError(TRUNCATED);
    }
    for (let done = 0; done < length; done += SCAN_CHUNK) {
      const want = Math.min(SCAN_CHUNK, length - done);
      const chunk = await this.source.read(offset + done, want);
      if (chunk.length !== want) {
        throw new ReadError(TRUNCATED);
      }
      onChunk(chunk);
    }
  }

  async view(offset: number, length: number): Promise<DataView> {
    const bytes = await this.bytes(offset, length);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** As much as exists of `length` bytes at `offset`: for data whose end the file may cut short. */
  async upTo(offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.size) {
      throw new ReadError(TRUNCATED);
    }
    return this.bytes(offset, Math.max(0, Math.min(length, this.size - offset)));
  }

  /** A NUL-terminated string, decoded as UTF-8 (a superset of the ASCII most formats specify). */
  async cstr(offset: number, max = 512): Promise<string> {
    const bytes = await this.upTo(offset, max);
    const end = bytes.indexOf(0);
    return printable(new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)));
  }
}
