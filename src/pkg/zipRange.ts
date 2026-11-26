// A zip reader over ranges of the file.
//
// src/ooxml/zip.ts inflates a whole archive into memory, which is right for a
// 2 MB workbook and wrong for a 300 MB .jar or .apk. This one reads the end of
// the file to find the central directory, lists it, and inflates only the few
// entries a package page wants (a manifest, a metadata file), each one bounded
// by the caller's cap on what it will accept.
//
// Nothing is extracted to disk and no entry name is ever used as a path: names
// are only displayed, after printable() has stripped what could disguise them.
import type { RangeReader } from '../binary/reader';
import { printable } from '../binary/text';
import { asciiLower } from './ascii';
import { Inflate } from 'fflate';
import { PackageError, type InfoSection, type PropertySection } from './model';
import { isSignedData, readSigner, signatureSection, signerCount, type Signer } from './signature';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const EOCD_SIZE = 22;
// The comment after the EOCD record is at most 65,535 bytes, so the record
// starts within this many bytes of the end of a well-formed archive.
const EOCD_SEARCH = 0xffff + EOCD_SIZE;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;
const SIGNING_MAGIC = 'APK Sig Block 42';

// A large Android app lists tens of thousands of entries; 100,000 is well past
// that and still only a few megabytes of directory.
export const MAX_ZIP_ENTRIES = 100_000;
// Bounds the memory spent on the directory whatever it declares. A directory
// of MAX_ZIP_ENTRIES short names fits in half of this.
export const MAX_DIRECTORY_BYTES = 12 * 1024 * 1024;
// A name is shown, not used; a longer one is cut rather than carried around.
const MAX_NAME_CHARS = 512;
// Characters of names kept across the directory. Real archives use a few million;
// past this, later names are kept short so a directory of long names stays small.
const MAX_NAME_TOTAL = 8 * 1024 * 1024;
const SHORT_NAME_CHARS = 128;
// Inflate in small pushes: one push can expand about a thousandfold, so this
// bounds the output of a single step to a few megabytes.
const INFLATE_STEP = 8 * 1024;
// A head read stops once it has its bytes; this bounds how much compressed data it will feed
// when a stream produces little or nothing for a very long time.
const HEAD_COMPRESSED_CAP = 4 * 1024 * 1024;
// Entry sizes in a real archive are far below this (1 PiB). Anything above is
// a corrupt field, and keeping it below 2^53 keeps the sums exact.
const MAX_SIZE = 2 ** 50;
// A signing block is a few kilobytes to a few megabytes; the IDs are listed
// from its start, and a handful of pairs is all a real one has.
export const MAX_SIGNING_PAIRS = 64;
const MAX_SIGNING_BLOCK = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** The compression method. For a WinZip AES entry this is the real one from the extra field, not the header's 99. */
  method: number;
  /** Relative to the start of the zip data; ZipArchive adds the base. */
  localHeaderOffset: number;
  crc: number;
  isDirectory: boolean;
  encrypted: boolean;
  /** What protects an encrypted entry, in plain words, or undefined when it is not encrypted. */
  encryption?: string;
  /**
   * True when `name` is the archive's name byte for byte: not cut, and nothing
   * removed by cleaning. Only such entries can be found by name, so a decoy whose
   * display name cleans to a recognised one never stands in for it.
   */
  exact: boolean;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** What the directory says it holds, which may exceed `entries` when the list was capped. */
  declaredEntries: number;
  /** False when the directory ran past a cap or was cut short, so counts are lower bounds. */
  complete: boolean;
  totalUncompressed: number;
  totalCompressed: number;
  /** Absolute offset of the central directory in the file. */
  directoryOffset: number;
  /** Entries with an exact name, one per name, the last of any duplicates (as Python's zipfile and Java's ZipFile resolve them). */
  exactEntries: ZipEntry[];
  /** How many exact names the directory lists more than once. */
  duplicateNames: number;
  /** The entry with exactly this name. */
  find(name: string): ZipEntry | undefined;
  /** The entry's data, refusing before reading anything when it is declared larger than `maxBytes`. */
  readEntry(entry: ZipEntry, maxBytes: number): Promise<Uint8Array>;
  /** The first `maxBytes` of the entry's data, however long it is. */
  readEntryHead(entry: ZipEntry, maxBytes: number): Promise<Uint8Array>;
  /** The APK Signing Block's pair IDs, or undefined when the archive has none. */
  signingBlockIds(): Promise<number[] | undefined>;
}

/** What one kind of zip-based package contributes to the page. */
export interface ZipFlavour {
  format: string;
  title?: string;
  summary?: string;
  /** Sections ahead of Contents. */
  before: InfoSection[];
  /** Sections after Contents, such as the signature. */
  after: InfoSection[];
  warnings: string[];
}

const u64 = (view: DataView, at: number): number => {
  const high = view.getUint32(at + 4, true);
  // Above 2^53 the value is not representable; treat it as invalid.
  return high >= 0x200000 ? Number.NaN : high * 2 ** 32 + view.getUint32(at, true);
};

function decodeName(raw: Uint8Array, utf8: boolean, max: number): { name: string; exact: boolean } {
  // Decode only what can be kept: a name field is up to 64 KiB and the
  // directory can hold a hundred thousand of them.
  let text: string;
  if (utf8) {
    text = new TextDecoder().decode(raw.subarray(0, max * 4)).slice(0, max);
  } else {
    // Bit 11 clear means the legacy code page. Latin-1 is exact for ASCII,
    // which is nearly every name in practice.
    text = String.fromCharCode(...Array.from(raw.subarray(0, max)));
  }
  const name = printable(text);
  // A name that was cut or cleaned is for display only: it must not compare
  // equal to a name the readers look for.
  return { name, exact: raw.length <= max && name === text };
}

interface Located {
  directoryOffset: number;
  directorySize: number;
  entryCount: number;
  base: number;
}

/**
 * Say how an entry is encrypted, from its flags and its WinZip AES extra field.
 *
 * Only a label: nothing is decrypted and no password is asked for. The extra
 * field is walked inside its own length and a malformed one is ignored, so a
 * damaged entry gets a less specific label rather than failing the listing.
 */
function describeEncryption(
  view: DataView,
  flags: number,
  headerMethod: number,
  extraStart: number,
  extraEnd: number,
): { label: string; actualMethod?: number } | undefined {
  if ((flags & 0x41) === 0) {
    return undefined;
  }
  if ((flags & 0x1) !== 0) {
    let at = extraStart;
    while (at + 4 <= extraEnd) {
      const id = view.getUint16(at, true);
      const length = view.getUint16(at + 2, true);
      const body = at + 4;
      if (body + length > extraEnd) {
        break;
      }
      // WinZip AES: vendor version, vendor id "AE", strength, real method.
      if (id === 0x9901 && length >= 7 && view.getUint16(body + 2, true) === 0x4541) {
        const version = view.getUint16(body, true);
        const bits = [128, 192, 256][view.getUint8(body + 4) - 1];
        const edition = version === 1 || version === 2 ? ` (WinZip AE-${version})` : ' (WinZip)';
        return {
          label: bits === undefined ? 'AES (WinZip, unknown key size)' : `AES-${bits}${edition}`,
          actualMethod: view.getUint16(body + 5, true),
        };
      }
      at = body + length;
    }
    // Method 99 is how WinZip AES marks an entry, so it is AES even when the field is damaged.
    if (headerMethod === 99) {
      return { label: 'AES (WinZip, unknown key size)' };
    }
  }
  if ((flags & 0x40) !== 0) {
    return { label: 'PKWARE strong encryption' };
  }
  return { label: 'ZipCrypto (legacy, easily broken)' };
}

/**
 * "3 of 10 entries: AES-256 (WinZip AE-2) 2, ZipCrypto (legacy, easily broken) 1", or undefined
 * when nothing is encrypted. When the directory was read only in part, the count is of the
 * entries read: "3 of the 10 entries read: ...".
 */
export function summariseEncryption(entries: ZipEntry[], complete = true): string | undefined {
  const files = entries.filter((e) => !e.isDirectory);
  const counts = new Map<string, number>();
  for (const e of files) {
    if (e.encrypted) {
      const label = e.encryption ?? 'encrypted';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) {
    return undefined;
  }
  const noun = files.length === 1 ? 'entry' : 'entries';
  const lead = complete
    ? `${total} of ${files.length} ${noun}: `
    : `${total} of the ${files.length} ${noun} read: `;
  return counts.size === 1
    ? lead + [...counts.keys()][0]
    : lead + [...counts].map(([label, n]) => `${label} ${n}`).join(', ');
}

async function locateDirectory(reader: RangeReader): Promise<Located> {
  const size = reader.size;
  const tailStart = Math.max(0, size - EOCD_SEARCH);
  const tail = await reader.upTo(tailStart, size - tailStart);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let at = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (view.getUint32(i, true) !== SIG_EOCD) {
      continue;
    }
    // The comment must end at or before the end of the file; trailing bytes
    // after it are tolerated, as unzip tolerates them.
    if (i + EOCD_SIZE + view.getUint16(i + 20, true) <= tail.length) {
      at = i;
      break;
    }
  }
  if (at < 0) {
    throw new PackageError('it is a zip archive whose end-of-directory record cannot be found.');
  }
  const eocdPos = tailStart + at;
  let entryCount = view.getUint16(at + 10, true);
  let directorySize = view.getUint32(at + 12, true);
  let directoryOffset = view.getUint32(at + 16, true);
  let endOfDirectory = eocdPos;

  const wide =
    entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff;
  if (wide && at >= 20 && view.getUint32(at - 20, true) === SIG_EOCD64_LOCATOR) {
    const declared = u64(view, at - 20 + 8);
    const locatorPos = eocdPos - 20;
    // The record normally sits directly before its locator. Try where the
    // locator says first, then walk back through the tail for the signature,
    // which covers an archive with bytes in front of it.
    const candidates = [declared];
    for (let i = at - 20 - 56; i >= 0; i--) {
      if (view.getUint32(i, true) === SIG_EOCD64) {
        candidates.push(tailStart + i);
        break;
      }
    }
    for (const pos of candidates) {
      if (!Number.isFinite(pos) || pos < 0 || pos + 56 > locatorPos) {
        continue;
      }
      const head = await reader.bytes(pos, 4);
      if (new DataView(head.buffer, head.byteOffset).getUint32(0, true) !== SIG_EOCD64) {
        continue;
      }
      const record = await reader.view(pos, 56);
      entryCount = u64(record, 32);
      directorySize = u64(record, 40);
      directoryOffset = u64(record, 48);
      endOfDirectory = pos;
      break;
    }
  }
  if (!Number.isFinite(entryCount + directorySize + directoryOffset)) {
    throw new PackageError('it is a zip archive with a damaged directory record.');
  }

  // Normally the directory is where the record says. A self-extracting stub or
  // other prefix shifts everything by a constant, which is how far the real
  // directory (just before its end record) sits from the declared offset.
  const probe = async (offset: number): Promise<boolean> => {
    if (offset < 0 || offset + 4 > size) {
      return false;
    }
    const head = await reader.bytes(offset, 4);
    return new DataView(head.buffer, head.byteOffset).getUint32(0, true) === SIG_CENTRAL;
  };
  let base = 0;
  if (directorySize > 0 && !(await probe(directoryOffset))) {
    base = endOfDirectory - directorySize - directoryOffset;
    if (base <= 0 || !(await probe(directoryOffset + base))) {
      throw new PackageError('it is a zip archive whose central directory cannot be found.');
    }
  } else if (directorySize === 0 && entryCount > 0) {
    throw new PackageError('it is a zip archive with a damaged directory record.');
  }
  return { directoryOffset: directoryOffset + base, directorySize, entryCount, base };
}

/** Open the archive, reading only its end and its central directory. */
export async function openZip(reader: RangeReader): Promise<ZipArchive> {
  if (reader.size < EOCD_SIZE) {
    throw new PackageError('it is too short to be a zip archive.');
  }
  const where = await locateDirectory(reader);
  let complete = true;
  let readSize = where.directorySize;
  if (readSize > MAX_DIRECTORY_BYTES) {
    readSize = MAX_DIRECTORY_BYTES;
    complete = false;
  }
  readSize = Math.max(0, Math.min(readSize, reader.size - where.directoryOffset));
  // Read in slices: one slice is under any single-read limit, and the pieces
  // are joined into one buffer sized by the capped length above.
  const directory = new Uint8Array(readSize);
  for (let done = 0; done < readSize;) {
    const take = Math.min(1024 * 1024, readSize - done);
    directory.set(await reader.bytes(where.directoryOffset + done, take), done);
    done += take;
  }
  const view = new DataView(directory.buffer);
  const entries: ZipEntry[] = [];
  let nameBudget = MAX_NAME_TOTAL;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  let pos = 0;
  while (pos + CENTRAL_FIXED <= directory.length) {
    if (entries.length >= MAX_ZIP_ENTRIES) {
      complete = false;
      break;
    }
    if (view.getUint32(pos, true) !== SIG_CENTRAL) {
      complete = false;
      break;
    }
    const flags = view.getUint16(pos + 8, true);
    let method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    let compressedSize = view.getUint32(pos + 20, true);
    let uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    let localHeaderOffset = view.getUint32(pos + 42, true);
    const nameAt = pos + CENTRAL_FIXED;
    const next = nameAt + nameLength + extraLength + commentLength;
    if (next > directory.length) {
      complete = false;
      break;
    }
    // ZIP64 fields replace the 32-bit ones that read as all ones, in this order.
    const wantsUncompressed = uncompressedSize === 0xffffffff;
    const wantsCompressed = compressedSize === 0xffffffff;
    const wantsOffset = localHeaderOffset === 0xffffffff;
    if (wantsUncompressed || wantsCompressed || wantsOffset) {
      let extraPos = nameAt + nameLength;
      const extraEnd = extraPos + extraLength;
      while (extraPos + 4 <= extraEnd) {
        const id = view.getUint16(extraPos, true);
        const length = view.getUint16(extraPos + 2, true);
        const body = extraPos + 4;
        if (body + length > extraEnd) {
          break;
        }
        if (id === 0x0001) {
          let at = body;
          const take = (): number => {
            if (at + 8 > body + length) {
              return Number.NaN;
            }
            at += 8;
            return u64(view, at - 8);
          };
          if (wantsUncompressed) {
            uncompressedSize = take();
          }
          if (wantsCompressed) {
            compressedSize = take();
          }
          if (wantsOffset) {
            localHeaderOffset = take();
          }
          break;
        }
        extraPos = body + length;
      }
    }
    const encryption = describeEncryption(
      view,
      flags,
      method,
      nameAt + nameLength,
      nameAt + nameLength + extraLength,
    );
    if (encryption?.actualMethod !== undefined) {
      method = encryption.actualMethod;
    }
    const raw = directory.subarray(nameAt, nameAt + nameLength);
    pos = next;
    if (
      !(compressedSize <= MAX_SIZE) ||
      !(uncompressedSize <= MAX_SIZE) ||
      !(localHeaderOffset <= MAX_SIZE)
    ) {
      // A size that is missing or absurd: the entry cannot be read, but the
      // rest of the list still can.
      complete = false;
      continue;
    }
    const { name, exact } = decodeName(
      raw,
      (flags & 0x800) !== 0,
      nameBudget > 0 ? MAX_NAME_CHARS : SHORT_NAME_CHARS,
    );
    nameBudget -= name.length;
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
      crc,
      isDirectory: raw.length > 0 && raw[raw.length - 1] === 0x2f,
      // Bit 0 is traditional or AES encryption, bit 6 strong encryption.
      encrypted: (flags & 0x41) !== 0,
      encryption: encryption?.label,
      exact,
    });
    totalUncompressed += uncompressedSize;
    totalCompressed += compressedSize;
  }
  if (entries.length < where.entryCount && complete) {
    complete = false;
  }

  // Lookup is by exact name only. Where a name is listed twice the last entry
  // wins, as it does in Python's zipfile and Java's ZipFile (and when unzip
  // extracts over its own earlier output); the caller is told so it can warn.
  const byName = new Map<string, ZipEntry>();
  let duplicateNames = 0;
  for (const entry of entries) {
    if (entry.exact) {
      if (byName.has(entry.name)) {
        duplicateNames++;
      }
      byName.set(entry.name, entry);
    }
  }

  async function dataStart(entry: ZipEntry): Promise<number> {
    // The local header's name and extra lengths can differ from the
    // directory's, so the data's position comes from the local copy.
    const at = entry.localHeaderOffset + where.base;
    const header = await reader.view(at, LOCAL_FIXED);
    if (header.getUint32(0, true) !== SIG_LOCAL) {
      throw new PackageError(`the entry "${entry.name}" does not start where the directory says.`);
    }
    return at + LOCAL_FIXED + header.getUint16(26, true) + header.getUint16(28, true);
  }

  async function read(entry: ZipEntry, maxBytes: number, head: boolean): Promise<Uint8Array> {
    if (entry.encrypted) {
      throw new PackageError(
        `the entry "${entry.name}" is encrypted (${entry.encryption ?? 'unknown method'}) and MarkCopy does not ask for passwords.`,
      );
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new PackageError(`the entry "${entry.name}" uses a compression method not supported.`);
    }
    if (!head && entry.uncompressedSize > maxBytes) {
      throw new PackageError(`the entry "${entry.name}" is larger than MarkCopy will read.`);
    }
    // Deflate can stretch a few bytes a thousandfold but not beyond what the
    // caller will take, so a compressed size far above the cap is damage.
    const compressedCap = maxBytes + Math.ceil(maxBytes / 8) + 1024;
    if (!head && entry.compressedSize > compressedCap) {
      throw new PackageError(`the entry "${entry.name}" is larger than MarkCopy will read.`);
    }
    const start = await dataStart(entry);
    if (entry.method === 0) {
      return reader.bytes(start, Math.min(entry.compressedSize, maxBytes));
    }
    const chunks: Uint8Array[] = [];
    let produced = 0;
    const inflate = new Inflate((chunk) => {
      if (produced < maxBytes) {
        chunks.push(chunk);
      }
      produced += chunk.length;
    });
    try {
      const limit = head
        ? Math.min(entry.compressedSize, HEAD_COMPRESSED_CAP)
        : entry.compressedSize;
      let fed = 0;
      while (fed < limit && produced < maxBytes) {
        const step = Math.min(INFLATE_STEP, limit - fed);
        fed += step;
        // Only the real end of the stream is final: a head read that stops early must not
        // be reported as a truncated stream.
        inflate.push(await reader.bytes(start + fed - step, step), fed >= entry.compressedSize);
      }
    } catch (error) {
      if (error instanceof PackageError) {
        throw error;
      }
      throw new PackageError(`the entry "${entry.name}" is damaged.`);
    }
    if (produced > maxBytes && !head) {
      // The directory understated the size; the stream is what it is.
      throw new PackageError(`the entry "${entry.name}" is larger than MarkCopy will read.`);
    }
    const out = new Uint8Array(Math.min(produced, maxBytes));
    let at = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, out.length - at);
      out.set(chunk.subarray(0, take), at);
      at += take;
    }
    return out;
  }

  return {
    entries,
    declaredEntries: where.entryCount,
    complete,
    totalUncompressed,
    totalCompressed,
    directoryOffset: where.directoryOffset,
    exactEntries: [...byName.values()],
    duplicateNames,
    find: (name) => byName.get(name),
    readEntry: (entry, maxBytes) => read(entry, maxBytes, false),
    readEntryHead: (entry, maxBytes) => read(entry, maxBytes, true),
    async signingBlockIds() {
      // Layout, ending at the central directory: size (8), pairs, size (8), magic (16).
      const end = where.directoryOffset;
      if (end < 24) {
        return undefined;
      }
      const trailer = await reader.view(end - 24, 24);
      const magic = String.fromCharCode(...new Uint8Array(trailer.buffer, 8, 16));
      if (magic !== SIGNING_MAGIC) {
        return undefined;
      }
      const blockSize = u64(trailer, 0);
      if (!(blockSize >= 24 && blockSize <= MAX_SIGNING_BLOCK) || blockSize + 8 > end) {
        return [];
      }
      const ids: number[] = [];
      let at = end - blockSize - 8 + 8;
      const pairsEnd = end - 24;
      while (at + 12 <= pairsEnd && ids.length < MAX_SIGNING_PAIRS) {
        const pair = await reader.view(at, 12);
        const length = u64(pair, 0);
        if (!(length >= 4) || at + 8 + length > pairsEnd) {
          break;
        }
        ids.push(pair.getUint32(8, true));
        at += 8 + length;
      }
      return ids;
    },
  };
}

/**
 * An entry's data as text, or undefined with a warning when it cannot be read.
 * A damaged optional part should not take the page down with it.
 */
export async function readTextEntry(
  zip: ZipArchive,
  entry: ZipEntry,
  maxBytes: number,
  warnings: string[],
  what: string,
): Promise<string | undefined> {
  try {
    const bytes = await zip.readEntry(entry, maxBytes);
    const text = new TextDecoder().decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    if (error instanceof PackageError) {
      warnings.push(`${what} could not be read.`);
      return undefined;
    }
    throw error;
  }
}

/** An entry's raw bytes with the same forgiveness as readTextEntry. */
export async function readBytesEntry(
  zip: ZipArchive,
  entry: ZipEntry,
  maxBytes: number,
  warnings: string[],
  what: string,
): Promise<Uint8Array | undefined> {
  try {
    return await zip.readEntry(entry, maxBytes);
  } catch (error) {
    if (error instanceof PackageError) {
      warnings.push(`${what} could not be read.`);
      return undefined;
    }
    throw error;
  }
}

/** A Signature section for a file that has signature-like parts but no signature the page can stand behind. */
export function signatureNotEstablished(status: string): InfoSection {
  return { kind: 'properties', heading: 'Signature', rows: [['Status', status]] };
}

/** Whether these bytes are a PKCS #7 block that says someone signed: SignedData with a SignerInfo that holds a signature value. */
export function isSignature(der: Uint8Array): boolean {
  return isSignedData(der) && signerCount(der) > 0;
}

// Signature blocks read. apksig allows ten signers; a few more candidates are
// read in case some are orphans, and no more than this are ever opened.
const MAX_V1_CANDIDATES = 16;
// Bytes of signature blocks read in all, whatever the entries declare.
const MAX_V1_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_V1_BLOCK_BYTES = 1024 * 1024;
// Signer names shown when there are several.
const MAX_V1_NAMES = 3;

export interface V1Signatures {
  /** Blocks that form a signature, paired ones first. */
  signed: { name: string; signer?: Signer }[];
  /** Why no signature is established, when signature blocks exist but none is. */
  notEstablished?: string;
}

/** Whether a bounded read of a DER item is possible: its tag, content range and whether its length is indefinite. */
function derAt(
  b: Uint8Array,
  at: number,
  limit: number,
): { tag: number; start: number; end: number; indefinite: boolean } | undefined {
  if (at + 2 > limit) {
    return undefined;
  }
  const tag = b[at];
  let length = b[at + 1];
  let p = at + 2;
  if (length === 0x80) {
    return { tag, start: p, end: limit, indefinite: true };
  }
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 4 || p + count > limit) {
      return undefined;
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + b[p++];
    }
  }
  return p + length > limit ? undefined : { tag, start: p, end: p + length, indefinite: false };
}

/**
 * Whether a PKCS #7 SignedData carries its own signature-file bytes: a
 * non-empty OCTET STRING in its encapsulated ContentInfo (what jarsigner
 * -internalsf writes). OpenJDK reads `block.getContentInfo().getData()` and
 * asks for an external .SF only when that is null.
 *
 * ContentInfo { OID, [0] { SignedData { version, digestAlgorithms,
 *   ContentInfo { OID, [0] { OCTET STRING }? }, ... } } }
 */
export function hasEmbeddedSignatureFile(der: Uint8Array): boolean {
  const outer = derAt(der, 0, der.length);
  if (outer?.tag !== 0x30) {
    return false;
  }
  const oid = derAt(der, outer.start, outer.end);
  const wrapped = oid && !oid.indefinite ? derAt(der, oid.end, outer.end) : undefined;
  const signed = wrapped?.tag === 0xa0 ? derAt(der, wrapped.start, wrapped.end) : undefined;
  if (signed?.tag !== 0x30) {
    return false;
  }
  // version, digestAlgorithms, then the encapsulated ContentInfo.
  let at = signed.start;
  for (let i = 0; i < 2; i++) {
    const item = derAt(der, at, signed.end);
    if (!item || item.indefinite) {
      return false;
    }
    at = item.end;
  }
  const content = derAt(der, at, signed.end);
  if (content?.tag !== 0x30) {
    return false;
  }
  const type = derAt(der, content.start, content.end);
  const holder = type && !type.indefinite ? derAt(der, type.end, content.end) : undefined;
  if (holder?.tag !== 0xa0) {
    return false;
  }
  const octets = derAt(der, holder.start, holder.end);
  if (!octets || (octets.tag !== 0x04 && octets.tag !== 0x24)) {
    return false;
  }
  // An indefinite length ends with 00 00; anything before that is content.
  return octets.indefinite
    ? der[octets.start] !== 0 || der[octets.start + 1] !== 0
    : octets.end > octets.start;
}

type V1Rules = 'jdk' | 'apksig';

const META_INF = 'meta-inf/';

interface V1Name {
  kind: 'block' | 'sf';
  /** What a block and its .SF share. */
  key: string;
}

/**
 * Which entry names are signature files, per implementation.
 *
 * OpenJDK, in two steps. The zip reader (ZipFile.Source.isMetaName and
 * isSignatureRelated, jdk-21+35) decides which members are signature files at
 * all, on the raw name bytes with ASCII-only case folding (`b | 0x20`):
 *   the name has more than 9 bytes, does not end in "/", and starts with
 *   "META-INF/" (letters folded, "-" and "/" exact);
 *   the byte three from the end is "." and the last two are "ec" or "sf", or
 *   else the byte four from the end is "." and the last three are "dsa" or
 *   "rsa";
 *   no "/" after the prefix, so only direct children count.
 * SignatureFileVerifier then pairs a block with its .SF by the upper-cased name
 * without the extension (toUpperCase(Locale.ENGLISH), full Unicode). That runs
 * only on names the zip reader accepted, so a directory spelled with a dotless
 * i (U+0131) in place of the "I" of "META-INF" is not a signature directory,
 * even though its upper case reads "META-INF".
 *
 * apksig (V1SchemeVerifier): any name starting "META-INF/" (case-sensitive,
 *   nested paths included) that ends with .SF, or .RSA, .DSA or .EC (all
 *   case-sensitive); a block pairs with the .SF named like it with the
 *   extension replaced by ".SF".
 */
function v1Name(name: string, rules: V1Rules): V1Name | undefined {
  if (rules === 'jdk') {
    const length = name.length;
    if (
      length <= META_INF.length ||
      name[length - 1] === '/' ||
      asciiLower(name.slice(0, META_INF.length)) !== META_INF ||
      name.indexOf('/', META_INF.length) >= 0
    ) {
      return undefined;
    }
    let extension: string;
    let dotted: number;
    if (name[length - 3] === '.') {
      extension = asciiLower(name.slice(length - 2));
      dotted = 3;
    } else if (name[length - 4] === '.') {
      extension = asciiLower(name.slice(length - 3));
      dotted = 4;
    } else {
      return undefined;
    }
    const key = name.slice(0, length - dotted).toUpperCase();
    if (extension === 'sf') {
      return { kind: 'sf', key };
    }
    return extension === 'ec' || extension === 'dsa' || extension === 'rsa'
      ? { kind: 'block', key }
      : undefined;
  }
  if (!name.startsWith('META-INF/')) {
    return undefined;
  }
  if (name.endsWith('.SF')) {
    return { kind: 'sf', key: name.slice(0, -3) };
  }
  if (/\.(RSA|DSA|EC)$/.test(name)) {
    return { kind: 'block', key: name.slice(0, name.lastIndexOf('.')) };
  }
  return undefined;
}

/**
 * The v1 (JAR) signatures of an archive, following each implementation.
 *
 * jdk (JarVerifier + SignatureFileVerifier): a block is a signature when it
 * carries its own signature-file bytes, or when a .SF with the same base name
 * is present; a block with neither is left pending and never verified, which
 * is "treated as unsigned". apksig: a block needs its external .SF (it warns
 * and skips one without), and the JAR needs META-INF/MANIFEST.MF.
 *
 * Every candidate is considered within a count and a byte budget, paired ones
 * first, so an orphan or an unreadable block ahead of the real one costs a
 * warning and not the signature. Nothing is said about a block that was not
 * examined.
 */
export async function readV1Signatures(
  zip: ZipArchive,
  rules: V1Rules,
  warnings: string[],
): Promise<V1Signatures> {
  const files = new Set<string>();
  const blocks: { entry: ZipEntry; key: string; paired: boolean }[] = [];
  let manifest = false;
  for (const entry of zip.exactEntries) {
    if (entry.isDirectory) {
      continue;
    }
    if (entry.name === 'META-INF/MANIFEST.MF') {
      manifest = true;
    }
    const parsed = v1Name(entry.name, rules);
    if (parsed?.kind === 'sf') {
      files.add(parsed.key);
    }
  }
  for (const entry of zip.exactEntries) {
    const parsed = entry.isDirectory ? undefined : v1Name(entry.name, rules);
    if (parsed?.kind === 'block') {
      blocks.push({ entry, key: parsed.key, paired: files.has(parsed.key) });
    }
  }
  const used = new Set(blocks.filter((b) => b.paired).map((b) => b.key));
  const orphanFiles = [...files].filter((f) => !used.has(f)).length;
  const ordered = [...blocks.filter((b) => b.paired), ...blocks.filter((b) => !b.paired)];

  const signed: V1Signatures['signed'] = [];
  let unreadable = 0;
  let unpaired = 0;
  let skipped = 0;
  let budget = MAX_V1_TOTAL_BYTES;
  for (const [index, { entry, paired }] of ordered.entries()) {
    // apksig never looks at a block without its .SF, so reading one is pointless.
    if (!paired && rules === 'apksig') {
      unpaired++;
      continue;
    }
    if (index >= MAX_V1_CANDIDATES || budget <= 0) {
      skipped++;
      continue;
    }
    try {
      const der = await zip.readEntry(entry, Math.min(MAX_V1_BLOCK_BYTES, budget));
      budget -= der.length;
      if (!isSignature(der)) {
        unreadable++;
      } else if (paired || hasEmbeddedSignatureFile(der)) {
        signed.push({ name: entry.name, signer: readSigner(der) });
      } else {
        unpaired++;
      }
    } catch (error) {
      if (!(error instanceof PackageError)) {
        throw error;
      }
      unreadable++;
    }
  }
  // A name missing from the listing is absent only when the listing is complete.
  // A directory cut by a cap or by damage may hold the manifest, or the .SF of a
  // block that looks unpaired, so those are reported as not established instead.
  const listed = zip.complete;
  const noManifest = rules === 'apksig' && !manifest && signed.length > 0;
  if (noManifest) {
    // apksig reports JAR_SIG_NO_MANIFEST and stops: nothing is a v1 signature.
    // Without a complete listing that is only what the inspected part shows.
    signed.length = 0;
  }
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
  if (unpaired > 0) {
    warnings.push(
      listed
        ? `${unpaired} signature block${plural(unpaired, ' has', 's have')} no matching .SF file in META-INF${rules === 'jdk' ? ' and no signature file inside it' : ''}, so ${plural(unpaired, 'it was', 'they were')} ignored.`
        : `${unpaired} signature block${plural(unpaired, ' has', 's have')} no matching .SF file in the part of META-INF that could be listed${rules === 'jdk' ? ' and no signature file inside it' : ''}, so ${plural(unpaired, 'it was', 'they were')} not counted; a matching file may be unlisted.`,
    );
  }
  if (unreadable > 0) {
    warnings.push(
      `${unreadable} signature block${plural(unreadable, '', 's')} in META-INF could not be read as ${plural(unreadable, 'a signature', 'signatures')}.`,
    );
  }
  if (orphanFiles > 0) {
    warnings.push(
      listed
        ? `${orphanFiles} .SF file${plural(orphanFiles, ' has', 's have')} no signature block in META-INF.`
        : `${orphanFiles} .SF file${plural(orphanFiles, ' has', 's have')} no signature block in the part of META-INF that could be listed; a block may be unlisted.`,
    );
  }
  if (skipped > 0) {
    warnings.push('More signature blocks than MarkCopy reads were skipped.');
  }
  if (noManifest) {
    warnings.push(
      listed
        ? 'The archive has no META-INF/MANIFEST.MF, so Android does not accept a v1 signature.'
        : 'META-INF/MANIFEST.MF was not found in the part of the archive that could be listed, so whether Android accepts a v1 signature could not be established.',
    );
  }
  let notEstablished: string | undefined;
  if (signed.length === 0 && (blocks.length > 0 || noManifest)) {
    notEstablished = noManifest
      ? listed
        ? 'A META-INF signature block is present, but the archive has no META-INF/MANIFEST.MF, so it is not a v1 signature'
        : 'A META-INF signature block is present, but the v1 prerequisites (META-INF/MANIFEST.MF) could not be established in the part of the archive that could be listed, so whether it is a v1 signature is not known'
      : skipped > 0
        ? 'META-INF signature blocks are present, but more than MarkCopy reads, so whether any is a signature is not known'
        : unreadable > 0
          ? 'A META-INF signature block is present but could not be read as a signature, so nothing is known about it'
          : listed
            ? 'A META-INF signature block has no signature file, so it does not form a signature'
            : 'A META-INF signature block has no signature file in the part of the archive that could be listed, so whether it forms a signature is not known';
  }
  return { signed, notEstablished };
}

/** The section for v1 signatures that were found: the first signer, and a count and names when there are several. */
export function v1Section(scheme: string, v1: V1Signatures): PropertySection {
  const section = signatureSection(scheme, v1.signed[0]?.signer);
  if (v1.signed.length > 1) {
    const names = v1.signed
      .slice(0, MAX_V1_NAMES)
      .map((s) => s.signer?.subject ?? s.name)
      .join(', ');
    section.rows.push([
      'Signatures',
      `${v1.signed.length} (${names}${v1.signed.length > MAX_V1_NAMES ? ', and more' : ''})`,
    ]);
  }
  return section;
}
