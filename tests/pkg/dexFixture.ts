import { createHash } from 'node:crypto';
import { adler32 } from '../../src/pkg/dex';

export interface DexOptions {
  version?: string;
  size?: number;
  declaredSize?: number;
  endian?: number;
  strings?: number;
  methods?: number;
  classes?: number;
  badChecksum?: boolean;
  badSignature?: boolean;
}

/** A DEX file of `size` bytes (at least 112) with a header whose digests are right unless told otherwise. */
export function buildDex(options: DexOptions = {}): Uint8Array {
  const size = options.size ?? 0x100;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(`dex\n${options.version ?? '035'}\0`), 0);
  view.setUint32(0x20, options.declaredSize ?? size, true);
  view.setUint32(0x24, 0x70, true);
  view.setUint32(0x28, options.endian ?? 0x12345678, true);
  view.setUint32(0x38, options.strings ?? 0, true);
  view.setUint32(0x58, options.methods ?? 0, true);
  view.setUint32(0x60, options.classes ?? 0, true);
  for (let i = 0x70; i < size; i++) {
    out[i] = (i * 7) & 0xff;
  }
  const signature = createHash('sha1').update(out.subarray(32)).digest();
  if (options.badSignature) {
    signature[0] ^= 0xff;
  }
  out.set(signature, 0x0c);
  const sum = adler32(out.subarray(12)) ^ (options.badChecksum ? 1 : 0);
  view.setUint32(0x08, sum >>> 0, true);
  return out;
}
