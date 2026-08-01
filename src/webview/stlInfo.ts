// Pure, dependency-free STL sniffing used by the STL preview and unit tests.
// Kept separate from the Three.js parsing path (STLLoader) so it has no DOM/Three
// dependency and is trivial to test.

export interface StlSniffResult {
  format: 'binary' | 'ascii';
  triangles: number | null;
}

// Safe upper bound on triangles for a viewer. A binary STL header can declare up
// to ~4.29B triangles (a uint32), and STLLoader allocates Float32Arrays sized
// from that value (faces * 9 floats), so an ~84-byte crafted file could request
// tens of GB and hang the webview. checkStl() gates parsing on this.
export const MAX_TRIANGLES = 10_000_000;

// The largest payload worth reconstructing: 80-byte header, uint32 count, then
// MAX_TRIANGLES triangles of 50 bytes. A payload claiming more than this is
// corrupt, and sizing an allocation from a corrupt length is how a bad message
// becomes an out-of-memory crash instead of an error message.
const MAX_PAYLOAD_BYTES = 84 + MAX_TRIANGLES * 50;

// Normalize the extension host's postMessage payload back to a Uint8Array.
//
// The host sends base64 (see src/stlEditor.ts) because the webview transport
// JSON-serializes messages, and JSON turns a Uint8Array into a numeric-keyed
// object ({"0":12,"1":34,...}) roughly 13x the size of the file. The remaining
// branches are a fallback for payloads that reach us some other way; they matter
// because `new Uint8Array(obj)` on such an object reads a missing `.length` and
// silently yields a ZERO-length array, which downstream is indistinguishable
// from a truncated file.
//
// Never throws and never allocates from an unbounded length: junk returns an
// empty array and the caller reports that instead of blaming the file.
export function toBytes(input: unknown): Uint8Array {
  if (typeof input === 'string') {
    return fromBase64(input);
  }
  // Returned by reference rather than copied. Nothing downstream mutates it.
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) {
    return Uint8Array.from(input as number[]);
  }
  if (input !== null && typeof input === 'object') {
    return fromArrayLikeObject(input as Record<string, unknown>);
  }
  return new Uint8Array(0);
}

function fromBase64(input: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(input);
  } catch {
    // Not base64, and nothing else sends a string, so there is nothing to
    // salvage. Report it as an empty payload.
    return new Uint8Array(0);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function fromArrayLikeObject(obj: Record<string, unknown>): Uint8Array {
  // A Node Buffer that went through JSON.
  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return Uint8Array.from(obj.data as number[]);
  }
  // Lost its prototype but kept a usable length. Index 0 has to be there too:
  // on a bare {length: n}, `Uint8Array.from` fabricates n zero bytes, which
  // sniffs as a valid empty binary STL rather than failing loudly.
  const { length } = obj;
  if (typeof length === 'number' && withinCap(length) && (length === 0 || '0' in obj)) {
    return Uint8Array.from(obj as unknown as ArrayLike<number>);
  }
  // Numeric keys, no length. Size from the highest index so a payload with a
  // gap still lands each byte at its original offset.
  const keys = Object.keys(obj).filter((k) => /^\d+$/.test(k));
  if (keys.length === 0) {
    return new Uint8Array(0);
  }
  let max = -1;
  for (const k of keys) {
    const index = Number(k);
    // Keys are unbounded strings, so an index past the cap would otherwise size
    // a multi-gigabyte allocation (or throw RangeError) off a corrupt message.
    if (!withinCap(index + 1)) {
      return new Uint8Array(0);
    }
    max = Math.max(max, index);
  }
  const out = new Uint8Array(max + 1);
  for (const k of keys) {
    out[Number(k)] = Number(obj[k]) & 0xff;
  }
  return out;
}

function withinCap(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= MAX_PAYLOAD_BYTES;
}

// Detect whether `bytes` looks like an ASCII or binary STL, and (for binary)
// read the declared triangle count out of the 80-byte header.
export function sniffStl(bytes: Uint8Array): StlSniffResult {
  if (looksAscii(bytes)) {
    return { format: 'ascii', triangles: null };
  }
  return { format: 'binary', triangles: binaryTriangleCount(bytes) };
}

// ASCII STL files start with "solid" and, within the same header region,
// contain a "facet" keyword introducing the first triangle. Binary STL files
// can technically start with the bytes "solid" too (the 80-byte header is
// free-form text), so requiring "facet" nearby as well avoids misclassifying
// those as ASCII.
function looksAscii(bytes: Uint8Array): boolean {
  const head = decodeLatin1(bytes.subarray(0, Math.min(bytes.length, 1024)));
  return /^\s*solid\b/i.test(head) && /facet/i.test(head);
}

// A binary STL is: 80-byte header, uint32 LE triangle count, then 50 bytes per
// triangle (12 floats + a uint16 attribute byte count). If the file's actual
// size does not match that formula, the header count is still returned as-is
// (some tools write STL files with a stale/incorrect count); the caller can
// treat the size mismatch as a warning if it cares.
function binaryTriangleCount(bytes: Uint8Array): number | null {
  if (bytes.length < 84) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(80, true);
}

function decodeLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

export interface StlCheck {
  ok: boolean;
  reason?: string;
  format: 'binary' | 'ascii';
  triangles: number | null;
}

// Decide whether `bytes` is safe to hand to STLLoader.parse(). For binary STL we
// reject when the header's declared triangle count needs more bytes than the
// file actually holds (the small-file / huge-count amplification that drives a
// giant allocation) or when it exceeds `maxTriangles`. ASCII STL is parsed
// facet-by-facet, bounded by the real file length, so it is always allowed here.
export function checkStl(bytes: Uint8Array, maxTriangles = MAX_TRIANGLES): StlCheck {
  const { format, triangles } = sniffStl(bytes);
  if (format === 'ascii') {
    return { ok: true, format, triangles };
  }
  if (triangles === null) {
    return { ok: false, reason: 'File is too short to be a valid STL.', format, triangles };
  }
  if (84 + triangles * 50 > bytes.byteLength) {
    return {
      ok: false,
      reason: `Binary STL header claims ${triangles.toLocaleString()} triangles, more than the file can hold. Refusing to load (possibly a corrupt or malicious file).`,
      format,
      triangles,
    };
  }
  if (triangles > maxTriangles) {
    return {
      ok: false,
      reason: `Model has ${triangles.toLocaleString()} triangles, above MarkCopy's ${maxTriangles.toLocaleString()} limit.`,
      format,
      triangles,
    };
  }
  return { ok: true, format, triangles };
}
