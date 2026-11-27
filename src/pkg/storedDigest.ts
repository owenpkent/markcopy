// Checking a digest that a package stores about its own bytes.
//
// A package can carry a hash of part of itself (an RPM's header digests, an
// Alpine package's `datahash`). The preview shows the stored value as before and
// recomputes it here, so a reader can see whether the bytes on disk are the ones
// the stored value names. A match says only that. It is not a signature check, it
// does not say who made the file, and a difference is reported without a cause.
//
// The check never fails the preview: every way it cannot run becomes a sentence.
// No `vscode` import: this runs in the worker thread.
import { createHash } from 'node:crypto';
import { formatBytesShort } from '../binary/html';
import type { RangeReader } from '../binary/reader';

export interface DigestAlgorithm {
  /** The name for `createHash`. */
  node: string;
  /** The name shown. */
  label: string;
  /** Hex characters in a digest. */
  hexLength: number;
}

export const SHA1: DigestAlgorithm = { node: 'sha1', label: 'SHA-1', hexLength: 40 };
export const SHA256: DigestAlgorithm = { node: 'sha256', label: 'SHA-256', hexLength: 64 };
export const SHA384: DigestAlgorithm = { node: 'sha384', label: 'SHA-384', hexLength: 96 };
export const SHA512: DigestAlgorithm = { node: 'sha512', label: 'SHA-512', hexLength: 128 };
export const MD5: DigestAlgorithm = { node: 'md5', label: 'MD5', hexLength: 32 };
export const SHA3_256: DigestAlgorithm = { node: 'sha3-256', label: 'SHA3-256', hexLength: 64 };

// Hashing reads every byte of the range, as hashing the whole file does, so the
// same ceiling applies.
export const CHECK_LIMIT = 256 * 1024 * 1024;

/**
 * The sentence for one stored digest: whether the digest of `start` up to `end`
 * of the file equals `stored`. Hex is compared without regard to case.
 */
export function checkStoredDigest(
  reader: RangeReader,
  algorithm: DigestAlgorithm,
  stored: string,
  start: number,
  end: number,
): Promise<string> {
  return checkStoredDigestRanges(reader, algorithm, stored, [[start, end]]);
}

/**
 * As checkStoredDigest, for a digest over several ranges of the file, each as
 * [start, end), hashed in the order given. A digest that skips parts of the
 * file (an Authenticode image hash) names the ranges it keeps.
 */
export async function checkStoredDigestRanges(
  reader: RangeReader,
  algorithm: DigestAlgorithm,
  stored: string,
  ranges: [number, number][],
): Promise<string> {
  const name = algorithm.label;
  const wanted = stored.trim().toLowerCase();
  if (wanted.length !== algorithm.hexLength || !/^[0-9a-f]+$/.test(wanted)) {
    return `Not checked: the stored value is not a ${name} digest.`;
  }
  let total = 0;
  for (const [start, end] of ranges) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return 'Not checked: the range the digest covers is not valid.';
    }
    if (end > reader.size) {
      return 'Not checked: the file ends before the data the digest covers.';
    }
    total += end - start;
  }
  if (total > CHECK_LIMIT) {
    return `Not checked: the data the digest covers is over ${formatBytesShort(CHECK_LIMIT)}.`;
  }
  const hash = createHash(algorithm.node);
  try {
    for (const [start, end] of ranges) {
      await reader.scan(start, end - start, (chunk) => hash.update(chunk));
    }
  } catch {
    return 'Not checked: the file could not be read to the end of the data the digest covers.';
  }
  return hash.digest('hex') === wanted
    ? `The computed ${name} matches the stored digest.`
    : `The computed ${name} differs from the stored digest.`;
}
