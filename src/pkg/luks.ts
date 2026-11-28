// What a LUKS volume declares about its encryption, from its header (the LUKS1
// on-disk format specification and the LUKS2 on-disk format specification,
// both from the cryptsetup project). Only names and parameters are read: the
// cipher, hash and key size, which key slots are in use and their key
// derivation cost, and (LUKS2) the segments, the keyslot types and tokens by
// type. Digests, salts, key material areas and the volume's data are never
// read into a result, no passphrase is used and nothing is unlocked.
//
// LUKS1 is a fixed 592-byte big-endian header. LUKS2 is a 4096-byte binary
// header followed by a JSON area of the size the header states; that area is
// read up to a cap and parsed in a try.
import { formatBytesShort } from '../binary/html';
import type { RangeReader } from '../binary/reader';
import { ENCRYPTION_NOTE, NOT_DETERMINED, ascii, count, safeText } from './labels';
import { propertySection, tableSection, type PackageInfo } from './model';

export const LUKS_MAGIC = [0x4c, 0x55, 0x4b, 0x53, 0xba, 0xbe];

const LUKS1_HEADER = 592;
const LUKS1_SLOTS = 8;
const SLOT_ACTIVE = 0x00ac71f3;
const LUKS2_BINARY = 4096;
/** The most of the JSON area that is read, whatever the header says. */
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_KEYSLOTS = 32;
const MAX_SEGMENTS = 32;
const MAX_TOKENS = 256;
const MAX_TOKEN_TYPES = 16;

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return safeText(ascii(end < 0 ? bytes : bytes.subarray(0, end)), 48);
}

function luks1(h: DataView, bytes: Uint8Array): PackageInfo {
  const cipher = `${text(bytes.subarray(8, 40))}-${text(bytes.subarray(40, 72))}`;
  const hash = text(bytes.subarray(72, 104));
  const keyBytes = h.getUint32(108, false);
  const digestIterations = h.getUint32(164, false);
  const slots: string[][] = [];
  for (let i = 0; i < LUKS1_SLOTS; i++) {
    const at = 208 + i * 48;
    if (h.getUint32(at, false) === SLOT_ACTIVE) {
      slots.push([
        `Slot ${i}`,
        'active',
        `PBKDF2 (${hash}), ${count(h.getUint32(at + 4, false))} iterations`,
      ]);
    }
  }
  const rows: [string, string][] = [
    ['Format version', 'LUKS1'],
    ['Cipher', cipher],
    ['Hash', hash],
    ['Key size', keyBytes >= 1 && keyBytes <= 1024 ? `${keyBytes * 8} bits` : NOT_DETERMINED],
    ['Active key slots', `${slots.length} of ${LUKS1_SLOTS}`],
    ['Master key check', `PBKDF2 (${hash}), ${count(digestIterations)} iterations`],
  ];
  return {
    format: 'LUKS volume (LUKS1)',
    summary: 'A LUKS1 encrypted volume. Everything after the header is encrypted.',
    sections: [
      ...propertySection('Encryption', rows, ENCRYPTION_NOTE),
      ...tableSection('Key slots', ['Slot', 'State', 'Key derivation'], slots),
    ],
    warnings: [],
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 48): string =>
  typeof v === 'string' ? safeText(v, max) : NOT_DETERMINED;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

function kdfLabel(kdf: unknown): string {
  if (!isObject(kdf)) {
    return NOT_DETERMINED;
  }
  const type = str(kdf.type, 24);
  if (type === 'pbkdf2') {
    const iterations = num(kdf.iterations);
    return `PBKDF2 (${str(kdf.hash, 24)}), ${iterations === undefined ? NOT_DETERMINED : count(iterations)} iterations`;
  }
  if (type === 'argon2i' || type === 'argon2id') {
    const time = num(kdf.time);
    const memory = num(kdf.memory);
    const cpus = num(kdf.cpus);
    return `${type === 'argon2id' ? 'Argon2id' : 'Argon2i'}, ${time === undefined ? NOT_DETERMINED : count(time)} iterations, ${memory === undefined ? NOT_DETERMINED : formatBytesShort(memory * 1024)} memory, ${cpus === undefined ? NOT_DETERMINED : count(cpus)} threads`;
  }
  return type;
}

function luks2(bytes: Uint8Array, json: string | undefined): PackageInfo {
  const rows: [string, string][] = [['Format version', 'LUKS2']];
  const sections: PackageInfo['sections'] = [];
  const warnings: string[] = [];
  const checksum = text(bytes.subarray(72, 104));
  let doc: unknown;
  if (json === undefined) {
    rows.push([
      'Metadata',
      `${NOT_DETERMINED} (the JSON area is missing or larger than will be read)`,
    ]);
  } else {
    try {
      doc = JSON.parse(json);
    } catch {
      rows.push(['Metadata', `${NOT_DETERMINED} (the JSON area could not be parsed)`]);
      warnings.push('The LUKS2 JSON area could not be parsed.');
    }
  }
  if (isObject(doc)) {
    const segments = isObject(doc.segments)
      ? Object.entries(doc.segments).slice(0, MAX_SEGMENTS)
      : [];
    const keyslots = isObject(doc.keyslots)
      ? Object.entries(doc.keyslots).slice(0, MAX_KEYSLOTS)
      : [];
    const tokens = isObject(doc.tokens) ? Object.values(doc.tokens).slice(0, MAX_TOKENS) : [];
    rows.push(['Header checksum algorithm', checksum]);
    rows.push(['Key slots', count(keyslots.length)]);
    rows.push(['Segments', count(segments.length)]);
    const types = new Map<string, number>();
    for (const t of tokens) {
      const type = isObject(t) ? str(t.type, 32) : NOT_DETERMINED;
      if (types.has(type) || types.size < MAX_TOKEN_TYPES) {
        types.set(type, (types.get(type) ?? 0) + 1);
      }
    }
    rows.push([
      'Tokens',
      tokens.length === 0
        ? 'none'
        : `${count(tokens.length)} (${[...types].map(([k, n]) => `${k}: ${n}`).join(', ')})`,
    ]);
    sections.push(
      ...tableSection(
        'Segments',
        ['Segment', 'Type', 'Encryption', 'Sector size'],
        segments.map(([name, s]) => {
          const o = isObject(s) ? s : {};
          const sector = num(o.sector_size);
          return [
            safeText(name, 16),
            str(o.type, 16),
            o.type === 'crypt' ? str(o.encryption) : 'not encrypted',
            sector === undefined ? '' : count(sector),
          ];
        }),
      ),
      ...tableSection(
        'Key slots',
        ['Slot', 'Type', 'Cipher', 'Key size', 'Key derivation'],
        keyslots.map(([name, s]) => {
          const o = isObject(s) ? s : {};
          const area = isObject(o.area) ? o.area : {};
          const keySize = num(o.key_size);
          return [
            safeText(name, 16),
            str(o.type, 16),
            str(area.encryption),
            keySize === undefined ? NOT_DETERMINED : `${keySize * 8} bits`,
            kdfLabel(o.kdf),
          ];
        }),
      ),
    );
  }
  return {
    format: 'LUKS volume (LUKS2)',
    summary: 'A LUKS2 encrypted volume. Everything after the header is encrypted.',
    sections: [...propertySection('Encryption', rows, ENCRYPTION_NOTE), ...sections],
    warnings,
  };
}

/** What the volume declares. Never throws. */
export async function readLuks(reader: RangeReader): Promise<PackageInfo> {
  try {
    const bytes = await reader.upTo(0, Math.min(reader.size, LUKS2_BINARY));
    const h = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = bytes.length >= 8 ? h.getUint16(6, false) : 0;
    if (version === 1 && bytes.length >= LUKS1_HEADER) {
      return luks1(h, bytes);
    }
    if (version === 2 && bytes.length >= LUKS2_BINARY) {
      const total = Number(h.getBigUint64(8, false));
      let json: string | undefined;
      const jsonSize = total - LUKS2_BINARY;
      if (
        Number.isSafeInteger(total) &&
        jsonSize > 0 &&
        jsonSize <= MAX_JSON_BYTES &&
        total <= reader.size
      ) {
        const area = await reader.bytes(LUKS2_BINARY, jsonSize);
        const end = area.indexOf(0);
        json = new TextDecoder().decode(end < 0 ? area : area.subarray(0, end));
      }
      return luks2(bytes, json);
    }
  } catch {
    // Falls through to the not-determined page below.
  }
  return {
    format: 'LUKS volume',
    summary: 'A LUKS encrypted volume whose header could not be read.',
    sections: propertySection('Encryption', [['Header', NOT_DETERMINED]], ENCRYPTION_NOTE),
    warnings: ['The LUKS header could not be read.'],
  };
}
