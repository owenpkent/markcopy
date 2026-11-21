// @vitest-environment node
//
// Coverage for the arithmetic of src/webview/stlSection.ts: how the section is
// fitted into its canvas and what the crosshair reads off the outlines. The
// drawing itself needs a 2D canvas and is checked by hand (docs/TESTING.md).
import { describe, expect, it } from 'vitest';
import { fitExtent, measure, type SectionOutline } from '../src/webview/stlSection';

// A square outline from (lo, lo) to (hi, hi), as four segments running
// anticlockwise, which puts the outside on each segment's right: the outline of
// a solid, as sectionSegments directs it.
function square(lo: number, hi: number): number[] {
  return [lo, lo, hi, lo, hi, lo, hi, hi, hi, hi, lo, hi, lo, hi, lo, lo];
}

// The same square running clockwise: the wall of a hole.
function hole(lo: number, hi: number): number[] {
  return [lo, lo, lo, hi, lo, hi, hi, hi, hi, hi, hi, lo, hi, lo, lo, lo];
}

describe('fitExtent', () => {
  it('fits the limiting axis and centres the other, v pointing up', () => {
    // 20 x 10 into 300 x 300 with 50 to spare each side: 200 px for 20 units.
    const fit = fitExtent([0, 20], [0, 10], 300, 300, 50);
    expect(fit.scale).toBe(10);
    // u = 0 lands 50 px in; the middle of v (5) lands on the middle row.
    expect(fit.x0 + 0 * fit.scale).toBe(50);
    expect(fit.y0 - 5 * fit.scale).toBe(150);
    // v grows upward: v = 10 is above v = 0.
    expect(fit.y0 - 10 * fit.scale).toBeLessThan(fit.y0);
  });

  it('survives a flat extent and a canvas smaller than its padding', () => {
    const flat = fitExtent([5, 5], [0, 10], 300, 300, 50);
    expect(Number.isFinite(flat.scale)).toBe(true);
    expect(flat.scale).toBeGreaterThan(0);
    expect(fitExtent([0, 10], [0, 10], 20, 20, 50).scale).toBeGreaterThan(0);
  });
});

describe('measure', () => {
  // A 20 mm square tube with a 12 mm pocket: 4 mm walls.
  const tube: SectionOutline = {
    label: 'tube.stl',
    color: '#00f',
    segments: Float32Array.from([...square(-10, 10), ...hole(-6, 6)]),
  };

  it('reads wall, pocket, wall along both lines of the crosshair', () => {
    const [row] = measure([tube], 0, 0);
    expect(row.across.crossings).toEqual([-10, -6, 6, 10]);
    expect(row.across.spans.map((s) => [s.length, s.solid])).toEqual([
      [4, true],
      [12, false],
      [4, true],
    ]);
    expect(row.up.spans.map((s) => s.length)).toEqual([4, 12, 4]);
  });

  it('reads solid wall where the line misses the pocket', () => {
    const [row] = measure([tube], 0, 8);
    expect(row.across.spans.map((s) => [s.length, s.solid])).toEqual([[20, true]]);
  });

  it('reads nothing outside the outline', () => {
    const [row] = measure([tube], 0, 50);
    expect(row.across.spans).toEqual([]);
    expect(row.up.spans).toHaveLength(3);
  });

  it('reads two overlapping solids as one wall', () => {
    const overlap: SectionOutline = {
      label: 'assembly.3mf',
      color: '#00f',
      segments: Float32Array.from([...square(-10, 2), ...square(-2, 10)]),
    };
    const [row] = measure([overlap], 0, 0);
    expect(row.across.crossings).toEqual([-10, 10]);
    expect(row.across.spans.map((s) => [s.length, s.solid])).toEqual([[20, true]]);
  });

  it('gives a row per outline, in order, so two versions read side by side', () => {
    const wider: SectionOutline = {
      label: 'old.stl',
      color: '#f80',
      segments: Float32Array.from([...square(-10, 10), ...hole(-7, 7)]),
    };
    const rows = measure([tube, wider], 0, 0);
    expect(rows.map((r) => r.label)).toEqual(['tube.stl', 'old.stl']);
    expect(rows[1].across.spans.map((s) => s.length)).toEqual([3, 14, 3]);
  });
});
