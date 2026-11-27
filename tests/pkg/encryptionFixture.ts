// Exact bytes for the encryption-label readers, built from each format's
// specification (7zFormat.txt, the RAR 5 and RAR 4 technotes, RFC 4880 and
// RFC 9580, the age and KeePass and LUKS descriptions, RFC 7292 and RFC 8018),
// not from the readers in src/pkg. Salts and IVs are filled with a marker
// byte, so a test can check that none of it reaches a result.
import { bytesSource, RangeReader } from '../../src/binary/reader';

/** The marker that stands in for every salt, IV, nonce and wrapped key. */
export const SECRET = 0xab;
export const secret = (n: number): number[] => new Array<number>(n).fill(SECRET);

export const enc = (s: string): number[] => [...new TextEncoder().encode(s)];
export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export const reader = (bytes: Uint8Array, limits = {}): RangeReader =>
  new RangeReader(bytesSource(bytes), limits);
export const u16be = (n: number): number[] => [(n >> 8) & 255, n & 255];
export const u32be = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >> 16) & 255,
  (n >> 8) & 255,
  n & 255,
];
export const u16le = (n: number): number[] => [n & 255, (n >> 8) & 255];
export const u32le = (n: number): number[] => [
  n & 255,
  (n >> 8) & 255,
  (n >> 16) & 255,
  (n >>> 24) & 255,
];
export const u64le = (n: number): number[] => [
  ...u32le(n % 2 ** 32),
  ...u32le(Math.floor(n / 2 ** 32)),
];
export const u64be = (n: number): number[] => [
  ...u32be(Math.floor(n / 2 ** 32)),
  ...u32be(n % 2 ** 32),
];
export const hex = (s: string): number[] => (s.match(/../g) ?? []).map((h) => parseInt(h, 16));

// ---- 7z ----

export interface SzCoder {
  id: string;
  /** First property byte of an AES coder (NumCyclesPower, plus salt and IV size bits). */
  props?: number[];
}

/** 7-Zip's number encoding, for values below 2^14. */
export const sz = (n: number): number[] => (n < 0x80 ? [n] : [0x80 | (n >> 8), n & 255]);

function szFolder(coders: SzCoder[]): number[] {
  const out = [...sz(coders.length)];
  for (const c of coders) {
    const id = hex(c.id);
    out.push(id.length | (c.props ? 0x20 : 0), ...id);
    if (c.props) {
      out.push(...sz(c.props.length), ...c.props);
    }
  }
  // One bind pair per extra coder, each joining the previous coder's output to the next input.
  for (let i = 1; i < coders.length; i++) {
    out.push(...sz(i), ...sz(i - 1));
  }
  return out;
}

/** A StreamsInfo: pack info, then unpack info with the folders. */
export function szStreams(folders: SzCoder[][], declared = folders.length): number[] {
  return [
    0x06,
    ...sz(0),
    ...sz(declared),
    0x09,
    ...new Array<number>(declared).fill(10),
    0x00,
    0x07,
    0x0b,
    ...sz(declared),
    0x00,
    ...folders.map(szFolder).flat(),
    0x0c,
    ...folders.map((f) => f.map(() => sz(20)).flat()).flat(),
    0x00,
    0x00,
  ];
}

export const AES_CODER = (power = 19): SzCoder => ({
  id: '06f10701',
  props: [0xc0 | power, 0x0f, ...secret(16), ...secret(16)],
});
export const LZMA: SzCoder = { id: '030101', props: [0x5d, 0, 0, 0x10, 0] };

export function build7z(
  nextHeader: number[],
  options: { declaredSize?: number; offset?: number } = {},
): Uint8Array {
  const packed = secret(10);
  return concat(
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4],
    u32le(0),
    u64le(options.offset ?? packed.length),
    u64le(options.declaredSize ?? nextHeader.length),
    u32le(0),
    packed,
    nextHeader,
  );
}
export const sevenZipPlain = (folders: SzCoder[][], declared?: number): Uint8Array =>
  build7z([0x01, 0x04, ...szStreams(folders, declared), 0x05, 0x00, 0x00]);
export const sevenZipEncoded = (folders: SzCoder[][]): Uint8Array =>
  build7z([0x17, ...szStreams(folders)]);

// ---- RAR ----

export function vint(n: number): number[] {
  const out: number[] = [];
  do {
    const low = n % 128;
    n = Math.floor(n / 128);
    out.push(n > 0 ? low | 0x80 : low);
  } while (n > 0);
  return out;
}
const RAR5_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
export function rar5Block(
  type: number,
  body: number[],
  extra: number[] = [],
  data: number[] = [],
): number[] {
  const flags = (extra.length ? 1 : 0) | (data.length ? 2 : 0);
  const header = [
    ...vint(type),
    ...vint(flags),
    ...(extra.length ? vint(extra.length) : []),
    ...(data.length ? vint(data.length) : []),
    ...body,
    ...extra,
  ];
  return [0, 0, 0, 0, ...vint(header.length), ...header, ...data];
}
export const rar5Main = (): number[] => rar5Block(1, vint(0));
export const rar5End = (): number[] => rar5Block(5, vint(0));
export const rar5EncryptionHeader = (kdf = 15, version = 0): number[] =>
  rar5Block(4, [...vint(version), ...vint(1), kdf, ...secret(16), ...secret(12)]);
export function rar5File(name: string, encrypted?: { kdf?: number; version?: number }): number[] {
  const extra = encrypted
    ? (() => {
        const record = [
          ...vint(1),
          ...vint(encrypted.version ?? 0),
          ...vint(1),
          encrypted.kdf ?? 15,
          ...secret(16),
          ...secret(16),
          ...secret(12),
        ];
        return [...vint(record.length), ...record];
      })()
    : [];
  const body = [
    ...vint(0),
    ...vint(5),
    ...vint(0x20),
    ...vint(0),
    ...vint(0),
    ...vint(name.length),
    ...enc(name),
  ];
  return rar5Block(2, body, extra, secret(8));
}
export const rar5 = (...blocks: number[][]): Uint8Array => concat(RAR5_SIG, ...blocks);

const RAR4_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
export function rar4Main(passwordHeaders = false): number[] {
  return [0, 0, 0x73, ...u16le(passwordHeaders ? 0x0080 : 0), ...u16le(13), 0, 0, 0, 0, 0, 0];
}
export function rar4File(name: string, encrypted = false, unpVer = 29): number[] {
  const body = [
    ...u32le(8),
    ...u32le(8),
    2,
    ...u32le(0),
    ...u32le(0),
    unpVer,
    0x33,
    ...u16le(name.length),
    ...u32le(0),
    ...enc(name),
  ];
  return [
    0,
    0,
    0x74,
    ...u16le(0x8000 | (encrypted ? 0x04 : 0)),
    ...u16le(7 + body.length),
    ...body,
    ...secret(8),
  ];
}
export const rar4End = (): number[] => [0, 0, 0x7b, ...u16le(0x4000), ...u16le(7)];
export const rar4 = (...blocks: number[][]): Uint8Array => concat(RAR4_SIG, ...blocks);

// ---- OpenPGP ----

export function newPacket(tag: number, body: number[]): number[] {
  const n = body.length;
  const length =
    n < 192 ? [n] : n < 8384 ? [((n - 192) >> 8) + 192, (n - 192) & 255] : [255, ...u32be(n)];
  return [0xc0 | tag, ...length, ...body];
}
export function oldPacket(tag: number, body: number[]): number[] {
  return body.length < 256
    ? [0x80 | (tag << 2), body.length, ...body]
    : [0x81 | (tag << 2), ...u16be(body.length), ...body];
}
export const pkesk = (keyId: string, algorithm: number): number[] => [
  3,
  ...hex(keyId),
  algorithm,
  0,
  8,
  1,
  ...secret(16),
];
export const skesk4 = (cipher: number, s2k: number[]): number[] => [4, cipher, ...s2k];
export const s2kIterated = (hash: number, count: number): number[] => [
  3,
  hash,
  ...secret(8),
  count,
];
export const SEIPD1 = [1, ...secret(30)];

export function armor(label: string, bytes: number[], headers: string[] = []): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return [
    `-----BEGIN ${label}-----`,
    ...headers,
    '',
    ...lines,
    '=AAAA',
    `-----END ${label}-----`,
    '',
  ].join('\n');
}

// ---- age ----

export const ageFile = (stanzas: string[]): string =>
  [
    'age-encryption.org/v1',
    ...stanzas.flatMap((s) => [s, 'QUJDREVGRw']),
    '--- ' + 'A'.repeat(43),
    'payload',
  ].join('\n');

// ---- KeePass ----

const KDBX_SIGS = [0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5];
const AES_CIPHER = '31c1f2e6bf714350be5805216afc5aff';
export const CHACHA_CIPHER = 'd6038a2b8b6f4cb5a524339a31dbb59a';
export const TWOFISH_CIPHER = 'ad68f29f576f4bb9a36ad47af965346c';
export const ARGON2D = 'ef636ddf8c29444b91f7a9a403e30a0c';
export const ARGON2ID = '9e298b1956db4773b23dfc3ec6f0a1e6';
export const AES_KDF_V4 = 'c9d9f39a628a4460bf740d08c18a4fea';

export function kdbx3(
  options: { cipher?: string; compression?: number; rounds?: number } = {},
): Uint8Array {
  const field = (id: number, data: number[]): number[] => [id, ...u16le(data.length), ...data];
  return concat(
    KDBX_SIGS,
    u16le(1),
    u16le(3),
    field(2, hex(options.cipher ?? AES_CIPHER)),
    field(3, u32le(options.compression ?? 1)),
    field(4, secret(32)),
    field(5, secret(32)),
    field(6, u64le(options.rounds ?? 6000)),
    field(7, secret(16)),
    field(8, secret(32)),
    field(9, secret(32)),
    field(10, u32le(2)),
    field(0, [13, 10, 13, 10]),
    secret(64),
  );
}

export type DictEntry = [type: number, name: string, value: number[]];
export const dictU64 = (name: string, n: number): DictEntry => [0x05, name, u64le(n)];
export const dictU32 = (name: string, n: number): DictEntry => [0x04, name, u32le(n)];
export const dictBytes = (name: string, v: number[]): DictEntry => [0x42, name, v];
export function variantDictionary(entries: DictEntry[]): number[] {
  return [
    ...u16le(0x0100),
    ...entries.flatMap(([type, name, value]) => [
      type,
      ...u32le(name.length),
      ...enc(name),
      ...u32le(value.length),
      ...value,
    ]),
    0,
  ];
}
export function kdbx4(
  kdf: number[] | undefined,
  options: { minor?: number; cipher?: string; compression?: number } = {},
): Uint8Array {
  const field = (id: number, data: number[]): number[] => [id, ...u32le(data.length), ...data];
  return concat(
    KDBX_SIGS,
    u16le(options.minor ?? 1),
    u16le(4),
    field(2, hex(options.cipher ?? CHACHA_CIPHER)),
    field(3, u32le(options.compression ?? 1)),
    field(4, secret(32)),
    field(7, secret(12)),
    kdf ? field(11, kdf) : [],
    field(0, [13, 10, 13, 10]),
    secret(64),
  );
}

// ---- LUKS ----

function padded(text: string, n: number): number[] {
  return [...enc(text), ...new Array<number>(n - text.length).fill(0)].slice(0, n);
}
export function luks1(
  options: {
    cipher?: string;
    mode?: string;
    hash?: string;
    keyBytes?: number;
    slots?: (number | undefined)[];
    digestIterations?: number;
  } = {},
): Uint8Array {
  const header = new Uint8Array(592 + 4096);
  const d = new DataView(header.buffer);
  header.set([0x4c, 0x55, 0x4b, 0x53, 0xba, 0xbe], 0);
  d.setUint16(6, 1, false);
  header.set(padded(options.cipher ?? 'aes', 32), 8);
  header.set(padded(options.mode ?? 'xts-plain64', 32), 40);
  header.set(padded(options.hash ?? 'sha256', 32), 72);
  d.setUint32(104, 4096, false);
  d.setUint32(108, options.keyBytes ?? 64, false);
  header.set(secret(20), 112);
  header.set(secret(32), 132);
  d.setUint32(164, options.digestIterations ?? 120000, false);
  for (let i = 0; i < 8; i++) {
    const at = 208 + i * 48;
    const iterations = options.slots?.[i];
    d.setUint32(at, iterations === undefined ? 0xdead : 0x00ac71f3, false);
    d.setUint32(at + 4, iterations ?? 0, false);
    header.set(secret(32), at + 8);
  }
  return header;
}
export function luks2(json: string | object, options: { headerSize?: number } = {}): Uint8Array {
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  const size = options.headerSize ?? 16384;
  const out = new Uint8Array(Math.max(size, 4096 + text.length + 1));
  const d = new DataView(out.buffer);
  out.set([0x4c, 0x55, 0x4b, 0x53, 0xba, 0xbe], 0);
  d.setUint16(6, 2, false);
  d.setBigUint64(8, BigInt(size), false);
  out.set(padded('sha256', 32), 72);
  out.set(secret(64), 104);
  out.set(enc(text), 4096);
  return out;
}

// ---- DER ----

export function tlv(tag: number, content: number[]): number[] {
  const n = content.length;
  const length = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return [tag, ...length, ...content];
}
export const seq = (...parts: number[][]): number[] => tlv(0x30, parts.flat());
export const set = (...parts: number[][]): number[] => tlv(0x31, parts.flat());
export const derInt = (n: number): number[] =>
  tlv(0x02, n < 128 ? [n] : n < 32768 ? [n >> 8, n & 255] : [0, n >> 16, (n >> 8) & 255, n & 255]);
export const octets = (b: number[]): number[] => tlv(0x04, b);
export function oid(dotted: string): number[] {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const groups = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) {
      groups.unshift((v & 0x7f) | 0x80);
    }
    out.push(...groups);
  }
  return tlv(0x06, out);
}
export const explicit0 = (...parts: number[][]): number[] => tlv(0xa0, parts.flat());

export const OID = {
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  scrypt: '1.3.6.1.4.1.11591.4.11',
  hmacSha256: '1.2.840.113549.2.9',
  hmacSha512: '1.2.840.113549.2.11',
  aes256cbc: '2.16.840.1.101.3.4.1.42',
  aes128cbc: '2.16.840.1.101.3.4.1.2',
  tripleDesP12: '1.2.840.113549.1.12.1.3',
  rc2_40P12: '1.2.840.113549.1.12.1.6',
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  signedData: '1.2.840.113549.1.7.2',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
};

export function pbes2(
  options: { prf?: string | null; iterations?: number; cipher?: string } = {},
): number[] {
  const prf = options.prf === undefined ? OID.hmacSha256 : options.prf;
  return seq(
    oid(OID.pbes2),
    seq(
      seq(
        oid(OID.pbkdf2),
        seq(
          octets(secret(16)),
          derInt(options.iterations ?? 600000),
          ...(prf ? [seq(oid(prf), tlv(0x05, []))] : []),
        ),
      ),
      seq(oid(options.cipher ?? OID.aes256cbc), octets(secret(16))),
    ),
  );
}
export const pbes2Scrypt = (): number[] =>
  seq(
    oid(OID.pbes2),
    seq(
      seq(oid(OID.scrypt), seq(octets(secret(16)), derInt(32768), derInt(8), derInt(1))),
      seq(oid(OID.aes256cbc), octets(secret(16))),
    ),
  );
export const legacyPbe = (id: string, iterations: number): number[] =>
  seq(oid(id), seq(octets(secret(8)), derInt(iterations)));

/** EncryptedPrivateKeyInfo. */
export const encryptedPrivateKeyInfo = (alg: number[]): number[] => seq(alg, octets(secret(40)));

export const bag = (id: string, value: number[]): number[] => seq(oid(id), explicit0(value));
export const safeContentsData = (bags: number[][]): number[] =>
  seq(oid(OID.data), explicit0(octets(seq(...bags))));
export const safeContentsEncrypted = (alg: number[]): number[] =>
  seq(
    oid(OID.encryptedData),
    explicit0(seq(derInt(0), seq(oid(OID.data), alg, tlv(0x80, secret(60))))),
  );

export function pfx(
  containers: number[][],
  mac?: { algorithm: string; iterations?: number },
): Uint8Array {
  const authSafe = seq(oid(OID.data), explicit0(octets(seq(...containers))));
  const macData: number[][] = mac
    ? [
        seq(
          seq(seq(oid(mac.algorithm), tlv(0x05, [])), octets(secret(20))),
          octets(secret(8)),
          ...(mac.iterations === undefined ? [] : [derInt(mac.iterations)]),
        ),
      ]
    : [];
  return new Uint8Array(seq(derInt(3), authSafe, ...macData));
}

export function pem(label: string, der: number[], headers: string[] = []): string {
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return [
    `-----BEGIN ${label}-----`,
    ...headers,
    ...(headers.length ? [''] : []),
    ...lines,
    `-----END ${label}-----`,
    '',
  ].join('\n');
}

export function openssh(cipher: string, kdf: string, rounds = 16): number[] {
  const str = (b: number[]): number[] => [...u32be(b.length), ...b];
  const options = kdf === 'bcrypt' ? [...str(secret(16)), ...u32be(rounds)] : [];
  return [
    ...enc('openssh-key-v1'),
    0,
    ...str(enc(cipher)),
    ...str(enc(kdf)),
    ...str(options),
    ...u32be(1),
    ...str(secret(51)),
    ...str(secret(120)),
  ];
}
