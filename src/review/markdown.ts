// A port of Review.export_markdown in owenpkent/okstudio-video-kit
// (okstudio_video/review.py at 467ec02), minus transcript cues. The webview never
// builds markdown; the host does, so the clipboard text matches the file on disk.

import type { ReviewFile } from './schema';
import { secondsToTimecode } from './timecode';

/** Python's `format(x, "g")` for the plain numbers a frame rate is: 6 significant digits. */
function formatG(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Python's `math.floor(v * 100 + 0.5)`: half up, not `round`. */
const percent = (v: number): number => Math.floor(v * 100 + 0.5);

/** One markdown section per note, led by a status line. Ends with one newline. */
export function reviewMarkdown(file: ReviewFile): string {
  const fps = Number(file.fps) || 0;
  const asset = file.asset ?? {};
  const lines: string[] = [`# Review notes: ${file.source ?? ''}`, ''];
  const meta = [`fps ${formatG(fps)}`, `status ${asset.status ?? 'none'}`];
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
    let tc = secondsToTimecode(Number(note.at), fps);
    if (note.out !== undefined && note.out !== null) {
      tc += ` to ${secondsToTimecode(Number(note.out), fps)}`;
    }
    lines.push(`## ${note.id}  ${tc}  ${note.kind}`, '');
    if (note.target === 'render') {
      lines.push('Target: render (output time)', '');
    }
    if (note.author) {
      lines.push(`By ${note.author}`, '');
    }
    if (note.point && note.point.length > 0) {
      // Half up, not round(): the web export does the same sum in JS.
      lines.push(
        `Pin: ${percent(note.point[0])}% from left, ${percent(note.point[1])}% from top`,
        '',
      );
    }
    if (note.text) {
      lines.push(note.text, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
