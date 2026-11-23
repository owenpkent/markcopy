// Reading an OLE compound file (Microsoft's MS-CFB), the container of
// Windows Installer packages and of old Office documents, without loading it.
//
// A compound file is a small file system: 512 or 4096 byte sectors, a table
// (the FAT) saying which sector follows which, and a directory of named
// streams. An installer can be hundreds of megabytes, nearly all of it one
// cabinet stream, so nothing here reads a stream the caller did not ask for.
// The FAT is read one sector at a time as chains are followed.
//
// The file is hostile. Every sector number is checked against the file's size,
// every chain walk is bounded by the number of sectors the file can hold (so a
// cycle ends), and every table has a named cap.
import { ReadError, type RangeReader } from '../binary/reader';

const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEADER_SIZE = 512;
const DIRECTORY_ENTRY = 128;
const MINI_SECTOR = 64;

const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const NO_STREAM = 0xffffffff;

// 32,768 FAT sectors index 4 GiB of 512 byte sectors (32 GiB of 4096 byte
// ones): more than any installer, and a header claiming more is damaged.
const MAX_FAT_SECTORS = 32768;
// The DIFAT lists FAT sectors 127 at a time (1023 with big sectors), so this
// many DIFAT sectors address far more FAT sectors than the cap above.
const MAX_DIFAT_SECTORS = 1024;
// 8192 mini FAT sectors describe 64 MiB of mini stream, and a mini stream
// holds only streams under 4 KiB.
const MAX_MINI_FAT_SECTORS = 8192;
const MAX_MINI_STREAM = 64 * 1024 * 1024;
// 65,536 entries is an 8 MiB directory. An installer has one entry per table,
// icon, binary and cabinet, which is hundreds, or thousands for a big one.
const MAX_DIRECTORY_ENTRIES = 65536;
// How many FAT sectors stay decoded. Chains are mostly sequential, so a few
// are enough, and the bound keeps a scattered chain from holding the FAT.
const FAT_CACHE = 64;
// One read at a time stays well under the reader's own limit.
const RUN_LIMIT = 1024 * 1024;

export const STORAGE = 1;
export const STREAM = 2;
export const ROOT = 5;

export interface CfbEntry {
  /** The name as stored, UTF-16 decoded. Installers mangle theirs; see msi.ts. */
  name: string;
  type: number;
  size: number;
  startSector: number;
}

export interface Cfb {
  rootClsid: string;
  /** The root's direct children, storages included. Nothing deeper is listed. */
  entries: CfbEntry[];
  /** True when the directory held more entries than MarkCopy lists. */
  truncated: boolean;
  /** The stream's bytes, or a ReadError when it is over `maxBytes` or its chain is broken. */
  readStream(entry: CfbEntry, maxBytes: number): Promise<Uint8Array>;
}

function notCompound(): ReadError {
  return new ReadError('it is an OLE compound file, but its header is damaged.');
}

function guid(view: DataView, at: number): string {
  const hex = (n: number, width: number): string =>
    n.toString(16).toUpperCase().padStart(width, '0');
  const tail = [...new Uint8Array(view.buffer, view.byteOffset + at + 8, 8)].map((b) => hex(b, 2));
  return (
    `{${hex(view.getUint32(at, true), 8)}-${hex(view.getUint16(at + 4, true), 4)}-` +
    `${hex(view.getUint16(at + 6, true), 4)}-${tail.slice(0, 2).join('')}-${tail.slice(2).join('')}}`
  );
}

export async function openCfb(reader: RangeReader): Promise<Cfb> {
  const header = await reader.view(0, HEADER_SIZE).catch(() => {
    throw notCompound();
  });
  if (!MAGIC.every((b, i) => header.getUint8(i) === b)) {
    throw new ReadError('it is not an OLE compound file.');
  }
  const major = header.getUint16(0x1a, true);
  const sectorShift = header.getUint16(0x1e, true);
  const miniShift = header.getUint16(0x20, true);
  if (
    header.getUint16(0x1c, true) !== 0xfffe ||
    (major !== 3 && major !== 4) ||
    (sectorShift !== 9 && sectorShift !== 12) ||
    miniShift !== 6
  ) {
    throw notCompound();
  }
  const sectorSize = 1 << sectorShift;
  // Sector 0 starts after the 512 byte header, which for 4096 byte sectors
  // occupies a whole sector of its own, so both cases are (n + 1) sectors in.
  const sectorCount = Math.max(0, Math.ceil(reader.size / sectorSize) - 1);
  const firstDirectory = header.getUint32(0x30, true);
  const miniCutoff = header.getUint32(0x38, true);
  const firstMiniFat = header.getUint32(0x3c, true);
  const miniFatSectors = header.getUint32(0x40, true);
  const firstDifat = header.getUint32(0x44, true);
  const difatSectors = header.getUint32(0x48, true);
  const headerFatSectors = header.getUint32(0x2c, true);
  if (headerFatSectors > MAX_FAT_SECTORS || miniFatSectors > MAX_MINI_FAT_SECTORS) {
    throw new ReadError(
      'it is an OLE compound file, but its tables are larger than MarkCopy reads.',
    );
  }

  const sectorOffset = (n: number): number => (n + 1) * sectorSize;
  const inFile = (n: number): boolean => n < sectorCount;

  // The numbers of the FAT's own sectors: 109 in the header, the rest in the DIFAT chain.
  const fatSectors: number[] = [];
  const addFat = (n: number): void => {
    if (n !== FREE && n !== END_OF_CHAIN && inFile(n) && fatSectors.length < MAX_FAT_SECTORS) {
      fatSectors.push(n);
    }
  };
  for (let i = 0; i < 109; i++) {
    addFat(header.getUint32(0x4c + i * 4, true));
  }
  let difat = firstDifat;
  const perDifat = sectorSize / 4 - 1;
  for (let i = 0; i < Math.min(difatSectors, MAX_DIFAT_SECTORS); i++) {
    if (difat === END_OF_CHAIN || difat === FREE || !inFile(difat)) {
      break;
    }
    const view = await reader.view(sectorOffset(difat), sectorSize);
    for (let j = 0; j < perDifat; j++) {
      addFat(view.getUint32(j * 4, true));
    }
    difat = view.getUint32(perDifat * 4, true);
  }

  const fatCache = new Map<number, DataView>();
  const perFat = sectorSize / 4;
  async function next(sector: number): Promise<number> {
    const index = Math.floor(sector / perFat);
    if (index >= fatSectors.length) {
      throw new ReadError('an OLE compound file chain points outside its allocation table.');
    }
    let view = fatCache.get(index);
    if (!view) {
      if (fatCache.size >= FAT_CACHE) {
        fatCache.clear();
      }
      view = await reader.view(sectorOffset(fatSectors[index]), sectorSize);
      fatCache.set(index, view);
    }
    return view.getUint32((sector % perFat) * 4, true);
  }

  /** The first `count` sectors of a chain, or fewer when it ends. A chain longer than the file is a cycle. */
  async function chain(start: number, count: number): Promise<number[]> {
    const out: number[] = [];
    let at = start;
    const limit = Math.min(count, sectorCount);
    while (at !== END_OF_CHAIN && out.length < limit) {
      if (!inFile(at)) {
        throw new ReadError(
          'an OLE compound file chain points outside the file, or the file is cut short.',
        );
      }
      out.push(at);
      at = await next(at);
    }
    if (at !== END_OF_CHAIN && out.length >= sectorCount && out.length < count) {
      throw new ReadError('an OLE compound file chain loops back on itself.');
    }
    return out;
  }

  /** Read pieces of `pieceSize` bytes at the given file offsets, joining neighbours into one read. */
  async function gather(offsets: number[], pieceSize: number, size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    let done = 0;
    let i = 0;
    while (i < offsets.length && done < size) {
      let run = 1;
      while (
        i + run < offsets.length &&
        offsets[i + run] === offsets[i] + run * pieceSize &&
        (run + 1) * pieceSize <= RUN_LIMIT
      ) {
        run++;
      }
      const take = Math.min(run * pieceSize, size - done);
      out.set(await reader.bytes(offsets[i], take), done);
      done += take;
      i += run;
    }
    if (done < size) {
      throw new ReadError('an OLE compound file stream ends before its declared size.');
    }
    return out;
  }

  async function readChain(start: number, size: number): Promise<Uint8Array> {
    const sectors = await chain(start, Math.ceil(size / sectorSize));
    return gather(sectors.map(sectorOffset), sectorSize, size);
  }

  // The directory: a chain of sectors of 128 byte entries.
  const directoryBytes = await (async () => {
    const maxSectors = Math.ceil((MAX_DIRECTORY_ENTRIES * DIRECTORY_ENTRY) / sectorSize);
    const sectors = await chain(firstDirectory, maxSectors);
    if (sectors.length === 0) {
      throw notCompound();
    }
    return gather(sectors.map(sectorOffset), sectorSize, sectors.length * sectorSize);
  })();
  const directory = new DataView(
    directoryBytes.buffer,
    directoryBytes.byteOffset,
    directoryBytes.byteLength,
  );
  const directoryCount = Math.min(directory.byteLength / DIRECTORY_ENTRY, MAX_DIRECTORY_ENTRIES);

  const parse = (
    id: number,
  ): (CfbEntry & { left: number; right: number; child: number }) | undefined => {
    if (id >= directoryCount) {
      return undefined;
    }
    const at = id * DIRECTORY_ENTRY;
    const type = directory.getUint8(at + 66);
    if (type !== STORAGE && type !== STREAM && type !== ROOT) {
      return undefined;
    }
    // The stored length counts the terminating NUL, in bytes, and the field is 64 bytes wide.
    const nameBytes = Math.max(0, Math.min(directory.getUint16(at + 64, true), 64) - 2);
    let name = '';
    for (let i = 0; i < nameBytes; i += 2) {
      name += String.fromCharCode(directory.getUint16(at + i, true));
    }
    const low = directory.getUint32(at + 120, true);
    // Version 3 files must ignore the high word: writers leave junk in it.
    const high = major === 4 ? directory.getUint32(at + 124, true) : 0;
    return {
      name,
      type,
      size: high * 4294967296 + low,
      startSector: directory.getUint32(at + 116, true),
      left: directory.getUint32(at + 68, true),
      right: directory.getUint32(at + 72, true),
      child: directory.getUint32(at + 76, true),
    };
  };

  const root = parse(0);
  if (!root || root.type !== ROOT) {
    throw notCompound();
  }
  const rootClsid = guid(directory, 80);

  // Walk the root's children as a tree, with a visited set: a red-black tree
  // is acyclic, a hostile one need not be.
  const entries: CfbEntry[] = [];
  const seen = new Set<number>([0]);
  const pending: number[] = root.child === NO_STREAM ? [] : [root.child];
  let truncated = false;
  while (pending.length > 0) {
    const id = pending.pop() as number;
    if (id >= directoryCount || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const entry = parse(id);
    if (!entry) {
      continue;
    }
    entries.push({
      name: entry.name,
      type: entry.type,
      size: entry.size,
      startSector: entry.startSector,
    });
    if (entry.left !== NO_STREAM) {
      pending.push(entry.left);
    }
    if (entry.right !== NO_STREAM) {
      pending.push(entry.right);
    }
  }
  // The chain read stops at the cap, so a full directory may have had more.
  if (directory.byteLength / DIRECTORY_ENTRY >= MAX_DIRECTORY_ENTRIES) {
    truncated = true;
  }

  // The mini FAT and the mini stream (the root's own chain) are only needed
  // for streams under the cutoff, so they are read on first use.
  let miniFat: DataView | undefined;
  let miniStream: number[] | undefined;
  async function readMini(start: number, size: number): Promise<Uint8Array> {
    if (!miniFat) {
      const sectors = await chain(firstMiniFat, miniFatSectors);
      const bytes = await gather(
        sectors.map(sectorOffset),
        sectorSize,
        sectors.length * sectorSize,
      );
      miniFat = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (!miniStream) {
      const length = Math.min(root!.size, MAX_MINI_STREAM);
      miniStream = await chain(root!.startSector, Math.ceil(length / sectorSize));
    }
    const needed = Math.ceil(size / MINI_SECTOR);
    const offsets: number[] = [];
    let at = start;
    while (at !== END_OF_CHAIN && offsets.length < needed) {
      if (at * 4 + 4 > miniFat.byteLength) {
        throw new ReadError(
          'an OLE compound file mini stream points outside its allocation table.',
        );
      }
      const inStream = Math.floor((at * MINI_SECTOR) / sectorSize);
      if (inStream >= miniStream.length) {
        throw new ReadError('an OLE compound file mini stream points outside the file.');
      }
      offsets.push(sectorOffset(miniStream[inStream]) + ((at * MINI_SECTOR) % sectorSize));
      at = miniFat.getUint32(at * 4, true);
    }
    return gather(offsets, MINI_SECTOR, size);
  }

  return {
    rootClsid,
    entries,
    truncated,
    async readStream(entry, maxBytes) {
      if (entry.type !== STREAM) {
        throw new ReadError('an OLE compound file entry is not a stream.');
      }
      if (entry.size > maxBytes) {
        throw new ReadError('an OLE compound file stream is larger than MarkCopy reads.');
      }
      if (entry.size === 0) {
        return new Uint8Array(0);
      }
      return entry.size < miniCutoff
        ? readMini(entry.startSector, entry.size)
        : readChain(entry.startSector, entry.size);
    },
  };
}
