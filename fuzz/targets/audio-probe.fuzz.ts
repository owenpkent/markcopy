import { AUDIO_TAG_KEYS, type AudioDetails } from '../../src/messages/audioDetails';
import { shapeAudioProbe } from '../../src/audioProbe';

// The audio details panel shows what ffprobe reports about a file, every tag
// included, so the text of the tags is the file's. shapeAudioProbe turns
// ffprobe's JSON into the small AudioDetails the webview renders and answers
// junk with undefined, so nothing is wrapped. What it returns is checked for
// what the panel relies on: only the known fields and tag keys, strings that are
// plain text within their caps, and numbers that are finite and positive. The
// input is the JSON as it is; the seeds are real ffprobe output.
const STRING_CAP: Record<string, number> = { format: 80, codec: 80, layout: 32 };
const NUMBERS = ['sampleRate', 'channels', 'bitDepth', 'bitRate', 'duration'];
const TAG_CAP = 1000; // MAX_TAG_LENGTH in src/audioProbe.ts
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f]/;

export function checkDetails(details: AudioDetails): void {
  for (const [key, value] of Object.entries(details)) {
    if (key === 'tags') {
      for (const [tag, text] of Object.entries(value as Record<string, unknown>)) {
        if (!(AUDIO_TAG_KEYS as readonly string[]).includes(tag)) {
          throw new Error(`unknown tag key ${JSON.stringify(tag)}`);
        }
        if (
          typeof text !== 'string' ||
          text === '' ||
          text.length > TAG_CAP ||
          CONTROL.test(text)
        ) {
          throw new Error(`tag ${tag} is not plain text within its cap: ${JSON.stringify(text)}`);
        }
      }
    } else if (Object.hasOwn(STRING_CAP, key)) {
      if (typeof value !== 'string' || value === '' || value.length > STRING_CAP[key]) {
        throw new Error(`${key} is not a short string: ${JSON.stringify(value)}`);
      }
    } else if (NUMBERS.includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${key} is not a finite positive number: ${String(value)}`);
      }
    } else {
      throw new Error(`unknown field ${JSON.stringify(key)}`);
    }
  }
}

export function fuzz(data: Buffer): void {
  const details = shapeAudioProbe(data.toString('utf8'));
  if (details !== undefined) {
    checkDetails(details);
  }
}
