import { crc32, deflateRawSync } from 'node:zlib';
import { adler32, DEX_HEADER_BYTES, parseDexHeader } from '../../src/pkg/dex';
import { readAndCheck } from './pkg.fuzz';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// An APK's classes.dex files are read by src/pkg/dex.ts: each header, and for the
// first file its stored Adler-32 and SHA-1 against the bytes inside. The pkg
// target reaches that only through an APK whose zip structure survives mutation
// and whose entry is named classes.dex; here the input is the DEX file, and a
// small zip around it (written below, so the target needs nothing from tests/) is
// the APK. The first byte picks how the entry is stored.
//
//   0  stored   1  deflated   2  stored, and a second file (classes2.dex) made
//   from the second half of the input, so the multi-file totals and the
//   version set are exercised too
const MODES = 3;
const MAGIC = Buffer.from('dex\n035\0', 'latin1');
const ENDIAN = 0x12345678;

interface Part {
  name: string;
  data: Buffer;
  deflate: boolean;
}

/** A zip of `parts`: local headers, data, a central directory and an end record. */
function zipOf(parts: Part[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, 'latin1');
    const body = part.deflate ? deflateRawSync(part.data) : part.data;
    const crc = crc32(part.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(part.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(part.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(part.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(part.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Adler-32 as RFC 1950 writes it, a modulo on every byte: slow, and obviously right. */
function adlerReference(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** The input with a DEX magic and the endian tag a real file has, when it is long enough to hold them. */
export function withDexHeader(data: Buffer): Buffer {
  if (data.length < DEX_HEADER_BYTES || data.subarray(0, 8).equals(MAGIC)) {
    return data;
  }
  const out = Buffer.from(data);
  MAGIC.copy(out);
  out.writeUInt32LE(DEX_HEADER_BYTES, 0x24);
  out.writeUInt32LE(ENDIAN, 0x28);
  return out;
}

function checkHeader(bytes: Buffer): void {
  const header = parseDexHeader(bytes);
  if (header === undefined) {
    return;
  }
  if (!/^[0-9]{3}$/.test(header.version) || header.signature.length !== 20) {
    throw new Error(`a DEX header read as version ${header.version}`);
  }
  if (bytes.length <= 1 << 16 && adler32(bytes) !== adlerReference(bytes)) {
    throw new Error('adler32 differs from the reference definition');
  }
}

// readPackage is async, so this target is too.
export async function fuzz(data: Buffer): Promise<void> {
  if (data.length === 0) {
    return;
  }
  const mode = data[0] % MODES;
  const dex = data.subarray(1);
  for (const bytes of [dex, withDexHeader(dex)]) {
    checkHeader(bytes);
    const parts: Part[] = [{ name: 'classes.dex', data: bytes, deflate: mode === 1 }];
    if (mode === 2) {
      parts.push({
        name: 'classes2.dex',
        data: withDexHeader(bytes.subarray(bytes.length >> 1)),
        deflate: false,
      });
    }
    await readAndCheck(zipOf(parts), 'fuzz.apk');
  }
}
