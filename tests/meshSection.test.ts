// Unit tests for src/webview/meshSection.ts, the cross-section maths behind the
// STL and 3MF section tool.
//
// Covered: slicing boxes on all three axes (outline length and endpoints), planes
// that touch a face or lie outside, a hollow tube and a tapered pocket read with
// straight lines through the section, the half-open rule at vertices (always an
// even number of crossings), NaN and empty input, spans, bounds, grid spacing,
// the print bed setting, and the exact clipboard report text.

import { describe, expect, it } from 'vitest';
import {
  bounds,
  fitsBed,
  fmt,
  formatSectionReport,
  gridStep,
  lineCrossings,
  parseBedSize,
  planeAxes,
  sectionSegments,
  spans,
  unionBounds,
  type Axis,
} from '../src/webview/meshSection';

type Vec3 = [number, number, number];

// Two triangles for the quad a, b, c, d (in order around the quad).
function quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

// The 12-triangle soup of an axis-aligned box.
function box(min: Vec3, max: Vec3): Float32Array {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const p = (x: number, y: number, z: number): Vec3 => [x, y, z];
  return new Float32Array([
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)),
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
    ...quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)),
    ...quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)),
  ]);
}

// A square frustum centred on the Z axis: half-width h0 at z0 and h1 at z1.
// Used as a tapered pocket. Its side faces are planar trapezoids.
function frustum(z0: number, h0: number, z1: number, h1: number): Float32Array {
  const lo = (sx: number, sy: number): Vec3 => [sx * h0, sy * h0, z0];
  const hi = (sx: number, sy: number): Vec3 => [sx * h1, sy * h1, z1];
  return new Float32Array([
    ...quad(lo(-1, -1), lo(1, -1), lo(1, 1), lo(-1, 1)),
    ...quad(hi(-1, -1), hi(1, -1), hi(1, 1), hi(-1, 1)),
    ...quad(lo(-1, -1), lo(1, -1), hi(1, -1), hi(-1, -1)),
    ...quad(lo(-1, 1), lo(1, 1), hi(1, 1), hi(-1, 1)),
    ...quad(lo(-1, -1), lo(-1, 1), hi(-1, 1), hi(-1, -1)),
    ...quad(lo(1, -1), lo(1, 1), hi(1, 1), hi(1, -1)),
  ]);
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// A hollow square tube: a 20 x 20 x 20 outer box with a 12 x 12 hole that runs
// right through it (the inner box pokes out of both ends).
function tube(): Float32Array {
  return concat(box([-10, -10, 0], [10, 10, 20]), box([-6, -6, -1], [6, 6, 21]));
}

function totalLength(segs: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < segs.length; i += 4) {
    sum += Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]);
  }
  return sum;
}

// Whether (u, v) lies on the border of the rectangle [u0, u1] x [v0, v1].
function onBorder(u: number, v: number, u0: number, u1: number, v0: number, v1: number): boolean {
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-5;
  const inU = u >= u0 - 1e-5 && u <= u1 + 1e-5;
  const inV = v >= v0 - 1e-5 && v <= v1 + 1e-5;
  return inU && inV && (close(u, u0) || close(u, u1) || close(v, v0) || close(v, v1));
}

function expectRectangleOutline(
  segs: Float32Array,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
): void {
  expect(segs.length % 4).toBe(0);
  expect(totalLength(segs)).toBeCloseTo(2 * (u1 - u0) + 2 * (v1 - v0), 4);
  for (let i = 0; i < segs.length; i += 4) {
    expect(onBorder(segs[i], segs[i + 1], u0, u1, v0, v1)).toBe(true);
    expect(onBorder(segs[i + 2], segs[i + 3], u0, u1, v0, v1)).toBe(true);
    // Each piece runs along one edge, never across the middle.
    const alongU = Math.abs(segs[i + 1] - segs[i + 3]) < 1e-5;
    const alongV = Math.abs(segs[i] - segs[i + 2]) < 1e-5;
    expect(alongU || alongV).toBe(true);
  }
}

describe('planeAxes', () => {
  it('gives the drawing axes for each cut', () => {
    expect(planeAxes(2)).toEqual([0, 1]);
    expect(planeAxes(1)).toEqual([0, 2]);
    expect(planeAxes(0)).toEqual([1, 2]);
  });
});

describe('sectionSegments on a box', () => {
  const b = box([0, 0, 0], [10, 6, 4]);

  it('cuts Z through the middle into the XY rectangle', () => {
    expectRectangleOutline(sectionSegments(b, 2, 2), 0, 10, 0, 6);
  });

  it('cuts Y through the middle into the XZ rectangle', () => {
    expectRectangleOutline(sectionSegments(b, 1, 3), 0, 10, 0, 4);
  });

  it('cuts X through the middle into the YZ rectangle', () => {
    expectRectangleOutline(sectionSegments(b, 0, 5), 0, 6, 0, 4);
  });

  it('gives nothing when the plane is outside the box', () => {
    expect(sectionSegments(b, 2, -1)).toHaveLength(0);
    expect(sectionSegments(b, 2, 5)).toHaveLength(0);
    expect(sectionSegments(b, 0, 11)).toHaveLength(0);
  });

  it('gives nothing at the minimum face, because on the plane counts as above', () => {
    // Every corner has z >= 0, so no triangle has a corner below the plane. The
    // bottom face lies in the plane and is not emitted either.
    expect(sectionSegments(b, 2, 0)).toHaveLength(0);
  });

  it('gives the whole closed top outline at the maximum face', () => {
    // At z = 4 the bottom corners are below and the top corners are not, so each
    // side quad contributes its top edge (one triangle) and a zero-length piece
    // (the other triangle). The outline is complete, not partial, and the top
    // face itself adds nothing.
    const segs = sectionSegments(b, 2, 4);
    expect(totalLength(segs)).toBeCloseTo(32, 4);
    expectRectangleOutline(segs, 0, 10, 0, 6);
  });

  it('sizes the result exactly, four floats per straddling triangle', () => {
    const segs = sectionSegments(b, 2, 2);
    // Only the 8 side triangles straddle z = 2.
    expect(segs).toHaveLength(8 * 4);
  });
});

describe('lineCrossings on a hollow tube', () => {
  const segs = sectionSegments(tube(), 2, 10);

  it('reads wall, pocket, wall along a horizontal line through the centre', () => {
    const crossings = lineCrossings(segs, 'v', 0);
    expect(crossings).toHaveLength(4);
    [-10, -6, 6, 10].forEach((x, i) => expect(crossings[i]).toBeCloseTo(x, 4));
    const s = spans(crossings);
    expect(s.map((x) => x.solid)).toEqual([true, false, true]);
    expect(s[0].length).toBeCloseTo(4, 4);
    expect(s[1].length).toBeCloseTo(12, 4);
    expect(s[2].length).toBeCloseTo(4, 4);
  });

  it('reads the same along a vertical line through the centre', () => {
    const crossings = lineCrossings(segs, 'u', 0);
    expect(crossings).toHaveLength(4);
    [-10, -6, 6, 10].forEach((y, i) => expect(crossings[i]).toBeCloseTo(y, 4));
  });

  it('counts an even number of crossings when the line passes through vertices', () => {
    for (const y of [-10, -6, 0, 6, 10]) {
      expect(lineCrossings(segs, 'v', y).length % 2).toBe(0);
    }
    for (const x of [-10, -6, 0, 6, 10]) {
      expect(lineCrossings(segs, 'u', x).length % 2).toBe(0);
    }
  });

  it('applies the half-open rule at outline corners', () => {
    // A line along the top edge touches the two vertical walls at their ends,
    // so each counts once. A line along the bottom edge counts them zero times,
    // because both ends are on the same side. Both stay even.
    expect(lineCrossings(segs, 'v', 10)).toHaveLength(2);
    expect(lineCrossings(segs, 'v', -10)).toHaveLength(0);
    const atInner = lineCrossings(segs, 'v', 6);
    expect(atInner).toHaveLength(4);
    expect(lineCrossings(segs, 'v', -6)).toHaveLength(2);
    expect(atInner[0]).toBeCloseTo(-10, 4);
  });

  it('returns nothing for a non-finite line value', () => {
    expect(lineCrossings(segs, 'v', NaN)).toEqual([]);
  });
});

describe('a tapered pocket', () => {
  it('reads different pocket widths at two heights', () => {
    // The pocket is 8 wide at the bottom (z = 0) and 16 wide at the top
    // (z = 20), so at z = 5 it is 10 wide and at z = 15 it is 14 wide. A bounding
    // box would miss this, which is why the section tool exists.
    const mesh = concat(box([-10, -10, 0], [10, 10, 20]), frustum(-0.0, 4, 20, 8));
    const low = lineCrossings(sectionSegments(mesh, 2, 5), 'v', 0);
    const high = lineCrossings(sectionSegments(mesh, 2, 15), 'v', 0);
    expect(low).toHaveLength(4);
    expect(high).toHaveLength(4);
    expect(spans(low)[1].length).toBeCloseTo(10, 3);
    expect(spans(high)[1].length).toBeCloseTo(14, 3);
  });
});

describe('bad input', () => {
  it('skips triangles with non-finite coordinates', () => {
    const good = box([0, 0, 0], [10, 6, 4]);
    const bad = new Float32Array([0, 0, NaN, 1, 0, 5, 0, 1, -5, Infinity, 0, -1, 1, 0, 5, 0, 1, 5]);
    const segs = sectionSegments(concat(good, bad), 2, 2);
    expect(segs).toHaveLength(8 * 4);
    expectRectangleOutline(segs, 0, 10, 0, 6);
  });

  it('gives nothing for a non-finite value', () => {
    const b = box([0, 0, 0], [1, 1, 1]);
    expect(sectionSegments(b, 2, NaN)).toHaveLength(0);
    expect(sectionSegments(b, 2, Infinity)).toHaveLength(0);
  });

  it('copes with empty and truncated input', () => {
    expect(sectionSegments(new Float32Array(0), 2, 0)).toHaveLength(0);
    expect(sectionSegments(new Float32Array(5), 2, 0)).toHaveLength(0);
    expect(lineCrossings(new Float32Array(0), 'v', 0)).toEqual([]);
    expect(lineCrossings(new Float32Array([0, 0, 1]), 'v', 0)).toEqual([]);
    expect(spans([])).toEqual([]);
    expect(spans([3])).toEqual([]);
  });

  it('skips segments with non-finite numbers', () => {
    const segs = new Float32Array([NaN, -1, 1, 1, 0, -1, 0, 1]);
    expect(lineCrossings(segs, 'v', 0)).toEqual([0]);
  });
});

describe('spans', () => {
  it('alternates material and gaps and drops an odd trailing crossing', () => {
    expect(spans([0, 2, 5, 9, 12])).toEqual([
      { from: 0, to: 2, length: 2, solid: true },
      { from: 2, to: 5, length: 3, solid: false },
      { from: 5, to: 9, length: 4, solid: true },
      { from: 9, to: 12, length: 3, solid: false },
    ]);
    expect(spans([0, 2, 5])).toHaveLength(2);
  });
});

describe('bounds and unionBounds', () => {
  it('measures a soup and skips non-finite coordinates', () => {
    const b = bounds(
      concat(box([-1, -2, -3], [4, 5, 6]), new Float32Array([NaN, 99, Infinity, 0, 0, 0, 0, 0, 0])),
    );
    expect(b).toEqual({ min: [-1, -2, -3], max: [4, 99, 6] });
  });

  it('gives zeros for empty and all-NaN soups', () => {
    const zero = { min: [0, 0, 0], max: [0, 0, 0] };
    expect(bounds(new Float32Array(0))).toEqual(zero);
    expect(bounds(new Float32Array(9).fill(NaN))).toEqual(zero);
  });

  it('joins two boxes', () => {
    const a = { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
    const c = { min: [-2, 0.5, 0] as Vec3, max: [0.5, 3, 4] as Vec3 };
    expect(unionBounds(a, c)).toEqual({ min: [-2, 0, 0], max: [1, 3, 4] });
  });
});

describe('gridStep', () => {
  it('picks the smallest 1 or 5 times a power of ten that fits in 50 lines', () => {
    expect(gridStep(40)).toBe(1);
    expect(gridStep(150)).toBe(5);
    expect(gridStep(300)).toBe(10);
    expect(gridStep(2)).toBeCloseTo(0.05, 10);
    expect(gridStep(10, 10)).toBe(1);
    expect(gridStep(100, 10)).toBe(10);
  });

  it('falls back to 1 for extents that mean nothing', () => {
    expect(gridStep(0)).toBe(1);
    expect(gridStep(-5)).toBe(1);
    expect(gridStep(NaN)).toBe(1);
    expect(gridStep(Infinity)).toBe(1);
  });
});

describe('parseBedSize', () => {
  it('accepts the common spellings', () => {
    expect(parseBedSize('256x256x256')).toEqual([256, 256, 256]);
    expect(parseBedSize('256 x 256')).toEqual([256, 256, Infinity]);
    expect(parseBedSize('256×256×256')).toEqual([256, 256, 256]);
    expect(parseBedSize('180,180,180')).toEqual([180, 180, 180]);
    expect(parseBedSize(' 220.5 X 220 x 250 ')).toEqual([220.5, 220, 250]);
  });

  it('rejects anything else', () => {
    for (const text of [
      '',
      'abc',
      '256',
      '1x2x3x4',
      '0x10x10',
      '-5x10',
      '10xx10',
      '1e3x5',
      'NaNx5',
      '10x',
    ]) {
      expect(parseBedSize(text)).toBeNull();
    }
  });
});

describe('fitsBed', () => {
  const bed: Vec3 = [250, 210, 200];

  it('fits a small part', () => {
    expect(fitsBed([100, 100, 100], bed)).toBe(true);
  });

  it('turns the part a quarter turn about Z when that helps', () => {
    expect(fitsBed([240, 200, 10], bed)).toBe(true);
    expect(fitsBed([205, 245, 10], bed)).toBe(true);
    expect(fitsBed([260, 100, 10], bed)).toBe(false);
  });

  it('checks the height on its own', () => {
    expect(fitsBed([10, 10, 201], bed)).toBe(false);
    expect(fitsBed([10, 10, 200], bed)).toBe(true);
    expect(fitsBed([10, 10, 1e6], [250, 210, Infinity])).toBe(true);
  });

  it('never fits a part with non-finite size', () => {
    expect(fitsBed([NaN, 1, 1], bed)).toBe(false);
  });
});

describe('fmt', () => {
  it('uses two decimals and never prints negative zero', () => {
    expect(fmt(12)).toBe('12.00');
    expect(fmt(-8.854)).toBe('-8.85');
    expect(fmt(-0)).toBe('0.00');
    expect(fmt(-0.001)).toBe('0.00');
  });
});

describe('formatSectionReport', () => {
  it('lays out a Z cut with a unit like stl_check.py', () => {
    const text = formatSectionReport('part.stl', 2, 12, 'mm', [
      { fixed: 'v', value: 0, crossings: [-8.85, -6.35, 6.35, 8.85] },
      { fixed: 'u', value: 0, crossings: [] },
    ]);
    expect(text).toBe(
      [
        'part.stl, Z = 12.00 mm',
        'Y = 0.00: -8.85 -6.35 6.35 8.85 (spans 2.50 | 12.70 | 2.50)',
        'X = 0.00: no crossings',
      ].join('\n'),
    );
  });

  it('names lines after the plane axes and leaves the unit out when there is none', () => {
    const axis: Axis = 0;
    const text = formatSectionReport('a.stl', axis, -0.001, '', [
      { fixed: 'u', value: 2, crossings: [1, 3.5] },
      { fixed: 'v', value: 1, crossings: [0.5] },
    ]);
    // Cutting X draws [Y, Z], so a fixed u line is Y and a fixed v line is Z. A
    // lone crossing has no span to report.
    expect(text).toBe(
      ['a.stl, X = 0.00', 'Y = 2.00: 1.00 3.50 (spans 2.50)', 'Z = 1.00: 0.50'].join('\n'),
    );
  });
});
