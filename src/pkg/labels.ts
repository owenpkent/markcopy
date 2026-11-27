// Shared wording and small helpers for the readers that label what a file
// declares about its own encryption (7z, RAR, OpenPGP, age, KeePass, LUKS and
// key files).
//
// These files are sensitive, so the rule for every one of them is the same:
// only what the file states in unencrypted metadata is shown, as algorithm
// names, parameters (iteration counts, memory cost), counts, versions and
// public identifiers. Salts, IVs, nonces, wrapped keys, MACs, ciphertext and
// stanza arguments are never read into a result, so they cannot be shown.
import { printable, clip } from '../binary/text';

export const NOT_DETERMINED = 'not determined';

/** The small print under every encryption table. */
export const ENCRYPTION_NOTE =
  'Read from what the file states in its unencrypted header or metadata. No password was asked for or tried, no key was loaded and nothing was decrypted. A label is not a judgment of how strong the encryption is, except where a scheme is marked legacy.';

/** Text from the file, cleaned and cut, for a value shown on the page. */
export function safeText(text: string, max = 64): string {
  return clip(printable(text), max);
}

/** Latin-1 view of bytes, for fields the formats define as ASCII. */
export function ascii(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += String.fromCharCode(b);
  }
  return out;
}

/** Lower-case hex, for algorithm and method identifiers only (never for key material). */
export function hexId(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const count = (n: number): string => n.toLocaleString('en-US');

/** "2^19 iterations", or not determined when the exponent is outside what a tool writes. */
export function powerOfTwo(exponent: number, max: number): string {
  return Number.isInteger(exponent) && exponent >= 0 && exponent <= max
    ? `2^${exponent}`
    : NOT_DETERMINED;
}

/** Thrown inside a reader when a field cannot be read, and caught at its edge. */
export class Undetermined extends Error {}

/** A cursor over bytes that throws Undetermined instead of reading past the end. */
export class Cursor {
  pos: number;
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.length,
  ) {
    this.pos = start;
  }
  get left(): number {
    return this.end - this.pos;
  }
  need(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.end) {
      throw new Undetermined('the data ends early');
    }
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  u16be(): number {
    const b = this.take(2);
    return (b[0] << 8) | b[1];
  }
  u32be(): number {
    const b = this.take(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
  u16le(): number {
    const b = this.take(2);
    return b[0] | (b[1] << 8);
  }
  u32le(): number {
    const b = this.take(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  u64le(): number {
    const lo = this.u32le();
    const hi = this.u32le();
    const value = hi * 2 ** 32 + lo;
    if (!Number.isSafeInteger(value)) {
      throw new Undetermined('a number is out of range');
    }
    return value;
  }
}
