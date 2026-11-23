// Building OLE compound files as exact bytes.
//
// Written from Microsoft's [MS-CFB] specification, not from src/pkg/cfb.ts.
// Layout: header, then sectors in this order: big streams, the mini stream,
// the mini FAT, the directory, the FAT, and DIFAT sectors when the FAT is
// listed in more than the header's 109 slots.

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const NO_STREAM = 0xffffffff;

export interface CfbStream {
  /** The name exactly as stored in the directory (UTF-16 code units). */
  name: string;
  data: Uint8Array;
}

export interface CfbSpec {
  /** The root storage's CLSID as 16 raw bytes in file order. */
  clsid?: Uint8Array;
  streams?: CfbStream[];
  /** Empty storages directly under the root. */
  storages?: string[];
  /** 9 (512 byte sectors, version 3) or 12 (4096 byte sectors, version 4). */
  sectorShift?: 9 | 12;
  /** Streams smaller than this live in the mini stream. */
  miniCutoff?: number;
}

/** A GUID in registry form ("{000C1084-0000-0000-C000-000000000046}") as the 16 bytes a file stores. */
export function guidBytes(text: string): Uint8Array {
  const hex = text.replace(/[{}-]/g, '');
  const b = Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
  // The first three groups are little-endian.
  return Uint8Array.from([b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.subarray(8, 16)]);
}

class Writer {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
}

function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}

export function buildCfb(spec: CfbSpec = {}): Uint8Array {
  const shift = spec.sectorShift ?? 9;
  const size = 1 << shift;
  const per = size / 4;
  const cutoff = spec.miniCutoff ?? 4096;
  const streams = spec.streams ?? [];
  const storages = spec.storages ?? [];

  const fat: number[] = [];
  const contents = new Map<number, Uint8Array>();
  /** Reserve `count` consecutive sectors chained to each other; returns the first (END when 0). */
  const chainOf = (count: number): number => {
    if (count === 0) {
      return END;
    }
    const first = fat.length;
    for (let i = 0; i < count; i++) {
      fat.push(i === count - 1 ? END : first + i + 1);
    }
    return first;
  };
  const place = (first: number, data: Uint8Array): void => {
    for (let i = 0; i * size < data.length; i++) {
      contents.set(first + i, data.subarray(i * size, (i + 1) * size));
    }
  };

  const starts: number[] = [];
  const small: { index: number; data: Uint8Array }[] = [];
  streams.forEach((s, index) => {
    if (s.data.length >= cutoff) {
      const first = chainOf(ceilDiv(s.data.length, size));
      place(first, s.data);
      starts[index] = first;
    } else {
      small.push({ index, data: s.data });
    }
  });

  // The mini stream: every small stream in 64 byte mini sectors, chained in the mini FAT.
  const miniFat: number[] = [];
  const mini: number[] = [];
  for (const { index, data } of small) {
    const count = ceilDiv(data.length, 64);
    if (count === 0) {
      starts[index] = END;
      continue;
    }
    const first = miniFat.length;
    for (let i = 0; i < count; i++) {
      miniFat.push(i === count - 1 ? END : first + i + 1);
    }
    starts[index] = first;
    for (let i = 0; i < count * 64; i++) {
      mini.push(i < data.length ? data[i] : 0);
    }
  }
  const miniBytes = Uint8Array.from(mini);
  const miniStart = chainOf(ceilDiv(miniBytes.length, size));
  place(miniStart, miniBytes);

  const miniFatBytes = new Uint8Array(ceilDiv(miniFat.length, per) * size).fill(0xff);
  const miniFatView = new DataView(miniFatBytes.buffer);
  miniFat.forEach((v, i) => miniFatView.setUint32(i * 4, v, true));
  const miniFatStart = chainOf(ceilDiv(miniFatBytes.length, size));
  place(miniFatStart, miniFatBytes);

  // The directory: root, then the children as a right-leaning chain of siblings.
  const names = [...streams.map((s) => s.name), ...storages];
  const total = 1 + names.length;
  const directorySectors = ceilDiv(total * 128, size);
  const dir = new Writer(directorySectors * size);
  const entry = (
    id: number,
    name: string,
    type: number,
    left: number,
    right: number,
    child: number,
    start: number,
    length: number,
    clsid?: Uint8Array,
  ): void => {
    const at = id * 128;
    for (let i = 0; i < name.length; i++) {
      dir.view.setUint16(at + i * 2, name.charCodeAt(i), true);
    }
    dir.view.setUint16(at + 64, name.length * 2 + 2, true);
    dir.bytes[at + 66] = type;
    dir.bytes[at + 67] = 1;
    dir.view.setUint32(at + 68, left, true);
    dir.view.setUint32(at + 72, right, true);
    dir.view.setUint32(at + 76, child, true);
    if (clsid) {
      dir.bytes.set(clsid, at + 80);
    }
    dir.view.setUint32(at + 116, start, true);
    dir.view.setUint32(at + 120, length, true);
  };
  entry(
    0,
    'Root Entry',
    5,
    NO_STREAM,
    NO_STREAM,
    names.length > 0 ? 1 : NO_STREAM,
    miniStart,
    miniBytes.length,
    spec.clsid,
  );
  names.forEach((name, i) => {
    const id = i + 1;
    const right = id < names.length ? id + 1 : NO_STREAM;
    if (i < streams.length) {
      entry(id, name, 2, NO_STREAM, right, NO_STREAM, starts[i], streams[i].data.length);
    } else {
      entry(id, name, 1, NO_STREAM, right, NO_STREAM, 0, 0);
    }
  });
  // Unused entries are free (type 0) with NOSTREAM links.
  for (let id = total; id * 128 < dir.bytes.length; id++) {
    dir.view.setUint32(id * 128 + 68, NO_STREAM, true);
    dir.view.setUint32(id * 128 + 72, NO_STREAM, true);
    dir.view.setUint32(id * 128 + 76, NO_STREAM, true);
  }
  const directoryStart = chainOf(directorySectors);
  place(directoryStart, dir.bytes);

  // The FAT describes itself, so find how many FAT and DIFAT sectors it needs.
  const used = fat.length;
  let fatCount = 1;
  let difatCount = 0;
  for (;;) {
    const need = ceilDiv(used + fatCount + difatCount, per);
    const difatNeed = need > 109 ? ceilDiv(need - 109, per - 1) : 0;
    if (need === fatCount && difatNeed === difatCount) {
      break;
    }
    fatCount = need;
    difatCount = difatNeed;
  }
  const fatFirst = fat.length;
  for (let i = 0; i < fatCount; i++) {
    fat.push(FAT_SECTOR);
  }
  const difatFirst = fat.length;
  for (let i = 0; i < difatCount; i++) {
    fat.push(DIFAT_SECTOR);
  }

  const sectors = fat.length;
  const out = new Writer(size + sectors * size);
  // Header.
  out.bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  out.view.setUint16(0x18, 0x3e, true);
  out.view.setUint16(0x1a, shift === 9 ? 3 : 4, true);
  out.view.setUint16(0x1c, 0xfffe, true);
  out.view.setUint16(0x1e, shift, true);
  out.view.setUint16(0x20, 6, true);
  out.view.setUint32(0x28, shift === 9 ? 0 : directorySectors, true);
  out.view.setUint32(0x2c, fatCount, true);
  out.view.setUint32(0x30, directoryStart, true);
  out.view.setUint32(0x38, cutoff, true);
  out.view.setUint32(0x3c, miniFatBytes.length > 0 ? miniFatStart : END, true);
  out.view.setUint32(0x40, miniFatBytes.length / size, true);
  out.view.setUint32(0x44, difatCount > 0 ? difatFirst : END, true);
  out.view.setUint32(0x48, difatCount, true);
  for (let i = 0; i < 109; i++) {
    out.view.setUint32(0x4c + i * 4, i < fatCount ? fatFirst + i : FREE, true);
  }
  // FAT sectors.
  const fatBytes = new Uint8Array(fatCount * size).fill(0xff);
  const fatView = new DataView(fatBytes.buffer);
  fat.forEach((v, i) => fatView.setUint32(i * 4, v, true));
  for (let i = 0; i < fatCount; i++) {
    contents.set(fatFirst + i, fatBytes.subarray(i * size, (i + 1) * size));
  }
  // DIFAT sectors list the FAT sectors after the 109th.
  for (let d = 0; d < difatCount; d++) {
    const bytes = new Uint8Array(size).fill(0xff);
    const view = new DataView(bytes.buffer);
    for (let j = 0; j < per - 1; j++) {
      const n = 109 + d * (per - 1) + j;
      if (n < fatCount) {
        view.setUint32(j * 4, fatFirst + n, true);
      }
    }
    view.setUint32((per - 1) * 4, d + 1 < difatCount ? difatFirst + d + 1 : END, true);
    contents.set(difatFirst + d, bytes);
  }
  for (const [sector, data] of contents) {
    out.bytes.set(data, (sector + 1) * size);
  }
  return out.bytes;
}
