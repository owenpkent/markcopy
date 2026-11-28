// The signer an APK Signature Scheme v2, v3 or v3.1 block names.
//
// Those schemes keep their signatures in the APK Signing Block, as pairs of an
// ID and a value. A value is a length-prefixed list of length-prefixed signers;
// a signer holds its signed data (digests, then X.509 certificates), the
// signatures and the public key. Everything is little-endian, and every length
// has to fit inside the thing that holds it, or reading stops there.
//
// Like the rest of the signature code this verifies NOTHING: not the
// signatures, not the digests over the APK, not the certificate chain. What it
// returns is what the block claims.

import { readCertificate, type Signer } from './signature';

// Newest scheme first: Android uses the newest one it supports.
export const APK_SCHEME_IDS = [
  { id: 0x1b93ad61, name: 'v3.1', hasSdkRange: true },
  { id: 0xf05368c0, name: 'v3', hasSdkRange: true },
  { id: 0x7109871a, name: 'v2', hasSdkRange: false },
] as const;

const MAX_SIGNERS = 16;

// A Map, not an object literal: the ids come from the file.
const ALGORITHMS = new Map<number, string>([
  [0x0101, 'RSASSA-PSS with SHA-256'],
  [0x0102, 'RSASSA-PSS with SHA-512'],
  [0x0103, 'RSA PKCS #1 v1.5 with SHA-256'],
  [0x0104, 'RSA PKCS #1 v1.5 with SHA-512'],
  [0x0201, 'ECDSA with SHA-256'],
  [0x0202, 'ECDSA with SHA-512'],
  [0x0301, 'DSA with SHA-256'],
  [0x0421, 'RSA PKCS #1 v1.5 with SHA-256 (verity)'],
  [0x0423, 'ECDSA with SHA-256 (verity)'],
  [0x0425, 'DSA with SHA-256 (verity)'],
]);

interface Range {
  start: number;
  end: number;
}

const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** A u32 length then that many bytes, starting at `at` and held inside `limit`. */
function prefixed(b: Uint8Array, at: number, limit: number): Range | undefined {
  if (at + 4 > limit) {
    return undefined;
  }
  const length = u32(b, at);
  const start = at + 4;
  return length <= limit - start ? { start, end: start + length } : undefined;
}

/** The length-prefixed items of a length-prefixed sequence, at most `max`. */
function items(b: Uint8Array, sequence: Range, max: number): Range[] {
  const out: Range[] = [];
  let at = sequence.start;
  while (at < sequence.end && out.length < max) {
    const item = prefixed(b, at, sequence.end);
    if (!item) {
      break;
    }
    out.push(item);
    at = item.end;
  }
  return out;
}

export interface ApkSigner {
  signer?: Signer;
  /** How many signers the block lists, at most 16. */
  count: number;
}

/**
 * The first signer of a v2, v3 or v3.1 block value, with how many there are.
 * It never throws: whatever does not parse is left out.
 */
export function readApkSigner(value: Uint8Array, hasSdkRange: boolean): ApkSigner {
  const all = prefixed(value, 0, value.length);
  const signers = all ? items(value, all, MAX_SIGNERS) : [];
  const first = signers[0];
  if (!first) {
    return { count: 0 };
  }
  // signer: signed data, [minSdk, maxSdk in v3], signatures, public key.
  const signedData = prefixed(value, first.start, first.end);
  if (!signedData) {
    return { count: signers.length };
  }
  const signatures = prefixed(value, signedData.end + (hasSdkRange ? 8 : 0), first.end);
  const algorithm = signatures ? items(value, signatures, 1)[0] : undefined;
  const id =
    algorithm && algorithm.end - algorithm.start >= 4 ? u32(value, algorithm.start) : undefined;
  const algorithmName =
    id === undefined ? undefined : (ALGORITHMS.get(id) ?? `0x${id.toString(16).padStart(4, '0')}`);

  // signed data: digests, certificates, [minSdk, maxSdk, attributes in v3].
  const digests = prefixed(value, signedData.start, signedData.end);
  const certificates = digests ? prefixed(value, digests.end, signedData.end) : undefined;
  const certificate = certificates ? items(value, certificates, 1)[0] : undefined;
  const signer = certificate
    ? readCertificate(value.subarray(certificate.start, certificate.end))
    : undefined;
  if (signer && algorithmName) {
    signer.signatureAlgorithm = algorithmName;
  }
  return { signer, count: signers.length };
}
