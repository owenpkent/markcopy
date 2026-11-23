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
import { iconToPng, pickIcon, type PeIcon } from './icon';
import { readSigner, type Signer } from './signer';
import {
  RangeReader as Reader,
  ReadError as PeError,
  TRUNCATED,
  type ByteSource,
} from '../binary/reader';
import { printable } from '../binary/text';
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
  /** Readable, writable, executable, in that order, as the loader will map it. */
  read: boolean;
  write: boolean;
  execute: boolean;
  /** What the section says it holds: code, initialized data, uninitialized data. */
  contents: string[];
}

export interface PeImport {
  library: string;
  functions: number;
  delayLoaded: boolean;
}

export interface PeExports {
  /** The name the image exports under, which survives a rename of the file. */
  name: string;
  functions: number;
  named: number;
  /** The first names, in table order. `named` says how many there are in all. */
  names: string[];
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
  /** Who the signature names. Absent when the table is not PKCS #7 we can walk. */
  signer?: Signer;
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
  sections: PeSection[];
  version?: VersionInfo;
  /** The largest image of the file's first icon, as a PNG. */
  icon?: PeIcon;
  manifest?: PeManifest;
  imports: PeImport[];
  exports?: PeExports;
  debug?: PeDebug;
  dotnet?: PeDotNet;
  signature?: PeSignature;
  /** Bytes after the last section that no header accounts for, as an installer's payload is. */
  overlay?: { offset: number; size: number };
  /** Parts of the file that were present but could not be read. */
  warnings: string[];
}

const MAX_SECTIONS = 96;
const MAX_IMPORTS = 1024;
const MAX_THUNKS = 16384;
const MAX_EXPORT_NAMES = 100;
const MAX_RESOURCE_ENTRIES = 4096;
const MAX_VERSION_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
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
const DIR_DELAY_IMPORT = 13;
const DIR_CLR = 14;

const RT_VERSION = 16;
const RT_MANIFEST = 24;
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
  const table = await reader.view(optOffset + optionalSize, sectionCount * 40);
  const sections: PeSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
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
      read: (flags & 0x40000000) !== 0,
      write: (flags & 0x80000000) !== 0,
      execute: (flags & 0x20000000) !== 0,
      contents,
    });
  }

  /** Where in the file a relative virtual address lives, if it is backed by file data at all. */
  const toOffset = (rva: number): number | undefined => {
    for (const s of sections) {
      if (rva >= s.virtualAddress && rva - s.virtualAddress < s.rawSize) {
        const offset = s.rawOffset + (rva - s.virtualAddress);
        return offset < reader.size ? offset : undefined;
      }
    }
    // The headers are mapped at the image base, one to one.
    return rva < sizeOfHeaders && rva < reader.size ? rva : undefined;
  };
  const need = (rva: number): number => {
    const offset = toOffset(rva);
    if (offset === undefined) {
      throw new PeError(TRUNCATED);
    }
    return offset;
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
      ['Address space layout randomization (ASLR)', (dllFlags & 0x40) !== 0],
      ['High-entropy ASLR', (dllFlags & 0x20) !== 0],
      ['Data execution prevention (DEP)', (dllFlags & 0x100) !== 0],
      ['Control Flow Guard', (dllFlags & 0x4000) !== 0],
      ['Forced integrity checks', (dllFlags & 0x80) !== 0],
      ['AppContainer only', (dllFlags & 0x1000) !== 0],
    ],
    sections,
    imports: [],
    warnings: [],
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
      const data = await findResource(reader, toOffset, need(resources.address), RT_MANIFEST);
      if (data) {
        info.manifest = readManifest(
          await reader.upTo(data.offset, Math.min(data.size, MAX_MANIFEST_BYTES)),
        );
      }
    });
  }

  const imports = directory(DIR_IMPORT);
  if (imports) {
    await attempt('import table', async () => {
      info.imports.push(...(await readImports(reader, need, need(imports.address), plus)));
    });
  }
  const delayed = directory(DIR_DELAY_IMPORT);
  if (delayed) {
    await attempt('delay-load import table', async () => {
      info.imports.push(...(await readDelayImports(reader, need, need(delayed.address), plus)));
    });
  }

  const exported = directory(DIR_EXPORT);
  if (exported) {
    await attempt('export table', async () => {
      info.exports = await readExports(reader, need, need(exported.address));
    });
  }

  const debug = directory(DIR_DEBUG);
  if (debug) {
    await attempt('debug directory', async () => {
      const count = Math.min(Math.floor(debug.size / 28), 32);
      const entries = await reader.view(need(debug.address), count * 28);
      for (let i = 0; i < count; i++) {
        const type = entries.getUint32(i * 28 + 12, true);
        const size = entries.getUint32(i * 28 + 16, true);
        const pointer = entries.getUint32(i * 28 + 24, true);
        if (type === 16) {
          info.reproducible = true;
        } else if (type === 2 && size >= 24 && !info.debug) {
          const head = await reader.view(pointer, 24);
          // "RSDS": the PDB 7.0 record every toolchain of the last two decades writes.
          if (head.getUint32(0, true) === 0x53445352) {
            info.debug = {
              guid: guidAt(head, 4),
              age: head.getUint32(20, true),
              pdbPath: await reader.cstr(pointer + 24, Math.min(size - 24, 1024)),
            };
          }
        }
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
      const head = await reader.view(security.address, 8);
      const length = head.getUint32(0, true);
      const type = head.getUint16(6, true);
      info.signature = { size: security.size };
      // 2 is a PKCS #7 SignedData, which is what Authenticode is.
      if (type === 2 && length > 8) {
        const der = await reader.upTo(
          security.address + 8,
          Math.min(length - 8, MAX_SIGNATURE_BYTES),
        );
        info.signature.signer = readSigner(der);
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

/** Count a NUL-terminated array of import thunks, 4 bytes each in PE32 and 8 in PE32+. */
async function countThunks(reader: Reader, offset: number, plus: boolean): Promise<number> {
  const width = plus ? 8 : 4;
  const chunk = 512;
  let count = 0;
  while (count < MAX_THUNKS) {
    const bytes = await reader.upTo(offset + count * width, chunk * width);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = Math.floor(bytes.length / width);
    if (entries === 0) {
      break;
    }
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
}

async function readImports(
  reader: Reader,
  need: (rva: number) => number,
  offset: number,
  plus: boolean,
): Promise<PeImport[]> {
  const out: PeImport[] = [];
  for (let i = 0; i < MAX_IMPORTS; i++) {
    const entry = await reader.view(offset + i * 20, 20);
    const lookup = entry.getUint32(0, true);
    const name = entry.getUint32(12, true);
    const address = entry.getUint32(16, true);
    if (lookup === 0 && name === 0 && address === 0) {
      break;
    }
    out.push({
      library: await reader.cstr(need(name), 260),
      // The lookup table is the one a bound image leaves untouched; the
      // address table is all an old linker wrote.
      functions: await countThunks(reader, need(lookup || address), plus),
      delayLoaded: false,
    });
  }
  return out;
}

async function readDelayImports(
  reader: Reader,
  need: (rva: number) => number,
  offset: number,
  plus: boolean,
): Promise<PeImport[]> {
  const out: PeImport[] = [];
  for (let i = 0; i < MAX_IMPORTS; i++) {
    const entry = await reader.view(offset + i * 32, 32);
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
    out.push({
      library: await reader.cstr(need(name), 260),
      functions: names === 0 ? 0 : await countThunks(reader, need(names), plus),
      delayLoaded: true,
    });
  }
  return out;
}

async function readExports(
  reader: Reader,
  need: (rva: number) => number,
  offset: number,
): Promise<PeExports> {
  const head = await reader.view(offset, 40);
  const nameRva = head.getUint32(12, true);
  const named = head.getUint32(24, true);
  const namesRva = head.getUint32(32, true);
  const shown = Math.min(named, MAX_EXPORT_NAMES);
  const names: string[] = [];
  if (shown > 0) {
    const pointers = await reader.view(need(namesRva), shown * 4);
    for (let i = 0; i < shown; i++) {
      names.push(await reader.cstr(need(pointers.getUint32(i * 4, true)), 512));
    }
  }
  return {
    name: nameRva === 0 ? '' : await reader.cstr(need(nameRva), 260),
    functions: head.getUint32(20, true),
    named,
    names,
  };
}

// An application manifest is a small XML document. Four facts in it are worth
// a row each, and attribute lookups find them without an XML parser in the
// host bundle; nothing here is used as markup, only shown as text.
function readManifest(bytes: Uint8Array): PeManifest | undefined {
  const xml = new TextDecoder().decode(bytes);
  const attribute = (element: string, name: string): string | undefined => {
    const tag = new RegExp(`<(?:\\w+:)?${element}\\b[^>]{0,2000}>`, 'i').exec(xml)?.[0];
    const value = tag && new RegExp(`\\b${name}\\s*=\\s*(["'])(.{0,200}?)\\1`, 'i').exec(tag)?.[2];
    return value ? printable(value) : undefined;
  };
  const text = (element: string): string | undefined => {
    const value = new RegExp(`<(?:\\w+:)?${element}\\b[^>]{0,500}>([^<]{0,200})</`, 'i').exec(
      xml,
    )?.[1];
    return value?.trim() ? printable(value.trim()) : undefined;
  };
  const name = attribute('assemblyIdentity', 'name');
  const version = attribute('assemblyIdentity', 'version');
  const manifest: PeManifest = {
    executionLevel: attribute('requestedExecutionLevel', 'level'),
    uiAccess: attribute('requestedExecutionLevel', 'uiAccess'),
    dpiAware: text('dpiAwareness') ?? text('dpiAware'),
    identity: name ? (version ? `${name} ${version}` : name) : undefined,
  };
  return Object.values(manifest).some((value) => value !== undefined) ? manifest : undefined;
}
