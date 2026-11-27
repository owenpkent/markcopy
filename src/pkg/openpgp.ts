// What an OpenPGP file declares about its encryption, from its packet headers
// (RFC 4880 and RFC 9580, "OpenPGP"). Binary (.gpg, .pgp) and armored (.asc)
// files are read the same way: the packets are walked, and only the fields
// that are public by design are kept: recipient key IDs, algorithm names, S2K
// type and hash, the iteration count, and the version of the data packet.
// Salts, session-key ciphertext, MPIs and the encrypted data are skipped, and
// no key is loaded, no passphrase asked for and nothing decrypted.
//
// Partial body lengths are accepted only on the data packets (literal,
// compressed, symmetrically encrypted, SEIPD, AEAD) that the specification
// allows them on; the walk stops at the first of those.
import type { RangeReader } from '../binary/reader';
import { decodeBase64 } from './base64';
import {
  ENCRYPTION_NOTE,
  NOT_DETERMINED,
  Cursor,
  Undetermined,
  count,
  hexId,
  safeText,
} from './labels';
import { propertySection, tableSection, type PackageInfo } from './model';

/** Bytes of a binary file read (a message's packet headers sit at the start). */
const MAX_BINARY_BYTES = 256 * 1024;
/** Characters of armored text read, and bytes decoded from it. */
export const MAX_ARMOR_CHARS = 1024 * 1024;
const MAX_ARMOR_DECODED = 768 * 1024;
const MAX_PACKETS = 64;
const MAX_RECIPIENTS = 32;
const MAX_LISTED = 16;

const KNOWN_TAGS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 17, 18, 19, 20, 21]);
const DATA_TAGS = new Set([8, 9, 11, 18, 20]);

const PUBLIC_KEY_ALGORITHMS: Record<number, string> = {
  1: 'RSA',
  2: 'RSA (encrypt only)',
  3: 'RSA (sign only)',
  16: 'Elgamal',
  17: 'DSA',
  18: 'ECDH',
  19: 'ECDSA',
  22: 'EdDSA (legacy)',
  25: 'X25519',
  26: 'X448',
  27: 'Ed25519',
  28: 'Ed448',
};
const SYMMETRIC: Record<number, string> = {
  1: 'IDEA (legacy)',
  2: 'TripleDES (legacy)',
  3: 'CAST5 (legacy)',
  4: 'Blowfish (legacy)',
  7: 'AES-128',
  8: 'AES-192',
  9: 'AES-256',
  10: 'Twofish',
  11: 'Camellia-128',
  12: 'Camellia-192',
  13: 'Camellia-256',
};
const AEAD: Record<number, string> = { 1: 'EAX', 2: 'OCB', 3: 'GCM' };
const HASHES: Record<number, string> = {
  1: 'MD5',
  2: 'SHA-1',
  3: 'RIPEMD-160',
  8: 'SHA-256',
  9: 'SHA-384',
  10: 'SHA-512',
  11: 'SHA-224',
  12: 'SHA3-256',
  14: 'SHA3-512',
};

const lookup = (table: Record<number, string>, id: number, what: string): string =>
  Object.hasOwn(table, id) ? table[id] : `${what} ${id}`;

export interface Packet {
  tag: number;
  /** Where the body starts, and its length when it is definite. */
  bodyStart: number;
  length: number | undefined;
  partial: boolean;
}

/** One packet header at the cursor (RFC 4880 section 4.2). */
export function readPacketHeader(c: Cursor, fileEnd: number): Packet {
  const b = c.u8();
  if ((b & 0x80) === 0) {
    throw new Undetermined('not a packet header');
  }
  let tag: number;
  let length: number | undefined;
  let partial = false;
  if (b & 0x40) {
    tag = b & 0x3f;
    const l1 = c.u8();
    if (l1 < 192) {
      length = l1;
    } else if (l1 < 224) {
      length = ((l1 - 192) << 8) + c.u8() + 192;
    } else if (l1 === 255) {
      length = c.u32be();
    } else {
      length = 1 << (l1 & 0x1f);
      partial = true;
    }
  } else {
    tag = (b >> 2) & 0x0f;
    const kind = b & 3;
    if (kind === 0) {
      length = c.u8();
    } else if (kind === 1) {
      length = c.u16be();
    } else if (kind === 2) {
      length = c.u32be();
    } else {
      length = fileEnd - c.pos;
    }
  }
  return { tag, bodyStart: c.pos, length, partial };
}

/** True when the bytes begin like an OpenPGP packet of a tag this reader knows. Cheap. */
export function looksLikePacket(head: Uint8Array, size: number): boolean {
  if (head.length < 2) {
    return false;
  }
  try {
    const c = new Cursor(head);
    const p = readPacketHeader(c, size);
    return KNOWN_TAGS.has(p.tag) && (p.length === undefined || p.partial || p.length > 0);
  } catch {
    return false;
  }
}

function s2kLabel(c: Cursor): string {
  const type = c.u8();
  if (type === 0) {
    return `S2K simple, unsalted (legacy), ${lookup(HASHES, c.u8(), 'hash')}`;
  }
  if (type === 1) {
    const hash = lookup(HASHES, c.u8(), 'hash');
    return `S2K salted, ${hash}`;
  }
  if (type === 3) {
    const hash = lookup(HASHES, c.u8(), 'hash');
    c.skip(8);
    const coded = c.u8();
    const bytes = (16 + (coded & 15)) * 2 ** ((coded >> 4) + 6);
    return `S2K iterated and salted, ${hash}, ${count(bytes)} bytes hashed`;
  }
  if (type === 4) {
    c.skip(16);
    const passes = c.u8();
    const lanes = c.u8();
    const memory = c.u8();
    return `S2K Argon2, ${passes} passes, ${lanes} lanes, 2^${memory} KiB memory`;
  }
  return `S2K type ${type}`;
}

function keyIdText(id: Uint8Array): string {
  return id.every((b) => b === 0)
    ? 'a hidden recipient (key ID not stored)'
    : `key ID 0x${hexId(id).toUpperCase()}`;
}

interface Walk {
  recipients: string[];
  passphrases: string[];
  data: string[];
  others: string[];
  firstTag?: number;
  recipientsOmitted: number;
  stopped?: string;
}

function walk(bytes: Uint8Array, size: number): Walk {
  const out: Walk = { recipients: [], passphrases: [], data: [], others: [], recipientsOmitted: 0 };
  const c = new Cursor(bytes);
  for (let n = 0; n < MAX_PACKETS && c.left > 0; n++) {
    let p: Packet;
    try {
      p = readPacketHeader(c, size);
    } catch {
      out.stopped = 'a packet header could not be read';
      return out;
    }
    out.firstTag ??= p.tag;
    if (p.partial && !DATA_TAGS.has(p.tag)) {
      out.stopped = 'a packet uses partial lengths where they are not allowed';
      return out;
    }
    const bodyLength = p.length ?? 0;
    const available = Math.min(bodyLength, c.left);
    const body = new Cursor(bytes, p.bodyStart, p.bodyStart + available);
    try {
      describe(p.tag, body, out);
    } catch {
      out.others.push(`packet ${p.tag} (${NOT_DETERMINED})`);
    }
    if (DATA_TAGS.has(p.tag) || p.partial) {
      return out;
    }
    if (bodyLength > c.left) {
      out.stopped = 'the file ends inside a packet';
      return out;
    }
    c.pos = p.bodyStart + bodyLength;
  }
  if (c.left > 0) {
    out.stopped = `only the first ${MAX_PACKETS} packets were read`;
  }
  return out;
}

function describe(tag: number, b: Cursor, out: Walk): void {
  switch (tag) {
    case 1: {
      const version = b.u8();
      let id: Uint8Array;
      if (version === 3) {
        id = b.take(8);
      } else if (version === 6) {
        const len = b.u8();
        if (len === 0) {
          id = new Uint8Array(8);
        } else {
          const keyVersion = b.u8();
          const fp = b.take(len - 1);
          id = keyVersion === 6 ? fp.subarray(0, 8) : fp.subarray(Math.max(0, fp.length - 8));
        }
      } else {
        throw new Undetermined('unknown PKESK version');
      }
      const algorithm = lookup(PUBLIC_KEY_ALGORITHMS, b.u8(), 'public-key algorithm');
      pushRecipient(out, `Encrypted to ${keyIdText(id)} (${algorithm})`);
      return;
    }
    case 3: {
      const version = b.u8();
      if (version === 4) {
        const cipher = lookup(SYMMETRIC, b.u8(), 'cipher');
        out.passphrases.push(`Encrypted with a passphrase (${s2kLabel(b)}, ${cipher})`);
      } else if (version === 6) {
        b.u8();
        const cipher = lookup(SYMMETRIC, b.u8(), 'cipher');
        const aead = lookup(AEAD, b.u8(), 'AEAD');
        b.u8();
        out.passphrases.push(`Encrypted with a passphrase (${s2kLabel(b)}, ${cipher}, ${aead})`);
      } else {
        out.passphrases.push(
          `Encrypted with a passphrase (${NOT_DETERMINED}: SKESK version ${version})`,
        );
      }
      return;
    }
    case 9:
      out.data.push('Legacy encrypted data packet (tag 9): legacy, no integrity protection');
      return;
    case 18: {
      const version = b.u8();
      if (version === 1) {
        out.data.push('Encrypted data with integrity protection (SEIPD v1, MDC)');
      } else if (version === 2) {
        const cipher = lookup(SYMMETRIC, b.u8(), 'cipher');
        const aead = lookup(AEAD, b.u8(), 'AEAD');
        out.data.push(`Encrypted data, SEIPD v2 (AEAD ${aead}, ${cipher})`);
      } else {
        out.data.push(`Encrypted data, SEIPD version ${version} (${NOT_DETERMINED})`);
      }
      return;
    }
    case 20: {
      b.u8();
      const cipher = lookup(SYMMETRIC, b.u8(), 'cipher');
      const aead = lookup(AEAD, b.u8(), 'AEAD');
      out.data.push(`AEAD encrypted data packet (tag 20, ${aead}, ${cipher})`);
      return;
    }
    case 12:
      out.others.push('Trust packet');
      return;
    case 13:
      out.others.push('User ID');
      return;
    case 17:
      out.others.push('User attribute');
      return;
    case 2:
      out.others.push('OpenPGP signature');
      return;
    case 4:
      out.others.push('One-pass signature (a signed message)');
      return;
    case 6:
    case 14:
      out.others.push('OpenPGP public key');
      return;
    case 5:
    case 7:
      out.others.push('OpenPGP secret key');
      return;
    case 8:
      out.others.push('Compressed data (not read further)');
      return;
    case 11:
      out.others.push('Literal data (not encrypted)');
      return;
    default:
      out.others.push(`Packet type ${tag}`);
  }
}

function pushRecipient(out: Walk, text: string): void {
  if (out.recipients.length < MAX_RECIPIENTS) {
    out.recipients.push(text);
  } else {
    out.recipientsOmitted++;
  }
}

/** True when the file starts, after any white space, with an OpenPGP armor line. */
export function looksArmored(head: Uint8Array): boolean {
  return /^\s*-----BEGIN PGP /.test(new TextDecoder().decode(head.subarray(0, 64)));
}

/** What the first armored block of `text` is, and its binary packets. */
export function dearmor(text: string): { label: string; bytes: Uint8Array } | undefined {
  const lines = text.slice(0, MAX_ARMOR_CHARS).split(/\r?\n/);
  const begin = lines.findIndex((l) => l.startsWith('-----BEGIN PGP '));
  if (begin < 0) {
    return undefined;
  }
  const label = lines[begin].slice('-----BEGIN '.length).replace(/-+$/, '');
  if (label === 'PGP SIGNED MESSAGE') {
    return { label, bytes: new Uint8Array(0) };
  }
  let i = begin + 1;
  // Armor headers (Version, Comment) run to the first blank line.
  while (i < lines.length && lines[i].trim() !== '') {
    if (lines[i].startsWith('-----')) {
      break;
    }
    i++;
  }
  const body: string[] = [];
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('-----') || line.startsWith('=')) {
      break;
    }
    body.push(line);
  }
  return { label, bytes: decodeBase64(body.join(''), MAX_ARMOR_DECODED) };
}

function classify(w: Walk): string {
  if (w.recipients.length > 0 || w.passphrases.length > 0 || w.data.length > 0) {
    return 'An encrypted OpenPGP message';
  }
  if (w.firstTag === 6 || w.firstTag === 14) {
    return 'An OpenPGP public key';
  }
  if (w.firstTag === 5 || w.firstTag === 7) {
    return 'An OpenPGP secret key';
  }
  if (w.firstTag === 2) {
    return 'An OpenPGP signature';
  }
  return 'An OpenPGP file that is not an encrypted message';
}

/** What the file declares. Never throws. */
export async function readOpenPgp(reader: RangeReader): Promise<PackageInfo> {
  const warnings: string[] = [];
  let armored = false;
  let label = '';
  let bytes: Uint8Array = new Uint8Array(0);
  let size = reader.size;
  try {
    const head = await reader.upTo(0, Math.min(reader.size, MAX_ARMOR_CHARS));
    if (looksArmored(head)) {
      armored = true;
      const result = dearmor(new TextDecoder().decode(head));
      label = result?.label ?? '';
      bytes = result?.bytes ?? new Uint8Array(0);
      size = bytes.length;
    } else {
      bytes = head.subarray(0, MAX_BINARY_BYTES);
    }
  } catch {
    warnings.push('The file could not be read.');
  }
  if (armored && label === 'PGP SIGNED MESSAGE') {
    return {
      format: 'OpenPGP cleartext signed message',
      summary: 'A cleartext signed message: the text is not encrypted.',
      sections: propertySection(
        'Encryption',
        [
          ['Kind', 'OpenPGP cleartext signed message'],
          ['Encryption', 'none (the text is readable)'],
        ],
        ENCRYPTION_NOTE,
      ),
      warnings,
    };
  }
  const w = walk(bytes, size);
  const rows: [string, string][] = [['Kind', classify(w)]];
  if (armored) {
    rows.push(['Armor', label ? `ASCII armor (${safeText(label, 48)})` : 'ASCII armor']);
  }
  const encrypted = w.recipients.length + w.passphrases.length + w.data.length > 0;
  if (encrypted) {
    rows.push(['Public-key recipients', count(w.recipients.length + w.recipientsOmitted)]);
    rows.push(['Passphrase recipients', count(w.passphrases.length)]);
    for (const d of w.data) {
      rows.push(['Data', d]);
    }
  } else {
    rows.push(['Encrypted message', 'no']);
  }
  const kinds = new Map<string, number>();
  for (const o of w.others) {
    kinds.set(o, (kinds.get(o) ?? 0) + 1);
  }
  for (const [kind, n] of [...kinds].slice(0, MAX_LISTED)) {
    rows.push(['Contains', n > 1 ? `${kind} (${count(n)} packets)` : kind]);
  }
  if (w.stopped) {
    rows.push(['Read', `${NOT_DETERMINED} beyond this point (${w.stopped})`]);
  }
  const recipientRows = [...w.passphrases, ...w.recipients].map((r) => [r]);
  return {
    format: armored ? 'OpenPGP file (ASCII armor)' : 'OpenPGP file',
    summary: classify(w) + '.',
    sections: [
      ...propertySection('Encryption', rows, ENCRYPTION_NOTE),
      ...tableSection('Recipients', ['Recipient'], recipientRows, {
        limit: MAX_LISTED,
        total: recipientRows.length + w.recipientsOmitted,
        noun: 'recipients',
      }),
    ],
    warnings,
  };
}
