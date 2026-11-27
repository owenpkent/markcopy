import { describe, expect, it } from 'vitest';
import { readPdfEncryption } from '../src/pdfEncryption';

const OU = '/O <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> /U (a\\)>>b)';

/** A PDF whose trailer (or xref stream) names the Encrypt dictionary in `encrypt` (or object 9). */
function pdf(opts: {
  encrypt?: string;
  direct?: string;
  stream?: boolean;
  pad?: number;
}): Uint8Array {
  let body = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  body += 'x'.repeat(opts.pad ?? 0) + '\n';
  if (opts.encrypt !== undefined) {
    body += `9 0 obj\n${opts.encrypt}\nendobj\n`;
  }
  const ref = opts.direct ?? (opts.encrypt !== undefined ? '9 0 R' : '');
  const enc = ref ? ` /Encrypt ${ref}` : '';
  const at = body.length;
  if (opts.stream) {
    body += `10 0 obj\n<< /Type /XRef /Size 11 /W [1 2 1] /Root 1 0 R${enc} /Length 0 >>\nstream\n\nendstream\nendobj\n`;
  } else {
    body += `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 10 /Root 1 0 R${enc} /ID [<AA><BB>] >>\n`;
  }
  body += `startxref\n${at}\n%%EOF\n`;
  return Uint8Array.from(body, (c) => c.charCodeAt(0));
}

describe('readPdfEncryption', () => {
  it('says nothing for a PDF that is not encrypted, or that is not a PDF', () => {
    expect(readPdfEncryption(pdf({}))).toBeUndefined();
    expect(readPdfEncryption(new Uint8Array(10))).toBeUndefined();
    expect(readPdfEncryption(new Uint8Array(0))).toBeUndefined();
  });

  it('labels V1 / R2 as RC4 40-bit, legacy', () => {
    const out = readPdfEncryption(
      pdf({ encrypt: `<< /Filter /Standard /V 1 /R 2 /P -44 ${OU} >>` }),
    );
    expect(out?.label).toBe('Encrypted: RC4 40-bit (legacy, revision 2)');
  });

  it('labels V2 / R3 with its /Length', () => {
    const out = readPdfEncryption(
      pdf({ encrypt: `<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 ${OU} >>` }),
    );
    expect(out?.label).toBe('Encrypted: RC4 128-bit (legacy, revision 3)');
  });

  it('labels V4 / R4 with AESV2 as AES-128', () => {
    const dict =
      '<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /P -1340 ' +
      OU +
      ' >>';
    expect(readPdfEncryption(pdf({ encrypt: dict }))?.label).toBe(
      'Encrypted: AES-128 (standard security handler, revision 4)',
    );
  });

  it('labels V4 with the V2 crypt filter as RC4 and reads its byte length', () => {
    const dict =
      '<< /Filter /Standard /V 4 /R 4 /CF << /StdCF << /CFM /V2 /Length 16 >> >> /StmF /StdCF /P -4 >>';
    expect(readPdfEncryption(pdf({ encrypt: dict }))?.label).toBe(
      'Encrypted: RC4 128-bit (legacy, revision 4)',
    );
  });

  it('labels V5 / R6 with AESV3 as AES-256', () => {
    const dict = `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF /P -1 ${OU} /Perms <00> >>`;
    expect(readPdfEncryption(pdf({ encrypt: dict }))?.label).toBe(
      'Encrypted: AES-256 (standard security handler, revision 6)',
    );
  });

  it('reads a direct /Encrypt dictionary in the trailer', () => {
    const out = readPdfEncryption(pdf({ direct: '<< /Filter /Standard /V 1 /R 2 /P -4 >>' }));
    expect(out?.label).toBe('Encrypted: RC4 40-bit (legacy, revision 2)');
  });

  it('reads the Encrypt reference from a cross-reference stream dictionary', () => {
    const dict =
      '<< /Filter /Standard /V 5 /R 6 /CF << /StdCF << /CFM /AESV3 >> >> /StmF /StdCF /P -4 >>';
    const out = readPdfEncryption(pdf({ encrypt: dict, stream: true }));
    expect(out?.label).toBe('Encrypted: AES-256 (standard security handler, revision 6)');
    expect(readPdfEncryption(pdf({ stream: true }))).toBeUndefined();
  });

  it('names a non-Standard handler and says the cipher was not determined', () => {
    const out = readPdfEncryption(
      pdf({ encrypt: '<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 >>' }),
    );
    expect(out?.label).toBe('Encrypted: Adobe.PubSec security handler, cipher not determined');
    expect(out?.permissions).toBeUndefined();
  });

  it('takes the cipher of a non-Standard handler from its crypt filters when declared', () => {
    const out = readPdfEncryption(
      pdf({
        encrypt:
          '<< /Filter /Adobe.PubSec /V 5 /CF << /DefaultCryptFilter << /CFM /AESV3 >> >> /StmF /DefaultCryptFilter >>',
      }),
    );
    expect(out?.label).toBe('Encrypted: Adobe.PubSec security handler, AES-256');
  });

  it('degrades on a truncated /Encrypt object without throwing', () => {
    const cut = readPdfEncryption(
      pdf({ encrypt: '<< /Filter /Standard /V 4 /R 4 /CF << /StdCF <<' }),
    );
    expect(cut?.label).toBe(
      'Encrypted: cipher not determined (standard security handler, revision 4)',
    );
    const none = readPdfEncryption(pdf({ direct: '9 0 R' }));
    expect(none?.label).toBe('Encrypted: the encryption details were not determined.');
  });

  it('reports not determined when the Encrypt object is not found', () => {
    const bytes = pdf({ direct: '77 0 R' });
    expect(readPdfEncryption(bytes)?.label).toContain('not determined');
  });

  it('finds the Encrypt object in the tail of a large file', () => {
    const out = readPdfEncryption(
      pdf({ encrypt: '<< /Filter /Standard /V 1 /R 2 /P -4 >>', pad: 200_000 }),
    );
    expect(out?.label).toContain('RC4 40-bit');
  });

  describe('permissions', () => {
    const withP = (p: number, r = 3) =>
      readPdfEncryption(
        pdf({ encrypt: `<< /Filter /Standard /V 2 /R ${r} /Length 128 /P ${p} >>` }),
      );

    it('lists what the file restricts, as a declaration', () => {
      // Print (bit 3) and copy (bit 5) cleared, everything else set.
      const p = -1 & ~(1 << 2) & ~(1 << 4);
      expect(withP(p)?.permissions).toBe(
        'The file restricts: printing, copying text. Whether a viewer honours this is up to the viewer.',
      );
    });

    it('lists every restriction when all permission bits are clear', () => {
      expect(withP(-3904 & ~0xf3c)?.permissions).toContain(
        'printing, modifying content, copying text, adding or editing annotations, filling in forms, extracting text for accessibility, assembling pages',
      );
    });

    it('names high-quality printing only when printing itself is allowed', () => {
      const p = -1 & ~(1 << 11);
      expect(withP(p)?.permissions).toContain('The file restricts: high-quality printing.');
    });

    it('says the file declares no restrictions when every bit is set', () => {
      expect(withP(-4)?.permissions).toContain('declares no restrictions');
    });

    it('reads an unsigned /P as the 32-bit value it stands for', () => {
      expect(withP(4294967292)?.permissions).toContain('declares no restrictions');
    });

    it('ignores the revision 3 bits for revision 2', () => {
      expect(withP(-1 & ~(1 << 8), 2)?.permissions).toContain('declares no restrictions');
    });

    it('gives no permissions sentence when /P is missing', () => {
      const out = readPdfEncryption(pdf({ encrypt: '<< /Filter /Standard /V 1 /R 2 >>' }));
      expect(out?.permissions).toBeUndefined();
    });
  });
});
