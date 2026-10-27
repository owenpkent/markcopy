// Ported from owenpkent/Marker web/test/timeline.test.ts at bed7d13.
import { describe, expect, it } from 'vitest';
import {
  DOT_GAP,
  DOT_HIT,
  bandGeometry,
  cycleTarget,
  fitRect,
  frameIndex,
  frameStartSeconds,
  frameStepMs,
  layoutDots,
  pendingBand,
  pinVisible,
  pointInRect,
  seekMsForFrame,
  seekTarget,
  stepTarget,
  timeFromX,
} from '../src/review/timeline';
import { positionTimecode, secondsToTimecode } from '../src/review/timecode';

const near = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(d);

const rows = (...ats: number[]) =>
  ats.map((at, i) => ({ id: `n${i + 1}`, at, startMs: at * 1000, tc: `tc${i + 1}`, done: false }));

describe('seek maths', () => {
  it('frame step', () => {
    near(frameStepMs(30), 33.3333, 1e-3);
    near(frameStepMs(29.97), 33.3667, 1e-3);
    near(frameStepMs(0), 33.3333, 1e-3);
  });

  it.each([30, 29.97])('seek lands half a frame into the frame at %s fps', (fps) => {
    const step = 1000 / fps;
    for (const frame of [0, 1, 30, 299]) {
      const edge = frame * step;
      for (const pos of [edge, edge - 1e-9, edge + step * 0.3]) {
        near(seekTarget(pos, fps, 10), frame * step + step / 2);
      }
      expect(frameIndex(seekTarget(edge, fps, 10), fps)).toBe(frame);
    }
  });

  it.each([30, 29.97])('step moves exactly one frame and never drifts at %s fps', (fps) => {
    const step = 1000 / fps;
    let pos = seekTarget(0, fps, 10);
    for (let n = 1; n < 40; n++) {
      pos = stepTarget(pos, 1, fps, 10);
      expect(frameIndex(pos, fps)).toBe(n);
      near(pos, n * step + step / 2);
    }
    for (let n = 38; n >= 0; n--) {
      pos = stepTarget(pos, -1, fps, 10);
      expect(frameIndex(pos, fps)).toBe(n);
    }
  });

  it('clamps to the first and last frame', () => {
    expect(frameIndex(stepTarget(0, -1, 30, 1), 30)).toBe(0);
    expect(frameIndex(stepTarget(seekTarget(5000, 30, 1), 1, 30, 1), 30)).toBe(29);
    near(seekTarget(999999, 30, 1), seekMsForFrame(29, 30));
  });

  it('a note stores the frame start', () => {
    near(frameStartSeconds(seekTarget(1000, 25, 10), 25), 1.0);
  });

  it('the timecode label is floor(position / step)', () => {
    expect(positionTimecode(seekTarget(1000, 25, 10) / 1000, 25)).toBe('00:00:01:00');
    expect(secondsToTimecode(600, 29.97)).toBe('00:09:59:12');
  });
});

describe('studs', () => {
  it('are one row and never closer than a target pitch', () => {
    const dots = layoutDots(rows(...Array.from({ length: 8 }, (_, i) => 5 + i * 0.01)), 10, 600);
    expect(dots).toHaveLength(1);
    expect(dots[0].count).toBe(8);
    expect(dots[0].label).toBe('8');
    expect(dots[0].ids).toEqual(Array.from({ length: 8 }, (_, i) => `n${i + 1}`));
    expect(dots.every((d) => !('lane' in d))).toBe(true);
    const spread = layoutDots(rows(...Array.from({ length: 20 }, (_, i) => 0.5 * i)), 10, 600);
    for (let i = 1; i < spread.length; i++) {
      expect(spread[i].x - spread[i - 1].x).toBeGreaterThanOrEqual(DOT_HIT + DOT_GAP);
    }
    expect(spread.every((d) => d.x >= 0 && d.x <= 600 - DOT_HIT)).toBe(true);
  });

  it('cluster threshold is one target pitch', () => {
    // usable 600 over 60 s: 10 px per second; pitch 52 px
    const under = layoutDots(rows(10.0, 15.1), 60, 644);
    const over = layoutDots(rows(10.0, 15.3), 60, 644);
    expect(under.map((d) => d.count)).toEqual([2]);
    expect(over.map((d) => d.count)).toEqual([1, 1]);
    near(under[0].x, 100);
  });

  it('a chain of close notes is one cluster and the next stays clear', () => {
    const dots = layoutDots(rows(10, 14, 18, 30), 60, 644);
    expect(dots.map((d) => d.count)).toEqual([3, 1]);
    expect(dots[0].labels).toEqual(['1', '2', '3']);
    expect(dots[1].label).toBe('4');
  });

  it('a cluster is done only when every member is', () => {
    const r = rows(10, 11);
    r[0].done = true;
    expect(layoutDots(r, 60, 644)[0].done).toBe(false);
    r[1].done = true;
    expect(layoutDots(r, 60, 644)[0].done).toBe(true);
  });
});

describe('cycleTarget', () => {
  it('goes to the first, then each next, wrapping', () => {
    const ids = ['n2', 'n3', 'n4'];
    expect(cycleTarget(ids, '')).toBe('n2');
    expect(cycleTarget(ids, 'n9')).toBe('n2');
    expect(cycleTarget(ids, 'n2')).toBe('n3');
    expect(cycleTarget(ids, 'n4')).toBe('n2');
    expect(cycleTarget(['n1'], 'n1')).toBe('n1');
    expect(cycleTarget([], 'n1')).toBe('');
  });
});

describe('bands', () => {
  it('band geometry is x and width from times', () => {
    const [x, w] = bandGeometry(2, 5, 10, 644); // usable 600
    near(x, 22 + 120);
    near(w, 180);
    expect(bandGeometry(2, 2, 10, 644)[1]).toBe(4); // never invisible
    expect(bandGeometry(0, 10, 10, 644)).toEqual([22, 600]);
  });

  it('pending band states', () => {
    expect(pendingBand(-1, -1, 10, 644).visible).toBe(false);
    const onlyIn = pendingBand(2, -1, 10, 644);
    expect(onlyIn.visible).toBe(true);
    expect(onlyIn.hasOut).toBe(false);
    expect(onlyIn.width).toBe(0);
    near(onlyIn.x, 22 + 120);
    const both = pendingBand(2, 5, 10, 644);
    expect(both.hasOut).toBe(true);
    near(both.width, 180);
  });

  it('timeFromX inverts the handle travel', () => {
    near(timeFromX(22, 644, 10), 0);
    near(timeFromX(322, 644, 10), 5);
    near(timeFromX(9999, 644, 10), 10);
  });
});

describe('pins', () => {
  it('fits the picture inside the box like object-fit: contain', () => {
    expect(fitRect(200, 100, 100, 100)).toEqual({ x: 50, y: 0, w: 100, h: 100 });
    expect(fitRect(100, 200, 100, 100)).toEqual({ x: 0, y: 50, w: 100, h: 100 });
    expect(fitRect(1600, 900, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
    const r = fitRect(1000, 500, 1920, 1080);
    near(r.w / r.h, 1920 / 1080);
    near(r.x, (1000 - r.w) / 2);
    expect(fitRect(100, 50, 0, 10)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(fitRect(100, 50, NaN, 10)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(fitRect(100, 50, 10, -1)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  it('maps a pixel to the picture, null in the letterbox', () => {
    const r = { x: 50, y: 0, w: 100, h: 100 };
    expect(pointInRect(100, 50, r)).toEqual([0.5, 0.5]);
    expect(pointInRect(50, 0, r)).toEqual([0, 0]);
    expect(pointInRect(150, 100, r)).toEqual([1, 1]);
    expect(pointInRect(49.9, 50, r)).toBeNull();
    expect(pointInRect(150.1, 50, r)).toBeNull();
    expect(pointInRect(100, -1, r)).toBeNull();
    expect(pointInRect(100, 101, r)).toBeNull();
    expect(pointInRect(0, 0, { x: 0, y: 0, w: 0, h: 10 })).toBeNull();
    expect(pointInRect(0, 0, { x: 0, y: 0, w: 10, h: 0 })).toBeNull();
    expect(pointInRect(1, 1, { x: 0, y: 0, w: 3, h: 3 })).toEqual([0.3333, 0.3333]);
    expect(pointInRect(2, 2, { x: 0, y: 0, w: 3, h: 3 })).toEqual([0.6667, 0.6667]);
  });

  it('shows a pin on the frames of its note', () => {
    const step = 1000 / 24;
    expect(pinVisible(1, null, 1 * 1000, 24)).toBe(true);
    expect(pinVisible(1, null, 24 * step, 24)).toBe(true);
    expect(pinVisible(1, null, 23 * step, 24)).toBe(false);
    expect(pinVisible(1, null, 25 * step, 24)).toBe(false);
    expect(pinVisible(1, 2, 24 * step, 24)).toBe(true);
    expect(pinVisible(1, 2, 48 * step, 24)).toBe(true);
    expect(pinVisible(1, 2, 49 * step, 24)).toBe(false);
    expect(pinVisible(1, 2, 23 * step, 24)).toBe(false);
    expect(pinVisible(1, null, 1000, 0)).toBe(false);
    expect(pinVisible(1, null, 1000, -24)).toBe(false);
  });
});
