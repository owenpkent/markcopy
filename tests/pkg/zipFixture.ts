// Building zip archives as exact bytes, from APPNOTE.TXT (the zip format
// specification), not from src/pkg/zipRange.ts: local file headers, a central
// directory, an end record, and optionally ZIP64 records, a prefix in front
// of the archive and an APK Signing Block ahead of the directory.
import { deflateSync } from 'fflate';
import { expect } from 'vitest';
import { bytesSource, RangeReader } from '../../src/binary/reader';
import {
  PackageError,
  type PackageInfo,
  type PropertySection,
  type TableSection,
} from '../../src/pkg/model';
import { renderPackageHtml } from '../../src/pkg/render';
import { readZipPackage } from '../../src/pkg/zipFormats';

export interface FixtureEntry {
  name: string;
  /** Text is encoded as UTF-8. Absent for a directory. */
  data?: Uint8Array | string;
  /** 0 stored (the default) or 8 deflate. */
  method?: 0 | 8;
  /** Leave general-purpose bit 11 clear, so the name is in the legacy code page. */
  legacyName?: boolean;
  encrypted?: boolean;
  /** Extra general-purpose flag bits, such as 0x40 for PKWARE strong encryption. */
  flagBits?: number;
  /** Raw bytes of extra field written in the central directory only. */
  centralExtra?: Uint8Array;
  /** Override the uncompressed size the directory declares (a lie). */
  declaredSize?: number;
  /** Override the compression method number (an unsupported one). */
  methodNumber?: number;
  /** Bytes of extra field in the local header only, so it differs from the directory's. */
  localExtra?: number;
  /** Override where the directory says the local header is. */
  declaredOffset?: number;
}

export interface ZipOptions {
  comment?: string;
  /** Bytes in front of the archive, as a self-extracting stub has. */
  prefix?: Uint8Array;
  zip64?: boolean;
  /** Pair IDs for an APK Signing Block placed ahead of the central directory. */
  signingBlockIds?: number[];
  /** Override the entry count the end record declares. */
  declaredCount?: number;
}

class Out {
  readonly parts: number[] = [];
  get length(): number {
    return this.parts.length;
  }
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  u64(v: number): this {
    return this.u32(v % 2 ** 32).u32(Math.floor(v / 2 ** 32));
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) {
      this.parts.push(b[i]);
    }
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

let crcTable: number[] | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable.push(c >>> 0);
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: FixtureEntry[], options: ZipOptions = {}): Uint8Array {
  const body = new Out();
  const directory = new Out();
  const wide = options.zip64 === true;
  for (const entry of entries) {
    const raw =
      entry.data === undefined
        ? new Uint8Array(0)
        : typeof entry.data === 'string'
          ? utf8(entry.data)
          : entry.data;
    const method = entry.method ?? 0;
    const stored = method === 8 ? deflateSync(raw) : raw;
    const name = entry.legacyName
      ? Uint8Array.from([...entry.name].map((c) => c.charCodeAt(0) & 0xff))
      : utf8(entry.name);
    const flags =
      (entry.legacyName ? 0 : 0x800) | (entry.encrypted ? 1 : 0) | (entry.flagBits ?? 0);
    const offset = body.length;
    const declared = entry.declaredSize ?? raw.length;
    const methodField = entry.methodNumber ?? method;

    body
      .u32(0x04034b50)
      .u16(20)
      .u16(flags)
      .u16(methodField)
      .u16(0)
      .u16(0x21)
      .u32(crc32(raw))
      .u32(stored.length)
      .u32(declared)
      .u16(name.length)
      .u16(entry.localExtra ?? 0)
      .bytes(name);
    for (let i = 0; i < (entry.localExtra ?? 0); i++) {
      body.u8(0xee);
    }
    body.bytes(stored);

    directory
      .u32(0x02014b50)
      .u16(45)
      .u16(20)
      .u16(flags)
      .u16(methodField)
      .u16(0)
      .u16(0x21)
      .u32(crc32(raw))
      .u32(wide ? 0xffffffff : stored.length)
      .u32(wide ? 0xffffffff : declared)
      .u16(name.length)
      .u16((wide ? 28 : 0) + (entry.centralExtra?.length ?? 0))
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(wide ? 0xffffffff : (entry.declaredOffset ?? offset))
      .bytes(name);
    if (wide) {
      directory
        .u16(0x0001)
        .u16(24)
        .u64(declared)
        .u64(stored.length)
        .u64(entry.declaredOffset ?? offset);
    }
    directory.bytes(entry.centralExtra ?? []);
  }

  if (options.signingBlockIds) {
    const pairs = new Out();
    for (const id of options.signingBlockIds) {
      pairs
        .u64(4 + 4)
        .u32(id)
        .u32(0);
    }
    const size = pairs.length + 8 + 16;
    body.u64(size).bytes(pairs.parts).u64(size).bytes(utf8('APK Sig Block 42'));
  }

  const directoryOffset = body.length;
  const comment = utf8(options.comment ?? '');
  const out = new Out()
    .bytes(options.prefix ?? [])
    .bytes(body.parts)
    .bytes(directory.parts);
  const count = options.declaredCount ?? entries.length;
  if (wide) {
    const recordAt = body.length + directory.length;
    out
      .u32(0x06064b50)
      .u64(44)
      .u16(45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u64(count)
      .u64(count)
      .u64(directory.length)
      .u64(directoryOffset)
      .u32(0x07064b50)
      .u32(0)
      .u64(recordAt)
      .u32(1);
  }
  out
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(wide ? 0xffff : count)
    .u16(wide ? 0xffff : count)
    .u32(wide ? 0xffffffff : directory.length)
    .u32(wide ? 0xffffffff : directoryOffset)
    .u16(comment.length)
    .bytes(comment);
  return out.done();
}

/** A Java properties-style or header-style text file as bytes. */
export const text = utf8;

// Helpers shared by the zip-based format tests.

export const readZip = (bytes: Uint8Array, fileName = 'x.zip'): Promise<PackageInfo> =>
  readZipPackage(new RangeReader(bytesSource(bytes)), fileName);

export function section(info: PackageInfo, heading: string): PackageInfo['sections'][number] {
  const found = info.sections.find((s) => s.heading === heading);
  if (!found) {
    throw new Error(`no "${heading}" section in ${info.sections.map((s) => s.heading).join(', ')}`);
  }
  return found;
}

export const hasSection = (info: PackageInfo, heading: string): boolean =>
  info.sections.some((s) => s.heading === heading);

/** One row's value from a property section. */
export function value(info: PackageInfo, heading: string, label: string): string | undefined {
  return (section(info, heading) as PropertySection).rows.find(([l]) => l === label)?.[1];
}

export const tableRows = (info: PackageInfo, heading: string): string[][] =>
  (section(info, heading) as TableSection).rows;

export const html = (info: PackageInfo): string =>
  renderPackageHtml(info, { fileName: 'x.pkg', fileSize: 1 });

/**
 * Cut the file at every length for the first 1024 bytes and then at a stride,
 * and flip each byte in turn: every outcome is a page or a PackageError, never
 * a RangeError or TypeError. Entries are stored, so a flipped byte lands in
 * the content the reader parses.
 */
export async function expectSafe(bytes: Uint8Array, fileName = 'x.zip'): Promise<void> {
  const attempt = async (data: Uint8Array): Promise<void> => {
    try {
      await readZip(data, fileName);
    } catch (error) {
      expect(error).toBeInstanceOf(PackageError);
    }
  };
  const stride = Math.max(1, Math.floor(bytes.length / 150));
  for (let n = 0; n < bytes.length; n += n < 1024 ? 1 : stride) {
    await attempt(bytes.subarray(0, n));
  }
  const step = Math.max(1, Math.floor(bytes.length / 1500));
  for (let i = 0; i < bytes.length; i += step) {
    const copy = bytes.slice();
    copy[i] ^= 0xff;
    await attempt(copy);
  }
}
