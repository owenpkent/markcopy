import { readApkSigner } from '../../src/pkg/apkSigner';
import { readImageDigest } from '../../src/pe/imageHash';
import {
  detailRows,
  isSignedData,
  readCertificate,
  readSigner,
  signerCount,
  type Signer,
} from '../../src/pe/signer';
import { CostError, hasControl, MAX_MILLISECONDS } from './binaryOracle';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// The DER and length-prefixed walkers that read who signed a file: the PKCS #7
// SignedData of an Authenticode signature, a bare X.509 certificate (a macOS
// installer's table of contents), the digest an Authenticode signature stores,
// and the APK Signature Scheme v2, v3 and v3.1 block. They read what a file
// claims and verify nothing, and each documents that it never throws, so any
// exception at all is a finding. The pe and pkg targets reach them only behind a
// whole image or archive whose certificate table or signing block survives
// mutation; here the input is the DER or the block value itself.
//
// The first byte picks the reader:
//   0  PKCS #7: isSignedData, signerCount, readSigner, readCertificate, readImageDigest
//   1  an X.509 certificate through readCertificate
//   2  an APK signing block value as v2 (3 as v3 and later, which has an SDK range)
const MODES = 4;
const THUMBPRINT = /^[0-9A-F]{40}$/;
const MAX_SIGNERS = 16;
const MAX_FIELD = 1024;

function checkSigner(label: string, signer: Signer | undefined): void {
  if (signer === undefined) {
    return;
  }
  for (const [name, value] of Object.entries(signer)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || hasControl(value) || value.length > MAX_FIELD) {
      throw new Error(
        `${label}: ${name} is ${typeof value === 'string' ? 'a control character or over-long string' : typeof value}`,
      );
    }
  }
  if (signer.thumbprint !== undefined && !THUMBPRINT.test(signer.thumbprint)) {
    throw new Error(`${label}: thumbprint ${signer.thumbprint}`);
  }
  for (const [rowLabel, rowValue] of detailRows(signer)) {
    if (hasControl(rowLabel) || (rowValue !== undefined && hasControl(rowValue))) {
      throw new Error(`${label}: a detail row holds a control character`);
    }
  }
}

export function fuzz(data: Buffer): void {
  if (data.length === 0) {
    return;
  }
  const mode = data[0] % MODES;
  const rest = new Uint8Array(data.subarray(1));
  const started = performance.now();
  if (mode === 0) {
    isSignedData(rest);
    const count = signerCount(rest);
    if (count < 0 || count > MAX_SIGNERS) {
      throw new CostError(`signerCount gave ${count}`);
    }
    checkSigner('readSigner', readSigner(rest));
    checkSigner('readCertificate', readCertificate(rest));
    const stored = readImageDigest(rest);
    if (stored !== undefined && (stored.digest.length === 0 || !/^[0-9.]+$/.test(stored.oid))) {
      throw new Error(`readImageDigest gave oid ${stored.oid} and ${stored.digest.length} bytes`);
    }
  } else if (mode === 1) {
    checkSigner('readCertificate', readCertificate(rest));
  } else {
    const result = readApkSigner(rest, mode === 3);
    if (result.count < 0 || result.count > MAX_SIGNERS) {
      throw new CostError(`readApkSigner counted ${result.count} signers`);
    }
    checkSigner('readApkSigner', result.signer);
  }
  if (performance.now() - started > MAX_MILLISECONDS) {
    throw new CostError(`${rest.length} bytes took too long to walk (mode ${mode})`);
  }
}
