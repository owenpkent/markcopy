// @vitest-environment node
//
// The encryption labels for 7z, RAR, OpenPGP, age, KeePass, LUKS and key
// files: every label branch from exact bytes, the caps, truncation, and that
// nothing secret (salts, IVs, wrapped keys) reaches a result. The same bytes go
// through readPackage, so the probe table is covered too.
import { describe, expect, it } from 'vitest';
import { bytesSource } from '../../src/binary/reader';
import { readPackage, renderPackageHtml, type PackageInfo } from '../../src/pkg';
import { readAge, parseAgeHeader } from '../../src/pkg/age';
import { decodeBase64 } from '../../src/pkg/base64';
import { readKeePass } from '../../src/pkg/keepass';
import { readOpenPgp } from '../../src/pkg/openpgp';
import { readLuks } from '../../src/pkg/luks';
import { readPem, readPkcs12 } from '../../src/pkg/keyFiles';
import { readRar } from '../../src/pkg/rar';
import { readSevenZip } from '../../src/pkg/sevenZip';
import * as fx from './encryptionFixture';

const dispatch = (bytes: Uint8Array, name = 'file.bin'): Promise<PackageInfo> =>
  readPackage(bytesSource(bytes), name);
const rowsOf = (info: PackageInfo, heading = 'Encryption'): Record<string, string> => {
  const s = info.sections.find((x) => x.heading === heading);
  return s?.kind === 'properties' ? Object.fromEntries(s.rows) : {};
};
const tableOf = (info: PackageInfo, heading: string): string[][] => {
  const s = info.sections.find((x) => x.heading === heading);
  return s?.kind === 'table' ? s.rows : [];
};
/** Everything a page would show, as one string, to look for what must not be there. */
const everything = (info: PackageInfo): string =>
  JSON.stringify(info) + renderPackageHtml(info, { fileName: 'f', fileSize: 1, sha256: '' });
const noSecret = (info: PackageInfo): void => {
  const text = everything(info).toLowerCase();
  expect(text).not.toContain('abab');
  expect(text).not.toContain('q6ur'); // 0xab bytes in base64
  expect(text).not.toContain('qqqq');
};

describe('7z', () => {
  const read = (b: Uint8Array): Promise<PackageInfo> => readSevenZip(fx.reader(b));

  it('labels an encrypted header: file names, key derivation, and entries not determined', async () => {
    const info = await read(fx.sevenZipEncoded([[fx.AES_CODER(19), fx.LZMA]]));
    const rows = rowsOf(info);
    expect(rows['Format version']).toBe('0.4');
    expect(rows['File names']).toBe('encrypted (AES-256)');
    expect(rows['Key derivation']).toBe('SHA-256, 2^19 rounds');
    expect(rows['Header']).toBe('encoded (AES-256, LZMA)');
    expect(rows['Entries']).toBe('not determined (the header is encrypted)');
    noSecret(info);
  });

  it('does not guess when the header is only compressed', async () => {
    const info = await read(fx.sevenZipEncoded([[fx.LZMA]]));
    expect(rowsOf(info)['Entry encryption']).toBe('not determined (the header is compressed)');
    expect(rowsOf(info)['File names']).toBeUndefined();
  });

  it('labels a readable header whose data folder is encrypted', async () => {
    const info = await read(fx.sevenZipPlain([[fx.AES_CODER(18), fx.LZMA]]));
    const rows = rowsOf(info);
    expect(rows['File names']).toBe('not encrypted (the header is readable)');
    expect(rows['Entries']).toBe('encrypted (AES-256)');
    expect(rows['Key derivation']).toBe('SHA-256, 2^18 rounds');
    noSecret(info);
  });

  it('counts the encrypted data blocks when only some are', async () => {
    const info = await read(fx.sevenZipPlain([[fx.AES_CODER(), fx.LZMA], [fx.LZMA]]));
    expect(rowsOf(info)['Entries']).toBe('encrypted (AES-256) in 1 of 2 data blocks');
  });

  it('labels a readable header with no AES coder as not encrypted', async () => {
    const info = await read(fx.sevenZipPlain([[fx.LZMA]]));
    expect(rowsOf(info)['Entries']).toBe('not encrypted');
  });

  it('says so when the archive stores no data', async () => {
    const info = await read(fx.build7z([0x01, 0x05, 0x00, 0x00]));
    expect(rowsOf(info)['Entries']).toBe('not encrypted (no stored data)');
  });

  it('reports an empty archive', async () => {
    const empty = fx.build7z([], { declaredSize: 0 });
    expect(rowsOf(await read(empty))['Entries']).toBe('none (an empty archive)');
  });

  it('does not determine the key derivation when the exponent is out of range', async () => {
    const odd = { ...fx.AES_CODER(), props: [0x3f] };
    const info = await read(fx.sevenZipPlain([[odd]]));
    expect(rowsOf(info)['Key derivation']).toBe('not determined');
  });

  it('reads only the first folders when the header declares more than the cap', async () => {
    const many = Array.from({ length: 4096 }, () => [fx.LZMA]);
    // The 4097th folder is declared but not present.
    const bytes = fx.build7z([0x01, 0x04, ...fx.szStreams(many, 5000), 0x05, 0x00, 0x00]);
    const info = await read(bytes);
    expect(rowsOf(info)['Entries']).toBe('not encrypted in the first 4,096 of 5,000 data blocks');
  });

  it('is not determined, not an error, when the header is cut short or is not a header', async () => {
    const cut = fx.sevenZipPlain([[fx.AES_CODER()]]).subarray(0, 45);
    expect(rowsOf(await read(cut))['Entry encryption']).toContain('cut short');
    const junk = fx.build7z([0x01, 0x04, 0x07, 0x0b, 0x7f]);
    const info = await read(junk);
    expect(rowsOf(info)['Entry encryption']).toContain('not determined');
    expect(info.warnings.length).toBe(1);
    const tiny = await read(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
    expect(rowsOf(tiny)['Entry encryption']).toContain('not determined');
  });

  it('is chosen by the signature, whatever the name', async () => {
    const info = await dispatch(fx.sevenZipEncoded([[fx.AES_CODER(), fx.LZMA]]), 'x.bin');
    expect(info.format).toBe('7-Zip archive');
  });
});

describe('RAR', () => {
  const read = (b: Uint8Array): Promise<PackageInfo> => readRar(fx.reader(b));

  it('RAR5: encrypted headers hide the names, with the KDF strength', async () => {
    const info = await read(fx.rar5(fx.rar5Main(), fx.rar5EncryptionHeader(15), fx.secret(40)));
    const rows = rowsOf(info);
    expect(rows['File names']).toBe('encrypted (AES-256)');
    expect(rows['Key derivation']).toBe('PBKDF2 (HMAC-SHA256), 2^15 iterations');
    expect(info.format).toBe('RAR archive (RAR 5)');
    noSecret(info);
  });

  it('RAR5: counts file headers with an encryption record', async () => {
    const info = await read(
      fx.rar5(
        fx.rar5Main(),
        fx.rar5File('a.txt', { kdf: 15 }),
        fx.rar5File('b.txt'),
        fx.rar5File('c.txt', { kdf: 15 }),
        fx.rar5End(),
      ),
    );
    const rows = rowsOf(info);
    expect(rows['File names']).toBe('not encrypted (the headers are readable)');
    expect(rows['Entries']).toBe('AES-256: 2 of 3 entries read');
    expect(rows['Key derivation']).toBe('PBKDF2 (HMAC-SHA256), 2^15 iterations');
    expect(rows['Entries read']).toBeUndefined();
    noSecret(info);
  });

  it('RAR5: unencrypted archive', async () => {
    const info = await read(fx.rar5(fx.rar5Main(), fx.rar5File('a.txt'), fx.rar5End()));
    expect(rowsOf(info)['Entries']).toBe('none of 1 entries read are encrypted');
  });

  it('RAR5: an unknown encryption version and an out-of-range KDF are not determined', async () => {
    const info = await read(
      fx.rar5(fx.rar5Main(), fx.rar5File('a', { kdf: 40, version: 3 }), fx.rar5End()),
    );
    const rows = rowsOf(info);
    expect(rows['Entries']).toContain('not determined (encryption version 3)');
    expect(rows['Key derivation']).toBe('not determined');
  });

  it('RAR5: stops at the header cap and says how many were read', async () => {
    const files = Array.from({ length: 1005 }, (_, i) =>
      fx.rar5File(`f${i}`, i % 2 ? { kdf: 15 } : undefined),
    );
    const info = await read(fx.rar5(fx.rar5Main(), ...files));
    const rows = rowsOf(info);
    expect(rows['Entries']).toBe('AES-256: 499 of 999 entries read');
    expect(rows['Entries read']).toContain('the cap of 1,000 headers');
  });

  it('RAR5: a cut archive reports what was read and stops', async () => {
    const bytes = fx.rar5(fx.rar5Main(), fx.rar5File('a.txt', { kdf: 15 }), fx.rar5File('b.txt'));
    const info = await read(bytes.subarray(0, bytes.length - 50));
    expect(rowsOf(info)['Entries']).toBe('AES-256: 1 of 1 entries read');
    expect(rowsOf(info)['Entries read']).toContain('the file ends before the end block');
  });

  it('RAR4: password-protected headers', async () => {
    const info = await read(fx.rar4(fx.rar4Main(true), fx.secret(20)));
    expect(rowsOf(info)['File names']).toBe('encrypted (RAR 2.9 format (legacy AES-128))');
    expect(info.format).toBe('RAR archive (RAR 2.9 to 4.x)');
  });

  it('RAR4: per-file encryption flag', async () => {
    const info = await read(
      fx.rar4(fx.rar4Main(), fx.rar4File('a.txt', true), fx.rar4File('b.txt'), fx.rar4End()),
    );
    const rows = rowsOf(info);
    expect(rows['File names']).toBe('not encrypted (the headers are readable)');
    expect(rows['Entries']).toBe('RAR 2.9 format (legacy AES-128): 1 of 2 entries read');
  });

  it('RAR4: unencrypted, and a header of impossible size', async () => {
    const plain = await read(fx.rar4(fx.rar4Main(), fx.rar4File('a'), fx.rar4End()));
    expect(rowsOf(plain)['Entries']).toBe('none of 1 entries read are encrypted');
    const bad = await read(fx.rar4(fx.rar4Main(), [0, 0, 0x74, 0, 0, 3, 0, 0, 0, 0]));
    expect(rowsOf(bad)['Entries']).toContain('not determined');
  });

  it('is chosen by the signature (RAR5 and RAR4), not by the name', async () => {
    expect((await dispatch(fx.rar5(fx.rar5Main(), fx.rar5End()), 'a.bin')).format).toContain(
      'RAR 5',
    );
    expect((await dispatch(fx.rar4(fx.rar4Main(), fx.rar4End()), 'a.bin')).format).toContain('2.9');
  });
});

describe('OpenPGP', () => {
  const read = (b: Uint8Array): Promise<PackageInfo> => readOpenPgp(fx.reader(b));
  const bin = (...packets: number[][]): Uint8Array => fx.concat(...packets);

  it('lists public-key recipients by key ID and algorithm, and the SEIPD v1 data packet', async () => {
    const info = await read(
      bin(
        fx.newPacket(1, fx.pkesk('1700B4E8F8F513AA', 18)),
        fx.newPacket(1, fx.pkesk('00000000DEADBEEF', 1)),
        fx.newPacket(18, fx.SEIPD1),
      ),
    );
    const rows = rowsOf(info);
    expect(rows['Kind']).toBe('An encrypted OpenPGP message');
    expect(rows['Public-key recipients']).toBe('2');
    expect(rows['Data']).toBe('Encrypted data with integrity protection (SEIPD v1, MDC)');
    expect(tableOf(info, 'Recipients').flat()).toEqual([
      'Encrypted to key ID 0x1700B4E8F8F513AA (ECDH)',
      'Encrypted to key ID 0x00000000DEADBEEF (RSA)',
    ]);
  });

  it('shows an all-zero key ID as a hidden recipient', async () => {
    const info = await read(
      bin(fx.newPacket(1, fx.pkesk('0000000000000000', 25)), fx.newPacket(18, fx.SEIPD1)),
    );
    expect(tableOf(info, 'Recipients')[0][0]).toBe(
      'Encrypted to a hidden recipient (key ID not stored) (X25519)',
    );
  });

  it('labels a v6 recipient by the key ID taken from its fingerprint', async () => {
    const fingerprint = [6, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, ...fx.secret(24)];
    const body = [6, fingerprint.length, ...fingerprint, 27, ...fx.secret(8)];
    const info = await read(bin(fx.newPacket(1, body), fx.newPacket(18, fx.SEIPD1)));
    expect(tableOf(info, 'Recipients')[0][0]).toBe(
      'Encrypted to key ID 0x1122334455667788 (Ed25519)',
    );
  });

  it('labels passphrase packets with the S2K and cipher', async () => {
    const iterated = fx.skesk4(9, fx.s2kIterated(8, 0xff));
    const info = await read(bin(fx.newPacket(3, iterated), fx.newPacket(18, fx.SEIPD1)));
    expect(tableOf(info, 'Recipients')[0][0]).toBe(
      'Encrypted with a passphrase (S2K iterated and salted, SHA-256, 65,011,712 bytes hashed, AES-256)',
    );
    expect(rowsOf(info)['Passphrase recipients']).toBe('1');
    const simple = await read(
      bin(fx.newPacket(3, fx.skesk4(3, [0, 2])), fx.newPacket(9, fx.secret(20))),
    );
    expect(tableOf(simple, 'Recipients')[0][0]).toBe(
      'Encrypted with a passphrase (S2K simple, unsalted (legacy), SHA-1, CAST5 (legacy))',
    );
    expect(rowsOf(simple)['Data']).toContain('legacy, no integrity protection');
    const salted = await read(
      bin(fx.newPacket(3, fx.skesk4(7, [1, 10, ...fx.secret(8)])), fx.newPacket(18, fx.SEIPD1)),
    );
    expect(tableOf(salted, 'Recipients')[0][0]).toBe(
      'Encrypted with a passphrase (S2K salted, SHA-512, AES-128)',
    );
    const argon = await read(
      bin(
        fx.newPacket(3, fx.skesk4(9, [4, ...fx.secret(16), 3, 4, 21])),
        fx.newPacket(18, fx.SEIPD1),
      ),
    );
    expect(tableOf(argon, 'Recipients')[0][0]).toContain(
      'S2K Argon2, 3 passes, 4 lanes, 2^21 KiB memory',
    );
    noSecret(argon);
  });

  it('labels SEIPD v2 with its AEAD mode, and the tag 20 AEAD packet', async () => {
    const v2 = await read(bin(fx.newPacket(18, [2, 9, 2, 6, ...fx.secret(32)])));
    expect(rowsOf(v2)['Data']).toBe('Encrypted data, SEIPD v2 (AEAD OCB, AES-256)');
    const aead = await read(bin(fx.newPacket(20, [1, 7, 1, 6, ...fx.secret(16)])));
    expect(rowsOf(aead)['Data']).toBe('AEAD encrypted data packet (tag 20, EAX, AES-128)');
    const future = await read(bin(fx.newPacket(18, [7, ...fx.secret(8)])));
    expect(rowsOf(future)['Data']).toContain('not determined');
  });

  it('reads old-format packet headers and partial lengths on a data packet', async () => {
    const old = await read(
      bin(fx.oldPacket(1, fx.pkesk('1700B4E8F8F513AA', 16)), fx.oldPacket(9, fx.secret(30))),
    );
    expect(tableOf(old, 'Recipients')[0][0]).toContain('(Elgamal)');
    expect(rowsOf(old)['Data']).toContain('legacy');
    // A SEIPD packet whose first chunk is a partial length (2^6 bytes).
    const partial = [0xc0 | 18, 0xe0 | 6, 1, ...fx.secret(63)];
    const p = await read(bin(fx.newPacket(1, fx.pkesk('1700B4E8F8F513AA', 18)), partial));
    expect(rowsOf(p)['Data']).toBe('Encrypted data with integrity protection (SEIPD v1, MDC)');
    // An indeterminate old-format length runs to the end of the file.
    const open = await read(
      bin([0x80 | (18 << 2) | 3 /* not a valid old tag, but a length type 3 */]),
    );
    expect(open.warnings).toEqual([]);
  });

  it('refuses partial lengths where they are not allowed', async () => {
    const bad = [0xc0 | 1, 0xe0 | 4, ...fx.secret(16)];
    const info = await read(bin(bad));
    expect(rowsOf(info)['Read']).toContain('partial lengths');
    expect(rowsOf(info)['Public-key recipients']).toBeUndefined();
  });

  it('says what signed-only and key files are, without parsing further', async () => {
    const sig = await read(bin(fx.newPacket(2, [4, 0, 22, 8, ...fx.secret(10)])));
    expect(rowsOf(sig)['Kind']).toBe('An OpenPGP signature');
    expect(rowsOf(sig)['Encrypted message']).toBe('no');
    const pub = await read(
      bin(
        fx.newPacket(6, [4, ...fx.secret(20)]),
        fx.newPacket(13, fx.enc('User')),
        fx.newPacket(2, fx.secret(12)),
      ),
    );
    expect(rowsOf(pub)['Kind']).toBe('An OpenPGP public key');
    const sec = await read(bin(fx.newPacket(5, [4, ...fx.secret(20)])));
    expect(rowsOf(sec)['Kind']).toBe('An OpenPGP secret key');
    const literal = await read(bin(fx.newPacket(11, [0x62, 0, 0, 0, 0, 0, 0, 0, 0])));
    expect(rowsOf(literal)['Contains']).toBe('Literal data (not encrypted)');
  });

  it('decodes only the first armored block, and recognises a cleartext signature', async () => {
    const msg = [
      ...fx.newPacket(1, fx.pkesk('1700B4E8F8F513AA', 18)),
      ...fx.newPacket(18, fx.SEIPD1),
    ];
    const text =
      fx.armor('PGP MESSAGE', msg, ['Version: test']) +
      fx.armor('PGP MESSAGE', fx.newPacket(18, fx.SEIPD1));
    const info = await read(new TextEncoder().encode(text));
    expect(info.format).toBe('OpenPGP file (ASCII armor)');
    expect(rowsOf(info)['Armor']).toBe('ASCII armor (PGP MESSAGE)');
    expect(rowsOf(info)['Public-key recipients']).toBe('1');
    const clear = await read(
      new TextEncoder().encode(
        '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nhello\n-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----\n',
      ),
    );
    expect(clear.format).toBe('OpenPGP cleartext signed message');
    expect(rowsOf(clear)['Encryption']).toBe('none (the text is readable)');
  });

  it('stops at the packet cap and at a truncated packet', async () => {
    const many = Array.from({ length: 70 }, () => fx.newPacket(13, fx.enc('u')));
    const capped = await read(bin(...many));
    expect(rowsOf(capped)['Read']).toContain('only the first 64 packets');
    const cut = await read(bin(fx.newPacket(1, fx.pkesk('1700B4E8F8F513AA', 18))).subarray(0, 8));
    expect(rowsOf(cut)['Read']).toBeDefined();
  });

  it('caps the recipients it lists', async () => {
    const recipients = Array.from({ length: 40 }, () =>
      fx.newPacket(1, fx.pkesk('1700B4E8F8F513AA', 18)),
    );
    const info = await read(bin(...recipients, fx.newPacket(18, fx.SEIPD1)));
    expect(rowsOf(info)['Public-key recipients']).toBe('40');
    expect(tableOf(info, 'Recipients').length).toBe(16);
  });

  it('is chosen by an armor line, or by a .gpg or .pgp name plus a valid first packet', async () => {
    const gpg = bin(fx.newPacket(1, fx.pkesk('1700B4E8F8F513AA', 18)), fx.newPacket(18, fx.SEIPD1));
    expect((await dispatch(gpg, 'm.gpg')).format).toBe('OpenPGP file');
    expect((await dispatch(gpg, 'm.PGP')).format).toBe('OpenPGP file');
    await expect(dispatch(gpg, 'm.bin')).rejects.toThrow();
    await expect(dispatch(fx.concat(fx.secret(30)), 'm.gpg')).rejects.toThrow();
    const asc = new TextEncoder().encode(fx.armor('PGP MESSAGE', [...gpg]));
    expect((await dispatch(asc, 'm.txt')).format).toBe('OpenPGP file (ASCII armor)');
  });
});

describe('age', () => {
  const read = (text: string | Uint8Array): Promise<PackageInfo> =>
    readAge(fx.reader(typeof text === 'string' ? new TextEncoder().encode(text) : text));

  it('counts stanzas by type, with scrypt work factor and plugin names', async () => {
    const info = await read(
      fx.ageFile([
        '-> X25519 ' + 'A'.repeat(43),
        '-> X25519 ' + 'B'.repeat(43),
        '-> scrypt ' + 'C'.repeat(22) + ' 18',
        '-> ssh-ed25519 AbCdEf ' + 'D'.repeat(43),
        '-> ssh-rsa AbCdEf',
        '-> piv-p256 AbCdEf ' + 'E'.repeat(44),
      ]),
    );
    const rows = rowsOf(info);
    expect(rows['Recipient stanzas']).toBe('6');
    expect(rows['X25519 recipient']).toBe('2');
    expect(rows['Passphrase (scrypt)']).toBe('1 (work factor 2^18)');
    expect(rows['SSH ed25519 recipient']).toBe('1');
    expect(rows['SSH RSA recipient']).toBe('1');
    expect(rows['Plugin: piv-p256']).toBe('1');
    expect(rows['Payload cipher']).toContain('ChaCha20-Poly1305');
    const text = everything(info);
    for (const arg of [
      'AAAAAAAA',
      'BBBBBBBB',
      'CCCCCCCC',
      'DDDDDDDD',
      'EEEEEEEE',
      'AbCdEf',
      'QUJDREVGRw',
    ]) {
      expect(text).not.toContain(arg);
    }
  });

  it('does not take a scrypt work factor that is not a number or is out of range', async () => {
    const a = await read(fx.ageFile(['-> scrypt SALT 99']));
    expect(rowsOf(a)['Passphrase (scrypt)']).toBe('1 (work factor not determined)');
    const b = await read(fx.ageFile(['-> scrypt SALT x']));
    expect(rowsOf(b)['Passphrase (scrypt)']).toBe('1 (work factor not determined)');
  });

  it('reads an armored file by decoding only its start', async () => {
    const binary = fx.enc(fx.ageFile(['-> X25519 ' + 'A'.repeat(43)]));
    const text = fx.armor('AGE ENCRYPTED FILE', binary).replace('=AAAA\n', '');
    const info = await read(text);
    expect(rowsOf(info)['Format']).toBe('age v1 (ASCII armor)');
    expect(rowsOf(info)['X25519 recipient']).toBe('1');
    expect(info.format).toBe('age encrypted file (ASCII armor)');
  });

  it('caps stanzas and distinct types', async () => {
    const parsed = parseAgeHeader(
      ['age-encryption.org/v1', ...Array.from({ length: 1100 }, () => '-> X25519 A'), '--- x'].join(
        '\n',
      ),
    )!;
    expect(parsed.total).toBe(1000);
    expect(parsed.truncated).toBe(true);
    const types = parseAgeHeader(
      [
        'age-encryption.org/v1',
        ...Array.from({ length: 30 }, (_, i) => `-> t${i} A`),
        '--- x',
      ].join('\n'),
    )!;
    expect(types.stanzas.length).toBe(16);
    expect(types.truncated).toBe(true);
  });

  it('refuses a header that is not age, and says so without failing', async () => {
    const info = await read('age-encryption.org/v2\n-> X25519 A\n--- x\n');
    expect(rowsOf(info)['Recipients']).toContain('not determined');
    expect(info.warnings.length).toBe(1);
  });

  it('notes a header that does not end inside the read window', async () => {
    const long = 'age-encryption.org/v1\n' + '-> X25519 A\nQUJD\n'.repeat(6000);
    const info = await read(long);
    expect(rowsOf(info)['Header']).toContain('not determined beyond');
  });

  it('is chosen by the text header or the armor line', async () => {
    expect(
      (await dispatch(new TextEncoder().encode(fx.ageFile(['-> X25519 A'])), 'f.age')).format,
    ).toBe('age encrypted file');
    const armored = fx.armor('AGE ENCRYPTED FILE', fx.enc(fx.ageFile(['-> X25519 A'])));
    expect((await dispatch(new TextEncoder().encode(armored), 'f.age')).format).toBe(
      'age encrypted file (ASCII armor)',
    );
  });
});

describe('KeePass', () => {
  const read = (b: Uint8Array): Promise<PackageInfo> => readKeePass(fx.reader(b));

  it('KDBX 3.1: cipher, compression, AES-KDF rounds', async () => {
    const info = await read(fx.kdbx3({ rounds: 60000 }));
    const rows = rowsOf(info);
    expect(rows['Format version']).toBe('3.1');
    expect(rows['Cipher']).toBe('AES-256');
    expect(rows['Compression']).toBe('gzip');
    expect(rows['Key derivation']).toBe('AES-KDF');
    expect(rows['Transform rounds']).toBe('60,000');
    expect(rows['Database contents']).toBe('encrypted');
    noSecret(info);
  });

  it('KDBX 3: Twofish, no compression, and an unknown cipher shown by its public id', async () => {
    const t = await read(fx.kdbx3({ cipher: fx.TWOFISH_CIPHER, compression: 0 }));
    expect(rowsOf(t)['Cipher']).toBe('Twofish');
    expect(rowsOf(t)['Compression']).toBe('none');
    const u = await read(fx.kdbx3({ cipher: '00112233445566778899aabbccddeeff' }));
    expect(rowsOf(u)['Cipher']).toBe('unknown (id 00112233445566778899aabbccddeeff)');
  });

  it('KDBX 4: Argon2d parameters', async () => {
    const kdf = fx.variantDictionary([
      fx.dictBytes('$UUID', fx.hex(fx.ARGON2D)),
      fx.dictBytes('S', fx.secret(32)),
      fx.dictU64('I', 3),
      fx.dictU64('M', 64 * 1024 * 1024),
      fx.dictU32('P', 2),
      fx.dictU32('V', 0x13),
    ]);
    const info = await read(fx.kdbx4(kdf, { minor: 1 }));
    const rows = rowsOf(info);
    expect(rows['Format version']).toBe('4.1');
    expect(rows['Cipher']).toBe('ChaCha20');
    expect(rows['Key derivation']).toBe('Argon2d');
    expect(rows['Iterations']).toBe('3');
    expect(rows['Memory']).toBe('64.0 MB');
    expect(rows['Parallelism']).toBe('2');
    expect(rows['Argon2 version']).toBe('0x13');
    noSecret(info);
  });

  it('KDBX 4: Argon2id, and AES-KDF with its rounds', async () => {
    const id = await read(
      fx.kdbx4(
        fx.variantDictionary([
          fx.dictBytes('$UUID', fx.hex(fx.ARGON2ID)),
          fx.dictU64('I', 10),
          fx.dictU64('M', 1024 * 1024),
          fx.dictU32('P', 4),
        ]),
        { minor: 0 },
      ),
    );
    expect(rowsOf(id)['Key derivation']).toBe('Argon2id');
    expect(rowsOf(id)['Format version']).toBe('4.0');
    const aes = await read(
      fx.kdbx4(
        fx.variantDictionary([
          fx.dictBytes('$UUID', fx.hex(fx.AES_KDF_V4)),
          fx.dictBytes('S', fx.secret(32)),
          fx.dictU64('R', 100000),
        ]),
        { cipher: '31c1f2e6bf714350be5805216afc5aff' },
      ),
    );
    expect(rowsOf(aes)['Key derivation']).toBe('AES-KDF');
    expect(rowsOf(aes)['Transform rounds']).toBe('100,000');
    expect(rowsOf(aes)['Cipher']).toBe('AES-256');
  });

  it('is not determined when the KDF is missing, unknown or its dictionary is damaged', async () => {
    expect(rowsOf(await read(fx.kdbx4(undefined)))['Key derivation']).toBe('not determined');
    const unknown = fx.variantDictionary([fx.dictBytes('$UUID', fx.secret(16))]);
    expect(rowsOf(await read(fx.kdbx4(unknown)))['Key derivation']).toContain('unknown');
    const bad = await read(fx.kdbx4([0x00, 0x01, 0x05, 0xff, 0xff, 0xff, 0x7f]));
    expect(rowsOf(bad)['Encryption']).toContain('not determined');
    expect(bad.warnings.length).toBe(1);
  });

  it('bounds the fields it reads', async () => {
    const field = (id: number, size: number): number[] => [
      id,
      ...fx.u16le(size),
      ...new Array<number>(size).fill(0),
    ];
    const many = fx.concat(
      [0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5],
      fx.u16le(1),
      fx.u16le(3),
      ...Array.from({ length: 40 }, () => field(4, 4)),
    );
    expect(rowsOf(await read(many))['Header']).toContain(
      'not determined beyond the first 32 fields',
    );
    const v4 = fx.concat(
      [0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5],
      fx.u16le(0),
      fx.u16le(4),
      [11, ...fx.u32le(70000)],
    );
    expect(rowsOf(await read(v4))['Encryption']).toContain('not determined');
  });

  it('does not read a version it does not know', async () => {
    const b = fx.kdbx3();
    b[10] = 2;
    expect(rowsOf(await read(b))['Encryption']).toContain('KDBX 2.1 is not read');
  });

  it('is chosen by its two signatures', async () => {
    expect((await dispatch(fx.kdbx3(), 'x.kdbx')).format).toBe('KeePass database');
    const wrongSecond = fx.kdbx3();
    wrongSecond[4] = 0x65; // the KeePass 1.x signature
    await expect(dispatch(wrongSecond, 'x.kdbx')).rejects.toThrow();
  });
});

describe('LUKS', () => {
  const read = (b: Uint8Array): Promise<PackageInfo> => readLuks(fx.reader(b));

  it('LUKS1: cipher, hash, key size and the active slots with their iterations', async () => {
    const info = await read(fx.luks1({ slots: [200000, undefined, 150000] }));
    const rows = rowsOf(info);
    expect(rows['Format version']).toBe('LUKS1');
    expect(rows['Cipher']).toBe('aes-xts-plain64');
    expect(rows['Hash']).toBe('sha256');
    expect(rows['Key size']).toBe('512 bits');
    expect(rows['Active key slots']).toBe('2 of 8');
    expect(tableOf(info, 'Key slots')).toEqual([
      ['Slot 0', 'active', 'PBKDF2 (sha256), 200,000 iterations'],
      ['Slot 2', 'active', 'PBKDF2 (sha256), 150,000 iterations'],
    ]);
    noSecret(info);
  });

  it('LUKS1: no active slots, odd key size', async () => {
    const info = await read(fx.luks1({ keyBytes: 0 }));
    expect(rowsOf(info)['Active key slots']).toBe('0 of 8');
    expect(rowsOf(info)['Key size']).toBe('not determined');
    expect(tableOf(info, 'Key slots')).toEqual([]);
  });

  const json = {
    keyslots: {
      '0': {
        type: 'luks2',
        key_size: 64,
        af: { type: 'luks1', stripes: 4000, hash: 'sha256' },
        area: {
          type: 'raw',
          encryption: 'aes-xts-plain64',
          key_size: 64,
          offset: '32768',
          size: '258048',
        },
        kdf: {
          type: 'argon2id',
          time: 4,
          memory: 1048576,
          cpus: 4,
          salt: 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=',
        },
      },
      '1': {
        type: 'luks2',
        key_size: 64,
        area: { type: 'raw', encryption: 'aes-xts-plain64', key_size: 64 },
        kdf: { type: 'pbkdf2', hash: 'sha256', iterations: 1000000, salt: 'q6urq6urq6urq6ur' },
      },
      '2': {
        type: 'luks2',
        key_size: 32,
        area: { encryption: 'aes-cbc-essiv:sha256' },
        kdf: { type: 'argon2i', time: 1, memory: 64, cpus: 1 },
      },
    },
    tokens: {
      '0': { type: 'luks2-keyring', keyslots: ['0'] },
      '1': { type: 'systemd-tpm2' },
      '2': { type: 'luks2-keyring' },
    },
    segments: {
      '0': {
        type: 'crypt',
        offset: '16777216',
        size: 'dynamic',
        iv_tweak: '0',
        encryption: 'aes-xts-plain64',
        sector_size: 4096,
      },
    },
    digests: {
      '0': {
        type: 'pbkdf2',
        keyslots: ['0'],
        segments: ['0'],
        hash: 'sha256',
        iterations: 123456,
        salt: 'q6urq6ur',
        digest: 'q6urq6ur',
      },
    },
    config: { json_size: '12288', keyslots_size: '4161536' },
  };

  it('LUKS2: segments, keyslots by type and KDF, tokens by type', async () => {
    const info = await read(fx.luks2(json));
    const rows = rowsOf(info);
    expect(rows['Format version']).toBe('LUKS2');
    expect(rows['Key slots']).toBe('3');
    expect(rows['Segments']).toBe('1');
    expect(rows['Tokens']).toBe('3 (luks2-keyring: 2, systemd-tpm2: 1)');
    expect(tableOf(info, 'Segments')).toEqual([['0', 'crypt', 'aes-xts-plain64', '4,096']]);
    const slots = tableOf(info, 'Key slots');
    expect(slots[0]).toEqual([
      '0',
      'luks2',
      'aes-xts-plain64',
      '512 bits',
      'Argon2id, 4 iterations, 1.00 GB memory, 4 threads',
    ]);
    expect(slots[1][4]).toBe('PBKDF2 (sha256), 1,000,000 iterations');
    expect(slots[2][4]).toBe('Argon2i, 1 iterations, 64.0 KB memory, 1 threads');
    expect(slots[2][3]).toBe('256 bits');
    noSecret(info);
    expect(everything(info)).not.toContain('123456');
  });

  it('LUKS2: no tokens, a JSON area that is damaged, and one that is larger than the cap', async () => {
    const bare = await read(fx.luks2({ keyslots: {}, segments: {}, tokens: {} }));
    expect(rowsOf(bare)['Tokens']).toBe('none');
    const broken = await read(fx.luks2('{"keyslots": {'));
    expect(rowsOf(broken)['Metadata']).toContain('could not be parsed');
    expect(broken.warnings.length).toBe(1);
    const huge = fx.luks2(json);
    new DataView(huge.buffer).setBigUint64(8, BigInt(8 * 1024 * 1024), false);
    expect(rowsOf(await read(huge))['Metadata']).toContain('missing or larger than will be read');
  });

  it('LUKS2: values of the wrong type are not determined, not crashes', async () => {
    const info = await read(
      fx.luks2({
        keyslots: {
          '0': { type: 5, key_size: 'x', kdf: { type: 'pbkdf2', iterations: 'many' }, area: 3 },
        },
        segments: { '0': 7 },
        tokens: { '0': 1 },
      }),
    );
    expect(tableOf(info, 'Key slots')[0][3]).toBe('not determined');
    expect(tableOf(info, 'Key slots')[0][4]).toContain('not determined');
  });

  it('is not determined when the header is cut short or of an unknown version', async () => {
    expect(rowsOf(await read(fx.luks1().subarray(0, 100)))['Header']).toBe('not determined');
    const v3 = fx.luks1();
    v3[7] = 3;
    expect((await read(v3)).warnings.length).toBe(1);
  });

  it('is chosen by content alone', async () => {
    expect((await dispatch(fx.luks1(), 'disk.img')).format).toBe('LUKS volume (LUKS1)');
    expect((await dispatch(fx.luks2(json), 'disk.bin')).format).toBe('LUKS volume (LUKS2)');
  });
});

describe('PKCS#12', () => {
  const read = (b: Uint8Array): Promise<PackageInfo> => readPkcs12(fx.reader(b));
  const keyBag = (alg: number[]): number[] =>
    fx.bag(fx.OID.shroudedKeyBag, fx.encryptedPrivateKeyInfo(alg));
  const certBag = (): number[] =>
    fx.bag(
      fx.OID.certBag,
      fx.seq(fx.oid('1.2.840.113549.1.9.22.1'), fx.explicit0(fx.octets(fx.secret(30)))),
    );

  it('modern: PBES2 key bag and certificate container, with the MAC', async () => {
    const file = fx.pfx(
      [
        fx.safeContentsEncrypted(fx.pbes2({ iterations: 2048 })),
        fx.safeContentsData([keyBag(fx.pbes2({ iterations: 2048 }))]),
      ],
      { algorithm: fx.OID.sha256, iterations: 2048 },
    );
    const info = await read(file);
    const rows = rowsOf(info);
    expect(rows['Format']).toBe('PKCS#12 (PFX) version 3');
    expect(rows['Key bags']).toBe('1 encrypted');
    expect(rows['Key bag encryption']).toBe(
      'PBES2: PBKDF2 (HMAC-SHA256, 2,048 iterations), AES-256-CBC',
    );
    expect(rows['Certificates']).toBe('not determined (in encrypted containers)');
    expect(rows['MAC']).toBe('SHA-256, 2,048 iterations');
    expect(tableOf(info, 'Containers')).toEqual([
      [
        'Encrypted data',
        'PBES2: PBKDF2 (HMAC-SHA256, 2,048 iterations), AES-256-CBC',
        'not shown (encrypted)',
      ],
      ['Data', 'not encrypted', '1 encrypted key bag'],
    ]);
    noSecret(info);
  });

  it('legacy: 3DES and RC2-40 are marked legacy, with SHA-1 MAC and the default iteration count', async () => {
    const file = fx.pfx(
      [
        fx.safeContentsEncrypted(fx.legacyPbe(fx.OID.rc2_40P12, 2048)),
        fx.safeContentsData([keyBag(fx.legacyPbe(fx.OID.tripleDesP12, 2048))]),
      ],
      { algorithm: fx.OID.sha1 },
    );
    const info = await read(file);
    const rows = rowsOf(info);
    expect(rows['Key bag encryption']).toBe(
      'pbeWithSHAAnd3-KeyTripleDES-CBC (legacy), 2,048 iterations',
    );
    expect(rows['MAC']).toBe('SHA-1, 1 iterations');
    expect(tableOf(info, 'Containers')[0][1]).toBe(
      'pbeWithSHAAnd40BitRC2-CBC (legacy), 2,048 iterations',
    );
  });

  it('PBES2 with a different PRF, the default PRF, and scrypt', async () => {
    const sha512 = await read(
      fx.pfx([
        fx.safeContentsData([
          keyBag(fx.pbes2({ prf: fx.OID.hmacSha512, iterations: 10000, cipher: fx.OID.aes128cbc })),
        ]),
      ]),
    );
    expect(rowsOf(sha512)['Key bag encryption']).toBe(
      'PBES2: PBKDF2 (HMAC-SHA512, 10,000 iterations), AES-128-CBC',
    );
    expect(rowsOf(sha512)['MAC']).toBe('none');
    const dflt = await read(fx.pfx([fx.safeContentsData([keyBag(fx.pbes2({ prf: null }))])]));
    expect(rowsOf(dflt)['Key bag encryption']).toContain('PBKDF2 (HMAC-SHA1, 600,000 iterations)');
    const scrypt = await read(fx.pfx([fx.safeContentsData([keyBag(fx.pbes2Scrypt())])]));
    expect(rowsOf(scrypt)['Key bag encryption']).toBe(
      'PBES2: scrypt (N=32,768, r=8, p=1), AES-256-CBC',
    );
  });

  it('counts unencrypted key bags and certificates in a plain container', async () => {
    const info = await read(
      fx.pfx([
        fx.safeContentsData([fx.bag(fx.OID.keyBag, fx.seq(fx.derInt(0))), certBag(), certBag()]),
      ]),
    );
    const rows = rowsOf(info);
    expect(rows['Key bags']).toBe('1 not encrypted');
    expect(rows['Unencrypted keys']).toContain('without a password');
    expect(rows['Certificates']).toBe('2 not encrypted');
    expect(tableOf(info, 'Containers')[0][2]).toBe('1 key bag not encrypted, 2 certificates');
  });

  it('reads an indefinite-length (BER) wrapper', async () => {
    // The authSafe content as a constructed octet string with an indefinite length.
    const inner = fx.seq(fx.safeContentsData([keyBag(fx.pbes2({ iterations: 5 }))]));
    const authSafe = fx.seq(
      fx.oid(fx.OID.data),
      fx.explicit0([0x24, 0x80, ...fx.octets(inner), 0, 0]),
    );
    const file = new Uint8Array(fx.seq(fx.derInt(3), authSafe));
    expect(rowsOf(await read(file))['Key bags']).toBe('1 encrypted');
  });

  it('is not determined, not a failure, when the structure is damaged or too large', async () => {
    const good = fx.pfx([fx.safeContentsData([keyBag(fx.pbes2())])]);
    const cut = await read(good.subarray(0, good.length - 40));
    expect(rowsOf(cut)['Protection']).toContain('not determined');
    expect(cut.warnings.length).toBe(1);
    const signed = new Uint8Array(
      fx.seq(fx.derInt(3), fx.seq(fx.oid(fx.OID.signedData), fx.explicit0(fx.seq()))),
    );
    expect(rowsOf(await read(signed))['Protection']).toContain('not determined');
    const nested = new Uint8Array(
      fx.seq(
        fx.derInt(3),
        fx.seq(
          fx.oid(fx.OID.data),
          fx.explicit0(
            ...Array.from({ length: 30 }, () => [0x30, 0x80])
              .flat()
              .map((b) => [b]),
          ),
        ),
      ),
    );
    expect(rowsOf(await read(nested))['Protection']).toContain('not determined');
    const big = new Uint8Array(4 * 1024 * 1024 + 8);
    big.set(good.subarray(0, 8));
    expect(rowsOf(await read(big))['Protection']).toContain('not determined');
  });

  it('is chosen by its structure, whatever the name', async () => {
    const good = fx.pfx([fx.safeContentsData([keyBag(fx.pbes2())])], {
      algorithm: fx.OID.sha256,
      iterations: 1,
    });
    expect((await dispatch(good, 'x.bin')).format).toBe('PKCS#12 file');
    await expect(
      dispatch(new Uint8Array(fx.seq(fx.derInt(2), fx.seq())), 'x.p12'),
    ).rejects.toThrow();
  });
});

describe('PEM', () => {
  const read = (text: string): Promise<PackageInfo> =>
    readPem(fx.reader(new TextEncoder().encode(text)));
  const body = (n = 40): number[] => fx.secret(n);

  it('encrypted PKCS#8: the PBES2 parameters', async () => {
    const der = fx.encryptedPrivateKeyInfo(fx.pbes2({ iterations: 600000 }));
    const info = await read(fx.pem('ENCRYPTED PRIVATE KEY', der));
    expect(tableOf(info, 'Blocks')).toEqual([
      [
        'ENCRYPTED PRIVATE KEY',
        'Private key, encrypted (PBES2: PBKDF2 (HMAC-SHA256, 600,000 iterations), AES-256-CBC)',
      ],
    ]);
    expect(info.summary).toContain('Private key, encrypted');
    noSecret(info);
  });

  it('encrypted PKCS#8 with a body that is not DER is not determined', async () => {
    const info = await read(fx.pem('ENCRYPTED PRIVATE KEY', body()));
    expect(tableOf(info, 'Blocks')[0][1]).toBe('Private key, encrypted (not determined)');
  });

  it('legacy PEM encryption: only the cipher name from DEK-Info', async () => {
    const text = fx.pem('RSA PRIVATE KEY', body(), [
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,ABABABABABABABABABABABABABABABAB',
    ]);
    const info = await read(text);
    expect(tableOf(info, 'Blocks')[0][1]).toBe(
      'RSA private key (traditional format), encrypted (legacy PEM encryption: AES-128-CBC)',
    );
    expect(everything(info).toUpperCase()).not.toContain('ABABABAB');
    const noDek = await read(fx.pem('EC PRIVATE KEY', body(), ['Proc-Type: 4,ENCRYPTED']));
    expect(tableOf(noDek, 'Blocks')[0][1]).toContain('cipher not determined');
    const badDek = await read(
      fx.pem('DSA PRIVATE KEY', body(), ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: <script>,00']),
    );
    expect(tableOf(badDek, 'Blocks')[0][1]).toContain('cipher not determined');
  });

  it('unencrypted private keys, without showing anything of them', async () => {
    const pkcs8 = await read(fx.pem('PRIVATE KEY', body()));
    expect(tableOf(pkcs8, 'Blocks')).toEqual([['PRIVATE KEY', 'Private key, not encrypted']]);
    const rsa = await read(fx.pem('RSA PRIVATE KEY', body()));
    expect(tableOf(rsa, 'Blocks')[0][1]).toBe(
      'RSA private key (traditional format), not encrypted',
    );
    noSecret(pkcs8);
  });

  it('OpenSSH keys: none, and bcrypt rounds', async () => {
    const plain = await read(fx.pem('OPENSSH PRIVATE KEY', fx.openssh('none', 'none')));
    expect(tableOf(plain, 'Blocks')[0][1]).toBe('OpenSSH private key, not encrypted');
    const enc = await read(fx.pem('OPENSSH PRIVATE KEY', fx.openssh('aes256-ctr', 'bcrypt', 16)));
    expect(tableOf(enc, 'Blocks')[0][1]).toBe(
      'OpenSSH private key, encrypted (aes256-ctr, bcrypt KDF, 16 rounds)',
    );
    noSecret(enc);
    const other = await read(
      fx.pem('OPENSSH PRIVATE KEY', fx.openssh('chacha20-poly1305@openssh.com', 'argon', 1)),
    );
    expect(tableOf(other, 'Blocks')[0][1]).toContain('KDF argon');
    const junk = await read(fx.pem('OPENSSH PRIVATE KEY', body()));
    expect(tableOf(junk, 'Blocks')[0][1]).toBe('OpenSSH private key (not determined)');
  });

  it('says what certificates, public keys and other blocks are, and nothing more', async () => {
    const text = [
      fx.pem('CERTIFICATE', body()),
      fx.pem('PUBLIC KEY', body()),
      fx.pem('CERTIFICATE REQUEST', body()),
      fx.pem('X509 CRL', body()),
      fx.pem('PKCS7', body()),
      fx.pem('EC PARAMETERS', body()),
      fx.pem('SOMETHING ELSE', body()),
    ].join('\n');
    const info = await read(text);
    expect(tableOf(info, 'Blocks').map((r) => r[1])).toEqual([
      'Certificate',
      'Public key',
      'Certificate request',
      'Certificate revocation list',
      'PKCS#7 or CMS message',
      'Parameters',
      'Other PEM block',
    ]);
    expect(rowsOf(info)['Private keys']).toBe('none');
    expect(info.summary).toBe('7 PEM blocks.');
    noSecret(info);
  });

  it('caps the blocks listed, and reads a file with none', async () => {
    const many = Array.from({ length: 40 }, () => fx.pem('CERTIFICATE', body())).join('');
    expect(tableOf(await read(many), 'Blocks').length).toBe(32);
    const none = await read('just some text\n');
    expect(none.summary).toBe('A text file with no PEM block in it.');
  });

  it('is chosen by a boundary line in plain text, not for binary, OpenPGP or age', async () => {
    const text = new TextEncoder().encode(
      'Bag Attributes\n    friendlyName: x\n' + fx.pem('CERTIFICATE', body()),
    );
    expect((await dispatch(text, 'a.pem')).format).toBe('PEM file');
    const binary = fx.concat([0, 1, 2], new TextEncoder().encode(fx.pem('CERTIFICATE', body())));
    await expect(dispatch(binary, 'a.pem')).rejects.toThrow();
    const pgp = new TextEncoder().encode(fx.armor('PGP MESSAGE', [0xc3, 0x00]));
    expect((await dispatch(pgp, 'a.asc')).format).toContain('OpenPGP');
  });
});

describe('base64', () => {
  it('decodes, skips white space, stops at a character that is not base64, and caps its output', () => {
    expect([...decodeBase64('AQID\nBAU=', 100)]).toEqual([1, 2, 3, 4, 5]);
    expect([...decodeBase64('AQID-----', 100)]).toEqual([1, 2, 3]);
    expect(decodeBase64('AQIDBAUG', 4).length).toBe(4);
  });
});

describe('page shape', () => {
  it('every reader puts its labels in an Encryption section with the no-decryption note', async () => {
    const info = await dispatch(fx.kdbx3(), 'x.kdbx');
    const section = info.sections.find((s) => s.heading === 'Encryption');
    expect(section?.kind === 'properties' && section.note).toContain(
      'No password was asked for or tried',
    );
  });
});

describe('damaged input', () => {
  const samples: [string, Uint8Array][] = [
    ['x.7z', fx.sevenZipEncoded([[fx.AES_CODER(), fx.LZMA]])],
    ['x.7z', fx.sevenZipPlain([[fx.AES_CODER()], [fx.LZMA]])],
    ['x.rar', fx.rar5(fx.rar5Main(), fx.rar5File('a', { kdf: 15 }), fx.rar5End())],
    ['x.rar', fx.rar4(fx.rar4Main(), fx.rar4File('a', true), fx.rar4End())],
    [
      'x.gpg',
      fx.concat(fx.newPacket(1, fx.pkesk('1700B4E8F8F513AA', 18)), fx.newPacket(18, fx.SEIPD1)),
    ],
    ['x.age', new TextEncoder().encode(fx.ageFile(['-> X25519 A', '-> scrypt S 18']))],
    ['x.kdbx', fx.kdbx3()],
    [
      'x.kdbx',
      fx.kdbx4(
        fx.variantDictionary([fx.dictBytes('$UUID', fx.hex(fx.ARGON2ID)), fx.dictU64('I', 2)]),
      ),
    ],
    ['x.img', fx.luks1({ slots: [1000] })],
    ['x.img', fx.luks2({ keyslots: { '0': { type: 'luks2', kdf: { type: 'pbkdf2' } } } })],
    [
      'x.p12',
      fx.pfx(
        [
          fx.safeContentsData([
            fx.bag(fx.OID.shroudedKeyBag, fx.encryptedPrivateKeyInfo(fx.pbes2())),
          ]),
        ],
        { algorithm: fx.OID.sha256, iterations: 1 },
      ),
    ],
    [
      'x.pem',
      new TextEncoder().encode(
        fx.pem('ENCRYPTED PRIVATE KEY', fx.encryptedPrivateKeyInfo(fx.pbes2())),
      ),
    ],
    [
      'x.pem',
      new TextEncoder().encode(fx.pem('OPENSSH PRIVATE KEY', fx.openssh('aes256-ctr', 'bcrypt'))),
    ],
  ];
  const settles = async (bytes: Uint8Array, name: string): Promise<void> => {
    if (bytes.length === 0) {
      return;
    }
    try {
      await dispatch(bytes, name);
    } catch (err) {
      // A file that is no longer the format is refused with a message, nothing else.
      expect(err instanceof Error && err.constructor.name).toBe('ReadError');
    }
  };

  it('never throws anything but a message, at every truncation', async () => {
    for (const [name, bytes] of samples) {
      for (let n = 0; n < Math.min(bytes.length, 400); n++) {
        await settles(bytes.subarray(0, n), name);
      }
    }
  });

  it('never throws anything but a message, with every byte of the header flipped', async () => {
    for (const [name, bytes] of samples) {
      for (let at = 0; at < Math.min(bytes.length, 160); at++) {
        for (const value of [0x00, 0xff, bytes[at] ^ 0x80]) {
          const copy = bytes.slice();
          copy[at] = value;
          await settles(copy, name);
        }
      }
    }
  });
});
