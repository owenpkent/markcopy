import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesSource, readPe, renderPeHtml } from '../../src/pe';
import {
  detailRows,
  digestLabel,
  keyLabel,
  readCertificate,
  readSigner,
} from '../../src/pe/signer';
import { signatureSection } from '../../src/pkg/signature';
import {
  buildLeafCertificate,
  buildPe,
  buildSignedData,
  ecSpki,
  oidBytes,
  rsaSpki,
  spki,
  tlv,
} from './fixture';

const names = { subject: { commonName: 'Contoso' }, issuer: { commonName: 'Contoso CA' } };

describe('signer digest', () => {
  const cases: [string, string][] = [
    ['1.2.840.113549.2.5', 'MD5'],
    ['1.3.14.3.2.26', 'SHA-1'],
    ['2.16.840.1.101.3.4.2.1', 'SHA-256'],
    ['2.16.840.1.101.3.4.2.2', 'SHA-384'],
    ['2.16.840.1.101.3.4.2.3', 'SHA-512'],
    ['1.2.3.4.5', '1.2.3.4.5'],
  ];
  it.each(cases)('names %s as %s', (dotted, name) => {
    const der = buildSignedData({ ...names, digestOid: oidBytes(dotted) });
    expect(readSigner(der)?.digest).toBe(name);
  });

  it('leaves the digest unset for a bare certificate, which names no hash', () => {
    expect(readCertificate(buildLeafCertificate(names))?.digest).toBeUndefined();
  });
});

describe('signer public key', () => {
  it.each([1024, 2048, 4096])('reads an RSA key of %i bits past the leading zero', (bits) => {
    const der = buildSignedData({ ...names, key: rsaSpki(bits) });
    expect(readSigner(der)?.publicKey).toBe(`RSA, ${bits} bits`);
  });

  it('counts an odd modulus length by its top bit', () => {
    expect(readSigner(buildSignedData({ ...names, key: rsaSpki(2047) }))?.publicKey).toBe(
      'RSA, 2047 bits',
    );
  });

  const curves: [string, string][] = [
    ['1.2.840.10045.3.1.7', 'ECDSA, P-256'],
    ['1.3.132.0.34', 'ECDSA, P-384'],
    ['1.3.132.0.35', 'ECDSA, P-521'],
    ['1.3.132.0.10', 'ECDSA, 1.3.132.0.10'],
  ];
  it.each(curves)('names curve %s as %s', (dotted, label) => {
    const der = buildSignedData({ ...names, key: ecSpki(oidBytes(dotted)) });
    expect(readSigner(der)?.publicKey).toBe(label);
  });

  it('names Ed25519, DSA and an unknown algorithm', () => {
    const key = Uint8Array.of(1, 2, 3);
    const read = (dotted: string): string | undefined =>
      readSigner(buildSignedData({ ...names, key: spki(oidBytes(dotted), key, new Uint8Array(0)) }))
        ?.publicKey;
    expect(read('1.3.101.112')).toBe('Ed25519');
    expect(read('1.2.840.10040.4.1')).toBe('DSA');
    expect(read('1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('signer thumbprint', () => {
  it('is the SHA-1 of the whole certificate, in uppercase hex', () => {
    const spec = { ...names, key: rsaSpki(2048) };
    const leaf = buildLeafCertificate(spec);
    const expected = createHash('sha1').update(leaf).digest('hex').toUpperCase();
    expect(readSigner(buildSignedData(spec))?.thumbprint).toBe(expected);
    expect(readCertificate(leaf)?.thumbprint).toBe(expected);
  });
});

describe('weak markers and rows', () => {
  it('marks MD5, SHA-1 and short RSA keys, and nothing else', () => {
    expect(digestLabel('MD5')).toBe('MD5 (broken)');
    expect(digestLabel('SHA-1')).toBe('SHA-1 (weak)');
    expect(digestLabel('SHA-256')).toBe('SHA-256');
    expect(keyLabel('RSA, 1024 bits')).toBe('RSA, 1024 bits (weak)');
    expect(keyLabel('RSA, 2048 bits')).toBe('RSA, 2048 bits');
    expect(keyLabel('ECDSA, P-256')).toBe('ECDSA, P-256');
  });

  it('drops rows that have no value', () => {
    expect(detailRows(undefined).every(([, v]) => v === undefined)).toBe(true);
    const labels = signatureSection('X', { subject: 'A' }).rows.map(([label]) => label);
    expect(labels).not.toContain('Digest');
    expect(labels).not.toContain('Public key');
  });

  it('shows the rows after Certificate valid in the package section', () => {
    const signer = readSigner(
      buildSignedData({ ...names, digestOid: oidBytes('1.3.14.3.2.26'), key: rsaSpki(1024) }),
    );
    const rows = signatureSection('Authenticode', signer).rows;
    expect(rows.map(([label]) => label).slice(-4)).toEqual([
      'Certificate valid',
      'Digest',
      'Public key',
      'Certificate thumbprint (SHA-1)',
    ]);
    expect(rows.find(([l]) => l === 'Digest')?.[1]).toBe('SHA-1 (weak)');
    expect(rows.find(([l]) => l === 'Public key')?.[1]).toBe('RSA, 1024 bits (weak)');
  });

  it('shows the same rows on the executable page', async () => {
    const certificate = buildSignedData({
      ...names,
      digestOid: oidBytes('1.2.840.113549.2.5'),
      key: rsaSpki(2048),
    });
    const info = await readPe(bytesSource(buildPe({ certificate })));
    const html = renderPeHtml(info, { fileName: 'tool.exe' });
    expect(html).toContain('MD5 (broken)');
    expect(html).toContain('RSA, 2048 bits');
    expect(html).toContain('Certificate thumbprint (SHA-1)');
    expect(html.indexOf('Certificate valid')).toBeLessThan(html.indexOf('MD5 (broken)'));
  });
});

describe('hostile input', () => {
  it('never throws on a truncated signature or certificate', () => {
    const der = buildSignedData({ ...names, key: rsaSpki(2048) });
    for (let n = 0; n < der.length; n += 3) {
      expect(() => readSigner(der.subarray(0, n))).not.toThrow();
      expect(() => readCertificate(der.subarray(0, n))).not.toThrow();
    }
  });

  it('gives no key for an OID that runs off its end', () => {
    const bad = tlv(
      0x30,
      tlv(0x30, tlv(0x06, Uint8Array.of(0x2a, 0x80)), tlv(0x05)),
      tlv(0x03, Uint8Array.of(0)),
    );
    expect(readSigner(buildSignedData({ ...names, key: bad }))?.publicKey).toBeUndefined();
  });
});
