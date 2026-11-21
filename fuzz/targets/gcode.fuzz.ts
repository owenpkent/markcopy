import { formatDuration, parseGcode, readSliceInfo } from '../../src/webview/gcode';

// Neither reader throws on purpose: parseGcode skips what it cannot read and
// readSliceInfo returns what it had before the XML went wrong. The output is
// checked for the promises the viewer leans on when it sizes buffers and draw
// ranges from it, so a miscount is a finding and not a silent overdraw.
export function fuzz(data: Buffer): void {
  const text = data.toString('latin1');
  const path = parseGcode(text, { maxSegments: 100_000 });
  if (path.positions.length !== path.segments * 6 || path.feature.length !== path.segments) {
    throw new Error('toolpath arrays do not match the segment count');
  }
  if (path.layerEnd.length !== path.layerZ.length) {
    throw new Error('layerEnd and layerZ differ in length');
  }
  let last = 0;
  for (const end of path.layerEnd) {
    if (end < last || end > path.segments) {
      throw new Error('layerEnd is not ascending within the segment count');
    }
    last = end;
  }
  for (const index of path.feature) {
    if (index >= path.features.length) {
      throw new Error('a segment names a feature that is not listed');
    }
  }

  const info = readSliceInfo(text);
  if (info.printSeconds !== undefined) {
    formatDuration(info.printSeconds);
  }
}
