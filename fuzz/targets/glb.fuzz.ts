import { GlbError, readGlb } from '../../src/webview/glb';
import { checkModel } from './modelOracle';

// readGlb reads the JSON chunk by hand (refusing compression, external
// buffers and anything over the triangle cap), prunes it, bounds-checks every
// accessor, and only then hands a copy to three's GLTFLoader. A GlbError is its
// documented answer; anything else, or a model whose arrays and parts disagree
// (fuzz/targets/modelOracle.ts), is a finding.
//
// A GLB is a 12-byte header and length-prefixed chunks, and random bytes almost
// never get the lengths right, so the input is read as a GLB's two parts: the
// JSON text up to the first NUL byte, then the binary chunk. The harness
// writes the header and chunk lengths around them. The input as it is goes
// through as well, for the header and chunk checks themselves.
//
// The cap is far below the viewer's so a file declaring a large mesh is refused
// rather than spending the run allocating it.
export const MAX_TRIANGLES = 50_000;

/** A GLB around `json` and `bin`, each chunk padded to four bytes as the format requires. */
export function glbOf(json: Uint8Array, bin: Uint8Array | null): Buffer {
  const pad = (b: Uint8Array, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const j = pad(json, 0x20);
  const chunks = [Buffer.alloc(8), j];
  chunks[0].writeUInt32LE(j.length, 0);
  chunks[0].writeUInt32LE(0x4e4f534a, 4); // "JSON"
  if (bin !== null) {
    const b = pad(bin, 0);
    const head = Buffer.alloc(8);
    head.writeUInt32LE(b.length, 0);
    head.writeUInt32LE(0x004e4942, 4); // "BIN\0"
    chunks.push(head, b);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** The input as a GLB: JSON up to the first NUL, the binary chunk after it. */
export function asGlb(data: Buffer): Buffer {
  const nul = data.indexOf(0);
  return nul < 0 ? glbOf(data, null) : glbOf(data.subarray(0, nul), data.subarray(nul + 1));
}

async function readAndCheck(label: string, bytes: Uint8Array): Promise<void> {
  let model;
  try {
    model = await readGlb(bytes, { maxTriangles: MAX_TRIANGLES });
  } catch (err) {
    if (err instanceof GlbError) {
      return;
    }
    throw err;
  }
  checkModel(label, model, MAX_TRIANGLES);
}

export async function fuzz(data: Buffer): Promise<void> {
  await readAndCheck('as given', data);
  await readAndCheck('as a GLB', asGlb(data));
}
