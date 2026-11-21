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
import type * as StepModule from '../src/webview/step';

// The scene the viewer last asked the renderer to draw, which is the way in to
// the meshes and lines it built.
const drawn = vi.hoisted(() => ({ scene: undefined as Three.Scene | undefined }));

// Holds the STEP engine back until a test lets it go, and counts the starts
// that have finished, so a test can pile up requests behind a slow engine.
const engineGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  engine: null as Promise<never> | null,
  calls: 0,
  answered: 0,
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof Three>();
  class WebGLRenderer {
    domElement = document.createElement('canvas');
    localClippingEnabled = false;
    setPixelRatio(): void {}
    setSize(): void {}
    setClearColor(): void {}
    render(scene: Three.Scene): void {
      drawn.scene = scene;
    }
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

// The real STEP engine, started from the raw wasm in node_modules: the webview
// would fetch the gzipped copy from media/, which a test has no server for.
vi.mock('../src/webview/step', async (importOriginal) => {
  const actual = await importOriginal<typeof StepModule>();
  const wasmPath = join(
    __dirname,
    '..',
    'node_modules',
    'occt-import-js',
    'dist',
    'occt-import-js.wasm',
  );
  const factory = (await import('occt-import-js')).default;
  return {
    ...actual,
    loadStepEngine: async () => {
      engineGate.calls++;
      await engineGate.hold;
      engineGate.engine ??= factory({
        wasmBinary: new Uint8Array(readFileSync(wasmPath)),
      }) as Promise<never>;
      const engine = await engineGate.engine;
      engineGate.answered++;
      return engine;
    },
  };
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
  drawn.scene = undefined;
  engineGate.hold = null;
  engineGate.calls = 0;
  engineGate.answered = 0;
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

/** The meshes in the scene the viewer drew, in the order it added them. */
function meshes(): Three.Mesh[] {
  const found: Three.Mesh[] = [];
  drawn.scene?.traverse((object) => {
    if ((object as Three.Mesh).isMesh) {
      found.push(object as Three.Mesh);
    }
  });
  return found;
}

const material = (mesh: Three.Mesh) => mesh.material as Three.MeshStandardMaterial;

/** How many vertices each traced section outline has, one entry per model cut. */
function sectionOutlines(): number[] {
  const found: number[] = [];
  drawn.scene?.traverse((object) => {
    const lines = object as Three.LineSegments;
    if (lines.isLineSegments && lines.renderOrder === 2) {
      found.push(lines.geometry.getAttribute('position').count);
    }
  });
  return found;
}

// A one-triangle binary STL whose header carries the "COLOR=" marker
// Materialise Magics writes, which makes STLLoader attach a per-vertex color
// attribute to the geometry.
function magicsStl(): string {
  const out = Buffer.alloc(84 + 50);
  out.write('COLOR=', 0, 'latin1');
  out.set([255, 0, 0, 255], 6);
  out.writeUInt32LE(1, 80);
  out.writeFloatLE(1, 84 + 12 + 12);
  out.writeFloatLE(1, 84 + 12 + 24 + 4);
  return out.toString('base64');
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

// A 3MF of one cube from the origin to `size` on every axis, in `unit`, with
// an object-level base material when `color` is given.
function cube3mf(size: number, unit: string, color?: string): string {
  const s = size;
  const v = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s],
    [s, 0, s],
    [s, s, s],
    [0, s, s],
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
  const vertices = v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
  const triangles = faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
  const base = color
    ? `<basematerials id="9"><base name="c" displaycolor="${color}"/></basematerials>`
    : '';
  const model =
    `<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${base}` +
    `<object id="1"${color ? ' pid="9" pindex="0"' : ''}><mesh><vertices>${vertices}</vertices>` +
    `<triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const zip = zipSync({ '_rels/.rels': strToU8(RELS), '3D/3dmodel.model': strToU8(model) });
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

  it('works out the normals of an STL whose facet normals are zero', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]) });
    const normal = meshes()[0].geometry.getAttribute('normal');
    expect(normal.count).toBe(36);
    let unit = 0;
    for (let i = 0; i < normal.count; i++) {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      if (Math.abs(length - 1) < 1e-4) {
        unit++;
      }
    }
    expect(unit).toBe(36);
  });

  it('reads the sample 3MF with its unit', async () => {
    await import('../src/webview/stl');
    const bytes = readFileSync(join(__dirname, '..', 'sample.3mf')).toString('base64');
    load({ format: '3mf', name: 'sample.3mf', bytes });
    await vi.waitFor(() =>
      expect(stats()).toBe('24 triangles\n25.00 × 10.00 × 10.00 mm\nGrid 1 mm'),
    );
  });

  it('draws an STL in the configured mesh color even when the file carries colors', async () => {
    // The loader gives this file a color attribute; the viewer has never drawn
    // an STL's own colors, and 3MF support must not start doing so by accident.
    await import('../src/webview/stl');
    load({ bytes: magicsStl(), meshColor: '#00ff00' });
    const [mesh] = meshes();
    expect(mesh.geometry.hasAttribute('color')).toBe(true);
    expect(material(mesh).vertexColors).toBe(false);
    expect(material(mesh).color.getHexString()).toBe('00ff00');
  });

  it('draws a colored 3MF in its own colors', async () => {
    await import('../src/webview/stl');
    load({ format: '3mf', name: 'blue.3mf', bytes: cube3mf(10, 'millimeter', '#0000FF') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    expect(material(meshes()[0]).vertexColors).toBe(true);
    expect(material(meshes()[0]).color.getHexString()).toBe('ffffff');
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

  it('draws the second model in the comparison color whatever colors it brings', async () => {
    // Both versions are the same blue in their files. The overlay is only
    // readable if the second is the orange its swatch says it is.
    await import('../src/webview/stl');
    load({ format: '3mf', name: 'new.3mf', bytes: cube3mf(10, 'millimeter', '#0000FF') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    send({
      type: 'compare',
      format: '3mf',
      name: 'old.3mf',
      bytes: cube3mf(8, 'millimeter', '#0000FF'),
    });
    await vi.waitFor(() => expect(meshes()).toHaveLength(2));
    const [first, second] = meshes();
    expect(material(first).vertexColors).toBe(true);
    expect(material(second).vertexColors).toBe(false);
    expect(material(second).color.getHexString()).toBe('f0883e');
  });

  it('brings a second model in other units to the first model scale', async () => {
    // The same 10 mm cube, once in millimetres and once as 1 cm. They are the
    // same part, so they must coincide, in the overlay and in a section.
    await import('../src/webview/stl');
    load({ format: '3mf', name: 'mm.3mf', bytes: cube3mf(10, 'millimeter') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    send({ type: 'compare', format: '3mf', name: 'cm.3mf', bytes: cube3mf(1, 'centimeter') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(2));

    const [first, second] = meshes();
    for (const mesh of [first, second]) {
      mesh.geometry.computeBoundingBox();
      expect(mesh.geometry.boundingBox?.max.toArray()).toEqual([10, 10, 10]);
    }
    // Each still reads out in its own file's unit.
    expect(stats()).toBe(
      'mm.3mf  12 triangles  10.00 × 10.00 × 10.00 mm\n' +
        'cm.3mf  12 triangles  1.00 × 1.00 × 1.00 cm\n' +
        'Grid 0.5 mm',
    );

    el('btn-section').click();
    expect(el<HTMLInputElement>('section-value').value).toBe('5.00');
    // Both cubes are cut at Z = 5 mm: four sides of two triangles each, two
    // vertices a piece.
    expect(sectionOutlines()).toEqual([16, 16]);
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

describe('3D viewer GLB and STEP', () => {
  const file = (name: string) => readFileSync(join(__dirname, '..', name)).toString('base64');

  it('reads the sample GLB, upright, in its own colors', async () => {
    await import('../src/webview/stl');
    load({ format: 'glb', name: 'sample.glb', bytes: file('sample.glb') });
    expect(stats()).toBe('Reading sample.glb…');
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    // 4 wide, 2.5 deep, 2.5 tall once turned from glTF's Y up; no unit.
    expect(stats()).toMatch(/^24 triangles\n4\.00 × 2\.50 × 2\.50\nGrid /);
    expect(material(meshes()[0]).vertexColors).toBe(true);
    expect(meshes()[0].geometry.hasAttribute('normal')).toBe(true);
  });

  it('does not let markcopy.stl.upAxis turn a GLB, which fixes its own', async () => {
    await import('../src/webview/stl');
    load({ format: 'glb', name: 'sample.glb', bytes: file('sample.glb'), upAxis: 'y' });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    const asY = meshes()[0].parent?.rotation.x;
    expect(asY).toBeCloseTo(-Math.PI / 2);
  });

  it('shows why a GLB could not be read in the viewport', async () => {
    await import('../src/webview/stl');
    load({ format: 'glb', name: 'bad.glb', bytes: btoa('not a glb at all') });
    await vi.waitFor(() => expect(stats()).toMatch(/not a GLB file|cannot be read/));
  });

  it('reads the sample STEP file in millimetres, with the engine status first', async () => {
    await import('../src/webview/stl');
    load({
      format: 'step',
      name: 'sample.step',
      bytes: file('sample.step'),
    });
    expect(stats()).toBe('Reading sample.step…');
    await vi.waitFor(() => expect(meshes()).toHaveLength(1), { timeout: 20000 });
    expect(stats()).toMatch(/^12 triangles\n20\.00 × 10\.00 × 5\.00 mm\nGrid /);
    expect(material(meshes()[0]).vertexColors).toBe(true);
  }, 30000);

  it('says why a STEP file could not be read', async () => {
    await import('../src/webview/stl');
    load({
      format: 'step',
      name: 'bad.step',
      bytes: btoa('ISO-10303-21;\nDATA;\n#1=NOPE(;\nENDSEC;'),
    });
    await vi.waitFor(() => expect(stats()).toMatch(/could not read this file/), { timeout: 20000 });
  }, 30000);

  it('keeps the normals a GLB and a STEP file bring', async () => {
    const THREE = await import('three');
    const compute = vi.spyOn(THREE.BufferGeometry.prototype, 'computeVertexNormals');
    await import('../src/webview/stl');
    load({ format: 'glb', name: 'sample.glb', bytes: file('sample.glb') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    expect(compute).not.toHaveBeenCalled();
    load({ format: 'step', name: 'sample.step', bytes: file('sample.step') });
    await vi.waitFor(() => expect(stats()).toMatch(/mm\nGrid /), { timeout: 20000 });
    expect(meshes()[0].geometry.hasAttribute('normal')).toBe(true);
    expect(compute).not.toHaveBeenCalled();
  }, 30000);

  // The sample box with its geometry turned into Y-up coordinates (x, y, z)
  // becomes (x, z, -y), the way a Y-up CAD export has it, while the file's own
  // global frame (the last placement) stays as it is.
  const yUpStep = (): string => {
    const text = readFileSync(join(__dirname, '..', 'sample.step'), 'utf8').replace(
      /^#(\d+)=(CARTESIAN_POINT|DIRECTION)\('',\(([^)]*)\)\);$/gm,
      (whole, id: string, kind: string, xyz: string) => {
        if (Number(id) >= 141 && Number(id) <= 143) {
          return whole;
        }
        const [x, y, z] = xyz.split(',').map(Number);
        return `#${id}=${kind}('',(${x.toFixed(6)},${z.toFixed(6)},${(-y).toFixed(6)}));`;
      },
    );
    return Buffer.from(text).toString('base64');
  };

  const stepFit = (bytes: string, upAxis: string, bed = '30x12x6') => {
    load({ format: 'step', name: 'box.step', bytes, upAxis, showBed: true, bedSize: bed });
  };

  it('stands a Z-up STEP file on the grid, and fits it to a bed', async () => {
    await import('../src/webview/stl');
    stepFit(file('sample.step'), 'z');
    await vi.waitFor(() => expect(meshes()).toHaveLength(1), { timeout: 20000 });
    expect(stats()).toMatch(
      /^12 triangles\n20\.00 × 10\.00 × 5\.00 mm\n.*Bed 30 × 12 × 6 mm: fits$/,
    );
    expect(meshes()[0].parent?.rotation.x).toBeCloseTo(-Math.PI / 2);
  }, 30000);

  it('follows markcopy.stl.upAxis for a Y-up STEP file, which then fits upright', async () => {
    await import('../src/webview/stl');
    stepFit(yUpStep(), 'y');
    await vi.waitFor(() => expect(meshes()).toHaveLength(1), { timeout: 20000 });
    // The file's own X x Y x Z, with Y the 5 mm height.
    expect(stats()).toMatch(
      /^12 triangles\n20\.00 × 5\.00 × 10\.00 mm\n.*Bed 30 × 12 × 6 mm: fits$/,
    );
    expect(meshes()[0].parent?.rotation.x).toBeCloseTo(0);
  }, 30000);

  it('lays a Y-up STEP file on its side when the up axis is left at Z', async () => {
    await import('../src/webview/stl');
    stepFit(yUpStep(), 'z');
    await vi.waitFor(() => expect(meshes()).toHaveLength(1), { timeout: 20000 });
    expect(stats()).toMatch(/Bed 30 × 12 × 6 mm: does not fit$/);
    expect(meshes()[0].parent?.rotation.x).toBeCloseTo(-Math.PI / 2);
  }, 30000);

  // Open the submenu whose row starts with `label` in the open context menu.
  const openSubmenu = (label: string): void => {
    const row = [...el('mc-menu').querySelectorAll('.mc-menu-item')].find((item) =>
      (item.textContent ?? '').startsWith(label),
    );
    row?.dispatchEvent(new MouseEvent('mouseenter'));
  };
  const menuText = (): string =>
    [...document.querySelectorAll('.mc-menu')].map((panel) => panel.textContent).join('|');

  it('offers the Up Axis menu for a STEP file but not for a GLB', async () => {
    await import('../src/webview/stl');
    load({ format: 'step', name: 'sample.step', bytes: file('sample.step') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1), { timeout: 20000 });
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    openSubmenu('View');
    expect(menuText()).toContain('Up Axis');
    load({ format: 'glb', name: 'sample.glb', bytes: file('sample.glb') });
    await vi.waitFor(() => expect(stats()).toMatch(/^24 triangles/));
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    openSubmenu('View');
    expect(menuText()).toContain('Fit View');
    expect(menuText()).not.toContain('Up Axis');
  }, 30000);

  it('keeps the latest comparison when an earlier STEP one finishes after it', async () => {
    await import('../src/webview/stl');
    let release = () => {};
    engineGate.hold = new Promise<void>((resolve) => (release = resolve));
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]), siblings: ['earlier.step', 'latest.stl'] });
    send({ type: 'compare', format: 'step', name: 'earlier.step', bytes: file('sample.step') });
    send({
      type: 'compare',
      format: 'stl',
      name: 'latest.stl',
      bytes: boxStl([0, 0, 0], [10, 20, 25]),
    });
    await vi.waitFor(() => expect(stats()).toMatch(/latest\.stl/));
    await vi.waitFor(() => expect(engineGate.calls).toBeGreaterThan(0));
    release();
    await vi.waitFor(() => expect(engineGate.answered).toBe(engineGate.calls), { timeout: 20000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stats()).toMatch(/latest\.stl/);
    expect(stats()).not.toMatch(/earlier\.step/);
    expect(meshes()).toHaveLength(2);
  }, 30000);

  it('does not bring an overlay back when Stop Comparing came before a pending STEP one', async () => {
    await import('../src/webview/stl');
    let release = () => {};
    engineGate.hold = new Promise<void>((resolve) => (release = resolve));
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]), siblings: ['a.stl', 'later.step'] });
    send({ type: 'compare', format: 'stl', name: 'a.stl', bytes: boxStl([0, 0, 0], [10, 20, 25]) });
    await vi.waitFor(() => expect(meshes()).toHaveLength(2));
    send({ type: 'compare', format: 'step', name: 'later.step', bytes: file('sample.step') });
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    openSubmenu('Compare with');
    const stop = [...document.querySelectorAll<HTMLElement>('.mc-menu-item')].find(
      (node) => node.textContent === 'Stop Comparing',
    );
    expect(stop).toBeDefined();
    stop?.click();
    expect(meshes()).toHaveLength(1);
    await vi.waitFor(() => expect(engineGate.calls).toBeGreaterThan(0));
    release();
    await vi.waitFor(() => expect(engineGate.answered).toBe(engineGate.calls), { timeout: 20000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(meshes()).toHaveLength(1);
    expect(stats()).toMatch(/^12 triangles/);
  }, 30000);

  it('compares a STEP file with a GLB', async () => {
    await import('../src/webview/stl');
    load({ format: 'glb', name: 'sample.glb', bytes: file('sample.glb') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    send({ type: 'compare', format: 'step', name: 'sample.step', bytes: file('sample.step') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(2), { timeout: 20000 });
  }, 30000);
});
