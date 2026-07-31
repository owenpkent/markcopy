// Unpacking the OPC (zip) container a workbook arrives in.
//
// An .xlsx is a zip of XML parts. That makes the file a hostile-input surface
// before a single tag is parsed: a few hundred kilobytes on disk can inflate to
// gigabytes in memory, and the caller's only defence is to refuse early. Every
// limit here is therefore checked against the *declared* uncompressed size, and
// against the running total, rather than after the fact.
//
// Nothing is ever written to disk. fflate inflates into memory, so a malicious
// entry name (`../../etc/passwd`, an absolute path, a symlink) has nothing to act
// on: names are only ever used as map keys.
import { unzipSync, strFromU8 } from 'fflate';

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
  // A 25 MB workbook is already an unusual thing to preview, and the inflated XML
  // behind it is several times larger again.
  maxFileBytes: 25 * 1024 * 1024,
  // Real workbooks run to a few dozen parts, plus one per sheet, drawing, and
  // image. A thousand is far past anything legitimate.
  maxEntries: 1000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

export class WorkbookError extends Error {}

/** The parts of a workbook, keyed by their zip path (`xl/workbook.xml`). */
export type Parts = Map<string, Uint8Array>;

export function openZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_LIMITS): Parts {
  if (bytes.length > limits.maxFileBytes) {
    throw new WorkbookError(
      `this workbook is ${mb(bytes.length)} MB, larger than the ${mb(limits.maxFileBytes)} MB preview limit.`,
    );
  }
  // Not a zip at all: .xls (BIFF/OLE2), .xlsb, or something misnamed. Say so,
  // rather than letting the inflate fail with something unreadable.
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new WorkbookError(
      'this file is not an .xlsx workbook (the older .xls format is not supported).',
    );
  }

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch (err) {
    throw new WorkbookError(`this workbook could not be unpacked (${String(err)}).`);
  }

  const names = Object.keys(raw);
  if (names.length > limits.maxEntries) {
    throw new WorkbookError(
      `this workbook has ${names.length} parts, more than the preview reads.`,
    );
  }

  const parts: Parts = new Map();
  let total = 0;
  for (const name of names) {
    const data = raw[name];
    if (data.length > limits.maxEntryBytes) {
      throw new WorkbookError(`part "${name}" is too large to preview.`);
    }
    total += data.length;
    if (total > limits.maxTotalBytes) {
      throw new WorkbookError('this workbook expands to more data than the preview can hold.');
    }
    // Zip paths are '/'-separated by spec, but writers in the wild emit '\'.
    parts.set(normalizePath(name), data);
  }
  return parts;
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
