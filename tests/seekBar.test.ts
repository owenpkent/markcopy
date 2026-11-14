import { describe, expect, it } from 'vitest';
import { seekFraction, setSeekFill } from '../src/webview/seekBar';

describe('seekFraction', () => {
  it('maps the thumb centre span onto 0 to 1', () => {
    // A 214px slider at x 100 with a 14px thumb: values run from 107 to 307.
    expect(seekFraction(107, 100, 214, 14)).toBe(0);
    expect(seekFraction(207, 100, 214, 14)).toBe(0.5);
    expect(seekFraction(307, 100, 214, 14)).toBe(1);
  });

  it('clamps past either end', () => {
    expect(seekFraction(0, 100, 214, 14)).toBe(0);
    expect(seekFraction(900, 100, 214, 14)).toBe(1);
  });

  it('is 0 on a slider no wider than its thumb', () => {
    expect(seekFraction(120, 100, 14, 14)).toBe(0);
    expect(seekFraction(120, 100, 0, 14)).toBe(0);
  });
});

describe('setSeekFill', () => {
  it('publishes the played fraction, clamped, and 0 without a duration', () => {
    const slider = document.createElement('input');
    setSeekFill(slider, 30, 120);
    expect(slider.style.getPropertyValue('--mc-seek-frac')).toBe('0.25');
    setSeekFill(slider, 500, 120);
    expect(slider.style.getPropertyValue('--mc-seek-frac')).toBe('1');
    setSeekFill(slider, 30, Number.NaN);
    expect(slider.style.getPropertyValue('--mc-seek-frac')).toBe('0');
  });
});
