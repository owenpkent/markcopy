// What a RAR archive declares about its own encryption, from the block headers
// that are stored in the clear. Nothing is decrypted and no password is used.
//
// RAR5 (technote.txt in the RAR 5 sources, "RAR 5.0 archive format"): an
// 8-byte signature, then blocks of CRC32, a variable-length header size and a
// header (type, flags, optional extra-area and data sizes). Type 4 is the
// archive encryption header: every block after it is encrypted. A file header
// (type 2) may carry an extra-area record of type 0x01, the file encryption
// record, whose version and KDF count are public parameters; its salt, IV and
// password check are never read into a result.
//
// RAR 2.9 to 4.x ("RAR 4 format", the unrar sources' headers.hpp): a 7-byte
// signature, then blocks of CRC16, type, flags and size. The main header flag
// 0x0080 means the headers are encrypted; a file header's flag 0x0004 means
// that file is. The file header's UnpVer byte picks the scheme: 13, 15 and 20
// (also 26) are the pre-AES RAR 1.3, 1.5 and 2.0 ciphers; 29 and up is AES-128.
import type { RangeReader } from '../binary/reader';
import { ENCRYPTION_NOTE, NOT_DETERMINED, Cursor, Undetermined, count } from './labels';
import { propertySection, type PackageInfo } from './model';

export const RAR5_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
export const RAR4_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];

/** Headers walked before the reader stops and says how many it read. */
const MAX_HEADERS = 1000;
/** The largest header read whole; a larger one ends the walk. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_EXTRA_RECORDS = 32;
/** RAR's own limit on the KDF exponent. */
const MAX_KDF_EXPONENT = 24;
const LEGACY = 'RAR 2.9 format (legacy AES-128)';
/** A file header's UnpVer byte sits after the 7-byte block header and 17 bytes of sizes, CRC and times. */
const RAR4_UNPVER_OFFSET = 24;

function vint(c: Cursor): number {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const b = c.u8();
    value += (b & 0x7f) * 2 ** (7 * i);
    if ((b & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) {
        break;
      }
      return value;
    }
  }
  throw new Undetermined('a number is out of range');
}

/** Why a walk that did not reach the end block stopped. */
function endReason(headers: number): string {
  return headers >= MAX_HEADERS
    ? `the cap of ${count(MAX_HEADERS)} headers was reached`
    : 'the file ends before the end block';
}

function kdf(exponent: number): string {
  return exponent <= MAX_KDF_EXPONENT
    ? `PBKDF2 (HMAC-SHA256), 2^${exponent} iterations`
    : NOT_DETERMINED;
}

function cipherV4(unpVer: number | undefined): string {
  if (unpVer === undefined) {
    return NOT_DETERMINED;
  }
  if (unpVer >= 29) {
    return LEGACY;
  }
  if (unpVer === 13 || unpVer === 15) {
    return `RAR 1.${unpVer === 13 ? 3 : 5} format (proprietary cipher, not AES)`;
  }
  if (unpVer === 20 || unpVer === 26) {
    return 'RAR 2.0 format (proprietary cipher, not AES)';
  }
  return `${NOT_DETERMINED} (entry version ${unpVer})`;
}

function cipherV5(version: number): string {
  return version === 0 ? 'AES-256' : `${NOT_DETERMINED} (encryption version ${version})`;
}

async function readRar5(reader: RangeReader): Promise<[string, string][]> {
  const rows: [string, string][] = [['Format', 'RAR 5']];
  let pos = RAR5_SIGNATURE.length;
  let headers = 0;
  let files = 0;
  let encryptedFiles = 0;
  let firstCipher: string | undefined;
  let firstKdf: string | undefined;
  let ended = false;
  let stopped = '';
  let headersEncrypted = false;
  try {
    while (headers < MAX_HEADERS && pos + 7 <= reader.size) {
      const window = await reader.upTo(pos, 4 + 3 + MAX_HEADER_BYTES);
      const c = new Cursor(window);
      c.skip(4);
      const headerSize = vint(c);
      const bodyStart = c.pos;
      if (headerSize < 2 || headerSize > MAX_HEADER_BYTES) {
        stopped = 'a header is larger than this reader will read';
        break;
      }
      const body = new Cursor(window, bodyStart, bodyStart + headerSize);
      const type = vint(body);
      const flags = vint(body);
      const extraSize = flags & 0x01 ? vint(body) : 0;
      const dataSize = flags & 0x02 ? vint(body) : 0;
      headers++;
      if (type === 4) {
        const version = vint(body);
        vint(body);
        const exponent = body.u8();
        headersEncrypted = true;
        rows.push(['File names', `encrypted (${cipherV5(version)})`]);
        rows.push(['Key derivation', kdf(exponent)]);
        break;
      }
      if (type === 5) {
        ended = true;
        break;
      }
      if (type === 2) {
        files++;
        if (extraSize > 0 && extraSize <= headerSize) {
          const extra = new Cursor(
            window,
            bodyStart + headerSize - extraSize,
            bodyStart + headerSize,
          );
          for (let i = 0; i < MAX_EXTRA_RECORDS && extra.left > 0; i++) {
            const size = vint(extra);
            const end = extra.pos + size;
            if (end > extra.end) {
              break;
            }
            const recordType = vint(extra);
            if (recordType === 0x01) {
              encryptedFiles++;
              if (firstKdf === undefined) {
                const record = new Cursor(window, extra.pos, end);
                const version = vint(record);
                vint(record);
                firstCipher = cipherV5(version);
                firstKdf = kdf(record.u8());
              }
            }
            extra.pos = end;
          }
        }
      }
      pos += bodyStart + headerSize + dataSize;
    }
  } catch {
    stopped = 'a header could not be read';
  }
  if (!headersEncrypted) {
    const all = ended ? 'all' : 'the first';
    rows.push(['File names', 'not encrypted (the headers are readable)']);
    if (files === 0) {
      rows.push(['Entries', `${NOT_DETERMINED} (no file headers were read)`]);
    } else {
      rows.push([
        'Entries',
        encryptedFiles > 0
          ? `${firstCipher ?? NOT_DETERMINED}: ${count(encryptedFiles)} of ${count(files)} entries read`
          : `none of ${count(files)} entries read are encrypted`,
      ]);
      if (firstKdf) {
        rows.push(['Key derivation', firstKdf]);
      }
      if (!ended) {
        rows.push([
          'Entries read',
          stopped
            ? `${all} ${count(files)} (stopped: ${stopped})`
            : `${all} ${count(files)} (${endReason(headers)})`,
        ]);
      }
    }
  } else if (stopped) {
    rows.push(['Entries', NOT_DETERMINED]);
  }
  return rows;
}

async function readRar4(reader: RangeReader): Promise<[string, string][]> {
  const rows: [string, string][] = [['Format', 'RAR 2.9 to 4.x']];
  let pos = RAR4_SIGNATURE.length;
  let headers = 0;
  let files = 0;
  let encryptedFiles = 0;
  const ciphers = new Set<string>();
  let ended = false;
  let stopped = '';
  let headersEncrypted = false;
  try {
    while (headers < MAX_HEADERS && pos + 7 <= reader.size) {
      const window = await reader.upTo(pos, MAX_HEADER_BYTES);
      const c = new Cursor(window);
      c.skip(2);
      const type = c.u8();
      const flags = c.u16le();
      const size = c.u16le();
      if (size < 7) {
        stopped = 'a header has an impossible size';
        break;
      }
      headers++;
      let data = flags & 0x8000 ? c.u32le() : 0;
      if (type === 0x73) {
        if (flags & 0x0080) {
          headersEncrypted = true;
          rows.push(['File names', `encrypted (${LEGACY})`]);
          break;
        }
      } else if (type === 0x74) {
        files++;
        if (flags & 0x0004) {
          encryptedFiles++;
          ciphers.add(
            cipherV4(
              size > RAR4_UNPVER_OFFSET && window.length > RAR4_UNPVER_OFFSET
                ? window[RAR4_UNPVER_OFFSET]
                : undefined,
            ),
          );
        }
        if (flags & 0x0100) {
          // 64-bit sizes: the high half of the packed size follows the attributes.
          const high = new Cursor(window, 7 + 4 + 4 + 1 + 4 + 4 + 1 + 1 + 2 + 4, size);
          data += high.u32le() * 2 ** 32;
        }
      } else if (type === 0x7b) {
        ended = true;
        break;
      }
      pos += size + data;
    }
  } catch {
    stopped = 'a header could not be read';
  }
  if (!headersEncrypted) {
    rows.push(['File names', 'not encrypted (the headers are readable)']);
    if (files === 0) {
      rows.push(['Entries', `${NOT_DETERMINED} (no file headers were read)`]);
    } else {
      rows.push([
        'Entries',
        encryptedFiles > 0
          ? `${[...ciphers].join(' and ')}: ${count(encryptedFiles)} of ${count(files)} entries read`
          : `none of ${count(files)} entries read are encrypted`,
      ]);
      if (!ended) {
        rows.push(['Entries read', `the first ${count(files)} (${stopped || endReason(headers)})`]);
      }
    }
  } else if (stopped) {
    rows.push(['Entries', NOT_DETERMINED]);
  }
  return rows;
}

/** What the archive declares. Never throws. */
export async function readRar(reader: RangeReader): Promise<PackageInfo> {
  const head = await reader.upTo(0, 8);
  const v5 = RAR5_SIGNATURE.every((b, i) => head[i] === b);
  let rows: [string, string][];
  try {
    rows = v5 ? await readRar5(reader) : await readRar4(reader);
  } catch {
    rows = [['Entry encryption', NOT_DETERMINED]];
  }
  const encryptedNames = rows.some((r) => r[0] === 'File names' && r[1].startsWith('encrypted'));
  return {
    format: v5 ? 'RAR archive (RAR 5)' : 'RAR archive (RAR 2.9 to 4.x)',
    summary: encryptedNames
      ? 'A RAR archive with encrypted headers: file names are hidden.'
      : 'A RAR archive. The labels below come from its block headers only.',
    sections: propertySection('Encryption', rows, ENCRYPTION_NOTE),
    warnings: [],
  };
}
