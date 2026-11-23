// ELF reader: shared libraries, executables, kernel modules and AppImages.
//
// Written from the System V gABI and the Linux extensions to it (the GNU
// property of PT_GNU_STACK and PT_GNU_RELRO, DT_FLAGS_1, the note formats).
// Only headers and small tables are read, through the ranged reader, so a
// multi-gigabyte binary costs a few kilobytes. The file is untrusted: every
// offset, size and count is checked before use and every loop has a cap.
import { printable } from '../binary/text';
import { formatBytes } from '../binary/html';
import { PackageError, propertySection, tableSection, type InfoSection } from './model';
import type { PackageInfo } from './model';
import type { RangeReader } from '../binary/reader';

// Real binaries have 5 to 20 program headers. 256 leaves room for odd linker
// scripts while keeping the table walk tiny.
const MAX_SEGMENTS = 256;
// A relocatable object built with -ffunction-sections has one section per
// function, so thousands are legitimate. Beyond this the names are not read.
const MAX_SECTIONS = 4096;
// A dynamic section is a few dozen entries. 1024 covers the largest real
// ones (hundreds of DT_NEEDED) and bounds a malicious one.
const MAX_DYNAMIC = 1024;
const MAX_NEEDED = 512;
// String tables are read whole; real ones are tens of kilobytes.
const MAX_STRTAB = 1024 * 1024;
const MAX_STRING = 512;
// Note segments are tiny (build ID, ABI tag). 64 KiB leaves room for
// package-metadata notes.
const MAX_NOTE_BYTES = 64 * 1024;
const MAX_NOTES = 64;
const MAX_NOTE_SEGMENTS = 16;
const MAX_COMMENT_BYTES = 8 * 1024;
const MAX_COMMENTS = 8;
// Kernel modules store one key=value per NUL; alias lists can be long.
const MAX_MODINFO_BYTES = 64 * 1024;
const MAX_MODINFO_KEYS = 40;
const MAX_MODINFO_VALUES_PER_KEY = 3;
const SECTION_ROWS = 200;

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const PT_NOTE = 4;
const PT_GNU_STACK = 0x6474e551;
const PT_GNU_RELRO = 0x6474e552;

const SHT_NOTE = 7;
const SHT_NOBITS = 8;

const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_SONAME = 14;
const DT_RPATH = 15;
const DT_BIND_NOW = 24;
const DT_RUNPATH = 29;
const DT_FLAGS = 30;
const DT_FLAGS_1 = 0x6ffffffb;
const DF_BIND_NOW = 0x8;
const DF_1_NOW = 0x1;
const DF_1_PIE = 0x08000000;

const MACHINES: Record<number, string> = {
  2: 'SPARC',
  3: 'x86',
  8: 'MIPS',
  20: 'PowerPC',
  21: 'PowerPC64',
  22: 'S390',
  40: 'ARM',
  43: 'SPARC v9',
  62: 'x86-64',
  183: 'AArch64',
  243: 'RISC-V',
  247: 'BPF',
  258: 'LoongArch',
};

const OS_ABIS: Record<number, string> = {
  0: 'UNIX System V',
  1: 'HP-UX',
  2: 'NetBSD',
  3: 'Linux (GNU)',
  6: 'Solaris',
  7: 'AIX',
  8: 'IRIX',
  9: 'FreeBSD',
  10: 'Tru64',
  12: 'OpenBSD',
  64: 'ARM EABI',
  97: 'ARM',
  255: 'Standalone',
};

const NOTE_OS: Record<number, string> = {
  0: 'Linux',
  1: 'GNU Hurd',
  2: 'Solaris',
  3: 'FreeBSD',
  4: 'NetBSD',
  5: 'Syllable',
};

const SECTION_TYPES: Record<number, string> = {
  0: 'Unused',
  1: 'Program data',
  2: 'Symbol table',
  3: 'String table',
  4: 'Relocations (with addends)',
  5: 'Hash table',
  6: 'Dynamic linking',
  7: 'Notes',
  8: 'Zero-filled (no file data)',
  9: 'Relocations',
  10: 'Reserved',
  11: 'Dynamic symbols',
  14: 'Initialisers',
  15: 'Finalisers',
  16: 'Pre-initialisers',
  17: 'Section group',
  18: 'Symbol index',
  0x6ffffff6: 'GNU hash table',
  0x6ffffffd: 'Version definitions',
  0x6ffffffe: 'Version needs',
  0x6fffffff: 'Symbol versions',
};

interface Header {
  wide: boolean;
  le: boolean;
  osAbi: number;
  type: number;
  machine: number;
  entry: bigint;
  phoff: number;
  shoff: number;
  phentsize: number;
  phnum: number;
  shentsize: number;
  shnum: number;
  shstrndx: number;
}

interface Segment {
  type: number;
  flags: number;
  offset: number;
  vaddr: number;
  filesz: number;
  align: number;
}

interface Section {
  name: string;
  nameOffset: number;
  type: number;
  offset: number;
  size: number;
}

interface Note {
  name: string;
  type: number;
  desc: Uint8Array;
}

/** A word 4 or 8 bytes wide as a double: values past 2^53 are far outside any file, so imprecision is harmless. */
function word(v: DataView, at: number, wide: boolean, le: boolean): number {
  if (!wide) {
    return v.getUint32(at, le);
  }
  const first = v.getUint32(at, le);
  const second = v.getUint32(at + 4, le);
  return (le ? second : first) * 0x100000000 + (le ? first : second);
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A NUL-terminated string at `at` inside `buf`, bounded and cleaned. */
function stringAt(buf: Uint8Array, at: number, max = MAX_STRING): string {
  if (!Number.isSafeInteger(at) || at < 0 || at >= buf.length) {
    return '';
  }
  const end = buf.indexOf(0, at);
  const stop = Math.min(end < 0 ? buf.length : end, at + max);
  return printable(new TextDecoder().decode(buf.subarray(at, stop)));
}

async function readHeader(reader: RangeReader): Promise<Header> {
  if (reader.size < 52) {
    throw new PackageError('it is too short to be an ELF file.');
  }
  const head = await reader.bytes(0, Math.min(64, reader.size));
  if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) {
    throw new PackageError('it is not an ELF file.');
  }
  if ((head[4] !== 1 && head[4] !== 2) || (head[5] !== 1 && head[5] !== 2)) {
    throw new PackageError('it is an ELF file with an unknown word size or byte order.');
  }
  const wide = head[4] === 2;
  const le = head[5] === 1;
  if (head.length < (wide ? 64 : 52)) {
    throw new PackageError('its ELF header is cut short.');
  }
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const type = v.getUint16(16, le);
  const machine = v.getUint16(18, le);
  if (wide) {
    return {
      wide,
      le,
      osAbi: head[7],
      type,
      machine,
      entry: v.getBigUint64(24, le),
      phoff: word(v, 32, true, le),
      shoff: word(v, 40, true, le),
      phentsize: v.getUint16(54, le),
      phnum: v.getUint16(56, le),
      shentsize: v.getUint16(58, le),
      shnum: v.getUint16(60, le),
      shstrndx: v.getUint16(62, le),
    };
  }
  return {
    wide,
    le,
    osAbi: head[7],
    type,
    machine,
    entry: BigInt(v.getUint32(24, le)),
    phoff: v.getUint32(28, le),
    shoff: v.getUint32(32, le),
    phentsize: v.getUint16(42, le),
    phnum: v.getUint16(44, le),
    shentsize: v.getUint16(46, le),
    shnum: v.getUint16(48, le),
    shstrndx: v.getUint16(50, le),
  };
}

async function readSegments(
  reader: RangeReader,
  h: Header,
  warnings: string[],
): Promise<Segment[]> {
  if (h.phoff === 0 || h.phnum === 0) {
    return [];
  }
  const min = h.wide ? 56 : 32;
  if (h.phentsize < min) {
    throw new PackageError('its program headers are smaller than the format allows.');
  }
  const count = Math.min(h.phnum, MAX_SEGMENTS);
  if (h.phnum > count) {
    warnings.push(`Only the first ${count} of ${h.phnum} program headers were read.`);
  }
  const out: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const v = await reader.view(h.phoff + i * h.phentsize, min);
    if (h.wide) {
      out.push({
        type: v.getUint32(0, h.le),
        flags: v.getUint32(4, h.le),
        offset: word(v, 8, true, h.le),
        vaddr: word(v, 16, true, h.le),
        filesz: word(v, 32, true, h.le),
        align: word(v, 48, true, h.le),
      });
    } else {
      out.push({
        type: v.getUint32(0, h.le),
        flags: v.getUint32(24, h.le),
        offset: v.getUint32(4, h.le),
        vaddr: v.getUint32(8, h.le),
        filesz: v.getUint32(16, h.le),
        align: v.getUint32(28, h.le),
      });
    }
  }
  return out;
}

interface SectionTable {
  sections: Section[];
  /** Entries in the table, including the unused first one. */
  total: number;
}

async function readSections(
  reader: RangeReader,
  h: Header,
  warnings: string[],
): Promise<SectionTable> {
  if (h.shoff === 0) {
    return { sections: [], total: 0 };
  }
  const min = h.wide ? 64 : 40;
  if (h.shentsize < min) {
    throw new PackageError('its section headers are smaller than the format allows.');
  }
  const entry = async (i: number): Promise<Section & { link: number }> => {
    const v = await reader.view(h.shoff + i * h.shentsize, min);
    return h.wide
      ? {
          name: '',
          nameOffset: v.getUint32(0, h.le),
          type: v.getUint32(4, h.le),
          offset: word(v, 24, true, h.le),
          size: word(v, 32, true, h.le),
          link: v.getUint32(40, h.le),
        }
      : {
          name: '',
          nameOffset: v.getUint32(0, h.le),
          type: v.getUint32(4, h.le),
          offset: v.getUint32(16, h.le),
          size: v.getUint32(20, h.le),
          link: v.getUint32(24, h.le),
        };
  };
  let total = h.shnum;
  let strIndex = h.shstrndx;
  // A table too long for the 16-bit count keeps the real count in the first
  // entry's size, and a section-name table past 0xfeff keeps its index in the
  // first entry's link.
  if (total === 0 || strIndex === 0xffff) {
    const first = await entry(0);
    if (total === 0) {
      total = first.size;
    }
    if (strIndex === 0xffff) {
      strIndex = first.link;
    }
  }
  if (total === 0) {
    return { sections: [], total: 0 };
  }
  const count = Math.min(total, MAX_SECTIONS);
  if (total > count) {
    warnings.push(`Only the first ${count} of ${total} section headers were read.`);
  }
  const sections: Section[] = [];
  for (let i = 0; i < count; i++) {
    sections.push(await entry(i));
  }
  if (strIndex > 0 && strIndex < sections.length) {
    const str = sections[strIndex];
    if (str.type !== SHT_NOBITS && str.offset < reader.size) {
      const names = await reader.upTo(str.offset, Math.min(str.size, MAX_STRTAB));
      for (const s of sections) {
        s.name = stringAt(names, s.nameOffset, 128);
      }
    }
  }
  return { sections, total };
}

/** The file offset a virtual address maps to, through the loadable segments. */
function offsetOf(segments: Segment[], vaddr: number): number | undefined {
  for (const s of segments) {
    if (s.type === PT_LOAD && vaddr >= s.vaddr && vaddr - s.vaddr < s.filesz) {
      return s.offset + (vaddr - s.vaddr);
    }
  }
  return undefined;
}

interface Dynamic {
  needed: string[];
  neededTotal: number;
  soname?: string;
  rpath?: string;
  runpath?: string;
  bindNow: boolean;
  pie: boolean;
}

async function readDynamic(
  reader: RangeReader,
  h: Header,
  segments: Segment[],
  sections: Section[],
): Promise<Dynamic> {
  const out: Dynamic = { needed: [], neededTotal: 0, bindNow: false, pie: false };
  const seg = segments.find((s) => s.type === PT_DYNAMIC);
  if (!seg) {
    return out;
  }
  const size = h.wide ? 16 : 8;
  const count = Math.min(Math.floor(seg.filesz / size), MAX_DYNAMIC);
  const v = await reader.view(seg.offset, count * size);
  const neededAt: number[] = [];
  let sonameAt: number | undefined;
  let rpathAt: number | undefined;
  let runpathAt: number | undefined;
  let strtab: number | undefined;
  let strsz: number | undefined;
  for (let i = 0; i < count; i++) {
    const tag = word(v, i * size, h.wide, h.le);
    const value = word(v, i * size + size / 2, h.wide, h.le);
    if (tag === 0) {
      break;
    }
    switch (tag) {
      case DT_NEEDED:
        out.neededTotal++;
        if (neededAt.length < MAX_NEEDED) {
          neededAt.push(value);
        }
        break;
      case DT_STRTAB:
        strtab = value;
        break;
      case DT_STRSZ:
        strsz = value;
        break;
      case DT_SONAME:
        sonameAt = value;
        break;
      case DT_RPATH:
        rpathAt = value;
        break;
      case DT_RUNPATH:
        runpathAt = value;
        break;
      case DT_BIND_NOW:
        out.bindNow = true;
        break;
      case DT_FLAGS:
        if (value & DF_BIND_NOW) {
          out.bindNow = true;
        }
        break;
      case DT_FLAGS_1:
        if (value & DF_1_NOW) {
          out.bindNow = true;
        }
        if (value & DF_1_PIE) {
          out.pie = true;
        }
        break;
    }
  }
  // Prefer the address the dynamic section names; a file with its section
  // headers stripped has only that. The section is the fallback when the
  // address maps nowhere.
  let strOffset = strtab === undefined ? undefined : offsetOf(segments, strtab);
  let strLength = strsz ?? MAX_STRTAB;
  if (strOffset === undefined) {
    const dynstr = sections.find((s) => s.name === '.dynstr' && s.type !== SHT_NOBITS);
    if (dynstr) {
      strOffset = dynstr.offset;
      strLength = dynstr.size;
    }
  }
  if (strOffset === undefined) {
    return out;
  }
  const str = await reader.upTo(strOffset, Math.min(strLength, MAX_STRTAB));
  out.needed = neededAt.map((at) => stringAt(str, at)).filter((s) => s !== '');
  out.soname = sonameAt === undefined ? undefined : stringAt(str, sonameAt) || undefined;
  out.rpath = rpathAt === undefined ? undefined : stringAt(str, rpathAt) || undefined;
  out.runpath = runpathAt === undefined ? undefined : stringAt(str, runpathAt) || undefined;
  return out;
}

function parseNotes(buf: Uint8Array, le: boolean, align: number): Note[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const up = (n: number): number => Math.ceil(n / align) * align;
  const out: Note[] = [];
  let at = 0;
  while (at + 12 <= buf.length && out.length < MAX_NOTES) {
    const nameSize = v.getUint32(at, le);
    const descSize = v.getUint32(at + 4, le);
    const type = v.getUint32(at + 8, le);
    const nameStart = at + 12;
    const descStart = up(nameStart + nameSize);
    const descEnd = descStart + descSize;
    if (descEnd > buf.length) {
      break;
    }
    const raw = buf.subarray(nameStart, nameStart + nameSize);
    const nul = raw.indexOf(0);
    out.push({
      name: printable(new TextDecoder().decode(nul < 0 ? raw : raw.subarray(0, nul))),
      type,
      desc: buf.subarray(descStart, descEnd),
    });
    at = up(descEnd);
  }
  return out;
}

async function readNotes(
  reader: RangeReader,
  h: Header,
  segments: Segment[],
  sections: Section[],
): Promise<Note[]> {
  const out: Note[] = [];
  const places: { offset: number; size: number; align: number }[] = [];
  const noteSegments = segments.filter((s) => s.type === PT_NOTE);
  if (noteSegments.length > 0) {
    for (const s of noteSegments.slice(0, MAX_NOTE_SEGMENTS)) {
      places.push({ offset: s.offset, size: s.filesz, align: s.align === 8 ? 8 : 4 });
    }
  } else {
    // Without program headers (an object file) the notes live in sections.
    for (const s of sections.filter((x) => x.type === SHT_NOTE).slice(0, MAX_NOTE_SEGMENTS)) {
      places.push({ offset: s.offset, size: s.size, align: 4 });
    }
  }
  for (const p of places) {
    if (out.length >= MAX_NOTES) {
      break;
    }
    const buf = await reader.bytes(p.offset, Math.min(p.size, MAX_NOTE_BYTES));
    out.push(...parseNotes(buf, h.le, p.align));
  }
  return out;
}

async function sectionData(reader: RangeReader, s: Section, cap: number): Promise<Uint8Array> {
  if (s.type === SHT_NOBITS) {
    return new Uint8Array(0);
  }
  return reader.bytes(s.offset, Math.min(s.size, cap));
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

function typeName(
  h: Header,
  hasInterp: boolean,
  dyn: Dynamic,
  isModule: boolean,
): { label: string; format: string; pie: boolean } {
  switch (h.type) {
    case 1:
      return isModule
        ? { label: 'Kernel module', format: 'Linux kernel module', pie: false }
        : { label: 'Relocatable object', format: 'ELF relocatable object', pie: false };
    case 2:
      return { label: 'Executable', format: 'ELF executable', pie: false };
    case 3: {
      // A library and a position-independent executable are both ET_DYN. The
      // linker marks a PIE (DF_1_PIE) and gives it no SONAME; glibc's own
      // libc.so is a library that happens to carry an interpreter too.
      const pie = dyn.pie || (hasInterp && !dyn.soname);
      return pie
        ? { label: 'Executable (position-independent)', format: 'ELF executable', pie: true }
        : { label: 'Shared library', format: 'ELF shared library', pie: false };
    }
    case 4:
      return { label: 'Core dump', format: 'ELF core dump', pie: false };
    default:
      return { label: `Unknown type (${h.type})`, format: 'ELF file', pie: false };
  }
}

export async function readElf(reader: RangeReader): Promise<PackageInfo> {
  const h = await readHeader(reader);
  const warnings: string[] = [];
  // An optional part that is damaged becomes a warning, not a failed page.
  const attempt = async <T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      warnings.push(`${what} could not be read.`);
      return fallback;
    }
  };

  const segments = await attempt(
    'The program headers',
    () => readSegments(reader, h, warnings),
    [],
  );
  const table = await attempt('The section headers', () => readSections(reader, h, warnings), {
    sections: [],
    total: 0,
  } as SectionTable);
  const sections = table.sections;
  const dyn = await attempt(
    'The dynamic section',
    () => readDynamic(reader, h, segments, sections),
    { needed: [], neededTotal: 0, bindNow: false, pie: false } as Dynamic,
  );
  const notes = await attempt('The notes', () => readNotes(reader, h, segments, sections), []);

  const named = (n: string): Section | undefined => sections.find((s) => s.name === n);
  const hasSymtab = named('.symtab') !== undefined;
  const hasDebug = named('.debug_info') !== undefined || named('.zdebug_info') !== undefined;
  const modinfoSection = named('.modinfo');
  const isModule =
    h.type === 1 &&
    (modinfoSection !== undefined || named('.gnu.linkonce.this_module') !== undefined);

  const interpSeg = segments.find((s) => s.type === PT_INTERP);
  const interp = interpSeg
    ? await attempt(
        'The interpreter path',
        async () =>
          stringAt(await reader.upTo(interpSeg.offset, Math.min(interpSeg.filesz, 256)), 0, 256),
        '',
      )
    : '';
  const kind = typeName(h, interpSeg !== undefined, dyn, isModule);

  let buildId: string | undefined;
  let goBuildId: string | undefined;
  let minKernel: string | undefined;
  for (const n of notes) {
    if (n.name === 'GNU' && n.type === 3 && !buildId) {
      buildId = hex(n.desc.subarray(0, 64));
    } else if (n.name === 'GNU' && n.type === 1 && n.desc.length >= 16 && !minKernel) {
      const d = new DataView(n.desc.buffer, n.desc.byteOffset, n.desc.byteLength);
      const os = NOTE_OS[d.getUint32(0, h.le)] ?? 'OS';
      minKernel = `${os} ${d.getUint32(4, h.le)}.${d.getUint32(8, h.le)}.${d.getUint32(12, h.le)}`;
    } else if (n.name === 'Go' && n.type === 4 && !goBuildId) {
      goBuildId = printable(decode(n.desc.subarray(0, 128)));
    }
  }

  const comment = named('.comment');
  const compilers: string[] = [];
  if (comment) {
    await attempt(
      'The compiler comment',
      async () => {
        const text = decode(await sectionData(reader, comment, MAX_COMMENT_BYTES));
        for (const part of text.split('\0')) {
          const clean = printable(part.slice(0, 400)).trim().slice(0, 200);
          if (clean && !compilers.includes(clean) && compilers.length < MAX_COMMENTS) {
            compilers.push(clean);
          }
        }
      },
      undefined,
    );
  }
  const debuglink = named('.gnu_debuglink');
  let debugFile: string | undefined;
  if (debuglink) {
    debugFile = await attempt(
      'The debug link',
      async () => stringAt(await sectionData(reader, debuglink, 512), 0),
      undefined,
    );
  }

  const modinfo = new Map<string, string[]>();
  let modinfoKeys = 0;
  if (modinfoSection && isModule) {
    await attempt(
      'The module information',
      async () => {
        const text = decode(await sectionData(reader, modinfoSection, MAX_MODINFO_BYTES));
        for (const entry of text.split('\0')) {
          const eq = entry.indexOf('=');
          if (eq <= 0) {
            continue;
          }
          const key = printable(entry.slice(0, Math.min(eq, 128)))
            .trim()
            .slice(0, 64);
          const value = printable(entry.slice(eq + 1, eq + 601))
            .trim()
            .slice(0, 300);
          let list = modinfo.get(key);
          if (!list) {
            modinfoKeys++;
            if (modinfoKeys > MAX_MODINFO_KEYS) {
              continue;
            }
            list = [];
            modinfo.set(key, list);
          }
          list.push(value);
        }
      },
      undefined,
    );
  }

  // AppImage: the runtime is an ELF with "AI" and a type byte in the padding
  // of e_ident, and a squashfs image appended after the last byte the ELF
  // itself accounts for.
  const head = await reader.bytes(0, 16);
  const appImageType =
    head[8] === 0x41 && head[9] === 0x49 && (head[10] === 1 || head[10] === 2) ? head[10] : 0;
  let appImage: InfoSection[] = [];
  if (appImageType) {
    let end = 0;
    if (h.shoff > 0 && h.shnum > 0) {
      end = h.shoff + h.shnum * h.shentsize;
    }
    for (const s of segments) {
      end = Math.max(end, s.offset + s.filesz);
    }
    for (const s of sections) {
      if (s.type !== SHT_NOBITS) {
        end = Math.max(end, s.offset + s.size);
      }
    }
    if (Number.isSafeInteger(end) && end > 0 && end <= reader.size) {
      const payload = reader.size - end;
      const magic = payload >= 4 ? decode(await reader.bytes(end, 4)) : '';
      appImage = propertySection('AppImage', [
        ['Runtime size', formatBytes(end)],
        ['Payload offset', end.toLocaleString('en-US')],
        ['Payload size', formatBytes(payload)],
        [
          'Payload format',
          magic === 'hsqs' ? 'SquashFS' : payload > 0 ? 'Not recognised' : undefined,
        ],
      ]);
    } else {
      warnings.push('The AppImage payload could not be located.');
    }
  }

  const arch = `${MACHINES[h.machine] ?? `Machine 0x${h.machine.toString(16)}`}, ${h.wide ? '64-bit' : '32-bit'}, ${h.le ? 'little-endian' : 'big-endian'}`;
  const hasSectionTable = sections.length > 0;
  const entry = h.type === 1 ? undefined : `0x${h.entry.toString(16)}`;

  // PT_GNU_STACK without the execute bit is a non-executable stack; its
  // absence leaves the choice to the loader's default, which is executable.
  const stack = segments.find((s) => s.type === PT_GNU_STACK);
  const hasRelro = segments.some((s) => s.type === PT_GNU_RELRO);
  const protections: [string, string | undefined][] = [];
  if (segments.length > 0 && h.type !== 1) {
    protections.push([
      'Position-independent (PIE)',
      kind.pie
        ? dyn.pie
          ? 'Yes'
          : 'Probably (it has an interpreter and no SONAME, but no PIE flag)'
        : h.type === 2
          ? 'No (fixed load address)'
          : undefined,
    ]);
    protections.push([
      'Non-executable stack',
      stack
        ? (stack.flags & 1) === 0
          ? 'Yes'
          : 'No (stack is executable)'
        : 'Unknown (no PT_GNU_STACK)',
    ]);
    protections.push(['RELRO', hasRelro ? (dyn.bindNow ? 'Full' : 'Partial') : 'None']);
  }
  protections.push(['RPATH', dyn.rpath], ['RUNPATH', dyn.runpath]);

  const sectionRows = sections
    .slice(1)
    .map((s) => [
      s.name || '(unnamed)',
      formatBytes(s.size),
      SECTION_TYPES[s.type] ?? `0x${s.type.toString(16)}`,
    ]);

  const modRows: [string, string][] = [];
  for (const [key, values] of modinfo) {
    const shown = values.slice(0, MAX_MODINFO_VALUES_PER_KEY).join('; ');
    modRows.push([
      key,
      values.length > MAX_MODINFO_VALUES_PER_KEY
        ? `${shown} (and ${values.length - MAX_MODINFO_VALUES_PER_KEY} more)`
        : shown,
    ]);
  }

  const sections_: InfoSection[] = [
    ...propertySection('Binary', [
      ['Type', kind.label],
      ['Architecture', arch],
      ['OS ABI', OS_ABIS[h.osAbi] ?? `0x${h.osAbi.toString(16)}`],
      ['Interpreter', interp],
      ['SONAME', dyn.soname],
      ['Entry point', entry],
      ['Build ID', buildId],
      ['Go build ID', goBuildId],
      ['Minimum kernel', minKernel],
      ['Stripped', hasSectionTable ? (hasSymtab ? 'No' : 'Yes') : 'Unknown (no section headers)'],
      ['Debug information', hasSectionTable ? (hasDebug ? 'Yes' : 'No') : undefined],
      ['Separate debug file', debugFile],
      ['Compiler', compilers.join('; ')],
    ]),
    ...appImage,
    ...propertySection('Protections', protections),
    ...propertySection('Kernel module', modRows),
    ...tableSection(
      'Dependencies',
      ['Library'],
      dyn.needed.map((n) => [n]),
      { total: dyn.neededTotal, noun: 'libraries' },
    ),
    ...tableSection('Sections', ['Name', 'Size', 'Type'], sectionRows, {
      limit: SECTION_ROWS,
      total: Math.max(table.total - 1, sectionRows.length),
      noun: 'sections',
    }),
  ];

  return {
    format: appImageType ? `AppImage (type ${appImageType})` : kind.format,
    title: dyn.soname,
    summary: `${kind.label} for ${MACHINES[h.machine] ?? 'an unrecognised architecture'}`,
    sections: sections_,
    warnings,
  };
}
