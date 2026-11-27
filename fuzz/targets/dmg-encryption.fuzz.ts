import { bytesSource, RangeReader } from '../../src/binary/reader';
import { encryptionRows, readDmgEncryption } from '../../src/pkg/dmgEncryption';
import { CostError, MAX_MILLISECONDS, hasControl } from './binaryOracle';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// What an encrypted Apple disk image declares is read from its unencrypted
// header: the version 2 "encrcdsa" header at the start, with a list of key items,
// or the version 1 trailer "cdsaencr" at the end that points at an info header
// (src/pkg/dmgEncryption.ts). It documents that it never throws, so any
// exception is a finding. The pkg-dmg variant reaches it only through an image
// that still starts with "encrcdsa" or ends with the trailer after mutation.
//
// The first byte picks the stage:
//   0  version 2 on the bytes as they are       1  version 1 as they are
//   2  version 2 with the magic, version 2 and a plausible key item count
//      written over the start, so mutation works on the fields behind them
//   3  version 1 with a trailer written over the end, pointing at an offset the
//      second and third bytes give
const MODES = 4;
const HEADER = 0x4c;
const V1_TRAILER = 20;
const V1_HEADER = 0x4e8;
const MAX_SLOTS = 17; // 16 listed, or one "header ends early" line
const MAX_LINE = 100;
const CIPHER = /^(AES-(128|192|256)|AES \(key size not determined\)|not determined)$/;

function shape(mode: number, rest: Buffer, hint: number): Buffer {
  if (mode === 2 && rest.length >= HEADER) {
    const out = Buffer.from(rest);
    out.write('encrcdsa', 0, 'latin1');
    out.writeUInt32BE(2, 8);
    if (out.readUInt32BE(0x48) > 16) {
      out.writeUInt32BE(out.readUInt32BE(0x48) % 17, 0x48);
    }
    return out;
  }
  if (mode === 3) {
    const out = Buffer.alloc(Math.max(rest.length, V1_HEADER + V1_TRAILER));
    rest.copy(out);
    const at = out.length - V1_TRAILER;
    out.writeBigUInt64BE(BigInt(hint % (at - V1_HEADER + 1)), at);
    out.writeUInt32BE(1, at + 8);
    out.write('cdsaencr', at + 12, 'latin1');
    return out;
  }
  return rest;
}

export async function fuzz(data: Buffer): Promise<void> {
  if (data.length < 3) {
    return;
  }
  const mode = data[0] % MODES;
  const version = mode === 1 || mode === 3 ? 1 : 2;
  const bytes = shape(mode, data.subarray(3), (data[1] << 8) | data[2]);
  const started = performance.now();
  const found = await readDmgEncryption(new RangeReader(bytesSource(bytes)), version);
  if (performance.now() - started > MAX_MILLISECONDS) {
    throw new CostError(`${bytes.length} bytes took too long`);
  }
  if (found !== undefined) {
    if (found.version !== version) {
      throw new Error(`asked for version ${version}, got ${found.version}`);
    }
    if (!CIPHER.test(found.cipher)) {
      throw new Error(`a cipher label ${JSON.stringify(found.cipher.slice(0, 60))}`);
    }
    if (found.blockSize !== undefined && (found.blockSize < 512 || found.blockSize > 1 << 24)) {
      throw new Error(`a block size of ${found.blockSize}`);
    }
    if (found.slots.length > MAX_SLOTS || found.slotsOmitted < 0) {
      throw new CostError(`${found.slots.length} slots, ${found.slotsOmitted} omitted`);
    }
    for (const slot of found.slots) {
      if (hasControl(slot) || slot.length > MAX_LINE) {
        throw new Error(`a slot line ${JSON.stringify(slot.slice(0, 60))}`);
      }
    }
  }
  for (const [label, value] of encryptionRows(found)) {
    if (hasControl(label) || hasControl(value)) {
      throw new Error('a row holds a control character');
    }
  }
}
