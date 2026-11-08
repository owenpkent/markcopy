// Pure helpers for the audio preview (src/webview/audio.ts), kept apart so the
// tests can drive them without a DOM.
import { AUDIO_TAG_KEYS, type AudioDetails, type AudioTagKey } from '../messages/audioDetails';
import { formatBytes, formatDuration } from './videoInfo';

/** Playback rates the speed button and the J and L keys walk, slowest first. */
export const AUDIO_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Seek distances: the arrow keys and the Back and Forward buttons, and Shift plus an arrow. */
export const SEEK_STEP = 5;
export const SEEK_STEP_LONG = 30;

/** The speed `direction` rungs from `rate` on the ladder, stopping at either end. */
export function stepSpeed(rate: number, direction: 1 | -1): number {
  // Start from the rung nearest the current rate, so an off-ladder rate still steps sensibly.
  let nearest = 0;
  for (let i = 1; i < AUDIO_SPEEDS.length; i++) {
    if (Math.abs(AUDIO_SPEEDS[i] - rate) < Math.abs(AUDIO_SPEEDS[nearest] - rate)) {
      nearest = i;
    }
  }
  const next = Math.min(AUDIO_SPEEDS.length - 1, Math.max(0, nearest + direction));
  return AUDIO_SPEEDS[next];
}

/** The speed button's next rate: one rung up, back to the slowest after the fastest. */
export function cycleSpeed(rate: number): number {
  const up = stepSpeed(rate, 1);
  return up === rate ? AUDIO_SPEEDS[0] : up;
}

/** `time` moved by `delta` seconds, kept inside the file. An unknown duration only floors at zero. */
export function seekTarget(time: number, delta: number, duration: number): number {
  const target = Math.max(0, time + delta);
  return Number.isFinite(duration) && duration > 0 ? Math.min(duration, target) : target;
}

/** The position readout: `m:ss / m:ss`, or `h:mm:ss` once either side reaches an hour. */
export function positionReadout(time: number, duration: number): string {
  return `${formatDuration(time)} / ${formatDuration(duration)}`;
}

/** The file's extension in upper case, without the dot; empty when it has none. */
export function formatOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
}

/** The info line under the file name: format, size and duration, whichever are known. */
export function infoLine(name: string, bytes: number, duration: number): string {
  const parts = [formatOf(name), formatBytes(bytes)];
  if (Number.isFinite(duration) && duration > 0) {
    parts.push(formatDuration(duration));
  }
  return parts.filter(Boolean).join(' · ');
}

/**
 * What to tell the reader when the <audio> element gives up on the file. It names
 * the extension and says VS Code cannot decode it. M4A and AAC get the likely
 * reason, since VS Code's Chromium ships without an AAC decoder.
 */
export function describeAudioError(name: string): string {
  const ext = formatOf(name).toLowerCase();
  const label = ext ? `.${ext}` : 'this';
  const why =
    ext === 'm4a' || ext === 'aac'
      ? ' These files usually hold AAC, which VS Code cannot decode.'
      : ' The file may be damaged, or use a codec VS Code cannot decode.';
  return `VS Code cannot play ${name}: it cannot decode ${label} audio.${why} Try opening it in your default player.`;
}

// ---------------------------------------------------------------------------
// Waveform and levels
// ---------------------------------------------------------------------------

/** Files above this many bytes are not decoded for a waveform: the decoded PCM is ~10x the file. */
export const WAVEFORM_SIZE_CAP = 150 * 1024 * 1024;

/**
 * Decoded-memory budget for the waveform: decodeAudioData materialises 32-bit float
 * PCM, so the encoded size says little (a 2 h stereo MP3 of 86 MB decodes to ~2.5 GB).
 * 1 GiB is 48000 Hz x 2 channels x 4 bytes = 384000 bytes/s, about 46 min of 48 kHz stereo.
 */
export const WAVEFORM_DECODE_BUDGET = 1024 * 1024 * 1024;

/**
 * Estimated bytes decodeAudioData will hold: duration x sample rate x channels x 4.
 * The context may resample up, so the rate is never taken below 48 kHz; channels are
 * ffprobe's when known, else 2. NaN when the duration is not finite.
 */
export function decodedBytes(duration: number, sampleRate?: number, channels?: number): number {
  if (!Number.isFinite(duration) || duration < 0) {
    return NaN;
  }
  const rate = Math.max(48000, sampleRate && sampleRate > 0 ? sampleRate : 0);
  const ch = channels && channels > 0 ? channels : 2;
  return duration * rate * ch * 4;
}

/** Spoken length for the skip line: "1 h 58 min", "46 min", "40 s". */
function spokenDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) {
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  return m > 0 ? `${m} min` : `${total} s`;
}

/** The one line shown when the decoded size would pass the budget, or the length is unknown. */
export function waveformTooLong(duration: number): string {
  return Number.isFinite(duration)
    ? `Waveform skipped: ${spokenDuration(duration)} is too long to decode here.`
    : 'Waveform skipped: the length of this file is not known.';
}

/** Peaks kept per channel. The canvas folds them down to its pixel width at draw time. */
export const PEAK_BUCKETS = 2000;

/** A sample at or beyond this magnitude counts as clipped. */
export const CLIP_THRESHOLD = 0.999;

/** Samples processed between yields to the event loop, so a long file does not freeze the page. */
const CHUNK_SAMPLES = 1 << 21;

/** The one line shown instead of a waveform for a file over the cap. */
export function waveformSkipped(bytes: number): string {
  return `Waveform skipped: ${formatBytes(bytes)} is over the ${formatBytes(WAVEFORM_SIZE_CAP)} limit for decoding.`;
}

export interface AudioAnalysis {
  /** Per channel, `[min0, max0, min1, max1, ...]` for each bucket, in -1..1. */
  peaks: Float32Array[];
  buckets: number;
  /** Largest |sample| over all channels, 0..1 (can exceed 1 for float files). */
  peak: number;
  /** Root mean square over all samples of all channels. */
  rms: number;
  /** Samples with |x| >= CLIP_THRESHOLD, all channels. */
  clipped: number;
  /** Samples per channel. */
  length: number;
}

/**
 * Min and max per bucket for every channel, plus whole-file levels, in one pass.
 * Yields through `yieldFn` after each ~2M samples (default: a macrotask) so a
 * long decode does not block the page.
 */
export async function analyzeChannels(
  channels: ArrayLike<number>[],
  buckets: number = PEAK_BUCKETS,
  yieldFn: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<AudioAnalysis> {
  const length = channels.length > 0 ? channels[0].length : 0;
  const count = Math.max(1, Math.min(buckets, length));
  const peaks = channels.map(() => new Float32Array(count * 2));
  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  let sinceYield = 0;
  for (let c = 0; c < channels.length; c++) {
    const data = channels[c];
    const out = peaks[c];
    for (let b = 0; b < count; b++) {
      const from = Math.floor((b * length) / count);
      const to = Math.floor(((b + 1) * length) / count);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i < to; i++) {
        const x = data[i];
        if (x < lo) {
          lo = x;
        }
        if (x > hi) {
          hi = x;
        }
        const a = x < 0 ? -x : x;
        if (a > peak) {
          peak = a;
        }
        if (a >= CLIP_THRESHOLD) {
          clipped++;
        }
        sumSquares += x * x;
      }
      out[b * 2] = lo === Infinity ? 0 : lo;
      out[b * 2 + 1] = hi === -Infinity ? 0 : hi;
      sinceYield += to - from;
      if (sinceYield >= CHUNK_SAMPLES) {
        sinceYield = 0;
        await yieldFn();
      }
    }
  }
  const total = length * channels.length;
  return {
    peaks,
    buckets: count,
    peak,
    rms: total > 0 ? Math.sqrt(sumSquares / total) : 0,
    clipped,
    length,
  };
}

/** A linear level in dBFS, or -Infinity for silence. */
export function toDb(level: number): number {
  return level > 0 ? 20 * Math.log10(level) : -Infinity;
}

/** A level as shown: `-3.0 dBFS`, or `silent` when there is nothing there. */
export function formatLevel(level: number): string {
  const db = toDb(level);
  return Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : 'silent';
}

/** The clipped-sample row: `none`, or the count with its share of all samples. */
export function formatClipping(clipped: number, length: number, channels: number): string {
  if (clipped <= 0) {
    return 'none';
  }
  const total = length * channels;
  const ratio = total > 0 ? clipped / total : 0;
  const share = total > 0 ? ` (${(ratio * 100).toFixed(ratio < 0.0001 ? 4 : 2)}%)` : '';
  return `${clipped.toLocaleString('en-US')} ${clipped === 1 ? 'sample' : 'samples'}${share}`;
}

/** `h:mm:ss.mmm`, the precise duration the details panel shows. */
export function formatPreciseDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

/** `44.1 kHz`, `48 kHz`. */
export function formatSampleRate(hz: number): string {
  return `${Number((hz / 1000).toFixed(3))} kHz`;
}

/** `320 kbps`. */
export function formatBitRate(bps: number): string {
  return `${Math.round(bps / 1000)} kbps`;
}

/** The channel row: `2 (stereo)`, `1 (mono)`, or just the count. */
export function formatChannels(channels: number, layout?: string): string {
  return layout ? `${channels} (${layout})` : String(channels);
}

/** The time under a pointer at `x` pixels into a bar `width` wide, clamped to the file. */
export function timeAtX(x: number, width: number, duration: number): number {
  if (!(width > 0) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, x / width)) * duration;
}

const TAG_LABELS: Record<AudioTagKey, string> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Album artist',
  date: 'Date',
  track: 'Track',
  genre: 'Genre',
  comment: 'Comment',
};

/** What the browser itself found out by decoding, used for rows ffprobe did not supply. */
export interface DecodedFacts {
  duration?: number;
  channels?: number;
  sampleRate?: number;
  peak?: number;
  rms?: number;
  clipped?: number;
  length?: number;
}

export type DetailRow = [label: string, value: string];

/**
 * The panel's rows in display order. ffprobe's facts win; the decode fills in
 * duration, channels and sample rate when ffprobe gave none. A row with no value
 * is left out, never shown as a dash.
 */
export function detailRows(
  fileName: string,
  fileBytes: number,
  probe: AudioDetails | undefined,
  decoded: DecodedFacts | undefined,
): DetailRow[] {
  const rows: DetailRow[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value) {
      rows.push([label, value]);
    }
  };
  const channels = probe?.channels ?? decoded?.channels;
  const sampleRate = probe?.sampleRate ?? decoded?.sampleRate;
  const duration = probe?.duration ?? decoded?.duration;
  add('Format', probe?.format ?? (formatOf(fileName) || undefined));
  add('Codec', probe?.codec);
  add('Sample rate', sampleRate ? formatSampleRate(sampleRate) : undefined);
  add('Channels', channels ? formatChannels(channels, probe?.layout) : undefined);
  add('Bit depth', probe?.bitDepth ? `${probe.bitDepth}-bit` : undefined);
  add('Bitrate', probe?.bitRate ? formatBitRate(probe.bitRate) : undefined);
  add('Duration', duration ? formatPreciseDuration(duration) : undefined);
  add('File size', fileBytes > 0 ? formatBytes(fileBytes) : undefined);
  if (decoded?.peak !== undefined && decoded.rms !== undefined) {
    add('Peak', formatLevel(decoded.peak));
    add('RMS', formatLevel(decoded.rms));
    add(
      'Clipping',
      formatClipping(decoded.clipped ?? 0, decoded.length ?? 0, decoded.channels ?? channels ?? 1),
    );
  }
  return rows;
}

/** The tag rows, in display order. */
export function tagRows(probe: AudioDetails | undefined): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const key of AUDIO_TAG_KEYS) {
    const value = probe?.tags?.[key];
    if (value) {
      rows.push([TAG_LABELS[key], value]);
    }
  }
  return rows;
}

/** The panel as Markdown for the clipboard: a heading, then `- **Label:** value` lines. */
export function detailsMarkdown(fileName: string, rows: DetailRow[], tags: DetailRow[]): string {
  const oneLine = (value: string): string => value.replace(/\s*\n\s*/g, ' ');
  const lines = [`## ${fileName}`, ''];
  for (const [label, value] of rows) {
    lines.push(`- **${label}:** ${oneLine(value)}`);
  }
  if (tags.length > 0) {
    lines.push('', '### Tags', '');
    for (const [label, value] of tags) {
      lines.push(`- **${label}:** ${oneLine(value)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function positiveNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function shortText(raw: unknown, max: number): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw.slice(0, max) : undefined;
}

/**
 * Check a `details` message from the host before the page renders it. Anything of
 * the wrong type is dropped, strings are capped, and an unusable message is
 * `undefined`. The result is rendered with textContent only.
 */
export function parseDetails(raw: unknown): AudioDetails | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const details: AudioDetails = {};
  const format = shortText(r.format, 80);
  const codec = shortText(r.codec, 80);
  const layout = shortText(r.layout, 32);
  if (format) {
    details.format = format;
  }
  if (codec) {
    details.codec = codec;
  }
  if (layout) {
    details.layout = layout;
  }
  const sampleRate = positiveNumber(r.sampleRate);
  const channels = positiveNumber(r.channels);
  const bitDepth = positiveNumber(r.bitDepth);
  const bitRate = positiveNumber(r.bitRate);
  const duration = positiveNumber(r.duration);
  if (sampleRate) {
    details.sampleRate = sampleRate;
  }
  if (channels) {
    details.channels = Math.round(channels);
  }
  if (bitDepth) {
    details.bitDepth = bitDepth;
  }
  if (bitRate) {
    details.bitRate = bitRate;
  }
  if (duration) {
    details.duration = duration;
  }
  if (typeof r.tags === 'object' && r.tags !== null && !Array.isArray(r.tags)) {
    const tags: Partial<Record<AudioTagKey, string>> = {};
    for (const key of AUDIO_TAG_KEYS) {
      const value = shortText((r.tags as Record<string, unknown>)[key], 1000);
      if (value) {
        tags[key] = value;
      }
    }
    if (Object.keys(tags).length > 0) {
      details.tags = tags;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}
