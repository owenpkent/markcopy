// Recognising a password-protected Office file, so the previews can say so.
//
// Office does not encrypt inside the zip. It wraps the whole document in an OLE
// compound file whose two root streams are `EncryptionInfo` (how it was
// encrypted) and `EncryptedPackage` (the scrambled zip). Left alone, that file
// fails the zip check and the person sees "not a workbook", which sounds like
// damage. This module names it instead.
//
// It only labels. It never asks for a password, never decrypts, and never says
// anything about whether the file is safe. Free of the `vscode` module, so the
// wording unit-tests directly.
import { bytesSource, RangeReader } from '../binary/reader';
import { openCfb, STREAM } from '../pkg/cfb';
import { OpcError } from './zip';

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
// EncryptionInfo is a few hundred bytes (Standard) to a couple of kilobytes
// (Agile, which carries XML), so this is generous and stops a hostile stream.
const MAX_INFO_BYTES = 64 * 1024;

// Worded to follow the preview's "MarkCopy could not preview this workbook: ".
const LOCKED = 'it is password-protected';
const REFUSAL = 'MarkCopy does not ask for passwords or decrypt files.';

/** True when the bytes start like an OLE compound file. */
export function looksLikeCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= CFB_MAGIC.length && CFB_MAGIC.every((b, i) => bytes[i] === b);
}

const STANDARD_ALGORITHMS = new Map<number, string>([
  [0x660e, 'AES-128'],
  [0x660f, 'AES-192'],
  [0x6610, 'AES-256'],
  [0x6801, 'RC4'],
]);

/**
 * How an EncryptionInfo stream says the file was encrypted, in plain words, or
 * undefined when the stream is too short or odd to say. Never throws.
 */
export function describeEncryptionInfo(info: Uint8Array): string | undefined {
  if (info.length < 4) {
    return undefined;
  }
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const major = view.getUint16(0, true);
  const minor = view.getUint16(2, true);
  const version = `Encryption version ${major}.${minor}`;

  if (major === 4 && minor === 4) {
    // Version, reserved word, then the XML description.
    if (info.length <= 8) {
      return 'Agile encryption';
    }
    const xml = new TextDecoder('utf-8').decode(info.subarray(8, 8 + MAX_INFO_BYTES));
    const tag = /<(?:\w+:)?keyData\b[^>]*>/.exec(xml)?.[0] ?? '';
    const attribute = (name: string): string | undefined =>
      // Either quote, and XML whitespace around the equals sign.
      new RegExp(`\\b${name}[ \\t\\r\\n]*=[ \\t\\r\\n]*(?:"([^"]{1,32})"|'([^']{1,32})')`)
        .exec(tag)
        ?.slice(1)
        .find(Boolean);
    const cipher = attribute('cipherAlgorithm');
    const bits = attribute('keyBits');
    const hash = attribute('hashAlgorithm');
    const parts = ['Agile encryption'];
    if (cipher) {
      parts.push(bits ? `${cipher}-${bits}` : cipher);
    }
    if (hash) {
      parts.push(hash);
    }
    return parts.join(', ');
  }
  if (minor === 2 && (major === 2 || major === 3 || major === 4)) {
    // Version, flags, header size, then the header: AlgID at 8 and KeySize at 16 within it.
    if (info.length >= 12 + 20 && view.getUint32(8, true) >= 20) {
      const algorithm = STANDARD_ALGORITHMS.get(view.getUint32(12 + 8, true));
      if (algorithm) {
        return `Standard encryption, ${algorithm}`;
      }
    }
    return 'Standard encryption';
  }
  if (minor === 3 && (major === 3 || major === 4)) {
    return 'Extensible encryption';
  }
  return version;
}

/**
 * The notice to show for a password-protected Office file, or undefined when the
 * bytes are not one (not a compound file, or one without both encryption streams).
 * A damaged compound file also gives undefined, so the ordinary refusal applies.
 */
export async function protectedFileNotice(bytes: Uint8Array): Promise<string | undefined> {
  if (!looksLikeCompoundFile(bytes)) {
    return undefined;
  }
  try {
    const cfb = await openCfb(new RangeReader(bytesSource(bytes)));
    const stream = (name: string) => cfb.entries.find((e) => e.type === STREAM && e.name === name);
    const info = stream('EncryptionInfo');
    if (!info || !stream('EncryptedPackage')) {
      return undefined;
    }
    let method: string | undefined;
    try {
      method = describeEncryptionInfo(await cfb.readStream(info, MAX_INFO_BYTES));
    } catch {
      // A cut or oversized EncryptionInfo still leaves the file recognisably locked.
    }
    return method ? `${LOCKED} (${method}), and ${REFUSAL}` : `${LOCKED}, and ${REFUSAL}`;
  } catch {
    return undefined;
  }
}

/** Throws the notice as the preview's usual format error when the file is password-protected. */
export async function refuseProtectedFile(bytes: Uint8Array): Promise<void> {
  const notice = await protectedFileNotice(bytes);
  if (notice !== undefined) {
    throw new OpcError(notice);
  }
}
