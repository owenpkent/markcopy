// Go build information: what `go version -m` prints.
//
// A program built by the Go toolchain embeds the toolchain's version and, since
// Go 1.13, the module list it was built from. Go's own reader is
// src/debug/buildinfo/buildinfo.go; this is written from that format.
//
// The block starts with a 32-byte header: the 14 bytes "\xff Go buildinf:", the
// pointer size, and a flags byte (bit 0: big-endian; bit 1: the strings follow
// the header inline, Go 1.18 and later). In the older layout the header holds
// two pointers to string headers, which are virtual addresses the caller maps
// to file offsets. The module text carries a 16-byte sentinel at each end, then
// lines of tab-separated fields.
//
// The file is untrusted: every length is capped before a read, every read goes
// through the ranged reader, and every string passes through the text cleaning.
//
// No `vscode` import: this runs in the worker thread.
import { ReadError, type RangeReader } from './reader';
import { clip, printable } from './text';
import type { Row } from './html';

const MAGIC = [
  0xff, 0x20, 0x47, 0x6f, 0x20, 0x62, 0x75, 0x69, 0x6c, 0x64, 0x69, 0x6e, 0x66, 0x3a,
] as const;
const HEADER_BYTES = 32;
// Go aligns the block to 16 bytes, and it sits near the start of its section.
const SEARCH_BYTES = 64 * 1024;
const ALIGN = 16;
const MAX_VERSION_BYTES = 64;
const MAX_MODINFO_BYTES = 256 * 1024;
const MAX_LINES = 2000;
const MAX_DEPS = 500;
const MAX_SETTINGS = 64;
const MAX_FIELD_CHARS = 512;
const SENTINEL = 16;

/** The most module rows a page draws. */
export const GO_MODULE_ROWS = 200;

export interface GoReplacement {
  path: string;
  version: string;
}

export interface GoModule {
  path: string;
  version: string;
  replacedBy?: GoReplacement;
}

export interface GoBuildInfo {
  /** The toolchain that built the program, such as "go1.22.1". */
  goVersion: string;
  /** The main package's import path. */
  path?: string;
  /** The main module. */
  module?: GoModule;
  /** The first modules the program depends on, in the order the file lists them. */
  deps: GoModule[];
  /** Every dependency the file lists, including those past the cap on `deps`. */
  depTotal: number;
  /** The build settings (`-trimpath`, `CGO_ENABLED`, `GOARCH`, `vcs.revision`...). */
  settings: [string, string][];
  /** Parts that were present but not read. */
  warnings: string[];
}

export type ParsedModinfo = Omit<GoBuildInfo, 'goVersion' | 'warnings'>;

// Tabs and line breaks become spaces before the cleaning removes control
// characters: an unquoted `-ldflags` value can separate two flags with a tab,
// and dropping it would run them together.
const field = (text: string): string =>
  clip(printable(text.slice(0, 2 * MAX_FIELD_CHARS).replace(/[\t\n\r\v\f]/g, ' ')), 512);

/** An unsigned LEB128 number as Go's binary.Uvarint reads it: at most 10 bytes, no overflow. */
export function uvarint(bytes: Uint8Array, at = 0): { value: number; length: number } | undefined {
  let value = 0;
  for (let i = 0; i < 10; i++) {
    const b = bytes[at + i];
    if (b === undefined) {
      return undefined;
    }
    if (b < 0x80) {
      // The tenth byte may only carry the 64th bit.
      if (i === 9 && b > 1) {
        return undefined;
      }
      return { value: value + b * 2 ** (7 * i), length: i + 1 };
    }
    value += (b & 0x7f) * 2 ** (7 * i);
  }
  return undefined;
}

/** Drop the 16-byte sentinels Go puts around the module text, when they are there. */
export function stripSentinels(raw: Uint8Array): Uint8Array {
  if (raw.length >= 2 * SENTINEL + 1 && raw[raw.length - SENTINEL - 1] === 0x0a) {
    return raw.subarray(SENTINEL, raw.length - SENTINEL);
  }
  return raw;
}

/**
 * Go's strconv.Unquote for a double-quoted or back-quoted string, or undefined
 * when `text` is not exactly one. Escapes: \a \b \f \n \r \t \v \\ \", \xHH and
 * \ooo (one byte each), \uHHHH and \UHHHHHHHH (one code point). A single quote
 * may not be escaped in a double-quoted string, as in Go.
 */
export function goUnquote(text: string): string | undefined {
  const quote = text[0];
  if (text.length < 2 || text[text.length - 1] !== quote) {
    return undefined;
  }
  const inner = text.slice(1, -1);
  if (quote === '`') {
    return inner.includes('`') ? undefined : inner.replace(/\r/g, '');
  }
  if (quote !== '"') {
    return undefined;
  }
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const SIMPLE: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
    '\\': 0x5c,
    '"': 0x22,
  };
  const hex = (at: number, count: number): number | undefined => {
    const digits = inner.slice(at, at + count);
    return digits.length === count && /^[0-9a-fA-F]+$/.test(digits)
      ? parseInt(digits, 16)
      : undefined;
  };
  for (let i = 0; i < inner.length;) {
    const c = inner[i];
    if (c === '"' || c === '\n') {
      return undefined;
    }
    if (c !== '\\') {
      const code = inner.codePointAt(i) as number;
      const width = code > 0xffff ? 2 : 1;
      bytes.push(...encoder.encode(inner.slice(i, i + width)));
      i += width;
      continue;
    }
    const e = inner[i + 1];
    if (e === undefined) {
      return undefined;
    }
    if (e in SIMPLE) {
      bytes.push(SIMPLE[e]);
      i += 2;
    } else if (e === 'x') {
      const v = hex(i + 2, 2);
      if (v === undefined) {
        return undefined;
      }
      bytes.push(v);
      i += 4;
    } else if (e >= '0' && e <= '7') {
      const digits = inner.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(digits) || parseInt(digits, 8) > 255) {
        return undefined;
      }
      bytes.push(parseInt(digits, 8));
      i += 4;
    } else if (e === 'u' || e === 'U') {
      const width = e === 'u' ? 4 : 8;
      const v = hex(i + 2, width);
      if (v === undefined || v > 0x10ffff || (v >= 0xd800 && v < 0xe000)) {
        return undefined;
      }
      bytes.push(...encoder.encode(String.fromCodePoint(v)));
      i += 2 + width;
    } else {
      return undefined;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** The leading quoted string of `text` (Go's strconv.QuotedPrefix), or undefined. */
function quotedPrefix(text: string): string | undefined {
  const quote = text[0];
  if (quote === '`') {
    const end = text.indexOf('`', 1);
    return end < 0 ? undefined : text.slice(0, end + 1);
  }
  if (quote !== '"') {
    return undefined;
  }
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '"') {
      const prefix = text.slice(0, i + 1);
      return goUnquote(prefix) === undefined ? undefined : prefix;
    } else if (text[i] === '\n') {
      return undefined;
    }
  }
  return undefined;
}

/**
 * `key=value` as runtime/debug.ParseBuildInfo reads a build line: a key or value
 * starting with a quote is a Go quoted string. A line Go would reject (no key, a
 * bad quoted key, no `=`) gives nothing; a value that does not unquote is kept as written.
 */
function parseSetting(kv: string): [string, string] | undefined {
  if (kv === '' || kv[0] === '=') {
    return undefined;
  }
  let key: string;
  let raw: string;
  if (kv[0] === '"' || kv[0] === '`') {
    const prefix = quotedPrefix(kv);
    if (prefix === undefined || kv[prefix.length] !== '=') {
      return undefined;
    }
    key = goUnquote(prefix) ?? prefix;
    raw = kv.slice(prefix.length + 1);
  } else {
    const eq = kv.indexOf('=');
    if (eq < 0) {
      return undefined;
    }
    key = kv.slice(0, eq);
    raw = kv.slice(eq + 1);
  }
  const quoted = raw[0] === '"' || raw[0] === '`';
  return [key, quoted ? (goUnquote(raw) ?? raw) : raw];
}

/** The module text of a Go binary, as bytes with the sentinels still on or already off. */
export function parseModinfo(input: Uint8Array | string): ParsedModinfo {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const text = new TextDecoder().decode(stripSentinels(bytes));
  const out: ParsedModinfo = { deps: [], depTotal: 0, settings: [] };
  // What a "=>" line replaces: the module or dependency just before it.
  let last: GoModule | undefined;
  let pos = 0;
  // Past the first MAX_LINES lines only dependencies are counted, so the total
  // stays true. The text is already capped at MAX_MODINFO_BYTES, so this loop is too.
  for (let n = 0; pos <= text.length; n++) {
    let end = text.indexOf('\n', pos);
    if (end < 0) {
      end = text.length;
    }
    const line = text.slice(pos, end);
    pos = end + 1;
    if (n >= MAX_LINES) {
      if (line.startsWith('dep\t')) {
        out.depTotal++;
      }
      continue;
    }
    const parts = line.split('\t');
    switch (parts[0]) {
      case 'path':
        out.path = field(parts[1] ?? '') || undefined;
        break;
      case 'mod':
        out.module = { path: field(parts[1] ?? ''), version: field(parts[2] ?? '') };
        last = out.module;
        break;
      case 'dep': {
        out.depTotal++;
        if (out.deps.length < MAX_DEPS) {
          last = { path: field(parts[1] ?? ''), version: field(parts[2] ?? '') };
          out.deps.push(last);
        } else {
          last = undefined;
        }
        break;
      }
      case '=>':
        if (last && !last.replacedBy) {
          last.replacedBy = { path: field(parts[1] ?? ''), version: field(parts[2] ?? '') };
        }
        break;
      case 'build': {
        if (out.settings.length >= MAX_SETTINGS) {
          break;
        }
        const setting = parseSetting(line.slice('build\t'.length));
        if (setting) {
          out.settings.push([field(setting[0]), field(setting[1])]);
        }
        break;
      }
    }
  }
  return out;
}

/**
 * The offset of the build information header in `bytes`, at the 16-byte
 * alignment Go gives it. `vaddr` is the virtual address of `bytes[0]`: Go aligns
 * addresses, not file offsets, so the probes fall where the address is a
 * multiple of 16.
 */
export function findHeader(bytes: Uint8Array, vaddr: bigint | number = 0): number | undefined {
  const first = (ALIGN - Number(BigInt(vaddr) % BigInt(ALIGN))) % ALIGN;
  for (let at = first; at + MAGIC.length <= bytes.length; at += ALIGN) {
    let same = true;
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[at + i] !== MAGIC[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      return at;
    }
  }
  return undefined;
}

const damaged = (): ReadError => new ReadError('its Go build information is damaged.');

/** Where a virtual address lies in the file, and how many file-backed bytes follow it in its segment or section. */
export interface MappedAddress {
  offset: number;
  available: number;
}

/** Go's check on the module text before it strips the sentinels. */
const framed = (raw: Uint8Array): boolean =>
  raw.length >= 2 * SENTINEL + 1 && raw[raw.length - SENTINEL - 1] === 0x0a;

/**
 * Read the Go build information from `region` of the file, a data section or
 * segment. `region.vaddr` is its virtual address (for the alignment of the
 * search) and `region.search` caps how many of its bytes are searched. Gives
 * nothing when the region holds none. Throws a ReadError when it holds a header
 * that points outside the file or the region, or makes no sense; the caller
 * turns that into a warning. `toOffset` maps a virtual address to a file offset
 * and the bytes available from it, or nothing when no file data backs it.
 */
export async function readGoBuildInfo(
  reader: RangeReader,
  region: { offset: number; size: number; vaddr?: bigint | number; search?: number },
  toOffset: (address: bigint) => MappedAddress | undefined,
): Promise<GoBuildInfo | undefined> {
  const head = await reader.upTo(
    region.offset,
    Math.min(region.size, region.search ?? SEARCH_BYTES, SEARCH_BYTES),
  );
  const found = findHeader(head, region.vaddr ?? 0);
  if (found === undefined) {
    return undefined;
  }
  const start = region.offset + found;
  const end = region.offset + region.size;
  if (start + HEADER_BYTES > end) {
    throw damaged();
  }
  const header = await reader.bytes(start, HEADER_BYTES);
  const pointerSize = header[14];
  if (pointerSize !== 4 && pointerSize !== 8) {
    throw damaged();
  }
  const flags = header[15];
  const le = (flags & 1) === 0;
  const inline = (flags & 2) !== 0;
  const warnings: string[] = [];

  let versionBytes: Uint8Array;
  let modinfo: Uint8Array | undefined;
  if (inline) {
    let at = start + HEADER_BYTES;
    const lengthOf = async (): Promise<{ value: number; length: number }> => {
      // Nothing past the end of the region is read, whatever follows it in the file.
      const v = uvarint(await reader.upTo(at, Math.max(0, Math.min(10, end - at))));
      if (!v) {
        throw damaged();
      }
      return v;
    };
    const inside = (length: number): void => {
      if (at + length > end) {
        throw damaged();
      }
    };
    const version = await lengthOf();
    if (version.value > MAX_VERSION_BYTES) {
      throw damaged();
    }
    at += version.length;
    inside(version.value);
    versionBytes = await reader.bytes(at, version.value);
    at += version.value;
    // A binary may end after the version, as one with no module text does.
    if (at < end && at < reader.size) {
      const info = await lengthOf();
      at += info.length;
      if (info.value > MAX_MODINFO_BYTES) {
        warnings.push('The Go module list is too long to read, so only the Go version is shown.');
      } else {
        inside(info.value);
        modinfo = await reader.bytes(at, info.value);
      }
    }
  } else {
    const pointers = await reader.view(start + 16, 2 * pointerSize);
    const pointer = (view: DataView, at: number): bigint =>
      pointerSize === 8 ? view.getBigUint64(at, le) : BigInt(view.getUint32(at, le));
    // A string header is a data pointer and a length, each a pointer wide. Both
    // it and the payload must lie inside the segment or section they start in.
    const stringAt = async (
      address: bigint,
      cap: number,
    ): Promise<{ bytes?: Uint8Array; tooLong: boolean }> => {
      const headerAt = toOffset(address);
      if (headerAt === undefined || headerAt.available < 2 * pointerSize) {
        throw damaged();
      }
      const sh = await reader.view(headerAt.offset, 2 * pointerSize);
      const length = pointer(sh, pointerSize);
      if (length > BigInt(cap)) {
        return { tooLong: true };
      }
      if (length === 0n) {
        return { bytes: new Uint8Array(0), tooLong: false };
      }
      const data = toOffset(pointer(sh, 0));
      if (data === undefined || data.available < Number(length)) {
        throw damaged();
      }
      return { bytes: await reader.bytes(data.offset, Number(length)), tooLong: false };
    };
    const version = await stringAt(pointer(pointers, 0), MAX_VERSION_BYTES);
    if (!version.bytes) {
      throw damaged();
    }
    versionBytes = version.bytes;
    const modPointer = pointer(pointers, pointerSize);
    if (modPointer !== 0n) {
      const info = await stringAt(modPointer, MAX_MODINFO_BYTES);
      if (info.tooLong) {
        warnings.push('The Go module list is too long to read, so only the Go version is shown.');
      } else {
        modinfo = info.bytes;
      }
    }
  }

  const goVersion = printable(new TextDecoder().decode(versionBytes)).trim();
  if (goVersion === '') {
    throw damaged();
  }
  // Go keeps the module text only when it is framed by the sentinels; otherwise
  // it keeps the version alone.
  if (modinfo && modinfo.length > 0 && !framed(modinfo)) {
    modinfo = undefined;
    warnings.push("The Go module list's framing is damaged, so it is not shown.");
  }
  const parsed: ParsedModinfo = modinfo
    ? parseModinfo(modinfo)
    : { deps: [], depTotal: 0, settings: [] };
  return { goVersion, ...parsed, warnings };
}

/** What a module's version column says, with its replacement when it has one. */
export function moduleVersion(module: GoModule): string {
  const r = module.replacedBy;
  if (!r) {
    return module.version;
  }
  const by = `replaced by ${r.path}${r.version ? ` ${r.version}` : ''}`;
  return module.version ? `${module.version}, ${by}` : by;
}

/** The facts about the program itself, as rows for a properties table. */
export function goProperties(info: GoBuildInfo): Row[] {
  const rows: Row[] = [['Go version', info.goVersion]];
  if (info.path) {
    rows.push(['Package', info.path]);
  }
  if (info.module?.path) {
    rows.push(['Module', info.module.path]);
  }
  if (info.module?.version) {
    rows.push(['Module version', info.module.version]);
  }
  const r = info.module?.replacedBy;
  if (r) {
    rows.push(['Module replaced by', r.version ? `${r.path} ${r.version}` : r.path]);
  }
  return rows;
}

/** One row per dependency: its path and version (with any replacement). */
export function goModuleRows(info: GoBuildInfo): string[][] {
  return info.deps.map((d) => [d.path, moduleVersion(d)]);
}
