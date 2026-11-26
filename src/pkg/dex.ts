// A summary of the DEX files (classes.dex, classes2.dex, ...) in an Android package.
//
// Only the 0x70-byte header of each file is read, plus, for the first file, the
// whole entry when it is small enough to recompute the two digests the header stores.
import { createHash } from 'node:crypto';
import { formatNumber } from '../binary/html';
import { PackageError, propertySection, type InfoSection } from './model';
import type { ZipArchive, ZipEntry } from './zipRange';

export const DEX_HEADER_BYTES = 0x70;
/** DEX files whose headers are read; a real app has a few dozen at most. */
export const MAX_DEX_FILES = 64;
/** The largest first DEX file that is inflated to recompute its stored digests. */
export const MAX_DEX_DIGEST_BYTES = 32 * 1024 * 1024;
/** The per-file limit on method references that a 16-bit method index allows. */
const METHOD_LIMIT = 65536;
const ENDIAN_TAG = 0x12345678;

export interface DexHeader {
  version: string;
  checksum: number;
  signature: Uint8Array;
  fileSize: number;
  headerSize: number;
  endianTag: number;
  strings: number;
  types: number;
  protos: number;
  fields: number;
  methods: number;
  classes: number;
}

/** The header's fields, or undefined when the bytes do not start like a DEX file. */
export function parseDexHeader(bytes: Uint8Array): DexHeader | undefined {
  if (bytes.length < DEX_HEADER_BYTES) {
    return undefined;
  }
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (!/^dex\n[0-9]{3}\0$/.test(magic)) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: magic.slice(4, 7),
    checksum: view.getUint32(0x08, true),
    signature: bytes.slice(0x0c, 0x20),
    fileSize: view.getUint32(0x20, true),
    headerSize: view.getUint32(0x24, true),
    endianTag: view.getUint32(0x28, true),
    strings: view.getUint32(0x38, true),
    types: view.getUint32(0x40, true),
    protos: view.getUint32(0x48, true),
    fields: view.getUint32(0x50, true),
    methods: view.getUint32(0x58, true),
    classes: view.getUint32(0x60, true),
  };
}

/** Adler-32 (RFC 1950) of the bytes. */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  // 5552 is the most bytes that can be added before the sums must be reduced.
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Number in "classes.dex" is 1, in "classes2.dex" is 2. */
const dexIndex = (name: string): number => Number(/^classes(\d*)\.dex$/.exec(name)?.[1] || 1);

/** What the DEX files hold, as a section, with a warning for each damaged or inconsistent header. */
export async function dexSections(
  zip: ZipArchive,
  entries: ZipEntry[],
  warnings: string[],
): Promise<InfoSection[]> {
  const files = [...entries].sort((a, b) => dexIndex(a.name) - dexIndex(b.name));
  if (files.length > MAX_DEX_FILES) {
    warnings.push(
      `The package holds ${formatNumber(files.length)} DEX files; only the first ${MAX_DEX_FILES} were read.`,
    );
    files.length = MAX_DEX_FILES;
  }
  const versions = new Set<string>();
  let read = 0;
  let classes = 0;
  let methods = 0;
  let strings = 0;
  let atLimit = 0;
  let first: { entry: ZipEntry; header: DexHeader } | undefined;
  for (const entry of files) {
    let header: DexHeader | undefined;
    try {
      header = parseDexHeader(await zip.readEntryHead(entry, DEX_HEADER_BYTES));
    } catch (error) {
      if (!(error instanceof PackageError)) {
        throw error;
      }
    }
    if (!header) {
      warnings.push(`${entry.name} does not start with a DEX header MarkCopy can read.`);
      continue;
    }
    if (header.endianTag !== ENDIAN_TAG) {
      warnings.push(
        `${entry.name} has endian tag 0x${header.endianTag.toString(16).padStart(8, '0')} rather than 0x12345678, so its counts were not used.`,
      );
      continue;
    }
    if (header.fileSize !== entry.uncompressedSize) {
      warnings.push(
        `${entry.name} states a file size of ${formatNumber(header.fileSize)} bytes, but the entry holds ${formatNumber(entry.uncompressedSize)}.`,
      );
    }
    if (header.headerSize !== DEX_HEADER_BYTES) {
      warnings.push(`${entry.name} states a header size of ${header.headerSize} rather than 112.`);
    }
    read++;
    versions.add(header.version);
    classes += header.classes;
    methods += header.methods;
    strings += header.strings;
    if (header.methods >= METHOD_LIMIT) {
      atLimit++;
    }
    first ??= { entry, header };
  }
  if (read === 0) {
    return [];
  }
  const rows: [string, string | undefined][] = [
    ['DEX files', `${formatNumber(read)}${read > 1 ? ' (multidex)' : ''}`],
    ['DEX format version', [...versions].sort().join(', ')],
    ['Classes defined', formatNumber(classes)],
    ['Method references', formatNumber(methods)],
    ['Strings', formatNumber(strings)],
  ];
  const note =
    atLimit > 0
      ? `${formatNumber(atLimit)} of the DEX files list ${formatNumber(METHOD_LIMIT)} or more method references, the most a 16-bit method index addresses in one file.`
      : undefined;
  const out = propertySection('DEX files', rows, note);
  if (first && out[0]) {
    out[0].rows.push(...(await digestRows(zip, first.entry, first.header, warnings)));
  }
  return out;
}

async function digestRows(
  zip: ZipArchive,
  entry: ZipEntry,
  header: DexHeader,
  warnings: string[],
): Promise<[string, string][]> {
  const skipped = (why: string): [string, string][] => [
    [`${entry.name} checksum`, `Not checked: ${why}.`],
    [`${entry.name} signature`, `Not checked: ${why}.`],
  ];
  if (entry.encrypted) {
    return skipped('the entry is encrypted');
  }
  if (entry.uncompressedSize > MAX_DEX_DIGEST_BYTES) {
    return skipped(
      `the file is larger than the ${formatNumber(MAX_DEX_DIGEST_BYTES / (1024 * 1024))} MiB MarkCopy reads for this`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await zip.readEntry(entry, MAX_DEX_DIGEST_BYTES);
  } catch (error) {
    if (!(error instanceof PackageError)) {
      throw error;
    }
    warnings.push(`${entry.name} could not be read in full.`);
    return skipped('the file could not be read in full');
  }
  if (bytes.length !== header.fileSize) {
    return skipped(
      `the file holds ${formatNumber(bytes.length)} bytes but its header states ${formatNumber(header.fileSize)}`,
    );
  }
  const checksum = adler32(bytes.subarray(12));
  const signature = createHash('sha1').update(bytes.subarray(32)).digest();
  return [
    [
      `${entry.name} checksum`,
      checksum === header.checksum
        ? 'The computed Adler-32 matches the stored checksum.'
        : 'The computed Adler-32 differs from the stored checksum.',
    ],
    [
      `${entry.name} signature`,
      hex(signature) === hex(header.signature)
        ? 'The computed SHA-1 matches the stored digest.'
        : 'The computed SHA-1 differs from the stored digest.',
    ],
  ];
}
