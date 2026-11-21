// Coverage for src/webview/stl.ts, the STL and 3MF viewer: what it shows for a
// model, a sliced print and a refusal, and how the up axis, the grid, the print
// bed, the section and Compare with behave.
//
// jsdom has no WebGL, so the renderer and OrbitControls are replaced with
// stand-ins. Everything else is the real Three.js, so the placement, the grid
// and the section are computed as they are in the webview; what the frame
// looks like is checked by hand (see docs/TESTING.md).
//
// The DOM mirrors the ids written by src/stlEditor.ts's html().
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Three from 'three';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof Three>();
  class WebGLRenderer {
    domElement = document.createElement('canvas');
    localClippingEnabled = false;
    setPixelRatio(): void {}
    setSize(): void {}
    setClearColor(): void {}
    render(): void {}
  }
  return { ...actual, WebGLRenderer };
});
vi.mock('three/examples/jsm/controls/OrbitControls.js', async () => {
  const { Vector3 } = await vi.importActual<typeof Three>('three');
  class OrbitControls {
    target = new Vector3();
    update(): boolean {
      return false;
    }
  }
  return { OrbitControls };
});

const BODY = `
  <div id="viewport"></div>
  <div id="toolbar">
    <button id="btn-fit"></button>
    <button id="btn-wireframe"></button>
    <button id="btn-grid"></button>
    <button id="btn-section"></button>
  </div>
  <div id="stats"></div>
  <div id="layers" hidden>
    <button id="layer-down"></button>
    <input id="layer-range" type="range" min="1" max="1" step="1" value="1" />
    <button id="layer-up"></button>
    <span id="layer-label"></span>
    <input id="layer-only" type="checkbox" />
  </div>
  <div id="section" hidden>
    <button id="section-x"></button>
    <button id="section-y"></button>
    <button id="section-z"></button>
    <button id="section-down"></button>
    <input id="section-range" type="range" min="0" max="1" step="any" value="0" />
    <button id="section-up"></button>
    <input id="section-value" type="number" step="0.1" />
    <button id="section-close"></button>
    <canvas id="section-canvas"></canvas>
    <div id="section-readout"></div>
  </div>
  <div id="mc-menu" hidden></div>
  <div id="mc-toast" hidden></div>`;

let posted: Array<Record<string, unknown>> = [];
// The render loop's pending frame, run by hand: it is where a moved section is
// recomputed.
let frame: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = BODY;
  document.body.className = '';
  posted = [];
  frame = undefined;
  vi.stubGlobal('acquireVsCodeApi', () => ({
    postMessage: (msg: Record<string, unknown>) => posted.push(msg),
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frame = cb;
    return 0;
  });
  // jsdom has no 2D canvas either; the section's drawing is skipped without one.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stats = () => el('stats').textContent ?? '';

function send(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.origin }));
}

// A binary STL of an axis-aligned box, twelve outward-facing triangles.
function boxStl(min: number[], max: number[]): string {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  const out = Buffer.alloc(84 + faces.length * 50);
  out.writeUInt32LE(faces.length, 80);
  faces.forEach((face, i) => {
    // The normal is left zero; the viewer computes its own.
    face.forEach((index, corner) => {
      v[index].forEach((value, axis) => {
        out.writeFloatLE(value, 84 + i * 50 + 12 + corner * 12 + axis * 4);
      });
    });
  });
  return out.toString('base64');
}

function load(extra: Record<string, unknown>): void {
  send({
    type: 'load',
    format: 'stl',
    name: 'part.stl',
    path: '/models/part.stl',
    showGrid: true,
    meshColor: '#8ab4f8',
    upAxis: 'z',
    showBed: false,
    bedSize: '256x256x256',
    siblings: [],
    ...extra,
  });
}

const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="r" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

// A sliced print file: an empty build, the G-code of one plate and the slicer's
// summary. Two layers of a 10 mm path at the middle of the bed.
function slicedPrint(): string {
  const gcode = [
    'M83',
    '; CHANGE_LAYER',
    '; Z_HEIGHT: 0.2',
    'G1 Z0.2',
    'G1 X100 Y100',
    '; FEATURE: Outer wall',
    'G1 X110 Y100 E1',
    'G1 X110 Y110 E1',
    '; CHANGE_LAYER',
    '; Z_HEIGHT: 0.4',
    'G1 Z0.4',
    'G1 X100 Y100',
    'G1 X110 Y100 E1',
    '',
  ].join('\n');
  const zip = zipSync({
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(
      '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/><build/></model>',
    ),
    'Metadata/plate_1.gcode': strToU8(gcode),
    'Metadata/slice_info.config': strToU8(
      '<config><plate><metadata key="prediction" value="3829"/><metadata key="weight" value="16.92"/>' +
        '<filament id="1" type="PETG" color="#000000" used_m="5.63" used_g="16.92"/></plate></config>',
    ),
  });
  return Buffer.from(zip).toString('base64');
}

describe('STL webview host replies', () => {
  it('shows the confirmation the host sends after Save View as PNG', async () => {
    await import('../src/webview/stl');
    const toast = el<HTMLDivElement>('mc-toast');
    expect(toast.hidden).toBe(true);

    send({ type: 'toast', message: 'Frame saved' });

    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toBe('Frame saved');
  });

  it('shows why a 3MF could not be read in the viewport', async () => {
    await import('../src/webview/stl');
    load({ format: '3mf', name: 'part.3mf', bytes: btoa('not a zip') });
    expect(stats()).toBe('Reading part.3mf…');
    await vi.waitFor(() => expect(stats()).toMatch(/not a 3MF package/));
  });
});

describe('3D viewer models', () => {
  it('reads an STL out in the file own axes, with the grid spacing', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]) });
    expect(stats()).toBe('12 triangles\n10.00 × 20.00 × 30.00\nGrid 1');
  });

  it('reads the sample 3MF with its unit', async () => {
    await import('../src/webview/stl');
    const bytes = readFileSync(join(__dirname, '..', 'sample.3mf')).toString('base64');
    load({ format: '3mf', name: 'sample.3mf', bytes });
    await vi.waitFor(() =>
      expect(stats()).toBe('24 triangles\n25.00 × 10.00 × 10.00 mm\nGrid 1 mm'),
    );
  });

  it('leaves the grid out of the readout when it is off', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]), showGrid: false });
    expect(stats()).toBe('12 triangles\n10.00 × 20.00 × 30.00');
    el('btn-grid').click();
    expect(stats()).toMatch(/\nGrid 1$/);
  });
});

describe('3D viewer up axis and print bed', () => {
  // 300 long in Y: lying down it overhangs a 256 bed, stood on end (Y up) it
  // is 300 tall, which a bed 400 high takes.
  const tall = () => boxStl([0, 0, 0], [10, 300, 20]);

  it('says a Z-up part does not fit a bed it overhangs', async () => {
    await import('../src/webview/stl');
    load({ bytes: tall(), showBed: true, bedSize: '256x256x400' });
    expect(stats()).toMatch(/Bed 256 × 256 × 400 mm: does not fit$/);
  });

  it('judges the fit in the orientation the up axis gives', async () => {
    await import('../src/webview/stl');
    load({ bytes: tall(), showBed: true, bedSize: '256x256x400', upAxis: 'y' });
    expect(stats()).toMatch(/Bed 256 × 256 × 400 mm: fits$/);
  });

  it('leaves the bed out when the size setting is not a size', async () => {
    await import('../src/webview/stl');
    load({ bytes: tall(), showBed: true, bedSize: 'big' });
    expect(stats()).not.toMatch(/Bed/);
  });
});

describe('3D viewer section', () => {
  it('opens across the up axis at mid height and moves by round steps', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]) });
    const value = el<HTMLInputElement>('section-value');

    el('btn-section').click();
    expect(el('section').hidden).toBe(false);
    expect(document.body.classList.contains('mc-section')).toBe(true);
    expect(el('section-z').classList.contains('active')).toBe(true);
    expect(value.value).toBe('15.00');
    expect(el('section-readout').textContent).toMatch(/Point at the section/);

    el('section-x').click();
    expect(el('section-x').classList.contains('active')).toBe(true);
    expect(value.value).toBe('5.00');

    // The slider and the step buttons only mark the section stale; the next
    // frame recomputes it.
    el('section-up').click();
    expect(value.value).toBe('5.00');
    frame?.();
    expect(value.value).toBe('5.05');

    el('section-close').click();
    expect(el('section').hidden).toBe(true);
    expect(document.body.classList.contains('mc-section')).toBe(false);
  });

  it('follows a Y-up file to cut across Y first', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]), upAxis: 'y' });
    el('btn-section').click();
    expect(el('section-y').classList.contains('active')).toBe(true);
    expect(el<HTMLInputElement>('section-value').value).toBe('10.00');
  });
});

describe('3D viewer compare', () => {
  it('lists both models once the second arrives', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]), siblings: ['versions/part_v1.stl'] });
    send({
      type: 'compare',
      format: 'stl',
      name: 'versions/part_v1.stl',
      bytes: boxStl([0, 0, 0], [10, 20, 25]),
    });
    await vi.waitFor(() => expect(stats()).toMatch(/versions\/part_v1\.stl/));
    expect(stats()).toBe(
      'part.stl  12 triangles  10.00 × 20.00 × 30.00\n' +
        'versions/part_v1.stl  12 triangles  10.00 × 20.00 × 25.00\n' +
        'Grid 1',
    );
    expect(el('stats').querySelectorAll('.swatch')).toHaveLength(2);
  });

  it('keeps the first model when the second cannot be read', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]) });
    send({ type: 'compare', format: '3mf', name: 'bad.3mf', bytes: btoa('junk') });
    await vi.waitFor(() => expect(el('mc-toast').textContent).toMatch(/not a 3MF package/));
    expect(stats()).toMatch(/^12 triangles/);
  });

  it('offers the host own list under Compare with and asks for a model by name', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]), siblings: ['versions/part_v1.stl', 7] });
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const menu = el('mc-menu');
    expect(menu.hidden).toBe(false);
    expect(menu.textContent).toContain('Compare with');
    expect(menu.textContent).toContain('Copy View as PNG');
  });
});

describe('3D viewer sliced print', () => {
  it('draws the toolpaths with the print summary, a layer slider and the bed', async () => {
    await import('../src/webview/stl');
    load({ format: '3mf', name: 'part.gcode.3mf', bytes: slicedPrint() });
    await vi.waitFor(() => expect(stats()).toMatch(/^Sliced print/));
    const lines = stats().split('\n');
    expect(lines.slice(0, 4)).toEqual([
      'Sliced print',
      '1h 3m · 16.92 g · PETG',
      '2 layers, 3 moves',
      '10.00 × 10.00 × 0.20 mm',
    ]);
    expect(lines[4]).toMatch(/^Grid \d+ mm · Bed 256 × 256 × 256 mm: fits$/);

    expect(el('layers').hidden).toBe(false);
    expect(el('layer-label').textContent).toBe('Layer 2 / 2 · Z 0.40 mm');
    el('layer-down').click();
    expect(el('layer-label').textContent).toBe('Layer 1 / 2 · Z 0.20 mm');
    // Nothing to cut or to draw as wireframe in a set of lines.
    expect(el<HTMLButtonElement>('btn-section').disabled).toBe(true);
    expect(el<HTMLButtonElement>('btn-wireframe').disabled).toBe(true);
  });
});
