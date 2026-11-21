// Pure, dependency-free cross-section maths for the 3D model preview (STL and
// 3MF). It slices a triangle soup with a plane and reads where a straight line
// crosses the outline, so walls and pockets show up as numbers. This replaces a
// throwaway Python script that did the same on STL files.
//
// There is no DOM, Three.js or vscode dependency, which keeps it trivial to test.
// It runs in a webview on untrusted meshes, so every function here tolerates
// NaN, Infinity, empty and truncated input without throwing, and every
// allocation is bounded by the size of the input.

/** An axis of the model file: 0 = X, 1 = Y, 2 = Z. */
export type Axis = 0 | 1 | 2;
export const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/**
 * The two axes a cut along `axis` is drawn in, as [u, v] (u to the right, v up):
 * cutting Z gives [X, Y], cutting Y gives [X, Z], cutting X gives [Y, Z].
 */
export function planeAxes(axis: Axis): [Axis, Axis] {
  if (axis === 0) {
    return [1, 2];
  }
  if (axis === 1) {
    return [0, 2];
  }
  return [0, 1];
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Bounds of a triangle soup, skipping non-finite coordinates. An empty or
 * all-NaN soup gives all zeros so callers never have to handle Infinity.
 */
export function bounds(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  // Walk whole triangles only: a truncated tail is not a triangle.
  const used = Math.floor(positions.length / 9) * 9;
  for (let i = 0; i < used; i++) {
    const value = positions[i];
    if (!Number.isFinite(value)) {
      continue;
    }
    const axis = i % 3;
    if (value < min[axis]) {
      min[axis] = value;
    }
    if (value > max[axis]) {
      max[axis] = value;
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    if (min[axis] > max[axis]) {
      min[axis] = 0;
      max[axis] = 0;
    }
  }
  return { min, max };
}

/** The smallest box holding both. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

// The three edges of a triangle as corner index pairs.
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 0],
];

// Whether the triangle starting at `base` has corners on both sides of the
// plane and only finite coordinates. A corner is "below" when its coordinate is
// < value and "above" otherwise, so a corner exactly on the plane counts as
// above. Both passes of sectionSegments share this so they always agree on how
// many segments there are.
function straddles(positions: Float32Array, base: number, axis: Axis, value: number): boolean {
  for (let k = 0; k < 9; k++) {
    if (!Number.isFinite(positions[base + k])) {
      return false;
    }
  }
  const s0 = positions[base + axis] < value;
  const s1 = positions[base + 3 + axis] < value;
  const s2 = positions[base + 6 + axis] < value;
  return s0 !== s1 || s1 !== s2;
}

/**
 * Where the plane `axis = value` cuts the mesh: four floats per segment,
 * u1 v1 u2 v2, in planeAxes(axis) order.
 *
 * Every corner is classified as below (coordinate < value) or not. A triangle
 * with corners on both sides contributes exactly one segment, between the two
 * edges whose ends are on different sides. A triangle wholly on one side, or
 * lying in the plane, contributes none. Counting "on the plane" as above is
 * applied everywhere the same way, which is what keeps the outline of a closed
 * mesh closed when the plane passes exactly through vertices: no piece is
 * emitted twice and none is missing. That is why the height is not nudged off
 * round values.
 *
 * Triangles with a non-finite coordinate are skipped, and a non-finite `value`
 * gives an empty result. The buffer is sized exactly by a counting pass first,
 * so memory never exceeds 4 floats per input triangle.
 */
export function sectionSegments(positions: Float32Array, axis: Axis, value: number): Float32Array {
  if (!Number.isFinite(value)) {
    return new Float32Array(0);
  }
  const triangles = Math.floor(positions.length / 9);
  let count = 0;
  for (let t = 0; t < triangles; t++) {
    if (straddles(positions, t * 9, axis, value)) {
      count++;
    }
  }
  const out = new Float32Array(count * 4);
  if (count === 0) {
    return out;
  }
  const [ua, va] = planeAxes(axis);
  let o = 0;
  for (let t = 0; t < triangles; t++) {
    const base = t * 9;
    if (!straddles(positions, base, axis, value)) {
      continue;
    }
    for (const [i, j] of EDGES) {
      const ci = positions[base + i * 3 + axis];
      const cj = positions[base + j * 3 + axis];
      if (ci < value === cj < value) {
        continue;
      }
      // One end is below and the other is not, so cj - ci is never zero.
      const f = (value - ci) / (cj - ci);
      const ui = positions[base + i * 3 + ua];
      const vi = positions[base + i * 3 + va];
      out[o++] = ui + f * (positions[base + j * 3 + ua] - ui);
      out[o++] = vi + f * (positions[base + j * 3 + va] - vi);
    }
  }
  return out;
}

/**
 * Where a straight line across the section crosses the outline. `fixed: 'v'` is
 * a horizontal line at v = value and returns the u coordinates of the
 * crossings; `fixed: 'u'` is a vertical line at u = value and returns v
 * coordinates. Sorted ascending.
 *
 * The same half-open rule as sectionSegments applies: a segment crosses the
 * line when one end is < value and the other is >= value. A crossing at a
 * vertex shared by two segments is therefore counted once, and a closed outline
 * always yields an even number of crossings.
 */
export function lineCrossings(segments: Float32Array, fixed: 'u' | 'v', value: number): number[] {
  const out: number[] = [];
  if (!Number.isFinite(value)) {
    return out;
  }
  // Index of the coordinate held fixed, and of the one that is reported.
  const f = fixed === 'v' ? 1 : 0;
  const r = 1 - f;
  const count = Math.floor(segments.length / 4);
  for (let s = 0; s < count; s++) {
    const k = s * 4;
    const a = segments[k + f];
    const b = segments[k + 2 + f];
    const ra = segments[k + r];
    const rb = segments[k + 2 + r];
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      !Number.isFinite(ra) ||
      !Number.isFinite(rb)
    ) {
      continue;
    }
    if (a < value === b < value) {
      continue;
    }
    out.push(ra + ((value - a) / (b - a)) * (rb - ra));
  }
  out.sort((x, y) => x - y);
  return out;
}

export interface Span {
  from: number;
  to: number;
  length: number;
  /** Material (true) or a gap such as a pocket or slot (false). */
  solid: boolean;
}

/**
 * The stretches between consecutive crossings: the first is material, then they
 * alternate. An odd trailing crossing is dropped because it has no partner.
 */
export function spans(crossings: number[]): Span[] {
  const out: Span[] = [];
  for (let i = 0; i + 1 < crossings.length; i++) {
    const from = crossings[i];
    const to = crossings[i + 1];
    out.push({ from, to, length: to - from, solid: i % 2 === 0 });
  }
  return out;
}

/**
 * A grid spacing for an extent: the smallest of 1, 5, 10, 50, 100 ... (1 and 5
 * times powers of ten, also below 1: 0.5, 0.1, 0.05 ...) that needs at most
 * `maxLines` lines to cover `extent`. Non-finite or non-positive extent gives 1.
 */
export function gridStep(extent: number, maxLines = 50): number {
  if (!Number.isFinite(extent) || extent <= 0) {
    return 1;
  }
  const lines = Number.isFinite(maxLines) && maxLines >= 1 ? maxLines : 50;
  // Start a decade below the ideal step so the first candidate is always too
  // fine, then walk up. A few decades are enough; the bound keeps the loop
  // finite for subnormal or huge extents.
  const start = Math.floor(Math.log10(extent / lines)) - 1;
  for (let e = start; e < start + 8; e++) {
    const decade = Math.pow(10, e);
    for (const step of [decade, 5 * decade]) {
      if (extent / step <= lines) {
        return step;
      }
    }
  }
  return 1;
}

/**
 * Parse a print bed size setting: '256x256x256', '256 x 256', '256×256×256',
 * '180,180,180'. Two numbers leave the height unlimited (Infinity). Returns
 * null for anything else, and for non-positive or non-finite numbers.
 */
export function parseBedSize(text: string): [number, number, number] | null {
  if (typeof text !== 'string') {
    return null;
  }
  const parts = text.trim().split(/\s*[x×,]\s*/i);
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    // Plain decimals only: Number() would also accept '', '0x10' and '1e3'.
    if (!/^\d+(\.\d+)?$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isFinite(n) || n <= 0) {
      return null;
    }
    numbers.push(n);
  }
  return [numbers[0], numbers[1], numbers.length === 3 ? numbers[2] : Infinity];
}

// A part that is exactly bed-sized in a float32 mesh can read a hair over after
// rounding, and calling that "does not fit" would be noise.
const FIT_TOLERANCE = 1e-6;

/**
 * Whether a part of `size` (X, Y, Z) fits on a bed of `bed` (X, Y, Z), turned a
 * quarter turn about Z if that helps. The height is never traded for width.
 */
export function fitsBed(
  size: readonly [number, number, number],
  bed: readonly [number, number, number],
): boolean {
  if (!size.every(Number.isFinite)) {
    return false;
  }
  if (size[2] > bed[2] + FIT_TOLERANCE) {
    return false;
  }
  const straight = size[0] <= bed[0] + FIT_TOLERANCE && size[1] <= bed[1] + FIT_TOLERANCE;
  const turned = size[1] <= bed[0] + FIT_TOLERANCE && size[0] <= bed[1] + FIT_TOLERANCE;
  return straight || turned;
}

/** Number formatting for the readouts: two decimals, and never '-0.00'. */
export function fmt(value: number): string {
  const text = value.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

export interface SectionReportLine {
  fixed: 'u' | 'v';
  value: number;
  crossings: number[];
}

/**
 * The text Copy as > Section Measurements puts on the clipboard, in the layout
 * of the old stl_check.py script:
 *
 *   part.stl, Z = 12.00 mm
 *   Y = 0.00: -8.85 -6.35 6.35 8.85 (spans 2.50 | 12.70 | 2.50)
 *   X = 0.00: ...
 *
 * `unit` may be '' (STL has none) and then the header has no unit. A line with
 * no crossings reads 'Y = 0.00: no crossings'. Spans list every stretch between
 * consecutive crossings (material and gaps alike), separated by ' | '. A line
 * named `Y` is a horizontal line when cutting Z, so a `fixed: 'v'` line is named
 * after the v axis of the cut and a `fixed: 'u'` line after the u axis.
 */
export function formatSectionReport(
  name: string,
  axis: Axis,
  value: number,
  unit: string,
  lines: SectionReportLine[],
): string {
  const [uAxis, vAxis] = planeAxes(axis);
  const out = [`${name}, ${AXIS_NAMES[axis]} = ${fmt(value)}${unit ? ' ' + unit : ''}`];
  for (const line of lines) {
    const lineName = AXIS_NAMES[line.fixed === 'v' ? vAxis : uAxis];
    const head = `${lineName} = ${fmt(line.value)}:`;
    if (line.crossings.length === 0) {
      out.push(`${head} no crossings`);
      continue;
    }
    const lengths = spans(line.crossings).map((s) => fmt(s.length));
    const tail = lengths.length > 0 ? ` (spans ${lengths.join(' | ')})` : '';
    out.push(`${head} ${line.crossings.map(fmt).join(' ')}${tail}`);
  }
  return out.join('\n');
}
