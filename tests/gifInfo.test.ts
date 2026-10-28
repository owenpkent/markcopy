import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  describeLoop,
  formatClip,
  frameDelayMs,
  frameFileName,
  parseGif,
  statusLine,
} from '../src/webview/gifInfo';

interface FrameSpec {
  /** Delay in hundredths of a second; omit for a frame with no Graphic Control Extension. */
  delay?: number;
}

/** Assemble a GIF from the structural blocks only; the LZW data is a stub the parser skips. */
function buildGif(opts: {
  width?: number;
  height?: number;
  version?: string;
  frames: FrameSpec[];
  loop?: number;
  trailer?: boolean;
  globalColors?: boolean;
}): Uint8Array {
  const { width = 4, height = 3, version = '89a', frames, trailer = true } = opts;
  const out: number[] = [];
  const push = (...b: number[]) => out.push(...b);
  for (const c of `GIF${version}`) {
    push(c.charCodeAt(0));
  }
  push(width & 0xff, width >> 8, height & 0xff, height >> 8);
  if (opts.globalColors) {
    push(0x80, 0, 0); // a 2-colour global table follows
    push(0, 0, 0, 255, 255, 255);
  } else {
    push(0, 0, 0);
  }
  if (opts.loop !== undefined) {
    push(0x21, 0xff, 11);
    for (const c of 'NETSCAPE2.0') {
      push(c.charCodeAt(0));
    }
    push(3, 1, opts.loop & 0xff, opts.loop >> 8, 0);
  }
  for (const frame of frames) {
    if (frame.delay !== undefined) {
      push(0x21, 0xf9, 4, 0, frame.delay & 0xff, frame.delay >> 8, 0, 0);
    }
    push(0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0);
    push(2); // LZW minimum code size
    push(2, 0x4c, 0x01, 0); // one sub-block, then the terminator
  }
  if (trailer) {
    push(0x3b);
  }
  return Uint8Array.from(out);
}

describe('parseGif', () => {
  it('reads version, dimensions, frame count and delays', () => {
    const info = parseGif(
      buildGif({ width: 320, height: 200, frames: [{ delay: 20 }, { delay: 50 }, { delay: 120 }] }),
    );
    expect(info).toMatchObject({
      version: '89a',
      width: 320,
      height: 200,
      frameCount: 3,
      delays: [200, 500, 1200],
      durationMs: 1900,
      truncated: false,
    });
  });

  it('accepts GIF87a and a global colour table', () => {
    const info = parseGif(buildGif({ version: '87a', globalColors: true, frames: [{}] }));
    expect(info?.version).toBe('87a');
    expect(info?.frameCount).toBe(1);
  });

  it('plays a delay of 0 or 10 ms or less as 100 ms', () => {
    const info = parseGif(buildGif({ frames: [{ delay: 0 }, { delay: 1 }, { delay: 2 }, {}] }));
    // 0 and 1 centiseconds (0 and 10 ms) clamp; 2 centiseconds (20 ms) does not;
    // a frame with no extension has no delay at all and clamps too.
    expect(info?.delays).toEqual([100, 100, 20, 100]);
    expect(frameDelayMs(0)).toBe(100);
    expect(frameDelayMs(1)).toBe(100);
    expect(frameDelayMs(2)).toBe(20);
  });

  it('does not carry a delay from one frame into the next', () => {
    const info = parseGif(buildGif({ frames: [{ delay: 50 }, {}] }));
    expect(info?.delays).toEqual([500, 100]);
  });

  it('reads the NETSCAPE loop count: absent, forever, and a number', () => {
    expect(parseGif(buildGif({ frames: [{ delay: 5 }] }))?.loopCount).toBeNull();
    expect(parseGif(buildGif({ loop: 0, frames: [{ delay: 5 }] }))?.loopCount).toBe(0);
    expect(parseGif(buildGif({ loop: 3, frames: [{ delay: 5 }] }))?.loopCount).toBe(3);
  });

  it('accepts a file with no trailer', () => {
    const info = parseGif(buildGif({ frames: [{ delay: 5 }, { delay: 5 }], trailer: false }));
    expect(info?.frameCount).toBe(2);
    expect(info?.truncated).toBe(false);
  });

  it('keeps the whole frames of a file cut off inside a later one', () => {
    const full = buildGif({ frames: [{ delay: 5 }, { delay: 5 }] });
    const info = parseGif(full.subarray(0, full.length - 4));
    expect(info?.frameCount).toBe(1);
    expect(info?.truncated).toBe(true);
  });

  it('returns null when truncated before any whole frame', () => {
    const full = buildGif({ globalColors: true, frames: [{ delay: 5 }] });
    for (const n of [0, 5, 6, 12, 14, 20, full.length - 3]) {
      expect(parseGif(full.subarray(0, n))).toBeNull();
    }
  });

  it('returns null for non-GIF input', () => {
    expect(parseGif(new TextEncoder().encode('# just a markdown file, not an image'))).toBeNull();
    expect(
      parseGif(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBeNull();
    expect(parseGif(new Uint8Array(0))).toBeNull();
  });

  it('terminates on garbage after a valid header', () => {
    const header = buildGif({ frames: [] }).subarray(0, 13);
    const junk = new Uint8Array(4096).fill(0xff);
    const bytes = new Uint8Array(header.length + junk.length);
    bytes.set(header);
    bytes.set(junk, header.length);
    expect(parseGif(bytes)).toBeNull();
  });

  it('terminates on sub-blocks that claim to run past the end', () => {
    const bytes = buildGif({ frames: [{ delay: 5 }], trailer: false });
    // Replace the final sub-block size with one far past the end of the data.
    const broken = bytes.slice();
    broken[broken.length - 4] = 0xff;
    expect(() => parseGif(broken)).not.toThrow();
  });
});

describe('formatters', () => {
  it('formats clip lengths', () => {
    expect(formatClip(340)).toBe('340 ms');
    expect(formatClip(2400)).toBe('2.4 s');
    expect(formatClip(NaN)).toBe('');
  });

  it('describes the loop count', () => {
    expect(describeLoop(null)).toBe('plays once');
    expect(describeLoop(0)).toBe('loops forever');
    expect(describeLoop(1)).toBe('repeats once');
    expect(describeLoop(4)).toBe('repeats 4 times');
  });

  it('names a saved frame after the GIF and the 1-based frame number', () => {
    expect(frameFileName('anim.gif', 12)).toBe('anim-frame-012.png');
    expect(frameFileName('my.clip.GIF', 1)).toBe('my.clip-frame-001.png');
    expect(frameFileName('anim.gif', 1234)).toBe('anim-frame-1234.png');
    expect(frameFileName('anim.gif', 0)).toBe('anim-frame-001.png');
    expect(frameFileName('', 5)).toBe('frame-frame-005.png');
  });

  it('builds the status line, with and without frame tracking', () => {
    const info = parseGif(
      buildGif({ width: 10, height: 6, loop: 0, frames: [{ delay: 50 }, { delay: 50 }] }),
    )!;
    expect(statusLine({ name: 'a.gif', bytes: 2048, info, frame: 1 })).toBe(
      'a.gif  ·  2 KB  ·  10x6  ·  frame 2 / 2  ·  1 s  ·  loops forever',
    );
    expect(statusLine({ name: 'a.gif', bytes: 0, info, frame: null })).toContain('2 frames');
    expect(statusLine({ name: 'a.gif', bytes: NaN, info: null, frame: null })).toBe('a.gif');
  });

  it('decodes base64 and shrugs off junk', () => {
    expect(Array.from(base64ToBytes('R0lG'))).toEqual([0x47, 0x49, 0x46]);
    expect(base64ToBytes('not base64!!').length).toBe(0);
    expect(base64ToBytes(42).length).toBe(0);
  });
});
