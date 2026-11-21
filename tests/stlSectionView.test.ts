// Coverage for the drawing side of src/webview/stlSection.ts, against a canvas
// that records what is asked of it. jsdom has no 2D context, so the other
// viewer tests never reach this code; here a stand-in context lets the grid and
// outline loops run, which is where a bad extent would hang them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSectionView } from '../src/webview/stlSection';

// Every drawing call is accepted and counted. A runaway loop shows up as the
// count passing a ceiling, at which point the stand-in throws to end the test
// instead of letting it spin.
function recordingContext(ceiling: number) {
  const calls: Record<string, number> = {};
  const context = new Proxy(
    {},
    {
      get(_target, key: string) {
        if (key === 'measureText') {
          return () => ({ width: 20 });
        }
        return () => {
          calls[key] = (calls[key] ?? 0) + 1;
          if (calls[key] > ceiling) {
            throw new Error(`${key} called more than ${ceiling} times`);
          }
        };
      },
      set: () => true,
    },
  );
  return { context, calls };
}

function sizedCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: width });
  Object.defineProperty(canvas, 'clientHeight', { value: height });
  return canvas;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('section view drawing', () => {
  it('rules a grid and strokes the outline for an ordinary section', () => {
    const { context, calls } = recordingContext(5000);
    const canvas = sizedCanvas(320, 480);
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as never);
    const view = createSectionView(canvas, document.createElement('div'));

    view.setData({
      outlines: [
        {
          label: 'a.stl',
          color: '#00f',
          segments: Float32Array.from([0, 0, 10, 0, 10, 0, 10, 10]),
        },
      ],
      u: [0, 10],
      v: [0, 10],
      uName: 'X',
      vName: 'Y',
    });

    // One stroke per grid line, plus one for the outline.
    expect(calls.stroke).toBeGreaterThan(10);
    expect(calls.stroke).toBeLessThan(200);
  });

  it('returns for a model far from its origin, where grid indices stop being exact', () => {
    // X near 1e16 with no X extent, Y from 0 to 1: the grid index of the left
    // edge is past the integers a double can count through, so a loop stepping
    // that index by one would never advance.
    const { context, calls } = recordingContext(5000);
    const canvas = sizedCanvas(320, 480);
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as never);
    const view = createSectionView(canvas, document.createElement('div'));
    const far = Math.fround(1e16);

    view.setData({
      outlines: [
        { label: 'far.stl', color: '#00f', segments: Float32Array.from([far, 0, far, 1]) },
      ],
      u: [far, far],
      v: [0, 1],
      uName: 'X',
      vName: 'Y',
    });

    expect(calls.stroke ?? 0).toBeLessThan(200);
  });

  it('writes the measuring hint without a context to draw on', () => {
    const canvas = sizedCanvas(320, 480);
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    const readout = document.createElement('div');
    const view = createSectionView(canvas, readout);
    view.setData({ outlines: [], u: [0, 1], v: [0, 1], uName: 'X', vName: 'Y' });
    expect(readout.textContent).toMatch(/Point at the section/);
  });
});
