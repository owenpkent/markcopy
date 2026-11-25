// @vitest-environment node
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  describeEncryptionInfo,
  protectedFileNotice,
  refuseProtectedFile,
} from '../src/ooxml/encrypted';
import { openZip, OpcError } from '../src/ooxml/zip';
import { buildCfb } from './pkg/cfbFixture';

const REFUSAL = 'MarkCopy does not ask for passwords or decrypt files.';
const LOCKED = `it is password-protected, and ${REFUSAL}`;

function header(major: number, minor: number, tail: number[] = []): Uint8Array {
  return Uint8Array.from([major & 0xff, major >> 8, minor & 0xff, minor >> 8, ...tail]);
}

function agile(cipher = 'AES', bits = '256', hash = 'SHA512'): Uint8Array {
  const xml = `<?xml version="1.0"?><encryption xmlns="x"><keyData saltSize="16" cipherAlgorithm="${cipher}" keyBits="${bits}" hashAlgorithm="${hash}"/></encryption>`;
  return Uint8Array.from([...header(4, 4, [0x40, 0, 0, 0]), ...new TextEncoder().encode(xml)]);
}

function standard(algId: number, major = 4): Uint8Array {
  const out: number[] = [...header(major, 2), 0, 0, 0, 0];
  const u32 = (v: number): number[] => [
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >>> 24) & 0xff,
  ];
  // Header size 32, then flags, extra size, AlgID, hash id, key size, provider type, two reserved.
  out.push(
    ...u32(32),
    ...u32(0),
    ...u32(0),
    ...u32(algId),
    ...u32(0x8004),
    ...u32(128),
    ...u32(0),
    ...u32(0),
    ...u32(0),
  );
  return Uint8Array.from(out);
}

const locked = (info: Uint8Array): Uint8Array =>
  buildCfb({
    streams: [
      { name: 'EncryptionInfo', data: info },
      { name: 'EncryptedPackage', data: new Uint8Array(100).fill(9) },
    ],
  });

describe('describeEncryptionInfo', () => {
  it('reads Agile encryption from its XML', () => {
    expect(describeEncryptionInfo(agile())).toBe('Agile encryption, AES-256, SHA512');
    expect(describeEncryptionInfo(agile('AES', '128', 'SHA1'))).toBe(
      'Agile encryption, AES-128, SHA1',
    );
  });
  it('reads Standard encryption', () => {
    expect(describeEncryptionInfo(standard(0x660e))).toBe('Standard encryption, AES-128');
    expect(describeEncryptionInfo(standard(0x6610, 3))).toBe('Standard encryption, AES-256');
    expect(describeEncryptionInfo(standard(0x6801, 2))).toBe('Standard encryption, RC4');
    expect(describeEncryptionInfo(standard(0x1234))).toBe('Standard encryption');
  });
  it('names Extensible encryption and an unknown version', () => {
    expect(describeEncryptionInfo(header(4, 3))).toBe('Extensible encryption');
    expect(describeEncryptionInfo(header(7, 9))).toBe('Encryption version 7.9');
  });
  it('gives no method for a cut stream and never throws', () => {
    expect(describeEncryptionInfo(new Uint8Array(0))).toBeUndefined();
    expect(describeEncryptionInfo(header(4, 4).subarray(0, 3))).toBeUndefined();
    expect(describeEncryptionInfo(header(4, 4))).toBe('Agile encryption');
    expect(describeEncryptionInfo(header(4, 2, [0, 0]))).toBe('Standard encryption');
    expect(describeEncryptionInfo(agile().subarray(0, 30))).toBe('Agile encryption');
  });
});

describe('protectedFileNotice', () => {
  it('says the file is locked and how', async () => {
    expect(await protectedFileNotice(locked(agile()))).toBe(
      `it is password-protected (Agile encryption, AES-256, SHA512), and ${REFUSAL}`,
    );
    expect(await protectedFileNotice(locked(standard(0x660e)))).toBe(
      `it is password-protected (Standard encryption, AES-128), and ${REFUSAL}`,
    );
  });
  it('still says locked when EncryptionInfo is truncated or empty', async () => {
    expect(await protectedFileNotice(locked(header(4, 4).subarray(0, 2)))).toBe(LOCKED);
    expect(await protectedFileNotice(locked(new Uint8Array(0)))).toBe(LOCKED);
  });
  it('leaves other files alone', async () => {
    const plain = buildCfb({ streams: [{ name: 'WordDocument', data: new Uint8Array(10) }] });
    expect(await protectedFileNotice(plain)).toBeUndefined();
    const oneStream = buildCfb({ streams: [{ name: 'EncryptionInfo', data: agile() }] });
    expect(await protectedFileNotice(oneStream)).toBeUndefined();
    expect(await protectedFileNotice(new Uint8Array(0))).toBeUndefined();
    const damaged = locked(agile()).slice(0, 700);
    expect(await protectedFileNotice(damaged)).toBeUndefined();
    const magicOnly = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
    expect(await protectedFileNotice(magicOnly)).toBeUndefined();
  });
  it('does not disturb a normal zip-based file', async () => {
    const zip = zipSync({ '[Content_Types].xml': new TextEncoder().encode('<Types/>') });
    expect(await protectedFileNotice(zip)).toBeUndefined();
    await expect(refuseProtectedFile(zip)).resolves.toBeUndefined();
    expect(openZip(zip).has('[Content_Types].xml')).toBe(true);
  });
  it('refuses a locked file with the preview format error', async () => {
    await expect(refuseProtectedFile(locked(agile()))).rejects.toBeInstanceOf(OpcError);
    await expect(refuseProtectedFile(locked(agile()))).rejects.toThrow(/password-protected/);
  });
});
