import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachSeekBar,
  createFramePeek,
  frameSize,
  seekFraction,
  setSeekFill,
} from '../src/webview/seekBar';

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
  it('keeps the shape, the longest side within 160 and the area within 160 by 90', () => {
    expect(frameSize(1920, 1080)).toEqual({ width: 160, height: 90 });
    // A vertical clip stands up rather than shrinking to a 51 by 90 sliver.
    expect(frameSize(1080, 1920)).toEqual({ width: 90, height: 160 });
    expect(frameSize(1080, 1080)).toEqual({ width: 120, height: 120 });
    expect(frameSize(640, 480)).toEqual({ width: 139, height: 104 });
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

  it('does not bring back a frame whose seek lands after the hover ended', () => {
    const v = fakeVideo();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const peek = createFramePeek(
      () => 'blob:clip',
      vi.fn(),
      () => v.el,
    );
    peek.request(1.25);
    v.settle(); // metadata: the seek to 1.25 starts
    peek.clear(); // the pointer leaves before it lands
    v.settle(); // it lands late
    expect(peek.canvas.hidden).toBe(true);
    peek.request(0.25); // the next hover
    expect(peek.canvas.hidden).toBe(true);
    expect(v.seeks).toEqual([1.25, 0.25]);
    v.settle();
    expect(peek.canvas.hidden).toBe(false);
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

describe('attachSeekBar', () => {
  function bar(snap?: (s: number) => number): { slider: HTMLInputElement; tip: HTMLElement } {
    document.body.className = 'mc-video';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.max = '2';
    document.body.append(slider);
    slider.getBoundingClientRect = () =>
      ({ left: 0, width: 214, top: 0, bottom: 32, right: 214, height: 32 }) as DOMRect;
    attachSeekBar({
      slider,
      media: { paused: true, pause: () => undefined },
      thumb: 14,
      duration: () => 2,
      format: (s) => s.toFixed(2),
      frames: () => '',
      snap,
    });
    const tips = document.querySelectorAll<HTMLElement>('.mc-seek-tip');
    return { slider, tip: tips[tips.length - 1] };
  }

  it('seeks to a press beside the playhead, on the thumb too, and follows a small drag', () => {
    const { slider } = bar();
    slider.value = '1';
    const seen: number[] = [];
    slider.addEventListener('input', () => seen.push(Number(slider.value)));
    // The thumb is centred at 107 px; a press 3 px right of it lands there.
    slider.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 110 }));
    expect(seen).toEqual([1.03]);
    // A drag of one more px moves it again.
    slider.dispatchEvent(new MouseEvent('pointermove', { clientX: 111 }));
    expect(seen).toEqual([1.03, 1.04]);
    document.dispatchEvent(new MouseEvent('pointerup', { clientX: 111 }));
    // Once let go, a hover no longer seeks.
    slider.dispatchEvent(new MouseEvent('pointermove', { clientX: 150 }));
    expect(seen).toEqual([1.03, 1.04]);
  });

  it('labels the snapped time, so the tip names the frame a seek lands on', () => {
    // A 1 fps clip: a hover at 0.75 s is in frame 0, whose middle is 0.5 s.
    const { slider, tip } = bar((s) => Math.floor(s) + 0.5);
    slider.dispatchEvent(new MouseEvent('pointermove', { clientX: 7 + 200 * 0.375 }));
    expect(tip.textContent).toBe('0.50');
  });

  it('is really hidden after the pointer leaves, also once it held a frame', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(join(__dirname, '../media/preview.css'), 'utf8');
    document.head.append(style);
    const { slider, tip } = bar();
    slider.dispatchEvent(new MouseEvent('pointermove', { clientX: 50 }));
    // As a drawn frame leaves it.
    tip.classList.add('mc-seek-tip-frame');
    expect(getComputedStyle(tip).display).toBe('flex');
    slider.dispatchEvent(new MouseEvent('pointerleave'));
    expect(tip.hidden).toBe(true);
    expect(getComputedStyle(tip).display).toBe('none');
    // And when a drag is let go off the bar.
    slider.dispatchEvent(new MouseEvent('pointermove', { clientX: 50 }));
    tip.classList.add('mc-seek-tip-frame');
    slider.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    document.dispatchEvent(new MouseEvent('pointerup', { clientX: 500, clientY: 500 }));
    expect(getComputedStyle(tip).display).toBe('none');
    // The stylesheet alone keeps a hidden tip hidden, class or not.
    tip.classList.add('mc-seek-tip-frame');
    expect(getComputedStyle(tip).display).toBe('none');
    style.remove();
  });
});
