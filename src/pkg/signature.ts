// How every package page reports a signature: who the file names, and that
// nothing was checked.
//
// Signatures in these formats are PKCS #7 blobs or bare X.509 certificates.
// src/pe/signer.ts reads the names and dates out of either; this turns them
// into the same section on every page, with the same caveat, so no format's
// page can present a claim as a verdict.
import type { Signer } from '../pe/signer';
import { rows, type PropertySection } from './model';

// isSignedData and signerCount are how a reader decides a PKCS #7 blob is a
// signature at all: SignedData, with at least one signer that carries a
// signature value. A blob that fails them is certificate data, not a signature.
export { isSignedData, readCertificate, readSigner, signerCount, type Signer } from '../pe/signer';

const CAVEAT =
  'These names are what the file claims. MarkCopy does not check the signature, the ' +
  'certificate chain or revocation, so verify the file with its own platform tools before ' +
  'trusting them.';

/**
 * The Signature section for a file that carries one.
 *
 * `scheme` says what kind, in the format's own words ("Authenticode", "JAR
 * signing", "APK Signature Scheme v2"). `signer` is absent when the signature
 * is there but in a form the reader does not walk.
 */
export function signatureSection(scheme: string, signer?: Signer): PropertySection {
  return {
    kind: 'properties',
    heading: 'Signature',
    rows: rows(
      ['Status', `${scheme} signature present, not verified by MarkCopy`],
      ['Signer', signer?.subject],
      ['Organization', signer?.organization !== signer?.subject ? signer?.organization : undefined],
      ['Issued by', signer?.issuer],
      [
        'Certificate valid',
        signer?.notBefore && signer.notAfter
          ? `${signer.notBefore} to ${signer.notAfter}`
          : undefined,
      ],
    ),
    note: CAVEAT,
  };
}
