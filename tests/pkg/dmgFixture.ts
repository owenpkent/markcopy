// Building Apple disk images (UDIF) as exact bytes.
//
// Written from the UDIF layout shared by the open-source implementations
// (libdmg-hfsplus, the apple-dmg crate): a data fork, an XML property list of
// "mish" partition tables, and a 512-byte big-endian "koly" trailer. Not from
// src/pkg/dmg.ts.

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface ChunkSpec {
  /** 0 zero-fill, 1 raw, 2 ignored, 0x80000004 ADC, 0x80000005 zlib, 0x80000006 bzip2, 0x80000007 LZFSE, 0x80000008 LZMA, 0x7ffffffe comment, 0xffffffff terminator. */
  type: number;
  sectors?: number;
}

export interface PartitionSpec {
  name: string;
  sectors?: number;
  chunks?: ChunkSpec[];
  /** Replace the chunk count the table declares. */
  declaredChunks?: number;
  /** Replace the signature. */
  signature?: string;
}

/** One partition's mish block: a 204-byte header, then 40 bytes per chunk. */
export function buildMish(spec: PartitionSpec): Uint8Array {
  const chunks = spec.chunks ?? [
    { type: 0x80000005, sectors: spec.sectors ?? 8 },
    { type: 0xffffffff },
  ];
  const out = new Uint8Array(204 + chunks.length * 40);
  const v = new DataView(out.buffer);
  out.set(utf8(spec.signature ?? 'mish'), 0);
  v.setUint32(4, 1, false);
  v.setBigUint64(8, 0n, false);
  v.setBigUint64(16, BigInt(spec.sectors ?? 8), false);
  v.setBigUint64(24, 0n, false);
  v.setUint32(32, 2052, false);
  v.setUint32(36, 0x7fffffff, false);
  // 24 reserved bytes, then the checksum: type, size in bits, 32 words.
  v.setUint32(64, 2, false);
  v.setUint32(68, 32, false);
  v.setUint32(200, spec.declaredChunks ?? chunks.length, false);
  chunks.forEach((c, i) => {
    const at = 204 + i * 40;
    v.setUint32(at, c.type, false);
    v.setBigUint64(at + 8, 0n, false);
    v.setBigUint64(at + 16, BigInt(c.sectors ?? 0), false);
  });
  return out;
}

export interface DmgSpec {
  partitions?: PartitionSpec[];
  /** Total sectors the trailer declares; defaults to the sum of the partitions. */
  sectorCount?: number;
  dataForkLength?: number;
  checksumType?: number;
  segmentNumber?: number;
  segmentCount?: number;
  flags?: number;
  licence?: boolean;
  /** A code signature SuperBlob to place before the property list and point to. */
  codeSignature?: Uint8Array;
  /** Raw property list text instead of a generated one. */
  rawPlist?: string;
  /** Overrides for the trailer's property-list offset and length. */
  xmlOffset?: number;
  xmlLength?: number;
}

function base64(bytes: Uint8Array): string {
  // Built in slices: spreading a large table into one call overflows the stack.
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  const text = btoa(binary);
  return text.replace(/(.{68})/g, '$1\n\t\t\t');
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function buildDmg(spec: DmgSpec = {}): Uint8Array {
  const partitions = spec.partitions ?? [
    { name: 'Protective Master Boot Record (MBR : 0)', sectors: 1 },
    { name: 'Install App (Apple_HFS : 1)', sectors: 2048 },
  ];
  const dataFork = new Uint8Array(1024).fill(0xab);
  const signature = spec.codeSignature ?? new Uint8Array(0);

  const blkx = partitions
    .map(
      (p, i) =>
        `<dict><key>Attributes</key><string>0x0050</string><key>CFName</key><string>${xmlEscape(p.name)}</string>` +
        `<key>Data</key><data>\n\t\t\t${base64(buildMish(p))}\n\t\t</data><key>ID</key><string>${i - 1}</string>` +
        `<key>Name</key><string>${xmlEscape(p.name)}</string></dict>`,
    )
    .join('');
  const plist =
    spec.rawPlist ??
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0"><dict><key>resource-fork</key><dict><key>blkx</key><array>${blkx}</array>` +
      (spec.licence
        ? '<key>LPic</key><array><dict><key>ID</key><string>5000</string></dict></array>'
        : '') +
      `<key>plst</key><array/></dict></dict></plist>`;
  const xml = utf8(plist);

  const signatureOffset = dataFork.length;
  const xmlOffset = signatureOffset + signature.length;
  const total = xmlOffset + xml.length;
  const out = new Uint8Array(total + 512);
  out.set(dataFork, 0);
  out.set(signature, signatureOffset);
  out.set(xml, xmlOffset);

  const k = new DataView(out.buffer, total, 512);
  out.set(utf8('koly'), total);
  k.setUint32(4, 4, false);
  k.setUint32(8, 512, false);
  k.setUint32(12, spec.flags ?? 1, false);
  k.setBigUint64(32, BigInt(spec.dataForkLength ?? dataFork.length), false);
  k.setUint32(56, spec.segmentNumber ?? 1, false);
  k.setUint32(60, spec.segmentCount ?? 1, false);
  k.setUint32(80, spec.checksumType ?? 2, false);
  k.setUint32(84, 32, false);
  k.setBigUint64(216, BigInt(spec.xmlOffset ?? xmlOffset), false);
  k.setBigUint64(224, BigInt(spec.xmlLength ?? xml.length), false);
  // The code signature's offset and length sit 64 bytes into the 120 reserved bytes.
  k.setBigUint64(296, BigInt(signature.length > 0 ? signatureOffset : 0), false);
  k.setBigUint64(304, BigInt(signature.length), false);
  k.setUint32(352, 2, false);
  k.setUint32(356, 32, false);
  k.setUint32(488, 1, false);
  k.setBigUint64(
    492,
    BigInt(spec.sectorCount ?? partitions.reduce((n, p) => n + (p.sectors ?? 8), 0)),
    false,
  );
  return out;
}

export interface SlotSpec {
  /** Slot type: 0 CodeDirectory, 0x10000 CMS signature, 0x10002 notarization ticket. */
  type: number;
  /** Blob magic: 0xfade0c02 CodeDirectory, 0xfade0b01 generic wrapper (CMS). */
  magic: number;
  body: Uint8Array;
}

/**
 * An Apple embedded-signature SuperBlob (xnu cs_blobs.h): magic 0xfade0cc0,
 * total length, blob count, one (type, offset) index entry per blob, then the
 * blobs, each a magic, a length that includes its 8-byte header, and a body.
 */
export function buildSuperBlob(slots: SlotSpec[]): Uint8Array {
  const headerSize = 12 + slots.length * 8;
  const total = headerSize + slots.reduce((n, s) => n + 8 + s.body.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0xfade0cc0, false);
  v.setUint32(4, total, false);
  v.setUint32(8, slots.length, false);
  let at = headerSize;
  slots.forEach((slot, i) => {
    v.setUint32(12 + i * 8, slot.type, false);
    v.setUint32(12 + i * 8 + 4, at, false);
    v.setUint32(at, slot.magic, false);
    v.setUint32(at + 4, 8 + slot.body.length, false);
    out.set(slot.body, at + 8);
    at += 8 + slot.body.length;
  });
  return out;
}

/** A SuperBlob holding one CMS signature blob in slot 0x10000. */
export function buildCodeSignature(cms: Uint8Array): Uint8Array {
  return buildSuperBlob([{ type: 0x10000, magic: 0xfade0b01, body: cms }]);
}

/** An encrypted image: the version 2 header, `encrcdsa`, followed by noise. */
export function buildEncryptedDmg(version: 1 | 2 = 2): Uint8Array {
  const out = new Uint8Array(4096).fill(0x5a);
  if (version === 2) {
    out.set(utf8('encrcdsa'), 0);
  } else {
    out.set(utf8('cdsaencr'), out.length - 8);
  }
  return out;
}

export interface KeySlot {
  type: number;
  /** For a passphrase slot (type 1). */
  iterations?: number;
}

export interface EncryptedV2Spec {
  algorithm?: number;
  keyBits?: number;
  blockSize?: number;
  slots?: KeySlot[];
  /** Claim this many slots in the header regardless of how many are written. */
  declaredCount?: number;
  /** Cut the file to this many bytes. */
  length?: number;
}

/** A version 2 `encrcdsa` header with a key-item list (layout as in src/pkg/dmgEncryption.ts). */
export function buildEncryptedV2(spec: EncryptedV2Spec = {}): Uint8Array {
  const slots = spec.slots ?? [{ type: 1, iterations: 250000 }];
  const out = new Uint8Array(4096);
  const v = new DataView(out.buffer);
  out.set(utf8('encrcdsa'), 0);
  v.setUint32(8, 2, false);
  v.setUint32(12, 16, false);
  v.setUint32(16, 5, false);
  v.setUint32(20, spec.algorithm ?? 0x80000001, false);
  v.setUint32(24, spec.keyBits ?? 128, false);
  v.setUint32(0x34, spec.blockSize ?? 512, false);
  v.setBigUint64(0x38, 1n << 20n, false);
  v.setBigUint64(0x40, 0x1000n, false);
  v.setUint32(0x48, spec.declaredCount ?? slots.length, false);
  let blobAt = 0x4c + 20 * Math.max(slots.length, 0) + 16;
  slots.forEach((slot, i) => {
    const at = 0x4c + i * 20;
    v.setUint32(at, slot.type, false);
    v.setBigUint64(at + 4, BigInt(blobAt), false);
    v.setBigUint64(at + 12, 0x68n, false);
    if (slot.type === 1) {
      v.setUint32(blobAt, 0x67, false);
      v.setBigUint64(blobAt + 4, BigInt(slot.iterations ?? 1000), false);
    }
    blobAt += 0x70;
  });
  return spec.length === undefined ? out : out.subarray(0, spec.length);
}

/** A version 1 image: a header block, then the 20-byte `cdsaencr` trailer pointing at it. */
export function buildEncryptedV1(
  spec: { keyBits?: number; iterations?: number; blockSize?: number } = {},
): Uint8Array {
  const out = new Uint8Array(0x4e8 + 20 + 100);
  const v = new DataView(out.buffer);
  const header = 100;
  v.setUint32(header + 0x10, spec.blockSize ?? 512, false);
  v.setBigUint64(header + 0x2c, BigInt(spec.iterations ?? 1000), false);
  v.setUint32(header + 0x60, 0x80000001, false);
  v.setUint32(header + 0x64, spec.keyBits ?? 128, false);
  const t = out.length - 20;
  v.setBigUint64(t, BigInt(header), false);
  v.setUint32(t + 8, 1, false);
  out.set(utf8('cdsaencr'), t + 12);
  return out;
}
