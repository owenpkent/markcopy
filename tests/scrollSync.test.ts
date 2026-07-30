import { describe, it, expect } from 'vitest';
import { lineForOffset, offsetForLine, sample, type Anchor } from '../src/webview/scrollSync';

// Three blocks: line 0 at the top, line 10 at 100px, line 30 at 500px.
const anchors: Anchor[] = [
  { line: 0, offset: 0 },
  { line: 10, offset: 100 },
  { line: 30, offset: 500 },
];

describe('offsetForLine', () => {
  it('lands exactly on an anchored line', () => {
    expect(offsetForLine(anchors, 0)).toBe(0);
    expect(offsetForLine(anchors, 10)).toBe(100);
    expect(offsetForLine(anchors, 30)).toBe(500);
  });

  it('interpolates between anchors', () => {
    // Half way from line 10 to line 30 is half way from 100px to 500px.
    expect(offsetForLine(anchors, 20)).toBe(300);
    expect(offsetForLine(anchors, 5)).toBe(50);
  });

  it('clamps outside the anchored range', () => {
    expect(offsetForLine(anchors, -5)).toBe(0);
    expect(offsetForLine(anchors, 999)).toBe(500);
  });

  it('has nothing to say about an empty document', () => {
    expect(offsetForLine([], 3)).toBeUndefined();
  });
});

describe('lineForOffset', () => {
  it('is the inverse of offsetForLine at the anchors', () => {
    for (const a of anchors) {
      expect(lineForOffset(anchors, a.offset)).toBe(a.line);
    }
  });

  it('interpolates between anchors', () => {
    expect(lineForOffset(anchors, 300)).toBe(20);
    expect(lineForOffset(anchors, 50)).toBe(5);
  });

  it('clamps outside the anchored range', () => {
    expect(lineForOffset(anchors, -40)).toBe(0);
    expect(lineForOffset(anchors, 10_000)).toBe(30);
  });

  it('round-trips a scroll position back to itself', () => {
    // What keeps the two surfaces from drifting apart as the sync bounces between
    // them: mapping an offset to a line and back must not move.
    for (const offset of [0, 25, 100, 250, 499, 500]) {
      const line = lineForOffset(anchors, offset);
      expect(line).toBeDefined();
      expect(offsetForLine(anchors, line as number)).toBeCloseTo(offset, 6);
    }
  });
});

describe('degenerate anchors', () => {
  it('survives two blocks reported on the same line', () => {
    const same: Anchor[] = [
      { line: 4, offset: 0 },
      { line: 4, offset: 80 },
      { line: 9, offset: 160 },
    ];
    expect(offsetForLine(same, 4)).toBe(0);
    expect(lineForOffset(same, 80)).toBe(4);
    expect(lineForOffset(same, 120)).toBeCloseTo(6.5, 6);
  });

  it('survives a single anchor', () => {
    const one: Anchor[] = [{ line: 7, offset: 40 }];
    expect(offsetForLine(one, 0)).toBe(40);
    expect(offsetForLine(one, 99)).toBe(40);
    expect(lineForOffset(one, 0)).toBe(7);
    expect(lineForOffset(one, 999)).toBe(7);
  });
});

describe('sample', () => {
  it('leaves a short list alone', () => {
    const list = [1, 2, 3];
    expect(sample(list, 10)).toBe(list);
  });

  it('thins a long list but keeps both ends', () => {
    const list = Array.from({ length: 5000 }, (_, i) => i);
    const out = sample(list, 600);
    expect(out.length).toBeLessThanOrEqual(601);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(4999);
    // Still ascending, which is what the interpolation relies on.
    expect(out.every((v, i) => i === 0 || v > out[i - 1])).toBe(true);
  });
});
