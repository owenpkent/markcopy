// Reads the metadata of a Windows PE image (.exe, .dll, .sys and friends): the
// headers, the version resource, the manifest, the import and export tables,
// the debug record, the .NET header, and who an embedded Authenticode
// signature names as its signer.
//
// Nothing here executes, loads or maps the file. It is read as bytes through a
// ByteSource, in ranges, so a 2 GB installer costs a few hundred kilobytes of
// reads rather than 2 GB of extension-host memory. Every offset the file
// supplies is bounds-checked against the file's real size, every loop has a
// cap, and the total that may be read is budgeted, because the whole point of
// previewing an executable instead of running it is that the file may be
// hostile.
//
// No `vscode` import: this module is pure so it can be unit-tested and fuzzed.
import { parseXmlBounded } from '../binary/xml';
import { child, findAll } from '../ooxml/xnode';
import { iconToPng, pickIcon, type PeIcon } from './icon';
import { checkImageHash, type PeImageHash } from './imageHash';
import { isSignedData, readSigner, signerCount, type Signer } from './signer';
import {
  RangeReader as Reader,
  ReadError as PeError,
  TRUNCATED,
  type ByteSource,
} from '../binary/reader';
import { printable } from '../binary/text';
import { readGoBuildInfo, type GoBuildInfo } from '../binary/goBuildInfo';
import { readRich, type PeRich } from './rich';
import { readVersionResource, type VersionInfo } from './version';

// The shared reader's error under this feature's name, so a file the ranged
// reader gives up on and one whose PE headers make no sense are the same thing
// to the preview: a message to show.
export { ReadError as PeError, bytesSource, type ByteSource } from '../binary/reader';

export interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
  /** The raw characteristics flags. */
  characteristics: number;
  /** Readable, writable, executable, in that order, as the loader will map it. */
  read: boolean;
  write: boolean;
  execute: boolean;
  /** What the section says it holds: code, initialized data, uninitialized data. */
  contents: string[];
}

export interface PeImport {
  library: string;
  /** Absent when the library's name is readable but its function list is not. */
  functions?: number;
  delayLoaded: boolean;
}

export interface PeExports {
  /** The name the image exports under, which survives a rename of the file. */
  name: string;
  /** The ordinal of the address table's first slot. Usually 1, and not always. */
  base: number;
  /**
   * Entries of the export address table that hold an address: what the image
   * really exports. Absent when the table could not be read to count them.
   */
  functions?: number;
  /**
   * How long the export address table is. Ordinals index it, so a library
   * whose ordinals have gaps has more slots than functions.
   */
  slots: number;
  named: number;
  /** The first names, in table order. `named` says how many there are in all. */
  names: string[];
  /** Names among the first ones that could not be read, so `names` is not a prefix of the table. */
  unreadNames?: number;
}

export interface PeDebug {
  pdbPath?: string;
  guid?: string;
  age?: number;
}

export interface PeDotNet {
  /** The runtime the metadata was built for, such as "v4.0.30319". */
  runtime?: string;
  ilOnly: boolean;
  requires32Bit: boolean;
  prefers32Bit: boolean;
  strongNamed: boolean;
}

export interface PeManifest {
  executionLevel?: string;
  uiAccess?: string;
  dpiAware?: string;
  identity?: string;
}

export interface PeSignature {
  /** Bytes of the certificate table. */
  size: number;
  /**
   * Whether the table holds a PKCS #7 SignedData entry with at least one
   * signer, the form an Authenticode signature takes. A table can exist
   * without one: a bare X.509 certificate signs nothing, and neither does
   * SignedData that only carries certificates.
   */
  signedData: boolean;
  /** What each entry of the table says it is, in table order. */
  entries: string[];
  /** Who the signature names. Absent when there is no SignedData, or it cannot be walked. */
  signer?: Signer;
  /** The image digest the signature stores, and whether the file still hashes to it. */
  imageHash?: PeImageHash;
}

/**
 * What the load configuration directory says about the image's hardening. Each
 * field is present only when the structure was long enough to hold it: older
 * linkers wrote a shorter structure, so "absent" (not recorded) and zero (recorded
 * as off) are different answers.
 */
export interface PeLoadConfig {
  /** Whether the stack cookie's address is filled in, which is what /GS leaves behind. */
  securityCookie?: boolean;
  /** x86 only. Present when the image lists its safe exception handlers. */
  safeSeh?: { handlers: number };
  /** The IMAGE_GUARD_* flags. */
  guardFlags?: number;
  /** How many functions the Control Flow Guard table lists. */
  cfFunctionCount?: number;
}

export interface PeInfo {
  fileSize: number;
  format: 'PE32' | 'PE32+';
  machine: number;
  machineName: string;
  /** "Application", "Dynamic-link library", "Driver" and so on. */
  kind: string;
  subsystem: number;
  subsystemName: string;
  /** Seconds since 1970 as the linker wrote it. Not a date when `reproducible`. */
  timestamp: number;
  /** A deterministic build puts a hash where the link time would be. */
  reproducible: boolean;
  linkerVersion: string;
  osVersion: string;
  subsystemVersion: string;
  imageVersion: string;
  imageBase: string;
  entryPoint: number;
  sizeOfImage: number;
  checksum: number;
  largeAddressAware: boolean;
  /** Loader-enforced mitigations, each as [label, enabled]. */
  mitigations: [string, boolean][];
  /** The optional header's DllCharacteristics bits, as written. */
  dllCharacteristics: number;
  /** Other DllCharacteristics bits that are set, in words. Empty when none is. */
  loaderFlags: string[];
  sections: PeSection[];
  version?: VersionInfo;
  /** The largest image of the file's first icon, as a PNG. */
  icon?: PeIcon;
  manifest?: PeManifest;
  imports: PeImport[];
  exports?: PeExports;
  debug?: PeDebug;
  /** Hardening facts from the load configuration directory. Absent when it is missing or unreadable. */
  loadConfig?: PeLoadConfig;
  /** The debug directory says the image works with CET shadow stacks. False when it says nothing. */
  cetCompat: boolean;
  /** The linker's record of the tools that built the image, when it has one. */
  rich?: PeRich;
  dotnet?: PeDotNet;
  signature?: PeSignature;
  /** What `go version -m` would print, for a program built by the Go toolchain. */
  go?: GoBuildInfo;
  /** Bytes after the last section that no header accounts for, as an installer's payload is. */
  overlay?: { offset: number; size: number };
  /** Parts of the file that were present but could not be read. */
  warnings: string[];
}

const MAX_SECTIONS = 96;
// Go's own test for its data section: initialized data, readable, writable, less the alignment bits.
const GO_DATA_FLAGS = 0xc0000040;
const GO_ALIGN_BITS = 0x600000;
const MAX_IMPORTS = 1024;
const MAX_THUNKS = 16384;
// Across every imported library together. The per-library and per-table caps
// multiply to sixteen million entries, each a 64-bit compare; a real image,
// even a browser's, imports a few thousand functions in all.
const MAX_TOTAL_THUNKS = 262144;
const MAX_EXPORT_NAMES = 100;
// An export is addressed by a 16-bit ordinal, so a table has no use for more
// slots than that, and a header that claims more is not counted.
const MAX_EXPORT_SLOTS = 0x10000;
const MAX_RESOURCE_ENTRIES = 4096;
const MAX_VERSION_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFEST_NODES = 5000;
// The most of the COFF string table read for long section names. A section name
// is a short word; the table can hold every symbol name of a large program.
const MAX_STRING_TABLE_BYTES = 64 * 1024;
const MAX_LONG_NAME_BYTES = 256;
// The most of the DOS header and stub read for the Rich header. A real stub
// with its record is a few hundred bytes.
const MAX_STUB_BYTES = 4096;
// The load configuration structure has grown to about 400 bytes; every field
// read here lies in the first 0x94.
const MAX_LOAD_CONFIG_BYTES = 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
// A signed file has one entry, a dual-signed one two.
const MAX_CERTIFICATES = 16;

const CERTIFICATE_TYPES: Record<number, string> = {
  1: 'X.509 certificate',
  2: 'PKCS #7 SignedData',
  4: 'Terminal Server certificate',
};
// A 256 pixel, 32-bit bitmap with its mask is about 270 KB; a PNG is smaller.
const MAX_ICON_BYTES = 1024 * 1024;

const MACHINES: Record<number, string> = {
  0x014c: 'x86 (32-bit)',
  0x0200: 'Itanium (64-bit)',
  0x8664: 'x64 (64-bit)',
  0x01c0: 'ARM (32-bit)',
  0x01c2: 'ARM Thumb (32-bit)',
  0x01c4: 'ARM Thumb-2 (32-bit)',
  0xaa64: 'ARM64 (64-bit)',
  0x0ebc: 'EFI byte code',
  0x5032: 'RISC-V (32-bit)',
  0x5064: 'RISC-V (64-bit)',
  0x6232: 'LoongArch (32-bit)',
  0x6264: 'LoongArch (64-bit)',
};

const SUBSYSTEMS: Record<number, string> = {
  0: 'Unknown',
  1: 'Native',
  2: 'Windows GUI',
  3: 'Windows console',
  5: 'OS/2 console',
  7: 'POSIX console',
  9: 'Windows CE',
  10: 'EFI application',
  11: 'EFI boot service driver',
  12: 'EFI runtime driver',
  13: 'EFI ROM',
  14: 'Xbox',
  16: 'Windows boot application',
};

const DIR_EXPORT = 0;
const DIR_IMPORT = 1;
const DIR_RESOURCE = 2;
const DIR_SECURITY = 4;
const DIR_DEBUG = 6;
const DIR_LOAD_CONFIG = 10;
const DIR_DELAY_IMPORT = 13;
const DIR_CLR = 14;

const RT_VERSION = 16;
const RT_MANIFEST = 24;
// CREATEPROCESS_MANIFEST_RESOURCE_ID and ISOLATIONAWARE_MANIFEST_RESOURCE_ID.
const PROCESS_MANIFEST_ID = 1;
const ISOLATION_MANIFEST_ID = 2;
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

interface Directory {
  address: number;
  size: number;
}

function hex(value: number, width = 8): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

function kindOf(isDll: boolean, subsystem: number): string {
  if (subsystem >= 10 && subsystem <= 13) {
    return SUBSYSTEMS[subsystem];
  }
  if (subsystem === 1) {
    return isDll ? 'Native library' : 'Driver or native image';
  }
  if (isDll) {
    return 'Dynamic-link library';
  }
  return subsystem === 3 ? 'Console application' : 'Application';
}

// DllCharacteristics bits that have no row of their own in `mitigations`, in
// the order the page lists them.
const LOADER_FLAGS: [bit: number, label: string][] = [
  [0x0200, 'Ignores side-by-side manifests (NO_ISOLATION)'],
  [0x0400, 'No structured exception handlers (NO_SEH)'],
  [0x0800, 'Never bound (NO_BIND)'],
  [0x2000, 'WDM driver (WDM_DRIVER)'],
  [0x8000, 'Terminal Server aware (TERMINAL_SERVER_AWARE)'],
];

/** The label of the NX_COMPAT row in `PeInfo.mitigations`, which the page words specially. */
export const NX_COMPAT_LABEL = 'DEP compatible (NX_COMPAT)';

/** The label of the Control Flow Guard row, which the page words from the header bit and the load configuration together. */
export const CFG_LABEL = 'Control Flow Guard';

export async function readPe(source: ByteSource): Promise<PeInfo> {
  const reader = new Reader(source);
  if (reader.size < 64) {
    throw new PeError('it is too small to be a Windows executable.');
  }
  const dos = await reader.view(0, 64);
  if (dos.getUint16(0, true) !== 0x5a4d) {
    throw new PeError('it does not start with the "MZ" signature every Windows executable has.');
  }
  const peOffset = dos.getUint32(0x3c, true);
  // Signature (4) + COFF header (20) + the part of the optional header that
  // PE32 and PE32+ lay out identically, up to its magic and a little beyond.
  if (peOffset + 24 + 2 > reader.size) {
    throw new PeError(
      'it is a DOS or 16-bit program, which has none of the headers this preview reads.',
    );
  }
  const coff = await reader.view(peOffset, 24);
  if (coff.getUint32(0, true) !== 0x00004550) {
    throw new PeError(
      'it is a DOS or 16-bit program, which has none of the headers this preview reads.',
    );
  }
  const machine = coff.getUint16(4, true);
  const sectionCount = coff.getUint16(6, true);
  const timestamp = coff.getUint32(8, true);
  const optionalSize = coff.getUint16(20, true);
  const characteristics = coff.getUint16(22, true);

  const optOffset = peOffset + 24;
  if (optionalSize < 96) {
    throw new PeError('its optional header is too short to describe an image.');
  }
  const opt = await reader.view(optOffset, optionalSize);
  const magic = opt.getUint16(0, true);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new PeError(`its optional header has an unknown format (${hex(magic, 4)}).`);
  }
  const plus = magic === 0x20b;
  const dirCountOffset = plus ? 108 : 92;
  if (optionalSize < dirCountOffset + 4) {
    throw new PeError('its optional header is too short to describe an image.');
  }
  const subsystem = opt.getUint16(68, true);
  const dllFlags = opt.getUint16(70, true);
  const imageBase = plus ? opt.getBigUint64(24, true) : BigInt(opt.getUint32(28, true));
  const sectionAlignment = opt.getUint32(32, true);
  const sizeOfHeaders = opt.getUint32(60, true);

  const dirCount = Math.min(opt.getUint32(dirCountOffset, true), 16);
  const directories: Directory[] = [];
  for (let i = 0; i < dirCount; i++) {
    const at = dirCountOffset + 4 + i * 8;
    if (at + 8 > optionalSize) {
      break;
    }
    directories.push({ address: opt.getUint32(at, true), size: opt.getUint32(at + 4, true) });
  }
  const directory = (index: number): Directory | undefined => {
    const dir = directories[index];
    return dir && dir.address !== 0 && dir.size !== 0 ? dir : undefined;
  };

  if (sectionCount > MAX_SECTIONS) {
    throw new PeError(`it declares ${sectionCount} sections, more than a real image has.`);
  }
  // A download cut off inside the section table still has headers worth
  // showing, so the table is read as far as the file goes.
  const tableAt = optOffset + optionalSize;
  const present = Math.min(sectionCount, Math.max(0, Math.floor((reader.size - tableAt) / 40)));
  const early: string[] = [];
  if (present < sectionCount) {
    early.push(
      `The file ends inside the section table: ${present} of ${sectionCount} sections are shown.`,
    );
  }
  const table = await reader.view(tableAt, present * 40);
  const sections: PeSection[] = [];
  for (let i = 0; i < present; i++) {
    const at = i * 40;
    const nameBytes = new Uint8Array(table.buffer, table.byteOffset + at, 8);
    const nameEnd = nameBytes.indexOf(0);
    const flags = table.getUint32(at + 36, true);
    const contents: string[] = [];
    if (flags & 0x20) {
      contents.push('code');
    }
    if (flags & 0x40) {
      contents.push('data');
    }
    if (flags & 0x80) {
      contents.push('uninitialized data');
    }
    sections.push({
      name: printable(
        new TextDecoder().decode(nameEnd < 0 ? nameBytes : nameBytes.subarray(0, nameEnd)),
      ),
      virtualSize: table.getUint32(at + 8, true),
      virtualAddress: table.getUint32(at + 12, true),
      rawSize: table.getUint32(at + 16, true),
      rawOffset: table.getUint32(at + 20, true),
      characteristics: flags,
      read: (flags & 0x40000000) !== 0,
      write: (flags & 0x80000000) !== 0,
      execute: (flags & 0x20000000) !== 0,
      contents,
    });
  }

  await resolveLongNames(reader, sections, coff.getUint32(12, true), coff.getUint32(16, true));

  // What the loader maps of each section. Its extent in memory is VirtualSize
  // rounded up to the section alignment (or SizeOfRawData when VirtualSize is
  // 0, as old linkers left it), and only the part of that the file holds is
  // backed by bytes. Raw data past the extent is file padding, or bytes that
  // belong to the next section, never what an address there reads.
  const align = sectionAlignment > 0 ? sectionAlignment : 1;
  const spans = sections.map((s) => {
    const extent = s.virtualSize === 0 ? s.rawSize : Math.ceil(s.virtualSize / align) * align;
    return {
      start: s.virtualAddress,
      extent,
      backed: Math.min(s.rawSize, extent),
      raw: s.rawOffset,
    };
  });

  /**
   * The file bytes behind a relative virtual address: where they start and how
   * many follow before the section's file data ends, or the file does.
   */
  const rangeOf = (rva: number): Mapped | undefined => {
    for (const s of spans) {
      if (rva >= s.start && rva - s.start < s.extent) {
        // Inside the section but past its file data: zero-filled at load time.
        if (rva - s.start >= s.backed) {
          return undefined;
        }
        const offset = s.raw + (rva - s.start);
        const end = s.raw + s.backed;
        return offset < reader.size
          ? {
              offset,
              length: Math.min(end, reader.size) - offset,
              cut: end > reader.size,
              zeroFill: s.extent - s.backed,
            }
          : undefined;
      }
    }
    // The headers are mapped at the image base, one to one. What the loader
    // maps after them is not counted on here as zeros.
    return rva < sizeOfHeaders && rva < reader.size
      ? {
          offset: rva,
          length: Math.min(sizeOfHeaders, reader.size) - rva,
          cut: sizeOfHeaders > reader.size,
          zeroFill: 0,
        }
      : undefined;
  };
  /** Where in the file a relative virtual address lives, if it is backed by file data at all. */
  const toOffset = (rva: number): number | undefined => rangeOf(rva)?.offset;
  const need = (rva: number): number => {
    const offset = toOffset(rva);
    if (offset === undefined) {
      throw new PeError(TRUNCATED);
    }
    return offset;
  };
  const needRange = (rva: number): Mapped => {
    const range = rangeOf(rva);
    if (range === undefined) {
      throw new PeError(TRUNCATED);
    }
    return range;
  };

  const isDll = (characteristics & 0x2000) !== 0;
  const info: PeInfo = {
    fileSize: reader.size,
    format: plus ? 'PE32+' : 'PE32',
    machine,
    machineName: MACHINES[machine] ?? `Unknown (${hex(machine, 4)})`,
    kind: kindOf(isDll, subsystem),
    subsystem,
    subsystemName: SUBSYSTEMS[subsystem] ?? `Unknown (${subsystem})`,
    timestamp,
    reproducible: false,
    linkerVersion: `${opt.getUint8(2)}.${opt.getUint8(3)}`,
    osVersion: `${opt.getUint16(40, true)}.${opt.getUint16(42, true)}`,
    imageVersion: `${opt.getUint16(44, true)}.${opt.getUint16(46, true)}`,
    subsystemVersion: `${opt.getUint16(48, true)}.${opt.getUint16(50, true)}`,
    imageBase: `0x${imageBase
      .toString(16)
      .toUpperCase()
      .padStart(plus ? 16 : 8, '0')}`,
    entryPoint: opt.getUint32(16, true),
    sizeOfImage: opt.getUint32(56, true),
    checksum: opt.getUint32(64, true),
    largeAddressAware: (characteristics & 0x20) !== 0,
    mitigations: [
      ['Address randomization (ASLR)', (dllFlags & 0x40) !== 0],
      ['High-entropy ASLR', (dllFlags & 0x20) !== 0],
      // The header flag, under its own name. Whether DEP is in force is not
      // this bit's to say: 64-bit Windows enforces it for every native 64-bit
      // program whatever the flag holds. The page words the row accordingly.
      [NX_COMPAT_LABEL, (dllFlags & 0x100) !== 0],
      [CFG_LABEL, (dllFlags & 0x4000) !== 0],
      ['Forced integrity checks', (dllFlags & 0x80) !== 0],
      ['AppContainer only', (dllFlags & 0x1000) !== 0],
    ],
    dllCharacteristics: dllFlags,
    cetCompat: false,
    loaderFlags: LOADER_FLAGS.filter(([bit]) => (dllFlags & bit) !== 0).map(([, label]) => label),
    sections,
    imports: [],
    warnings: early,
  };

  // A damaged table costs that table, not the preview: the headers above are
  // already worth showing, and a truncated download is exactly when someone
  // wants to see what the file claims to be.
  const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch {
      info.warnings.push(`The ${what} could not be read.`);
    }
  };

  // The record sits between the DOS stub and the PE header, so it is read from
  // the start of the file up to e_lfanew, as far as is plausible.
  await attempt('build tools record', async () => {
    const stub = await reader.bytes(0, Math.min(peOffset, MAX_STUB_BYTES));
    info.rich = readRich(stub);
  });

  const resources = directory(DIR_RESOURCE);
  if (resources) {
    await attempt('version resource', async () => {
      const data = await findResource(reader, toOffset, need(resources.address), RT_VERSION);
      if (data) {
        info.version = readVersionResource(
          await reader.upTo(data.offset, Math.min(data.size, MAX_VERSION_BYTES)),
        );
      }
    });
    await attempt('icon', async () => {
      const root = need(resources.address);
      // The first group is the one Explorer shows for the file.
      const group = await findResource(reader, toOffset, root, RT_GROUP_ICON);
      if (!group) {
        return;
      }
      const choice = pickIcon(
        await reader.upTo(group.offset, Math.min(group.size, 4096)),
        MAX_ICON_BYTES,
      );
      const image = choice && (await findResource(reader, toOffset, root, RT_ICON, choice.id));
      if (image) {
        info.icon = iconToPng(
          await reader.upTo(image.offset, Math.min(image.size, MAX_ICON_BYTES)),
        );
      }
    });
    await attempt('manifest', async () => {
      // The manifest Windows applies to the process is resource ID 1 in an
      // executable and ID 2 in a library, which is where the linker puts
      // them. A file may carry others, and named ones sort first in the
      // directory: taking the first found showed a secondary activation
      // context's "asInvoker" for a program whose own manifest asks for
      // administrator rights. Only the process manifest is read, and a file
      // with none at its ID is shown as having none.
      const root = need(resources.address);
      const ids = isDll ? [ISOLATION_MANIFEST_ID, PROCESS_MANIFEST_ID] : [PROCESS_MANIFEST_ID];
      let data: { offset: number; size: number } | undefined;
      for (const id of ids) {
        data = await findResource(reader, toOffset, root, RT_MANIFEST, id);
        if (data) {
          break;
        }
      }
      if (data) {
        info.manifest = readManifest(
          await reader.upTo(data.offset, Math.min(data.size, MAX_MANIFEST_BYTES)),
        );
      }
    });
  }

  const thunks = { left: MAX_TOTAL_THUNKS };
  const imports = directory(DIR_IMPORT);
  if (imports) {
    await attempt('import table', async () => {
      info.imports.push(
        ...(await readImports(
          reader,
          rangeOf,
          needRange(imports.address),
          plus,
          thunks,
          info.warnings,
        )),
      );
    });
  }
  const delayed = directory(DIR_DELAY_IMPORT);
  if (delayed) {
    await attempt('delay-load import table', async () => {
      info.imports.push(
        ...(await readDelayImports(
          reader,
          rangeOf,
          needRange(delayed.address),
          plus,
          thunks,
          info.warnings,
        )),
      );
    });
  }

  const exported = directory(DIR_EXPORT);
  if (exported) {
    await attempt('export table', async () => {
      info.exports = await readExports(
        reader,
        need,
        rangeOf,
        need(exported.address),
        info.warnings,
      );
    });
  }

  // The header bit only says the linker was asked for Control Flow Guard. The
  // load configuration is where the guard tables and flags actually are, so
  // this is what shows whether the protection is really in the image. The
  // structure's own first field is its size, and it is trusted over the
  // directory's: old linkers wrote the directory size wrong.
  const loadConfig = directory(DIR_LOAD_CONFIG);
  if (loadConfig) {
    await attempt('load configuration', async () => {
      const at = needRange(loadConfig.address);
      if (at.length < 4) {
        throw new PeError(TRUNCATED);
      }
      const declared = (await reader.view(at.offset, 4)).getUint32(0, true);
      const length = Math.min(declared, at.length, MAX_LOAD_CONFIG_BYTES);
      const view = await reader.view(at.offset, length);
      const fits = (offset: number, width: number): boolean => offset + width <= length;
      const config: PeLoadConfig = {};
      if (fits(plus ? 0x58 : 0x3c, plus ? 8 : 4)) {
        const cookie = plus
          ? view.getBigUint64(0x58, true) !== 0n
          : view.getUint32(0x3c, true) !== 0;
        config.securityCookie = cookie;
      }
      // The handler table is a 32-bit idea: 64-bit images find their handlers
      // through the exception directory instead.
      if (!plus && fits(0x40, 8) && view.getUint32(0x40, true) !== 0) {
        config.safeSeh = { handlers: view.getUint32(0x44, true) };
      }
      if (fits(plus ? 0x90 : 0x58, 4)) {
        config.guardFlags = view.getUint32(plus ? 0x90 : 0x58, true);
      }
      if (fits(plus ? 0x88 : 0x54, plus ? 8 : 4)) {
        if (plus) {
          // A count too large for 32 bits is not a real table. It is shown as
          // the largest safe number, which reads as "very many".
          const high = view.getUint32(0x8c, true);
          config.cfFunctionCount =
            high === 0 ? view.getUint32(0x88, true) : Number.MAX_SAFE_INTEGER;
        } else {
          config.cfFunctionCount = view.getUint32(0x54, true);
        }
      }
      info.loadConfig = config;
    });
  }

  const debug = directory(DIR_DEBUG);
  if (debug) {
    await attempt('debug directory', async () => {
      // The entries are read as far as the file holds them, and one whose
      // record lies outside the file is skipped rather than ending the loop.
      const declared = Math.min(Math.floor(debug.size / 28), 32);
      const bytes = await reader.upTo(need(debug.address), declared * 28);
      const entries = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = Math.floor(bytes.length / 28);
      if (count < declared) {
        info.warnings.push(
          'The file ends inside the debug directory: the entries before that are shown.',
        );
      }
      let skipped = 0;
      for (let i = 0; i < count; i++) {
        const type = entries.getUint32(i * 28 + 12, true);
        const size = entries.getUint32(i * 28 + 16, true);
        const pointer = entries.getUint32(i * 28 + 24, true);
        if (type === 16) {
          info.reproducible = true;
        } else if (type === 20 && size >= 4) {
          // IMAGE_DEBUG_TYPE_EX_DLLCHARACTERISTICS: a second set of
          // DllCharacteristics bits that does not fit in the header. Bit 0 says
          // the image works with CET shadow stacks.
          try {
            info.cetCompat = ((await reader.view(pointer, 4)).getUint32(0, true) & 0x1) !== 0;
          } catch {
            skipped++;
          }
        } else if (type === 2 && size >= 24 && !info.debug) {
          try {
            const head = await reader.view(pointer, 24);
            // "RSDS": the PDB 7.0 record every toolchain of the last two decades writes.
            if (head.getUint32(0, true) === 0x53445352) {
              info.debug = {
                guid: guidAt(head, 4),
                age: head.getUint32(20, true),
                pdbPath: await reader.cstr(pointer + 24, Math.min(size - 24, 1024)),
              };
            }
          } catch {
            skipped++;
          }
        }
      }
      if (skipped > 0) {
        info.warnings.push(leftOut(skipped, 'debug directory'));
      }
    });
  }

  const clr = directory(DIR_CLR);
  if (clr) {
    await attempt('.NET header', async () => {
      const head = await reader.view(need(clr.address), 20);
      const flags = head.getUint32(16, true);
      const dotnet: PeDotNet = {
        ilOnly: (flags & 0x1) !== 0,
        requires32Bit: (flags & 0x2) !== 0 && (flags & 0x20000) === 0,
        prefers32Bit: (flags & 0x20000) !== 0,
        strongNamed: (flags & 0x8) !== 0,
      };
      info.dotnet = dotnet;
      const metadata = toOffset(head.getUint32(8, true));
      if (metadata !== undefined) {
        const root = await reader.view(metadata, 16);
        // "BSJB", then a length-prefixed runtime version string.
        if (root.getUint32(0, true) === 0x424a5342) {
          const length = Math.min(root.getUint32(12, true), 255);
          dotnet.runtime = (await reader.cstr(metadata + 16, length)) || undefined;
        }
      }
    });
  }

  // The one directory whose address is a file offset, not an RVA: the
  // certificate table is not mapped into memory, so it has no virtual address.
  const security = directory(DIR_SECURITY);
  if (security) {
    await attempt('signature', async () => {
      // The table is a run of WIN_CERTIFICATE entries, each padded to eight
      // bytes. Only type 2, PKCS #7 SignedData, is an Authenticode signature;
      // the table existing says nothing by itself. Every entry is looked at,
      // within the table's declared size and the file's real one.
      if (security.address + 8 > reader.size) {
        // A directory pointing past the end of the file is a damaged file, not
        // an empty certificate table.
        throw new PeError(TRUNCATED);
      }
      const signature: PeSignature = { size: security.size, signedData: false, entries: [] };
      info.signature = signature;
      const end = Math.min(security.address + security.size, reader.size);
      let at = security.address;
      for (let i = 0; i < MAX_CERTIFICATES && at + 8 <= end; i++) {
        const head = await reader.view(at, 8);
        const length = head.getUint32(0, true);
        const type = head.getUint16(6, true);
        // An entry is its 8-byte header and its content, and it lies inside
        // the table. A length that says otherwise is damage, and is not
        // followed: stepping by it would carry the walk out of the table and
        // read whatever lies there as certificate entries.
        if (length < 8 || length > end - at) {
          break;
        }
        signature.entries.push(CERTIFICATE_TYPES[type] ?? `Type ${type}`);
        if (type === 2 && !signature.signedData) {
          const der = await reader.upTo(
            at + 8,
            Math.min(length - 8, MAX_SIGNATURE_BYTES, end - at - 8),
          );
          // SignedData with no signer is a bundle of certificates, not a
          // signature: something has to have signed.
          if (isSignedData(der) && signerCount(der) > 0) {
            signature.signedData = true;
            signature.signer = readSigner(der);
            signature.imageHash = await checkImageHash(reader, der, {
              checksumAt: optOffset + 64,
              directoryAt: optOffset + dirCountOffset + 4 + DIR_SECURITY * 8,
              headersEnd: Math.max(sizeOfHeaders, optOffset + optionalSize + sectionCount * 40),
              table: security,
            });
          }
        }
        // Entries are padded to eight bytes. Arithmetic, not a bit mask: a
        // mask works on 32-bit signed values, and turned a length near the
        // top of the range into a step backwards.
        at += Math.ceil(length / 8) * 8;
      }
    });
  }

  // The Go linker puts its build information in the data section. The old
  // layout names it by address, which is the image base plus an RVA.
  // Go looks in the first section that is initialized, readable and writable
  // data (ignoring the alignment bits), whatever it is named, so that comes
  // first; a section named .data is tried after it, in case the flags are odd.
  // A name alone is not enough: a read-only section can be called .data while
  // the record sits in another.
  const usable = (s: PeSection): boolean => s.rawSize > 0 && s.rawOffset < reader.size;
  const byFlags = sections.find(
    (s) =>
      usable(s) &&
      s.virtualAddress !== 0 &&
      (s.characteristics & ~GO_ALIGN_BITS) >>> 0 === GO_DATA_FLAGS,
  );
  const byName = sections.find((s) => s.name === '.data' && usable(s));
  const candidates = [byFlags, byName].filter(
    (s, i, all): s is PeSection => s !== undefined && all.indexOf(s) === i,
  );
  if (candidates.length > 0) {
    await attempt('Go build information', async () => {
      for (const data of candidates) {
        const go = await readGoBuildInfo(
          reader,
          {
            offset: data.rawOffset,
            size: data.rawSize,
            vaddr: imageBase + BigInt(data.virtualAddress),
          },
          (address) => {
            const rva = address - imageBase;
            const at = rva >= 0n && rva <= 0xffffffffn ? rangeOf(Number(rva)) : undefined;
            return at === undefined ? undefined : { offset: at.offset, available: at.length };
          },
        );
        if (go) {
          info.go = go;
          info.warnings.push(...go.warnings);
          return;
        }
      }
    });
  }

  let end = sizeOfHeaders;
  for (const s of sections) {
    if (s.rawSize > 0) {
      end = Math.max(end, s.rawOffset + s.rawSize);
    }
  }
  const tail = security && security.address >= end ? security.address : reader.size;
  if (end < tail && tail <= reader.size) {
    info.overlay = { offset: end, size: tail - end };
  }

  return info;
}

// MinGW and GCC name a section whose name is over 8 bytes "/N": a slash and the
// decimal offset of the real name in the COFF string table. The table follows
// the symbol table, and its first four bytes are its own size. Resolved with
// one bounded read for all sections. Anything out of range leaves the name
// as it was written, and this never throws: the short name is still worth
// showing.
async function resolveLongNames(
  reader: Reader,
  sections: PeSection[],
  symbolPointer: number,
  symbolCount: number,
): Promise<void> {
  if (symbolPointer === 0 || !sections.some((s) => /^\/\d+$/.test(s.name))) {
    return;
  }
  try {
    const tableAt = symbolPointer + symbolCount * 18;
    if (tableAt + 4 > reader.size) {
      return;
    }
    const bytes = await reader.upTo(tableAt, MAX_STRING_TABLE_BYTES);
    if (bytes.length < 4) {
      return;
    }
    const size = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    // What was read, but no further than the table says it extends.
    const limit = Math.min(size, bytes.length);
    for (const section of sections) {
      if (!/^\/\d+$/.test(section.name)) {
        continue;
      }
      const at = Number(section.name.slice(1));
      if (!Number.isSafeInteger(at) || at < 4 || at >= limit) {
        continue;
      }
      const end = bytes.subarray(at, Math.min(limit, at + MAX_LONG_NAME_BYTES)).indexOf(0);
      const text = bytes.subarray(
        at,
        end < 0 ? Math.min(limit, at + MAX_LONG_NAME_BYTES) : at + end,
      );
      const name = printable(new TextDecoder().decode(text));
      if (name) {
        section.name = name;
      }
    }
  } catch {
    // Keep the "/N" names.
  }
}

function guidAt(view: DataView, at: number): string {
  const h = (value: number, width: number): string => value.toString(16).padStart(width, '0');
  let tail = '';
  for (let i = 8; i < 16; i++) {
    tail += h(view.getUint8(at + i), 2);
    if (i === 9) {
      tail += '-';
    }
  }
  return `${h(view.getUint32(at, true), 8)}-${h(view.getUint16(at + 4, true), 4)}-${h(view.getUint16(at + 6, true), 4)}-${tail}`.toUpperCase();
}

// The resource tree is three levels deep: type, then name, then language. This
// takes the first language of the resource of `type` numbered `name`, or of
// the first resource of that type when no name is asked for, which for a
// version resource or a manifest is the only one a normal image has.
async function findResource(
  reader: Reader,
  toOffset: (rva: number) => number | undefined,
  root: number,
  type: number,
  name?: number,
): Promise<{ offset: number; size: number } | undefined> {
  let table = root;
  for (let level = 0; level < 3; level++) {
    const head = await reader.view(table, 16);
    const named = head.getUint16(12, true);
    const ids = head.getUint16(14, true);
    const count = Math.min(named + ids, MAX_RESOURCE_ENTRIES);
    const entries = await reader.view(table + 16, count * 8);
    let target: number | undefined;
    for (let i = 0; i < count; i++) {
      const id = entries.getUint32(i * 8, true);
      // Levels 0 and 1 match by number; a named entry (high bit set) is never one.
      const wanted = level === 0 ? type : level === 1 ? name : undefined;
      if (wanted === undefined || id === wanted) {
        target = entries.getUint32(i * 8 + 4, true);
        break;
      }
    }
    if (target === undefined) {
      return undefined;
    }
    const isTable = (target & 0x80000000) !== 0;
    const at = root + (target & 0x7fffffff);
    if (!isTable) {
      const leaf = await reader.view(at, 16);
      const offset = toOffset(leaf.getUint32(0, true));
      return offset === undefined ? undefined : { offset, size: leaf.getUint32(4, true) };
    }
    table = at;
  }
  return undefined;
}

/** The file bytes behind an RVA, up to where the section's file data or the file ends. */
export interface Mapped {
  offset: number;
  length: number;
  /** The file ends before the section's file data does: the bytes past `length` are missing. */
  cut: boolean;
  /** Bytes of the section after its file data that the loader fills with zeros. */
  zeroFill: number;
}

/**
 * Count a NUL-terminated array of import thunks, 4 bytes each in PE32 and 8
 * in PE32+, within the bytes mapped at its start. An array that runs to the end
 * of those bytes ends there only when a whole zero entry is known to follow:
 * the leftover file bytes are zero and the section's zero-filled tail makes up
 * the rest. Otherwise (the file is cut off, or the section's data runs right
 * up to its mapped end, where the next address may be another section's) the
 * count is not known. Every entry looked at is charged to `budget`, including
 * on the way out of a read error.
 */
export async function countThunks(
  reader: Reader,
  start: Mapped,
  plus: boolean,
  budget: { left: number },
): Promise<number | undefined> {
  const width = plus ? 8 : 4;
  const chunk = 512;
  const most = Math.min(MAX_THUNKS, budget.left);
  const limit = Math.floor(start.length / width);
  let count = 0;
  try {
    while (count < most) {
      if (count >= limit) {
        if (start.cut) {
          return undefined;
        }
        const tail = start.length - limit * width;
        if (tail + start.zeroFill < width) {
          return undefined;
        }
        if (tail > 0) {
          const rest = await reader.bytes(start.offset + limit * width, tail);
          if (rest.some((b) => b !== 0)) {
            return undefined;
          }
        }
        return count;
      }
      const entries = Math.min(chunk, limit - count, most - count);
      const view = await reader.view(start.offset + count * width, entries * width);
      for (let i = 0; i < entries; i++) {
        const zero = plus
          ? view.getBigUint64(i * width, true) === 0n
          : view.getUint32(i * width, true) === 0;
        if (zero) {
          return count;
        }
        count++;
      }
    }
    return count;
  } finally {
    budget.left -= count;
  }
}

// One bad entry costs that entry, not the table: a library whose name points
// nowhere is left out and the rest are still listed. Each reader says what it
// left out in one warning, so a badly damaged table does not flood the page.

/** "2 entries of the import table could not be read and are left out." */
function leftOut(count: number, table: string): string {
  return count === 1
    ? `1 entry of the ${table} could not be read and is left out.`
    : `${count} entries of the ${table} could not be read and are left out.`;
}

/**
 * Descriptor `index` of a table read entry by entry, within the bytes mapped
 * at the table's start: the walk does not run on into whatever follows the
 * section's file data. When the table stops early, one warning says why, and
 * the entries before are kept. The first entry failing fails the table.
 */
async function descriptor(
  reader: Reader,
  start: Mapped,
  index: number,
  size: number,
  table: string,
  warnings: string[],
): Promise<DataView | undefined> {
  const at = index * size;
  if (at + size > start.length) {
    if (index === 0) {
      throw new PeError(TRUNCATED);
    }
    warnings.push(
      start.cut
        ? `The file ends inside the ${table}: the entries before that are shown.`
        : `The ${table} runs to the end of its section without a closing entry: the entries before that are shown.`,
    );
    return undefined;
  }
  try {
    return await reader.view(start.offset + at, size);
  } catch (error) {
    if (index === 0) {
      throw error;
    }
    // Not the end of the file, which the check above rules out: the read
    // budget or the file system stopped it, and the page says which.
    const reason = error instanceof Error ? error.message : 'a read failed.';
    warnings.push(`The rest of the ${table} could not be read: ${reason}`);
    return undefined;
  }
}

/** A descriptor's library name, or undefined when it points nowhere or cannot be read. */
async function libraryName(
  reader: Reader,
  rangeOf: (rva: number) => Mapped | undefined,
  rva: number,
): Promise<string | undefined> {
  const at = rangeOf(rva);
  if (!at) {
    return undefined;
  }
  try {
    return await reader.cstr(at.offset, Math.min(260, at.length));
  } catch {
    return undefined;
  }
}

/** Count the thunks at an RVA, or undefined when they cannot be reached or end unseen. */
async function thunksAt(
  reader: Reader,
  rangeOf: (rva: number) => Mapped | undefined,
  rvas: number[],
  plus: boolean,
  budget: { left: number },
): Promise<number | undefined> {
  // The first RVA that maps is used; a later one is a fallback for an
  // earlier one that does not.
  const start = rvas.map((rva) => (rva === 0 ? undefined : rangeOf(rva))).find(Boolean);
  if (!start) {
    return undefined;
  }
  try {
    return await countThunks(reader, start, plus, budget);
  } catch {
    return undefined;
  }
}

async function readImports(
  reader: Reader,
  rangeOf: (rva: number) => Mapped | undefined,
  start: Mapped,
  plus: boolean,
  budget: { left: number },
  warnings: string[],
): Promise<PeImport[]> {
  const table = 'import table';
  const out: PeImport[] = [];
  let skipped = 0;
  for (let i = 0; i < MAX_IMPORTS; i++) {
    const entry = await descriptor(reader, start, i, 20, table, warnings);
    if (!entry) {
      break;
    }
    const lookup = entry.getUint32(0, true);
    const name = entry.getUint32(12, true);
    const address = entry.getUint32(16, true);
    if (lookup === 0 && name === 0 && address === 0) {
      break;
    }
    const library = await libraryName(reader, rangeOf, name);
    if (library === undefined) {
      skipped++;
      continue;
    }
    out.push({
      library,
      // The lookup table is the one a bound image leaves untouched; the
      // address table is all an old linker wrote, and the copy to fall back
      // on when the lookup table's address does not resolve.
      functions: await thunksAt(reader, rangeOf, [lookup, address], plus, budget),
      delayLoaded: false,
    });
  }
  if (skipped > 0) {
    warnings.push(leftOut(skipped, table));
  }
  return out;
}

async function readDelayImports(
  reader: Reader,
  rangeOf: (rva: number) => Mapped | undefined,
  start: Mapped,
  plus: boolean,
  budget: { left: number },
  warnings: string[],
): Promise<PeImport[]> {
  const table = 'delay-load import table';
  const out: PeImport[] = [];
  let skipped = 0;
  for (let i = 0; i < MAX_IMPORTS; i++) {
    const entry = await descriptor(reader, start, i, 32, table, warnings);
    if (!entry) {
      break;
    }
    const attributes = entry.getUint32(0, true);
    const name = entry.getUint32(4, true);
    const names = entry.getUint32(16, true);
    if (name === 0) {
      break;
    }
    // Without this bit the fields are absolute addresses, a layout nothing has
    // emitted since Visual C++ 6. Stop rather than misread them as RVAs.
    if ((attributes & 1) === 0) {
      break;
    }
    const library = await libraryName(reader, rangeOf, name);
    if (library === undefined) {
      skipped++;
      continue;
    }
    out.push({
      library,
      functions: names === 0 ? 0 : await thunksAt(reader, rangeOf, [names], plus, budget),
      delayLoaded: true,
    });
  }
  if (skipped > 0) {
    warnings.push(leftOut(skipped, table));
  }
  return out;
}

async function readExports(
  reader: Reader,
  need: (rva: number) => number,
  rangeOf: (rva: number) => Mapped | undefined,
  offset: number,
  warnings: string[],
): Promise<PeExports> {
  const head = await reader.view(offset, 40);
  const nameRva = head.getUint32(12, true);
  const base = head.getUint32(16, true);
  const slots = head.getUint32(20, true);
  const named = head.getUint32(24, true);
  const namesRva = head.getUint32(32, true);
  // The header gives the length of the address table, not how many of its
  // entries are in use: shell32.dll has 2,001 slots and 843 exports. The
  // unused ordinals are zero, so the functions are the entries that are not.
  let functions: number | undefined;
  if (slots <= MAX_EXPORT_SLOTS) {
    try {
      const table = await reader.view(need(head.getUint32(28, true)), slots * 4);
      functions = 0;
      for (let i = 0; i < slots; i++) {
        if (table.getUint32(i * 4, true) !== 0) {
          functions++;
        }
      }
    } catch {
      // The names below may still be readable; the page says the slots were not counted.
      functions = undefined;
    }
  }
  // The name table is read as far as its section's file data holds it, and a
  // name whose pointer leads nowhere is left out. If the table itself cannot
  // be reached, the counts above are still shown without names.
  const shown = Math.min(named, MAX_EXPORT_NAMES);
  const names: string[] = [];
  let skipped = 0;
  if (shown > 0) {
    const table = rangeOf(namesRva);
    const present = table ? Math.min(shown, Math.floor(table.length / 4)) : 0;
    let view: DataView | undefined;
    if (table && present > 0) {
      try {
        view = await reader.view(table.offset, present * 4);
      } catch {
        view = undefined;
      }
    }
    if (!view) {
      skipped = shown;
      warnings.push('The table of exported names could not be read.');
    } else {
      skipped += shown - present;
      for (let i = 0; i < present; i++) {
        try {
          names.push(await reader.cstr(need(view.getUint32(i * 4, true)), 512));
        } catch {
          skipped++;
        }
      }
      if (skipped > 0) {
        warnings.push(
          skipped === 1
            ? '1 exported name could not be read and is left out.'
            : `${skipped} exported names could not be read and are left out.`,
        );
      }
    }
  }
  let name = '';
  if (nameRva !== 0) {
    try {
      name = await reader.cstr(need(nameRva), 260);
    } catch {
      warnings.push('The name the library exports under could not be read.');
    }
  }
  return {
    name,
    base,
    functions,
    slots,
    named,
    names,
    ...(skipped > 0 ? { unreadNames: skipped } : {}),
  };
}

// An application manifest is a small XML document, and it is parsed as one.
// Matching its text instead reads the wrong thing in two ordinary cases: the
// stock Visual Studio manifest keeps a commented-out example of every
// execution level above the live element, so the first textual match for
// requestedExecutionLevel is the comment's asInvoker whatever the program
// really asks for; and the first assemblyIdentity in the text of many
// manifests is a dependency's (the common controls library), not the
// program's own.
function readManifest(bytes: Uint8Array): PeManifest | undefined {
  // A manifest is UTF-8 unless a byte order mark says UTF-16.
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  // Bounded: a manifest is a few dozen elements, and a tree costs a hundred
  // times its text, so a quarter megabyte of empty elements is not parsed.
  const root = parseXmlBounded(new TextDecoder(encoding).decode(bytes), {
    maxNodes: MAX_MANIFEST_NODES,
    maxDepth: 64,
  });
  const clean = (value: string | undefined): string | undefined => {
    const text = value === undefined ? '' : printable(value).trim().slice(0, 200);
    return text || undefined;
  };
  const first = (name: string) => findAll(root, name)[0];
  // The program's own identity is the one directly under <assembly>. Those
  // nested in <dependency> name what it depends on.
  const assembly = child(root, 'assembly');
  const own = assembly && child(assembly, 'assemblyIdentity');
  const name = clean(own?.attrs.name);
  const version = clean(own?.attrs.version);
  const level = first('requestedExecutionLevel');
  const manifest: PeManifest = {
    executionLevel: clean(level?.attrs.level),
    uiAccess: clean(level?.attrs.uiAccess),
    dpiAware: clean(first('dpiAwareness')?.text) ?? clean(first('dpiAware')?.text),
    identity: name ? (version ? `${name} ${version}` : name) : undefined,
  };
  return Object.values(manifest).some((value) => value !== undefined) ? manifest : undefined;
}
