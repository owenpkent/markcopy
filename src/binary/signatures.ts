// Cheap structural tests for formats a file may have besides the one a preview
// reads it as. Each looks only at bytes a RangeReader serves from the head of
// the file or its last 64 KiB, never at the whole file, and each says false
// for a file that is too short or cut off instead of throwing.
//
// Used by the package preview's probe table (src/pkg/index.ts) and by the
// executable preview's note on what its appended data is. No `vscode` import.
import type { RangeReader } from './reader';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const EOCD_SIZE = 22;
// The record is followed by a comment of at most 65,535 bytes.
const EOCD_SEARCH = 0xffff + EOCD_SIZE;

/** PDF readers accept the header anywhere in the first 1,024 bytes. */
export const PDF_HEADER_WINDOW = 1024;

export interface ZipEnd {
  /** Where the end-of-central-directory record starts. */
  eocd: number;
  /** Where the central directory starts, when the record gives a size that can be checked. */
  directoryStart?: number;
}

/**
 * A zip end-of-central-directory record whose comment runs exactly to the end
 * of the file, with the central directory in front of it when its size is
 * stated (zip64 archives state it elsewhere and are not checked further).
 */
export async function findZipEnd(reader: RangeReader): Promise<ZipEnd | undefined> {
  try {
    const size = reader.size;
    if (size < EOCD_SIZE) {
      return undefined;
    }
    const tailStart = Math.max(0, size - EOCD_SEARCH);
    const tail = await reader.upTo(tailStart, size - tailStart);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
      if (
        view.getUint32(i, true) !== SIG_EOCD ||
        i + EOCD_SIZE + view.getUint16(i + 20, true) !== tail.length
      ) {
        continue;
      }
      const eocd = tailStart + i;
      const directorySize = view.getUint32(i + 12, true);
      if (i >= 20 && view.getUint32(i - 20, true) === SIG_EOCD64_LOCATOR) {
        return { eocd };
      }
      if (directorySize > eocd) {
        return undefined;
      }
      const directoryStart = eocd - directorySize;
      if (
        directorySize > 0 &&
        new DataView((await reader.bytes(directoryStart, 4)).slice().buffer).getUint32(0, true) !==
          SIG_CENTRAL
      ) {
        return undefined;
      }
      return { eocd, directoryStart };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** "MZ", then an `e_lfanew` that points at "PE\0\0" inside the file. */
export async function looksLikePe(reader: RangeReader): Promise<boolean> {
  try {
    if (reader.size < 0x40) {
      return false;
    }
    const dos = await reader.bytes(0, 0x40);
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) {
      return false;
    }
    const at = new DataView(dos.buffer, dos.byteOffset).getUint32(0x3c, true);
    if (at < 0x40 || at + 4 > reader.size) {
      return false;
    }
    const sig = await reader.bytes(at, 4);
    return sig[0] === 0x50 && sig[1] === 0x45 && sig[2] === 0 && sig[3] === 0;
  } catch {
    return false;
  }
}

const PDF_TAIL_WINDOW = 64 * 1024;

const indexOfText = (bytes: Uint8Array, text: string, from = 0): number => {
  const want = [...text].map((c) => c.charCodeAt(0));
  for (let i = from; i + want.length <= bytes.length; i++) {
    if (want.every((b, k) => bytes[i + k] === b)) {
      return i;
    }
  }
  return -1;
};

/** "%PDF-" and a 1.x or 2.x version in the first 1,024 bytes, given the head of the file. */
export function hasPdfHeader(head: Uint8Array): boolean {
  const window = head.subarray(0, PDF_HEADER_WINDOW);
  for (let at = indexOfText(window, '%PDF-'); at >= 0; at = indexOfText(window, '%PDF-', at + 1)) {
    const v = head.subarray(at + 5, at + 8);
    if ((v[0] === 0x31 || v[0] === 0x32) && v[1] === 0x2e && v[2] >= 0x30 && v[2] <= 0x39) {
      return true;
    }
  }
  return false;
}

/**
 * A PDF header, and "startxref" followed by "%%EOF" in the last 64 KiB, which
 * is where PDF readers look. The marker alone, as in a file name or ordinary
 * text, does not count.
 */
export async function looksLikePdf(reader: RangeReader, head: Uint8Array): Promise<boolean> {
  if (!hasPdfHeader(head)) {
    return false;
  }
  const start = Math.max(0, reader.size - PDF_TAIL_WINDOW);
  const tail = await reader.upTo(start, reader.size - start);
  const xref = indexOfText(tail, 'startxref');
  return xref >= 0 && indexOfText(tail, '%%EOF', xref) >= 0;
}
