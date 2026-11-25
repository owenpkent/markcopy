// Building ELF files as exact bytes.
//
// Written from the System V gABI (ELF header, program and section headers, the
// dynamic section) and the GNU extensions (PT_GNU_STACK, PT_GNU_RELRO,
// DT_FLAGS_1, the build-id and ABI-tag notes), not from src/pkg/elf.ts.
//
// Layout: ELF header, program header table, then the body (interpreter, notes,
// dynamic string table, dynamic section, section contents, section name
// table), then the section header table. One PT_LOAD maps the whole file at
// BASE, so a virtual address is BASE plus a file offset.

export const BASE = 0x400000;

export interface SectionSpec {
  name: string;
  /** SHT_* value; 1 (PROGBITS) by default. */
  type?: number;
  /** The contents, or a function of the section's virtual address for contents that point into the file. */
  data?: Uint8Array | string | ((vaddr: number) => Uint8Array);
  /** Place the section at a file offset that is a multiple of this. */
  align?: number;
  /** Size to declare when it should differ from the data (NOBITS sections). */
  size?: number;
}

export interface ElfSpec {
  /** 64-bit unless false. */
  wide?: boolean;
  /** Big-endian when true. */
  big?: boolean;
  /** e_type: 1 REL, 2 EXEC, 3 DYN, 4 CORE. */
  type?: number;
  machine?: number;
  osAbi?: number;
  entry?: number;
  interp?: string;
  soname?: string;
  needed?: string[];
  rpath?: string;
  runpath?: string;
  /** DT_FLAGS value, when present. */
  flags?: number;
  /** DT_FLAGS_1 value, when present. */
  flags1?: number;
  /** Emit a DT_BIND_NOW entry. */
  bindNow?: boolean;
  /** PT_GNU_STACK: 'nx' (RW), 'exec' (RWX) or none. Defaults to 'nx'. */
  stack?: 'nx' | 'exec' | 'none';
  relro?: boolean;
  buildId?: number[];
  /** [os, major, minor, patch] of the GNU ABI tag note. */
  abiTag?: [number, number, number, number];
  goBuildId?: string;
  sections?: SectionSpec[];
  /** p_flags of the PT_LOAD segment: 5 (read, execute) unless given; 6 is writable. */
  loadFlags?: number;
  /** Leave out program headers (an object file, a kernel module). */
  noProgramHeaders?: boolean;
  /** Leave out the section header table. */
  noSections?: boolean;
  /** AppImage type byte (1 or 2) and the bytes appended after the ELF. */
  appImage?: number;
  payload?: Uint8Array | string;
}

class Writer {
  readonly out: number[] = [];
  constructor(
    private readonly le: boolean,
    private readonly wide: boolean,
  ) {}
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
  u64(v: number): this {
    const lo = v % 0x100000000;
    const hi = Math.floor(v / 0x100000000);
    return this.le ? this.u32(lo).u32(hi) : this.u32(hi).u32(lo);
  }
  /** An address, offset or size: 4 bytes in a 32-bit file, 8 in a 64-bit one. */
  word(v: number): this {
    return this.wide ? this.u64(v) : this.u32(v);
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

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const asBytes = (data: Uint8Array | string | undefined): Uint8Array =>
  typeof data === 'string' ? utf8(data) : (data ?? new Uint8Array(0));

const PT = {
  LOAD: 1,
  DYNAMIC: 2,
  INTERP: 3,
  NOTE: 4,
  GNU_STACK: 0x6474e551,
  GNU_RELRO: 0x6474e552,
};

export function buildElf(spec: ElfSpec = {}): Uint8Array {
  const wide = spec.wide ?? true;
  const le = !(spec.big ?? false);
  const type = spec.type ?? 3;
  const hdrSize = wide ? 64 : 52;
  const phSize = wide ? 56 : 32;
  const shSize = wide ? 64 : 40;
  const isDynamic =
    !spec.noProgramHeaders &&
    (spec.needed !== undefined ||
      spec.soname !== undefined ||
      spec.rpath !== undefined ||
      spec.runpath !== undefined ||
      spec.flags !== undefined ||
      spec.flags1 !== undefined ||
      spec.bindNow === true);

  // Strings of the dynamic section share one table.
  const dynstr: number[] = [0];
  const addString = (s: string): number => {
    const at = dynstr.length;
    dynstr.push(...utf8(s), 0);
    return at;
  };

  const notes = new Writer(le, wide);
  const note = (name: string, kind: number, desc: ArrayLike<number>): void => {
    const nameBytes = [...utf8(name), 0];
    notes.u32(nameBytes.length).u32(desc.length).u32(kind).raw(nameBytes).pad(4);
    notes.raw(desc).pad(4);
  };
  if (spec.abiTag) {
    const d = new Writer(le, wide);
    spec.abiTag.forEach((n) => d.u32(n));
    note('GNU', 1, d.out);
  }
  if (spec.buildId) {
    note('GNU', 3, spec.buildId);
  }
  if (spec.goBuildId) {
    note('Go', 4, utf8(spec.goBuildId));
  }

  const segmentKinds: number[] = [];
  if (!spec.noProgramHeaders) {
    segmentKinds.push(PT.LOAD);
    if (spec.interp !== undefined) {
      segmentKinds.push(PT.INTERP);
    }
    if (isDynamic) {
      segmentKinds.push(PT.DYNAMIC);
    }
    if (notes.length > 0) {
      segmentKinds.push(PT.NOTE);
    }
    if ((spec.stack ?? 'nx') !== 'none') {
      segmentKinds.push(PT.GNU_STACK);
    }
    if (spec.relro) {
      segmentKinds.push(PT.GNU_RELRO);
    }
  }

  const body = new Writer(le, wide);
  const bodyStart = hdrSize + segmentKinds.length * phSize;
  const at = (): number => bodyStart + body.length;

  let interpOffset = 0;
  let interpLength = 0;
  if (spec.interp !== undefined) {
    interpOffset = at();
    const bytes = [...utf8(spec.interp), 0];
    interpLength = bytes.length;
    body.raw(bytes).pad(8);
  }
  const noteOffset = at();
  body.raw(notes.out).pad(8);

  let dynstrOffset = 0;
  let dynOffset = 0;
  let dynLength = 0;
  let dynstrLength = 0;
  if (isDynamic) {
    const entries: [number, number][] = [];
    for (const lib of spec.needed ?? []) {
      entries.push([1, addString(lib)]);
    }
    if (spec.soname !== undefined) {
      entries.push([14, addString(spec.soname)]);
    }
    if (spec.rpath !== undefined) {
      entries.push([15, addString(spec.rpath)]);
    }
    if (spec.runpath !== undefined) {
      entries.push([29, addString(spec.runpath)]);
    }
    if (spec.flags !== undefined) {
      entries.push([30, spec.flags]);
    }
    if (spec.flags1 !== undefined) {
      entries.push([0x6ffffffb, spec.flags1]);
    }
    if (spec.bindNow) {
      entries.push([24, 0]);
    }
    dynstrOffset = at();
    dynstrLength = dynstr.length;
    body.raw(dynstr).pad(8);
    entries.push([5, BASE + dynstrOffset], [10, dynstrLength], [0, 0]);
    dynOffset = at();
    for (const [tag, value] of entries) {
      body.word(tag).word(value);
    }
    dynLength = entries.length * (wide ? 16 : 8);
  }

  // Sections: null, then the dynamic string table when there is one, the
  // caller's, and the section name table last.
  const userSections = spec.sections ?? [];
  const placed: { name: string; type: number; offset: number; size: number }[] = [];
  if (isDynamic) {
    placed.push({ name: '.dynstr', type: 3, offset: dynstrOffset, size: dynstrLength });
  }
  if (notes.length > 0) {
    placed.push({ name: '.note.gnu.build-id', type: 7, offset: noteOffset, size: notes.length });
  }
  for (const s of userSections) {
    while (s.align && at() % s.align !== 0) {
      body.u8(0);
    }
    const offset = at();
    const data = typeof s.data === 'function' ? s.data(BASE + offset) : asBytes(s.data);
    if (s.type !== 8) {
      body.raw(data).pad(4);
    }
    placed.push({ name: s.name, type: s.type ?? 1, offset, size: s.size ?? data.length });
  }

  let shoff = 0;
  let shnum = 0;
  let shstrndx = 0;
  const table = new Writer(le, wide);
  if (!spec.noSections) {
    const names: number[] = [0];
    const nameOf = (name: string): number => {
      const start = names.length;
      names.push(...utf8(name), 0);
      return start;
    };
    const all = [...placed];
    const nameOffsets = all.map((s) => nameOf(s.name));
    const shstrName = nameOf('.shstrtab');
    const shstrOffset = at();
    body.raw(names).pad(8);
    all.push({ name: '.shstrtab', type: 3, offset: shstrOffset, size: names.length });
    nameOffsets.push(shstrName);
    shoff = bodyStart + body.length;
    shnum = all.length + 1;
    shstrndx = all.length;
    const header = (nameOff: number, kind: number, offset: number, size: number): void => {
      table.u32(nameOff).u32(kind);
      if (wide) {
        table.u64(0).u64(0).u64(offset).u64(size).u32(0).u32(0).u64(1).u64(0);
      } else {
        table.u32(0).u32(0).u32(offset).u32(size).u32(0).u32(0).u32(1).u32(0);
      }
    };
    header(0, 0, 0, 0);
    all.forEach((s, i) => header(nameOffsets[i], s.type, s.offset, s.size));
  }

  const fileSize = bodyStart + body.length + table.length;
  const phdrs = new Writer(le, wide);
  for (const kind of segmentKinds) {
    let flags = 4;
    let offset = 0;
    let size = 0;
    let align = 8;
    switch (kind) {
      case PT.LOAD:
        flags = spec.loadFlags ?? 5;
        offset = 0;
        size = fileSize;
        align = 0x1000;
        break;
      case PT.INTERP:
        offset = interpOffset;
        size = interpLength;
        align = 1;
        break;
      case PT.DYNAMIC:
        flags = 6;
        offset = dynOffset;
        size = dynLength;
        break;
      case PT.NOTE:
        offset = noteOffset;
        size = notes.length;
        align = 4;
        break;
      case PT.GNU_STACK:
        flags = spec.stack === 'exec' ? 7 : 6;
        align = 16;
        break;
      case PT.GNU_RELRO:
        offset = dynOffset;
        size = dynLength;
        align = 1;
        break;
    }
    const vaddr = kind === PT.GNU_STACK ? 0 : BASE + offset;
    if (wide) {
      phdrs.u32(kind).u32(flags).u64(offset).u64(vaddr).u64(vaddr).u64(size).u64(size).u64(align);
    } else {
      phdrs.u32(kind).u32(offset).u32(vaddr).u32(vaddr).u32(size).u32(size).u32(flags).u32(align);
    }
  }

  const head = new Writer(le, wide);
  head.raw([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, le ? 1 : 2, 1, spec.osAbi ?? 0]);
  if (spec.appImage) {
    head.raw([0x41, 0x49, spec.appImage]);
  }
  head.pad(16);
  head
    .u16(type)
    .u16(spec.machine ?? 62)
    .u32(1);
  head
    .word(spec.entry ?? 0x1040)
    .word(segmentKinds.length > 0 ? hdrSize : 0)
    .word(shoff);
  head
    .u32(0)
    .u16(hdrSize)
    .u16(phSize)
    .u16(segmentKinds.length)
    .u16(shSize)
    .u16(shnum)
    .u16(shstrndx);

  const out = new Writer(le, wide);
  out.raw(head.out).raw(phdrs.out).raw(body.out).raw(table.out);
  if (spec.appImage) {
    out.raw(asBytes(spec.payload ?? 'hsqs-image'));
  }
  return Uint8Array.from(out.out);
}

/** Byte offsets of the header fields a test may overwrite, per class. */
export const FIELDS = {
  wide: { phoff: 32, shoff: 40, phentsize: 54, phnum: 56, shentsize: 58, shnum: 60, shstrndx: 62 },
  narrow: {
    phoff: 28,
    shoff: 32,
    phentsize: 42,
    phnum: 44,
    shentsize: 46,
    shnum: 48,
    shstrndx: 50,
  },
};
