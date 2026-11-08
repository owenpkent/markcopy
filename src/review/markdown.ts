// A port of Review.export_markdown in owenpkent/okstudio-video-kit
// (okstudio_video/review.py, PR #4 on feat/image-region, plus `media: audio` from feat/audio-media), minus transcript cues. The webview never
// builds markdown; the host does, so the clipboard text matches the file on disk.

import type { ReviewFile } from './schema';
import { secondsToClock, secondsToTimecode } from './timecode';

/** Python's `format(x, "g")` for the plain numbers a frame rate is: 6 significant digits. */
function formatG(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Python's `math.floor(v * 100 + 0.5)`: half up, not `round`. */
const percent = (v: number): number => Math.floor(v * 100 + 0.5);

/** One markdown section per note, led by a status line. Ends with one newline. */
export function reviewMarkdown(file: ReviewFile): string {
  const audio = file.media === 'audio';
  const video = file.media !== 'image';
  const fps = Number(file.fps) || 0;
  const asset = file.asset ?? {};
  const lines: string[] = [`# Review notes: ${file.source ?? ''}`, ''];
  const meta = [
    audio ? 'audio' : video ? `fps ${formatG(fps)}` : 'image',
    `status ${asset.status ?? 'none'}`,
  ];
  if (asset.rating) {
    meta.push(`rating ${asset.rating}/5`);
  }
  if (asset.keywords && asset.keywords.length > 0) {
    meta.push(`keywords ${asset.keywords.join(', ')}`);
  }
  lines.push(meta.join(', '), '');
  if (asset.notes) {
    lines.push(String(asset.notes), '');
  }
  for (const note of file.notes ?? []) {
    // Half up, not round(): the web export does the same sum in JS.
    const pin =
      note.point && note.point.length > 0
        ? `${percent(note.point[0])}% from left, ${percent(note.point[1])}% from top`
        : undefined;
    const area =
      note.region && note.region.length > 0
        ? `${percent(note.region[0])}%, ${percent(note.region[1])}%, ${percent(note.region[2])}% x ${percent(note.region[3])}%`
        : undefined;
    let tc: string;
    if (video) {
      const stamp = (t: number): string => (audio ? secondsToClock(t) : secondsToTimecode(t, fps));
      tc = stamp(Number(note.at));
      if (note.out !== undefined && note.out !== null) {
        tc += ` to ${stamp(Number(note.out))}`;
      }
    } else {
      tc = area ? `area ${area}` : pin ? `pin ${pin}` : 'whole image';
    }
    lines.push(`## ${note.id}  ${tc}  ${note.kind}`, '');
    if (note.target === 'render') {
      lines.push('Target: render (output time)', '');
    }
    if (note.author) {
      lines.push(`By ${note.author}`, '');
    }
    if (video) {
      if (pin) {
        lines.push(`Pin: ${pin}`, '');
      }
      if (area) {
        lines.push(`Area: ${area}`, '');
      }
    }
    if (note.text) {
      lines.push(note.text, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
