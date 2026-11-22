// Coverage for the travel moves src/webview/gcode.ts keeps beside the extrusion
// for the viewer's playback: which moves count, how each is tagged with the
// segments drawn before it, what the first layer marker drops, and the cap.
import { describe, expect, it } from 'vitest';
import { parseGcode } from '../src/webview/gcode';
import type { Toolpath } from '../src/webview/gcode';

function lines(...rows: string[]): string {
  return rows.join('\n') + '\n';
}

const travelOf = (tp: Toolpath, n: number): number[] =>
  Array.from(tp.travel.subarray(n * 6, n * 6 + 6)).map((v) => Math.round(v * 1000) / 1000);

describe('travel moves', () => {
  it('keeps non-extruding moves, each tagged with the segments drawn before it', () => {
    const tp = parseGcode(
      lines('M83', 'G1 X10 Y0 Z0.2', 'G1 X20 Y0 E1', 'G1 X20 Y10', 'G1 X20 Y20 E1', 'G0 X0 Y0'),
    );
    expect(tp.segments).toBe(2);
    expect(tp.travelMoves).toBe(3);
    expect(Array.from(tp.travelAt)).toEqual([0, 1, 2]);
    expect(travelOf(tp, 0)).toEqual([0, 0, 0, 10, 0, 0.2]);
    expect(travelOf(tp, 1)).toEqual([20, 0, 0.2, 20, 10, 0.2]);
    expect(travelOf(tp, 2)).toEqual([20, 20, 0.2, 0, 0, 0.2]);
  });

  it('counts a retraction or a move to the same point as no travel', () => {
    const tp = parseGcode(lines('M83', 'G1 X5 Y5', 'G1 E-1', 'G1 X5 Y5', 'G1 X9 Y5 E1'));
    expect(tp.travelMoves).toBe(1);
  });

  it('drops the start-up moves with the purge line at the first layer marker', () => {
    const tp = parseGcode(
      lines('M83', 'G1 X50 Y50', 'G1 X60 Y50 E1', ';LAYER_CHANGE', 'G1 X1 Y1', 'G1 X2 Y1 E1'),
    );
    expect(tp.segments).toBe(1);
    expect(tp.travelMoves).toBe(1);
    expect(travelOf(tp, 0)).toEqual([60, 50, 0, 1, 1, 0]);
  });

  it('stops keeping travel at maxTravel without touching the extrusion', () => {
    const rows = ['M83'];
    for (let i = 1; i <= 10; i++) {
      rows.push(`G0 X${i} Y0`, `G1 X${i} Y1 E1`);
    }
    const tp = parseGcode(lines(...rows), { maxTravel: 4 });
    expect(tp.travelMoves).toBe(4);
    expect(tp.travel.length).toBe(24);
    expect(tp.segments).toBe(10);
  });
});

describe('travel arcs', () => {
  const chord = (tp: Toolpath, n: number) => Array.from(tp.travel.subarray(n * 6, n * 6 + 6));

  it('tessellates a spiral Z-hop, circling and rising', () => {
    const tp = parseGcode(lines('M83', 'G1 X10 E1', 'G17', 'G3 Z1 I1 J0 P1', 'G1 X11 E1'));
    expect(tp.travelMoves).toBeGreaterThan(8);
    const first = chord(tp, 0);
    const last = chord(tp, tp.travelMoves - 1);
    expect([first[0], first[1], first[2]].map((v) => Math.round(v * 1000) / 1000)).toEqual([
      10, 0, 0,
    ]);
    expect([last[3], last[4], last[5]].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 0, 1]);
    let maxX = -Infinity;
    for (let i = 0; i < tp.travelMoves; i++) {
      maxX = Math.max(maxX, chord(tp, i)[3]);
    }
    expect(maxX).toBeGreaterThan(11.5);
    expect(new Set(Array.from(tp.travelAt))).toEqual(new Set([1]));
  });

  it('draws a closed arc with no XYZ change as a full circle', () => {
    const tp = parseGcode(lines('M83', 'G1 X10 E1', 'G3 I1 J0', 'G1 X11 E1'));
    expect(tp.travelMoves).toBeGreaterThan(8);
    const first = chord(tp, 0);
    const last = chord(tp, tp.travelMoves - 1);
    expect(last[3]).toBeCloseTo(first[0], 3);
    expect(last[4]).toBeCloseTo(first[1], 3);
  });

  it('respects the travel cap when an arc would exceed it', () => {
    const tp = parseGcode(lines('M83', 'G1 X10 E1', 'G3 I50 J0', 'G1 X11 E1'), { maxTravel: 5 });
    expect(tp.travelMoves).toBe(5);
  });
});
