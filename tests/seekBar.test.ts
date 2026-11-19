import { describe, expect, it, vi } from 'vitest';
import { createFramePeek, frameSize, seekFraction, setSeekFill } from '../src/webview/seekBar';

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

describe('frameSize', () => {
  it('fits the picture in 160 by 90, keeping its shape', () => {
    expect(frameSize(1920, 1080)).toEqual({ width: 160, height: 90 });
    expect(frameSize(1080, 1920)).toEqual({ width: 51, height: 90 });
    expect(frameSize(640, 480)).toEqual({ width: 120, height: 90 });
    expect(frameSize(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe('createFramePeek', () => {
  /** A hidden video whose seeks complete only when the test says so. */
  function fakeVideo(): { el: HTMLVideoElement; seeks: number[]; settle: () => void } {
    const el = document.createElement('video');
    const seeks: number[] = [];
    let time = 0;
    let ready = 0;
    Object.defineProperty(el, 'readyState', { get: () => ready });
    Object.defineProperty(el, 'videoWidth', { get: () => 1920 });
    Object.defineProperty(el, 'videoHeight', { get: () => 1080 });
    Object.defineProperty(el, 'currentTime', {
      get: () => time,
      set: (t: number) => {
        time = t;
        seeks.push(t);
      },
    });
    Object.defineProperty(el, 'src', { get: () => '', set: () => undefined });
    // The first settle delivers metadata; each later one finishes the pending seek.
    const settle = (): void => {
      ready = ready === 0 ? 1 : 4;
      el.dispatchEvent(new Event(ready === 1 ? 'loadedmetadata' : 'seeked'));
    };
    return { el, seeks, settle };
  }

  it('keeps one seek in flight and only the latest wanted time', () => {
    const v = fakeVideo();
    const drawImage = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const onDraw = vi.fn();
    const peek = createFramePeek(
      () => 'blob:clip',
      onDraw,
      () => v.el,
    );
    peek.request(10);
    expect(v.seeks).toEqual([]); // no metadata yet
    v.settle(); // loadedmetadata
    expect(v.seeks).toEqual([10]);
    peek.request(20);
    peek.request(30);
    expect(v.seeks).toEqual([10]);
    v.settle(); // seeked at 10: drawn, then straight on to 30, skipping 20
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(peek.canvas.hidden).toBe(false);
    expect(peek.canvas.style.width).toBe('160px');
    expect(v.seeks).toEqual([10, 30]);
    v.settle();
    expect(onDraw).toHaveBeenCalledTimes(2);
    peek.clear();
    expect(peek.canvas.hidden).toBe(true);
    getContext.mockRestore();
  });

  it('draws nothing without a source or after the source fails to load', () => {
    const v = fakeVideo();
    let source = '';
    const peek = createFramePeek(
      () => source,
      vi.fn(),
      () => v.el,
    );
    peek.request(5);
    expect(peek.canvas.hidden).toBe(true);
    source = 'blob:clip';
    peek.request(5);
    v.el.dispatchEvent(new Event('error'));
    v.settle();
    peek.request(6);
    expect(v.seeks).toEqual([]);
    expect(peek.canvas.hidden).toBe(true);
  });
});
