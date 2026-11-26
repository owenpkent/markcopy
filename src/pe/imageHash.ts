// The image hash an Authenticode signature stores, and the check of it.
//
// The signed content of a PKCS #7 SignedData is an SpcIndirectDataContent
// (1.3.6.1.4.1.311.2.1.4) whose DigestInfo holds the digest of the image as
// the signer saw it: the file from offset 0 to its end, leaving out the
// header's CheckSum field, the certificate-table entry in the data directory,
// and the certificate table itself. Recomputing it says whether the bytes on
// disk are the ones that digest names. It is not a signature check: nothing
// here looks at the signature, the chain or who signed, and a stolen
// certificate signs a matching hash as well as any.
//
// Only the primary signature's digest is read. A nested signature (unsigned
// attribute 1.3.6.1.4.1.311.2.4.1) is not looked at.
//
// The DER walk is self-contained, so this file stands apart from signer.ts.
// No `vscode` import: this runs in the worker thread.

import type { RangeReader } from '../binary/reader';
import {
  checkStoredDigestRanges,
  MD5,
  SHA1,
  SHA256,
  SHA384,
  SHA512,
  type DigestAlgorithm,
} from '../pkg/storedDigest';

export interface PeImageHash {
  /** The algorithm OID as dotted digits, when the DigestInfo could be read. */
  oid?: string;
  /** The algorithm's name, when MarkCopy knows it. */
  algorithm?: string;
  /** The stored digest as lowercase hex, when the DigestInfo could be read. */
  stored?: string;
  /** The sentence for the check. */
  check: string;
}

/** Where the skipped parts of the file are, as the headers place them. */
export interface ImageLayout {
  /** Offset of the 4-byte CheckSum field. */
  checksumAt: number;
  /** Offset of the 8-byte certificate-table entry in the data directory. */
  directoryAt: number;
  /** The certificate table as the data directory states it. */
  table: { address: number; size: number };
}

const ALGORITHMS: Record<string, DigestAlgorithm> = {
  '1.2.840.113549.2.5': MD5,
  '1.3.14.3.2.26': SHA1,
  '2.16.840.1.101.3.4.2.1': SHA256,
  '2.16.840.1.101.3.4.2.2': SHA384,
  '2.16.840.1.101.3.4.2.3': SHA512,
};

// SPC_INDIRECT_DATA_OBJID.
const SPC_INDIRECT_DATA = '1.3.6.1.4.1.311.2.1.4';

interface Node {
  tag: number;
  start: number;
  end: number;
}

function nodeAt(der: Uint8Array, at: number, limit: number): Node | undefined {
  if (at + 2 > limit) {
    return undefined;
  }
  let length = der[at + 1];
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) {
      return undefined;
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + der[start++];
    }
  }
  return start + length <= limit ? { tag: der[at], start, end: start + length } : undefined;
}

function parts(der: Uint8Array, parent: Node, max: number): Node[] {
  const out: Node[] = [];
  for (let at = parent.start; at < parent.end && out.length < max;) {
    const child = nodeAt(der, at, parent.end);
    if (!child) {
      break;
    }
    out.push(child);
    at = child.end;
  }
  return out;
}

function dotted(der: Uint8Array, value: Node | undefined): string | undefined {
  if (value?.tag !== 0x06 || value.end <= value.start || value.end - value.start > 32) {
    return undefined;
  }
  const arcs: number[] = [];
  let arc = 0;
  for (let i = value.start; i < value.end; i++) {
    arc = arc * 128 + (der[i] & 0x7f);
    if (!(der[i] & 0x80)) {
      arcs.push(arc);
      arc = 0;
    }
  }
  const first = Math.min(Math.floor(arcs[0] / 40), 2);
  return [first, arcs[0] - first * 40, ...arcs.slice(1)].join('.');
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The algorithm and digest the SignedData's contentInfo stores, or undefined
 * when the DER does not have that shape.
 */
export function readImageDigest(der: Uint8Array): { oid: string; digest: Uint8Array } | undefined {
  // ContentInfo { OID, [0] SignedData }; SignedData { version, digestAlgorithms,
  // contentInfo { OID, [0] SpcIndirectDataContent { data, messageDigest DigestInfo } }, ... }
  const outer = nodeAt(der, 0, der.length);
  const wrapped = outer?.tag === 0x30 ? parts(der, outer, 2)[1] : undefined;
  const signed = wrapped?.tag === 0xa0 ? nodeAt(der, wrapped.start, wrapped.end) : undefined;
  const content = signed?.tag === 0x30 ? parts(der, signed, 3)[2] : undefined;
  if (content?.tag !== 0x30) {
    return undefined;
  }
  const [type, explicit] = parts(der, content, 2);
  if (dotted(der, type) !== SPC_INDIRECT_DATA || explicit?.tag !== 0xa0) {
    return undefined;
  }
  const indirect = nodeAt(der, explicit.start, explicit.end);
  const info = indirect?.tag === 0x30 ? parts(der, indirect, 2)[1] : undefined;
  if (info?.tag !== 0x30) {
    return undefined;
  }
  const [algorithm, digest] = parts(der, info, 2);
  const oid = algorithm?.tag === 0x30 ? dotted(der, parts(der, algorithm, 1)[0]) : undefined;
  if (!oid || digest?.tag !== 0x04 || digest.end === digest.start) {
    return undefined;
  }
  return { oid, digest: der.subarray(digest.start, digest.end) };
}

/**
 * The stored image digest of a signature and the sentence for whether the
 * file still hashes to it. Never throws: each way the check cannot run is a
 * sentence beginning "Not checked".
 */
export async function checkImageHash(
  reader: RangeReader,
  der: Uint8Array,
  layout: ImageLayout,
): Promise<PeImageHash> {
  let stored: ReturnType<typeof readImageDigest>;
  try {
    stored = readImageDigest(der);
  } catch {
    stored = undefined;
  }
  if (!stored) {
    return { check: "Not checked: the signature's stored digest could not be read." };
  }
  const algorithm = ALGORITHMS[stored.oid];
  const found = { oid: stored.oid, algorithm: algorithm?.label, stored: hex(stored.digest) };
  if (!algorithm) {
    return {
      ...found,
      check: 'Not checked: MarkCopy does not compute the digest algorithm the signature names.',
    };
  }
  const { checksumAt, directoryAt, table } = layout;
  const tableEnd = table.address + table.size;
  if (
    !Number.isSafeInteger(tableEnd) ||
    table.address < directoryAt + 8 ||
    tableEnd > reader.size
  ) {
    return {
      ...found,
      check:
        "Not checked: the certificate table overlaps the file's headers or runs past the end of the file.",
    };
  }
  try {
    return {
      ...found,
      check: await checkStoredDigestRanges(reader, algorithm, found.stored, [
        [0, checksumAt],
        [checksumAt + 4, directoryAt],
        [directoryAt + 8, table.address],
        [tableEnd, reader.size],
      ]),
    };
  } catch {
    return { ...found, check: 'Not checked: the file could not be read.' };
  }
}
