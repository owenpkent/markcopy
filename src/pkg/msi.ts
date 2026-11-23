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
import { openCfb, STREAM, type Cfb, type CfbEntry } from './cfb';
import { propertySection, rows, tableSection, type InfoSection, type PackageInfo } from './model';
import { readSigner, signatureSection } from './signature';

const CLSID_MSI = '{000C1084-0000-0000-C000-000000000046}';
const CLSID_TRANSFORM = '{000C1082-0000-0000-C000-000000000046}';
const CLSID_PATCH = '{000C1086-0000-0000-C000-000000000046}';
const CLSID_MERGE_MODULE = '{000C1083-0000-0000-C000-000000000046}';

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

// Tables worth counting, and what a row of each is.
const COUNTED: [table: string, label: string][] = [
  ['File', 'Files installed'],
  ['Component', 'Components'],
  ['Feature', 'Features'],
  ['Registry', 'Registry values written'],
  ['Shortcut', 'Shortcuts'],
  ['ServiceInstall', 'Services installed'],
  ['CustomAction', 'Custom actions (code run during install)'],
  ['LaunchCondition', 'Launch conditions'],
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

  const kind =
    cfb.rootClsid === CLSID_MSI
      ? 'Windows Installer package'
      : cfb.rootClsid === CLSID_PATCH
        ? 'Windows Installer patch'
        : cfb.rootClsid === CLSID_TRANSFORM
          ? 'Windows Installer transform'
          : cfb.rootClsid === CLSID_MERGE_MODULE
            ? 'Windows Installer merge module'
            : tables.has('_StringPool')
              ? 'Windows Installer package'
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
  } else if (kind === 'Windows Installer package') {
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
      for (const [table] of COUNTED) {
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

  if (propertyRows > MAX_PROPERTIES) {
    warnings.push(
      `The Property table has ${formatNumber(propertyRows)} rows; only the first ${formatNumber(MAX_PROPERTIES)} were read.`,
    );
  }
  if (strings?.exhausted) {
    warnings.push('The package holds more text than MarkCopy reads, so some values are left out.');
  }

  // Package section.
  const template = text(7);
  const [platformText, languageText] = template ? template.split(';') : [];
  const platform = platformText
    ? (PLATFORMS[platformText.trim().toLowerCase()] ?? platformText)
    : undefined;
  const words = num(15);
  const allUsers = properties.get('ALLUSERS');
  const scope =
    allUsers === '1'
      ? 'Per-machine (all users)'
      : allUsers === '2'
        ? properties.get('MSIINSTALLPERUSER') === '1'
          ? 'Per-user by default, per-machine when run elevated'
          : 'Per-machine, or per-user when not elevated'
        : properties.size > 0
          ? 'Per-user'
          : undefined;
  const productName = properties.get('ProductName') || text(3);
  const productVersion = properties.get('ProductVersion');
  const manufacturer = properties.get('Manufacturer') || text(4);
  const flag = (name: string): string | undefined => (properties.has(name) ? 'Yes' : undefined);

  const sections: InfoSection[] = [
    ...propertySection('Package', [
      ['Product name', productName],
      ['Version', productVersion],
      ['Manufacturer', manufacturer],
      ['Product code', properties.get('ProductCode')],
      ['Upgrade code', properties.get('UpgradeCode')],
      ['Package code', text(9)],
      ['Platform', platform],
      ['Languages', languages(languageText) ?? languages(properties.get('ProductLanguage'))],
      ['Install scope', scope],
      ['Minimum installer version', installerVersion(num(14))],
      ['Needs elevation', words === undefined ? undefined : (words & 8) !== 0 ? 'No' : 'Yes'],
      [
        'Source files',
        words === undefined ? undefined : (words & 2) !== 0 ? 'Compressed' : 'Uncompressed',
      ],
      ['Administrative image', words !== undefined && (words & 4) !== 0 ? 'Yes' : undefined],
      ['Created with', text(18)],
      ['Created', text(12)],
      ['Last saved', text(13)],
      ['Subject', text(3) !== productName ? text(3) : undefined],
      ['Comments', text(6)],
      ['Keywords', text(5)],
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
      installs.push([label, 'Yes']);
    }
  }
  if (tables.has('Binary')) {
    installs.push(['Has binary resources', 'Yes']);
  }
  sections.push(...propertySection('What it installs', installs));

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

  // Signature, reported and never verified.
  if (signatureEntry) {
    const bytes = await tryRead(cfb, signatureEntry, MAX_SIGNATURE_STREAM);
    const signer = bytes ? readSigner(bytes) : undefined;
    const section = signatureSection('Authenticode', signer);
    if (signatureEx) {
      section.rows.push(...rows(['Hash extension', 'MsiDigitalSignatureEx present']));
    }
    sections.push(section);
  }

  const name = productName;
  return {
    format: kind,
    title: name ? `${name}${productVersion ? ' ' + productVersion : ''}` : undefined,
    summary: manufacturer || text(3) || text(6),
    sections,
    warnings,
  };
}
