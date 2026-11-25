// Building Windows PE images as exact bytes.
//
// Written from the PE/COFF specification (Microsoft's "PE Format" document and
// the Authenticode and RFC 5280 structures it points to), not from src/pe/: the
// fixture is an independent statement of the format, so a parser that agrees
// with it agrees with the specification and not merely with itself. Each test
// spells out only the fields under test.
//
// Layout of every image: headers (0x200 bytes), a .text section, a .rdata
// section holding the import, export, debug and .NET structures, an optional
// .rsrc section, then the overlay, then the certificate table. File and section
// alignment are 0x200 and 0x1000.

const SECTION_ALIGN = 0x1000;
const FILE_ALIGN = 0x200;
const HEADERS = 0x200;
const PE_OFFSET = 0x80;

const alignTo = (n: number, to: number): number => Math.ceil(n / to) * to;

/** A growing little-endian byte buffer. */
class Bytes {
  private data: number[] = [];

  get length(): number {
    return this.data.length;
  }
  u8(v: number): this {
    this.data.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  u64(v: bigint): this {
    return this.u32(Number(v & 0xffffffffn)).u32(Number(v >> 32n));
  }
  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) {
      this.data.push(bytes[i]);
    }
    return this;
  }
  /** UTF-8 text followed by a NUL, as the PE name tables store strings. */
  cstr(text: string): this {
    return this.raw(new TextEncoder().encode(text)).u8(0);
  }
  /** UTF-16LE text followed by a NUL, as version resources store strings. */
  wstr(text: string): this {
    for (let i = 0; i < text.length; i++) {
      this.u16(text.charCodeAt(i));
    }
    return this.u16(0);
  }
  pad(to: number): this {
    while (this.data.length % to !== 0) {
      this.data.push(0);
    }
    return this;
  }
  zeros(count: number): this {
    for (let i = 0; i < count; i++) {
      this.data.push(0);
    }
    return this;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.data);
  }
}

// ---- DER ---------------------------------------------------------------

/** One DER element: tag, definite length (short or long form), contents. */
export function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const head = [tag];
  if (length < 0x80) {
    head.push(length);
  } else if (length < 0x100) {
    head.push(0x81, length);
  } else {
    head.push(0x82, length >> 8, length & 0xff);
  }
  const out = new Uint8Array(head.length + length);
  out.set(head);
  let at = head.length;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const SEQUENCE = 0x30;
const SET = 0x31;
const OID = 0x06;
const INTEGER = 0x02;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;

const oid = (...bytes: number[]): Uint8Array => tlv(OID, Uint8Array.from(bytes));
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface NameSpec {
  commonName?: string;
  organization?: string;
}

/** An X.501 Name: a SEQUENCE of SETs, each holding one { OID, string } pair. */
function name(spec: NameSpec, stringTag = UTF8_STRING): Uint8Array {
  const rdns: Uint8Array[] = [];
  if (spec.organization !== undefined) {
    rdns.push(
      tlv(
        SET,
        tlv(
          SEQUENCE,
          oid(0x55, 0x04, 0x0a),
          tlv(stringTag, new TextEncoder().encode(spec.organization)),
        ),
      ),
    );
  }
  if (spec.commonName !== undefined) {
    rdns.push(
      tlv(
        SET,
        tlv(
          SEQUENCE,
          oid(0x55, 0x04, 0x03),
          tlv(stringTag, new TextEncoder().encode(spec.commonName)),
        ),
      ),
    );
  }
  return tlv(SEQUENCE, ...rdns);
}

const SHA256_WITH_RSA = tlv(
  SEQUENCE,
  oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b),
  tlv(0x05),
);

function certificate(
  serial: number,
  issuer: Uint8Array,
  subject: Uint8Array,
  notBefore: string,
  notAfter: string,
): Uint8Array {
  const tbs = tlv(
    SEQUENCE,
    tlv(0xa0, tlv(INTEGER, Uint8Array.from([2]))), // version v3
    tlv(INTEGER, Uint8Array.from([serial])),
    SHA256_WITH_RSA,
    issuer,
    tlv(SEQUENCE, tlv(UTC_TIME, ascii(notBefore)), tlv(UTC_TIME, ascii(notAfter))),
    subject,
    // SubjectPublicKeyInfo with a placeholder key: nothing reads it.
    tlv(
      SEQUENCE,
      tlv(SEQUENCE, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01), tlv(0x05)),
      tlv(0x03, Uint8Array.from([0, 1, 2, 3, 4])),
    ),
  );
  return tlv(SEQUENCE, tbs, SHA256_WITH_RSA, tlv(0x03, Uint8Array.from([0, 9, 9, 9])));
}

export interface SignerSpec {
  /** The signer certificate's subject. */
  subject: NameSpec;
  issuer: NameSpec;
  /** UTCTime strings such as "230615000000Z". */
  notBefore?: string;
  notAfter?: string;
  /** DER tag for the name strings; PrintableString (0x13) is what older CAs wrote. */
  stringTag?: number;
}

/**
 * A PKCS #7 ContentInfo wrapping a SignedData with two certificates (an
 * unrelated one first, then the signer's) and one SignerInfo that cites the
 * second by issuer and serial number, so a reader that took the first
 * certificate it saw would name the wrong party.
 */
export function buildSignedData(spec: SignerSpec): Uint8Array {
  const tag = spec.stringTag ?? UTF8_STRING;
  const issuer = name(spec.issuer, tag);
  const subject = name(spec.subject, tag);
  const decoy = certificate(
    7,
    name({ commonName: 'Unrelated Root' }, tag),
    name({ commonName: 'Unrelated Intermediate' }, tag),
    '200101000000Z',
    '400101000000Z',
  );
  const leaf = certificate(
    0x2a,
    issuer,
    subject,
    spec.notBefore ?? '230615000000Z',
    spec.notAfter ?? '260615235959Z',
  );
  const sha256 = tlv(
    SEQUENCE,
    oid(0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01),
    tlv(0x05),
  );
  const signerInfo = tlv(
    SEQUENCE,
    tlv(INTEGER, Uint8Array.from([1])),
    // IssuerAndSerialNumber
    tlv(SEQUENCE, issuer, tlv(INTEGER, Uint8Array.from([0x2a]))),
    sha256,
    SHA256_WITH_RSA,
    tlv(0x04, Uint8Array.from([1, 2, 3, 4])),
  );
  const signedData = tlv(
    SEQUENCE,
    tlv(INTEGER, Uint8Array.from([1])),
    tlv(SET, sha256),
    tlv(SEQUENCE, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01)), // data
    tlv(0xa0, decoy, leaf),
    tlv(SET, signerInfo),
  );
  return tlv(
    SEQUENCE,
    oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02), // signedData
    tlv(0xa0, signedData),
  );
}

// ---- Version resource ----------------------------------------------------

export interface VersionSpec {
  fileVersion?: [number, number, number, number];
  productVersion?: [number, number, number, number];
  /** VS_FF_* bits the file sets (1 debug, 2 prerelease, 4 patched, 8 private, 0x20 special). */
  fileFlags?: number;
  /** Which of those bits are meaningful. Defaults to all the defined ones. */
  fileFlagsMask?: number;
  strings?: [string, string][];
  /** Language and code page as the 8 hex digits a string table is keyed by. */
  language?: string;
}

/** One VS_VERSIONINFO-family node: length, value length, type, key, padded value, children. */
function versionNode(
  key: string,
  type: 0 | 1,
  valueLength: number,
  value: Uint8Array,
  children: Uint8Array[],
): Uint8Array {
  const out = new Bytes();
  out.u16(0).u16(valueLength).u16(type).wstr(key).pad(4);
  out.raw(value);
  for (const child of children) {
    out.pad(4);
    out.raw(child);
  }
  const bytes = out.bytes();
  // wLength covers the node and its children, but not the padding after it.
  bytes[0] = bytes.length & 0xff;
  bytes[1] = bytes.length >>> 8;
  return bytes;
}

function buildVersionResource(spec: VersionSpec): Uint8Array {
  const language = spec.language ?? '040904B0';
  const fixed = new Bytes();
  const [fa, fb, fc, fd] = spec.fileVersion ?? [0, 0, 0, 0];
  const [pa, pb, pc, pd] = spec.productVersion ?? spec.fileVersion ?? [0, 0, 0, 0];
  fixed
    .u32(0xfeef04bd) // dwSignature
    .u32(0x00010000) // dwStrucVersion
    .u32(((fa << 16) | fb) >>> 0)
    .u32(((fc << 16) | fd) >>> 0)
    .u32(((pa << 16) | pb) >>> 0)
    .u32(((pc << 16) | pd) >>> 0)
    .u32(spec.fileFlagsMask ?? 0x3f)
    .u32(spec.fileFlags ?? 0)
    .u32(0x00040004) // VOS_NT_WINDOWS32
    .u32(1) // VFT_APP
    .u32(0)
    .u32(0)
    .u32(0);
  const strings = (spec.strings ?? []).map(([key, value]) =>
    // A String node's wValueLength counts UTF-16 characters including the NUL.
    versionNode(key, 1, value.length + 1, new Bytes().wstr(value).bytes(), []),
  );
  const table = versionNode(language, 1, 0, new Uint8Array(0), strings);
  const stringFileInfo = versionNode('StringFileInfo', 1, 0, new Uint8Array(0), [table]);
  const translation = new Bytes()
    .u16(parseInt(language.slice(0, 4), 16))
    .u16(parseInt(language.slice(4), 16))
    .bytes();
  const varFileInfo = versionNode('VarFileInfo', 1, 0, new Uint8Array(0), [
    versionNode('Translation', 0, 4, translation, []),
  ]);
  return versionNode('VS_VERSION_INFO', 0, 52, fixed.bytes(), [stringFileInfo, varFileInfo]);
}

// ---- Resource section ----------------------------------------------------

/**
 * A .rsrc section body: a three-level tree of type, then name id, then language
 * (0x409), with one data entry per leaf. Types and names are written in
 * ascending order, as the format requires. Subdirectory and entry offsets are
 * relative to the start of the section; a data entry's address is an RVA.
 */
function buildResources(
  items: { type: number; name: number | string; data: Uint8Array }[],
  baseRva: number,
): Uint8Array {
  const types = [...new Set(items.map((item) => item.type))].sort((a, b) => a - b);
  // Within a directory the named entries come first, in name order, and the
  // numbered ones after them, ascending.
  const order = (a: number | string, b: number | string): number =>
    typeof a === 'string'
      ? typeof b === 'string'
        ? a.toUpperCase() < b.toUpperCase()
          ? -1
          : 1
        : -1
      : typeof b === 'string'
        ? 1
        : a - b;
  const byType = types.map((type) =>
    items.filter((item) => item.type === type).sort((a, b) => order(a.name, b.name)),
  );
  let at = 16 + 8 * types.length;
  const nameTableAt = byType.map((list) => {
    const here = at;
    at += 16 + 8 * list.length;
    return here;
  });
  const leafAt = byType.map((list) =>
    list.map(() => {
      const here = at; // language table, then its data entry
      at += 24 + 16;
      return here;
    }),
  );
  // A named entry points at its name: a 16-bit length, then UTF-16.
  const nameAt = byType.map((list) =>
    list.map((item) => {
      if (typeof item.name !== 'string') {
        return 0;
      }
      const here = at;
      at += 2 + item.name.length * 2;
      return here;
    }),
  );
  let dataAt = alignTo(at, 4);
  const dataOffsets = byType.map((list) =>
    list.map((item) => {
      const here = dataAt;
      dataAt = alignTo(dataAt + item.data.length, 4);
      return here;
    }),
  );
  const table = (ids: number, named = 0): Bytes =>
    new Bytes().u32(0).u32(0).u16(0).u16(0).u16(named).u16(ids);
  const out = new Bytes();
  out.raw(table(types.length).bytes());
  types.forEach((type, t) => {
    out.u32(type).u32(0x80000000 | nameTableAt[t]);
  });
  byType.forEach((list, t) => {
    const named = list.filter((item) => typeof item.name === 'string').length;
    out.raw(table(list.length - named, named).bytes());
    list.forEach((item, n) => {
      out
        .u32(typeof item.name === 'string' ? (0x80000000 | nameAt[t][n]) >>> 0 : item.name)
        .u32(0x80000000 | leafAt[t][n]);
    });
  });
  byType.forEach((list, t) => {
    list.forEach((item, n) => {
      out
        .raw(table(1).bytes())
        .u32(0x409)
        .u32(leafAt[t][n] + 24); // the language entry points at the data entry
      out
        .u32(baseRva + dataOffsets[t][n])
        .u32(item.data.length)
        .u32(0)
        .u32(0);
    });
  });
  byType.forEach((list) => {
    list.forEach((item) => {
      if (typeof item.name === 'string') {
        out.u16(item.name.length);
        for (const ch of item.name) {
          out.u16(ch.charCodeAt(0));
        }
      }
    });
  });
  byType.forEach((list, t) => {
    list.forEach((item, n) => {
      while (out.length < dataOffsets[t][n]) {
        out.u8(0);
      }
      out.raw(item.data);
    });
  });
  return out.pad(4).bytes();
}

// ---- Icons -----------------------------------------------------------------

export interface BitmapSpec {
  width: number;
  height: number;
  bitCount: 1 | 4 | 8 | 24 | 32;
  /** Top-down, left-to-right [r, g, b, a] per pixel, for 24 and 32 bits. */
  rgba?: [number, number, number, number][];
  /** Palette indices, top-down, for 1, 4 and 8 bits. */
  indices?: number[];
  palette?: [number, number, number][];
  /** One flag per pixel, top-down; true hides the pixel. Omit to leave the AND mask off. */
  transparent?: boolean[];
  /** Header fields to corrupt on purpose. */
  headerSize?: number;
  compression?: number;
  statedWidth?: number;
  statedHeight?: number;
}

/**
 * An icon image as stored in an RT_ICON resource: a BITMAPINFOHEADER whose
 * height counts the colour rows and the mask together, a palette for 8 bits and
 * shallower, the colour rows, then a 1-bit AND mask (set means transparent).
 * Rows run bottom to top and each is padded to a multiple of four bytes.
 */
export function iconBitmap(spec: BitmapSpec): Uint8Array {
  const { width, height, bitCount } = spec;
  const out = new Bytes();
  out
    .u32(spec.headerSize ?? 40)
    .u32(spec.statedWidth ?? width)
    .u32((spec.statedHeight ?? height * 2) >>> 0)
    .u16(1) // planes
    .u16(bitCount)
    .u32(spec.compression ?? 0)
    .u32(0) // SizeImage
    .u32(0)
    .u32(0)
    .u32(spec.palette?.length ?? 0) // ColorsUsed
    .u32(0);
  for (const [r, g, b] of spec.palette ?? []) {
    out.u8(b).u8(g).u8(r).u8(0); // RGBQUAD is blue, green, red, reserved
  }
  const rowBytes = Math.ceil((width * bitCount) / 32) * 4;
  for (let y = height - 1; y >= 0; y--) {
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < width; x++) {
      if (bitCount === 24 || bitCount === 32) {
        const [r, g, b, a] = spec.rgba?.[y * width + x] ?? [0, 0, 0, 255];
        const at = x * (bitCount / 8);
        row[at] = b;
        row[at + 1] = g;
        row[at + 2] = r;
        if (bitCount === 32) {
          row[at + 3] = a;
        }
      } else {
        const index = spec.indices?.[y * width + x] ?? 0;
        const bit = x * bitCount;
        row[bit >> 3] |= index << (8 - bitCount - (bit & 7));
      }
    }
    out.raw(row);
  }
  if (spec.transparent) {
    const maskRow = Math.ceil(width / 32) * 4;
    for (let y = height - 1; y >= 0; y--) {
      const row = new Uint8Array(maskRow);
      for (let x = 0; x < width; x++) {
        if (spec.transparent[y * width + x]) {
          row[x >> 3] |= 0x80 >> (x & 7);
        }
      }
      out.raw(row);
    }
  }
  return out.bytes();
}

/** The first 24 bytes of a PNG: signature, then an IHDR chunk header and its size fields. */
export function pngStub(width: number, height: number): Uint8Array {
  return (
    new Bytes()
      .raw([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      .raw([0, 0, 0, 13])
      .raw(ascii('IHDR'))
      .raw([
        width >>> 24,
        width >>> 16,
        width >>> 8,
        width,
        height >>> 24,
        height >>> 16,
        height >>> 8,
        height,
      ])
      .raw([8, 6, 0, 0, 0])
      // The header chunk's CRC. The reader does not verify it, but it does need
      // the chunk to be whole.
      .raw([0, 0, 0, 0])
      .bytes()
  );
}

export interface IconSpec {
  /** The RT_ICON resource id, and the id the group entry names. */
  id: number;
  width: number;
  height: number;
  bitCount: number;
  /** The image resource. Omit to list the entry in the group with no resource behind it. */
  data?: Uint8Array;
}

/** A GRPICONDIR: reserved, type (1 icon, 2 cursor), count, then 14-byte entries. */
export function iconGroup(icons: IconSpec[], type = 1): Uint8Array {
  const out = new Bytes().u16(0).u16(type).u16(icons.length);
  for (const icon of icons) {
    out
      .u8(icon.width >= 256 ? 0 : icon.width)
      .u8(icon.height >= 256 ? 0 : icon.height)
      .u8(0) // colour count
      .u8(0)
      .u16(1) // planes
      .u16(icon.bitCount)
      .u32(icon.data?.length ?? 100)
      .u16(icon.id);
  }
  return out.bytes();
}

// ---- The image ------------------------------------------------------------

export interface PeSpec {
  /** PE32+ (64-bit) when true. Default false. */
  plus?: boolean;
  machine?: number;
  dll?: boolean;
  subsystem?: number;
  timestamp?: number;
  dllCharacteristics?: number;
  largeAddressAware?: boolean;
  imageBase?: bigint;
  subsystemVersion?: [number, number];
  checksum?: number;
  version?: VersionSpec;
  /** Manifest XML, stored as an RT_MANIFEST resource. */
  manifest?: string;
  /** The resource ID the manifest is stored under. 1, the process manifest, unless given. */
  manifestId?: number;
  /** Further manifest resources beside it, each under a name or another ID. */
  extraManifests?: { name: number | string; xml: string }[];
  /**
   * Icon images, each its own RT_ICON resource under its `id`, plus one
   * RT_GROUP_ICON listing them all. A group entry with no `data` names an id
   * that has no resource.
   */
  icons?: IconSpec[];
  /** wType of the group's directory: 1 for icons, 2 for cursors. */
  iconGroupType?: number;
  imports?: { library: string; functions: number }[];
  /** Delay-load imports: attributes bit 0 set, so every field is an RVA. */
  delayImports?: { library: string; functions: number }[];
  /**
   * `functions` is the length of the export address table (it defaults to the
   * number of names) and `unused` lists the slots in it left empty, as the
   * gaps between a library's ordinals are.
   */
  exports?: {
    dllName: string;
    names: string[];
    functions?: number;
    unused?: number[];
    /** The ordinal of the first slot. 1 unless given. */
    base?: number;
  };
  /** A CodeView "RSDS" debug record. `guid` is the usual 8-4-4-4-12 text form. */
  debug?: { guid: string; age: number; pdbPath: string };
  /** Adds an IMAGE_DEBUG_TYPE_REPRO (16) entry, which marks a deterministic build. */
  repro?: boolean;
  /** A CLR header and metadata root. `flags` are the COMIMAGE_FLAGS_* bits. */
  clr?: { runtime: string; flags: number };
  /** The bytes of a WIN_CERTIFICATE's bCertificate, normally PKCS #7 DER. */
  certificate?: Uint8Array;
  /** wCertificateType of that entry. 2 is PKCS_SIGNED_DATA, the default. */
  certificateType?: number;
  /** What the entry says its length is, when it should lie. */
  certificateLength?: number;
  /**
   * Bytes of a `.data` section after the others, or a function of the section's
   * RVA for contents that hold addresses within it.
   */
  data?: Uint8Array | ((rva: number) => Uint8Array);
  /** Bytes after the last section: given directly, or as a length of 0x5A fill. */
  overlay?: Uint8Array | number;
  /** Overrides the NumberOfSections field without adding sections. */
  declaredSections?: number;
  /** Rewrites data directory entries after the image is built, to point where the test wants. */
  directories?: Record<number, { address: number; size: number }>;
}

interface Piece {
  rva: number;
  size: number;
}

export function buildPe(spec: PeSpec = {}): Uint8Array {
  const plus = spec.plus ?? false;
  // Four section headers do not fit in 0x200 bytes beside the optional header.
  const headerSize = spec.data === undefined ? HEADERS : HEADERS * 2;
  const dirs: Piece[] = Array.from({ length: 16 }, () => ({ rva: 0, size: 0 }));

  // .text
  const text = new Uint8Array(FILE_ALIGN).fill(0xcc);
  text[0] = 0xc3;
  const TEXT_RVA = SECTION_ALIGN;
  const TEXT_RAW = headerSize;

  // .rdata, built so that every structure can name the RVAs of what it points at.
  const RDATA_RVA = SECTION_ALIGN * 2;
  const RDATA_RAW = TEXT_RAW + text.length;
  const rdata = new Bytes();
  const here = (): number => RDATA_RVA + rdata.length;
  const hereFile = (): number => RDATA_RAW + rdata.length;
  const string = (text: string): number => {
    rdata.pad(2);
    const rva = here();
    rdata.cstr(text);
    return rva;
  };
  const writeThunks = (rvas: number[]): number => {
    rdata.pad(8);
    const rva = here();
    for (const r of [...rvas, 0]) {
      if (plus) {
        rdata.u64(BigInt(r));
      } else {
        rdata.u32(r);
      }
    }
    return rva;
  };
  /** Hint/name entries for `count` functions, as the RVAs the thunks hold. */
  const importNames = (library: string, count: number): number[] => {
    const rvas: number[] = [];
    for (let i = 0; i < count; i++) {
      rdata.pad(2);
      rvas.push(here());
      rdata.u16(i).cstr(`${library.replace(/\W/g, '')}Fn${i}`);
    }
    return rvas;
  };

  if (spec.imports && spec.imports.length > 0) {
    const entries = spec.imports.map((lib) => {
      const nameRva = string(lib.library);
      const names = importNames(lib.library, lib.functions);
      const ilt = writeThunks(names);
      const iat = writeThunks(names);
      return { nameRva, ilt, iat };
    });
    rdata.pad(4);
    dirs[1] = { rva: here(), size: (entries.length + 1) * 20 };
    for (const e of entries) {
      // OriginalFirstThunk, TimeDateStamp, ForwarderChain, Name, FirstThunk
      rdata.u32(e.ilt).u32(0).u32(0).u32(e.nameRva).u32(e.iat);
    }
    rdata.zeros(20);
  }

  if (spec.delayImports && spec.delayImports.length > 0) {
    const entries = spec.delayImports.map((lib) => {
      const nameRva = string(lib.library);
      rdata.pad(4);
      const module = here();
      rdata.u32(0);
      const names = importNames(lib.library, lib.functions);
      const int = writeThunks(names);
      const iat = writeThunks(names);
      return { nameRva, module, int, iat };
    });
    rdata.pad(4);
    dirs[13] = { rva: here(), size: (entries.length + 1) * 32 };
    for (const e of entries) {
      // Attributes, DllNameRVA, ModuleHandleRVA, ImportAddressTableRVA,
      // ImportNameTableRVA, BoundImportAddressTableRVA, UnloadInformationTableRVA, TimeDateStamp
      rdata.u32(1).u32(e.nameRva).u32(e.module).u32(e.iat).u32(e.int).u32(0).u32(0).u32(0);
    }
    rdata.zeros(32);
  }

  if (spec.exports) {
    const names = spec.exports.names;
    const functions = spec.exports.functions ?? names.length;
    const dllName = string(spec.exports.dllName);
    const nameRvas = names.map((n) => string(n));
    rdata.pad(4);
    const functionTable = here();
    for (let i = 0; i < functions; i++) {
      rdata.u32(spec.exports.unused?.includes(i) ? 0 : TEXT_RVA);
    }
    const nameTable = here();
    for (const r of nameRvas) {
      rdata.u32(r);
    }
    const ordinalTable = here();
    for (let i = 0; i < names.length; i++) {
      rdata.u16(i);
    }
    rdata.pad(4);
    dirs[0] = { rva: here(), size: 40 };
    rdata
      .u32(0) // Characteristics
      .u32(0) // TimeDateStamp
      .u16(0)
      .u16(0) // version
      .u32(dllName)
      .u32(spec.exports.base ?? 1) // Base
      .u32(functions)
      .u32(names.length)
      .u32(functionTable)
      .u32(nameTable)
      .u32(ordinalTable);
  }

  if (spec.debug || spec.repro) {
    const entries: { type: number; size: number; rva: number; file: number }[] = [];
    if (spec.debug) {
      rdata.pad(4);
      const rva = here();
      const file = hereFile();
      const hex = spec.debug.guid.replace(/-/g, '');
      const byteAt = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      rdata.raw(ascii('RSDS'));
      // A GUID is a u32, two u16s and eight bytes: the first three are little-endian.
      rdata.u32(parseInt(hex.slice(0, 8), 16));
      rdata.u16(parseInt(hex.slice(8, 12), 16));
      rdata.u16(parseInt(hex.slice(12, 16), 16));
      for (let i = 8; i < 16; i++) {
        rdata.u8(byteAt(i));
      }
      rdata.u32(spec.debug.age).cstr(spec.debug.pdbPath);
      entries.push({ type: 2, size: here() - rva, rva, file });
    }
    if (spec.repro) {
      rdata.pad(4);
      const rva = here();
      const file = hereFile();
      rdata.u32(32).raw(new Uint8Array(32).fill(0x11)); // length-prefixed hash
      entries.push({ type: 16, size: 36, rva, file });
    }
    rdata.pad(4);
    dirs[6] = { rva: here(), size: entries.length * 28 };
    for (const e of entries) {
      // Characteristics, TimeDateStamp, Major, Minor, Type, SizeOfData,
      // AddressOfRawData (an RVA), PointerToRawData (a file offset)
      rdata.u32(0).u32(0).u16(0).u16(0).u32(e.type).u32(e.size).u32(e.rva).u32(e.file);
    }
  }

  if (spec.clr) {
    rdata.pad(4);
    const metadata = here();
    const version = new Bytes().cstr(spec.clr.runtime).pad(4).bytes();
    rdata
      .u32(0x424a5342) // "BSJB"
      .u16(1)
      .u16(1)
      .u32(0)
      .u32(version.length)
      .raw(version)
      .u16(0) // flags
      .u16(0); // streams
    const metadataSize = here() - metadata;
    rdata.pad(4);
    dirs[14] = { rva: here(), size: 72 };
    rdata
      .u32(72) // cb
      .u16(2)
      .u16(5) // runtime version
      .u32(metadata)
      .u32(metadataSize)
      .u32(spec.clr.flags)
      .u32(0) // entry point token
      .zeros(48); // resources, strong name signature, and the rest, all empty
  }
  rdata.pad(FILE_ALIGN);
  if (rdata.length === 0) {
    rdata.zeros(FILE_ALIGN);
  }
  const rdataBytes = rdata.bytes();

  // .rsrc
  const RSRC_RVA = RDATA_RVA + alignTo(rdataBytes.length, SECTION_ALIGN);
  const RSRC_RAW = RDATA_RAW + rdataBytes.length;
  const resourceItems: { type: number; name: number | string; data: Uint8Array }[] = [];
  if (spec.version) {
    resourceItems.push({ type: 16, name: 1, data: buildVersionResource(spec.version) });
  }
  if (spec.manifest !== undefined) {
    resourceItems.push({ type: 24, name: spec.manifestId ?? 1, data: ascii(spec.manifest) });
  }
  for (const extra of spec.extraManifests ?? []) {
    resourceItems.push({ type: 24, name: extra.name, data: ascii(extra.xml) });
  }
  if (spec.icons && spec.icons.length > 0) {
    for (const icon of spec.icons) {
      if (icon.data) {
        resourceItems.push({ type: 3, name: icon.id, data: icon.data });
      }
    }
    resourceItems.push({
      type: 14,
      name: 1,
      data: iconGroup(spec.icons, spec.iconGroupType),
    });
  }
  const rsrcBytes =
    resourceItems.length > 0
      ? (() => {
          const body = buildResources(resourceItems, RSRC_RVA);
          return new Bytes().raw(body).pad(FILE_ALIGN).bytes();
        })()
      : new Uint8Array(0);
  if (resourceItems.length > 0) {
    dirs[2] = { rva: RSRC_RVA, size: rsrcBytes.length };
  }

  // .data, last, so nothing else moves.
  const DATA_RVA = RSRC_RVA + alignTo(rsrcBytes.length, SECTION_ALIGN);
  const DATA_RAW = RSRC_RAW + rsrcBytes.length;
  const dataBytes =
    spec.data === undefined
      ? new Uint8Array(0)
      : new Bytes()
          .raw(typeof spec.data === 'function' ? spec.data(DATA_RVA) : spec.data)
          .pad(FILE_ALIGN)
          .bytes();

  // Overlay and certificate table come after the last section.
  const overlay =
    spec.overlay === undefined
      ? new Uint8Array(0)
      : typeof spec.overlay === 'number'
        ? new Uint8Array(spec.overlay).fill(0x5a)
        : spec.overlay;
  const sectionsEnd = DATA_RAW + dataBytes.length;
  const certAt = alignTo(sectionsEnd + overlay.length, 8);
  let certBytes = new Uint8Array(0);
  if (spec.certificate) {
    const win = new Bytes()
      .u32(spec.certificateLength ?? 8 + spec.certificate.length) // dwLength, without the padding
      .u16(0x0200) // wRevision
      .u16(spec.certificateType ?? 2)
      .raw(spec.certificate)
      .pad(8);
    certBytes = win.bytes();
    // The security directory is the one entry whose address is a file offset.
    dirs[4] = { rva: certAt, size: certBytes.length };
  }
  for (const [index, dir] of Object.entries(spec.directories ?? {})) {
    dirs[Number(index)] = { rva: dir.address, size: dir.size };
  }

  // Headers.
  const sections: {
    name: string;
    vsize: number;
    va: number;
    raw: number;
    rawSize: number;
    flags: number;
  }[] = [
    {
      name: '.text',
      vsize: text.length,
      va: TEXT_RVA,
      raw: TEXT_RAW,
      rawSize: text.length,
      flags: 0x60000020,
    },
    {
      name: '.rdata',
      vsize: rdataBytes.length,
      va: RDATA_RVA,
      raw: RDATA_RAW,
      rawSize: rdataBytes.length,
      flags: 0x40000040,
    },
  ];
  if (rsrcBytes.length > 0) {
    sections.push({
      name: '.rsrc',
      vsize: rsrcBytes.length,
      va: RSRC_RVA,
      raw: RSRC_RAW,
      rawSize: rsrcBytes.length,
      flags: 0x40000040,
    });
  }
  if (dataBytes.length > 0) {
    sections.push({
      name: '.data',
      vsize: dataBytes.length,
      va: DATA_RVA,
      raw: DATA_RAW,
      rawSize: dataBytes.length,
      flags: 0xc0000040,
    });
  }
  const last = sections[sections.length - 1];
  const sizeOfImage = last.va + alignTo(last.vsize, SECTION_ALIGN);

  const optionalSize = (plus ? 112 : 96) + 16 * 8;
  const opt = new DataView(new ArrayBuffer(optionalSize));
  opt.setUint16(0, plus ? 0x20b : 0x10b, true);
  opt.setUint8(2, 14);
  opt.setUint8(3, 36);
  opt.setUint32(4, text.length, true); // SizeOfCode
  opt.setUint32(8, rdataBytes.length + rsrcBytes.length, true); // SizeOfInitializedData
  opt.setUint32(16, TEXT_RVA, true); // AddressOfEntryPoint
  opt.setUint32(20, TEXT_RVA, true); // BaseOfCode
  const base = spec.imageBase ?? (plus ? 0x140000000n : 0x400000n);
  if (plus) {
    opt.setBigUint64(24, base, true);
  } else {
    opt.setUint32(24, RDATA_RVA, true); // BaseOfData
    opt.setUint32(28, Number(base), true);
  }
  opt.setUint32(32, SECTION_ALIGN, true);
  opt.setUint32(36, FILE_ALIGN, true);
  opt.setUint16(40, 6, true); // MajorOperatingSystemVersion
  opt.setUint16(42, 0, true);
  opt.setUint16(44, 1, true); // MajorImageVersion
  opt.setUint16(46, 2, true);
  const [subMajor, subMinor] = spec.subsystemVersion ?? [6, 0];
  opt.setUint16(48, subMajor, true);
  opt.setUint16(50, subMinor, true);
  opt.setUint32(56, sizeOfImage, true);
  opt.setUint32(60, headerSize, true);
  opt.setUint32(64, spec.checksum ?? 0, true);
  opt.setUint16(68, spec.subsystem ?? 2, true);
  opt.setUint16(70, spec.dllCharacteristics ?? 0x140, true);
  const dirCount = plus ? 108 : 92;
  opt.setUint32(dirCount, 16, true);
  dirs.forEach((dir, i) => {
    opt.setUint32(dirCount + 4 + i * 8, dir.rva, true);
    opt.setUint32(dirCount + 8 + i * 8, dir.size, true);
  });

  const head = new Bytes();
  head.raw(ascii('MZ')).zeros(0x3a).u32(PE_OFFSET); // e_lfanew at 0x3C
  head.zeros(PE_OFFSET - head.length);
  head.raw(ascii('PE')).u16(0);
  let characteristics = 0x0002 | (plus ? 0 : 0x0100); // EXECUTABLE_IMAGE, 32BIT_MACHINE
  if (spec.dll) {
    characteristics |= 0x2000;
  }
  if (spec.largeAddressAware) {
    characteristics |= 0x0020;
  }
  head
    .u16(spec.machine ?? (plus ? 0x8664 : 0x014c))
    .u16(spec.declaredSections ?? sections.length)
    .u32(spec.timestamp ?? 1700000000)
    .u32(0) // PointerToSymbolTable
    .u32(0) // NumberOfSymbols
    .u16(optionalSize)
    .u16(characteristics);
  head.raw(new Uint8Array(opt.buffer));
  for (const s of sections) {
    const nameBytes = new Uint8Array(8);
    nameBytes.set(ascii(s.name));
    head
      .raw(nameBytes)
      .u32(s.vsize)
      .u32(s.va)
      .u32(s.rawSize)
      .u32(s.raw)
      .u32(0)
      .u32(0)
      .u16(0)
      .u16(0)
      .u32(s.flags);
  }
  head.zeros(headerSize - head.length);

  const total = certAt + certBytes.length;
  const file = new Uint8Array(total);
  file.set(head.bytes(), 0);
  file.set(text, TEXT_RAW);
  file.set(rdataBytes, RDATA_RAW);
  file.set(rsrcBytes, RSRC_RAW);
  file.set(dataBytes, DATA_RAW);
  file.set(overlay, sectionsEnd);
  file.set(certBytes, certAt);
  return file;
}
