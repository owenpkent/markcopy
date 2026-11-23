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
  return { tags, store, end: storeAt + size };
}

function strings(header: Header, tag: number): string[] | undefined {
  const entry = header.tags.get(tag);
  if (
    !entry ||
    (entry.type !== STRING && entry.type !== STRING_ARRAY && entry.type !== I18NSTRING)
  ) {
    return undefined;
  }
  const { store } = header;
  // Every string takes at least its terminator, so a larger count is a lie.
  const wanted = Math.min(entry.count, store.length - entry.offset);
  const out: string[] = [];
  const decoder = new TextDecoder();
  let at = entry.offset;
  for (let i = 0; i < wanted && at < store.length; i++) {
    let end = store.indexOf(0, at);
    if (end < 0) {
      end = store.length;
    }
    out.push(decoder.decode(store.subarray(at, end)));
    at = end + 1;
  }
  return out;
}

const text = (header: Header, tag: number): string | undefined => {
  const value = strings(header, tag)?.[0];
  return value === undefined ? undefined : printable(value.slice(0, MAX_TEXT));
};

function numbers(header: Header, tag: number): number[] | undefined {
  const entry = header.tags.get(tag);
  const width = entry && [INT8, INT16, INT32, INT64].includes(entry.type) ? SIZES[entry.type] : 0;
  if (!entry || !width) {
    return undefined;
  }
  const available = Math.floor((header.store.length - entry.offset) / width);
  const n = Math.min(entry.count, available);
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
  const names = strings(header, nameTag) ?? [];
  const flags = numbers(header, flagTag) ?? [];
  const versions = strings(header, versionTag) ?? [];
  const rows: string[][] = [];
  let total = 0;
  let hidden = 0;
  for (let i = 0; i < names.length; i++) {
    // rpmlib(...) entries describe the rpm tool needed to install, not the system.
    if (hideRpmlib && ((flags[i] ?? 0) & RPMLIB || names[i].startsWith('rpmlib('))) {
      hidden++;
      continue;
    }
    total++;
    if (rows.length < limit) {
      const op = comparison(flags[i] ?? 0);
      const version = printable(versions[i] ?? '');
      rows.push([label, printable(names[i]), version ? `${op} ${version}`.trim() : '']);
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
  if (body[0] !== 4 || body.length < 6) {
    return undefined;
  }
  const algorithm = body[2];
  // Hashed subpackets, then unhashed ones; the issuer is usually in either.
  let keyId: string | undefined;
  let pos = 4;
  for (let area = 0; area < 2 && pos + 2 <= body.length; area++) {
    const size = (body[pos] << 8) | body[pos + 1];
    pos += 2;
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
      } else if (type === 33 && len === 22 && body[sub + 1] === 4 && !keyId) {
        keyId = hex(body.subarray(sub + 14, sub + 22));
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

const SCRIPTS: [number, string, string][] = [
  [1151, 'Pre-transaction (%pretrans)', 'Runs as root before the whole transaction'],
  [1023, 'Pre-install (%pre)', 'Runs as root before the files are installed'],
  [1024, 'Post-install (%post)', 'Runs as root after the files are installed'],
  [1025, 'Pre-uninstall (%preun)', 'Runs as root before the files are removed'],
  [1026, 'Post-uninstall (%postun)', 'Runs as root after the files are removed'],
  [1152, 'Post-transaction (%posttrans)', 'Runs as root after the whole transaction'],
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
  const sha256 = text(signature, 273);

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
    ]),
  );

  const summary = get(1004);
  const description = paragraphs(strings(main, 1005)?.[0]);
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
  sections.push(
    ...propertySection(
      'Scripts',
      scripts,
      'Installing a package runs these scripts as root. MarkCopy does not show or run them.',
    ),
  );

  sections.push(...contents(main, warnings));
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
  const base = strings(main, 1117);
  if (!base || base.length === 0) {
    return [];
  }
  const dirs = strings(main, 1118) ?? [];
  const indexes = numbers(main, 1116) ?? [];
  const sizes = numbers(main, 5008) ?? numbers(main, 1028) ?? [];
  const modes = numbers(main, 1030);
  if (indexes.length !== base.length) {
    warnings.push('The file list could not be read.');
    return [];
  }
  const rows: string[][] = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  for (let i = 0; i < base.length; i++) {
    // The file mode's type bits (S_IFMT) mark directories, which are listed but are not files.
    if (modes && ((modes[i] ?? 0) & 0xf000) === 0x4000) {
      directories++;
      continue;
    }
    files++;
    bytes += sizes[i] ?? 0;
    if (rows.length < TABLE_LIMIT) {
      rows.push([
        printable(`${dirs[indexes[i]] ?? ''}${base[i]}`),
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

function signatureOf(signature: Header): InfoSection[] {
  // RSAHEADER and DSAHEADER sign the header alone; PGP and GPG cover the payload too.
  for (const tag of [268, 267, 1002, 1005]) {
    const packet = bin(signature, tag);
    if (!packet) {
      continue;
    }
    const issuer = openPgpIssuer(packet);
    const algorithm = issuer ? ALGORITHMS[issuer.algorithm] : undefined;
    const section = signatureSection(algorithm ? `OpenPGP (${algorithm})` : 'OpenPGP');
    if (issuer?.keyId) {
      section.rows.push(['Key ID', issuer.keyId]);
    }
    return [section];
  }
  return [];
}
