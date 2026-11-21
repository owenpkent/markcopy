// @vitest-environment node
//
// Coverage for src/stlSiblings.ts: which files count as models, and the order
// the Compare with menu lists them in.
import { describe, expect, it } from 'vitest';
import { isModelFile, rankSiblings } from '../src/stlSiblings';

describe('isModelFile', () => {
  it('takes STL and 3MF in any case and nothing else', () => {
    expect(isModelFile('part.stl')).toBe(true);
    expect(isModelFile('PART.STL')).toBe(true);
    expect(isModelFile('plate.gcode.3mf')).toBe(true);
    expect(isModelFile('part.blend')).toBe(false);
    expect(isModelFile('stl')).toBe(false);
  });
});

describe('rankSiblings', () => {
  it('puts the previous versions of the open model first, newest on top', () => {
    const labels = [
      'versions/bar_cap_v1.stl',
      'versions/bar_cap_v10.stl',
      'versions/bar_cap_v9.stl',
      'holder.stl',
      'bar_clip_v1_current.stl',
    ];
    expect(rankSiblings('bar_cap_v11_current.stl', labels)).toEqual([
      'versions/bar_cap_v10.stl',
      'versions/bar_cap_v9.stl',
      'versions/bar_cap_v1.stl',
      'bar_clip_v1_current.stl',
      'holder.stl',
    ]);
  });

  it('ranks the current file first when an old version is open', () => {
    const labels = ['bar_cap_v1.stl', '../bar_cap_v7_current.stl', '../pump_v1_current.stl'];
    expect(rankSiblings('bar_cap_v6.stl', labels)).toEqual([
      '../bar_cap_v7_current.stl',
      'bar_cap_v1.stl',
      '../pump_v1_current.stl',
    ]);
  });

  it('keeps to the limit', () => {
    const labels = Array.from({ length: 30 }, (_, i) => `part_v${i}.stl`);
    expect(rankSiblings('part_v30.stl', labels)).toHaveLength(12);
    expect(rankSiblings('part_v30.stl', labels, 3)).toEqual([
      'part_v29.stl',
      'part_v28.stl',
      'part_v27.stl',
    ]);
  });

  it('returns nothing for nothing', () => {
    expect(rankSiblings('part.stl', [])).toEqual([]);
  });
});
