// Unpacking the OPC (zip) container an Office document arrives in.
//
// Check the archive's directory and size limits before extracting any parts.
// Validate what the stream actually produces while inflating each part. Entries
// are put in a map in memory, so their paths are never used for file access.
import { Inflate, strFromU8 } from 'fflate';

/** Caps chosen to refuse the pathological cases without bothering real files. */
export interface ZipLimits {
  /** Refuse the whole file above this, before unzipping. */
  maxFileBytes: number;
  /** Refuse above this many entries. */
  maxEntries: number;
  /** Refuse any single part larger than this once inflated. */
  maxEntryBytes: number;
  /** Refuse once everything inflated so far exceeds this. */
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: ZipLimits = {
  // Decks and documents full of photographs run to tens of megabytes without
  // being unusual, so the file cap matches maxTotalBytes: a package whose parts
  // all fit the inflate budget is one worth reading, whatever it weighs on disk.
  maxFileBytes: 256 * 1024 * 1024,
  // Real workbooks run to a few dozen parts, plus one per sheet, drawing, and
  // image. A thousand is far past anything legitimate.
  maxEntries: 1000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

// The most deflate can expand by is 1032 to 1 (a run of one byte, coded at
// the format's longest match). The ratio is rounded up and given some slack so
// that a tiny, legitimately compressible part is never caught by it.
const MAX_DEFLATE_RATIO = 1100;
const DEFLATE_SLACK = 4096;
// Each push can expand about a thousandfold. Small pushes limit transient
// output before the callback can check the part's remaining budget.
const INFLATE_STEP = 8 * 1024;
// A DEFLATE stored block can buffer 65,535 bytes before yielding output. Allow
// that, but bound growth if a stream stops producing data and has trailing bytes.
const MAX_INFLATE_GAP = 128 * 1024;

const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const ZIP64_SENTINEL = 0xffffffff;

interface Entry {
  name: string;
  method: number;
  size: number;
  offset: number;
  start: number;
  end: number;
}

/**
 * A package we will not or cannot read, with a message written to be shown.
 *
 * One class for every format on purpose: each feature re-exports it under the
 * noun its own callers use (`WorkbookError`, `DeckError`), so an `instanceof`
 * check at the top of a preview keeps reading the way it always did. The cost
 * is that the two names are the same class, which nothing needs to tell apart.
 */
export class OpcError extends Error {}

export interface OpenOptions {
  limits?: ZipLimits;
  /** How the refusal messages name the document: `workbook`, `presentation`. */
  noun?: string;
  /** Message for a file that is not a zip at all, naming the legacy format. */
  notZip?: string;
}

/** The parts of a package, keyed by their zip path (`xl/workbook.xml`). */
export type Parts = Map<string, Uint8Array>;

export function openZip(bytes: Uint8Array, options: OpenOptions = {}): Parts {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const noun = options.noun ?? 'file';
  if (bytes.length > limits.maxFileBytes) {
    throw new OpcError(
      `this ${noun} is ${mb(bytes.length)} MB, larger than the ${mb(limits.maxFileBytes)} MB preview limit.`,
    );
  }
  // Not a zip at all: the pre-2007 OLE2 formats (.xls, .ppt), a binary variant
  // (.xlsb), or something misnamed. Say so, rather than letting the inflate fail
  // with something unreadable.
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new OpcError(options.notZip ?? `this file is not an Office ${noun}.`);
  }

  try {
    const parts: Parts = new Map();
    for (const entry of readEntries(bytes, limits, noun)) {
      const compressed = bytes.subarray(entry.start, entry.end);
      const data = entry.method === 0 ? new Uint8Array(compressed) : inflatePart(entry, compressed);
      // Zip paths are '/'-separated by spec, but writers in the wild emit '\'.
      parts.set(normalizePath(entry.name), data);
    }
    return parts;
  } catch (err) {
    // A limit refusal is the answer, not an unpacking failure to be reworded.
    if (err instanceof OpcError) {
      throw err;
    }
    throw new OpcError(`this ${noun} could not be unpacked (${String(err)}).`);
  }
}

function zip64Number(view: DataView, offset: number): number {
  const value = Number(view.getBigUint64(offset, true));
  if (!Number.isSafeInteger(value)) {
    throw new Error('invalid ZIP64 value');
  }
  return value;
}

function locateDirectory(view: DataView): { offset: number; end: number; count: number } {
  const length = view.byteLength;
  const first = Math.max(0, length - EOCD_SIZE - 0xffff);
  let at = length - EOCD_SIZE;
  for (; at >= first; at--) {
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + EOCD_SIZE + view.getUint16(at + 20, true) <= length
    ) {
      break;
    }
  }
  if (at < first) {
    throw new Error('missing zip directory end record');
  }
  const disk = view.getUint16(at + 4, true);
  const directoryDisk = view.getUint16(at + 6, true);
  let count = view.getUint16(at + 10, true);
  let onDisk = view.getUint16(at + 8, true);
  let size = view.getUint32(at + 12, true);
  let offset = view.getUint32(at + 16, true);
  if (
    disk === 0xffff ||
    directoryDisk === 0xffff ||
    count === 0xffff ||
    onDisk === 0xffff ||
    size === ZIP64_SENTINEL ||
    offset === ZIP64_SENTINEL
  ) {
    const locator = at - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) {
      throw new Error('missing ZIP64 locator');
    }
    const record = zip64Number(view, locator + 8);
    if (record > locator - 56 || view.getUint32(record, true) !== 0x06064b50) {
      throw new Error('invalid ZIP64 directory end record');
    }
    if (view.getUint32(record + 16, true) !== 0 || view.getUint32(record + 20, true) !== 0) {
      throw new Error('split zip archives are unsupported');
    }
    onDisk = zip64Number(view, record + 24);
    count = zip64Number(view, record + 32);
    size = zip64Number(view, record + 40);
    offset = zip64Number(view, record + 48);
    at = record;
  } else if (disk !== 0 || directoryDisk !== 0) {
    throw new Error('split zip archives are unsupported');
  }
  if (onDisk !== count || offset > at || size > at - offset) {
    throw new Error('invalid zip directory bounds');
  }
  return { offset, end: offset + size, count };
}

/** ZIP64 replaces only the saturated fields, in size, compressed size, offset order. */
function zip64EntryFields(view: DataView, at: number, end: number, fields: number[]): number[] {
  const required = fields.filter((field) => field === ZIP64_SENTINEL).length * 8;
  for (; at + 4 <= end;) {
    const id = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    at += 4;
    if (at + length > end) {
      break;
    }
    if (id === 1 && length >= required) {
      return fields.map((field) => {
        if (field !== ZIP64_SENTINEL) {
          return field;
        }
        const value = zip64Number(view, at);
        at += 8;
        return value;
      });
    }
    at += length;
  }
  throw new Error('invalid ZIP64 entry fields');
}

function readEntries(bytes: Uint8Array, limits: ZipLimits, noun: string): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = locateDirectory(view);
  if (directory.count > limits.maxEntries) {
    throw new OpcError(
      `this ${noun} has more than ${limits.maxEntries} parts, more than the preview reads.`,
    );
  }
  const entries: Entry[] = [];
  let at = directory.offset;
  let declared = 0;
  for (let index = 0; index < directory.count; index++) {
    if (at + CENTRAL_SIZE > directory.end || view.getUint32(at, true) !== 0x02014b50) {
      throw new Error('invalid zip directory entry');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const nameStart = at + CENTRAL_SIZE;
    const extraStart = nameStart + view.getUint16(at + 28, true);
    const extraEnd = extraStart + view.getUint16(at + 30, true);
    const next = extraEnd + view.getUint16(at + 32, true);
    if (next > directory.end) {
      throw new Error('truncated zip directory entry');
    }
    const name = strFromU8(bytes.subarray(nameStart, extraStart), (flags & 0x800) === 0);
    let [size, compressed, offset] = [
      view.getUint32(at + 24, true),
      view.getUint32(at + 20, true),
      view.getUint32(at + 42, true),
    ];
    if (size === ZIP64_SENTINEL || compressed === ZIP64_SENTINEL || offset === ZIP64_SENTINEL) {
      [size, compressed, offset] = zip64EntryFields(view, extraStart, extraEnd, [
        size,
        compressed,
        offset,
      ]);
    }
    if (size > limits.maxEntryBytes) {
      throw new OpcError(`part "${name}" is too large to preview.`);
    }
    if (size > Math.min(compressed, bytes.length) * MAX_DEFLATE_RATIO + DEFLATE_SLACK) {
      throw new OpcError(`part "${name}" claims more data than it can hold.`);
    }
    declared += size;
    if (declared > limits.maxTotalBytes) {
      throw new OpcError(`this ${noun} expands to more data than the preview can hold.`);
    }
    if (method !== 0 && method !== 8) {
      throw new OpcError(`part "${name}" uses an unsupported compression method.`);
    }
    if (offset + LOCAL_SIZE > directory.offset || view.getUint32(offset, true) !== 0x04034b50) {
      throw new OpcError(`part "${name}" has an invalid local header.`);
    }
    if ((flags | view.getUint16(offset + 6, true)) & 1) {
      throw new OpcError(`part "${name}" is encrypted.`);
    }
    if (method !== view.getUint16(offset + 8, true)) {
      throw new OpcError(`part "${name}" has inconsistent compression methods.`);
    }
    const start =
      offset + LOCAL_SIZE + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (start > directory.offset || compressed > directory.offset - start) {
      throw new OpcError(`part "${name}" has invalid data bounds.`);
    }
    if (method === 0 && compressed !== size) {
      throw new OpcError(`part "${name}" has an inconsistent stored size.`);
    }
    entries.push({ name, method, size, offset, start, end: start + compressed });
    at = next;
  }
  // A compressed byte can be processed at most once across all parts. Keep the
  // original directory order for callers, even when local records are reordered.
  let end = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset < end) {
      throw new OpcError(`part "${entry.name}" overlaps another part.`);
    }
    end = entry.end;
  }
  return entries;
}

function inflatePart(entry: Entry, compressed: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let produced = 0;
  let lastOutput = 0;
  const sizeError = () => new OpcError(`part "${entry.name}" does not match its declared size.`);
  const inflate = new Inflate((chunk) => {
    // The declared individual and combined sizes already fit the limits. Stop
    // as soon as a stream exceeds its own validated share of that budget.
    produced += chunk.length;
    if (produced > entry.size) {
      throw sizeError();
    }
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  });
  for (let start = 0; start < compressed.length; start += INFLATE_STEP) {
    const end = Math.min(start + INFLATE_STEP, compressed.length);
    const before = produced;
    inflate.push(compressed.subarray(start, end), end === compressed.length);
    if (produced > before) {
      lastOutput = end;
    } else if (end - lastOutput > MAX_INFLATE_GAP) {
      throw new OpcError(`part "${entry.name}" has too much compressed data without output.`);
    }
  }
  if (compressed.length === 0 || produced !== entry.size) {
    throw sizeError();
  }
  if (chunks.length === 1) {
    return chunks[0];
  }
  const data = new Uint8Array(produced);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return data;
}

/**
 * A part's text, or undefined when it is absent.
 *
 * Absent is normal and not an error: sharedStrings.xml only exists when the
 * workbook uses shared strings, styles.xml only when it has any.
 */
export function partText(parts: Parts, path: string): string | undefined {
  const data = parts.get(normalizePath(path));
  return data === undefined ? undefined : stripBom(strFromU8(data));
}

/** Normalize a zip entry path for lookup: forward slashes, no leading slash. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Resolve a relationship target against the part that declared it.
 *
 * Targets are usually relative to the declaring part's folder (`worksheets/sheet1.xml`
 * from `xl/_rels/workbook.xml.rels` means `xl/worksheets/sheet1.xml`), but may be
 * absolute (`/xl/worksheets/sheet1.xml`), and may contain `..`.
 */
export function resolveTarget(basePart: string, target: string): string {
  const clean = normalizePath(target);
  if (target.startsWith('/')) {
    return clean;
  }
  const baseDir = normalizePath(basePart).replace(/\/[^/]*$/, '');
  const segments = (baseDir ? baseDir.split('/') : []).concat(clean.split('/'));
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join('/');
}

/**
 * The part a `.rels` file describes.
 *
 * Relationship targets are relative to that part, not to the `_rels` folder the
 * relationships live in, so resolving them against the `.rels` path itself lands
 * one directory too deep: `xl/_rels/workbook.xml.rels` plus `worksheets/sheet1.xml`
 * is `xl/worksheets/sheet1.xml`, never `xl/_rels/worksheets/sheet1.xml`.
 *
 *   xl/_rels/workbook.xml.rels -> xl/workbook.xml
 *   _rels/.rels                -> '' (the package root)
 */
export function partForRels(relsPath: string): string {
  return normalizePath(relsPath).replace(/_rels\/([^/]*)\.rels$/, '$1');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
