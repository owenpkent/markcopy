// Building Mach-O and universal binaries as exact bytes.
//
// Written from Apple's <mach-o/loader.h> and <mach-o/fat.h>, not from
// src/pkg/macho.ts. A file is a header, then load commands, then whatever
// trailing bytes a test asks for. A load command is a function of the file's
// byte order and word size, so one description builds all four variants.

export type Cmd = (le: boolean, wide: boolean) => number[];

export interface MachoSpec {
  /** 64-bit unless false. */
  wide?: boolean;
  /** Big-endian when true. */
  big?: boolean;
  cputype?: number;
  cpusubtype?: number;
  /** MH_*: 1 object, 2 execute, 6 dylib, and so on. Executable by default. */
  filetype?: number;
  flags?: number;
  commands?: Cmd[];
  /** Header values to write instead of the true ones. */
  ncmds?: number;
  sizeofcmds?: number;
  /** Bytes after the load commands. */
  tail?: number[];
}

export const CPU = {
  X86: 7,
  X86_64: 0x01000007,
  ARM: 12,
  ARM64: 0x0100000c,
  ARM64_32: 0x0200000c,
  PPC: 18,
  PPC64: 0x01000012,
};

export const LC = {
  SEGMENT: 0x1,
  LOAD_DYLIB: 0xc,
  ID_DYLIB: 0xd,
  LOAD_DYLINKER: 0xe,
  UUID: 0x1b,
  CODE_SIGNATURE: 0x1d,
  SEGMENT_64: 0x19,
  ENCRYPTION_INFO: 0x21,
  LAZY_LOAD_DYLIB: 0x20,
  VERSION_MIN_MACOSX: 0x24,
  VERSION_MIN_IPHONEOS: 0x25,
  SOURCE_VERSION: 0x2a,
  ENCRYPTION_INFO_64: 0x2c,
  VERSION_MIN_TVOS: 0x2f,
  VERSION_MIN_WATCHOS: 0x30,
  BUILD_VERSION: 0x32,
  LOAD_WEAK_DYLIB: 0x80000018,
  RPATH: 0x8000001c,
  REEXPORT_DYLIB: 0x8000001f,
  LOAD_UPWARD_DYLIB: 0x80000023,
  MAIN: 0x80000028,
};

export const MH_PIE = 0x200000;
export const MH_ALLOW_STACK_EXECUTION = 0x20000;
export const MH_NO_HEAP_EXECUTION = 0x1000000;

class Writer {
  readonly out: number[] = [];
  constructor(private readonly le: boolean) {}
  get length(): number {
    return this.out.length;
  }
  u8(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.le ? this.u8(v).u8(v >>> 8) : this.u8(v >>> 8).u8(v);
  }
  u32(v: number): this {
    return this.le ? this.u16(v & 0xffff).u16(v >>> 16) : this.u16(v >>> 16).u16(v & 0xffff);
  }
  u64(v: number | bigint): this {
    const n = BigInt(v);
    const lo = Number(n & 0xffffffffn);
    const hi = Number((n >> 32n) & 0xffffffffn);
    return this.le ? this.u32(lo).u32(hi) : this.u32(hi).u32(lo);
  }
  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) {
      this.out.push(bytes[i]);
    }
    return this;
  }
  pad(to: number): this {
    while (this.out.length % to !== 0) {
      this.out.push(0);
    }
    return this;
  }
}

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)];

/** X.Y.Z as the 16.8.8 bit packing every version field except the source version uses. */
export const ver = (x: number, y = 0, z = 0): number => (x << 16) | (y << 8) | z;

/** A command with its size filled in and padded to the word size. */
function command(kind: number, fill: (w: Writer) => void, options: { size?: number } = {}): Cmd {
  return (le, wide) => {
    const body = new Writer(le);
    fill(body);
    body.pad(wide ? 8 : 4);
    const out = new Writer(le);
    out
      .u32(kind)
      .u32(options.size ?? body.length + 8)
      .raw(body.out);
    return out.out;
  };
}

/** A command whose declared size is whatever a test wants, with `payload` after the size. */
export function rawCommand(kind: number, cmdsize: number, payload: number[] = []): Cmd {
  return (le) => new Writer(le).u32(kind).u32(cmdsize).raw(payload).out;
}

/** An lc_str command: `fixed` bytes of fields after the name offset, then the string. */
function withString(
  kind: number,
  text: string,
  fixed: (w: Writer) => void,
  fixedBytes: number,
  nameOffset?: number,
): Cmd {
  return command(kind, (w) => {
    w.u32(nameOffset ?? 8 + 4 + fixedBytes);
    fixed(w);
    w.raw(utf8(text)).u8(0);
  });
}

export const dylib = (
  kind: number,
  name: string,
  current = ver(1),
  compat = ver(1),
  nameOffset?: number,
): Cmd => withString(kind, name, (w) => w.u32(2).u32(current).u32(compat), 12, nameOffset);

export const rpath = (path: string, nameOffset?: number): Cmd =>
  withString(LC.RPATH, path, () => undefined, 0, nameOffset);

export const dylinker = (path = '/usr/lib/dyld', nameOffset?: number): Cmd =>
  withString(LC.LOAD_DYLINKER, path, () => undefined, 0, nameOffset);

export const uuid = (bytes: number[]): Cmd => command(LC.UUID, (w) => w.raw(bytes));

export const buildVersion = (
  platform: number,
  minos: number,
  sdk: number,
  tools: [number, number][] = [],
): Cmd =>
  command(LC.BUILD_VERSION, (w) => {
    w.u32(platform).u32(minos).u32(sdk).u32(tools.length);
    for (const [tool, version] of tools) {
      w.u32(tool).u32(version);
    }
  });

export const versionMin = (kind: number, version: number, sdk: number): Cmd =>
  command(kind, (w) => w.u32(version).u32(sdk));

/** A.B.C.D.E packed 24.10.10.10.10. */
export const sourceVersion = (a: number, b: number, c: number, d: number, e: number): Cmd =>
  command(LC.SOURCE_VERSION, (w) =>
    w.u64(
      (BigInt(a) << 40n) | (BigInt(b) << 30n) | (BigInt(c) << 20n) | (BigInt(d) << 10n) | BigInt(e),
    ),
  );

export const main = (entryoff: number, stacksize = 0): Cmd =>
  command(LC.MAIN, (w) => w.u64(entryoff).u64(stacksize));

export const linkedit = (kind: number, dataoff: number, datasize: number): Cmd =>
  command(kind, (w) => w.u32(dataoff).u32(datasize));

export const encryption = (kind: number, cryptid: number): Cmd =>
  command(kind, (w) => {
    w.u32(0x1000).u32(0x2000).u32(cryptid);
    if (kind === LC.ENCRYPTION_INFO_64) {
      w.u32(0);
    }
  });

export interface SegmentSpec {
  vmsize?: number;
  filesize?: number;
  maxprot?: number;
  initprot?: number;
  nsects?: number;
}

/** LC_SEGMENT or LC_SEGMENT_64 by the file's word size, with no section records. */
export const segment =
  (name: string, s: SegmentSpec = {}): Cmd =>
  (le, wide) => {
    const w = new Writer(le);
    const nameBytes = utf8(name).slice(0, 16);
    while (nameBytes.length < 16) {
      nameBytes.push(0);
    }
    const fields = new Writer(le);
    fields.raw(nameBytes);
    if (wide) {
      fields
        .u64(0x100000000)
        .u64(s.vmsize ?? 0x4000)
        .u64(0)
        .u64(s.filesize ?? 0x4000);
    } else {
      fields
        .u32(0x1000)
        .u32(s.vmsize ?? 0x4000)
        .u32(0)
        .u32(s.filesize ?? 0x4000);
    }
    fields
      .u32(s.maxprot ?? 5)
      .u32(s.initprot ?? 5)
      .u32(s.nsects ?? 0)
      .u32(0);
    w.u32(wide ? LC.SEGMENT_64 : LC.SEGMENT)
      .u32(8 + fields.length)
      .raw(fields.out);
    return w.out;
  };

export function buildMacho(spec: MachoSpec = {}): Uint8Array {
  const wide = spec.wide ?? true;
  const le = !(spec.big ?? false);
  const body = new Writer(le);
  const commands = spec.commands ?? [];
  for (const c of commands) {
    body.raw(c(le, wide));
  }
  const head = new Writer(le);
  // The magic is stored as a word, so a big-endian file reads 0xfeedface and
  // a little-endian one has the same four bytes reversed.
  head.u32(wide ? 0xfeedfacf : 0xfeedface);
  head
    .u32(spec.cputype ?? (wide ? CPU.X86_64 : CPU.X86))
    .u32(spec.cpusubtype ?? 3)
    .u32(spec.filetype ?? 2)
    .u32(spec.ncmds ?? commands.length)
    .u32(spec.sizeofcmds ?? body.length)
    .u32(spec.flags ?? 0);
  if (wide) {
    head.u32(0);
  }
  return Uint8Array.from([...head.out, ...body.out, ...(spec.tail ?? [])]);
}

export interface FatSlice {
  bytes: Uint8Array;
  cputype: number;
  cpusubtype?: number;
}

/**
 * A universal binary: a big-endian header and architecture table, each slice
 * placed at the next multiple of `align` (16 KiB by default, as Apple's tools
 * do for arm64).
 */
export function buildFat(
  slices: FatSlice[],
  options: { wide?: boolean; align?: number } = {},
): Uint8Array {
  const wide = options.wide ?? false;
  const align = options.align ?? 0x4000;
  const entry = wide ? 32 : 20;
  const roundUp = (n: number): number => Math.ceil(n / align) * align;
  const out: number[] = [];
  const head = new Writer(false);
  head.u32(wide ? 0xcafebabf : 0xcafebabe).u32(slices.length);
  let at = roundUp(8 + slices.length * entry);
  const offsets: number[] = [];
  for (const s of slices) {
    offsets.push(at);
    head.u32(s.cputype).u32(s.cpusubtype ?? 0);
    if (wide) {
      head.u64(at).u64(s.bytes.length).u32(Math.log2(align)).u32(0);
    } else {
      head.u32(at).u32(s.bytes.length).u32(Math.log2(align));
    }
    at = roundUp(at + s.bytes.length);
  }
  out.push(...head.out);
  slices.forEach((s, i) => {
    while (out.length < offsets[i]) {
      out.push(0);
    }
    for (const b of s.bytes) {
      out.push(b);
    }
  });
  return Uint8Array.from(out);
}

/** A Java class file header: 0xcafebabe, minor and major version, then a constant pool of zeros. */
export function buildClassFileLike(major = 52, minor = 0, size = 4096): Uint8Array {
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint16(4, minor, false);
  v.setUint16(6, major, false);
  return out;
}
