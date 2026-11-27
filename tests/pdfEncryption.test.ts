import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { readPdfEncryption } from '../src/pdfEncryption';

const OU = '/O <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> /U (a\\)>>b)';

/** The bytes of a string, one per character. */
const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
const textOf = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** A PDF whose trailer (or xref stream) names the Encrypt dictionary in `encrypt` (or object 9). */
function pdf(opts: {
  encrypt?: string;
  direct?: string;
  stream?: boolean;
  pad?: number;
  /** Text placed between the objects and the cross-reference section. */
  before?: string;
  /** Replaces the xref stream's data, with `streamDict` for the entries that describe it. */
  streamData?: Uint8Array;
  streamDict?: string;
}): Uint8Array {
  let body = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  body += 'x'.repeat(opts.pad ?? 0) + '\n';
  const objectAt = body.length;
  if (opts.encrypt !== undefined) {
    body += `9 0 obj\n${opts.encrypt}\nendobj\n`;
  }
  body += opts.before ?? '';
  const ref = opts.direct ?? (opts.encrypt !== undefined ? '9 0 R' : '');
  const enc = ref ? ` /Encrypt ${ref}` : '';
  const at = body.length;
  if (opts.stream) {
    // One entry, for object 9: type 1, a 4-byte offset, a 1-byte generation.
    const data =
      opts.streamData ??
      Uint8Array.from(
        [1, objectAt >>> 24, objectAt >>> 16, objectAt >>> 8, objectAt, 0].map((x) => x & 0xff),
      );
    body += `10 0 obj\n<< /Type /XRef /Size 11 /Index [9 1] /W [1 4 1] /Root 1 0 R${enc} ${opts.streamDict ?? ''} /Length ${data.length} >>\nstream\n`;
    return Uint8Array.from([
      ...bytesOf(body),
      ...data,
      ...bytesOf(`\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`),
    ]);
  }
  const entry = `${String(objectAt).padStart(10, '0')} 00000 n \n`;
  body += `xref\n0 1\n0000000000 65535 f \n9 1\n${entry}trailer\n<< /Size 10 /Root 1 0 R${enc} /ID [<AA><BB>] >>\n`;
  body += `startxref\n${at}\n%%EOF\n`;
  return bytesOf(body);
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

  it('cleans and bounds a handler name taken from the file (found by the pdf-encryption fuzz target)', () => {
    // #00 is a NUL in a PDF name, #20 a space; neither may reach the label.
    const nul = readPdfEncryption(pdf({ encrypt: '<< /Filter /Standar#00V /V 4 >>' }));
    expect(nul?.label).toBe('Encrypted: StandarV security handler, cipher not determined');
    const long = readPdfEncryption(pdf({ encrypt: `<< /Filter /${'A'.repeat(500)} /V 4 >>` }));
    expect(long?.label.length).toBeLessThan(120);
    const blank = readPdfEncryption(pdf({ encrypt: '<< /Filter /#01#02 /V 4 >>' }));
    expect(blank?.label).toBe('Encrypted: the encryption details were not determined.');
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

  describe('finding the Encrypt object', () => {
    const real =
      '<< /Filter /Standard /V 5 /R 6 /CF << /StdCF << /CFM /AESV3 >> >> /StmF /StdCF /P -1 >>';
    const decoy = '<< /Filter /Standard /V 1 /R 2 /P -4 >>';
    const NOT_DETERMINED = 'Encrypted: the encryption details were not determined.';

    it('is not taken from an object-shaped comment before the xref section', () => {
      const out = readPdfEncryption(
        pdf({ encrypt: real, before: `% example: 9 0 obj ${decoy}\n` }),
      );
      expect(out?.label).toBe('Encrypted: AES-256 (standard security handler, revision 6)');
      expect(out?.permissions).toContain('declares no restrictions');
    });

    it('is not taken from object-shaped text in a stream either', () => {
      const stream = `5 0 obj\n<< /Length 40 >>\nstream\n\n9 0 obj ${decoy}\nendstream\nendobj\n`;
      const out = readPdfEncryption(pdf({ encrypt: real, before: stream }));
      expect(out?.label).toContain('AES-256');
    });

    it('reports not determined when the xref offset does not lead to the object', () => {
      const moved = textOf(pdf({ encrypt: real })).replace(/\d{10} 00000 n/, '0000000003 00000 n');
      expect(readPdfEncryption(bytesOf(moved))?.label).toBe(NOT_DETERMINED);
    });

    it('reports not determined when the object is not listed', () => {
      const text = textOf(pdf({ encrypt: real })).replace('9 1\n', '3 1\n');
      expect(readPdfEncryption(bytesOf(text))?.label).toBe(NOT_DETERMINED);
    });

    it('reads the entry from a cross-reference stream, not from a decoy', () => {
      const out = readPdfEncryption(
        pdf({ encrypt: real, stream: true, before: `% 9 0 obj ${decoy}\n` }),
      );
      expect(out?.label).toContain('AES-256');
    });

    it('reads a Flate cross-reference stream with a PNG predictor', () => {
      const objectAt = textOf(pdf({ encrypt: real })).indexOf('9 0 obj');
      // One row of 6 bytes after its Up tag: type 1, a 4-byte offset, generation 0.
      const row = Uint8Array.from([2, 1, 0, 0, objectAt >> 8, objectAt & 0xff, 0]);
      const out = readPdfEncryption(
        pdf({
          encrypt: real,
          stream: true,
          streamData: zlibSync(row),
          streamDict: '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 6 >>',
        }),
      );
      expect(out?.label).toContain('AES-256');
    });

    /** PNG-filters rows of equal length with one filter type (1 Sub, 2 Up, 3 Average, 4 Paeth). */
    const pngRows = (rows: number[][], tag: number): Uint8Array => {
      const out: number[] = [];
      rows.forEach((row, r) => {
        out.push(tag);
        row.forEach((raw, c) => {
          const left = c > 0 ? row[c - 1] : 0;
          const up = r > 0 ? rows[r - 1][c] : 0;
          const upLeft = r > 0 && c > 0 ? rows[r - 1][c - 1] : 0;
          const p = left + up - upLeft;
          const nearest = [left, up, upLeft].reduce((best, v) =>
            Math.abs(p - v) < Math.abs(p - best) ? v : best,
          );
          const predicted = [0, left, up, (left + up) >> 1, nearest][tag];
          out.push((raw - predicted) & 0xff);
        });
      });
      return Uint8Array.from(out);
    };

    it.each([
      [1, 'Sub'],
      [2, 'Up'],
      [3, 'Average'],
      [4, 'Paeth'],
    ])('undoes PNG row filter %i (%s) in a cross-reference stream', (tag) => {
      const objectAt = textOf(pdf({ encrypt: real })).indexOf('9 0 obj');
      // Two rows, objects 8 and 9, so Up, Average and Paeth have a row above.
      const rows = [
        [1, 0, 0, 0x12, 0x34, 0],
        [1, 0, 0, objectAt >> 8, objectAt & 0xff, 0],
      ];
      const out = readPdfEncryption(
        pdf({
          encrypt: real,
          stream: true,
          streamData: zlibSync(pngRows(rows, tag)),
          streamDict:
            '/Index [8 2] /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 6 >>',
        }),
      );
      expect(out?.label).toBe('Encrypted: AES-256 (standard security handler, revision 6)');
    });

    it('reads a single filter written as a one-element array, from the same bytes', () => {
      const objectAt = textOf(pdf({ encrypt: real })).indexOf('9 0 obj');
      const streamData = zlibSync(Uint8Array.from([2, 1, 0, 0, objectAt >> 8, objectAt & 0xff, 0]));
      const parms = '<< /Predictor 12 /Columns 6 >>';
      for (const streamDict of [
        `/Filter /FlateDecode /DecodeParms ${parms}`,
        `/Filter [/FlateDecode] /DecodeParms ${parms}`,
        `/Filter [/FlateDecode] /DecodeParms [${parms}]`,
      ]) {
        const out = readPdfEncryption(pdf({ encrypt: real, stream: true, streamData, streamDict }));
        expect(out?.label, streamDict).toBe(
          'Encrypted: AES-256 (standard security handler, revision 6)',
        );
      }
    });

    it('reports not determined for a row filter PNG does not define', () => {
      const objectAt = textOf(pdf({ encrypt: real })).indexOf('9 0 obj');
      const row = Uint8Array.from([5, 1, 0, 0, objectAt >> 8, objectAt & 0xff, 0]);
      const out = readPdfEncryption(
        pdf({
          encrypt: real,
          stream: true,
          streamData: zlibSync(row),
          streamDict: '/Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 6 >>',
        }),
      );
      expect(out?.label).toBe(NOT_DETERMINED);
    });

    it('reads a classic table whose trailer lies past the 64 KiB window', () => {
      // 4,000 free entries (80,000 bytes) before the subsection that lists object 9.
      const filler = `10 4000\n${'0000000000 65535 f \n'.repeat(4000)}`;
      const text = textOf(pdf({ encrypt: real })).replace('9 1\n', `${filler}9 1\n`);
      expect(text.indexOf('trailer') - text.indexOf('xref\n')).toBeGreaterThan(64 * 1024);
      const out = readPdfEncryption(bytesOf(text));
      expect(out?.label).toBe('Encrypted: AES-256 (standard security handler, revision 6)');
    });

    it('reads a cross-reference stream longer than the 64 KiB window', () => {
      const objectAt = textOf(pdf({ encrypt: real })).indexOf('9 0 obj');
      // The index lists 20,000 free entries (objects 100 to 20099) and then
      // object 9, so its entry sits 120,000 bytes into the stream.
      const data = new Uint8Array(20_001 * 6);
      data.set([1, 0, 0, objectAt >> 8, objectAt & 0xff, 0], 20_000 * 6);
      expect(data.length).toBeGreaterThan(64 * 1024);
      const out = readPdfEncryption(
        pdf({
          encrypt: real,
          stream: true,
          streamData: data,
          streamDict: '/Index [100 20000 9 1]',
        }),
      );
      expect(out?.label).toBe('Encrypted: AES-256 (standard security handler, revision 6)');
    });

    it('follows /Prev to an older table for an object the newest one lacks', () => {
      const base = textOf(pdf({ encrypt: real }));
      const older = base.indexOf('xref\n0 1');
      const update = `${base}% update\n`;
      const text =
        update +
        `xref\n20 1\n0000000000 00000 f \ntrailer\n<< /Size 21 /Root 1 0 R /Encrypt 9 0 R /Prev ${older} >>\n` +
        `startxref\n${update.length}\n%%EOF\n`;
      expect(readPdfEncryption(bytesOf(text))?.label).toContain('AES-256');
    });
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

    it('lets bit 6 allow form filling from revision 3, as bit 9 does', () => {
      // /P -260: bit 6 set, bit 9 clear.
      expect(withP(-260)?.permissions).not.toContain('filling in forms');
      // Bit 9 set, bit 6 clear.
      expect(withP(-1 & ~(1 << 5))?.permissions).not.toContain('filling in forms');
      // Both clear.
      expect(withP(-1 & ~(1 << 5) & ~(1 << 8))?.permissions).toContain('filling in forms');
    });

    it('does not give bit 9 a meaning for revision 2', () => {
      expect(withP(-1 & ~(1 << 5), 2)?.permissions).toBe(
        'The file restricts: adding or editing annotations. Whether a viewer honours this is up to the viewer.',
      );
    });

    it('gives no permissions sentence when /P is missing', () => {
      const out = readPdfEncryption(pdf({ encrypt: '<< /Filter /Standard /V 1 /R 2 >>' }));
      expect(out?.permissions).toBeUndefined();
    });
  });
});
