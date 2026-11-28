import { describe, expect, it } from 'vitest';
import { readApkSigner } from '../../src/pkg/apkSigner';
import { buildLeafCertificate, rsaSpki } from '../pe/fixture';
import { buildZip, readZip, value } from './zipFixture';

const V2 = 0x7109871a;
const V3 = 0xf05368c0;
const V31 = 0x1b93ad61;

const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24];
/** A length-prefixed block. */
const lp = (...parts: ArrayLike<number>[]): Uint8Array => {
  const body = parts.flatMap((p) => [...p]);
  return Uint8Array.from([...u32(body.length), ...body]);
};

const cert = (name: string, bits = 2048): Uint8Array =>
  buildLeafCertificate({
    subject: { commonName: name },
    issuer: { commonName: `${name} CA` },
    key: rsaSpki(bits),
  });

/** One signer of the given scheme, with signature algorithm `algorithm`. */
function signer(
  v3: boolean,
  certificate: Uint8Array,
  algorithm = 0x0103,
  signedExtra: number[] = [],
): Uint8Array {
  const digests = lp(lp(u32(algorithm), lp([1, 2, 3])));
  const certificates = lp(lp(certificate));
  const signedData = lp(
    digests,
    certificates,
    v3 ? [...u32(24), ...u32(0x7fffffff)] : [],
    signedExtra,
  );
  const signatures = lp(lp(u32(algorithm), lp([9, 9, 9])));
  return lp(signedData, v3 ? [...u32(24), ...u32(0x7fffffff)] : [], signatures, lp([7, 7]));
}

const block = (...signers: Uint8Array[]): Uint8Array => lp(...signers.map((s) => [...s]));

const apk = (pairs: { id: number; value: Uint8Array }[]): Uint8Array =>
  buildZip([{ name: 'AndroidManifest.xml', data: 'x' }], { signingBlockPairs: pairs });

const read = async (pairs: { id: number; value: Uint8Array }[]) => readZip(apk(pairs));

describe('readApkSigner', () => {
  it('reads a v2 signer: certificate, key, algorithm and thumbprint', () => {
    const c = cert('Acme v2');
    const result = readApkSigner(block(signer(false, c)), false);
    expect(result.count).toBe(1);
    expect(result.signer?.subject).toBe('Acme v2');
    expect(result.signer?.publicKey).toBe('RSA, 2048 bits');
    expect(result.signer?.signatureAlgorithm).toBe('RSA PKCS #1 v1.5 with SHA-256');
    // Precomputed once with `openssl dgst -sha1` over the fixture's DER bytes
    // (certificate for subject "Acme v2", 2048-bit key), so no test calls SHA-1.
    expect(result.signer?.thumbprint).toBe('9D92773E3C18E75C0C8396B75A15CF9C9FCE8344');
  });

  it('reads a v3 signer, which has an SDK range before the signatures', () => {
    const result = readApkSigner(block(signer(true, cert('Acme v3'), 0x0201)), true);
    expect(result.signer?.subject).toBe('Acme v3');
    expect(result.signer?.signatureAlgorithm).toBe('ECDSA with SHA-256');
  });

  it('names known algorithms and gives hex for an unknown one', () => {
    const name = (id: number) =>
      readApkSigner(block(signer(false, cert('A'), id)), false).signer?.signatureAlgorithm;
    expect(name(0x0101)).toBe('RSASSA-PSS with SHA-256');
    expect(name(0x0102)).toBe('RSASSA-PSS with SHA-512');
    expect(name(0x0104)).toBe('RSA PKCS #1 v1.5 with SHA-512');
    expect(name(0x0202)).toBe('ECDSA with SHA-512');
    expect(name(0x0301)).toBe('DSA with SHA-256');
    expect(name(0x0421)).toBe('RSA PKCS #1 v1.5 with SHA-256 (verity)');
    expect(name(0x0423)).toBe('ECDSA with SHA-256 (verity)');
    expect(name(0x0425)).toBe('DSA with SHA-256 (verity)');
    expect(name(0x9999)).toBe('0x9999');
  });

  it('counts signers and reads the first', () => {
    const result = readApkSigner(
      block(signer(false, cert('One')), signer(false, cert('Two'))),
      false,
    );
    expect(result.count).toBe(2);
    expect(result.signer?.subject).toBe('One');
  });

  it('caps the count at 16', () => {
    const many = Array.from({ length: 20 }, () => signer(false, cert('X')));
    expect(readApkSigner(block(...many), false).count).toBe(16);
  });

  it('finds no signer when a length runs past its parent', () => {
    const good = block(signer(false, cert('Bad')));
    for (const at of [0, 4, 8]) {
      const broken = Uint8Array.from(good);
      broken[at] = 0xff;
      broken[at + 1] = 0xff;
      expect(() => readApkSigner(broken, false)).not.toThrow();
      expect(readApkSigner(broken, false).signer).toBeUndefined();
    }
  });

  it('never throws on any truncation', () => {
    const good = block(signer(true, cert('T')));
    for (let n = 0; n < good.length; n += 5) {
      expect(() => readApkSigner(good.subarray(0, n), true)).not.toThrow();
    }
  });
});

describe('APK page signer from the signing block', () => {
  it('shows a v2 signer through the same rows', async () => {
    const info = await read([{ id: V2, value: block(signer(false, cert('Release key'))) }]);
    expect(value(info, 'Signature', 'Signer')).toBe('Release key');
    expect(value(info, 'Signature', 'Signature algorithm')).toBe('RSA PKCS #1 v1.5 with SHA-256');
    expect(value(info, 'Signature', 'Public key')).toBe('RSA, 2048 bits');
    expect(value(info, 'Signature', 'Certificate thumbprint (SHA-1)')).toMatch(/^[0-9A-F]{40}$/);
    expect(value(info, 'Signature', 'Status')).toContain('not verified by MarkCopy');
    expect(value(info, 'Signature', 'Signers')).toBeUndefined();
  });

  it('marks a short RSA key as weak', async () => {
    const info = await read([{ id: V2, value: block(signer(false, cert('Old', 1024))) }]);
    expect(value(info, 'Signature', 'Public key')).toBe('RSA, 1024 bits (weak)');
  });

  it('shows a v3 signer', async () => {
    const info = await read([{ id: V3, value: block(signer(true, cert('V3 key'))) }]);
    expect(value(info, 'Signature', 'Signer')).toBe('V3 key');
  });

  it('prefers v3.1, then v3, then v2', async () => {
    const pairs = [
      { id: V2, value: block(signer(false, cert('from v2'))) },
      { id: V3, value: block(signer(true, cert('from v3'))) },
      { id: V31, value: block(signer(true, cert('from v3.1'))) },
    ];
    expect(value(await read(pairs), 'Signature', 'Signer')).toBe('from v3.1');
    expect(value(await read(pairs.slice(0, 2)), 'Signature', 'Signer')).toBe('from v3');
    expect(value(await read(pairs.slice(0, 1)), 'Signature', 'Signer')).toBe('from v2');
  });

  it('says which scheme the certificate comes from when several are listed', async () => {
    const pairs = [
      { id: V3, value: block(signer(true, cert('original key'))) },
      { id: V31, value: block(signer(true, cert('rotated key'))) },
    ];
    const both = await read(pairs);
    expect(value(both, 'Signature', 'Signer')).toBe('rotated key');
    expect(value(both, 'Signature', 'Certificate from')).toBe('APK Signature Scheme v3.1');
    const older = await read(pairs.slice(0, 1));
    expect(value(older, 'Signature', 'Certificate from')).toBeUndefined();
    const fallback = await read([
      { id: V31, value: Uint8Array.of(255, 255, 255, 255) },
      { id: V2, value: block(signer(false, cert('from v2'))) },
    ]);
    expect(value(fallback, 'Signature', 'Signer')).toBe('from v2');
    expect(value(fallback, 'Signature', 'Certificate from')).toBe('APK Signature Scheme v2');
  });

  it('falls back to an older scheme when the newest cannot be read', async () => {
    const info = await read([
      { id: V3, value: Uint8Array.of(255, 255, 255, 255) },
      { id: V2, value: block(signer(false, cert('from v2'))) },
    ]);
    expect(value(info, 'Signature', 'Signer')).toBe('from v2');
  });

  it('says how many signers there are only when more than one', async () => {
    const two = await read([
      { id: V2, value: block(signer(false, cert('One')), signer(false, cert('Two'))) },
    ]);
    expect(value(two, 'Signature', 'Signers')).toBe('2 signers');
    expect(value(two, 'Signature', 'Signer')).toBe('One');
  });

  it('reports no signer, without crashing, when a length runs past its parent', async () => {
    const info = await read([{ id: V2, value: Uint8Array.of(9, 0, 0, 0, 1, 2) }]);
    expect(value(info, 'Signature', 'Signer')).toContain('Not read');
    expect(value(info, 'Signature', 'Status')).toContain('Scheme v2');
  });

  it('warns and shows no signer for a block value over the cap', async () => {
    const huge = new Uint8Array(1024 * 1024 + 1);
    const info = await read([{ id: V2, value: huge }]);
    expect(value(info, 'Signature', 'Signer')).toContain('Not read');
    expect(info.warnings.join(' ')).toContain('Scheme v2');
  });
});
