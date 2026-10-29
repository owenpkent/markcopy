import { describeLoop, parseGif, statusLine } from '../../src/webview/gifInfo';

// parseGif answers anything that is not a whole GIF with null (and a cut-off
// one with `truncated`) rather than throwing, so nothing is wrapped. A result is
// then read the way the preview's status line reads it.
export function fuzz(data: Buffer): void {
  const info = parseGif(data);
  if (!info) {
    return;
  }
  describeLoop(info.loopCount);
  statusLine({ name: 'fuzz.gif', bytes: data.byteLength, info, frame: 0 });
}
