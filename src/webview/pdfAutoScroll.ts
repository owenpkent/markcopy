// Auto-scroll for the PDF viewer: the speed steps, the per-frame arithmetic and
// the remembered settings. Ported from folio's auto-scroll (viewerStore.ts and
// autoScrollLayout.ts there). Free of the DOM so tests can drive it directly.

// Pixels per second. Skewed slow: the floor is a gentle reading crawl and even
// the top speed is a calm advance rather than a fling. The - and + buttons and
// the arrow keys step it geometrically, so the slow end, where fine control
// matters, gets the finer steps.
export const AUTO_SCROLL_MIN = 4;
export const AUTO_SCROLL_MAX = 160;
export const AUTO_SCROLL_DEFAULT = 12;

// One press of - or +.
export const SPEED_STEP = 1.3;
// Holding - or + steps once on the press, again after HOLD_DELAY_MS, then every
// HOLD_INTERVAL_MS. Slow on purpose: a press that takes a moment to release
// should not run away.
export const HOLD_DELAY_MS = 500;
export const HOLD_INTERVAL_MS = 200;

// A frame longer than this (a backgrounded tab, a stall) is treated as this
// long, so the page does not lurch when frames resume.
export const MAX_FRAME_SECONDS = 0.05;
// A scrollTop further than this from where the loop left it was moved by the
// reader (wheel, keys, a zoom, a jump): the loop adopts it instead of fighting.
export const ADOPT_THRESHOLD_PX = 2;
// Scroll positions within this of an end count as being at it.
const EDGE_PX = 0.5;

/** Keeps the direction and clamps the size; zero (or NaN) becomes slowest down. */
export function clampSpeed(speed: number): number {
  const size = Number.isFinite(speed)
    ? Math.min(AUTO_SCROLL_MAX, Math.max(AUTO_SCROLL_MIN, Math.round(Math.abs(speed))))
    : AUTO_SCROLL_MIN;
  return speed < 0 ? -size : size;
}

/**
 * The next speed after one step toward down (factor > 1) or toward up
 * (factor < 1). Speed is signed: negative scrolls up. Moving the way it already
 * goes is faster; against it is slower, and from the slowest speed it crosses
 * over to the slowest speed the other way.
 */
export function stepSpeed(speed: number, factor: number): number {
  const towardDown = factor > 1;
  const ratio = towardDown ? factor : 1 / factor;
  if (!Number.isFinite(ratio) || ratio <= 1) {
    return clampSpeed(speed);
  }
  const goingDown = speed > 0;
  if (goingDown === towardDown) {
    return clampSpeed(speed * ratio);
  }
  if (Math.abs(speed) <= AUTO_SCROLL_MIN) {
    return towardDown ? AUTO_SCROLL_MIN : -AUTO_SCROLL_MIN;
  }
  return clampSpeed(speed / ratio);
}

/** Flip the direction, keeping the pace. */
export function reverseSpeed(speed: number): number {
  return clampSpeed(-speed);
}

/**
 * Whether a held press may take another step: not at a limit, and never across
 * zero (reversing always takes a fresh press).
 */
export function canHoldStep(speed: number, factor: number): boolean {
  const next = stepSpeed(speed, factor);
  return next !== speed && Math.sign(next) === Math.sign(speed);
}

/** "12 pixels per second, down", for announcements. */
export function describeSpeed(speed: number): string {
  return `${Math.abs(speed)} pixels per second, ${speed < 0 ? 'up' : 'down'}`;
}

/** What - and + will do from this speed, so each name says what the press does. */
export function speedLabels(speed: number): { minus: string; plus: string } {
  if (speed > 0) {
    return {
      minus: speed <= AUTO_SCROLL_MIN ? 'Reverse, scroll up' : 'Slower',
      plus: 'Faster',
    };
  }
  return {
    minus: 'Faster',
    plus: speed >= -AUTO_SCROLL_MIN ? 'Reverse, scroll down' : 'Slower',
  };
}

export type ScrollEdge = 'end' | 'top' | null;

/**
 * The speed to start at. With no room to go the current way (up from the top, or
 * down from the end) the first frame would switch straight off again, so start
 * the other way. With room both ways, or none at all, the direction is kept.
 */
export function startingSpeed(speed: number, scrollTop: number, maxTop: number): number {
  const s = clampSpeed(speed);
  if (maxTop <= EDGE_PX) {
    return s;
  }
  if ((s < 0 && scrollTop <= EDGE_PX) || (s > 0 && scrollTop >= maxTop - EDGE_PX)) {
    return -s;
  }
  return s;
}

export interface FrameInput {
  /** The position the loop owns between frames (a float). */
  pos: number;
  /** The container's real scrollTop right now. */
  scrollTop: number;
  speed: number;
  /** Seconds since the previous frame. */
  dt: number;
  /** scrollHeight - clientHeight. */
  maxTop: number;
}

export interface FrameResult {
  pos: number;
  /** Set when this frame reached an end, which switches auto-scroll off. */
  edge: ScrollEdge;
}

/**
 * One frame, with time-based motion so the pace is the same at 30, 60 or 144
 * Hz. A document that does not overflow idles (and stays armed in case a zoom
 * makes it scroll). A scrollTop the loop did not set is adopted first.
 */
export function advanceFrame(f: FrameInput): FrameResult {
  const dt = Math.min(Math.max(f.dt, 0), MAX_FRAME_SECONDS);
  let pos = f.pos;
  if (Math.abs(f.scrollTop - pos) > ADOPT_THRESHOLD_PX) {
    pos = f.scrollTop;
  }
  if (f.maxTop <= EDGE_PX || dt <= 0) {
    return { pos, edge: null };
  }
  pos = Math.min(f.maxTop, Math.max(0, pos + f.speed * dt));
  if (f.speed > 0 && pos >= f.maxTop - EDGE_PX) {
    return { pos, edge: 'end' };
  }
  if (f.speed < 0 && pos <= EDGE_PX) {
    return { pos, edge: 'top' };
  }
  return { pos, edge: null };
}

/** The size choices: a multiplier on the controls' normal dimensions. */
export const SIZES = [
  { label: 'Small', scale: 0.75 },
  { label: 'Medium', scale: 1 },
  { label: 'Large', scale: 1.5 },
  { label: 'Extra large', scale: 2 },
] as const;
export const DEFAULT_SIZE_INDEX = 1;

export interface AutoScrollSettings {
  speed: number;
  /** Index into SIZES. */
  size: number;
}

export const defaultSettings = (): AutoScrollSettings => ({
  speed: AUTO_SCROLL_DEFAULT,
  size: DEFAULT_SIZE_INDEX,
});

/** Settings from a stored value; anything missing or invalid falls back to the default. */
export function parseSettings(raw: unknown): AutoScrollSettings {
  const out = defaultSettings();
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  const { speed, size } = raw as Record<string, unknown>;
  if (typeof speed === 'number' && Number.isFinite(speed) && speed !== 0) {
    out.speed = clampSpeed(speed);
  }
  if (typeof size === 'number' && Number.isInteger(size) && size >= 0 && size < SIZES.length) {
    out.size = size;
  }
  return out;
}
