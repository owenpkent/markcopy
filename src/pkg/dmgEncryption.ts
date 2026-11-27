// What an encrypted Apple disk image declares about itself, read from its
// unencrypted header. It only labels: no password is asked for, no key is
// loaded, nothing is decrypted, and nothing is said about strength.
//
// Layouts (all big-endian) follow the reverse-engineered descriptions that
// open-source tools share: nlitsme/encrypteddmg (readencrcdsa.py) for the
// version 2 header with its key-item list and for the version 1 info header and
// trailer, and the vfdecrypt / dmg2img sources for the password header. No
// Apple specification exists, so the offsets are as good as those descriptions
// and a field that does not read sensibly is shown as "not determined" rather
// than guessed.
//
//   v2 header at offset 0: "encrcdsa", version (u32 at 8), IV size (12),
//     block mode (16), block algorithm CSSM_ALGID (20), key bits (24),
//     block size (u32 at 0x34), data length (u64 at 0x38), data offset
//     (u64 at 0x40), key-item count (u32 at 0x48), then 20-byte items
//     {type u32, offset u64, size u64} from 0x4C. Item type 1 is a
//     passphrase-wrapped key (KDF algorithm u32 at +0, iteration count u64 at
//     +4), type 2 a certificate (public-key) wrapped key, type 3 a key bag.
//   v1: a 20-byte trailer {offset u64, version u32, "cdsaencr"} points at a
//     0x4E8-byte info header (block size u32 at 0x10, block algorithm at 0x60,
//     key bits at 0x64, KDF iteration count u64 at 0x2C).
import { formatBytes } from '../binary/html';
import type { RangeReader } from '../binary/reader';

/** The key items sit within the first 64 KiB of the file. */
const MAX_HEADER_BYTES = 0x10000;
const MAX_KEY_SLOTS = 16;
const ITEM_SIZE = 20;
const ITEMS_AT = 0x4c;
const V1_HEADER = 0x4e8;
const V1_TRAILER = 20;
const ALG_AES = 0x80000001;
const ALG_PBKDF2 = 0x67;
const NOT_DETERMINED = 'not determined';

export interface DmgEncryption {
  version: 1 | 2;
  /** "AES-128", or a plain "not determined". */
  cipher: string;
  /** Block size in bytes, when it reads sensibly. */
  blockSize?: number;
  /** One line per key slot, for example "Password (PBKDF2, 250,000 iterations)". */
  slots: string[];
  /** Slots beyond the cap that are not listed. */
  slotsOmitted: number;
}

function cipherLabel(algorithm: number, keyBits: number): string {
  if (algorithm !== ALG_AES) {
    return NOT_DETERMINED;
  }
  return keyBits === 128 || keyBits === 192 || keyBits === 256
    ? `AES-${keyBits}`
    : 'AES (key size not determined)';
}

function plausibleBlock(n: number): number | undefined {
  return n >= 512 && n <= 1 << 24 ? n : undefined;
}

function iterationsLabel(iterations: number): string {
  return iterations >= 1 && iterations <= 1e9
    ? `Password (PBKDF2, ${iterations.toLocaleString('en-US')} iterations)`
    : `Password (${NOT_DETERMINED})`;
}

function passphraseSlot(v: DataView, at: number, size: number): string {
  if (size < 0x0c || at + 0x0c > v.byteLength || v.getUint32(at, false) !== ALG_PBKDF2) {
    return `Password (${NOT_DETERMINED})`;
  }
  return iterationsLabel(Number(v.getBigUint64(at + 4, false)));
}

async function readV2(reader: RangeReader): Promise<DmgEncryption | undefined> {
  const bytes = await reader.bytes(0, Math.min(reader.size, MAX_HEADER_BYTES));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x28 || v.getUint32(8, false) !== 2) {
    return undefined;
  }
  const cipher = cipherLabel(v.getUint32(20, false), v.getUint32(24, false));
  const blockSize = bytes.length >= 0x38 ? plausibleBlock(v.getUint32(0x34, false)) : undefined;
  const slots: string[] = [];
  let omitted = 0;
  if (bytes.length >= ITEMS_AT) {
    const count = v.getUint32(0x48, false);
    const room = Math.floor((bytes.length - ITEMS_AT) / ITEM_SIZE);
    if (count > room && count <= MAX_KEY_SLOTS) {
      slots.push(`${NOT_DETERMINED} (the header ends early)`);
    }
    for (let i = 0; i < Math.min(count, room, MAX_KEY_SLOTS); i++) {
      const at = ITEMS_AT + i * ITEM_SIZE;
      const type = v.getUint32(at, false);
      const offset = Number(v.getBigUint64(at + 4, false));
      const size = Number(v.getBigUint64(at + 12, false));
      if (type === 1) {
        const inside = offset + size <= bytes.length;
        slots.push(inside ? passphraseSlot(v, offset, size) : `Password (${NOT_DETERMINED})`);
      } else if (type === 2) {
        slots.push('Public key');
      } else if (type === 3) {
        slots.push('Key bag');
      } else {
        slots.push(`Other (type ${type})`);
      }
    }
    omitted = Math.max(0, count - MAX_KEY_SLOTS);
  }
  return { version: 2, cipher, blockSize, slots, slotsOmitted: omitted };
}

async function readV1(reader: RangeReader): Promise<DmgEncryption | undefined> {
  if (reader.size < V1_TRAILER + V1_HEADER) {
    return undefined;
  }
  const t = await reader.view(reader.size - V1_TRAILER, V1_TRAILER);
  const offset = Number(t.getBigUint64(0, false));
  if (t.getUint32(8, false) !== 1 || offset + V1_HEADER > reader.size - V1_TRAILER) {
    return undefined;
  }
  const v = await reader.view(offset, V1_HEADER);
  return {
    version: 1,
    cipher: cipherLabel(v.getUint32(0x60, false), v.getUint32(0x64, false)),
    blockSize: plausibleBlock(v.getUint32(0x10, false)),
    slots: [iterationsLabel(Number(v.getBigUint64(0x2c, false)))],
    slotsOmitted: 0,
  };
}

/** What the encrypted image declares, or undefined when the header does not read as expected. Never throws. */
export async function readDmgEncryption(
  reader: RangeReader,
  version: 1 | 2,
): Promise<DmgEncryption | undefined> {
  try {
    return version === 2 ? await readV2(reader) : await readV1(reader);
  } catch {
    return undefined;
  }
}

/** The rows for the Disk image section. */
export function encryptionRows(info: DmgEncryption | undefined): [string, string][] {
  if (!info) {
    return [['Encryption', NOT_DETERMINED]];
  }
  const out: [string, string][] = [
    ['Encryption', info.cipher],
    ['Format version', String(info.version)],
  ];
  if (info.blockSize !== undefined) {
    out.push(['Block size', formatBytes(info.blockSize)]);
  }
  info.slots.forEach((s, i) => out.push([`Key slot ${i + 1}`, s]));
  if (info.slotsOmitted > 0) {
    out.push(['More key slots', `${info.slotsOmitted} not shown`]);
  }
  return out;
}
