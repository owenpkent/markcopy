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

import { printable } from './text';

export interface Signer {
  subject?: string;
  organization?: string;
  issuer?: string;
  notBefore?: string;
  notAfter?: string;
}

interface Tlv {
  tag: number;
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
  return end <= limit ? { tag, start, end } : undefined;
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
  const cited = signerInfo && children(der, signerInfo, 2)[1];
  const [citedIssuer, citedSerial] = cited ? children(der, cited, 2) : [];
  if (!citedIssuer || !citedSerial) {
    return undefined;
  }
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
    const [notBefore, notAfter] = children(der, validity, 2);
    const signer: Signer = {
      subject: nameField(der, subject, COMMON_NAME),
      organization: nameField(der, subject, ORGANIZATION),
      issuer: nameField(der, issuer, COMMON_NAME) ?? nameField(der, issuer, ORGANIZATION),
      notBefore: date(der, notBefore),
      notAfter: date(der, notAfter),
    };
    return Object.values(signer).some((value) => value !== undefined) ? signer : undefined;
  }
  return undefined;
}
