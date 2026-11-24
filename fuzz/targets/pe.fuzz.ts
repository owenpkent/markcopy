import { bytesSource, PeError, readPe, renderPeHtml } from '../../src/pe';
import { checkPage, startCost } from './binaryOracle';

// Random bytes almost never begin with "MZ" and a valid PE header, so left
// alone the fuzzer would spend its time on the first two checks of readPe.
// Input that does not already look like a PE image gets a minimal PE32 header
// written over its start (two sections mapping the rest of the input, all 16
// data directories left as the input has them), so the mutated directory
// entries, resources and tables behind the header are what gets exercised.
export function withHeader(data: Buffer): Buffer {
  const looksLikePe =
    data.length >= 0x40 &&
    data.readUInt16LE(0) === 0x5a4d &&
    data.readUInt32LE(0x3c) + 4 <= data.length &&
    data.readUInt32LE(data.readUInt32LE(0x3c)) === 0x00004550;
  if (looksLikePe || data.length < 0x200) {
    return data;
  }
  const out = Buffer.from(data);
  out.writeUInt16LE(0x5a4d, 0);
  out.writeUInt32LE(0x40, 0x3c);
  out.writeUInt32LE(0x00004550, 0x40);
  out.writeUInt16LE(0x014c, 0x44); // machine
  out.writeUInt16LE(2, 0x46); // sections
  out.writeUInt16LE(0xe0, 0x54); // optional header size
  out.writeUInt16LE(0x010b, 0x58); // PE32 magic
  out.writeUInt32LE(0x200, 0x58 + 60); // SizeOfHeaders
  out.writeUInt32LE(16, 0x58 + 92); // NumberOfRvaAndSizes
  const table = 0x58 + 0xe0;
  const rest = out.length - 0x200;
  for (let i = 0; i < 2; i++) {
    const at = table + i * 40;
    out.fill(0, at, at + 40);
    out.write(i === 0 ? '.text' : '.rsrc', at, 'latin1');
    out.writeUInt32LE(rest, at + 8); // VirtualSize
    out.writeUInt32LE(0x1000 * (i + 1), at + 12); // VirtualAddress
    out.writeUInt32LE(rest, at + 16); // SizeOfRawData
    out.writeUInt32LE(0x200, at + 20); // PointerToRawData
    out.writeUInt32LE(0x60000020, at + 36);
  }
  return out;
}

/** Read one image and check the page and what it cost (fuzz/targets/binaryOracle.ts). */
export async function readAndCheck(bytes: Buffer): Promise<string> {
  const done = startCost('fuzz.exe', bytes.length);
  let html = '';
  let info: unknown;
  try {
    const read = await readPe(bytesSource(bytes));
    info = read;
    html = renderPeHtml(read, { fileName: 'fuzz.exe', sha256: 'f'.repeat(64) });
  } catch (err) {
    if (!(err instanceof PeError)) {
      throw err;
    }
  }
  done(html);
  checkPage('fuzz.exe', html, bytes, info);
  return html;
}

// readPe is async (it reads through a ByteSource), so this target is too;
// Jazzer.js awaits the promise, and fuzz/run.js runs it without --sync.
// A PeError is the reader's documented answer to a file it cannot describe;
// anything else (a RangeError from a view past the buffer, a TypeError, a
// CostError or a PageError) is a finding. The cost and page checks are the
// ones the pkg target has: until 2026-11-23 this target had neither.
export async function fuzz(data: Buffer): Promise<void> {
  await readAndCheck(data);
  const headed = withHeader(data);
  if (headed !== data) {
    await readAndCheck(headed);
  }
}
