// A tar reader for metadata archives held in memory: ustar headers, GNU long
// names (type L) and pax path records (type x). Only headers are interpreted;
// an entry's bytes are just a range of the buffer, so nothing is extracted.
//
// `readTar` can be pointed at a buffer that is still growing: Alpine's control
// archive is read while it is being inflated, and `stop: 'more'` says the
// buffer ended before the next header or before a name record was complete.

const BLOCK = 512;

// Control archives hold a handful of files and a signature archive one. The cap
// stops a hostile archive of empty headers from being walked block by block.
export const TAR_MAX_ENTRIES = 2000;

// A long-name or pax record bigger than this is not a path.
const MAX_META = 64 * 1024;

export interface TarEntry {
  /** The path as stored, with any leading "./" removed. */
  name: string;
  size: number;
  /** The typeflag character: "0" or "" for a file, "5" for a directory. */
  type: string;
  /** Where the entry's data starts in the buffer. */
  offset: number;
  /** True when the whole of the entry's data is inside the buffer. */
  complete: boolean;
}

export interface TarResult {
  entries: TarEntry[];
  /** Where the next header would start. May lie past the buffer's end. */
  next: number;
  /** Why the walk stopped. */
  stop: 'end' | 'more' | 'cap' | 'invalid';
}

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** An octal field, or a GNU base-256 number for sizes past 8 GiB. NaN when it is neither. */
function number(field: Uint8Array): number {
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) {
      value = value * 256 + field[i];
      if (value > Number.MAX_SAFE_INTEGER) {
        return NaN;
      }
    }
    return value;
  }
  const digits = text(field).trim();
  return /^[0-7]+$/.test(digits) ? parseInt(digits, 8) : digits === '' ? 0 : NaN;
}

function checksumValid(header: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum === number(header.subarray(148, 156));
}

/** The `path` record of a pax extended header ("<length> path=<value>\n" records). */
function paxPath(data: Uint8Array): string | undefined {
  let at = 0;
  // Every record advances `at` by its own length, which is checked to be at least 2.
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) {
      return undefined;
    }
    const length = Number(text(data.subarray(at, space)));
    if (!Number.isInteger(length) || length < space - at + 2 || at + length > data.length) {
      return undefined;
    }
    const record = new TextDecoder().decode(data.subarray(space + 1, at + length - 1));
    if (record.startsWith('path=')) {
      return record.slice(5);
    }
    at += length;
  }
  return undefined;
}

function clean(name: string): string {
  return name.replace(/^(\.\/)+/, '');
}

/**
 * The entries whose headers lie in `buffer` from `start`. `stop` says why it
 * ended: the end-of-archive block or a non-header ('end' / 'invalid'), bytes
 * not yet available ('more'), or the entry cap.
 */
export function readTar(buffer: Uint8Array, start = 0): TarResult {
  const entries: TarEntry[] = [];
  let at = start;
  let longName: string | undefined;
  for (;;) {
    if (entries.length >= TAR_MAX_ENTRIES) {
      return { entries, next: at, stop: 'cap' };
    }
    if (at + BLOCK > buffer.length) {
      return { entries, next: at, stop: 'more' };
    }
    const header = buffer.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) {
      return { entries, next: at, stop: 'end' };
    }
    const size = number(header.subarray(124, 136));
    if (!checksumValid(header) || !Number.isSafeInteger(size) || size < 0) {
      return { entries, next: at, stop: 'invalid' };
    }
    const type = String.fromCharCode(header[156]);
    const dataAt = at + BLOCK;
    const after = dataAt + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L' || type === 'x' || type === 'g' || type === 'K') {
      if (size > MAX_META) {
        return { entries, next: at, stop: 'invalid' };
      }
      if (dataAt + size > buffer.length) {
        return { entries, next: at, stop: 'more' };
      }
      const data = buffer.subarray(dataAt, dataAt + size);
      if (type === 'L') {
        longName = text(data);
      } else if (type === 'x') {
        longName = paxPath(data) ?? longName;
      }
      at = after;
      continue;
    }

    let name = longName;
    longName = undefined;
    if (name === undefined) {
      name = text(header.subarray(0, 100));
      // ustar splits a long path into a 155-byte prefix and the name.
      if (text(header.subarray(257, 262)) === 'ustar') {
        const prefix = text(header.subarray(345, 500));
        if (prefix) {
          name = `${prefix}/${name}`;
        }
      }
    }
    entries.push({
      name: clean(name),
      size,
      type: type === '\0' ? '0' : type,
      offset: dataAt,
      complete: dataAt + size <= buffer.length,
    });
    at = after;
  }
}

/** The bytes of an entry, or undefined when they are not all in the buffer. */
export function tarData(buffer: Uint8Array, entry: TarEntry): Uint8Array | undefined {
  return entry.complete ? buffer.subarray(entry.offset, entry.offset + entry.size) : undefined;
}
