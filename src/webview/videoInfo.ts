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

// The containers VS Code's player opens, measured: .mp4, .mov, .m4v and .3gp
// play, while .mkv, .webm, .avi, .flv, .mpg and .wmv fail at once with
// MEDIA_ERR_SRC_NOT_SUPPORTED even when they hold codecs that play inside an MP4.
const MP4_FAMILY = new Set(['mp4', 'mov', 'm4v', '3gp']);

/** The lowercase extension without its dot, or '' when the name has none. */
export function containerOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Whether the name's container is one VS Code's player cannot open at all.
 *
 * An unknown or missing extension counts as inside the family: the container
 * messages name the extension, and claiming "cannot open .xyz files" about a file
 * we know nothing about would be a guess dressed up as a measurement.
 */
export function outsideMp4Family(name: string): boolean {
  const ext = containerOf(name);
  return ext !== '' && !MP4_FAMILY.has(ext);
}

/**
 * What to tell the reader when the <video> element gives up on the file.
 *
 * The `.mov` case is the one worth spelling out. QuickTime is a container, not a
 * codec: VS Code's Chromium plays H.264 video inside it (though not AAC audio,
 * which is a separate, silent failure handled by the sound copy), but a `.mov`
 * straight off a camera or out of an editor is often ProRes, DNxHD, or HEVC,
 * none of which it can decode. "Error 4" would read as a broken extension; the real answer is
 * that the file needs the OS player, so say so and offer that door.
 */
export function describeMediaError(code: number | undefined, name: string): string {
  if ((code === 4 || code === undefined) && outsideMp4Family(name)) {
    return containerLimit(name);
  }
  switch (code) {
    case 1: // MEDIA_ERR_ABORTED
      return `Loading ${name} was cancelled.`;
    case 2: // MEDIA_ERR_NETWORK
      return `${name} could not be read from disk.`;
    case 3: // MEDIA_ERR_DECODE
      return `${name} is damaged, or uses a codec VS Code cannot decode. Try opening it in your default player.`;
    default:
      // MEDIA_ERR_SRC_NOT_SUPPORTED, and anything the element declines to name.
      return `VS Code cannot play ${name}. It plays H.264, VP9 and AV1 video; ProRes, DNxHD, and most HEVC files need your default player.`;
  }
}

/**
 * What a file that VS Code cannot decode is, when ffmpeg has told us.
 *
 * The generic message below has to hedge ("ProRes, DNxHD, and most HEVC"),
 * because without a prober all the viewer knows is that the element gave up. A
 * probe turns that into a fact about this file, which is both shorter and the
 * thing the reader would otherwise go and look up.
 */
export function describeCodec(name: string, codec: string): string {
  return codec ? `${name} is ${codec}, which VS Code cannot play.` : `VS Code cannot play ${name}.`;
}

/** Why a non-MP4 file never opened: the container, whatever the codec inside is. */
function containerLimit(name: string): string {
  return `VS Code's player opens only MP4 and QuickTime files, so ${name} needs your default player.`;
}

/**
 * The offer, when ffmpeg is there to make good on it.
 *
 * `remux` is the host's word that the picture will be copied, not re-encoded. It
 * only changes the wording for a container outside the MP4 family: there, an
 * H.264 file is not something VS Code "cannot play", its wrapper is.
 */
export function proxyOffer(name: string, codec: string, remux = false): string {
  if (remux && outsideMp4Family(name)) {
    return `VS Code's player cannot open .${containerOf(name)} files. MarkCopy can repackage ${name} as MP4 with ffmpeg in a few seconds, without re-encoding the picture or touching the original.`;
  }
  return `${describeCodec(name, codec)} MarkCopy can build a playable copy with ffmpeg, without touching the original.`;
}

/**
 * The dead end, when it is not.
 *
 * Names the way out that costs nothing (the OS player, one button away) before
 * the one that costs an install, so the reader who just wants to watch the clip
 * is not sent to a package manager first.
 */
export function proxyUnavailable(name: string): string {
  const install =
    'Install ffmpeg, or set markcopy.video.ffmpegPath, and MarkCopy will build a playable copy here instead.';
  if (outsideMp4Family(name)) {
    return `${containerLimit(name)} ${install}`;
  }
  return `VS Code cannot play ${name}. It plays H.264, VP9 and AV1 video; ProRes, DNxHD, and most HEVC files need your default player. ${install}`;
}

/** What went wrong, with ffmpeg's own words kept: they are terse and specific. */
export function proxyFailed(name: string, detail: string): string {
  const said = detail.trim();
  return said
    ? `ffmpeg could not build a playable copy of ${name}: ${said}`
    : `ffmpeg could not build a playable copy of ${name}.`;
}

/**
 * The progress line, which reports a percentage only when it can mean one.
 *
 * A container with no duration (a stream, a damaged index) still encodes fine,
 * and claiming a percentage against an unknown total would either stick at 0 or
 * run past 100. Elapsed output time is the honest readout there.
 */
export function proxyProgress(seconds: number, durationSec: number): string {
  return progressLine('Building a playable copy…', seconds, durationSec);
}

/** The same readout for the sound copy, which runs in the background. */
export function soundProgress(seconds: number, durationSec: number): string {
  return progressLine('Adding sound…', seconds, durationSec);
}

function progressLine(label: string, seconds: number, durationSec: number): string {
  if (durationSec > 0) {
    const pct = Math.min(100, Math.max(0, Math.round((seconds / durationSec) * 100)));
    return `${label} ${pct}%`;
  }
  return seconds > 0 ? `${label} ${formatDuration(seconds)} in` : label;
}

/**
 * The notice for a file whose picture plays but whose sound does not.
 *
 * Says "silent" outright, because from the reader's side that is the whole
 * symptom: the video plays, nothing is wrong on screen, and there is no error
 * to explain the quiet.
 */
export function soundOffer(name: string, codec: string): string {
  const what = codec ? `${codec} audio, which VS Code cannot play,` : 'audio VS Code cannot play,';
  return `${name} has ${what} so it is silent here. MarkCopy can build a copy with sound using ffmpeg, without touching the original.`;
}

/** A sound copy that failed. The video is still playing, just without sound. */
export function soundFailed(name: string, detail: string): string {
  const said = detail.trim();
  return said
    ? `ffmpeg could not build a copy of ${name} with sound: ${said}`
    : `ffmpeg could not build a copy of ${name} with sound.`;
}

/**
 * The dead end the reader chose, when `markcopy.video.transcode` is off.
 *
 * Separate from proxyUnavailable because pointing someone at an ffmpeg install
 * they may already have, to enable a thing they switched off on purpose, is
 * worse than saying nothing. The setting is named so the way back is findable.
 */
export function proxyDisabled(name: string): string {
  return `VS Code cannot play ${name}. Transcoding is off (markcopy.video.transcode), so this needs your default player.`;
}
