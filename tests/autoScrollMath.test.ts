import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTO_SCROLL_DEFAULT,
  AUTO_SCROLL_MAX,
  AUTO_SCROLL_MIN,
  DEFAULT_SIZE_INDEX,
  MAX_FRAME_SECONDS,
  SIZES,
  SPEED_STEP,
  advanceFrame,
  canHoldStep,
  clampSpeed,
  describeSpeed,
  parseSettings,
  speedLabels,
  startingSpeed,
  stepSpeed,
} from '../src/webview/autoScrollMath';

describe('clampSpeed', () => {
  it('keeps direction and clamps the size', () => {
    expect(clampSpeed(1000)).toBe(AUTO_SCROLL_MAX);
    expect(clampSpeed(-1000)).toBe(-AUTO_SCROLL_MAX);
    expect(clampSpeed(1)).toBe(AUTO_SCROLL_MIN);
    expect(clampSpeed(-1)).toBe(-AUTO_SCROLL_MIN);
    expect(clampSpeed(12.4)).toBe(12);
  });
  it('turns zero and NaN into the slowest speed down', () => {
    expect(clampSpeed(0)).toBe(AUTO_SCROLL_MIN);
    expect(clampSpeed(NaN)).toBe(AUTO_SCROLL_MIN);
    expect(clampSpeed(Infinity)).toBe(AUTO_SCROLL_MIN);
  });
});

describe('stepSpeed', () => {
  it('speeds up the way it goes and slows against it', () => {
    expect(stepSpeed(20, SPEED_STEP)).toBe(26);
    expect(stepSpeed(26, 1 / SPEED_STEP)).toBe(20);
    expect(stepSpeed(-20, 1 / SPEED_STEP)).toBe(-26);
    expect(stepSpeed(-26, SPEED_STEP)).toBe(-20);
  });
  it('crosses zero from the slowest speed', () => {
    expect(stepSpeed(AUTO_SCROLL_MIN, 1 / SPEED_STEP)).toBe(-AUTO_SCROLL_MIN);
    expect(stepSpeed(-AUTO_SCROLL_MIN, SPEED_STEP)).toBe(AUTO_SCROLL_MIN);
  });
  it('stops at full speed and ignores a useless factor', () => {
    expect(stepSpeed(AUTO_SCROLL_MAX, SPEED_STEP)).toBe(AUTO_SCROLL_MAX);
    expect(stepSpeed(-AUTO_SCROLL_MAX, 1 / SPEED_STEP)).toBe(-AUTO_SCROLL_MAX);
    expect(stepSpeed(20, 1)).toBe(20);
    expect(stepSpeed(20, NaN)).toBe(20);
  });
  it('still moves at the slow end, where the steps are small', () => {
    expect(stepSpeed(5, SPEED_STEP)).toBeGreaterThan(5);
  });
});

describe('canHoldStep', () => {
  it('refuses at a limit and across zero', () => {
    expect(canHoldStep(AUTO_SCROLL_MAX, SPEED_STEP)).toBe(false);
    expect(canHoldStep(AUTO_SCROLL_MIN, 1 / SPEED_STEP)).toBe(false);
    expect(canHoldStep(-AUTO_SCROLL_MIN, SPEED_STEP)).toBe(false);
    expect(canHoldStep(20, 1 / SPEED_STEP)).toBe(true);
    expect(canHoldStep(20, SPEED_STEP)).toBe(true);
  });
});

describe('labels and descriptions', () => {
  it('names what the next press does', () => {
    expect(speedLabels(20)).toEqual({ minus: 'Slower', plus: 'Faster' });
    expect(speedLabels(AUTO_SCROLL_MIN).minus).toBe('Reverse, scroll up');
    expect(speedLabels(-20)).toEqual({ minus: 'Faster', plus: 'Slower' });
    expect(speedLabels(-AUTO_SCROLL_MIN).plus).toBe('Reverse, scroll down');
  });
  it('says which way it goes', () => {
    expect(describeSpeed(12)).toBe('12 pixels per second, down');
    expect(describeSpeed(-12)).toBe('12 pixels per second, up');
  });
});

describe('startingSpeed', () => {
  it('starts the way there is room', () => {
    expect(startingSpeed(-12, 0, 1000)).toBe(12);
    expect(startingSpeed(12, 1000, 1000)).toBe(-12);
  });
  it('keeps the direction with room both ways, or none', () => {
    expect(startingSpeed(-12, 500, 1000)).toBe(-12);
    expect(startingSpeed(12, 500, 1000)).toBe(12);
    expect(startingSpeed(-12, 0, 0)).toBe(-12);
  });
});

describe('advanceFrame', () => {
  const base = { pos: 100, scrollTop: 100, speed: 60, dt: 0.016, maxTop: 1000 };
  it('moves by speed times time, independent of frame rate', () => {
    const a = advanceFrame({ ...base, dt: 1 / 30 }).pos - 100;
    const b = advanceFrame({ ...base, dt: 1 / 60 }).pos - 100;
    expect(a).toBeCloseTo(2, 6);
    expect(b).toBeCloseTo(1, 6);
  });
  it('moves up for a negative speed', () => {
    expect(advanceFrame({ ...base, speed: -60 }).pos).toBeLessThan(100);
  });
  it('clamps a long frame', () => {
    const r = advanceFrame({ ...base, dt: 5 });
    expect(r.pos - 100).toBeCloseTo(60 * MAX_FRAME_SECONDS, 6);
  });
  it('adopts a position the reader moved to', () => {
    const r = advanceFrame({ ...base, scrollTop: 400 });
    expect(r.pos).toBeGreaterThan(400);
    expect(r.pos).toBeLessThan(402);
  });
  it('keeps its own float position for sub-pixel drift', () => {
    const r = advanceFrame({ ...base, pos: 100.4, scrollTop: 100 });
    expect(r.pos).toBeCloseTo(100.4 + 60 * 0.016, 6);
  });
  it('reports the end and the top, clamped', () => {
    expect(advanceFrame({ ...base, pos: 999.9, scrollTop: 999.9 })).toEqual({
      pos: 1000,
      edge: 'end',
    });
    expect(advanceFrame({ ...base, pos: 0.2, scrollTop: 0.2, speed: -60 })).toEqual({
      pos: 0,
      edge: 'top',
    });
  });
  it('idles on a document that does not overflow, without reporting an end', () => {
    expect(advanceFrame({ ...base, maxTop: 0 }).edge).toBeNull();
    expect(advanceFrame({ ...base, maxTop: 0 }).pos).toBe(100);
  });
  it('does not move on a zero or negative dt', () => {
    expect(advanceFrame({ ...base, dt: 0 }).pos).toBe(100);
    expect(advanceFrame({ ...base, dt: -1 }).pos).toBe(100);
  });
});

describe('parseSettings', () => {
  it('falls back to defaults for anything unusable', () => {
    const d = { speed: AUTO_SCROLL_DEFAULT, size: DEFAULT_SIZE_INDEX };
    for (const raw of [undefined, null, 5, 'x', [], {}, { speed: 'fast', size: '2' }]) {
      expect(parseSettings(raw)).toEqual(d);
    }
    expect(parseSettings({ speed: 0, size: 1.5 })).toEqual(d);
    expect(parseSettings({ speed: NaN, size: -1 })).toEqual(d);
    expect(parseSettings({ size: SIZES.length })).toEqual(d);
  });
  it('keeps valid values and clamps the speed', () => {
    expect(parseSettings({ speed: -40, size: 3 })).toEqual({ speed: -40, size: 3 });
    expect(parseSettings({ speed: 99999, size: 0 })).toEqual({ speed: AUTO_SCROLL_MAX, size: 0 });
  });
});

describe('the puck in a narrow pane (stylesheet)', () => {
  // Measured in headless Chromium at Extra large: the three small buttons ended
  // up at 69 px wide at 300 px, 49 px at 240 px and 44 px at 220 px, all inside
  // the pane. This checks that the rules producing that are still there.
  const css = readFileSync('media/preview.css', 'utf8').replace(/\r\n/g, '\n');
  it('caps the button size by the room the pane has, never below 44px', () => {
    expect(css).toMatch(
      /--mc-as-small: min\(\s*calc\(44px \* var\(--mc-as-scale\)\),\s*max\(44px, /,
    );
    expect(css).toMatch(/width: var\(--mc-as-small\);/);
  });
  it('wraps the row when even 44px buttons cannot sit side by side', () => {
    expect(css).toMatch(/\.mc-as-row \{\n {2}display: flex;\n {2}flex-wrap: wrap;/);
  });
});
