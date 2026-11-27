// Building Go build information blocks as exact bytes.
//
// Written from Go's src/debug/buildinfo/buildinfo.go (the 32-byte header, the
// inline varint strings of Go 1.18 and later, the pointer form before it, and
// the 16-byte sentinels around the module text), not from src/binary/goBuildInfo.ts.

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const MAGIC = Uint8Array.from([
  0xff, 0x20, 0x47, 0x6f, 0x20, 0x62, 0x75, 0x69, 0x6c, 0x64, 0x69, 0x6e, 0x66, 0x3a,
]);

/** Sixteen bytes on each side of the module text. Their values are not read. */
export const START = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
export const END = Uint8Array.from({ length: 16 }, (_, i) => 0xc0 + i);

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** LEB128, as Go's binary.PutUvarint writes it. */
export function uvarintBytes(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

/** The module text: lines, each ended by a newline, between 16-byte sentinels. */
export function modinfo(lines: string[], sentinels = true): Uint8Array {
  const text = utf8(lines.map((l) => `${l}\n`).join(''));
  return sentinels ? concat(START, text, END) : text;
}

export interface BlockSpec {
  version?: string;
  /** The module text as bytes, or lines to wrap in sentinels. */
  info?: Uint8Array | string[];
  /** Pointer width in bytes. 8 unless given. */
  pointerSize?: number;
  big?: boolean;
  /** Declare this length for the module text, whatever it holds. */
  declaredInfoLength?: number;
}

const infoBytes = (spec: BlockSpec): Uint8Array =>
  spec.info === undefined
    ? new Uint8Array(0)
    : Array.isArray(spec.info)
      ? modinfo(spec.info)
      : spec.info;

function header(spec: BlockSpec, inline: boolean): Uint8Array {
  const out = new Uint8Array(32);
  out.set(MAGIC);
  out[14] = spec.pointerSize ?? 8;
  out[15] = (spec.big ? 1 : 0) | (inline ? 2 : 0);
  return out;
}

/** Go 1.18 and later: the header, then each string as a varint length and its bytes. */
export function inlineBlock(spec: BlockSpec = {}): Uint8Array {
  const version = utf8(spec.version ?? 'go1.22.1');
  const info = infoBytes(spec);
  return concat(
    header(spec, true),
    uvarintBytes(version.length),
    version,
    uvarintBytes(spec.declaredInfoLength ?? info.length),
    info,
  );
}

/**
 * Go 1.17 and earlier: the header holds two pointers to string headers. The
 * result is a function of the virtual address the block starts at, because the
 * pointers are addresses.
 */
export function pointerBlock(spec: BlockSpec = {}): (vaddr: number) => Uint8Array {
  return (vaddr) => {
    const width = spec.pointerSize ?? 8;
    const le = !spec.big;
    const word = (value: number): Uint8Array => {
      const out = new Uint8Array(width);
      const view = new DataView(out.buffer);
      if (width === 8) {
        view.setBigUint64(0, BigInt(value), le);
      } else {
        view.setUint32(0, value, le);
      }
      return out;
    };
    const version = utf8(spec.version ?? 'go1.16.5');
    const info = infoBytes(spec);
    const headers = vaddr + 32;
    const data = headers + 4 * width;
    const head = header(spec, false);
    head.set(word(headers), 16);
    head.set(word(headers + 2 * width), 16 + width);
    return concat(
      head,
      word(data),
      word(version.length),
      word(data + version.length),
      word(spec.declaredInfoLength ?? info.length),
      version,
      info,
    );
  };
}

/** A realistic module list for a program with a replaced dependency. */
export const SAMPLE_LINES = [
  'path\texample.com/app/cmd/app',
  'mod\texample.com/app\tv1.4.0\th1:abc=',
  'dep\tgithub.com/spf13/cobra\tv1.8.0\th1:def=',
  'dep\tgolang.org/x/sys\tv0.15.0\th1:ghi=',
  '=>\texample.com/fork-sys\tv0.15.1\th1:jkl=',
  'build\t-buildmode=exe',
  'build\t-compiler=gc',
  'build\t-trimpath=true',
  'build\tCGO_ENABLED=0',
  'build\tGOARCH=amd64',
  'build\tGOOS=linux',
];
