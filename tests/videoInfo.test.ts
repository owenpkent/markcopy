import { describe, expect, it } from 'vitest';
import {
  describeMediaError,
  formatBytes,
  formatDuration,
  frameFileName,
  timecodeSlug,
} from '../src/webview/videoInfo';

describe('formatDuration', () => {
  it('formats under a minute', () => {
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(59.9)).toBe('0:59');
  });

  it('formats minutes without padding the leading field', () => {
    expect(formatDuration(83)).toBe('1:23');
    expect(formatDuration(723)).toBe('12:03');
  });

  it('pads the minutes once there are hours', () => {
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('says the duration is unknown rather than claiming zero', () => {
    // A video reports NaN before its metadata loads and Infinity for a stream;
    // rendering either as 0:00 would read as an empty file.
    expect(formatDuration(Number.NaN)).toBe('--:--');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('--:--');
    expect(formatDuration(-1)).toBe('--:--');
  });
});

describe('formatBytes', () => {
  it('keeps small sizes whole', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('gives megabytes and gigabytes one decimal', () => {
    expect(formatBytes(1024 * 1024 * 4.25)).toBe('4.3 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe('2 GB');
  });

  it('returns nothing for a size it was never given', () => {
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});

describe('timecodeSlug', () => {
  it('keeps milliseconds so two nearby frames do not collide', () => {
    expect(timecodeSlug(23.4)).toBe('23.400s');
    expect(timecodeSlug(23.44)).toBe('23.440s');
  });

  it('pads seconds to two digits', () => {
    expect(timecodeSlug(3.5)).toBe('03.500s');
  });

  it('adds minutes and hours only once they exist', () => {
    expect(timecodeSlug(83.4)).toBe('1m23.400s');
    expect(timecodeSlug(3723)).toBe('1h02m03.000s');
  });

  it('treats an unknown position as the start', () => {
    expect(timecodeSlug(Number.NaN)).toBe('00.000s');
    expect(timecodeSlug(-5)).toBe('00.000s');
  });

  it('contains nothing illegal in a Windows filename', () => {
    // The whole reason this is not the displayed timecode: `:` cannot be
    // written to disk on Windows, and a save dialog seeded with one fails.
    expect(timecodeSlug(3723.25)).not.toMatch(/[<>:"/\\|?*]/);
  });
});

describe('frameFileName', () => {
  it('replaces the video extension with the timecode and .png', () => {
    expect(frameFileName('clip.mov', 83.4)).toBe('clip-1m23.400s.png');
  });

  it('handles a name with dots in it', () => {
    expect(frameFileName('take.2.final.mp4', 1)).toBe('take.2.final-01.000s.png');
  });

  it('copes with a name that has no extension', () => {
    expect(frameFileName('clip', 0)).toBe('clip-00.000s.png');
  });

  it('still produces a usable name for an empty one', () => {
    expect(frameFileName('', 0)).toBe('frame-00.000s.png');
  });
});

describe('describeMediaError', () => {
  it('names the file in every message', () => {
    for (const code of [1, 2, 3, 4, undefined]) {
      expect(describeMediaError(code, 'clip.mov')).toContain('clip.mov');
    }
  });

  it('explains the codec case rather than the error number', () => {
    // The common .mov failure: the container is fine, the codec is not.
    const message = describeMediaError(4, 'clip.mov');
    expect(message).toMatch(/ProRes/);
    expect(message).toMatch(/default player/);
  });

  it('distinguishes a damaged file from an unsupported one', () => {
    expect(describeMediaError(3, 'clip.mov')).toMatch(/damaged/);
    expect(describeMediaError(2, 'clip.mov')).toMatch(/read from disk/);
  });
});
