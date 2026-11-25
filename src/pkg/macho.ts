// Mach-O reader: macOS and iOS executables, libraries, bundles and universal
// ("fat") binaries.
//
// Written from Apple's <mach-o/loader.h> and <mach-o/fat.h>. Only the header,
// the load commands (a few kilobytes) and a fat file's architecture table are
// read, through the ranged reader, so a multi-gigabyte binary costs a few
// kilobytes. The file is untrusted: every count, size and offset is checked
// before use, every loop has a cap, and a damaged load command ends the walk
// with a warning instead of a failed page.
import { printable } from '../binary/text';
import { formatBytes } from '../binary/html';
import { PackageError, propertySection, tableSection, type InfoSection } from './model';
import type { PackageInfo } from './model';
import type { RangeReader } from '../binary/reader';

// Ghidra's MAX_LOAD_COMMANDS. A real binary has 10 to 60.
const MAX_COMMANDS = 32768;
// Real load commands total a few kilobytes; a large app with hundreds of
// dependencies stays well under this.
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_STRING = 1024;
const MAX_DEPENDENCIES = 200;
const MAX_RPATHS = 64;
const MAX_SEGMENTS = 64;
const MAX_TOOLS = 8;
// A fat file with more architectures than this is not a real one; Ghidra
// refuses it too (ubi/FatHeader.java).
const MAX_FAT_ARCHS = 0x1000;
const MAX_SLICES_SHOWN = 16;
const DAMAGED = 'The load commands stop at a damaged command; the ones before it are shown.';

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MIN_HEADER = 28;

const MH_PIE = 0x200000;
const MH_ALLOW_STACK_EXECUTION = 0x20000;
const MH_NO_HEAP_EXECUTION = 0x1000000;

const LC_SEGMENT = 0x1;
const LC_LOAD_DYLIB = 0xc;
const LC_ID_DYLIB = 0xd;
const LC_LOAD_DYLINKER = 0xe;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;
const LC_ENCRYPTION_INFO = 0x21;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_VERSION_MIN_IPHONEOS = 0x25;
const LC_SEGMENT_64 = 0x19;
const LC_SOURCE_VERSION = 0x2a;
const LC_ENCRYPTION_INFO_64 = 0x2c;
const LC_VERSION_MIN_TVOS = 0x2f;
const LC_VERSION_MIN_WATCHOS = 0x30;
const LC_BUILD_VERSION = 0x32;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_RPATH = 0x8000001c;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LOAD_UPWARD_DYLIB = 0x80000023;
const LC_MAIN = 0x80000028;

const DEPENDENCY_KINDS: Record<number, string> = {
  [LC_LOAD_DYLIB]: 'Required',
  [LC_LOAD_WEAK_DYLIB]: 'Weak',
  [LC_REEXPORT_DYLIB]: 'Re-exported',
  [LC_LAZY_LOAD_DYLIB]: 'Lazy',
  [LC_LOAD_UPWARD_DYLIB]: 'Upward',
};

const FILE_TYPES: Record<number, { label: string; noun: string }> = {
  1: { label: 'Object file', noun: 'object file' },
  2: { label: 'Executable', noun: 'executable' },
  3: { label: 'Fixed VM library', noun: 'fixed VM library' },
  4: { label: 'Core dump', noun: 'core dump' },
  5: { label: 'Preloaded executable', noun: 'preloaded executable' },
  6: { label: 'Dynamic library', noun: 'dynamic library' },
  7: { label: 'Dynamic linker', noun: 'dynamic linker' },
  8: { label: 'Bundle', noun: 'bundle' },
  9: { label: 'Dynamic library stub', noun: 'dynamic library stub' },
  10: { label: 'dSYM companion file', noun: 'dSYM companion file' },
  11: { label: 'Kernel extension bundle', noun: 'kernel extension bundle' },
  12: { label: 'Fileset', noun: 'fileset' },
};

const PLATFORMS: Record<number, string> = {
  1: 'macOS',
  2: 'iOS',
  3: 'tvOS',
  4: 'watchOS',
  5: 'bridgeOS',
  6: 'Mac Catalyst',
  7: 'iOS Simulator',
  8: 'tvOS Simulator',
  9: 'watchOS Simulator',
  10: 'DriverKit',
  11: 'visionOS',
  12: 'visionOS Simulator',
  13: 'Firmware',
  14: 'sepOS',
};

const TOOLS: Record<number, string> = { 1: 'clang', 2: 'swift', 3: 'ld', 4: 'lld' };

const CPU_ARM = 12;
const CPU_ARM64 = 0x0100000c;
const CPU_ARM64_32 = 0x0200000c;
const CPU_X86 = 7;
const CPU_X86_64 = 0x01000007;
const CPU_PPC = 18;
const CPU_PPC64 = 0x01000012;

/** The architecture name a tool such as `lipo` would use. */
function archName(cputype: number, cpusubtype: number): string {
  // The top byte of the subtype carries capability bits, such as pointer authentication.
  const sub = cpusubtype & 0xffffff;
  switch (cputype) {
    case CPU_X86:
      return 'x86';
    case CPU_X86_64:
      return sub === 8 ? 'x86_64h' : 'x86_64';
    case CPU_ARM:
      switch (sub) {
        case 9:
          return 'armv7';
        case 10:
          return 'armv7f';
        case 11:
          return 'armv7s';
        case 12:
          return 'armv7k';
        case 6:
          return 'armv6';
        default:
          return 'arm';
      }
    case CPU_ARM64:
      return sub === 2 ? 'arm64e' : 'arm64';
    case CPU_ARM64_32:
      return 'arm64_32';
    case CPU_PPC:
      return 'ppc';
    case CPU_PPC64:
      return 'ppc64';
    default:
      return `0x${cputype.toString(16)}`;
  }
}

const version3 = (v: number): string => `${v >>> 16}.${(v >>> 8) & 0xff}.${v & 0xff}`;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function protection(bits: number): string {
  return `${bits & 1 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 4 ? 'x' : '-'}`;
}

/** A bounded view of part of the file, so a fat file's slice is read as if it were a file of its own. */
class Slice {
  constructor(
    private readonly reader: RangeReader,
    private readonly base: number,
    readonly size: number,
  ) {}
  async bytes(offset: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    ) {
      throw new PackageError('the file ends before the data its headers point to.');
    }
    try {
      return await this.reader.bytes(this.base + offset, length);
    } catch (e) {
      // A failure of the source under this slice belongs to this slice: the
      // caller keeps the other slices instead of failing the whole page.
      if (e instanceof PackageError) {
        throw e;
      }
      throw new PackageError('the file could not be read here.');
    }
  }
}

interface Dependency {
  name: string;
  kind: string;
  version: string;
}

interface Segment {
  name: string;
  fileSize: number;
  memSize: number;
  protection: string;
  sections: number;
}

interface Build {
  platform: string;
  minOs: string;
  sdk?: string;
}

// A binary declares one or two platforms; more than this is not a real file.
const MAX_BUILDS = 4;

/**
 * The platform a legacy minimum-version command means. Those commands name no
 * simulator, so dyld tells one apart by the CPU: an Intel iOS or watchOS slice
 * (i386 or x86_64) is a simulator one, but for tvOS only x86_64 is, so a
 * 32-bit Intel tvOS slice is no target dyld recognises.
 */
function legacyPlatform(cmd: number, cputype: number): string {
  const x86 = cputype === CPU_X86;
  const x64 = cputype === CPU_X86_64;
  switch (cmd) {
    case LC_VERSION_MIN_MACOSX:
      return 'macOS';
    case LC_VERSION_MIN_IPHONEOS:
      return x86 || x64 ? 'iOS Simulator' : 'iOS';
    case LC_VERSION_MIN_TVOS:
      return x64 ? 'tvOS Simulator' : x86 ? 'tvOS (32-bit Intel, not a recognised target)' : 'tvOS';
    default:
      return x86 || x64 ? 'watchOS Simulator' : 'watchOS';
  }
}
const SECTION_NAME = 16;

interface Thin {
  wide: boolean;
  le: boolean;
  cputype: number;
  cpusubtype: number;
  arch: string;
  filetype: number;
  flags: number;
  /** One record per platform: a library can declare macOS and Mac Catalyst. */
  builds: Build[];
  tools: string[];
  uuid?: string;
  sourceVersion?: string;
  installName?: string;
  currentVersion?: string;
  compatVersion?: string;
  dylinker?: string;
  entry?: string;
  /** The slice's size, which a declared signature range must lie inside. */
  sliceSize: number;
  codeSignature?: { offset: number; size: number };
  encrypted?: boolean;
  /** False when a cap, a damaged command or the end of the file stopped the walk early. */
  complete: boolean;
  dependencies: Dependency[];
  dependencyTotal: number;
  rpaths: string[];
  rpathTotal: number;
  segments: Segment[];
  segmentTotal: number;
  hasRestrict: boolean;
  /** A __RESTRICT segment declared sections its command does not hold, so the marker may be among them. */
  restrictUnread: boolean;
  warnings: string[];
}

const typeOf = (filetype: number): { label: string; noun: string } =>
  FILE_TYPES[filetype] ?? {
    label: `Unknown type (${filetype})`,
    noun: 'file',
  };

/** An lc_str: an offset from the start of the command to a NUL-terminated string inside it. */
function lcStr(cmd: Uint8Array, offset: number): string {
  if (offset < 8 || offset >= cmd.length) {
    return '';
  }
  const limit = Math.min(cmd.length, offset + MAX_STRING);
  const end = cmd.indexOf(0, offset);
  const stop = end < 0 || end > limit ? limit : end;
  return printable(new TextDecoder().decode(cmd.subarray(offset, stop))).trim();
}

/** A fixed-width name such as a segment name: NUL-terminated or filling its field. */
function fixedStr(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return printable(new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)));
}

/** Eight bytes as a double: a size past 2^53 is far outside any file, so imprecision is harmless. */
function u64(v: DataView, at: number, le: boolean): number {
  const first = v.getUint32(at, le);
  const second = v.getUint32(at + 4, le);
  return (le ? second : first) * 0x100000000 + (le ? first : second);
}

async function readThin(slice: Slice): Promise<Thin> {
  if (slice.size < MIN_HEADER) {
    throw new PackageError('it is too short to be a Mach-O file.');
  }
  const head = await slice.bytes(0, Math.min(32, slice.size));
  const big32 = head[0] === 0xfe && head[1] === 0xed && head[2] === 0xfa;
  const little32 = head[3] === 0xfe && head[2] === 0xed && head[1] === 0xfa;
  const wide = big32 ? head[3] === 0xcf : little32 ? head[0] === 0xcf : false;
  const known =
    (big32 && (head[3] === 0xce || head[3] === 0xcf)) ||
    (little32 && (head[0] === 0xce || head[0] === 0xcf));
  if (!known) {
    throw new PackageError('it is not a Mach-O file.');
  }
  const le = little32;
  const headerSize = wide ? 32 : 28;
  if (head.length < headerSize) {
    throw new PackageError('its Mach-O header is cut short.');
  }
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const cputype = v.getUint32(4, le);
  const cpusubtype = v.getUint32(8, le);
  const out: Thin = {
    wide,
    le,
    cputype,
    cpusubtype,
    arch: archName(cputype, cpusubtype),
    filetype: v.getUint32(12, le),
    flags: v.getUint32(24, le),
    builds: [],
    sliceSize: slice.size,
    complete: true,
    tools: [],
    dependencies: [],
    dependencyTotal: 0,
    rpaths: [],
    rpathTotal: 0,
    segments: [],
    segmentTotal: 0,
    hasRestrict: false,
    restrictUnread: false,
    warnings: [],
  };
  const ncmds = v.getUint32(16, le);
  const sizeofcmds = v.getUint32(20, le);

  const count = Math.min(ncmds, MAX_COMMANDS);
  if (ncmds > count) {
    out.complete = false;
    out.warnings.push(
      `Only the first ${count.toLocaleString('en-US')} of ${ncmds.toLocaleString('en-US')} load commands were read.`,
    );
  }
  const available = slice.size - headerSize;
  const length = Math.min(sizeofcmds, MAX_COMMAND_BYTES, available);
  const capped = sizeofcmds > MAX_COMMAND_BYTES && length === MAX_COMMAND_BYTES;
  const cut = !capped && sizeofcmds > available;
  const buf = length > 0 ? await slice.bytes(headerSize, length) : new Uint8Array(0);
  const cmds = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // A walk that runs out of bytes says why: MarkCopy's cap, the end of the
  // file, or a command whose size does not fit.
  const stopped = (): void => {
    out.complete = false;
    out.warnings.push(
      capped
        ? 'The load commands are larger than MarkCopy reads (1 MiB); the ones before that are shown.'
        : cut
          ? 'The file ends inside the load commands; the ones before that are shown.'
          : DAMAGED,
    );
  };

  let at = 0;
  let small = false;
  // One record per platform, whichever command format declares it: Apple's
  // linker picks the format per target, so a macOS LC_VERSION_MIN_MACOSX can
  // sit beside a Mac Catalyst LC_BUILD_VERSION. A second record for the same
  // platform is a duplicate, and the first is kept.
  const addBuild = (build: Build): void => {
    if (out.builds.length < MAX_BUILDS && !out.builds.some((b) => b.platform === build.platform)) {
      out.builds.push(build);
    }
  };
  let toolsRead = false;
  for (let i = 0; i < count; i++) {
    if (at + 8 > buf.length) {
      stopped();
      break;
    }
    const cmd = cmds.getUint32(at, le);
    const cmdsize = cmds.getUint32(at + 4, le);
    if (cmdsize < 8 || cmdsize % 4 !== 0 || at + cmdsize > buf.length) {
      stopped();
      break;
    }
    const body = buf.subarray(at, at + cmdsize);
    const c = new DataView(body.buffer, body.byteOffset, body.byteLength);
    at += cmdsize;
    // The smallest size each command's fixed fields need.
    const need = ((): number => {
      switch (cmd) {
        case LC_SEGMENT:
          return 56;
        case LC_SEGMENT_64:
          return 72;
        case LC_LOAD_DYLIB:
        case LC_ID_DYLIB:
        case LC_LOAD_WEAK_DYLIB:
        case LC_REEXPORT_DYLIB:
        case LC_LAZY_LOAD_DYLIB:
        case LC_LOAD_UPWARD_DYLIB:
          return 24;
        case LC_LOAD_DYLINKER:
        case LC_RPATH:
          return 12;
        case LC_UUID:
          return 24;
        case LC_CODE_SIGNATURE:
          return 16;
        case LC_ENCRYPTION_INFO:
        case LC_ENCRYPTION_INFO_64:
          return 20;
        case LC_SOURCE_VERSION:
          return 16;
        case LC_MAIN:
          return 16;
        case LC_BUILD_VERSION:
          return 24;
        case LC_VERSION_MIN_MACOSX:
        case LC_VERSION_MIN_IPHONEOS:
        case LC_VERSION_MIN_TVOS:
        case LC_VERSION_MIN_WATCHOS:
          return 16;
        default:
          return 0;
      }
    })();
    if (cmdsize < need) {
      small = true;
      continue;
    }
    switch (cmd) {
      case LC_SEGMENT:
      case LC_SEGMENT_64: {
        out.segmentTotal++;
        const name = fixedStr(body.subarray(8, 24));
        const w = cmd === LC_SEGMENT_64;
        if (name === '__RESTRICT' && !out.hasRestrict) {
          // Only a __restrict section inside the segment is what dyld looks for.
          const first = w ? 72 : 56;
          const entry = w ? 80 : 68;
          const nsects = c.getUint32(w ? 64 : 48, le);
          const fit = Math.max(0, Math.floor((cmdsize - first) / entry));
          for (let s = 0; s < Math.min(nsects, fit); s++) {
            const at = first + s * entry;
            if (fixedStr(body.subarray(at, at + SECTION_NAME)) === '__restrict') {
              out.hasRestrict = true;
              break;
            }
          }
          // Sections it declares but its command does not hold may include the
          // marker, so its absence is not established.
          if (!out.hasRestrict && nsects > fit) {
            out.restrictUnread = true;
            out.warnings.push(
              `The __RESTRICT segment declares ${nsects.toLocaleString('en-US')} sections, but its command holds ${fit.toLocaleString('en-US')}.`,
            );
          }
        }
        if (out.segments.length < MAX_SEGMENTS) {
          const num = (n: number): number => (w ? u64(c, n, le) : c.getUint32(n, le));
          const maxprot = c.getUint32(w ? 56 : 40, le);
          const initprot = c.getUint32(w ? 60 : 44, le);
          out.segments.push({
            name,
            memSize: num(w ? 32 : 28),
            fileSize: num(w ? 48 : 36),
            protection:
              initprot === maxprot
                ? protection(initprot)
                : `${protection(initprot)} (max ${protection(maxprot)})`,
            sections: c.getUint32(w ? 64 : 48, le),
          });
        }
        break;
      }
      case LC_LOAD_DYLIB:
      case LC_LOAD_WEAK_DYLIB:
      case LC_REEXPORT_DYLIB:
      case LC_LAZY_LOAD_DYLIB:
      case LC_LOAD_UPWARD_DYLIB:
      case LC_ID_DYLIB: {
        const name = lcStr(body, c.getUint32(8, le));
        const current = version3(c.getUint32(16, le));
        const compat = version3(c.getUint32(20, le));
        if (cmd === LC_ID_DYLIB) {
          if (out.installName === undefined) {
            out.installName = name;
            out.currentVersion = current;
            out.compatVersion = compat;
          }
        } else {
          out.dependencyTotal++;
          if (out.dependencies.length < MAX_DEPENDENCIES) {
            out.dependencies.push({
              name: name || '(name outside the command)',
              kind: DEPENDENCY_KINDS[cmd],
              version: current === compat ? current : `${current} (compatible ${compat})`,
            });
          }
        }
        break;
      }
      case LC_LOAD_DYLINKER:
        out.dylinker ??= lcStr(body, c.getUint32(8, le));
        break;
      case LC_RPATH:
        out.rpathTotal++;
        if (out.rpaths.length < MAX_RPATHS) {
          out.rpaths.push(lcStr(body, c.getUint32(8, le)));
        }
        break;
      case LC_UUID:
        if (out.uuid === undefined) {
          const h = hex(body.subarray(8, 24));
          out.uuid =
            `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
        }
        break;
      case LC_SOURCE_VERSION:
        if (out.sourceVersion === undefined) {
          const n = c.getBigUint64(8, le);
          out.sourceVersion = [
            n >> 40n,
            (n >> 30n) & 0x3ffn,
            (n >> 20n) & 0x3ffn,
            (n >> 10n) & 0x3ffn,
            n & 0x3ffn,
          ].join('.');
        }
        break;
      case LC_MAIN:
        if (out.entry === undefined) {
          out.entry = `__TEXT + 0x${u64(c, 8, le).toString(16)}`;
        }
        break;
      case LC_CODE_SIGNATURE:
        out.codeSignature ??= { offset: c.getUint32(8, le), size: c.getUint32(12, le) };
        break;
      case LC_ENCRYPTION_INFO:
      case LC_ENCRYPTION_INFO_64:
        out.encrypted ??= c.getUint32(16, le) !== 0;
        break;
      case LC_BUILD_VERSION: {
        const platform = c.getUint32(8, le);
        const sdk = c.getUint32(16, le);
        addBuild({
          platform: PLATFORMS[platform] ?? `Platform ${platform}`,
          minOs: version3(c.getUint32(12, le)),
          // 0 is what a compiler writes when it was given no SDK.
          sdk: sdk === 0 ? undefined : version3(sdk),
        });
        if (!toolsRead) {
          toolsRead = true;
          const ntools = c.getUint32(20, le);
          for (let t = 0; t < ntools && t < MAX_TOOLS && 24 + t * 8 + 8 <= cmdsize; t++) {
            const tool = c.getUint32(24 + t * 8, le);
            out.tools.push(
              `${TOOLS[tool] ?? `tool ${tool}`} ${version3(c.getUint32(28 + t * 8, le))}`,
            );
          }
        }
        break;
      }
      case LC_VERSION_MIN_MACOSX:
      case LC_VERSION_MIN_IPHONEOS:
      case LC_VERSION_MIN_TVOS:
      case LC_VERSION_MIN_WATCHOS: {
        const sdk = c.getUint32(12, le);
        addBuild({
          platform: legacyPlatform(cmd, out.cputype),
          minOs: version3(c.getUint32(8, le)),
          sdk: sdk === 0 ? undefined : version3(sdk),
        });
        break;
      }
    }
  }
  if (small) {
    out.complete = false;
    out.warnings.push('A load command is smaller than its type needs and was skipped.');
  }
  return out;
}

interface FatArch {
  cputype: number;
  cpusubtype: number;
  offset: number;
  size: number;
}

/** The architecture table of a universal binary, or undefined when the file is not one. */
async function readFatTable(reader: RangeReader): Promise<FatArch[] | undefined> {
  if (reader.size < 8) {
    return undefined;
  }
  const head = await reader.view(0, 8);
  const magic = head.getUint32(0, false);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    return undefined;
  }
  const count = head.getUint32(4, false);
  // 0xcafebabe is also a Java class file, whose next four bytes are the
  // version: a class file reads as a fat file of a few dozen architectures.
  // Nothing in such a table lies inside the file, which is what rules it out.
  if (count < 1 || count > MAX_FAT_ARCHS) {
    return undefined;
  }
  const wide = magic === FAT_MAGIC_64;
  const entry = wide ? 32 : 20;
  const tableEnd = 8 + count * entry;
  if (tableEnd > reader.size) {
    return undefined;
  }
  const t = await reader.view(8, count * entry);
  const archs: FatArch[] = [];
  for (let i = 0; i < count; i++) {
    const at = i * entry;
    const offset = wide ? u64(t, at + 8, false) : t.getUint32(at + 8, false);
    const size = wide ? u64(t, at + 16, false) : t.getUint32(at + 12, false);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      offset < tableEnd ||
      offset + size > reader.size
    ) {
      return undefined;
    }
    archs.push({
      cputype: t.getUint32(at, false),
      cpusubtype: t.getUint32(at + 4, false),
      offset,
      size,
    });
  }
  const first = await reader.bytes(archs[0].offset, Math.min(4, archs[0].size));
  return isMachOMagic(first) ? archs : undefined;
}

function isMachOMagic(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    ((b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && (b[3] === 0xce || b[3] === 0xcf)) ||
      (b[3] === 0xfe && b[2] === 0xed && b[1] === 0xfa && (b[0] === 0xce || b[0] === 0xcf)))
  );
}

/** Whether the file is a Mach-O or a universal binary, so a Java class file is not claimed. */
export async function looksLikeMachO(reader: RangeReader): Promise<boolean> {
  if (reader.size < 8) {
    return false;
  }
  const head = await reader.bytes(0, 4);
  if (isMachOMagic(head)) {
    return true;
  }
  return (await readFatTable(reader)) !== undefined;
}

/** "macOS 11.0.0", or "macOS 11.0.0, Mac Catalyst 14.0.0" for a slice built for two platforms. */
function minimumOs(t: Thin): string | undefined {
  return t.builds.length === 0
    ? undefined
    : t.builds.map((b) => `${b.platform} ${b.minOs}`).join(', ');
}

/** A per-platform value: bare for one platform, prefixed by the platform name for several. */
function perPlatform(t: Thin, pick: (b: Build) => string | undefined): string | undefined {
  if (t.builds.length === 1) {
    return pick(t.builds[0]);
  }
  const parts = t.builds.flatMap((b) => {
    const value = pick(b);
    return value === undefined ? [] : [`${b.platform} ${value}`];
  });
  return parts.length === 0 ? undefined : parts.join(', ');
}

const UNKNOWN = 'Unknown (the load commands were not all read)';

type SignatureState = 'none' | 'unknown' | 'present' | 'empty' | 'outside';

/** What the declared signature range says. The payload is never read. */
function signatureState(t: Thin): SignatureState {
  const s = t.codeSignature;
  if (s === undefined) {
    return t.complete ? 'none' : 'unknown';
  }
  if (s.size === 0) {
    return 'empty';
  }
  return s.offset + s.size <= t.sliceSize ? 'present' : 'outside';
}

function sectionsOf(t: Thin, note?: string): InfoSection[] {
  const type = typeOf(t.filetype);
  const isObject = t.filetype === 1;
  const executable = t.filetype === 2;
  const protections: [string, string | undefined][] = [];
  if (executable) {
    protections.push(
      ['Position-independent (PIE)', t.flags & MH_PIE ? 'Yes' : 'No (fixed load address)'],
      [
        'Executable stack allowed',
        t.flags & MH_ALLOW_STACK_EXECUTION ? 'Yes (MH_ALLOW_STACK_EXECUTION)' : 'No',
      ],
      ['No heap execution', t.flags & MH_NO_HEAP_EXECUTION ? 'Yes' : 'No'],
      [
        '__RESTRICT,__restrict section',
        t.hasRestrict
          ? 'Present'
          : t.restrictUnread
            ? 'Unknown (the __RESTRICT segment declares more sections than it holds)'
            : t.complete
              ? 'No'
              : UNKNOWN,
      ],
    );
  }
  const signature = signatureState(t);
  if (!isObject) {
    protections.push([
      'Code signature',
      {
        none: 'None',
        unknown: UNKNOWN,
        present: 'Present',
        empty: 'Declared, but empty',
        outside: 'Declared, data missing',
      }[signature],
    ]);
  }
  return [
    ...propertySection(
      'Binary',
      [
        ['Type', type.label],
        ['Architecture', t.arch],
        ['Platform', t.builds.map((b) => b.platform).join(', ') || undefined],
        ['Minimum OS', perPlatform(t, (b) => b.minOs)],
        ['SDK', perPlatform(t, (b) => b.sdk)],
        ['Build tools', t.tools.join(', ')],
        ['UUID', t.uuid],
        ['Source version', t.sourceVersion],
        ['Install name', t.installName],
        ['Current version', t.currentVersion],
        ['Compatibility version', t.compatVersion],
        ['Dynamic linker', t.dylinker],
        ['Entry point', t.entry],
        [
          'Code signature',
          {
            none: 'None',
            unknown: UNKNOWN,
            present: `Present, not verified by MarkCopy (${formatBytes(t.codeSignature?.size ?? 0)})`,
            empty: 'Declared, but empty',
            outside: 'Declared, but its data lies outside the file',
          }[signature],
        ],
        [
          'Encrypted',
          t.encrypted === undefined
            ? t.complete
              ? undefined
              : UNKNOWN
            : t.encrypted
              ? 'Yes'
              : 'No',
        ],
      ],
      note,
    ),
    ...propertySection('Protections', protections),
    ...tableSection(
      'Dependencies',
      ['Library', 'Kind', 'Version'],
      t.dependencies.map((d) => [d.name, d.kind, d.version]),
      { total: t.dependencyTotal, noun: 'libraries', limit: MAX_DEPENDENCIES },
    ),
    ...tableSection(
      'Run paths',
      ['Path'],
      t.rpaths.map((p) => [p]),
      { total: t.rpathTotal, noun: 'run paths', limit: MAX_RPATHS },
    ),
    ...tableSection(
      'Segments',
      ['Name', 'File size', 'Memory size', 'Protection', 'Sections'],
      t.segments.map((s) => [
        s.name,
        formatBytes(s.fileSize),
        formatBytes(s.memSize),
        s.protection,
        String(s.sections),
      ]),
      { total: t.segmentTotal, noun: 'segments', limit: MAX_SEGMENTS },
    ),
  ];
}

export async function readMachO(reader: RangeReader): Promise<PackageInfo> {
  const archs = await readFatTable(reader);
  if (archs === undefined) {
    if (reader.size < MIN_HEADER) {
      throw new PackageError('it is too short to be a Mach-O file.');
    }
    const t = await readThin(new Slice(reader, 0, reader.size));
    const type = typeOf(t.filetype);
    return {
      format: `Mach-O ${type.noun} (${t.arch})`,
      title: t.installName || undefined,
      summary: `${type.label} for ${t.arch}`,
      sections: sectionsOf(t),
      warnings: t.warnings,
    };
  }

  const warnings: string[] = [];
  const shown = archs.slice(0, MAX_SLICES_SHOWN);
  const slices: (Thin | undefined)[] = [];
  for (const [i, a] of shown.entries()) {
    const fallback = archName(a.cputype, a.cpusubtype);
    try {
      const t = await readThin(new Slice(reader, a.offset, a.size));
      slices.push(t);
      for (const w of t.warnings) {
        warnings.push(i === 0 ? w : `The ${t.arch} slice: ${w}`);
      }
    } catch (e) {
      slices.push(undefined);
      if (!(e instanceof PackageError)) {
        throw e;
      }
      warnings.push(`The ${fallback} slice could not be read.`);
    }
  }
  const names = shown.map((a, i) => slices[i]?.arch ?? archName(a.cputype, a.cpusubtype));
  const rows = shown.map((a, i) => {
    const t = slices[i];
    return [
      names[i],
      t ? typeOf(t.filetype).label : '',
      (t && minimumOs(t)) ?? '',
      t?.uuid ?? '',
      `0x${a.offset.toString(16)}`,
      formatBytes(a.size),
    ];
  });
  const first = slices[0];
  const sections: InfoSection[] = [
    ...tableSection(
      'Architectures',
      ['Architecture', 'File type', 'Minimum OS', 'UUID', 'Offset', 'Size'],
      rows,
      { total: archs.length, noun: 'architectures', limit: MAX_SLICES_SHOWN },
    ),
    ...(first ? sectionsOf(first, `Describes the first slice (${first.arch}).`) : []),
  ];
  return {
    format: `Universal binary (${names.join(', ')}${archs.length > shown.length ? ', ...' : ''})`,
    title: first?.installName || undefined,
    summary: `Universal binary with ${archs.length.toLocaleString('en-US')} ${archs.length === 1 ? 'architecture' : 'architectures'}`,
    sections,
    warnings,
  };
}
