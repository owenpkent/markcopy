// The arithmetic behind two-way scroll sync, kept free of the DOM so it can be
// tested directly.
//
// Both surfaces are described by the same thing: a list of anchors pairing a
// source line with the scroll offset of the block rendered from it. Everything
// between two anchors is interpolated, which is what makes the sync track a drag
// smoothly instead of snapping from one block to the next.

/** A rendered block: the source line it came from, and where it sits in the scroller. */
export interface Anchor {
  /** 0-based source line. */
  line: number;
  /** Distance from the top of the scrollable content, in CSS pixels. */
  offset: number;
}

/**
 * The scroll offset that brings `line` to the top of the viewport.
 *
 * Returns undefined only when there is nothing to align to (an empty document).
 */
export function offsetForLine(anchors: Anchor[], line: number): number | undefined {
  const i = indexBefore(anchors, line, (a) => a.line);
  if (i === undefined) {
    return undefined;
  }
  const a = anchors[i];
  const b = anchors[i + 1];
  if (!b) {
    return a.offset;
  }
  return a.offset + fraction(line, a.line, b.line) * (b.offset - a.offset);
}

/**
 * The source line showing at the top of the viewport for scroll offset `offset`.
 *
 * Fractional by design: the caller decides whether to floor it (the editor can
 * only be revealed to a whole line) or keep the precision.
 */
export function lineForOffset(anchors: Anchor[], offset: number): number | undefined {
  const i = indexBefore(anchors, offset, (a) => a.offset);
  if (i === undefined) {
    return undefined;
  }
  const a = anchors[i];
  const b = anchors[i + 1];
  if (!b) {
    return a.line;
  }
  return a.line + fraction(offset, a.offset, b.offset) * (b.line - a.line);
}

// The last anchor at or before `value`, or the first anchor when `value` precedes
// all of them. Anchors are non-decreasing in both keys (the caller guarantees it),
// so a binary search is exact.
function indexBefore(
  anchors: Anchor[],
  value: number,
  key: (a: Anchor) => number,
): number | undefined {
  if (anchors.length === 0) {
    return undefined;
  }
  if (value <= key(anchors[0])) {
    return 0;
  }
  if (value >= key(anchors[anchors.length - 1])) {
    return anchors.length - 1;
  }
  let lo = 0;
  let hi = anchors.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (key(anchors[mid]) <= value) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// How far `value` sits between `from` and `to`, as 0..1. A zero-width span (two
// blocks on the same line, or two lines at the same offset) yields 0 rather than
// a division by zero.
function fraction(value: number, from: number, to: number): number {
  const span = to - from;
  if (span <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (value - from) / span));
}

/**
 * Reduce `anchors` to at most `max` entries, keeping the first and last.
 *
 * A 5000-row CSV grid has 5000 candidate anchors, and measuring them all on every
 * scroll frame costs more than the sync is worth. Interpolating across a sampled
 * subset is visually identical.
 */
export function sample<T>(anchors: T[], max: number): T[] {
  if (anchors.length <= max || max < 2) {
    return anchors;
  }
  const stride = Math.ceil(anchors.length / max);
  const out: T[] = [];
  for (let i = 0; i < anchors.length; i += stride) {
    out.push(anchors[i]);
  }
  const last = anchors[anchors.length - 1];
  if (out[out.length - 1] !== last) {
    out.push(last);
  }
  return out;
}
