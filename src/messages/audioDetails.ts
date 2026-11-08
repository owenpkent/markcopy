// Types and constants shared by the audio host (src/audioProbe.ts) and webview
// (src/webview/audioInfo.ts). No imports, so the webview bundle stays small.

/** The tags the details panel shows, in display order. Every value is plain text. */
export const AUDIO_TAG_KEYS = [
  'title',
  'artist',
  'album',
  'albumArtist',
  'date',
  'track',
  'genre',
  'comment',
] as const;
export type AudioTagKey = (typeof AUDIO_TAG_KEYS)[number];

/**
 * What ffprobe knows about an audio file, shaped by the host (src/audioProbe.ts)
 * and sent in the `details` message. Every field is optional: a missing one means
 * ffprobe did not report it, and the panel omits the row.
 */
export interface AudioDetails {
  format?: string;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  layout?: string;
  bitDepth?: number;
  bitRate?: number;
  duration?: number;
  tags?: Partial<Record<AudioTagKey, string>>;
}

/** Host to webview: the probe result. Never sent when ffprobe is missing or fails. */
export interface AudioDetailsMessage {
  type: 'details';
  details: AudioDetails;
}
