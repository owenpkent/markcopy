import { ThreeMfError, read3mf } from '../../src/webview/threeMf';
import { parseGcode, readSliceInfo } from '../../src/webview/gcode';
import { bounds, lineCrossings, sectionSegments, spans } from '../../src/webview/meshSection';

// read3mf answers a package it will not draw with ThreeMfError and nothing
// else: a zip refusal, malformed model XML, a missing object, a component
// cycle and an instancing fan-out all arrive as that class. What comes back is
// then put through what the viewer does with it, since a model that parses is
// also input to the section tool, and a sliced file to the G-code reader.
//
// The triangle cap is far below the viewer's so that a file declaring a large
// build is refused here rather than spending the run allocating it.
export function fuzz(data: Buffer): void {
  let content;
  try {
    content = read3mf(data, { maxTriangles: 50_000 });
  } catch (err) {
    if (err instanceof ThreeMfError) {
      return;
    }
    throw err;
  }
  if (content.kind === 'sliced') {
    parseGcode(content.gcode, { maxSegments: 100_000 });
    if (content.sliceInfo !== undefined) {
      readSliceInfo(content.sliceInfo);
    }
    return;
  }
  const box = bounds(content.positions);
  for (const axis of [0, 1, 2] as const) {
    const middle = (box.min[axis] + box.max[axis]) / 2;
    const segments = sectionSegments(content.positions, axis, middle);
    spans(lineCrossings(segments, 'u', 0));
    spans(lineCrossings(segments, 'v', 0));
  }
}
