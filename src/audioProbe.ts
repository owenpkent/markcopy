import { findFfmpeg, run } from './videoProxy';
import { AUDIO_TAG_KEYS, type AudioDetails, type AudioTagKey } from './messages/audioDetails';

// Host half of the audio details panel: one ffprobe run per opened file, shaped
// into the small, validated AudioDetails the webview renders. No vscode import, so
// the shaping is testable against a recorded ffprobe JSON sample.

/** How long ffprobe may take on one file before the panel goes without it. */
const PROBE_TIMEOUT_MS = 10_000;
/** Longest tag value kept; a comment can be a whole paragraph, an embedded blob is not wanted. */
const MAX_TAG_LENGTH = 1000;

/** ffprobe's arguments: only the fields the panel shows, plus every tag. */
export function audioProbeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_entries',
    'format=format_name,format_long_name,duration,bit_rate:format_tags:stream=codec_type,codec_name,codec_long_name,sample_rate,channels,channel_layout,bits_per_sample,bits_per_raw_sample,bit_rate,duration:stream_tags',
    '-i',
    input,
  ];
}

const FORMAT_LABELS: Record<string, string> = {
  mp3: 'MP3',
  wav: 'WAV',
  flac: 'FLAC',
  ogg: 'Ogg',
  aac: 'AAC (ADTS)',
  mov: 'MPEG-4 audio (M4A)',
  matroska: 'Matroska',
  aiff: 'AIFF',
};

const CODEC_LABELS: Record<string, string> = {
  mp3: 'MP3',
  aac: 'AAC',
  flac: 'FLAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  alac: 'ALAC',
};

// ffprobe lower-cases nothing: ID3 gives `title`, Vorbis gives `TITLE`, MP4 gives
// `album_artist`, some taggers write `ALBUMARTIST`. Keys are compared lower case.
const TAG_ALIASES: Record<AudioTagKey, string[]> = {
  title: ['title'],
  artist: ['artist'],
  album: ['album'],
  albumArtist: ['album_artist', 'albumartist'],
  date: ['date', 'year', 'originaldate'],
  track: ['track', 'tracknumber'],
  genre: ['genre'],
  comment: ['comment', 'description'],
};

function positive(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

/** A tag value as plain text: control characters dropped, whitespace trimmed, length capped. */
function cleanTag(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return undefined;
  }
  // Newlines are kept (a comment may have them); everything else below space goes.
  const text = [...String(raw)]
    .filter((c) => c === '\n' || c.charCodeAt(0) >= 32)
    .join('')
    .trim();
  return text === '' ? undefined : text.slice(0, MAX_TAG_LENGTH);
}

function shapeTags(...sources: unknown[]): AudioDetails['tags'] {
  const lowered = new Map<string, unknown>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(record(source) ?? {})) {
      const k = key.toLowerCase();
      if (!lowered.has(k)) {
        lowered.set(k, value);
      }
    }
  }
  const tags: Partial<Record<AudioTagKey, string>> = {};
  for (const key of AUDIO_TAG_KEYS) {
    for (const alias of TAG_ALIASES[key]) {
      const value = cleanTag(lowered.get(alias));
      if (value !== undefined) {
        tags[key] = value;
        break;
      }
    }
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function layoutLabel(channels: number | undefined, layout: unknown): string | undefined {
  if (typeof layout === 'string' && /^[\w.()+-]{1,32}$/.test(layout)) {
    return layout;
  }
  if (channels === 1) {
    return 'mono';
  }
  return channels === 2 ? 'stereo' : undefined;
}

/**
 * ffprobe's JSON into AudioDetails. Tolerant: anything missing, mistyped or
 * unparseable is left out, and unparseable JSON gives `undefined`.
 */
export function shapeAudioProbe(json: string): AudioDetails | undefined {
  let root: Record<string, unknown> | undefined;
  try {
    root = record(JSON.parse(json));
  } catch {
    return undefined;
  }
  if (!root) {
    return undefined;
  }
  const format = record(root.format) ?? {};
  const streams = Array.isArray(root.streams) ? root.streams.map(record) : [];
  const stream = streams.find((s) => s?.codec_type === 'audio') ?? undefined;
  if (!stream && Object.keys(format).length === 0) {
    return undefined;
  }

  const details: AudioDetails = {};
  const formatName = typeof format.format_name === 'string' ? format.format_name : '';
  const firstName = formatName.split(',')[0];
  const formatLabel =
    FORMAT_LABELS[firstName] ??
    (typeof format.format_long_name === 'string' ? format.format_long_name : formatName);
  if (formatLabel) {
    details.format = formatLabel.slice(0, 80);
  }
  const codecName = typeof stream?.codec_name === 'string' ? stream.codec_name : '';
  const codecLabel =
    CODEC_LABELS[codecName] ??
    (typeof stream?.codec_long_name === 'string' ? stream.codec_long_name : codecName);
  if (codecLabel) {
    details.codec = codecLabel.slice(0, 80);
  }
  details.sampleRate = positive(stream?.sample_rate);
  const channels = positive(stream?.channels);
  details.channels = channels === undefined ? undefined : Math.round(channels);
  const layout = layoutLabel(details.channels, stream?.channel_layout);
  if (layout) {
    details.layout = layout;
  }
  // Lossy codecs report 0 (or nothing) here; the row is only for lossless depth.
  details.bitDepth = positive(stream?.bits_per_raw_sample) ?? positive(stream?.bits_per_sample);
  details.bitRate = positive(stream?.bit_rate) ?? positive(format.bit_rate);
  details.duration = positive(stream?.duration) ?? positive(format.duration);
  const tags = shapeTags(format.tags, stream?.tags);
  if (tags) {
    details.tags = tags;
  }
  for (const key of Object.keys(details) as Array<keyof AudioDetails>) {
    if (details[key] === undefined) {
      delete details[key];
    }
  }
  return details;
}

/**
 * Probe `file` with the ffprobe next to the configured or detected ffmpeg. Every
 * failure (no ffmpeg, a file ffprobe rejects, a timeout) is `undefined`: the panel
 * just goes without the rows, it is never an error.
 */
export async function probeAudio(
  file: string,
  configuredFfmpeg: string | undefined,
): Promise<AudioDetails | undefined> {
  const tools = await findFfmpeg(configuredFfmpeg).catch(() => undefined);
  if (!tools) {
    return undefined;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const { stdout } = await run(tools.ffprobe, audioProbeArgs(file), {
      signal: controller.signal,
    });
    return shapeAudioProbe(stdout);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
