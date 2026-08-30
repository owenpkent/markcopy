// Pure helpers for the video preview, kept out of src/webview/video.ts so they
// can be unit-tested without a DOM or a real <video> element (same split as
// src/webview/stlInfo.ts).

/** Clock time for the readout: `1:23`, `12:03`, `1:02:03`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    // A stream with no duration reports Infinity, and a video that has not
    // loaded its metadata reports NaN. Both are "not known yet", not zero.
    return '--:--';
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** File size for the readout, in whichever unit keeps it to a few digits. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Bytes and kilobytes are whole numbers; above that a decimal earns its place.
  const rounded = unit >= 2 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

/**
 * A filename-safe stamp for a position in the video: `23.400s`, `1m23.400s`,
 * `1h02m03.000s`.
 *
 * Colons are illegal in a Windows filename, so the displayed timecode cannot be
 * reused here. Milliseconds are kept because grabbing two frames a few frames
 * apart is the normal case, and a stamp truncated to whole seconds would
 * collide and quietly overwrite the first one.
 */
export function timecodeSlug(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toFixed(3).padStart(6, '0');
  if (h > 0) {
    return `${h}h${String(m).padStart(2, '0')}m${s}s`;
  }
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

/** Default name for a grabbed frame: `clip.mov` at 83.4s -> `clip-1m23.400s.png`. */
export function frameFileName(videoName: string, seconds: number): string {
  const dot = videoName.lastIndexOf('.');
  const base = dot > 0 ? videoName.slice(0, dot) : videoName || 'frame';
  return `${base}-${timecodeSlug(seconds)}.png`;
}

/**
 * What to tell the reader when the <video> element gives up on the file.
 *
 * The `.mov` case is the one worth spelling out. QuickTime is a container, not a
 * codec: VS Code's Chromium plays H.264/AAC inside it, but a `.mov` straight off
 * a camera or out of an editor is often ProRes, DNxHD, or HEVC, none of which it
 * can decode. "Error 4" would read as a broken extension; the real answer is
 * that the file needs the OS player, so say so and offer that door.
 */
export function describeMediaError(code: number | undefined, name: string): string {
  switch (code) {
    case 1: // MEDIA_ERR_ABORTED
      return `Loading ${name} was cancelled.`;
    case 2: // MEDIA_ERR_NETWORK
      return `${name} could not be read from disk.`;
    case 3: // MEDIA_ERR_DECODE
      return `${name} is damaged, or uses a codec VS Code cannot decode. Try opening it in your default player.`;
    default:
      // MEDIA_ERR_SRC_NOT_SUPPORTED, and anything the element declines to name.
      return `VS Code cannot play ${name}. It supports H.264 (and AAC audio); ProRes, DNxHD, and most HEVC files need your default player.`;
  }
}
