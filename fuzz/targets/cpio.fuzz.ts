import { gunzipUntil, unxzUntil, unzstdUntil, type ChunkHandler } from '../../src/pkg/decompress';
import { PackageError } from '../../src/pkg/model';
import {
  CpioWalker,
  MAX_MEMBER_NAME,
  MAX_PAYLOAD_MEMBERS,
  NotChecked,
} from '../../src/pkg/rpmPayload';
import { CostError, MAX_HEAP_GROWTH, MAX_MILLISECONDS, memoryInUse } from './binaryOracle';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// The RPM payload check (src/pkg/rpmPayload.ts) feeds a streaming decompressor's
// output, in pieces of whatever size it produces, to a CpioWalker. The pkg target
// reaches it only behind a whole RPM whose header must parse first, and then a
// valid compressed stream; this target feeds both pieces directly.
//
// The first input byte picks the stage and the second the piece size; the rest is
// the data:
//   0  the bytes as a cpio stream, fed whole and again in pieces: the names, the
//      finished flag and the refusal (a NotChecked, the walker's documented
//      answer) must be the same however the stream is cut
//   1  gzip   2  zstd   3  xz: the decompressor is given the bytes with a
//      1 MiB output cap and a handler that walks what it produces; it may throw a
//      PackageError, never anything else, and must not hand out more than the cap
const MODES = 4;
const MAX_OUTPUT = 1024 * 1024;

/** What walking a stream gave: names, whether the trailer was reached, or why not. */
interface Walked {
  names: string[];
  finished: boolean;
  refusal?: string;
}

function walk(data: Uint8Array, piece: number): Walked {
  const walker = new CpioWalker();
  let refusal: string | undefined;
  try {
    for (let at = 0; at < data.length && !walker.finished; at += piece) {
      walker.feed(data.subarray(at, at + piece));
    }
  } catch (err) {
    if (!(err instanceof NotChecked)) {
      throw err;
    }
    refusal = err.message;
  }
  checkNames(walker.names);
  return { names: walker.names, finished: walker.finished, refusal };
}

function checkNames(names: string[]): void {
  if (names.length > MAX_PAYLOAD_MEMBERS) {
    throw new CostError(`${names.length} names kept, past the ${MAX_PAYLOAD_MEMBERS} cap`);
  }
  for (const name of names) {
    // A name is at most MAX_MEMBER_NAME bytes, and a byte decodes to at most one character.
    if (name.length > MAX_MEMBER_NAME) {
      throw new CostError(`a name of ${name.length} characters, past ${MAX_MEMBER_NAME}`);
    }
  }
}

function sameWalk(a: Walked, b: Walked, piece: number): void {
  if (
    a.finished !== b.finished ||
    a.refusal !== b.refusal ||
    a.names.length !== b.names.length ||
    a.names.some((n, i) => n !== b.names[i])
  ) {
    throw new Error(`cpio walked in pieces of ${piece} bytes differs from the whole stream`);
  }
}

async function decompress(mode: number, data: Uint8Array): Promise<void> {
  const walker = new CpioWalker();
  let total = 0;
  const onChunk: ChunkHandler = (chunk) => {
    total += chunk.length;
    try {
      return walker.feed(chunk);
    } catch (err) {
      if (!(err instanceof NotChecked)) {
        throw err;
      }
      return true;
    }
  };
  try {
    if (mode === 1) {
      gunzipUntil(data, MAX_OUTPUT, onChunk);
    } else if (mode === 2) {
      unzstdUntil(data, MAX_OUTPUT, onChunk);
    } else {
      await unxzUntil(data, MAX_OUTPUT, onChunk);
    }
  } catch (err) {
    if (!(err instanceof PackageError)) {
      throw err;
    }
  }
  // The cap is on what the decompressor produces; a piece that crosses it is
  // refused before the handler sees it, so the handler never sees more.
  if (total > MAX_OUTPUT) {
    throw new CostError(`a decompressor handed out ${total} bytes past the ${MAX_OUTPUT} cap`);
  }
  checkNames(walker.names);
}

// unxzUntil is async, so this target is too (fuzz/run.js runs it without --sync).
export async function fuzz(data: Buffer): Promise<void> {
  if (data.length < 2) {
    return;
  }
  const mode = data[0] % MODES;
  const piece = 1 + data[1];
  const rest = data.subarray(2);
  const started = performance.now();
  const memory = memoryInUse();
  if (mode === 0) {
    const whole = walk(rest, rest.length + 1);
    sameWalk(whole, walk(rest, piece), piece);
    sameWalk(whole, walk(rest, 1), 1);
  } else {
    await decompress(mode, rest);
  }
  const took = performance.now() - started;
  if (took > MAX_MILLISECONDS) {
    throw new CostError(`${rest.length} bytes took ${Math.round(took)} ms (mode ${mode})`);
  }
  if (memoryInUse() - memory > MAX_HEAP_GROWTH) {
    throw new CostError(`${rest.length} bytes grew memory past ${MAX_HEAP_GROWTH} (mode ${mode})`);
  }
}
