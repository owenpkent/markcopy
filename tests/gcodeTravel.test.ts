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
