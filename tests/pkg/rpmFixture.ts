// Building RPM packages as exact bytes.
//
// Written from the RPM file format (the lead, the header structure and the tag
// numbers of rpm's rpmtag.h and rpmlib's "Packaging" documentation), not from
// src/pkg/rpm.ts. Layout: 96-byte lead, signature header padded to 8 bytes,
// main header (not padded), payload. Every header is: magic 8E AD E8 01, four
// reserved bytes, index count, store size, 16-byte index entries (tag, type,
// offset, count; sorted by tag), then the store, in which 16-bit values sit on
// even offsets, 32-bit on multiples of 4 and 64-bit on multiples of 8.

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

export const TYPE = {
  INT8: 2,
  INT16: 3,
  INT32: 4,
  INT64: 5,
  STRING: 6,
  BIN: 7,
  STRING_ARRAY: 8,
  I18N: 9,
} as const;

export type TagValue = string | string[] | number[] | bigint[] | Uint8Array;
export interface Tag {
  tag: number;
  type: number;
  value: TagValue;
}

export const str = (tag: number, value: string): Tag => ({ tag, type: TYPE.STRING, value });
export const i18n = (tag: number, value: string): Tag => ({ tag, type: TYPE.I18N, value });
export const strings = (tag: number, value: string[]): Tag => ({
  tag,
  type: TYPE.STRING_ARRAY,
  value,
});
export const int32 = (tag: number, ...value: number[]): Tag => ({
  tag,
  type: TYPE.INT32,
  value,
});
export const int16 = (tag: number, ...value: number[]): Tag => ({
  tag,
  type: TYPE.INT16,
  value,
});
export const int64 = (tag: number, ...value: bigint[]): Tag => ({
  tag,
  type: TYPE.INT64,
  value,
});
export const bin = (tag: number, value: Uint8Array): Tag => ({ tag, type: TYPE.BIN, value });

/** Append without spreading: a spread of a megabyte exceeds the argument limit. */
function put(into: number[], items: ArrayLike<number>): void {
  for (let i = 0; i < items.length; i++) {
    into.push(items[i]);
  }
}

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

export interface HeaderOptions {
  /** Overrides, to describe a lie. */
  indexCount?: number;
  storeSize?: number;
  magic?: number[];
}

/** One header: structure plus store. */
export function header(tags: Tag[], options: HeaderOptions = {}): Uint8Array {
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  const store: number[] = [];
  const index: number[] = [];
  const align = (to: number): void => {
    while (store.length % to !== 0) {
      store.push(0);
    }
  };
  for (const { tag, type, value } of sorted) {
    let count = 1;
    if (type === TYPE.INT16) {
      align(2);
    } else if (type === TYPE.INT32) {
      align(4);
    } else if (type === TYPE.INT64) {
      align(8);
    }
    const offset = store.length;
    if (type === TYPE.STRING || type === TYPE.I18N) {
      put(store, ascii(value as string));
      store.push(0);
    } else if (type === TYPE.STRING_ARRAY) {
      count = (value as string[]).length;
      for (const item of value as string[]) {
        put(store, ascii(item));
        store.push(0);
      }
    } else if (type === TYPE.BIN) {
      count = (value as Uint8Array).length;
      put(store, value as Uint8Array);
    } else if (type === TYPE.INT16) {
      count = (value as number[]).length;
      for (const item of value as number[]) {
        store.push((item >> 8) & 255, item & 255);
      }
    } else if (type === TYPE.INT32) {
      count = (value as number[]).length;
      for (const item of value as number[]) {
        store.push(...u32(item));
      }
    } else if (type === TYPE.INT64) {
      count = (value as bigint[]).length;
      for (const item of value as bigint[]) {
        store.push(...u32(Number(item >> 32n)), ...u32(Number(item & 0xffffffffn)));
      }
    }
    index.push(...u32(tag), ...u32(type), ...u32(offset), ...u32(count));
  }
  return Uint8Array.from([
    ...(options.magic ?? [0x8e, 0xad, 0xe8, 0x01]),
    0,
    0,
    0,
    0,
    ...u32(options.indexCount ?? sorted.length),
    ...u32(options.storeSize ?? store.length),
    ...index,
    ...store,
  ]);
}

/** The lead: magic, version, type (0 binary, 1 source), architecture number, name, OS number, signature type. */
export function lead(type = 0, name = 'pkg-1.0-1'): Uint8Array {
  const out = new Uint8Array(96);
  out.set([0xed, 0xab, 0xee, 0xdb, 3, 0, 0, type, 0, 1]);
  out.set(ascii(name).subarray(0, 65), 10);
  out.set([0, 1, 0, 5], 76);
  return out;
}

// --- OpenPGP signature packets (RFC 4880) -------------------------------------

export const KEY_ID = [0x82, 0x9b, 0x60, 0x66, 0x31, 0x64, 0x55, 0x31];
export const KEY_ID_HEX = '829b606631645531';

/** A new-format version 4 signature packet with the issuer subpacket in the unhashed area. */
export function pgpSignatureV4(algorithm = 1, keyId = KEY_ID): Uint8Array {
  const body = [
    4,
    0,
    algorithm,
    8,
    0,
    6,
    5,
    2,
    0x65,
    0,
    0,
    0, // hashed area: signature creation time
    0,
    10,
    9,
    16,
    ...keyId, // unhashed area: issuer key ID
    0xab,
    0xcd, // left 16 bits of the hash
    0,
    8,
    0xff, // an MPI
  ];
  return Uint8Array.from([0xc2, body.length, ...body]);
}

/** A new-format version 6 signature packet (RFC 9580) naming its issuer by fingerprint. */
export function pgpSignatureV6(algorithm = 22, keyId = KEY_ID): Uint8Array {
  const fingerprint = [...keyId, ...new Array<number>(24).fill(0x11)]; // v6: key ID is the first 8 bytes
  const unhashed = [34, 33, 6, ...fingerprint];
  const body = [
    6,
    0,
    algorithm,
    8,
    0,
    0,
    0,
    0, // hashed subpacket area: empty
    0,
    0,
    0,
    unhashed.length,
    ...unhashed,
    0xab,
    0xcd,
    0,
    0, // left 16 bits of the hash, salt length 0
  ];
  return Uint8Array.from([0xc2, body.length, ...body]);
}

/** An old-format version 3 signature packet. */
export function pgpSignatureV3(algorithm = 17, keyId = KEY_ID): Uint8Array {
  const body = [3, 5, 0, 0, 0, 0, 1, ...keyId, algorithm, 2, 0xab, 0xcd, 0, 8, 0xff];
  return Uint8Array.from([0x88, body.length, ...body]);
}

// --- Package ---------------------------------------------------------------

export interface RpmFile {
  dir: string;
  name: string;
  size: number;
  /** st_mode; a directory is 0o040755. */
  mode?: number;
}

export interface RpmSpec {
  leadType?: number;
  /** Tags that replace or add to the defaults of the main header. */
  main?: Tag[];
  /** Tags that replace or add to the defaults of the signature header. */
  signature?: Tag[];
  /** Tags removed from the defaults. */
  without?: number[];
  files?: RpmFile[];
  payload?: Uint8Array;
  mainOptions?: HeaderOptions;
  signatureOptions?: HeaderOptions;
}

export const BUILD_TIME = 1700000000; // 2023-11-14 22:13:20 UTC

export const defaultMain = (files: RpmFile[]): Tag[] => {
  const dirs = [...new Set(files.map((f) => f.dir))];
  return [
    str(1000, 'curl'),
    str(1001, '8.5.0'),
    str(1002, '2.fc40'),
    int32(1003, 1),
    i18n(1004, 'A tool for transferring data'),
    i18n(1005, 'curl is a tool.\n\nSecond paragraph with a <img src=x onerror=1> tag.'),
    int32(1006, BUILD_TIME),
    str(1007, 'builder.example.org'),
    int32(1009, 4096),
    str(1010, 'Example Distribution'),
    str(1011, 'Example Vendor'),
    str(1014, 'curl'),
    str(1015, 'Example Packager'),
    str(1016, 'Applications/Internet'),
    str(1020, 'https://curl.example/'),
    str(1021, 'linux'),
    str(1022, 'x86_64'),
    str(1044, 'curl-8.5.0-2.fc40.src.rpm'),
    str(1124, 'cpio'),
    str(1125, 'zstd'),
    str(1126, '19'),
    // Requires: an rpmlib entry (flag bit 24) that is hidden, one by name, a versioned one.
    strings(1049, [
      'rpmlib(PayloadIsZstd)',
      'rpmlib(CompressedFileNames)',
      'libc.so.6()(64bit)',
      'glibc',
      'zlib',
    ]),
    int32(1048, 0x1000000 | 0x0e, 0x1000000 | 0x0e, 0, 0x0c, 0x04),
    strings(1050, ['5.4.18-1', '3.0.4-1', '', '2.34', '1.2']),
    strings(1047, ['curl', 'curl(x86-64)']),
    int32(1112, 0x08, 0x08),
    strings(1113, ['8.5.0-2.fc40', '8.5.0-2.fc40']),
    strings(1054, ['curl-old']),
    int32(1053, 0x02),
    strings(1055, ['7.0']),
    strings(1090, ['curl-legacy']),
    int32(1114, 0x0a),
    strings(1115, ['6.0']),
    strings(5046, ['ca-certificates']),
    int32(5048, 0),
    strings(5047, ['']),
    strings(5049, ['curl-doc']),
    int32(5051, 0x08),
    strings(5050, ['8.5.0']),
    str(1023, 'echo pre'),
    str(1024, '/sbin/ldconfig'),
    str(1026, '/sbin/ldconfig'),
    str(1152, 'echo done'),
    ...(files.length > 0
      ? [
          strings(
            1117,
            files.map((f) => f.name),
          ),
          int32(1116, ...files.map((f) => dirs.indexOf(f.dir))),
          strings(1118, dirs),
          int32(1028, ...files.map((f) => f.size)),
          int16(1030, ...files.map((f) => f.mode ?? 0o100644)),
        ]
      : []),
  ];
};

export const defaultSignature = (): Tag[] => [
  int32(1000, 12345),
  bin(268, pgpSignatureV4()),
  str(273, 'a'.repeat(64)),
  int32(1007, 99999),
];

function merge(defaults: Tag[], changes: Tag[] = [], without: number[] = []): Tag[] {
  const replaced = new Set(changes.map((t) => t.tag));
  return [...defaults.filter((t) => !replaced.has(t.tag) && !without.includes(t.tag)), ...changes];
}

export const DEFAULT_FILES: RpmFile[] = [
  { dir: '/usr/bin/', name: 'curl', size: 250000 },
  { dir: '/usr/share/doc/curl/', name: 'README', size: 1200 },
  { dir: '/usr/share/doc/curl/', name: '', size: 4096, mode: 0o040755 },
];

export function buildRpm(spec: RpmSpec = {}): Uint8Array {
  const sigHeader = header(
    merge(defaultSignature(), spec.signature, spec.without),
    spec.signatureOptions,
  );
  const padding = new Uint8Array((8 - (sigHeader.length % 8)) % 8);
  const main = header(
    merge(defaultMain(spec.files ?? DEFAULT_FILES), spec.main, spec.without),
    spec.mainOptions,
  );
  const parts = [
    lead(spec.leadType),
    sigHeader,
    padding,
    main,
    spec.payload ?? new Uint8Array(500),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
