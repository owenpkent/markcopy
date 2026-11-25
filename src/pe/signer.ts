// Who an embedded Authenticode signature names as its signer.
//
// The certificate table holds a PKCS #7 SignedData in DER. This walks just far
// enough into it to find the signer's certificate (the one whose issuer and
// serial number the SignerInfo cites) and read the names and dates off it.
//
// It verifies NOTHING: not the file's hash against the signed one, not the
// signature, not the chain, not revocation, not expiry. A file can carry a
// stolen or self-made certificate with any name in it. The preview says so
// beside these fields; this module's output is a claim the file makes, and
// must never be presented as a verdict.

import { sha1Hex } from '../binary/sha1';
import { printable } from '../binary/text';

export interface Signer {
  subject?: string;
  organization?: string;
  issuer?: string;
  notBefore?: string;
  notAfter?: string;
  /** The hash algorithm the signature says it used. A claim, not a check. */
  digest?: string;
  /** The signature algorithm, for formats that name one rather than a hash (APK v2 and later). */
  signatureAlgorithm?: string;
  /** The kind and size of the signer certificate's public key, as the certificate states it. */
  publicKey?: string;
  /** SHA-1 of the certificate's DER, uppercase hex, as Windows shows a thumbprint. */
  thumbprint?: string;
}

interface Tlv {
  tag: number;
  /** Where the header begins, so the whole element can be hashed. */
  from: number;
  start: number;
  end: number;
}

function tlvAt(der: Uint8Array, at: number, limit: number): Tlv | undefined {
  if (at + 2 > limit) {
    return undefined;
  }
  const tag = der[at];
  let length = der[at + 1];
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    // Zero is BER's indefinite length, which DER forbids; more than four
    // bytes is a length no certificate table can hold.
    if (count === 0 || count > 4 || start + count > limit) {
      return undefined;
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + der[start++];
    }
  }
  const end = start + length;
  return end <= limit ? { tag, from: at, start, end } : undefined;
}

function children(der: Uint8Array, parent: Tlv, max = 64): Tlv[] {
  const out: Tlv[] = [];
  let at = parent.start;
  while (at < parent.end && out.length < max) {
    const child = tlvAt(der, at, parent.end);
    if (!child) {
      break;
    }
    out.push(child);
    at = child.end;
  }
  return out;
}

function same(der: Uint8Array, a: Tlv, b: Tlv): boolean {
  if (a.end - a.start !== b.end - b.start) {
    return false;
  }
  for (let i = 0; i < a.end - a.start; i++) {
    if (der[a.start + i] !== der[b.start + i]) {
      return false;
    }
  }
  return true;
}

function text(der: Uint8Array, value: Tlv): string | undefined {
  const bytes = der.subarray(value.start, Math.min(value.end, value.start + 512));
  let out: string;
  if (value.tag === 0x1e) {
    // BMPString: UTF-16, big-endian.
    out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
  } else if ([0x0c, 0x13, 0x14, 0x16].includes(value.tag)) {
    // UTF8String, PrintableString, TeletexString, IA5String.
    out = new TextDecoder().decode(bytes);
  } else {
    return undefined;
  }
  out = printable(out).trim();
  return out || undefined;
}

/** The value of one attribute of an X.501 Name, by the last byte of its 2.5.4.x OID. */
function nameField(der: Uint8Array, name: Tlv, attribute: number): string | undefined {
  for (const set of children(der, name)) {
    for (const pair of children(der, set, 8)) {
      const [oid, value] = children(der, pair, 2);
      if (
        oid?.tag === 0x06 &&
        value &&
        oid.end - oid.start === 3 &&
        der[oid.start] === 0x55 &&
        der[oid.start + 1] === 0x04 &&
        der[oid.start + 2] === attribute
      ) {
        return text(der, value);
      }
    }
  }
  return undefined;
}

const COMMON_NAME = 0x03;
const ORGANIZATION = 0x0a;

/** A certificate date as YYYY-MM-DD, from UTCTime or GeneralizedTime. */
function date(der: Uint8Array, value: Tlv | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const raw = new TextDecoder().decode(
    der.subarray(value.start, Math.min(value.end, value.start + 24)),
  );
  const utc = value.tag === 0x17 && /^(\d\d)(\d\d)(\d\d)/.exec(raw);
  if (utc) {
    // RFC 5280: two-digit years below 50 are 20xx, the rest 19xx.
    return `${Number(utc[1]) < 50 ? '20' : '19'}${utc[1]}-${utc[2]}-${utc[3]}`;
  }
  const general = value.tag === 0x18 && /^(\d{4})(\d\d)(\d\d)/.exec(raw);
  return general ? `${general[1]}-${general[2]}-${general[3]}` : undefined;
}

// 1.2.840.113549.1.7.2, the PKCS #7 signedData content type.
const SIGNED_DATA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];

/**
 * Whether these bytes are a PKCS #7 ContentInfo that says it holds SignedData,
 * which is the form an Authenticode signature takes. It says what the bytes
 * claim to be, and nothing about whether the signature is good.
 */
export function isSignedData(der: Uint8Array): boolean {
  const outer = tlvAt(der, 0, der.length);
  if (outer?.tag !== 0x30) {
    return false;
  }
  const oid = children(der, outer, 1)[0];
  return (
    oid?.tag === 0x06 &&
    oid.end - oid.start === SIGNED_DATA_OID.length &&
    SIGNED_DATA_OID.every((byte, i) => der[oid.start + i] === byte)
  );
}

/**
 * How many signers a PKCS #7 SignedData carries, at most `max`. A signer is a
 * SignerInfo of the right shape that holds a signature value: see isSignerInfo.
 *
 * SignedData with none is a legitimate thing and not a signature: it is how a
 * bundle of certificates is shipped ("certs-only"). Something has to have
 * signed for there to be a signature, so the reader asks this before it says
 * a file carries one.
 */
export function signerCount(der: Uint8Array, max = 16): number {
  const outer = tlvAt(der, 0, der.length);
  if (outer?.tag !== 0x30) {
    return 0;
  }
  const wrapped = children(der, outer, 2)[1];
  const signed = wrapped?.tag === 0xa0 ? tlvAt(der, wrapped.start, wrapped.end) : undefined;
  if (signed?.tag !== 0x30) {
    return 0;
  }
  // version, digestAlgorithms, contentInfo, then optional certificates and
  // CRLs, then signerInfos: the last element, and a SET like the second.
  const parts = children(der, signed, 8);
  const signers = parts.length > 3 ? parts[parts.length - 1] : undefined;
  if (signers?.tag !== 0x31) {
    return 0;
  }
  return children(der, signers, max).filter((info) => isSignerInfo(der, info)).length;
}

// SignerInfo ::= SEQUENCE {
//   version                    INTEGER,
//   issuerAndSerialNumber      SEQUENCE   (or, in later versions, [0] a key identifier),
//   digestAlgorithm            SEQUENCE,
//   authenticatedAttributes    [0] IMPLICIT OPTIONAL,
//   digestEncryptionAlgorithm  SEQUENCE,
//   encryptedDigest            OCTET STRING,
//   unauthenticatedAttributes  [1] IMPLICIT OPTIONAL }
//
// Counting any SEQUENCE in the set as a signer let an empty one stand for a
// signature. A signer is one that has this shape and, above all, a signature
// value that is not empty. This still only reads what the file claims: whether
// that value is a good signature of anything is not looked at.
function isSignerInfo(der: Uint8Array, info: Tlv): boolean {
  if (info.tag !== 0x30) {
    return false;
  }
  const fields = children(der, info, 8);
  let i = 0;
  if (fields[i++]?.tag !== 0x02) {
    return false;
  }
  const identifier = fields[i++]?.tag;
  if (identifier !== 0x30 && identifier !== 0x80) {
    return false;
  }
  if (fields[i++]?.tag !== 0x30) {
    return false;
  }
  if (fields[i]?.tag === 0xa0) {
    i++;
  }
  if (fields[i++]?.tag !== 0x30) {
    return false;
  }
  const value = fields[i];
  return value?.tag === 0x04 && value.end > value.start;
}

const DIGESTS: Record<string, string> = {
  '1.2.840.113549.2.5': 'MD5',
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

const CURVES: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

/** An OBJECT IDENTIFIER as dotted arcs. Bounded: long or oversized ones give nothing. */
function oidText(der: Uint8Array, value: Tlv | undefined): string | undefined {
  if (value?.tag !== 0x06 || value.end - value.start < 1 || value.end - value.start > 32) {
    return undefined;
  }
  const arcs: number[] = [];
  let n = 0;
  for (let i = value.start; i < value.end; i++) {
    n = n * 128 + (der[i] & 0x7f);
    // Past 2^40 an arc is no OID anyone assigns; stop before doubles lose digits.
    if (n > 2 ** 40) {
      return undefined;
    }
    if (der[i] & 0x80) {
      if (i === value.end - 1) {
        // The last byte still says "more follows": cut off.
        return undefined;
      }
      continue;
    }
    if (arcs.length === 0) {
      // The first value holds two arcs: 40 * first + second, first at most 2.
      const first = Math.min(Math.floor(n / 40), 2);
      arcs.push(first, n - first * 40);
    } else {
      arcs.push(n);
    }
    n = 0;
  }
  return arcs.join('.');
}

/** The name of the hash in an AlgorithmIdentifier, or its dotted OID when unknown. */
function digestName(der: Uint8Array, algorithm: Tlv): string | undefined {
  const dotted = oidText(der, children(der, algorithm, 1)[0]);
  return dotted === undefined ? undefined : (DIGESTS[dotted] ?? dotted);
}

/** "RSA, 2048 bits" and the like, from a SubjectPublicKeyInfo. */
function keyName(der: Uint8Array, spki: Tlv | undefined): string | undefined {
  if (spki?.tag !== 0x30) {
    return undefined;
  }
  const [algorithm, bits] = children(der, spki, 2);
  if (algorithm?.tag !== 0x30 || bits?.tag !== 0x03) {
    return undefined;
  }
  const [kind, parameters] = children(der, algorithm, 2);
  const dotted = oidText(der, kind);
  if (dotted === undefined) {
    return undefined;
  }
  switch (dotted) {
    case '1.2.840.113549.1.1.1': {
      // The BIT STRING (first byte: unused bits) holds SEQUENCE { modulus, exponent }.
      const key = tlvAt(der, bits.start + 1, bits.end);
      const modulus = key?.tag === 0x30 ? children(der, key, 1)[0] : undefined;
      if (modulus?.tag !== 0x02) {
        return 'RSA';
      }
      // A leading zero byte only keeps the INTEGER positive; it is not key size.
      let at = modulus.start;
      while (at < modulus.end - 1 && der[at] === 0) {
        at++;
      }
      if (at >= modulus.end || der[at] === 0) {
        return 'RSA';
      }
      return `RSA, ${(modulus.end - at - 1) * 8 + (32 - Math.clz32(der[at]))} bits`;
    }
    case '1.2.840.10045.2.1': {
      const curve = oidText(der, parameters);
      return curve === undefined ? 'ECDSA' : `ECDSA, ${CURVES[curve] ?? curve}`;
    }
    case '1.3.101.112':
      return 'Ed25519';
    case '1.2.840.10040.4.1':
      return 'DSA';
    default:
      return dotted;
  }
}

/**
 * What a certificate says about itself: names, dates, key and thumbprint.
 * `fields` are the TBSCertificate's first elements and `base` is where the
 * serial number sits (1 when an explicit version comes first).
 */
function describe(
  der: Uint8Array,
  certificate: Tlv,
  fields: Tlv[],
  base: number,
): Signer | undefined {
  const issuer = fields[base + 2];
  const validity = fields[base + 3];
  const subject = fields[base + 4];
  if (!issuer || !validity || !subject) {
    return undefined;
  }
  const [notBefore, notAfter] = children(der, validity, 2);
  const signer: Signer = {
    subject: nameField(der, subject, COMMON_NAME),
    organization: nameField(der, subject, ORGANIZATION),
    issuer: nameField(der, issuer, COMMON_NAME) ?? nameField(der, issuer, ORGANIZATION),
    notBefore: date(der, notBefore),
    notAfter: date(der, notAfter),
    publicKey: keyName(der, fields[base + 5]),
  };
  // The thumbprint always exists, so "found nothing" is judged before it is added.
  if (!Object.values(signer).some((value) => value !== undefined)) {
    return undefined;
  }
  signer.thumbprint = sha1Hex(der.subarray(certificate.from, certificate.end));
  return signer;
}

/** The "weak" wording for a hash name; one place so every page says the same. */
export function digestLabel(digest: string): string {
  return digest === 'MD5' ? 'MD5 (broken)' : digest === 'SHA-1' ? 'SHA-1 (weak)' : digest;
}

/** The "weak" wording for a key description: RSA under 2048 bits. */
export function keyLabel(key: string): string {
  const bits = /^RSA, (\d+) bits$/.exec(key);
  return bits && Number(bits[1]) < 2048 ? `${key} (weak)` : key;
}

/** The detail rows every signature section shows after "Certificate valid"; empty values are left for the caller to drop. */
export function detailRows(signer?: Signer): [string, string | undefined][] {
  return [
    ['Digest', signer?.digest === undefined ? undefined : digestLabel(signer.digest)],
    ['Signature algorithm', signer?.signatureAlgorithm],
    ['Public key', signer?.publicKey === undefined ? undefined : keyLabel(signer.publicKey)],
    ['Certificate thumbprint (SHA-1)', signer?.thumbprint],
  ];
}

export function readSigner(der: Uint8Array): Signer | undefined {
  // ContentInfo ::= SEQUENCE { contentType OID, [0] EXPLICIT SignedData }
  const outer = tlvAt(der, 0, der.length);
  if (outer?.tag !== 0x30) {
    return undefined;
  }
  const wrapped = children(der, outer, 2)[1];
  if (wrapped?.tag !== 0xa0) {
    return undefined;
  }
  // SignedData ::= SEQUENCE { version, digestAlgorithms SET, contentInfo,
  //   certificates [0] IMPLICIT OPTIONAL, crls [1] IMPLICIT OPTIONAL,
  //   signerInfos SET }
  const signed = tlvAt(der, wrapped.start, wrapped.end);
  if (signed?.tag !== 0x30) {
    return undefined;
  }
  const parts = children(der, signed, 8);
  const certificates = parts.find((part) => part.tag === 0xa0);
  // The digest algorithms are a SET too, so the signers are the last one.
  const signers = parts.length > 3 ? parts[parts.length - 1] : undefined;
  if (!certificates || signers?.tag !== 0x31) {
    return undefined;
  }
  // SignerInfo ::= SEQUENCE { version, IssuerAndSerialNumber { issuer, serial }, ... }
  const signerInfo = children(der, signers, 1)[0];
  const cited = signerInfo && children(der, signerInfo, 3)[1];
  const [citedIssuer, citedSerial] = cited ? children(der, cited, 2) : [];
  if (!citedIssuer || !citedSerial) {
    return undefined;
  }
  // The hash the signer says it used: the AlgorithmIdentifier after the sid.
  const algorithm = signerInfo && children(der, signerInfo, 3)[2];
  const digest = algorithm?.tag === 0x30 ? digestName(der, algorithm) : undefined;
  for (const certificate of children(der, certificates, 32)) {
    // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version OPTIONAL,
    //   serial, signature, issuer, validity { notBefore, notAfter }, subject, ... }, ... }
    const tbs = children(der, certificate, 1)[0];
    if (!tbs) {
      continue;
    }
    const fields = children(der, tbs, 8);
    const base = fields[0]?.tag === 0xa0 ? 1 : 0;
    const serial = fields[base];
    const issuer = fields[base + 2];
    const validity = fields[base + 3];
    const subject = fields[base + 4];
    if (!serial || !issuer || !validity || !subject) {
      continue;
    }
    if (!same(der, serial, citedSerial) || !same(der, issuer, citedIssuer)) {
      continue;
    }
    const signer = describe(der, certificate, fields, base);
    if (signer && digest) {
      signer.digest = digest;
    }
    return signer;
  }
  return undefined;
}

/**
 * The names and dates on one X.509 certificate, for the formats that carry a
 * bare certificate rather than a PKCS #7 blob (a macOS installer package's
 * table of contents). The same caveat applies: this reads a claim and
 * verifies nothing.
 */
export function readCertificate(der: Uint8Array): Signer | undefined {
  const certificate = tlvAt(der, 0, der.length);
  const tbs = certificate?.tag === 0x30 ? children(der, certificate, 1)[0] : undefined;
  if (!certificate || !tbs) {
    return undefined;
  }
  const fields = children(der, tbs, 8);
  const base = fields[0]?.tag === 0xa0 ? 1 : 0;
  return describe(der, certificate, fields, base);
}
