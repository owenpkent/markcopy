// What a 7-Zip archive declares about its own encryption, read from its
// unencrypted structure only. Nothing is decrypted, no password is asked for
// and no LZMA decoder is involved: when the archive's header is compressed the
// entries are reported as "not determined" instead of guessed.
//
// Layout (7zFormat.txt in the 7-Zip sources): a 32-byte signature header
// (signature, version, start-header CRC, next-header offset, size and CRC,
// little-endian), and at that offset the next header, which is either the
// header itself (0x01) or an encoded header (0x17), a StreamsInfo that says
// how the real header was packed (coders, and so whether AES-256 is among
// them). Numbers are 7-Zip's variable-length encoding.
import type { RangeReader } from '../binary/reader';
import { ENCRYPTION_NOTE, NOT_DETERMINED, Cursor, Undetermined, count, hexId } from './labels';
import { propertySection, type PackageInfo } from './model';

export const SEVEN_ZIP_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

const START_HEADER = 32;
/** Of the next header, the first bytes read: the stream tables come before the file list. */
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_FOLDERS = 4096;
const MAX_CODERS = 32;
const MAX_STREAMS = 64;
const MAX_PACK_STREAMS = 1 << 20;
const MAX_PROPERTIES = 64;
const AES_ID = '06f10701';
const MAX_CYCLES_POWER = 30;

const METHODS: Record<string, string> = {
  '00': 'Copy',
  '03': 'Delta',
  '21': 'LZMA2',
  '030101': 'LZMA',
  '030401': 'PPMd',
  '040108': 'Deflate',
  '040202': 'BZip2',
  '06f10701': 'AES-256',
};

interface Coder {
  id: string;
  /** NumCyclesPower of an AES coder: the first property byte's low six bits. */
  cyclesPower?: number;
}
interface Folder {
  coders: Coder[];
}
interface Streams {
  folders: Folder[];
  folderCount: number;
}

/** 7-Zip's variable-length number: the high bits of the first byte count the bytes that follow. */
function readNumber(c: Cursor): number {
  const first = c.u8();
  let mask = 0x80;
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if ((first & mask) === 0) {
      value += (first & (mask - 1)) * 2 ** (8 * i);
      break;
    }
    value += c.u8() * 2 ** (8 * i);
    mask >>= 1;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Undetermined('a number is out of range');
  }
  return value;
}

function skipDigests(c: Cursor, n: number): void {
  const allDefined = c.u8();
  let defined = n;
  if (allDefined === 0) {
    const bits = c.take(Math.ceil(n / 8));
    defined = 0;
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3] & (0x80 >> (i & 7))) {
        defined++;
      }
    }
  }
  c.skip(defined * 4);
}

function readFolder(c: Cursor): Folder {
  const numCoders = readNumber(c);
  if (numCoders < 1 || numCoders > MAX_CODERS) {
    throw new Undetermined('a folder has an unexpected number of coders');
  }
  const coders: Coder[] = [];
  let totalIn = 0;
  let totalOut = 0;
  for (let i = 0; i < numCoders; i++) {
    const flag = c.u8();
    if (flag & 0x80) {
      throw new Undetermined('alternative methods are not supported');
    }
    const id = hexId(c.take(flag & 0x0f));
    let ins = 1;
    let outs = 1;
    if (flag & 0x10) {
      ins = readNumber(c);
      outs = readNumber(c);
    }
    totalIn += ins;
    totalOut += outs;
    if (totalIn > MAX_STREAMS || totalOut > MAX_STREAMS) {
      throw new Undetermined('a folder has too many streams');
    }
    const coder: Coder = { id };
    if (flag & 0x20) {
      const size = readNumber(c);
      const props = c.take(size);
      // Only the first byte of an AES coder's properties is read: its salt and IV never are.
      if (id === AES_ID && props.length > 0) {
        coder.cyclesPower = props[0] & 0x3f;
      }
    }
    coders.push(coder);
  }
  const bindPairs = totalOut - 1;
  if (bindPairs < 0) {
    throw new Undetermined('a folder has no output stream');
  }
  for (let i = 0; i < bindPairs; i++) {
    readNumber(c);
    readNumber(c);
  }
  const packed = totalIn - bindPairs;
  if (packed < 1) {
    throw new Undetermined('a folder has no packed stream');
  }
  if (packed > 1) {
    for (let i = 0; i < packed; i++) {
      readNumber(c);
    }
  }
  return { coders };
}

/** A StreamsInfo up to the end of its UnpackInfo (the folders), which is all that is needed. */
function readStreamsInfo(c: Cursor): Streams {
  for (let guard = 0; guard < MAX_PROPERTIES; guard++) {
    const id = c.u8();
    if (id === 0x00) {
      return { folders: [], folderCount: 0 };
    }
    if (id === 0x06) {
      readNumber(c);
      const n = readNumber(c);
      if (n > MAX_PACK_STREAMS) {
        throw new Undetermined('there are too many pack streams');
      }
      for (let p = 0; p < MAX_PROPERTIES; p++) {
        const prop = c.u8();
        if (prop === 0x00) {
          break;
        }
        if (prop === 0x09) {
          for (let i = 0; i < n; i++) {
            readNumber(c);
          }
        } else if (prop === 0x0a) {
          skipDigests(c, n);
        } else {
          throw new Undetermined('unknown pack property');
        }
      }
    } else if (id === 0x07) {
      if (c.u8() !== 0x0b) {
        throw new Undetermined('folders are missing');
      }
      const total = readNumber(c);
      if (c.u8() !== 0) {
        throw new Undetermined('folders are stored outside the header');
      }
      const folders: Folder[] = [];
      for (let i = 0; i < Math.min(total, MAX_FOLDERS); i++) {
        folders.push(readFolder(c));
      }
      return { folders, folderCount: total };
    } else {
      // A SubStreamsInfo or anything else before the folders is not expected.
      throw new Undetermined('unexpected stream property');
    }
  }
  throw new Undetermined('too many properties');
}

function methodName(id: string): string {
  return Object.hasOwn(METHODS, id) ? METHODS[id] : `method ${id || 'unknown'}`;
}

function kdfLabel(folders: Folder[]): string {
  for (const f of folders) {
    for (const coder of f.coders) {
      if (coder.id === AES_ID) {
        const p = coder.cyclesPower;
        return p !== undefined && p <= MAX_CYCLES_POWER ? `SHA-256, 2^${p} rounds` : NOT_DETERMINED;
      }
    }
  }
  return NOT_DETERMINED;
}

/** The main streams of a readable header, or undefined when the archive stores no data. */
function plainHeader(c: Cursor): Streams | undefined {
  for (let guard = 0; guard < MAX_PROPERTIES; guard++) {
    const id = c.u8();
    if (id === 0x00 || id === 0x05) {
      return undefined;
    }
    if (id === 0x02) {
      for (let p = 0; p < MAX_PROPERTIES; p++) {
        if (c.u8() === 0x00) {
          break;
        }
        c.skip(readNumber(c));
      }
    } else if (id === 0x04) {
      return readStreamsInfo(c);
    } else {
      throw new Undetermined('additional streams come before the data streams');
    }
  }
  throw new Undetermined('too many properties');
}

function entryRows(streams: Streams | undefined): [string, string][] {
  if (!streams || streams.folderCount === 0) {
    return [['Entries', 'not encrypted (no stored data)']];
  }
  const seen = streams.folders.length;
  const partial = streams.folderCount > seen;
  const encrypted = streams.folders.filter((f) => f.coders.some((k) => k.id === AES_ID));
  if (encrypted.length === 0) {
    return [
      [
        'Entries',
        partial
          ? `not encrypted in the first ${count(seen)} of ${count(streams.folderCount)} data blocks`
          : 'not encrypted',
      ],
    ];
  }
  return [
    [
      'Entries',
      encrypted.length === seen && !partial
        ? 'encrypted (AES-256)'
        : `encrypted (AES-256) in ${count(encrypted.length)} of ${count(partial ? streams.folderCount : seen)} data blocks${partial ? ` (the first ${count(seen)} read)` : ''}`,
    ],
    ['Key derivation', kdfLabel(encrypted)],
  ];
}

/** What the archive declares, as rows. Never throws. */
export async function readSevenZip(reader: RangeReader): Promise<PackageInfo> {
  const warnings: string[] = [];
  const rows: [string, string][] = [];
  try {
    const head = new Cursor(await reader.bytes(0, Math.min(reader.size, START_HEADER)));
    head.skip(6);
    const major = head.u8();
    const minor = head.u8();
    rows.push(['Format version', `${major}.${minor}`]);
    head.skip(4);
    const offset = head.u64le();
    const size = head.u64le();
    if (size === 0) {
      rows.push(['Entries', 'none (an empty archive)']);
    } else if (START_HEADER + offset + size > reader.size) {
      rows.push(['Entry encryption', `${NOT_DETERMINED} (the archive is cut short)`]);
    } else {
      const bytes = await reader.bytes(START_HEADER + offset, Math.min(size, MAX_HEADER_BYTES));
      const c = new Cursor(bytes);
      const kind = c.u8();
      if (kind === 0x17) {
        const first = readStreamsInfo(c).folders.slice(0, 1);
        const coders = first[0]?.coders ?? [];
        rows.push(['Header', `encoded (${coders.map((k) => methodName(k.id)).join(', ')})`]);
        if (coders.some((k) => k.id === AES_ID)) {
          rows.push(['File names', 'encrypted (AES-256)']);
          rows.push(['Key derivation', kdfLabel(first)]);
          rows.push(['Entries', `${NOT_DETERMINED} (the header is encrypted)`]);
        } else {
          rows.push(['Entry encryption', `${NOT_DETERMINED} (the header is compressed)`]);
        }
      } else if (kind === 0x01) {
        rows.push(['Header', 'not encoded']);
        rows.push(['File names', 'not encrypted (the header is readable)']);
        rows.push(...entryRows(plainHeader(c)));
      } else {
        rows.push([
          'Entry encryption',
          `${NOT_DETERMINED} (the header is not one this reader knows)`,
        ]);
      }
    }
  } catch {
    rows.push(['Entry encryption', `${NOT_DETERMINED} (the header could not be read to the end)`]);
    warnings.push('Part of the 7-Zip header could not be read, so some labels are not determined.');
  }
  const encryptedNames = rows.some((r) => r[0] === 'File names' && r[1].startsWith('encrypted'));
  return {
    format: '7-Zip archive',
    summary: encryptedNames
      ? 'A 7-Zip archive with an encrypted header: file names are hidden.'
      : 'A 7-Zip archive. The labels below come from its header only.',
    sections: propertySection('Encryption', rows, ENCRYPTION_NOTE),
    warnings,
  };
}
