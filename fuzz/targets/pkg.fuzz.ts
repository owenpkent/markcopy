import { bytesSource } from '../../src/binary/reader';
import { PackageError, readPackage, renderPackageHtml } from '../../src/pkg';

// readPackage picks a reader from the first bytes of the file (and, for disk
// images, the last 512), so a random input is almost always turned away at the
// door and the readers behind it never run. The first input byte therefore
// chooses a format; the rest of the input is the file, with that format's magic
// written over its start (for a DMG, its trailer over the end) and a file name
// that sends the dispatcher the same way. Mutation then works on the headers
// and tables behind the magic.
interface Shape {
  name: string;
  /** Written at the start of the file. */
  magic?: number[];
  /** A UDIF trailer is written over the last 512 bytes instead. */
  trailer?: boolean;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

export const SHAPES: Shape[] = [
  { name: 'fuzz.so', magic: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'fuzz.rpm', magic: [0xed, 0xab, 0xee, 0xdb] },
  { name: 'fuzz.deb', magic: ascii('!<arch>\n') },
  { name: 'fuzz.msi', magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { name: 'fuzz.pkg', magic: ascii('xar!') },
  { name: 'fuzz.jar', magic: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'fuzz.vsix', magic: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'fuzz.whl', magic: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'fuzz.nupkg', magic: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'fuzz.apk', magic: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'fuzz.jar', magic: [0x50, 0x4b, 0x05, 0x06] },
  // Alpine packages are gzip, which the dispatcher only trusts by name.
  { name: 'fuzz.apk', magic: [0x1f, 0x8b, 0x08] },
  { name: 'fuzz.dmg', trailer: true },
];

const TRAILER = 512;

/** The file the fuzzer's bytes become: `data[0]` picks the shape, the rest is the file. */
export function shaped(data: Buffer): { bytes: Buffer; name: string } {
  if (data.length === 0) {
    return { bytes: data, name: 'fuzz.bin' };
  }
  const shape = SHAPES[data[0] % SHAPES.length];
  const rest = data.subarray(1);
  if (shape.trailer) {
    const out = Buffer.alloc(Math.max(rest.length, TRAILER));
    rest.copy(out);
    // "koly", version 4, header size 512: enough for looksLikeDmg, and the
    // plist, data fork and sector fields it points at stay as the input has them.
    const at = out.length - TRAILER;
    out.write('koly', at, 'latin1');
    out.writeUInt32BE(4, at + 4);
    out.writeUInt32BE(TRAILER, at + 8);
    return { bytes: out, name: shape.name };
  }
  const magic = shape.magic ?? [];
  const out = Buffer.alloc(Math.max(rest.length, magic.length));
  rest.copy(out);
  Buffer.from(magic).copy(out);
  return { bytes: out, name: shape.name };
}

// readPackage is async (it reads through a ByteSource), so this target is too;
// Jazzer.js awaits the promise, and fuzz/run.js runs it without --sync.
// What one input may cost. An error is not the only way a reader fails: the
// first version of this target ran half a million inputs clean while a
// 642-byte file could take the extension host to 4 GB, because a reader that
// spends a gigabyte and then returns a small page throws nothing. These turn
// cost into something the fuzzer can find. They are far above what any input
// the fuzzer can produce should need (a real 900 MB installer reads in 25 ms),
// so a slow CI machine does not trip them.
export const MAX_MILLISECONDS = 3000;
export const MAX_HTML_CHARS = 4 * 1024 * 1024;
export const MAX_HEAP_GROWTH = 256 * 1024 * 1024;

/** Thrown when an input was read without error but cost more than a preview may. */
export class CostError extends Error {}

// A PackageError is the reader's documented answer to a file it cannot
// describe; anything else (a RangeError from a view past the buffer, a
// TypeError, or a CostError from the limits above) is a finding.
export async function fuzz(data: Buffer): Promise<void> {
  const { bytes, name } = shaped(data);
  for (const [input, fileName] of [
    [data, 'fuzz.bin'],
    [bytes, name],
  ] as const) {
    const started = performance.now();
    const heap = process.memoryUsage().heapUsed;
    let html = '';
    try {
      const info = await readPackage(bytesSource(input), fileName);
      html = renderPackageHtml(info, { fileName, fileSize: input.length, sha256: 'f'.repeat(64) });
    } catch (err) {
      if (!(err instanceof PackageError)) {
        throw err;
      }
    }
    const took = performance.now() - started;
    const grew = process.memoryUsage().heapUsed - heap;
    if (took > MAX_MILLISECONDS) {
      throw new CostError(`${fileName}: ${input.length} bytes took ${Math.round(took)} ms to read`);
    }
    if (html.length > MAX_HTML_CHARS) {
      throw new CostError(
        `${fileName}: ${input.length} bytes made a page of ${html.length} characters`,
      );
    }
    if (grew > MAX_HEAP_GROWTH) {
      throw new CostError(
        `${fileName}: ${input.length} bytes grew the heap by ${Math.round(grew / 1048576)} MB`,
      );
    }
  }
}
