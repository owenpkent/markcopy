import { describe, expect, it } from 'vitest';
import { framesToTimecode, positionTimecode, secondsToTimecode } from '../src/review/timecode';

describe('secondsToTimecode', () => {
  it('labels whole seconds at 25, 30 and 60 fps', () => {
    expect(secondsToTimecode(0, 25)).toBe('00:00:00:00');
    expect(secondsToTimecode(1, 25)).toBe('00:00:01:00');
    expect(secondsToTimecode(1.04, 25)).toBe('00:00:01:01');
    expect(secondsToTimecode(61.5, 30)).toBe('00:01:01:15');
    expect(secondsToTimecode(3600, 30)).toBe('01:00:00:00');
    expect(secondsToTimecode(2.5, 60)).toBe('00:00:02:30');
    expect(secondsToTimecode(0.99, 60)).toBe('00:00:00:59');
  });

  it('counts frames at 29.97 and labels them at 30', () => {
    expect(secondsToTimecode(1, 29.97)).toBe('00:00:01:00');
    expect(secondsToTimecode(0.5, 29.97)).toBe('00:00:00:15');
    expect(secondsToTimecode(600, 29.97)).toBe('00:09:59:12');
  });

  it('falls back to 30 for a missing rate', () => {
    expect(secondsToTimecode(2, 0)).toBe('00:00:02:00');
  });

  it('clamps negative times to zero', () => {
    expect(secondsToTimecode(-3, 30)).toBe('00:00:00:00');
  });
});

describe('framesToTimecode', () => {
  it('rolls over minutes and hours', () => {
    expect(framesToTimecode(30 * 60 - 1, 30)).toBe('00:00:59:29');
    expect(framesToTimecode(30 * 60, 30)).toBe('00:01:00:00');
    expect(framesToTimecode(30 * 3600, 30)).toBe('01:00:00:00');
  });
});

describe('positionTimecode', () => {
  it('floors to the frame being shown', () => {
    expect(positionTimecode(1.039, 25)).toBe('00:00:01:00');
    expect(positionTimecode(1.04, 25)).toBe('00:00:01:01');
    expect(positionTimecode(-1, 25)).toBe('00:00:00:00');
  });
});
