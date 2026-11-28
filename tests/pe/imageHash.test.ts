import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesSource, readPe, renderPeHtml } from '../../src/pe';
import { RangeReader } from '../../src/binary/reader';
import { checkImageHash } from '../../src/pe/imageHash';
import { buildPe, tlv, type PeSpec } from './fixture';

const oidOf = (...bytes: number[]): Uint8Array => tlv(0x06, Uint8Array.from(bytes));
const SHA256_OID = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const SHA1_OID = [0x2b, 0x0e, 0x03, 0x02, 0x1a];
const MD5_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05];
const SHA512_OID = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03];
const UNKNOWN_OID = [0x2a, 0x03, 0x04, 0x05];
const SPC_INDIRECT_DATA = [0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04];

const ALGORITHM = (id: number[]): Uint8Array => tlv(0x30, oidOf(...id), tlv(0x05));

/** A SignedData whose contentInfo stores `digest` under `algorithm`, with one signer. */
function signedWith(algorithm: number[], digest: Uint8Array): Uint8Array {
  const info = tlv(
    0x30,
    tlv(0x02, Uint8Array.of(1)),
    tlv(0x30, tlv(0x30), tlv(0x02, Uint8Array.of(5))),
    ALGORITHM(SHA256_OID),
    ALGORITHM(SHA256_OID),
    tlv(0x04, Uint8Array.of(1, 2, 3, 4)),
  );
  const indirect = tlv(
    0x30,
    tlv(0x30, oidOf(0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x0f)),
    tlv(0x30, ALGORITHM(algorithm), tlv(0x04, digest)),
  );
  return tlv(
    0x30,
    oidOf(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02),
    tlv(
      0xa0,
      tlv(
        0x30,
        tlv(0x02, Uint8Array.of(1)),
        tlv(0x31, ALGORITHM(algorithm)),
        tlv(0x30, oidOf(...SPC_INDIRECT_DATA), tlv(0xa0, indirect)),
        tlv(0x31, info),
      ),
    ),
  );
}

interface Offsets {
  checksum: number;
  directory: number;
  table: number;
  tableSize: number;
}

// The skipped ranges, found the way the specification says: the optional
// header starts 24 bytes after the PE signature, CheckSum is 64 bytes in, and
// data directory 4 follows the directory count.
function offsets(file: Uint8Array): Offsets {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const optional = view.getUint32(0x3c, true) + 24;
  const plus = view.getUint16(optional, true) === 0x20b;
  const directory = optional + (plus ? 112 : 96) + 4 * 8;
  return {
    checksum: optional + 64,
    directory,
    table: view.getUint32(directory, true),
    tableSize: view.getUint32(directory + 4, true),
  };
}

function imageDigest(file: Uint8Array, algorithm = 'sha256'): Uint8Array {
  const o = offsets(file);
  const hash = createHash(algorithm);
  hash.update(file.subarray(0, o.checksum));
  hash.update(file.subarray(o.checksum + 4, o.directory));
  hash.update(file.subarray(o.directory + 8, o.table));
  hash.update(file.subarray(o.table + o.tableSize));
  return hash.digest();
}

/** A signed image whose stored digest is the right one for its own bytes. */
function signedImage(
  spec: PeSpec = {},
  algorithm = SHA256_OID,
  name = 'sha256',
  digestLength?: number,
): Uint8Array {
  const placeholder = signedWith(algorithm, new Uint8Array(digestLength ?? 32));
  const first = buildPe({ ...spec, certificate: placeholder });
  const digest = digestLength ? new Uint8Array(digestLength) : imageDigest(first, name);
  return buildPe({ ...spec, certificate: signedWith(algorithm, digest) });
}

const render = async (file: Uint8Array): Promise<string> =>
  renderPeHtml(await readPe(bytesSource(file)), { fileName: 'a.exe' });
const check = async (file: Uint8Array): Promise<string | undefined> =>
  (await readPe(bytesSource(file))).signature?.imageHash?.check;

const MATCH = 'The computed SHA-256 matches the stored digest.';
const NOT_CHECKED_TABLE =
  "Not checked: the certificate table overlaps the file's headers or runs past the end of the file.";
const DIFFER = 'The computed SHA-256 differs from the stored digest.';

describe('Authenticode image hash', () => {
  it('matches when the file is the one the signature hashed, and shows the stored digest', async () => {
    const file = signedImage({ overlay: 300 });
    expect(await check(file)).toBe(MATCH);
    const html = await render(file);
    expect(html).toContain('Image digest (SHA-256)');
    expect(html).toContain(Buffer.from(imageDigest(file)).toString('hex'));
    expect(html).toContain('Image hash check');
    expect(html).toContain(MATCH);
    expect(html).toContain('not verified by MarkCopy');
  });

  it('matches a 64-bit image', async () => {
    expect(await check(signedImage({ plus: true }))).toBe(MATCH);
  });

  it('differs when a byte in a hashed region changes', async () => {
    const file = signedImage({ overlay: 300 });
    const o = offsets(file);
    for (const at of [0x10, o.checksum - 4, o.checksum + 4, o.directory - 1, 0x300, o.table - 1]) {
      const flipped = file.slice();
      flipped[at] ^= 1;
      expect(await check(flipped), `byte ${at}`).toBe(DIFFER);
    }
    // Flip rather than zero the byte: the fixture's header padding at 0x300 may already be zero.
    const changed = file.slice();
    changed[0x300] ^= 1;
    expect(await render(changed)).toContain(DIFFER);
  });

  it('hashes bytes after the certificate table', async () => {
    const file = signedImage();
    const trailing = new Uint8Array(file.length + 16).fill(7);
    trailing.set(file);
    expect(await check(trailing)).toBe(DIFFER);
  });

  it('still matches when the CheckSum field or the certificate table changes', async () => {
    const file = signedImage();
    const o = offsets(file);
    for (const at of [o.checksum, o.checksum + 3]) {
      const changed = file.slice();
      changed[at] ^= 0xff;
      expect(await check(changed), `byte ${at}`).toBe(MATCH);
    }
    const table = file.slice();
    // The encryptedDigest value (01 02 03 04) lies inside the table.
    const value = table.findIndex((_, i) => i >= o.table && table[i] === 3 && table[i - 1] === 2);
    expect(value).toBeGreaterThan(o.table);
    table[value] ^= 0xff;
    expect(await check(table)).toBe(MATCH);
  });

  it('computes SHA-1, MD5 and SHA-512 digests', async () => {
    expect(await check(signedImage({}, SHA1_OID, 'sha1'))).toBe(
      'The computed SHA-1 matches the stored digest.',
    );
    expect(await check(signedImage({}, MD5_OID, 'md5'))).toBe(
      'The computed MD5 matches the stored digest.',
    );
    const sha512 = signedImage({}, SHA512_OID, 'sha512');
    expect(await check(sha512)).toBe('The computed SHA-512 matches the stored digest.');
    expect(await render(sha512)).toContain('Image digest (SHA-512)');
  });

  it('does not compute an algorithm it does not know', async () => {
    const file = signedImage({}, UNKNOWN_OID, 'sha256', 32);
    expect(await check(file)).toBe(
      'Not checked: MarkCopy does not compute the digest algorithm the signature names.',
    );
    expect(await render(file)).toContain('Image digest (OID 1.2.3.4.5)');
  });

  it('does not check a digest of the wrong length for its algorithm', async () => {
    const file = signedImage({}, SHA256_OID, 'sha256', 20);
    expect(await check(file)).toBe('Not checked: the stored value is not a SHA-256 digest.');
  });

  it('says so when the certificate table runs past the end of the file', async () => {
    const file = signedImage();
    const o = offsets(file);
    // The directory states a longer table than the file holds; the entry
    // itself still fits, so the signature is read and the hash is not run.
    new DataView(file.buffer).setUint32(o.directory + 4, o.tableSize + 0x1000, true);
    expect(await check(file)).toBe(NOT_CHECKED_TABLE);
  });

  it('says so when the certificate table overlaps the headers', async () => {
    const file = signedImage();
    const o = offsets(file);
    const der = file.subarray(o.table + 8, o.table + o.tableSize);
    const reader = new RangeReader(bytesSource(file));
    const layout = {
      checksumAt: o.checksum,
      directoryAt: o.directory,
      headersEnd: o.directory + 8,
    };
    expect(
      (await checkImageHash(reader, der, { ...layout, table: { address: o.checksum, size: 64 } }))
        .check,
    ).toBe(NOT_CHECKED_TABLE);
    expect(
      (
        await checkImageHash(reader, der, {
          ...layout,
          table: { address: o.table, size: o.tableSize },
        })
      ).check,
    ).toBe(MATCH);
  });

  it('says so when the certificate table starts inside the headers after the Security entry', async () => {
    const file = signedImage();
    const o = offsets(file);
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    // SizeOfHeaders is 60 bytes into the optional header.
    view.setUint32(o.checksum - 64 + 60, o.table + 8, true);
    expect(await check(file)).toBe(NOT_CHECKED_TABLE);
  });

  it('says so when the stored digest cannot be read', async () => {
    const bare = buildPe({
      certificate: tlv(
        0x30,
        oidOf(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02),
        tlv(
          0xa0,
          tlv(
            0x30,
            tlv(0x02, Uint8Array.of(1)),
            tlv(0x31),
            tlv(0x30),
            tlv(
              0x31,
              tlv(
                0x30,
                tlv(0x02, Uint8Array.of(1)),
                tlv(0x30, tlv(0x30), tlv(0x02, Uint8Array.of(5))),
                ALGORITHM(SHA256_OID),
                ALGORITHM(SHA256_OID),
                tlv(0x04, Uint8Array.of(1)),
              ),
            ),
          ),
        ),
      ),
    });
    expect(await check(bare)).toBe("Not checked: the signature's stored digest could not be read.");
    const html = await render(bare);
    expect(html).toContain('Image hash check');
    expect(html).not.toContain('Image digest (');
  });

  it('shows no image hash rows for an unsigned file', async () => {
    const html = await render(buildPe());
    expect(html).not.toContain('Image hash check');
    expect(html).not.toContain('Image digest');
  });

  it('never gives a cause for a difference or calls a match verified', async () => {
    const file = signedImage();
    const flipped = file.slice();
    flipped[0x300] ^= 1;
    for (const bytes of [file, flipped]) {
      const html = (await render(bytes)).replace('not verified by MarkCopy', '');
      expect(html).not.toMatch(/verified|trusted|tamper|corrupt|modified|forged|✓/i);
    }
  });
});
