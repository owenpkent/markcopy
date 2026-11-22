// The arithmetic behind the 3D viewer's G-code playback: where the nozzle is,
// which layer a move belongs to, which travel moves to show, and how fast the
// playhead runs. Pure and allocation-free per call (results go into caller
// owned arrays), so it is unit-tested in tests/gcodePlayback.test.ts and cheap
// to run every frame on a file of millions of moves.
//
// The playhead is a count of extrusion segments drawn, as a float: `head` of
// 12.5 means 12 segments are drawn and the nozzle is halfway along the 13th.

/** Playback speeds, in extrusion moves per second. */
export const SPEEDS: readonly number[] = [
  30, 100, 300, 1000, 3000, 10_000, 30_000, 100_000, 300_000, 1_000_000,
];

/** The longest a whole print should take to play at the speed picked for it. */
const TARGET_SECONDS = 60;

/** A speed as a short label: 30/s, 3k/s, 1M/s. */
export function speedLabel(movesPerSecond: number): string {
  if (movesPerSecond >= 1_000_000) {
    return `${movesPerSecond / 1_000_000}M moves/s`;
  }
  if (movesPerSecond >= 1000) {
    return `${movesPerSecond / 1000}k moves/s`;
  }
  return `${movesPerSecond} moves/s`;
}

/** The slowest speed that plays `total` moves in a minute or less. */
export function defaultSpeedIndex(total: number): number {
  for (let i = 0; i < SPEEDS.length; i++) {
    if (total / SPEEDS[i] <= TARGET_SECONDS) {
      return i;
    }
  }
  return SPEEDS.length - 1;
}

/** One step along the speed list, clamped at both ends. */
export function stepSpeed(index: number, direction: number): number {
  const next = Math.round(index) + (direction < 0 ? -1 : 1);
  return Math.min(Math.max(next, 0), SPEEDS.length - 1);
}

/** The playhead after `seconds` at `speed` moves per second, clamped to [0, total]. */
export function advance(head: number, seconds: number, speed: number, total: number): number {
  const next = head + seconds * speed;
  if (!(next > 0)) {
    return 0;
  }
  return next > total ? total : next;
}

/** A playhead clamped to [0, total]; NaN is 0. */
export function clampHead(head: number, total: number): number {
  if (!(head > 0)) {
    return 0;
  }
  return head > total ? total : head;
}

/** The segments fully drawn at a playhead: the whole part of it. */
export function drawnSegments(head: number): number {
  return Math.floor(head);
}

/**
 * The 1-based layer the playhead is in: the layer of the last segment drawn
 * (or of the segment being drawn, once the head is inside one). `layerEnd` is
 * ascending, one past each layer's last segment. O(log layers).
 */
export function layerAtHead(layerEnd: ArrayLike<number>, head: number): number {
  const count = layerEnd.length;
  if (count === 0) {
    return 1;
  }
  // The segment the nozzle is on: head 0 is the first, head 12.0 is the end of
  // the 12th (index 11), head 12.5 is inside the 13th (index 12).
  const whole = Math.floor(head);
  const index = head > whole ? whole : whole - 1;
  if (index <= 0) {
    return 1;
  }
  // The first layer whose end is past `index`.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (layerEnd[mid] > index) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo + 1;
}

/** The segment index a 1-based layer starts at. */
export function layerStart(layerEnd: ArrayLike<number>, layer: number): number {
  return layer <= 1 ? 0 : layerEnd[Math.min(layer, layerEnd.length) - 2];
}

/** The playhead that shows a 1-based layer complete: the end of that layer. */
export function headForLayer(layerEnd: ArrayLike<number>, layer: number): number {
  if (layerEnd.length === 0) {
    return 0;
  }
  return layerEnd[Math.min(Math.max(Math.round(layer) || 1, 1), layerEnd.length) - 1];
}

/**
 * Write the nozzle position at a playhead into `out` (x, y, z): the start of
 * the segment the head is inside, moved along it by the fraction of it done.
 * On a whole number it is the end of the last segment drawn (not the start of
 * the next, which a travel move may have put elsewhere), so head 0 is the start
 * of the first segment and the end is the end of the last.
 */
export function nozzleAt(
  positions: ArrayLike<number>,
  segments: number,
  head: number,
  out: { x: number; y: number; z: number },
): void {
  if (segments <= 0) {
    out.x = out.y = out.z = 0;
    return;
  }
  let index = Math.floor(head);
  let t = head - index;
  if (index >= segments) {
    index = segments - 1;
    t = 1;
  } else if (index < 0) {
    index = 0;
    t = 0;
  }
  if (t === 0 && index > 0) {
    index--;
    t = 1;
  }
  const o = index * 6;
  out.x = positions[o] + (positions[o + 3] - positions[o]) * t;
  out.y = positions[o + 1] + (positions[o + 4] - positions[o + 1]) * t;
  out.z = positions[o + 2] + (positions[o + 5] - positions[o + 2]) * t;
}

/** The first index in the ascending `values[0..count)` whose value is >= `target`. */
export function lowerBound(values: ArrayLike<number>, count: number, target: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** The first index in the ascending `values[0..count)` whose value is > `target`. */
export function upperBound(values: ArrayLike<number>, count: number, target: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The travel moves to draw at a playhead, as `[first, last)` indices into the
 * travel list: those made in the playhead's layer, up to the nozzle. A move
 * made just before segment n is drawn has `travelAt` n; those before the
 * layer's first segment and from the next layer on are left out. When the layer
 * is complete (the head at its end) every travel move inside it shows.
 * O(log travel moves).
 */
export function travelRange(
  travelAt: ArrayLike<number>,
  travelMoves: number,
  layerEnd: ArrayLike<number>,
  head: number,
  out: { first: number; last: number },
): void {
  const layer = layerAtHead(layerEnd, head);
  const start = layerStart(layerEnd, layer);
  const end = layerEnd.length === 0 ? 0 : layerEnd[layer - 1];
  // Moves at `end` belong to the next layer's approach.
  const limit = Math.min(Math.floor(head), end - 1);
  out.first = lowerBound(travelAt, travelMoves, start);
  out.last = Math.max(out.first, upperBound(travelAt, travelMoves, limit));
}

/** The minimum an element must say about itself for the Space-key rule. */
export interface KeyTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/**
 * Whether a Space key press should toggle playback. Not while typing, and not
 * on a control that already uses Space itself (a button, a checkbox, a select);
 * a range slider does nothing with Space, so it counts as the viewer.
 */
export function spaceTogglesPlayback(target: KeyTarget | null): boolean {
  if (!target) {
    return true;
  }
  if (target.isContentEditable) {
    return false;
  }
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A') {
    return false;
  }
  if (tag === 'INPUT') {
    return (target.type ?? '').toLowerCase() === 'range';
  }
  return true;
}
