import { bytesSource } from '../../src/binary/reader';
import { PackageError, readPackage, renderPackageHtml } from '../../src/pkg';
import { checkPage, startCost } from './binaryOracle';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// readPackage picks a reader from the first bytes of the file (and, for disk
// images, the last 512), so a random input is almost always turned away at the
// door and the readers behind it never run. The first input byte therefore
// chooses a format; the rest of the input is the file, with that format's magic
// written over its start (for a DMG, its trailer over the end) and a file name
// that sends the dispatcher the same way. Mutation then works on the headers
// and tables behind the magic.
//
// FUZZ_PKG_FORMAT (one of PKG_FORMATS) narrows the shapes to one format, the
// way FUZZ_IMAGE_FORMAT does for the image target, so a whole run is spent
// inside one reader: fuzz/run.js sets it for `pkg-<format>`. The catch-all
// stays, because routing between readers is code under test too.
interface Shape {
  name: string;
  format: string;
  /** Written at the start of the file. */
  magic?: number[];
  /** A UDIF trailer is written over the last 512 bytes instead. */
  trailer?: boolean;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const ZIP = [0x50, 0x4b, 0x03, 0x04];

export const SHAPES: Shape[] = [
  { name: 'fuzz.so', format: 'elf', magic: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'fuzz.rpm', format: 'rpm', magic: [0xed, 0xab, 0xee, 0xdb] },
  { name: 'fuzz.deb', format: 'deb', magic: ascii('!<arch>\n') },
  { name: 'fuzz.msi', format: 'msi', magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { name: 'fuzz.pkg', format: 'xar', magic: ascii('xar!') },
  { name: 'fuzz.jar', format: 'zip', magic: ZIP },
  { name: 'fuzz.vsix', format: 'zip', magic: ZIP },
  { name: 'fuzz.whl', format: 'zip', magic: ZIP },
  { name: 'fuzz.nupkg', format: 'zip', magic: ZIP },
  { name: 'fuzz.apk', format: 'zip', magic: ZIP },
  { name: 'fuzz.jar', format: 'zip', magic: [0x50, 0x4b, 0x05, 0x06] },
  // Alpine packages are gzip, which the dispatcher only trusts by name.
  { name: 'fuzz.apk', format: 'alpine', magic: [0x1f, 0x8b, 0x08] },
  { name: 'fuzz.dmg', format: 'dmg', trailer: true },
];

export const PKG_FORMATS = [...new Set(SHAPES.map((s) => s.format))];

const FORMAT = process.env.FUZZ_PKG_FORMAT || undefined;
if (FORMAT !== undefined && !PKG_FORMATS.includes(FORMAT)) {
  throw new Error(`FUZZ_PKG_FORMAT must be one of ${PKG_FORMATS.join(', ')}; got ${FORMAT}`);
}

const TRAILER = 512;

/**
 * The shape `choice` (the input's first byte) picks. `choice` indexes all the
 * shapes, so a seed written for the catch-all means the same file under every
 * variant; with a format set, a choice outside it falls back to one inside.
 */
export function shapeFor(choice: number, format: string | undefined = FORMAT): Shape {
  const shape = SHAPES[choice % SHAPES.length];
  if (format === undefined || shape.format === format) {
    return shape;
  }
  const family = SHAPES.filter((s) => s.format === format);
  return family[choice % family.length];
}

/** The file the fuzzer's bytes become: `data[0]` picks the shape, the rest is the file. */
export function shaped(
  data: Buffer,
  format: string | undefined = FORMAT,
): { bytes: Buffer; name: string } {
  if (data.length === 0) {
    return { bytes: data, name: 'fuzz.bin' };
  }
  const shape = shapeFor(data[0], format);
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

/** Read one file and check the page and what it cost (fuzz/targets/binaryOracle.ts). */
export async function readAndCheck(input: Buffer, fileName: string): Promise<string> {
  const done = startCost(fileName, input.length);
  let html = '';
  let info: unknown;
  try {
    const read = await readPackage(bytesSource(input), fileName);
    info = read;
    html = renderPackageHtml(read, { fileName, fileSize: input.length, sha256: 'f'.repeat(64) });
  } catch (err) {
    if (!(err instanceof PackageError)) {
      throw err;
    }
  }
  done(html);
  checkPage(fileName, html, input, info);
  return html;
}

// readPackage is async (it reads through a ByteSource), so this target is too;
// Jazzer.js awaits the promise, and fuzz/run.js runs it without --sync.
// A PackageError is the reader's documented answer to a file it cannot
// describe; anything else (a RangeError from a view past the buffer, a
// TypeError, a CostError or a PageError) is a finding.
export async function fuzz(data: Buffer): Promise<void> {
  const { bytes, name } = shaped(data);
  // The catch-all also offers the input as it is, unnamed, to the dispatcher.
  // A variant spends its time inside its one reader instead.
  if (FORMAT === undefined) {
    await readAndCheck(data, 'fuzz.bin');
  }
  await readAndCheck(bytes, name);
}
