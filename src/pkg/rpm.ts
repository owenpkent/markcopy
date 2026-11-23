// RPM packages (.rpm): a 96-byte lead, a signature header, the main header and
// then the compressed payload. Everything worth showing is in the two headers,
// which are tables of tagged values; the payload (the files themselves) is
// never opened. A header's store holds every string of the file list, so a
// package with many files is megabytes and is read in pieces.
import { formatBytes, formatNumber } from '../binary/html';
import type { RangeReader } from '../binary/reader';
import { printable } from '../binary/text';
import {
  PackageError,
  propertySection,
  tableSection,
  type InfoSection,
  type PackageInfo,
} from './model';
import { signatureSection } from './signature';

const LEAD_LENGTH = 96;
const HEADER_MAGIC = [0x8e, 0xad, 0xe8, 0x01];

// A real header has about 100 to 200 tags (one per kind of fact, not per file).
const MAX_INDEX = 8192;
// A header's store holds the whole file list as strings. Large packages reach a
// few megabytes; this leaves headroom, and stays inside the reader's 32 MiB budget.
const MAX_STORE = 24 * 1024 * 1024;
const PIECE = 1024 * 1024;
// Rows shown per table. The counts in the lead and the note are always real.
const TABLE_LIMIT = 200;
const RELATION_LIMIT = 500;
const MAX_TEXT = 64 * 1024;

const INT8 = 2;
const INT16 = 3;
const INT32 = 4;
const INT64 = 5;
const STRING = 6;
const BIN = 7;
const STRING_ARRAY = 8;
const I18NSTRING = 9;

interface Entry {
  type: number;
  offset: number;
  count: number;
}

interface Header {
  tags: Map<number, Entry>;
  store: Uint8Array;
  /** The offset just past the header's store. */
  end: number;
  /** Store bytes walked so far while finding string boundaries, shared by every tag. */
  scanned: number;
  /** True once a table was cut short by a cap, so the page can say so. */
  limited: boolean;
  /** String tables already located, by region, so tags that alias one region share the work. */
  tables: Map<string, Strings>;
}

const SIZES: Record<number, number> = {
  1: 1,
  [INT8]: 1,
  [INT16]: 2,
  [INT32]: 4,
  [INT64]: 8,
  [BIN]: 1,
};

async function readHeader(reader: RangeReader, at: number): Promise<Header> {
  const head = await reader.view(at, 16);
  if (HEADER_MAGIC.some((byte, i) => head.getUint8(i) !== byte)) {
    throw new PackageError('it has the RPM signature, but a header in it is damaged.');
  }
  const count = head.getUint32(8);
  const size = head.getUint32(12);
  if (count > MAX_INDEX || size > MAX_STORE) {
    throw new PackageError('its header is larger than MarkCopy will read.');
  }
  const index = await reader.view(at + 16, count * 16);
  const storeAt = at + 16 + count * 16;
  if (storeAt + size > reader.size) {
    throw new PackageError('the file ends before the data its headers point to.');
  }
  const store = new Uint8Array(size);
  for (let done = 0; done < size; done += PIECE) {
    store.set(await reader.bytes(storeAt + done, Math.min(PIECE, size - done)), done);
  }
  const tags = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    const tag = index.getUint32(i * 16);
    const type = index.getUint32(i * 16 + 4);
    const offset = index.getUint32(i * 16 + 8);
    const n = index.getUint32(i * 16 + 12);
    // An entry that points outside the store is ignored, not trusted.
    if (type >= 1 && type <= 9 && offset <= size && !tags.has(tag)) {
      tags.set(tag, { type, offset, count: n });
    }
  }
  return { tags, store, end: storeAt + size, scanned: 0, limited: false, tables: new Map() };
}

// A single value (name, summary, URL) is cut to this many characters.
const MAX_FIELD = 4096;
// One path component. Directory and base name are each cut to this before they are joined.
const MAX_PATH_PART = 1024;
// Entries considered of the file list. A real package with 200,000 files has a header of
// roughly 20 MB, about the most MarkCopy reads.
const MAX_FILES = 200_000;
// Entries considered of one relationship list (requires, provides ...).
const MAX_RELATION_ENTRIES = 20_000;
// Store bytes that may be walked, across every tag of one header, to find string
// boundaries. Tags can point at the same region, and each walk would otherwise repeat.
const SCAN_BUDGET = 128 * 1024 * 1024;

/**
 * Where the strings of one array start, found without building any of them. A
 * string is decoded only when asked for, cut to the length asked.
 */
class Strings {
  constructor(
    private readonly store: Uint8Array,
    private readonly starts: number[],
    /** True when the entry declared more strings than were located. */
    readonly truncated: boolean,
  ) {}

  get count(): number {
    return this.starts.length;
  }

  /** The string at `index`, at most `max` characters, cleaned; undefined past the end. */
  at(index: number, max: number, keepLineBreaks = false): string | undefined {
    const start = this.starts[index];
    if (start === undefined) {
      return undefined;
    }
    // A character is at most 4 bytes, so looking further for the terminator is wasted work.
    const window = this.store.subarray(start, Math.min(this.store.length, start + max * 4));
    const end = window.indexOf(0);
    const decoded = new TextDecoder().decode(end < 0 ? window : window.subarray(0, end));
    return printable(decoded.slice(0, max), keepLineBreaks);
  }
}

function strings(header: Header, tag: number, max: number): Strings | undefined {
  const entry = header.tags.get(tag);
  if (
    !entry ||
    (entry.type !== STRING && entry.type !== STRING_ARRAY && entry.type !== I18NSTRING)
  ) {
    return undefined;
  }
  const key = `${entry.offset}:${entry.count}:${max}`;
  const known = header.tables.get(key);
  if (known) {
    return known;
  }
  const { store } = header;
  // Every string takes at least its terminator, so a larger count is a lie.
  const declared = Math.min(entry.count, store.length - entry.offset);
  const starts: number[] = [];
  const wanted = Math.min(declared, max);
  let at = entry.offset;
  while (starts.length < wanted && at < store.length) {
    if (header.scanned > SCAN_BUDGET) {
      header.limited = true;
      break;
    }
    starts.push(at);
    if (starts.length >= wanted) {
      break; // the last wanted string needs no end: `at()` finds it
    }
    let end = store.indexOf(0, at);
    if (end < 0) {
      end = store.length;
    }
    header.scanned += end - at + 1;
    at = end + 1;
  }
  const table = new Strings(store, starts, declared > starts.length);
  header.tables.set(key, table);
  return table;
}

const text = (
  header: Header,
  tag: number,
  max = MAX_FIELD,
  keepLineBreaks = false,
): string | undefined => strings(header, tag, 1)?.at(0, max, keepLineBreaks);

function numbers(header: Header, tag: number, max = 1): number[] | undefined {
  const entry = header.tags.get(tag);
  const width = entry && [INT8, INT16, INT32, INT64].includes(entry.type) ? SIZES[entry.type] : 0;
  if (!entry || !width) {
    return undefined;
  }
  const available = Math.floor((header.store.length - entry.offset) / width);
  const n = Math.min(entry.count, available, max);
  const view = new DataView(header.store.buffer, header.store.byteOffset, header.store.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const at = entry.offset + i * width;
    out[i] =
      width === 1
        ? view.getUint8(at)
        : width === 2
          ? view.getUint16(at)
          : width === 4
            ? view.getUint32(at)
            : Number(view.getBigUint64(at));
  }
  return out;
}

const number = (header: Header, tag: number): number | undefined => numbers(header, tag)?.[0];

function bin(header: Header, tag: number): Uint8Array | undefined {
  const entry = header.tags.get(tag);
  if (!entry || entry.type !== BIN || entry.offset + entry.count > header.store.length) {
    return undefined;
  }
  return header.store.subarray(entry.offset, entry.offset + entry.count);
}

function utc(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds <= 0) {
    return undefined;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime())
    ? undefined
    : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

const LESS = 0x02;
const GREATER = 0x04;
const EQUAL = 0x08;
const RPMLIB = 0x01000000;

function comparison(flags: number): string {
  const less = (flags & LESS) !== 0;
  const greater = (flags & GREATER) !== 0;
  const equal = (flags & EQUAL) !== 0;
  if (less) {
    return equal ? '<=' : '<';
  }
  if (greater) {
    return equal ? '>=' : '>';
  }
  return equal ? '=' : '';
}

interface Relations {
  rows: string[][];
  total: number;
  hidden: number;
}

/** The rows of one relationship (names, flags, versions as parallel tag arrays). */
function relations(
  header: Header,
  label: string,
  [nameTag, flagTag, versionTag]: number[],
  limit: number,
  hideRpmlib: boolean,
): Relations {
  const names = strings(header, nameTag, MAX_RELATION_ENTRIES);
  const flags = numbers(header, flagTag, MAX_RELATION_ENTRIES) ?? [];
  const versions = strings(header, versionTag, MAX_RELATION_ENTRIES);
  if (names?.truncated) {
    header.limited = true;
  }
  const rows: string[][] = [];
  let total = 0;
  let hidden = 0;
  for (let i = 0; i < (names?.count ?? 0); i++) {
    // rpmlib(...) entries describe the rpm tool needed to install, not the system.
    if (hideRpmlib && ((flags[i] ?? 0) & RPMLIB || names?.at(i, 8)?.startsWith('rpmlib('))) {
      hidden++;
      continue;
    }
    total++;
    if (rows.length < limit) {
      const op = comparison(flags[i] ?? 0);
      const version = versions?.at(i, MAX_PATH_PART) ?? '';
      rows.push([
        label,
        names?.at(i, MAX_PATH_PART) ?? '',
        version ? `${op} ${version}`.trim() : '',
      ]);
    }
  }
  return { rows, total, hidden };
}

function paragraphs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\n\s*\n/)
    .map((p) => printable(p.trim(), true))
    .filter(Boolean);
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The public-key algorithm and the 8-byte issuer key ID of an OpenPGP signature packet. */
export function openPgpIssuer(
  packet: Uint8Array,
): { algorithm: number; keyId?: string } | undefined {
  try {
    return parseIssuer(packet);
  } catch {
    // A packet that runs past its own length is not worth a page failure.
    return undefined;
  }
}

function parseIssuer(packet: Uint8Array): { algorithm: number; keyId?: string } | undefined {
  if (packet.length < 3 || (packet[0] & 0x80) === 0) {
    return undefined;
  }
  let at = 1;
  let tag: number;
  let length: number;
  if (packet[0] & 0x40) {
    tag = packet[0] & 0x3f;
    const first = packet[at++];
    if (first < 192) {
      length = first;
    } else if (first < 224) {
      length = ((first - 192) << 8) + packet[at++] + 192;
    } else if (first === 255) {
      length = new DataView(packet.buffer, packet.byteOffset, packet.length).getUint32(at);
      at += 4;
    } else {
      return undefined; // partial lengths do not occur in a signature
    }
  } else {
    tag = (packet[0] >> 2) & 0x0f;
    const kind = packet[0] & 3;
    if (kind === 3) {
      return undefined;
    }
    const width = 1 << kind;
    length = 0;
    for (let i = 0; i < width; i++) {
      length = length * 256 + (packet[at + i] ?? 0);
    }
    at += width;
  }
  if (tag !== 2 || at + length > packet.length || length < 4) {
    return undefined;
  }
  const body = packet.subarray(at, at + length);
  if (body[0] === 3) {
    // Version 3 puts the key ID in a fixed place.
    return body.length >= 17
      ? { algorithm: body[15], keyId: hex(body.subarray(7, 15)) }
      : undefined;
  }
  const version = body[0];
  if ((version !== 4 && version !== 6) || body.length < 10) {
    return undefined;
  }
  const algorithm = body[2];
  // Version 6 (RFC 9580) widens the subpacket area lengths to 4 bytes.
  const width = version === 6 ? 4 : 2;
  // Hashed subpackets, then unhashed ones; the issuer is usually in either.
  let keyId: string | undefined;
  let pos = 4;
  for (let area = 0; area < 2 && pos + width <= body.length; area++) {
    let size = 0;
    for (let i = 0; i < width; i++) {
      size = size * 256 + body[pos + i];
    }
    pos += width;
    const end = Math.min(pos + size, body.length);
    let sub = pos;
    // Each subpacket is at least 2 bytes, so this ends.
    while (sub + 2 <= end) {
      let len = body[sub++];
      if (len >= 192 && len < 255) {
        len = ((len - 192) << 8) + (body[sub++] ?? 0) + 192;
      } else if (len === 255) {
        if (sub + 4 > end) {
          break;
        }
        len = new DataView(body.buffer, body.byteOffset, body.length).getUint32(sub);
        sub += 4;
      }
      const type = (body[sub] ?? 0) & 0x7f;
      if (len < 1 || sub + len > end) {
        break;
      }
      if (type === 16 && len === 9) {
        keyId = hex(body.subarray(sub + 1, sub + 9));
      } else if (type === 33 && !keyId) {
        // Issuer fingerprint: the key ID is its last 8 bytes (version 4) or first 8 (version 6).
        if (len === 22 && body[sub + 1] === 4) {
          keyId = hex(body.subarray(sub + 14, sub + 22));
        } else if (len === 34 && body[sub + 1] === 6) {
          keyId = hex(body.subarray(sub + 2, sub + 10));
        }
      }
      sub += len;
    }
    pos = end;
  }
  return { algorithm, keyId };
}

const ALGORITHMS: Record<number, string> = {
  1: 'RSA',
  17: 'DSA',
  19: 'ECDSA',
  22: 'EdDSA',
};

// Every tag that holds code rpm runs as root, from rpmtag.h and rpm's tag reference.
const SCRIPTS: [number, string, string][] = [
  [1151, 'Pre-transaction (%pretrans)', 'Runs as root before the whole transaction'],
  [1023, 'Pre-install (%pre)', 'Runs as root before the files are installed'],
  [1024, 'Post-install (%post)', 'Runs as root after the files are installed'],
  [1025, 'Pre-uninstall (%preun)', 'Runs as root before the files are removed'],
  [1026, 'Post-uninstall (%postun)', 'Runs as root after the files are removed'],
  [1152, 'Post-transaction (%posttrans)', 'Runs as root after the whole transaction'],
  [5103, 'Pre-uninstall transaction (%preuntrans)', 'Runs as root before a removal transaction'],
  [5104, 'Post-uninstall transaction (%postuntrans)', 'Runs as root after a removal transaction'],
  [1079, 'Verify (%verify)', 'Runs as root when the package is verified'],
];

// Script arrays: one entry per trigger. They run when other packages, or files, change.
const TRIGGER_SCRIPTS: [number, string, string][] = [
  [
    1065,
    'Triggers (%triggerin, %triggerun, %triggerpostun)',
    'when other packages are installed, upgraded or removed',
  ],
  [5066, 'File triggers (%filetriggerin ...)', 'when files under a watched path change'],
  [
    5076,
    'Transaction file triggers (%transfiletriggerin ...)',
    'after a transaction that changed files under a watched path',
  ],
];

export async function readRpm(reader: RangeReader): Promise<PackageInfo> {
  const lead = await reader.view(0, LEAD_LENGTH).catch(() => undefined);
  if (!lead || lead.getUint32(0) !== 0xedabeedb) {
    throw new PackageError('it is not an RPM package.');
  }
  const leadType = lead.getUint16(6);

  const signature = await readHeader(reader, LEAD_LENGTH);
  // The signature header is padded to 8 bytes; the main header is not.
  const main = await readHeader(reader, Math.ceil(signature.end / 8) * 8);

  const warnings: string[] = [];
  const get = (tag: number): string | undefined => text(main, tag);
  const name = get(1000);
  if (!name) {
    throw new PackageError('it has RPM headers, but no package name.');
  }
  const version = get(1001);
  const release = get(1002);
  const epoch = number(main, 1003);
  const isSource = leadType === 1 || !main.tags.has(1044);
  const evr = `${epoch !== undefined ? `${epoch}:` : ''}${version ?? ''}${release ? `-${release}` : ''}`;

  const sections: InfoSection[] = [];
  const installed = number(main, 5009) ?? number(main, 1009);
  const payloadAt = main.end;
  const compressor = get(1125);
  // Version 6 packages keep the same digest in tag 273; rpm 6 also adds a SHA3-256 in 279.
  const sha256 = text(signature, 273);
  const sha3 = text(signature, 279);

  sections.push(
    ...propertySection('Package', [
      ['Name', name],
      ['Epoch', epoch],
      ['Version', version],
      ['Release', release],
      ['Architecture', get(1022)],
      ['Vendor', get(1011)],
      ['Distribution', get(1010)],
      ['Packager', get(1015)],
      ['License', get(1014)],
      ['Group', get(1016)],
      ['URL', get(1020)],
      ['Installed size', installed === undefined ? undefined : formatBytes(installed)],
      ['Built', utc(number(main, 1006))],
      ['Build host', get(1007)],
      ['Operating system', get(1021)],
      ['Source package', get(1044)],
      ['Payload format', get(1124)],
      [
        'Payload',
        payloadAt <= reader.size
          ? `${compressor ? `${compressor} compressed, ` : ''}${formatBytes(reader.size - payloadAt)}`
          : undefined,
      ],
      ['Payload flags', get(1126)],
      ['Header SHA-256', sha256],
      ['Header SHA3-256', sha3],
    ]),
  );

  const summary = get(1004);
  const description = paragraphs(text(main, 1005, MAX_TEXT, true));
  if (description.length > 0) {
    sections.push({ kind: 'text', heading: 'Description', paragraphs: description });
  }

  const requires = relations(main, 'Requires', [1049, 1048, 1050], RELATION_LIMIT, true);
  const others = [
    relations(main, 'Recommends', [5046, 5048, 5047], RELATION_LIMIT, false),
    relations(main, 'Suggests', [5049, 5051, 5050], RELATION_LIMIT, false),
    relations(main, 'Conflicts', [1054, 1053, 1055], RELATION_LIMIT, false),
    relations(main, 'Obsoletes', [1090, 1114, 1115], RELATION_LIMIT, false),
  ];
  const dependencyRows = [requires, ...others].flatMap((r) => r.rows);
  const dependencyTotal = [requires, ...others].reduce((sum, r) => sum + r.total, 0);
  sections.push(
    ...tableSection('Dependencies', ['Relation', 'Package', 'Version'], dependencyRows, {
      limit: RELATION_LIMIT,
      total: dependencyTotal,
      noun: 'relationships',
      lead:
        requires.hidden > 0
          ? `${formatNumber(requires.hidden)} rpmlib requirement${requires.hidden === 1 ? '' : 's'} about the rpm tool itself ${requires.hidden === 1 ? 'is' : 'are'} not shown.`
          : undefined,
    }),
  );
  const provides = relations(main, 'Provides', [1047, 1112, 1113], RELATION_LIMIT, false);
  sections.push(
    // The section is named for the relation, so the row need not repeat it.
    ...tableSection(
      'Provides',
      ['Package', 'Version'],
      provides.rows.map((row) => row.slice(1)),
      {
        limit: RELATION_LIMIT,
        total: provides.total,
        noun: 'entries',
      },
    ),
  );

  const scripts = SCRIPTS.filter(([tag]) => main.tags.has(tag)).map(
    ([, label, runs]): [string, string] => [label, runs],
  );
  for (const [tag, label, when] of TRIGGER_SCRIPTS) {
    const count = strings(main, tag, MAX_RELATION_ENTRIES)?.count ?? 0;
    if (count > 0) {
      scripts.push([
        label,
        `${formatNumber(count)} script${count === 1 ? '' : 's'}, run as root ${when}`,
      ]);
    }
  }
  if (main.tags.has(5109)) {
    scripts.push([
      'System users (%sysusers)',
      'Creates users and groups as root (declarative, not a script)',
    ]);
  }
  sections.push(
    ...propertySection(
      'Scripts',
      scripts,
      'Installing a package runs these scripts as root. MarkCopy does not show or run them.',
    ),
  );

  sections.push(...contents(main, warnings));
  if (main.limited) {
    warnings.push(
      'Some tables in the package are larger than MarkCopy will read, so they are cut short.',
    );
  }
  sections.push(...signatureOf(signature));

  return {
    format: isSource ? 'RPM source package' : 'RPM package',
    title: `${name}${evr ? ` ${evr}` : ''}`,
    summary: summary?.split('\n')[0],
    sections,
    warnings,
  };
}

function contents(main: Header, warnings: string[]): InfoSection[] {
  const base = strings(main, 1117, MAX_FILES);
  if (!base || base.count === 0) {
    return [];
  }
  const dirs = strings(main, 1118, MAX_FILES);
  const indexes = numbers(main, 1116, MAX_FILES) ?? [];
  const sizes = numbers(main, 5008, MAX_FILES) ?? numbers(main, 1028, MAX_FILES) ?? [];
  const modes = numbers(main, 1030, MAX_FILES);
  if (base.truncated) {
    warnings.push(
      `The file list is longer than MarkCopy will read, so only its first ${formatNumber(base.count)} entries are counted.`,
    );
  }
  if (indexes.length !== base.count) {
    warnings.push('The file list could not be read.');
    return [];
  }
  const rows: string[][] = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  // Directory names are shared by many files: decode each once, cut short.
  const dirNames = new Map<number, string>();
  const dirName = (index: number | undefined): string => {
    if (index === undefined) {
      return '';
    }
    let name = dirNames.get(index);
    if (name === undefined) {
      name = dirs?.at(index, MAX_PATH_PART) ?? '';
      dirNames.set(index, name);
    }
    return name;
  };
  for (let i = 0; i < base.count; i++) {
    // The file mode's type bits (S_IFMT) mark directories, which are listed but are not files.
    if (modes && ((modes[i] ?? 0) & 0xf000) === 0x4000) {
      directories++;
      continue;
    }
    files++;
    bytes += sizes[i] ?? 0;
    if (rows.length < TABLE_LIMIT) {
      rows.push([
        `${dirName(indexes[i])}${base.at(i, MAX_PATH_PART) ?? ''}`,
        sizes[i] === undefined ? '' : formatBytes(sizes[i]),
      ]);
    }
  }
  const lead =
    `The package contains ${formatNumber(files)} ${files === 1 ? 'file' : 'files'} ` +
    `totalling ${formatBytes(bytes)}` +
    (directories > 0
      ? ` and ${formatNumber(directories)} ${directories === 1 ? 'directory' : 'directories'}.`
      : '.');
  return tableSection('Contents', ['Path', 'Size'], rows, {
    limit: TABLE_LIMIT,
    total: files,
    noun: 'files',
    lead,
  });
}

// RPM v6 keeps its OpenPGP signatures as base64 strings in tag 278 (RPMTAG_OPENPGP),
// one or several. Signatures are read up to this many, each decoded from at most
// this many characters (an RSA-4096 signature packet is about 700 bytes).
const MAX_SIGNATURES = 16;
const MAX_SIGNATURE_CHARS = 16 * 1024;

function decodeBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text.replace(/\s+/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return undefined;
  }
}

interface Issuer {
  algorithm?: string;
  keyId?: string;
}

function describe(packet: Uint8Array | undefined): Issuer {
  const issuer = packet && openPgpIssuer(packet);
  return { algorithm: issuer ? ALGORITHMS[issuer.algorithm] : undefined, keyId: issuer?.keyId };
}

function signatureOf(signature: Header): InfoSection[] {
  // RPM v6 signatures (tag 278) win: rpm ignores the legacy tags when they are present.
  const v6 = strings(signature, 278, MAX_SIGNATURES);
  if (v6 && v6.count > 0) {
    const issuers: Issuer[] = [];
    for (let i = 0; i < v6.count; i++) {
      issuers.push(describe(decodeBase64(v6.at(i, MAX_SIGNATURE_CHARS) ?? '')));
    }
    const algorithms = [...new Set(issuers.map((i) => i.algorithm).filter(Boolean))];
    const section = signatureSection(
      algorithms.length > 0 ? `OpenPGP v6 (${algorithms.join(', ')})` : 'OpenPGP v6',
    );
    issuers.forEach((issuer, i) => {
      if (issuer.keyId) {
        section.rows.push([
          issuers.length === 1 ? 'Key ID' : `Key ID (signature ${i + 1})`,
          issuer.keyId,
        ]);
      }
    });
    if (issuers.length > 1) {
      section.rows.push([
        'Signatures',
        v6.truncated ? `${issuers.length} shown, more are present` : String(issuers.length),
      ]);
    }
    return [section];
  }
  // RSAHEADER and DSAHEADER sign the header alone; PGP and GPG cover the payload too.
  for (const tag of [268, 267, 1002, 1005]) {
    const packet = bin(signature, tag);
    if (!packet) {
      continue;
    }
    const { algorithm, keyId } = describe(packet);
    const section = signatureSection(algorithm ? `OpenPGP (${algorithm})` : 'OpenPGP');
    if (keyId) {
      section.rows.push(['Key ID', keyId]);
    }
    return [section];
  }
  return [];
}
