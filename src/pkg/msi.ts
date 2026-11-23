// A Windows Installer package (.msi), described from its tables without
// installing, running or unpacking anything.
//
// An MSI is an OLE compound file (cfb.ts) holding a relational database. Each
// table is one stream, stored column by column, and every string in it is a
// small number into a shared pool (_StringPool and _StringData). Stream names
// are packed: the characters of a name are squeezed two to a UTF-16 unit.
//
// Only the facts that identify a package are read: the Summary Information
// stream, the Property table, and the size of every other table, which with
// the column types in _Columns gives its row count without reading a row.
import { formatBytes, formatNumber } from '../binary/html';
import { ReadError, type RangeReader } from '../binary/reader';
import { printable } from '../binary/text';
import { asciiLower } from './ascii';
import { openCfb, STREAM, type Cfb, type CfbEntry } from './cfb';
import { propertySection, rows, tableSection, type InfoSection, type PackageInfo } from './model';
import { isSignedData, readSigner, signatureSection, signerCount } from './signature';

const CLSID_MSI = '{000C1084-0000-0000-C000-000000000046}';
const CLSID_TRANSFORM = '{000C1082-0000-0000-C000-000000000046}';
const CLSID_PATCH = '{000C1086-0000-0000-C000-000000000046}';

// The string data of a large installer is a few megabytes. 16 MiB leaves room
// for any real one and bounds what a hostile pool can make us hold.
const MAX_STRING_DATA = 16 * 1024 * 1024;
// A pool entry is 4 bytes, so this is an 8 MiB pool.
const MAX_POOL_ENTRIES = 2 * 1024 * 1024;
// _Columns has a row per column of every table: about a thousand for the
// standard schema, a few thousand with custom tables.
const MAX_COLUMNS_STREAM = 4 * 1024 * 1024;
const MAX_PROPERTY_STREAM = 4 * 1024 * 1024;
const MAX_SUMMARY_STREAM = 1024 * 1024;
const MAX_SIGNATURE_STREAM = 256 * 1024;
// Summary properties: the standard set is under 20.
const MAX_SUMMARY_PROPERTIES = 64;
// A property value or name is a line; anything longer is not one.
const MAX_STRING_CHARS = 2048;
const MAX_LISTED_STREAMS = 200;
// Property rows read. A real package has a few hundred; the stream cap alone
// would allow a million.
const MAX_PROPERTIES = 5000;
// _Columns rows read: about a thousand for the standard schema. Past this the
// row widths cannot be trusted, so counts fall back to presence.
const MAX_COLUMN_ROWS = 50000;
// Characters of decoded pool strings held in all. Each string is decoded once
// and kept, so this is what a package's strings can cost, however many rows
// name them. Real packages use well under a tenth of it.
const MAX_DECODED_CHARS = 2 * 1024 * 1024;
// Table and column names are identifiers.
const MAX_NAME_CHARS = 128;
// Streams kept for the Embedded files list, per kind. The rest are counted.
const MAX_KEPT_ROWS = 200;

const SUMMARY_NAME = String.fromCharCode(5) + 'SummaryInformation';
const SIGNATURE_NAME = String.fromCharCode(5) + 'DigitalSignature';
const SIGNATURE_EX_NAME = String.fromCharCode(5) + 'MsiDigitalSignatureEx';

// Names are 64 symbols packed into UTF-16 units; this is their order.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._';
const TABLE_PREFIX = 0x4840;

/** What a stored stream name says: the real name, and whether it is a table. */
export function decodeStreamName(stored: string): { name: string; table: boolean } {
  let name = '';
  let table = false;
  for (let i = 0; i < stored.length; i++) {
    const unit = stored.charCodeAt(i);
    if (unit === TABLE_PREFIX && i === 0) {
      table = true;
    } else if (unit >= 0x3800 && unit < 0x4800) {
      const value = unit - 0x3800;
      name += ALPHABET[value & 0x3f] + ALPHABET[(value >> 6) & 0x3f];
    } else if (unit >= 0x4800 && unit < 0x4840) {
      name += ALPHABET[unit - 0x4800];
    } else {
      name += stored[i];
    }
  }
  return { name, table };
}

function decoderFor(codePage: number): TextDecoder {
  const label =
    codePage === 65001
      ? 'utf-8'
      : codePage >= 1250 && codePage <= 1258
        ? `windows-${codePage}`
        : codePage === 932
          ? 'shift_jis'
          : codePage === 936
            ? 'gbk'
            : codePage === 949
              ? 'euc-kr'
              : codePage === 950
                ? 'big5'
                : 'windows-1252';
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder('latin1');
  }
}

function clean(text: string): string {
  return printable(text.length > MAX_STRING_CHARS ? text.slice(0, MAX_STRING_CHARS) : text);
}

function utc(ms: number): string | undefined {
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  const date = new Date(ms);
  // Dates before 1980 or after 2200 are an unset field or a damaged one.
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() < 1980 ||
    date.getUTCFullYear() > 2200
  ) {
    return undefined;
  }
  return date.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}

// ---- Summary Information: an OLE property set --------------------------------

type SummaryValue = string | number;

function readSummary(bytes: Uint8Array): Map<number, SummaryValue> {
  const out = new Map<number, SummaryValue>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (at: number, length: number): boolean => at >= 0 && at + length <= view.byteLength;
  // Header: byte order, version, OS, CLSID, section count; then FMTID and offset per section.
  if (!has(0, 48) || view.getUint16(0, true) !== 0xfffe || view.getUint32(24, true) < 1) {
    return out;
  }
  const section = view.getUint32(44, true);
  if (!has(section, 8)) {
    return out;
  }
  const count = Math.min(view.getUint32(section + 4, true), MAX_SUMMARY_PROPERTIES);
  let codePage = 1252;
  const pending: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const at = section + 8 + i * 8;
    if (!has(at, 8)) {
      break;
    }
    pending.push([view.getUint32(at, true), section + view.getUint32(at + 4, true)]);
  }
  // Property 1 is the code page of the narrow strings, so it is read first.
  const sorted = [...pending].sort((a, b) => (a[0] === 1 ? -1 : b[0] === 1 ? 1 : 0));
  for (const [id, at] of sorted) {
    if (!has(at, 4)) {
      continue;
    }
    const type = view.getUint32(at, true);
    if (type === 2 && has(at + 4, 2)) {
      const value = view.getUint16(at + 4, true);
      if (id === 1) {
        codePage = value;
      }
      out.set(id, value);
    } else if (type === 3 && has(at + 4, 4)) {
      out.set(id, view.getUint32(at + 4, true));
    } else if (type === 30 && has(at + 4, 4)) {
      const length = view.getUint32(at + 4, true);
      if (length <= 65536 && has(at + 8, length)) {
        let slice = bytes.subarray(at + 8, at + 8 + Math.min(length, MAX_STRING_CHARS * 4));
        const nul = slice.indexOf(0);
        slice = nul < 0 ? slice : slice.subarray(0, nul);
        out.set(id, clean(decoderFor(codePage).decode(slice)));
      }
    } else if (type === 31 && has(at + 4, 4)) {
      const chars = view.getUint32(at + 4, true);
      if (chars <= 32768 && has(at + 8, chars * 2)) {
        const slice = bytes.subarray(at + 8, at + 8 + Math.min(chars, MAX_STRING_CHARS) * 2);
        out.set(id, clean(new TextDecoder('utf-16le').decode(slice).replace(/\0.*$/s, '')));
      }
    } else if (type === 64 && has(at + 4, 8)) {
      const ticks = view.getUint32(at + 4, true) + view.getUint32(at + 8, true) * 4294967296;
      // 100 ns ticks since 1601-01-01; 0 means unset.
      const text = ticks > 0 ? utc(ticks / 10000 - 11644473600000) : undefined;
      if (text) {
        out.set(id, text);
      }
    }
  }
  return out;
}

// ---- The database: string pool and tables ------------------------------------

interface Strings {
  /** Bytes per string reference in a table: 2, or 3 for a pool of more than 64K strings. */
  width: number;
  /** The string with this ID, cut to `max` characters; decoded once and kept. */
  get(id: number, max?: number): string;
  /** True once the budget of decoded characters ran out and later strings came back empty. */
  readonly exhausted: boolean;
}

function readPool(pool: Uint8Array, data: Uint8Array): Strings {
  const view = new DataView(pool.buffer, pool.byteOffset, pool.byteLength);
  const entries = Math.min(Math.floor(pool.length / 4), MAX_POOL_ENTRIES);
  // The header's two words are the code page (low) and flags (high); the top
  // flag bit is the 3-byte reference width, the rest extend the code page.
  const codePage =
    entries > 0 ? view.getUint16(0, true) | ((view.getUint16(2, true) & 0x7fff) << 16) : 0;
  const width = entries > 0 && (view.getUint16(2, true) & 0x8000) !== 0 ? 3 : 2;
  const decoder = decoderFor(codePage);
  // Strings are decoded on demand: a pool can hold hundreds of thousands.
  // Logical string IDs are counted apart from the 4 byte records: a string over
  // 64 KB takes two records but one ID (Wine's msi_load_string_table does the
  // same), and an empty record (two zero words) still takes an ID.
  const start = new Float64Array(entries);
  const length = new Float64Array(entries);
  let offset = 0;
  let count = 1;
  for (let i = 1; i < entries; count++) {
    const size = view.getUint16(i * 4, true);
    const refs = view.getUint16(i * 4 + 2, true);
    let len = size;
    if (size === 0 && refs === 0) {
      i++;
      continue;
    }
    if (size === 0) {
      // A long string: [0, reference count] then [length low, length high].
      if (i + 1 >= entries) {
        break;
      }
      len = view.getUint16((i + 1) * 4, true) + view.getUint16((i + 1) * 4 + 2, true) * 65536;
      i += 2;
    } else {
      i++;
    }
    start[count] = offset;
    length[count] = len;
    offset += len;
  }
  // One cache per cut length, so a table name (short) never poisons a value.
  const caches = new Map<number, Map<number, string>>();
  let budget = MAX_DECODED_CHARS;
  const strings: Strings = {
    width,
    exhausted: false,
    get(id, max = MAX_STRING_CHARS) {
      if (id <= 0 || id >= count || start[id] + length[id] > data.length) {
        return '';
      }
      let cache = caches.get(max);
      if (!cache) {
        cache = new Map();
        caches.set(max, cache);
      }
      const known = cache.get(id);
      if (known !== undefined) {
        return known;
      }
      if (budget <= 0) {
        (strings as { exhausted: boolean }).exhausted = true;
        return '';
      }
      // Decode only the bytes that can be kept (4 per character covers UTF-8).
      const slice = data.subarray(start[id], start[id] + Math.min(length[id], max * 4));
      const text = printable(decoder.decode(slice).slice(0, max));
      budget -= text.length + 1;
      cache.set(id, text);
      return text;
    },
  };
  return strings;
}

/** Column-major integer reads, 2 bytes or 3 for string references. */
function readRefs(bytes: Uint8Array, at: number, width: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = at + i * width;
    out.push(bytes[p] | (bytes[p + 1] << 8) | (width === 3 ? bytes[p + 2] << 16 : 0));
  }
  return out;
}

/** Bytes per row of each table, from _Columns; undefined when a table's columns are not understood. */
function rowWidths(columns: Uint8Array, strings: Strings): Map<string, number | undefined> {
  const width = strings.width;
  const count = Math.floor(columns.length / (2 * width + 4));
  if (count > MAX_COLUMN_ROWS) {
    return new Map();
  }
  const tables = readRefs(columns, 0, width, count);
  const types = new DataView(columns.buffer, columns.byteOffset, columns.byteLength);
  // Layout, column-major: Table[count], Number[count], Name[count], Type[count].
  const typesStart = count * (2 * width + 2);
  const out = new Map<string, number | undefined>();
  for (let i = 0; i < count; i++) {
    const name = strings.get(tables[i], MAX_NAME_CHARS);
    if (!name) {
      continue;
    }
    // Integers are stored with 0x8000 added.
    const stored = types.getUint16(typesStart + i * 2, true);
    const type = stored >= 0x8000 ? stored - 0x8000 : stored;
    let bytes: number | undefined;
    if ((type & ~0x1000) === 0x0900) {
      // A binary column holds a 2 byte key to a stream, not data.
      bytes = 2;
    } else if (type & 0x0800) {
      bytes = width;
    } else if ((type & 0xff) === 2 || (type & 0xff) === 4) {
      bytes = type & 0xff;
    }
    const before = out.has(name) ? out.get(name) : 0;
    out.set(name, bytes === undefined || before === undefined ? undefined : before + bytes);
  }
  return out;
}

const PLATFORMS: Record<string, string> = {
  intel: 'x86 (32-bit)',
  x64: 'x64 (64-bit)',
  amd64: 'x64 (64-bit)',
  intel64: 'Itanium (64-bit)',
  arm: 'ARM (32-bit)',
  arm64: 'ARM64 (64-bit)',
};

// The languages installers most often declare. Anything else shows its number.
const LANGUAGES: Record<number, string> = {
  0: 'Neutral',
  1025: 'Arabic',
  1028: 'Chinese (Traditional)',
  1029: 'Czech',
  1030: 'Danish',
  1031: 'German',
  1032: 'Greek',
  1033: 'English (US)',
  1034: 'Spanish',
  1035: 'Finnish',
  1036: 'French',
  1037: 'Hebrew',
  1038: 'Hungarian',
  1040: 'Italian',
  1041: 'Japanese',
  1042: 'Korean',
  1043: 'Dutch',
  1044: 'Norwegian',
  1045: 'Polish',
  1046: 'Portuguese (Brazil)',
  1049: 'Russian',
  1053: 'Swedish',
  1055: 'Turkish',
  1058: 'Ukrainian',
  2052: 'Chinese (Simplified)',
  2057: 'English (UK)',
  3082: 'Spanish',
};

function languages(list: string | undefined): string | undefined {
  if (!list) {
    return undefined;
  }
  return list
    .split(',')
    .slice(0, 40)
    .map((part) => {
      const id = Number(part.trim());
      return Number.isInteger(id)
        ? LANGUAGES[id]
          ? `${LANGUAGES[id]} (${id})`
          : String(id)
        : part;
    })
    .join(', ');
}

function installerVersion(value: number | undefined): string | undefined {
  if (value === undefined || value <= 0 || value > 9999) {
    return undefined;
  }
  const minor = value % 100;
  return `${Math.floor(value / 100)}.${minor >= 10 && minor % 10 === 0 ? minor / 10 : minor}`;
}

// The summary information means different things in an installation package, a
// transform and a patch, so each row follows the definition for the kind of file
// in hand. From Microsoft's "Summary Property Descriptions" page and the page of
// each property (all under learn.microsoft.com/en-us/windows/win32/msi/):
//   Title, Comments, Create/Last Saved Time, Creating Application (same idea for
//     all three kinds; shown as they are)
//   Subject (subject-summary):
//     package    the product name, the same as ProductName
//     transform  the product name of the original package
//     patch      "a short description of the patch that includes the name of the product"
//   Author: the manufacturer of the package, the transform or the patch
//   Keywords (keywords-summary):
//     package, transform  a list of keywords
//     patch      "a semicolon-delimited list of network or URL locations for the
//                sources of the patch"
//   Template (template-summary):
//     package    the platform and languages, "[platform];[language id],[language id]"
//     transform  the platform and one language the transform can be applied to; either may be blank
//     patch      "a semicolon-delimited list of the product codes that can accept the patch"
//   Last Saved By (last-saved-by-summary):
//     package    a tool or LogonUser note, "never used by the installer"; not shown
//     transform  the platform and language ID(s) the database has after the transform
//     patch      "a semicolon-delimited list of transform substorage names in the order
//                they are applied by this patch"
//   Revision Number (revision-number-summary):
//     package    the package code
//     transform  "Original-Product-Code Original-Product-Version ; New-Product Code
//                New-Product-Version; Upgrade-Code"
//     patch      the patch code GUID, "followed by a list of patch code GUIDs for obsolete
//                patches", "concatenated with no delimiters"
//   Page Count (page-count-summary):
//     package    the minimum installer version, as 200 for 2.0 or 301 for 3.1
//     transform  the minimum installer version to process the transform
//     patch      "set to Null"
//   Word Count (word-count-summary):
//     package    a bit field: 1 short file names, 2 compressed, 4 administrative image,
//                8 elevated privileges not required
//     transform  "should be Null"
//     patch      the minimum installer version: 1 "the default value, which indicates that
//                MSPATCH was used to create the patch", 2 is 1.2, 3 is 2.0, 4 is 3.0, 5 is 3.1
//   Character Count (character-count-summary):
//     transform  the upper 16-bit word holds the transform validation flags and the
//                lower word the transform error condition flags
//     package, patch  "should be Null"
//   Security: not shown.
// A file whose root CLSID is not one of the three keeps the package reading.
type SummaryKind = 'package' | 'transform' | 'patch';

const PATCH_WORD_COUNT: Record<number, string> = {
  1: 'Not stated (Word Count 1, the default: MSPATCH was used to create the patch)',
  2: '1.2',
  3: '2.0',
  4: '3.0',
  5: '3.1',
};

const MAX_LIST_ITEMS = 50;
const GUID = /\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}/g;

function semicolonList(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const items = value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (items.length === 0) {
    return undefined;
  }
  const shown = items.slice(0, MAX_LIST_ITEMS).join(', ');
  return items.length > MAX_LIST_ITEMS
    ? `${shown} (and ${formatNumber(items.length - MAX_LIST_ITEMS)} more)`
    : shown;
}

/**
 * Whether a patch carries the sequencing data that replaces its legacy obsolete
 * list. Microsoft's Revision Number Summary page: "If there is sequencing
 * information present in the MsiPatchSequence table, Windows Installer 3.0 uses
 * the sequencing information in the table and ignores the list of obsolete
 * patches included in the Revision Number Summary property. Windows Installer
 * 3.0 can still use the obsolete patch information in the Revision Number
 * Summary property if the package does not contain a MsiPatchSequence table."
 */
type PatchSequence = 'rows' | 'none' | 'unknown';

const LEGACY_OBSOLETE = 'Obsolete patches (legacy list in the summary)';

function obsoleteNote(sequence: PatchSequence): string {
  return sequence === 'rows'
    ? 'Windows Installer 3.0 and later ignore this list, because this patch has sequencing information in an MsiPatchSequence table'
    : sequence === 'none'
      ? 'used when the patch has no MsiPatchSequence sequencing information, and this patch has none'
      : 'Windows Installer 3.0 and later ignore this list when the patch has MsiPatchSequence sequencing information, and whether this one has could not be read';
}

/** A patch's Revision Number: the patch code, then the legacy list of patches it obsoletes. */
function patchCodes(
  value: string | undefined,
  sequence: PatchSequence,
): [string, string | undefined][] {
  if (!value) {
    return [];
  }
  const trimmed = value.trim();
  const guids = trimmed.match(GUID) ?? [];
  if (guids.length === 0 || guids.join('').length !== trimmed.length) {
    // Not the documented layout: show it as it is.
    return [['Revision number (from the summary)', trimmed]];
  }
  const obsolete = guids.slice(1);
  const listed =
    obsolete.length > MAX_LIST_ITEMS
      ? `${obsolete.slice(0, MAX_LIST_ITEMS).join(', ')} (and ${formatNumber(obsolete.length - MAX_LIST_ITEMS)} more)`
      : obsolete.join(', ');
  return [
    ['Patch code', guids[0]],
    [LEGACY_OBSOLETE, listed ? `${listed} (${obsoleteNote(sequence)})` : undefined],
  ];
}

/** A transform's Revision Number: original product, new product, upgrade code. */
function transformProducts(value: string | undefined): [string, string | undefined][] {
  if (!value) {
    return [];
  }
  const parts = value.split(';', 4).map((part) => part.trim());
  if (parts.length !== 3) {
    return [['Revision number (from the summary)', value.trim()]];
  }
  return [
    ['Original product (code and version)', parts[0] || undefined],
    ['New product (code and version)', parts[1] || undefined],
    ['Upgrade code', parts[2] || undefined],
  ];
}

const hex16 = (value: number): string => `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;

// Tables worth counting, and what a row of each is.
const COUNTED: [table: string, label: string][] = [
  ['File', 'File table rows'],
  ['Component', 'Component table rows'],
  ['Feature', 'Feature table rows'],
  ['Registry', 'Registry table rows'],
  ['Shortcut', 'Shortcut table rows'],
  ['ServiceInstall', 'ServiceInstall table rows'],
  ['CustomAction', 'CustomAction table rows'],
  ['LaunchCondition', 'LaunchCondition table rows'],
];

async function tryRead(
  cfb: Cfb,
  entry: CfbEntry | undefined,
  max: number,
): Promise<Uint8Array | undefined> {
  if (!entry) {
    return undefined;
  }
  try {
    return await cfb.readStream(entry, max);
  } catch (error) {
    if (error instanceof ReadError) {
      return undefined;
    }
    throw error;
  }
}

export async function readMsi(reader: RangeReader): Promise<PackageInfo> {
  const cfb = await openCfb(reader);
  const warnings: string[] = [];

  // Only the tables read below are remembered: a hostile directory can name
  // 65,000 of them.
  const wanted = new Set([
    '_StringPool',
    '_StringData',
    '_Columns',
    'Property',
    'Binary',
    'ModuleSignature',
    'MsiPatchSequence',
    'ModuleComponents',
    ...COUNTED.map(([table]) => table),
  ]);
  const tables = new Map<string, CfbEntry>();
  // WiX names its cabinet streams "Name.cab" or "Name.CABinet".
  const cabinet = /\.cab(inet)?$/i;
  const groups: { label: string; test: RegExp; count: number; size: number }[] = [
    { label: 'custom action binaries (Binary.*)', test: /^Binary\./, count: 0, size: 0 },
    { label: 'icons (Icon.*)', test: /^Icon\./, count: 0, size: 0 },
    {
      label: 'signature certificates and hashes (MsiDigital*)',
      test: /^MsiDigital/,
      count: 0,
      size: 0,
    },
  ];
  // Rows for the Embedded files list are kept only up to a cap; the rest are counted.
  const cabinetRows: string[][] = [];
  const otherRows: string[][] = [];
  let cabinetCount = 0;
  let otherCount = 0;
  let summaryEntry: CfbEntry | undefined;
  let signatureEntry: CfbEntry | undefined;
  let signatureEx = false;
  let storages = 0;
  for (const entry of cfb.entries) {
    if (entry.type !== STREAM) {
      storages++;
      continue;
    }
    if (entry.name === SUMMARY_NAME) {
      summaryEntry = entry;
    } else if (entry.name === SIGNATURE_NAME) {
      signatureEntry = entry;
    } else if (entry.name === SIGNATURE_EX_NAME) {
      signatureEx = true;
    } else {
      const decoded = decodeStreamName(entry.name);
      if (decoded.table) {
        if (wanted.has(decoded.name)) {
          tables.set(decoded.name, entry);
        }
        continue;
      }
      const name = printable(decoded.name);
      const group = groups.find((g) => g.test.test(name));
      if (cabinet.test(name)) {
        cabinetCount++;
        if (cabinetRows.length < MAX_KEPT_ROWS) {
          cabinetRows.push([name, formatBytes(entry.size)]);
        }
      } else if (group) {
        group.count++;
        group.size += entry.size;
      } else {
        otherCount++;
        if (otherRows.length < MAX_KEPT_ROWS) {
          otherRows.push([name, formatBytes(entry.size)]);
        }
      }
    }
  }

  // The root CLSID names the kind of storage (Windows Installer's registered
  // classes for a package, a patch and a transform). A file with an unrecognised
  // CLSID but a string pool is called a database, which is all that is known.
  // Whether a package is really a merge module is decided below, once the tables
  // are counted.
  const patchOrTransform = cfb.rootClsid === CLSID_PATCH || cfb.rootClsid === CLSID_TRANSFORM;
  let kind: string | undefined =
    cfb.rootClsid === CLSID_PATCH
      ? 'Windows Installer patch'
      : cfb.rootClsid === CLSID_TRANSFORM
        ? 'Windows Installer transform'
        : cfb.rootClsid === CLSID_MSI
          ? 'Windows Installer package'
          : tables.has('_StringPool')
            ? 'Windows Installer database'
            : undefined;
  if (!kind) {
    throw new ReadError('it is an OLE compound file, but not a Windows Installer package.');
  }
  if (cfb.truncated) {
    warnings.push('The file lists more streams than MarkCopy reads, so some are left out.');
  }

  // Summary Information.
  let summary = new Map<number, SummaryValue>();
  const summaryBytes = await tryRead(cfb, summaryEntry, MAX_SUMMARY_STREAM);
  if (summaryBytes) {
    summary = readSummary(summaryBytes);
  } else if (summaryEntry) {
    warnings.push('The summary information could not be read.');
  }
  const text = (id: number): string | undefined => {
    const value = summary.get(id);
    return typeof value === 'string' ? value : undefined;
  };
  const num = (id: number): number | undefined => {
    const value = summary.get(id);
    return typeof value === 'number' ? value : undefined;
  };

  // The database.
  const properties = new Map<string, string>();
  let propertyRows = 0;
  const counts = new Map<string, number>();
  let strings: Strings | undefined;
  const poolEntry = tables.get('_StringPool');
  const dataEntry = tables.get('_StringData');
  if (poolEntry && dataEntry) {
    const pool = await tryRead(cfb, poolEntry, MAX_POOL_ENTRIES * 4);
    const data = await tryRead(cfb, dataEntry, MAX_STRING_DATA);
    if (pool && data) {
      strings = readPool(pool, data);
    } else {
      warnings.push('The string table could not be read, so the installer database is not shown.');
    }
  } else if (!patchOrTransform) {
    warnings.push('The package has no string table, so its database is not shown.');
  }

  if (strings) {
    const propertyEntry = tables.get('Property');
    const bytes = await tryRead(cfb, propertyEntry, MAX_PROPERTY_STREAM);
    if (bytes) {
      const n = Math.floor(bytes.length / (2 * strings.width));
      const read = Math.min(n, MAX_PROPERTIES);
      const names = readRefs(bytes, 0, strings.width, read);
      const values = readRefs(bytes, n * strings.width, strings.width, read);
      for (let i = 0; i < read; i++) {
        const name = strings.get(names[i], MAX_NAME_CHARS);
        if (name) {
          properties.set(name, strings.get(values[i]));
        }
      }
      propertyRows = n;
    } else if (propertyEntry) {
      warnings.push('The Property table could not be read.');
    }

    const columnsBytes = await tryRead(cfb, tables.get('_Columns'), MAX_COLUMNS_STREAM);
    if (columnsBytes) {
      const widths = rowWidths(columnsBytes, strings);
      for (const table of [
        ...COUNTED.map(([name]) => name),
        'ModuleSignature',
        'MsiPatchSequence',
      ]) {
        const entry = tables.get(table);
        const width = widths.get(table);
        if (entry && width) {
          if (entry.size % width === 0) {
            counts.set(table, entry.size / width);
          }
        } else if (!entry && widths.has(table)) {
          // A declared table with no stream has no rows.
          counts.set(table, 0);
        }
      }
    }
  }

  // Microsoft's "Merge Module Database" and "ModuleSignature Table" pages: a
  // standalone module has exactly one ModuleSignature row, has ModuleComponents,
  // and "does not contain a Feature table" (so it "cannot be installed alone");
  // an installer that has had modules merged in has one ModuleSignature row per
  // module, and also has a Feature table and a ProductCode. So a package is
  // called a merge module only with the positive evidence and none of the
  // contrary evidence; anything else stays a package.
  const mergedModules = counts.get('ModuleSignature');
  if (
    kind === 'Windows Installer package' &&
    mergedModules === 1 &&
    tables.has('ModuleComponents') &&
    !tables.has('Feature') &&
    !properties.has('ProductCode')
  ) {
    kind = 'Windows Installer merge module';
  }

  if (propertyRows > MAX_PROPERTIES) {
    warnings.push(
      `The Property table has ${formatNumber(propertyRows)} rows; only the first ${formatNumber(MAX_PROPERTIES)} were read.`,
    );
  }
  if (strings?.exhausted) {
    warnings.push('The package holds more text than MarkCopy reads, so some values are left out.');
  }

  // Package section.
  // Each summary row follows the definition for the kind of file (see the table
  // above SummaryKind). A patch's Template lists the product codes it applies to,
  // not a platform.
  const summaryKind: SummaryKind =
    cfb.rootClsid === CLSID_PATCH
      ? 'patch'
      : cfb.rootClsid === CLSID_TRANSFORM
        ? 'transform'
        : 'package';
  const isPatch = summaryKind === 'patch';
  const isTransform = summaryKind === 'transform';
  const isPackage = summaryKind === 'package';
  // A table with no stream has no rows; one whose stream could not be measured is not known.
  const sequenceRows = counts.get('MsiPatchSequence');
  const patchSequence: PatchSequence = !tables.has('MsiPatchSequence')
    ? 'none'
    : sequenceRows === undefined
      ? 'unknown'
      : sequenceRows > 0
        ? 'rows'
        : 'none';
  const template = text(7);
  const [platformText, languageText] = template && !isPatch ? template.split(';') : [];
  const platform = platformText
    ? (PLATFORMS[asciiLower(platformText.trim())] ?? platformText)
    : undefined;
  const words = num(15);
  const pages = num(14);
  const subject = text(3);
  const characters = num(16);
  const allUsers = properties.get('ALLUSERS');
  // What the Property table declares about the installation context, from
  // Microsoft's ALLUSERS and MSIINSTALLPERUSER pages:
  //   ALLUSERS not set (absent or "")  -> "the system uses the per-user installation context"
  //   ALLUSERS=1                       -> "specifies the per-machine installation context"
  //   ALLUSERS=2                       -> the installer resets ALLUSERS and picks the context from
  //                                       the user's privileges and the Windows version; with
  //                                       Windows Installer 5.0 (Windows 7 and later) the
  //                                       MSIINSTALLPERUSER property decides:
  //     MSIINSTALLPERUSER=1            -> requests per-user
  //     MSIINSTALLPERUSER="" (empty)   -> requests per-machine
  //     MSIINSTALLPERUSER absent       -> not stated; privileges and Windows version decide
  //     MSIINSTALLPERUSER, any value, with ALLUSERS other than 2 -> ignored
  //     MSIINSTALLPERUSER with Windows Installer 4.5 or earlier  -> ignored
  //   any other ALLUSERS value         -> not documented
  // These values can also be set at install time, on the command line or by the
  // package's own logic, so the row states the declaration and nothing more.
  const fromOlder = 'earlier Windows Installer versions ignore MSIINSTALLPERUSER';
  const perUser = properties.get('MSIINSTALLPERUSER');
  // ALLUSERS is a property of an installation package. A patch or a transform
  // that happens to carry a Property table declares no install context of its own.
  const scope =
    !isPackage || properties.size === 0
      ? undefined
      : allUsers === undefined || allUsers === ''
        ? 'ALLUSERS not set: the per-user context'
        : allUsers === '1'
          ? 'ALLUSERS=1: the per-machine context'
          : allUsers !== '2'
            ? `ALLUSERS=${JSON.stringify(allUsers)}: not a documented value`
            : perUser === '1'
              ? `ALLUSERS=2 and MSIINSTALLPERUSER=1: requests per-user (Windows Installer 5.0 and later; ${fromOlder})`
              : perUser === ''
                ? `ALLUSERS=2 and MSIINSTALLPERUSER empty: requests per-machine (Windows Installer 5.0 and later; ${fromOlder})`
                : perUser === undefined
                  ? 'ALLUSERS=2, MSIINSTALLPERUSER not set: dual-purpose, the context depends on the privileges of the user and the Windows version'
                  : `ALLUSERS=2, MSIINSTALLPERUSER=${JSON.stringify(perUser)}: not a documented value`;
  // The Subject is the product name only in a package; in a transform it names
  // the original product and in a patch it describes the patch.
  const productName = properties.get('ProductName') || (isPackage ? subject : undefined);
  const productVersion = properties.get('ProductVersion');
  const manufacturer = properties.get('Manufacturer') || text(4);
  const subjectRow: [string, string | undefined] = isPatch
    ? ['Patch description (from Subject)', subject]
    : isTransform
      ? ['Original product name (from Subject)', subject]
      : ['Subject', subject !== productName ? subject : undefined];
  const flag = (name: string): string | undefined => (properties.has(name) ? 'Yes' : undefined);

  const sections: InfoSection[] = [
    ...propertySection('Package', [
      ['Product name', productName],
      ['Version', productVersion],
      [isPackage ? 'Manufacturer' : 'Author (from the summary)', manufacturer],
      ['Product code', properties.get('ProductCode')],
      ['Upgrade code', properties.get('UpgradeCode')],
      ...(isPatch
        ? patchCodes(text(9), patchSequence)
        : isTransform
          ? transformProducts(text(9))
          : [['Package code', text(9)] as [string, string | undefined]]),
      ['Platform (from the summary template)', platform],
      [
        'Languages',
        isPatch
          ? undefined
          : isTransform
            ? languages(languageText)
            : (languages(languageText) ?? languages(properties.get('ProductLanguage'))),
      ],
      [
        'Applies to product codes (from the summary template)',
        isPatch ? semicolonList(template) : undefined,
      ],
      ['Install scope (from ALLUSERS)', scope],
      // Page Count is the minimum version for a package and to process a transform,
      // and Null in a patch, where Word Count carries it.
      [
        isTransform ? 'Minimum installer version to process' : 'Minimum installer version',
        isPatch ? undefined : installerVersion(pages),
      ],
      [
        'Minimum installer version',
        isPatch && words !== undefined
          ? (PATCH_WORD_COUNT[words] ?? `Word Count ${words}: not a documented value`)
          : undefined,
      ],
      [
        'Elevation (summary flag)',
        !isPackage || words === undefined
          ? undefined
          : (words & 8) !== 0
            ? 'Not required'
            : 'Can be required',
      ],
      [
        'Source files (summary flag)',
        !isPackage || words === undefined
          ? undefined
          : (words & 2) !== 0
            ? 'Compressed'
            : 'Uncompressed',
      ],
      [
        'Source is (summary flag)',
        isPackage && words !== undefined && (words & 4) !== 0
          ? 'An administrative image'
          : undefined,
      ],
      [
        'Transform flags (from Character Count)',
        isTransform && characters !== undefined
          ? `Validation ${hex16(Math.floor(characters / 65536) & 0xffff)}, error conditions ${hex16(characters & 0xffff)} (not decoded)`
          : undefined,
      ],
      [
        'Transforms applied, in order (from Last Saved By)',
        isPatch ? semicolonList(text(8)) : undefined,
      ],
      [
        'Platform and language after the transform (from Last Saved By)',
        isTransform ? text(8) : undefined,
      ],
      ['Created with', text(18)],
      ['Created', text(12)],
      ['Last saved', text(13)],
      subjectRow,
      ['Comments', text(6)],
      isPatch ? ['Patch sources (from Keywords)', semicolonList(text(5))] : ['Keywords', text(5)],
      ['Contact', properties.get('ARPCONTACT')],
      ['Website', properties.get('ARPURLINFOABOUT')],
      ['Help link', properties.get('ARPHELPLINK')],
      ['Description', properties.get('ARPCOMMENTS')],
      ['Reinstall mode', properties.get('REINSTALLMODE')],
      ['Hides Modify', flag('ARPNOMODIFY')],
      ['Hides Remove', flag('ARPNOREMOVE')],
      [
        'Properties in database',
        properties.size > 0 ? formatNumber(Math.max(properties.size, propertyRows)) : undefined,
      ],
    ]),
  ];

  // What it installs: counts where the schema was understood, else presence.
  const installs: [string, string | undefined][] = [];
  for (const [table, label] of COUNTED) {
    const count = counts.get(table);
    if (count !== undefined) {
      installs.push([label, formatNumber(count)]);
    } else if (tables.has(table)) {
      installs.push([label, 'present']);
    }
  }
  if (
    kind !== 'Windows Installer merge module' &&
    mergedModules !== undefined &&
    mergedModules > 0
  ) {
    installs.push(['Merged modules (ModuleSignature rows)', formatNumber(mergedModules)]);
  }
  if (tables.has('Binary')) {
    installs.push(['Binary table', 'present']);
  }
  sections.push(...propertySection('What the tables define', installs));

  // Embedded files: cabinets first, then the groups of small streams that
  // would otherwise bury them (one certificate and one hash per signed cabinet,
  // one icon per shortcut), then anything else.
  const listed: string[][] = [...cabinetRows];
  for (const group of groups) {
    if (group.count > 0) {
      listed.push([`${formatNumber(group.count)} ${group.label}`, formatBytes(group.size)]);
    }
  }
  listed.push(...otherRows);
  let total = listed.length + (cabinetCount - cabinetRows.length) + (otherCount - otherRows.length);
  if (storages > 0) {
    listed.push([`${formatNumber(storages)} embedded storages (transforms or sub-packages)`, '']);
    total++;
  }
  sections.push(
    ...tableSection('Embedded files', ['Stream', 'Size'], listed, {
      limit: MAX_LISTED_STREAMS,
      total,
      noun: 'streams',
    }),
  );

  // Signature. A DigitalSignature stream counts only when it holds PKCS #7
  // SignedData with at least one signer that carries a signature value;
  // anything else is reported as an unrecognised stream, and a lone
  // MsiDigitalSignatureEx (a hash the signature would cover) claims nothing.
  if (signatureEntry) {
    const bytes = await tryRead(cfb, signatureEntry, MAX_SIGNATURE_STREAM);
    if (bytes && isSignedData(bytes) && signerCount(bytes) > 0) {
      const section = signatureSection('Authenticode', readSigner(bytes));
      if (signatureEx) {
        section.rows.push(...rows(['Hash extension', 'MsiDigitalSignatureEx present']));
      }
      sections.push(section);
    } else {
      warnings.push(
        bytes
          ? 'The package has a DigitalSignature stream that is not a recognised signature, so no signature is reported.'
          : 'The package has a DigitalSignature stream that could not be read, so no signature is reported.',
      );
    }
  }

  const name = productName ?? (isPackage ? undefined : subject);
  return {
    format: kind,
    title: name ? `${name}${productVersion ? ' ' + productVersion : ''}` : undefined,
    summary: manufacturer || text(3) || text(6),
    sections,
    warnings,
  };
}
