// Ported from owenpkent/Marker web/public/js/timeline.js at bed7d13.
// Pure timeline and seek maths. Positions are milliseconds, as in Marker; the
// player divides by 1000 for the video element.

export const DOT_HIT = 44; // the hit target behind every dot
export const DOT_GAP = 8; // space between neighbouring targets
const EPS = 1e-6; // absorbs float error when a position sits on a frame edge
const DEFAULT_FPS = 30;

/** A note as the scrubber lays it out. `at` is seconds, `startMs` where a press seeks. */
export interface DotRow {
  id: string;
  at: number;
  startMs: number;
  tc: string;
  done: boolean;
}

export interface DotMember {
  id: string;
  label: string;
  startMs: number;
  tc: string;
  done: boolean;
}

/** One stud: a single note, or a cluster of notes closer than one pitch. */
export interface Dot {
  id: string;
  ids: string[];
  members: DotMember[];
  count: number;
  label: string;
  labels: string[];
  /** Left edge of the stud's hit target, px. */
  x: number;
  startMs: number;
  tc: string;
  done: boolean;
}

export interface PendingBand {
  visible: boolean;
  hasOut: boolean;
  x: number;
  width: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const frameStepMs = (fps: number): number => 1000 / (fps > 0 ? fps : DEFAULT_FPS);

export const frameIndex = (positionMs: number, fps: number): number =>
  Math.max(0, Math.floor(positionMs / frameStepMs(fps) + EPS));

/** Start of the frame containing positionMs, in seconds (what a note stores). */
export const frameStartSeconds = (positionMs: number, fps: number): number =>
  (frameIndex(positionMs, fps) * frameStepMs(fps)) / 1000;

/** Aim half a frame into the frame so the decoder lands on it, not the one before. */
export function seekMsForFrame(frame: number, fps: number): number {
  const step = frameStepMs(fps);
  return frame * step + step / 2;
}

function lastFrame(duration: number, fps: number): number | null {
  if (!(duration > 0)) {
    return null;
  }
  const rate = fps > 0 ? fps : DEFAULT_FPS;
  return Math.max(0, Math.ceil(duration * rate - EPS) - 1);
}

/** Seek target one frame from positionMs, clamped to the first and last frame. */
export function stepTarget(
  positionMs: number,
  direction: number,
  fps: number,
  duration: number,
): number {
  let frame = frameIndex(positionMs, fps) + (direction >= 0 ? 1 : -1);
  const last = lastFrame(duration, fps);
  if (last !== null) {
    frame = Math.min(frame, last);
  }
  return seekMsForFrame(Math.max(0, frame), fps);
}

/** Seek target for any position: the half-frame nudge into the frame it falls in. */
export function seekTarget(positionMs: number, fps: number, duration: number): number {
  let frame = frameIndex(positionMs, fps);
  const last = lastFrame(duration, fps);
  if (last !== null) {
    frame = Math.min(frame, last);
  }
  return seekMsForFrame(frame, fps);
}

function noteNum(id: string): number {
  const digits = [...String(id)].filter((c) => c >= '0' && c <= '9').join('');
  return digits ? parseInt(digits, 10) : 0;
}

/**
 * One row of studs. `x` is the left edge of a stud's hit target; the slider
 * handle travels width - hit. Notes closer than one pitch (hit + gap) merge
 * into a cluster stud showing the count.
 */
export function layoutDots(
  rows: DotRow[],
  duration: number,
  width: number,
  hit: number = DOT_HIT,
  gap: number = DOT_GAP,
): Dot[] {
  const usable = Math.max(0, Number(width) - hit);
  const dur = Math.max(0.001, Number(duration));
  const pitch = hit + gap;
  const ordered = [...rows].sort(
    (a, b) => Number(a.at) - Number(b.at) || noteNum(a.id) - noteNum(b.id),
  );
  const groups: Array<Array<[DotRow, number]>> = [];
  for (const r of ordered) {
    const trueX = Math.min(usable, Math.max(0, (usable * Number(r.at)) / dur));
    const g = groups[groups.length - 1];
    if (g && trueX - g[g.length - 1][1] < pitch) {
      g.push([r, trueX]);
    } else {
      groups.push([[r, trueX]]);
    }
  }
  return groups.map((g) => {
    const [first, x] = g[0];
    const members: DotMember[] = g.map(([r]) => {
      const num = noteNum(r.id);
      return {
        id: r.id,
        label: num ? String(num) : String(r.id),
        startMs: r.startMs,
        tc: r.tc,
        done: r.done,
      };
    });
    const labels = members.map((m) => m.label);
    return {
      id: first.id,
      ids: members.map((m) => m.id),
      members,
      count: members.length,
      label: members.length === 1 ? labels[0] : String(members.length),
      labels,
      x,
      startMs: first.startMs,
      tc: first.tc,
      done: members.every((m) => m.done),
    };
  });
}

/** The note a press on a cluster goes to: the first, then each next, wrapping. */
export function cycleTarget(ids: string[], selected: string): string {
  if (!ids.length) {
    return '';
  }
  const i = ids.indexOf(selected);
  return i >= 0 ? ids[(i + 1) % ids.length] : ids[0];
}

/** [x, width] in px of a range band across a strip `width` px wide. */
export function bandGeometry(
  start: number,
  end: number,
  duration: number,
  width: number,
  hit: number = DOT_HIT,
): [number, number] {
  const usable = Math.max(0, Number(width) - hit);
  const dur = Math.max(0.001, Number(duration));
  const x = hit / 2 + (usable * Math.max(0, Number(start))) / dur;
  const w = Math.max(4, (usable * (Number(end) - Number(start))) / dur);
  return [x, w];
}

/** The pending In/Out span. Nothing before In; with In alone, a bracket only. */
export function pendingBand(
  pendingIn: number,
  pendingOut: number,
  duration: number,
  width: number,
  hit: number = DOT_HIT,
): PendingBand {
  if (pendingIn < 0) {
    return { visible: false, hasOut: false, x: 0, width: 0 };
  }
  if (pendingOut < 0 || pendingOut <= pendingIn) {
    const [x] = bandGeometry(pendingIn, pendingIn, duration, width, hit);
    return { visible: true, hasOut: false, x, width: 0 };
  }
  const [x, w] = bandGeometry(pendingIn, pendingOut, duration, width, hit);
  return { visible: true, hasOut: true, x, width: w };
}

/** Seconds for a pointer x inside the strip (inverse of the handle travel). */
export function timeFromX(
  x: number,
  width: number,
  duration: number,
  hit: number = DOT_HIT,
): number {
  const usable = Math.max(1, Number(width) - hit);
  const frac = Math.min(1, Math.max(0, (x - hit / 2) / usable));
  return frac * duration;
}

const round4 = (v: number): number => Math.floor(v * 10000 + 0.5) / 10000;

/** The largest rectangle with the video's aspect inside the box, centred (object-fit: contain). */
export function fitRect(boxW: number, boxH: number, videoW: number, videoH: number): Rect {
  const ok = [boxW, boxH, videoW, videoH].every((v) => Number.isFinite(v) && v > 0);
  if (!ok) {
    return { x: 0, y: 0, w: boxW, h: boxH };
  }
  const scale = Math.min(boxW / videoW, boxH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** A pixel in the box as [nx, ny] of the picture (0..1, 4 decimals), or null outside the rect. */
export function pointInRect(px: number, py: number, rect: Rect): [number, number] | null {
  if (!(rect.w > 0) || !(rect.h > 0)) {
    return null;
  }
  if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) {
    return null;
  }
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return [round4(clamp((px - rect.x) / rect.w)), round4(clamp((py - rect.y) / rect.h))];
}

/** Whether a note's pin shows at positionMs: from its In frame to its Out frame (or In alone). */
export function pinVisible(
  tIn: number,
  tOut: number | null | undefined,
  positionMs: number,
  fps: number,
): boolean {
  if (!(fps > 0)) {
    return false;
  }
  const frame = frameIndex(positionMs, fps);
  const first = Math.floor(tIn * fps + 0.5);
  const last = tOut == null ? first : Math.floor(tOut * fps + 0.5);
  return first <= frame && frame <= last;
}
