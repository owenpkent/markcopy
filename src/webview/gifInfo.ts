// Pure helpers for the GIF preview, kept out of src/webview/gif.ts so they can
// be unit-tested without a DOM or a real ImageDecoder (same split as
// src/webview/videoInfo.ts and src/webview/stlInfo.ts).
import { formatBytes } from './videoInfo';

// The host reads the file whole and sends it as base64 (see src/gifEditor.ts),
// so the largest GIF it will open is bounded by the same JSON-string cost as
// the STL viewer's. Far lower than that viewer's cap, because the browser holds
// the decoder's frame cache on top of the bytes and a GIF this large is not a
// preview-sized thing anyway.
export const MAX_GIF_BYTES = 64 * 1024 * 1024;

export interface GifInfo {
  /** `87a` or `89a`. */
  version: string;
  width: number;
  height: number;
  frameCount: number;
  /** Per-frame display time in ms, after the browser's clamp (see frameDelayMs). */
  delays: number[];
  /**
   * The NETSCAPE2.0 repeat count: how many times the animation repeats after
   * its first play, 0 meaning forever. `null` when the block is absent, which
   * browsers play once.
   */
  loopCount: number | null;
  /** One pass through every frame, in ms. */
  durationMs: number;
  /** The data ended inside a block, after at least one whole frame. */
  truncated: boolean;
}

/**
 * How long a frame is shown, given its Graphic Control Extension delay in
 * hundredths of a second.
 *
 * Browsers do not honour the file for short delays: a delay of 0 or 10 ms or
 * less plays as 100 ms, a rule inherited from the days when encoders wrote 0
 * to mean "as fast as possible" and viewers answered by spinning the CPU. The
 * preview applies it too, so the total it reports matches what plays.
 */
export function frameDelayMs(centiseconds: number): number {
  const ms = centiseconds * 10;
  return ms <= 10 ? 100 : ms;
}

class Truncated extends Error {}

/**
 * Read a GIF's structure without decoding any pixels: the logical screen, the
 * frame count and each frame's delay, and the loop count.
 *
 * Returns null for anything that is not a GIF, or that ends before a whole
 * frame. A file cut off after at least one whole frame is reported with
 * `truncated` set, as browsers still play what is there. Every step either
 * advances the cursor or stops, so malformed input cannot loop forever.
 */
export function parseGif(bytes: Uint8Array): GifInfo | null {
  if (bytes.length < 13) {
    return null;
  }
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    return null;
  }

  let pos = 6;
  const u8 = (): number => {
    if (pos >= bytes.length) {
      throw new Truncated();
    }
    return bytes[pos++];
  };
  const u16 = (): number => u8() | (u8() << 8);
  const skip = (n: number): void => {
    if (pos + n > bytes.length) {
      throw new Truncated();
    }
    pos += n;
  };
  // A data sub-block chain: length-prefixed chunks ending at a zero length.
  const skipSubBlocks = (): void => {
    for (let size = u8(); size !== 0; size = u8()) {
      skip(size);
    }
  };

  let width: number;
  let height: number;
  try {
    width = u16();
    height = u16();
    const packed = u8();
    skip(2); // background colour index, pixel aspect ratio
    if (packed & 0x80) {
      skip(3 * (1 << ((packed & 7) + 1)));
    }
  } catch {
    return null;
  }

  const delays: number[] = [];
  let loopCount: number | null = null;
  let pendingDelay = 0;
  let truncated = false;
  try {
    for (;;) {
      if (pos >= bytes.length) {
        break; // no trailer: common, and not damage
      }
      const intro = u8();
      if (intro === 0x3b) {
        break;
      }
      if (intro === 0x21) {
        const label = u8();
        if (label === 0xf9) {
          const size = u8();
          const start = pos;
          skip(size);
          if (size >= 4) {
            pendingDelay = bytes[start + 1] | (bytes[start + 2] << 8);
          }
          skipSubBlocks();
        } else if (label === 0xff) {
          const size = u8();
          const start = pos;
          skip(size);
          const ident = String.fromCharCode(...bytes.subarray(start, start + size));
          if (ident === 'NETSCAPE2.0' || ident === 'ANIMEXTS1.0') {
            // The first sub-block after the identifier is [1, count lo, count hi].
            const len = u8();
            const body = pos;
            skip(len);
            if (len >= 3 && bytes[body] === 1) {
              loopCount = bytes[body + 1] | (bytes[body + 2] << 8);
            }
          }
          skipSubBlocks();
        } else {
          skipSubBlocks();
        }
      } else if (intro === 0x2c) {
        skip(8); // left, top, width, height
        const flags = u8();
        if (flags & 0x80) {
          skip(3 * (1 << ((flags & 7) + 1)));
        }
        u8(); // LZW minimum code size
        skipSubBlocks();
        delays.push(frameDelayMs(pendingDelay));
        pendingDelay = 0;
      } else {
        // Not a block introducer: the stream is damaged from here on.
        throw new Truncated();
      }
    }
  } catch (err) {
    if (!(err instanceof Truncated)) {
      throw err;
    }
    truncated = true;
  }

  if (delays.length === 0) {
    return null;
  }
  return {
    version: signature.slice(3),
    width,
    height,
    frameCount: delays.length,
    delays,
    loopCount,
    durationMs: delays.reduce((a, b) => a + b, 0),
    truncated,
  };
}

/** Decode the host's base64 payload. Junk gives an empty array, never a throw. */
export function base64ToBytes(b64: unknown): Uint8Array {
  if (typeof b64 !== 'string') {
    return new Uint8Array(0);
  }
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** A time for the readout: `340 ms` under a second, `2.4 s` above. */
export function formatClip(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;
}

/** What the file says about repeating, in words. */
export function describeLoop(loopCount: number | null): string {
  if (loopCount === null) {
    return 'plays once';
  }
  if (loopCount === 0) {
    return 'loops forever';
  }
  return loopCount === 1 ? 'repeats once' : `repeats ${loopCount} times`;
}

/**
 * Default name for a saved frame: `anim.gif` frame 12 -> `anim-frame-012.png`.
 * `frame` is the 1-based number the status line shows, so the name matches what
 * the reader saw when they saved it; a clip past 999 frames just gets wider.
 */
export function frameFileName(gifName: string, frame: number): string {
  const dot = gifName.lastIndexOf('.');
  const base = dot > 0 ? gifName.slice(0, dot) : gifName || 'frame';
  const n = Number.isFinite(frame) && frame > 0 ? Math.floor(frame) : 1;
  return `${base}-frame-${String(n).padStart(3, '0')}.png`;
}

/** The one-line readout: name, size, dimensions, frame position, length, loop. */
export function statusLine(args: {
  name: string;
  bytes: number;
  info: GifInfo | null;
  /** 0-based index of the frame on screen, or null when frames are not tracked. */
  frame: number | null;
  loop?: boolean;
}): string {
  const { name, bytes, info, frame } = args;
  const parts: string[] = [name];
  const size = formatBytes(bytes);
  if (size) {
    parts.push(size);
  }
  if (info) {
    parts.push(`${info.width}x${info.height}`);
    parts.push(
      frame === null ? `${info.frameCount} frames` : `frame ${frame + 1} / ${info.frameCount}`,
    );
    parts.push(formatClip(info.durationMs));
    parts.push(args.loop ? 'looping' : describeLoop(info.loopCount));
    if (info.truncated) {
      parts.push('file is cut short');
    }
  }
  return parts.filter(Boolean).join('  ·  ');
}
