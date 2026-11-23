// Building Windows Installer packages as exact bytes.
//
// Written from the Windows Installer database file format as documented for
// the database (the packed stream names, the string pool, column-major tables,
// the Summary Information property set), not from src/pkg/msi.ts. The package
// is an OLE compound file built by cfbFixture.ts.
import { buildSignedData, type SignerSpec } from '../pe/fixture';
import { buildCfb, guidBytes, type CfbStream } from './cfbFixture';

export const CLSID_MSI = '{000C1084-0000-0000-C000-000000000046}';
export const CLSID_PATCH = '{000C1086-0000-0000-C000-000000000046}';
export const CLSID_TRANSFORM = '{000C1082-0000-0000-C000-000000000046}';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._';

/** How the installer packs a stream name: two alphabet characters per UTF-16 unit. */
export function packName(text: string, table: boolean): string {
  let out = table ? String.fromCharCode(0x4840) : '';
  let i = 0;
  while (i < text.length) {
    const a = ALPHABET.indexOf(text[i]);
    if (a < 0) {
      out += text[i];
      i++;
      continue;
    }
    const b = i + 1 < text.length ? ALPHABET.indexOf(text[i + 1]) : -1;
    if (b >= 0) {
      out += String.fromCharCode(0x3800 + a + (b << 6));
      i += 2;
    } else {
      out += String.fromCharCode(0x4800 + a);
      i++;
    }
  }
  return out;
}

class Out {
  private data: number[] = [];
  u8(v: number): this {
    this.data.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) {
      this.data.push(bytes[i]);
    }
    return this;
  }
  get length(): number {
    return this.data.length;
  }
  pad(to: number): this {
    while (this.data.length % to !== 0) {
      this.data.push(0);
    }
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.data);
  }
}

/** The kinds of column a test table can have. */
export type Column = 's' | 'i2' | 'i4' | 'b';

export interface TableSpec {
  name: string;
  columns: Column[];
  /** Row count; the stream is zero-filled, since only its size is read. */
  rows: number;
  /** Bytes appended to the stream, so its size is not a whole number of rows. */
  extra?: number;
}

export interface SummarySpec {
  codePage?: number;
  title?: string;
  subject?: string;
  author?: string;
  keywords?: string;
  comments?: string;
  template?: string;
  revision?: string;
  /** Windows FILETIME values, 100 ns ticks since 1601. */
  created?: bigint;
  saved?: bigint;
  pageCount?: number;
  wordCount?: number;
  application?: string;
  /** Written as a VT_LPWSTR instead of VT_LPSTR. */
  wideComments?: string;
}

export interface MsiSpec {
  clsid?: string;
  properties?: Record<string, string>;
  summary?: SummarySpec | false;
  tables?: TableSpec[];
  /** Streams that are not tables: cabinets, binaries, icons. Names are unpacked. */
  streams?: { name: string; size: number }[];
  storages?: string[];
  /** Pool references of 3 bytes, as for a pool of more than 64K strings. */
  wide?: boolean;
  codePage?: number;
  signature?: SignerSpec | Uint8Array;
  signatureEx?: boolean;
  /** Leave the string pool out. */
  noPool?: boolean;
  sectorShift?: 9 | 12;
  /** Replacement bytes for the streams, to build damaged databases. */
  propertyBytes?: Uint8Array;
  poolBytes?: Uint8Array;
  dataBytes?: Uint8Array;
  summaryBytes?: Uint8Array;
  columnsBytes?: Uint8Array;
  /** Extra raw streams by stored name. */
  rawStreams?: CfbStream[];
}

const FILETIME_UNIX_EPOCH = 11644473600n;

/** A FILETIME for a Unix time in seconds. */
export function filetime(unixSeconds: number): bigint {
  return (BigInt(unixSeconds) + FILETIME_UNIX_EPOCH) * 10000000n;
}

export function summaryStream(spec: SummarySpec): Uint8Array {
  const props: [number, Uint8Array][] = [];
  const codePage = spec.codePage ?? 1252;
  const typed = (type: number, body: Uint8Array): Uint8Array =>
    new Out().u32(type).raw(body).pad(4).done();
  const i2 = (v: number) => typed(2, new Out().u16(v).u16(0).done());
  const i4 = (v: number) => typed(3, new Out().u32(v).done());
  const lpstr = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    return typed(
      30,
      new Out()
        .u32(bytes.length + 1)
        .raw(bytes)
        .u8(0)
        .done(),
    );
  };
  const lpwstr = (text: string) => {
    const o = new Out().u32(text.length + 1);
    for (let i = 0; i < text.length; i++) {
      o.u16(text.charCodeAt(i));
    }
    return typed(31, o.u16(0).done());
  };
  const ft = (v: bigint) =>
    typed(
      64,
      new Out()
        .u32(Number(v & 0xffffffffn))
        .u32(Number(v >> 32n))
        .done(),
    );

  props.push([1, i2(codePage)]);
  const text: [number, string | undefined][] = [
    [2, spec.title],
    [3, spec.subject],
    [4, spec.author],
    [5, spec.keywords],
    [6, spec.wideComments === undefined ? spec.comments : undefined],
    [7, spec.template],
    [9, spec.revision],
    [18, spec.application],
  ];
  for (const [id, value] of text) {
    if (value !== undefined) {
      props.push([id, lpstr(value)]);
    }
  }
  if (spec.wideComments !== undefined) {
    props.push([6, lpwstr(spec.wideComments)]);
  }
  if (spec.created !== undefined) {
    props.push([12, ft(spec.created)]);
  }
  if (spec.saved !== undefined) {
    props.push([13, ft(spec.saved)]);
  }
  if (spec.pageCount !== undefined) {
    props.push([14, i4(spec.pageCount)]);
  }
  if (spec.wordCount !== undefined) {
    props.push([15, i4(spec.wordCount)]);
  }
  props.sort((a, b) => a[0] - b[0]);

  const table = 8 + props.length * 8;
  let offset = table;
  const index = new Out();
  const values = new Out();
  for (const [id, value] of props) {
    index.u32(id).u32(offset);
    values.raw(value);
    offset += value.length;
  }
  const section = new Out().u32(offset).u32(props.length).raw(index.done()).raw(values.done());
  const header = new Out().u16(0xfffe).u16(0).u32(0x00020006);
  header.raw(new Uint8Array(16)).u32(1);
  // The FMTID of the SummaryInformation property set, then the section's offset.
  header.raw(guidBytes('{F29F85E0-4FF9-1068-AB91-08002B27B3D9}')).u32(48);
  return new Out().raw(header.done()).raw(section.done()).done();
}

function columnBytes(column: Column, wide: boolean): number {
  return column === 's' ? (wide ? 3 : 2) : column === 'i4' ? 4 : 2;
}

/** The _Columns type word for a column, as stored (the integer offset 0x8000 added). */
function typeWord(column: Column): number {
  const type =
    column === 's' ? 0x0d00 | 0xff : column === 'b' ? 0x1900 : column === 'i2' ? 0x0502 : 0x0504;
  return type + 0x8000;
}

export function buildMsi(spec: MsiSpec = {}): Uint8Array {
  const wide = spec.wide ?? false;
  const properties = spec.properties ?? {};
  const tables: TableSpec[] = [
    { name: 'Property', columns: ['s', 's'], rows: Object.keys(properties).length },
    ...(spec.tables ?? []),
  ];

  // The string pool: every distinct string, 1-based.
  const pool: string[] = [];
  const idOf = (text: string): number => {
    let at = pool.indexOf(text);
    if (at < 0) {
      pool.push(text);
      at = pool.length - 1;
    }
    return at + 1;
  };
  const refs = (ids: number[]): Out => {
    const o = new Out();
    for (const id of ids) {
      o.u16(id & 0xffff);
      if (wide) {
        o.u8(id >>> 16);
      }
    }
    return o;
  };

  // _Columns lists every column of every table, sorted by table then number.
  const columnRows: { table: number; number: number; name: number; type: number }[] = [];
  for (const table of tables) {
    table.columns.forEach((column, i) => {
      columnRows.push({
        table: idOf(table.name),
        number: i + 1 + 0x8000,
        name: idOf(`${table.name}Col${i + 1}`),
        type: typeWord(column),
      });
    });
  }
  const columns = new Out()
    .raw(refs(columnRows.map((r) => r.table)).done())
    .raw(new Out().raw(columnRows.flatMap((r) => [r.number & 0xff, r.number >> 8])).done())
    .raw(refs(columnRows.map((r) => r.name)).done())
    .raw(new Out().raw(columnRows.flatMap((r) => [r.type & 0xff, r.type >> 8])).done());

  const names = Object.keys(properties);
  const propertyStream = new Out()
    .raw(refs(names.map((n) => idOf(n))).done())
    .raw(refs(names.map((n) => idOf(properties[n]))).done());

  const poolOut = new Out().u16(spec.codePage ?? 1252).u16(wide ? 0x8000 : 0);
  const data = new Out();
  for (const text of pool) {
    const bytes = new TextEncoder().encode(text);
    poolOut.u16(bytes.length).u16(1);
    data.raw(bytes);
  }

  const streams: CfbStream[] = [];
  if (spec.summary !== false) {
    streams.push({
      name: String.fromCharCode(5) + 'SummaryInformation',
      data: spec.summaryBytes ?? summaryStream(spec.summary ?? {}),
    });
  }
  if (!spec.noPool) {
    streams.push({ name: packName('_StringPool', true), data: spec.poolBytes ?? poolOut.done() });
    streams.push({ name: packName('_StringData', true), data: spec.dataBytes ?? data.done() });
    streams.push({ name: packName('_Columns', true), data: spec.columnsBytes ?? columns.done() });
  }
  streams.push({
    name: packName('Property', true),
    data: spec.propertyBytes ?? propertyStream.done(),
  });
  for (const table of spec.tables ?? []) {
    const width = table.columns.reduce((sum, c) => sum + columnBytes(c, wide), 0);
    if (table.rows > 0) {
      streams.push({
        name: packName(table.name, true),
        data: new Uint8Array(table.rows * width + (table.extra ?? 0)),
      });
    }
  }
  for (const s of spec.streams ?? []) {
    streams.push({ name: packName(s.name, false), data: new Uint8Array(s.size) });
  }
  if (spec.signature) {
    streams.push({
      name: String.fromCharCode(5) + 'DigitalSignature',
      data: spec.signature instanceof Uint8Array ? spec.signature : buildSignedData(spec.signature),
    });
  }
  if (spec.signatureEx) {
    streams.push({
      name: String.fromCharCode(5) + 'MsiDigitalSignatureEx',
      data: new Uint8Array(32),
    });
  }
  streams.push(...(spec.rawStreams ?? []));

  return buildCfb({
    clsid: guidBytes(spec.clsid ?? CLSID_MSI),
    streams,
    storages: spec.storages,
    sectorShift: spec.sectorShift,
  });
}
