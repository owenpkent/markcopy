// Ported from owenpkent/Marker web/public/js/timecode.js at bed7d13.
// Non-drop HH:MM:SS:FF, the same clock as okstudio_video.timecode.
// One deliberate difference from the JS source: seconds are rounded to a frame
// half to even, as Python's round() does, so an exact half frame (50 s at 29.97
// fps is frame 1498.5) labels the same as the kit and Marker desktop.

const EPS = 1e-6;

/** Python's round(): halves go to the even neighbour, not up. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) {
    return floor;
  }
  if (diff > 0.5) {
    return floor + 1;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Label a whole frame count at the nominal integer rate. */
export function framesToTimecode(frames: number, nominal: number): string {
  const f = Math.max(0, Math.round(frames));
  const rate = nominal || 30;
  const ff = f % rate;
  const total = Math.floor(f / rate);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(ff)}`;
}

/** Seconds to timecode: frame count at the real rate, labelled at the nominal integer rate. */
export function secondsToTimecode(seconds: number, fps: number): string {
  const nominal = roundHalfEven(fps) || 30;
  const frames = roundHalfEven(seconds * (fps > 0 ? fps : nominal));
  return framesToTimecode(frames, nominal);
}

/** The label for a playback position: floor(position / step), then that frame's timecode. */
export function positionTimecode(seconds: number, fps: number): string {
  const rate = fps > 0 ? fps : 30;
  const frame = Math.max(0, Math.floor(seconds * rate + EPS));
  return framesToTimecode(frame, Math.round(rate) || 30);
}
