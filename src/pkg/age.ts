// What an age-encrypted file declares: the recipient stanzas in its text
// header (the age v1 specification, C2SP/age.md). Stanzas are counted by type;
// of their arguments only scrypt's work factor is read, because it is a public
// cost parameter. Recipient shares, salts, wrapped file keys, the header MAC and
// the payload are never read into a result. No identity is loaded and nothing is
// decrypted.
import type { RangeReader } from '../binary/reader';
import { decodeBase64 } from './base64';
import { ENCRYPTION_NOTE, NOT_DETERMINED, count, safeText } from './labels';
import { propertySection, type PackageInfo } from './model';

export const AGE_MAGIC = 'age-encryption.org/v1';
export const AGE_ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
/** Header text read from a binary file, and armor text read from an armored one. */
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ARMOR_CHARS = 128 * 1024;
const MAX_LINES = 4096;
const MAX_STANZAS = 1000;
const MAX_TYPES = 16;
/** The largest scrypt work factor age itself accepts when decrypting. */
const MAX_LOG_N = 30;

export interface AgeStanza {
  type: string;
  count: number;
  /** For scrypt: the work factor exponents seen. */
  logN: number[];
}

const NAMES: Record<string, string> = {
  X25519: 'X25519 recipient',
  scrypt: 'Passphrase (scrypt)',
  'ssh-ed25519': 'SSH ed25519 recipient',
  'ssh-rsa': 'SSH RSA recipient',
};

/** Parse a header's text: the stanza types and counts, or undefined when it is not an age header. */
export function parseAgeHeader(text: string):
  | {
      stanzas: AgeStanza[];
      total: number;
      truncated: boolean;
      ended: boolean;
    }
  | undefined {
  const lines = text.split('\n', MAX_LINES);
  if (lines[0] !== AGE_MAGIC) {
    return undefined;
  }
  const byType = new Map<string, AgeStanza>();
  let total = 0;
  let ended = false;
  let truncated = lines.length >= MAX_LINES;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('---')) {
      ended = true;
      break;
    }
    if (!line.startsWith('-> ')) {
      continue;
    }
    if (total >= MAX_STANZAS) {
      truncated = true;
      break;
    }
    total++;
    const args = line.slice(3).split(' ');
    const type = safeText(args[0] ?? '', 48);
    let stanza = byType.get(type);
    if (!stanza) {
      if (byType.size >= MAX_TYPES) {
        truncated = true;
        continue;
      }
      stanza = { type, count: 0, logN: [] };
      byType.set(type, stanza);
    }
    stanza.count++;
    if (type === 'scrypt' && args.length === 3 && /^[0-9]{1,2}$/.test(args[2])) {
      const logN = Number(args[2]);
      if (logN <= MAX_LOG_N && !stanza.logN.includes(logN) && stanza.logN.length < 4) {
        stanza.logN.push(logN);
      }
    }
  }
  return { stanzas: [...byType.values()], total, truncated, ended };
}

/** The header text of a file: binary as is, armored decoded from the first block. */
export function ageHeaderText(head: Uint8Array): { text: string; armored: boolean } | undefined {
  const raw = new TextDecoder('latin1').decode(head.subarray(0, MAX_ARMOR_CHARS));
  if (raw.startsWith(AGE_MAGIC + '\n')) {
    return { text: raw.slice(0, MAX_HEADER_BYTES), armored: false };
  }
  if (raw.startsWith(AGE_ARMOR_BEGIN)) {
    const lines = raw.split(/\r?\n/);
    const body: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith('-----')) {
        break;
      }
      body.push(lines[i]);
    }
    const bytes = decodeBase64(body.join(''), MAX_HEADER_BYTES);
    return { text: new TextDecoder('latin1').decode(bytes), armored: true };
  }
  return undefined;
}

function label(s: AgeStanza): [string, string] {
  if (s.type === 'scrypt') {
    const cost =
      s.logN.length > 0
        ? `work factor ${s.logN.map((n) => `2^${n}`).join(', ')}`
        : `work factor ${NOT_DETERMINED}`;
    return [NAMES.scrypt, `${count(s.count)} (${cost})`];
  }
  if (Object.hasOwn(NAMES, s.type)) {
    return [NAMES[s.type], count(s.count)];
  }
  return [`Plugin: ${s.type || NOT_DETERMINED}`, count(s.count)];
}

/** What the file declares. Never throws. */
export async function readAge(reader: RangeReader): Promise<PackageInfo> {
  const warnings: string[] = [];
  let parsed: ReturnType<typeof parseAgeHeader>;
  let armored = false;
  try {
    const head = await reader.upTo(0, Math.min(reader.size, MAX_ARMOR_CHARS));
    const found = ageHeaderText(head);
    armored = found?.armored ?? false;
    parsed = found ? parseAgeHeader(found.text) : undefined;
  } catch {
    parsed = undefined;
  }
  const rows: [string, string][] = [['Format', armored ? 'age v1 (ASCII armor)' : 'age v1']];
  if (!parsed) {
    rows.push(['Recipients', `${NOT_DETERMINED} (the header could not be read)`]);
    warnings.push('The age header could not be read.');
  } else {
    rows.push(['Recipient stanzas', `${count(parsed.total)}${parsed.truncated ? ' or more' : ''}`]);
    for (const s of parsed.stanzas) {
      rows.push(label(s));
    }
    rows.push(['Payload cipher', 'ChaCha20-Poly1305 (fixed by the age v1 format)']);
    if (!parsed.ended) {
      rows.push(['Header', `${NOT_DETERMINED} beyond the first ${count(MAX_HEADER_BYTES)} bytes`]);
    }
  }
  return {
    format: armored ? 'age encrypted file (ASCII armor)' : 'age encrypted file',
    summary: 'An age-encrypted file. The labels below come from its header only.',
    sections: propertySection('Encryption', rows, ENCRYPTION_NOTE),
    warnings,
  };
}
