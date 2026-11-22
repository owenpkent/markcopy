// Coverage for src/webview/gcodePlayback.ts: the playhead arithmetic behind the
// 3D viewer's G-code playback (nozzle position, layer mapping, travel window,
// speed stepping, the Space-key rule).
import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/webview/gcode';
import {
  SPEEDS,
  advance,
  clampHead,
  defaultSpeedIndex,
  headForLayer,
  layerAtHead,
  layerStart,
  lowerBound,
  nozzleAt,
  spaceTogglesPlayback,
  speedLabel,
  stepSpeed,
  travelRange,
  upperBound,
} from '../src/webview/gcodePlayback';

// Three layers of 10, 5 and 20 segments.
const layerEnd = Uint32Array.from([10, 15, 35]);

describe('speeds', () => {
  it('is ascending and labelled in moves per second', () => {
    expect([...SPEEDS]).toEqual([...SPEEDS].sort((a, b) => a - b));
    expect(speedLabel(30)).toBe('30 moves/s');
    expect(speedLabel(3000)).toBe('3k moves/s');
    expect(speedLabel(1_000_000)).toBe('1M moves/s');
  });

  it('picks the slowest speed that plays a print in a minute', () => {
    expect(defaultSpeedIndex(0)).toBe(0);
    expect(defaultSpeedIndex(1800)).toBe(0);
    expect(defaultSpeedIndex(1801)).toBe(1);
    expect(SPEEDS[defaultSpeedIndex(2_000_000)]).toBe(100_000);
    expect(defaultSpeedIndex(1e12)).toBe(SPEEDS.length - 1);
  });

  it('steps one place and stops at both ends', () => {
    expect(stepSpeed(3, 1)).toBe(4);
    expect(stepSpeed(3, -1)).toBe(2);
    expect(stepSpeed(0, -1)).toBe(0);
    expect(stepSpeed(SPEEDS.length - 1, 1)).toBe(SPEEDS.length - 1);
  });

  it('advances by seconds times speed and clamps to the print', () => {
    expect(advance(10, 0.5, 100, 1000)).toBe(60);
    expect(advance(990, 1, 100, 1000)).toBe(1000);
    expect(advance(5, -1, 100, 1000)).toBe(0);
    expect(clampHead(NaN, 10)).toBe(0);
    expect(clampHead(11, 10)).toBe(10);
  });
});

describe('layers', () => {
  it('maps a playhead to the layer of the segment being drawn', () => {
    expect(layerAtHead(layerEnd, 0)).toBe(1);
    expect(layerAtHead(layerEnd, 1)).toBe(1);
    expect(layerAtHead(layerEnd, 10)).toBe(1); // layer 1 just completed
    expect(layerAtHead(layerEnd, 10.5)).toBe(2); // inside the first segment of layer 2
    expect(layerAtHead(layerEnd, 15)).toBe(2);
    expect(layerAtHead(layerEnd, 16)).toBe(3);
    expect(layerAtHead(layerEnd, 35)).toBe(3);
    expect(layerAtHead(layerEnd, 99)).toBe(3);
    expect(layerAtHead(new Uint32Array(0), 4)).toBe(1);
  });

  it('puts a layer pick at the end of that layer, which maps back to the same layer', () => {
    for (let layer = 1; layer <= 3; layer++) {
      expect(layerAtHead(layerEnd, headForLayer(layerEnd, layer))).toBe(layer);
    }
    expect(headForLayer(layerEnd, 2)).toBe(15);
    expect(headForLayer(layerEnd, 0)).toBe(10);
    expect(headForLayer(layerEnd, 9)).toBe(35);
  });

  it('finds where a layer starts', () => {
    expect(layerStart(layerEnd, 1)).toBe(0);
    expect(layerStart(layerEnd, 2)).toBe(10);
    expect(layerStart(layerEnd, 3)).toBe(15);
  });
});

describe('nozzleAt', () => {
  // Two segments: (0,0,0) to (10,0,0), then (10,0,0) to (10,20,4).
  const positions = Float32Array.from([0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 20, 4]);
  const at = (head: number) => {
    const out = { x: -1, y: -1, z: -1 };
    nozzleAt(positions, 2, head, out);
    return [out.x, out.y, out.z];
  };

  it('starts at the first segment and ends at the last', () => {
    expect(at(0)).toEqual([0, 0, 0]);
    expect(at(2)).toEqual([10, 20, 4]);
    expect(at(50)).toEqual([10, 20, 4]);
    expect(at(-3)).toEqual([0, 0, 0]);
  });

  it('moves along the segment being drawn', () => {
    expect(at(0.5)).toEqual([5, 0, 0]);
    expect(at(1)).toEqual([10, 0, 0]);
    expect(at(1.25)).toEqual([10, 5, 1]);
  });

  it('sits at the end of the last segment drawn when the next starts elsewhere', () => {
    // A hop between the two: (0,0,0) to (1,0,0), then (5,5,0) to (6,5,0).
    const apart = Float32Array.from([0, 0, 0, 1, 0, 0, 5, 5, 0, 6, 5, 0]);
    const out = { x: 0, y: 0, z: 0 };
    nozzleAt(apart, 2, 1, out);
    expect([out.x, out.y]).toEqual([1, 0]);
    nozzleAt(apart, 2, 1.5, out);
    expect([out.x, out.y]).toEqual([5.5, 5]);
  });

  it('is at the origin with no segments', () => {
    const out = { x: 9, y: 9, z: 9 };
    nozzleAt(new Float32Array(0), 0, 3, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('travel window', () => {
  it('finds bounds in an ascending list', () => {
    const v = [0, 2, 2, 5, 9];
    expect(lowerBound(v, 5, 2)).toBe(1);
    expect(upperBound(v, 5, 2)).toBe(3);
    expect(lowerBound(v, 5, 10)).toBe(5);
    expect(upperBound(v, 5, -1)).toBe(0);
  });

  // Travel made just before segments 0, 3, 10, 11, 14, 15, 20 are drawn.
  const travelAt = Uint32Array.from([0, 3, 10, 11, 14, 15, 20]);
  const window = (head: number) => {
    const out = { first: -1, last: -1 };
    travelRange(travelAt, travelAt.length, layerEnd, head, out);
    return [out.first, out.last];
  };

  it('shows the playhead layer up to the nozzle', () => {
    expect(window(0)).toEqual([0, 1]); // the approach to the first segment
    expect(window(3.5)).toEqual([0, 2]);
    expect(window(10)).toEqual([0, 2]); // layer 1 complete: its two, not the hop to layer 2
    expect(window(10.5)).toEqual([2, 3]); // layer 2 begun: the hop at 10
    expect(window(12)).toEqual([2, 4]);
  });

  it('shows a finished layer whole and none from the layers after', () => {
    expect(window(15)).toEqual([2, 5]);
    expect(window(35)).toEqual([5, 7]);
    expect(window(19)).toEqual([5, 6]);
  });

  it('agrees with the nozzle: a hop appears only once the nozzle has left', () => {
    const tp = parseGcode(['M83', 'G1 X10 E1', 'G0 X20', 'G1 X30 E1', ''].join('\n'));
    const at = (head: number) => {
      const o = { first: 0, last: 0 };
      travelRange(tp.travelAt, tp.travelMoves, tp.layerEnd, head, o);
      return o.last - o.first;
    };
    expect(tp.travelMoves).toBe(1);
    expect(at(1)).toBe(0);
    expect(at(1.5)).toBe(1);
  });

  it('is empty with no travel', () => {
    const out = { first: 5, last: 5 };
    travelRange(new Uint32Array(0), 0, layerEnd, 12, out);
    expect(out.last - out.first).toBe(0);
  });
});

describe('spaceTogglesPlayback', () => {
  it('toggles on the page, the canvas and a range slider', () => {
    expect(spaceTogglesPlayback(null)).toBe(true);
    expect(spaceTogglesPlayback({ tagName: 'BODY' })).toBe(true);
    expect(spaceTogglesPlayback({ tagName: 'CANVAS' })).toBe(true);
    expect(spaceTogglesPlayback({ tagName: 'INPUT', type: 'range' })).toBe(true);
  });

  it('leaves Space to anything that types or uses it', () => {
    for (const tagName of ['BUTTON', 'SELECT', 'TEXTAREA', 'A']) {
      expect(spaceTogglesPlayback({ tagName })).toBe(false);
    }
    expect(spaceTogglesPlayback({ tagName: 'INPUT', type: 'number' })).toBe(false);
    expect(spaceTogglesPlayback({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(spaceTogglesPlayback({ tagName: 'DIV', isContentEditable: true })).toBe(false);
  });
});
