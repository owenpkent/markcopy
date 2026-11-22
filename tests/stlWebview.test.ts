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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Three from 'three';
import type * as StepModule from '../src/webview/step';

// The scene the viewer last asked the renderer to draw, which is the way in to
// the meshes and lines it built.
const drawn = vi.hoisted(() => ({
  scene: undefined as Three.Scene | undefined,
  controls: undefined as { target: Three.Vector3 } | undefined,
}));

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
    constructor(private camera: Three.Camera) {
      drawn.controls = this;
    }
    // The real controls aim the camera at the target on every update.
    update(): boolean {
      this.camera.lookAt(this.target);
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
    <button id="btn-parts" hidden></button>
  </div>
  <div id="stats"></div>
  <div id="layers" hidden>
    <button id="layer-down"></button>
    <input id="layer-range" type="range" min="1" max="1" step="1" value="1" />
    <button id="layer-up"></button>
    <span id="layer-label"></span>
    <input id="layer-only" type="checkbox" />
  </div>
  <div id="parts" hidden>
    <span id="parts-count"></span>
    <button id="parts-show-all"></button>
    <button id="parts-close"></button>
    <div id="parts-list"></div>
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

// ---------------------------------------------------------------------------
// The parts panel
// ---------------------------------------------------------------------------
// An ASCII STL of axis-aligned boxes, one `solid` each: the way a multi-part STL
// carries its parts.
function asciiBoxes(boxes: Array<[string, number[], number[]]>): string {
  const out: string[] = [];
  for (const [name, [x0, y0, z0], [x1, y1, z1]] of boxes) {
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
    out.push(`solid ${name}`);
    for (const face of faces) {
      out.push('facet normal 0 0 0', ' outer loop');
      for (const index of face) {
        out.push(`  vertex ${v[index].join(' ')}`);
      }
      out.push(' endloop', 'endfacet');
    }
    out.push(`endsolid ${name}`);
  }
  return Buffer.from(out.join('\n') + '\n').toString('base64');
}

const TWO_BOXES = (): string =>
  asciiBoxes([
    ['left', [0, 0, 0], [10, 10, 10]],
    ['right', [20, 0, 0], [30, 10, 10]],
  ]);

const rows = () => [...document.querySelectorAll<HTMLElement>('#parts-list .mc-part-row')];
const rowName = (row: HTMLElement) => row.querySelector('.mc-part-name')?.textContent;
const rowsNamed = (name: string) => rows().filter((row) => rowName(row) === name);
const rowNamed = (name: string, nth = 0) => rowsNamed(name)[nth];
const showBox = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input.mc-part-check')!;
const selectedNames = () =>
  rows()
    .filter((row) => row.classList.contains('mc-part-selected'))
    .map(rowName);
const groupsOf = () =>
  meshes()[0].geometry.groups.map((g) => [g.start / 3, g.count / 3, g.materialIndex]);

function openMenuAt(): void {
  document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
}
function menuRow(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.mc-menu-item')].find(
    (item) => item.textContent?.replace('✓', '').replace('▸', '').trim() === label,
  );
}

/** Click every point of a grid over the viewport, collecting what each selects. */
function sweep(): Set<string> {
  const canvas = document.querySelector('#viewport canvas') as HTMLCanvasElement;
  const found = new Set<string>();
  for (let x = 20; x < 800; x += 40) {
    for (let y = 15; y < 600; y += 30) {
      canvas.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }),
      );
      canvas.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y }),
      );
      for (const name of selectedNames()) {
        found.add(name as string);
      }
    }
  }
  return found;
}

describe('3D viewer parts panel', () => {
  beforeEach(() => {
    // Give the viewport a size, so the camera has an aspect and a click a place.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
  });

  it('opens by itself for a model of two or more parts, one row each', async () => {
    await import('../src/webview/stl');
    expect(el('parts').hidden).toBe(true);
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    expect(el('parts').hidden).toBe(false);
    expect(el<HTMLButtonElement>('btn-parts').hidden).toBe(false);
    expect(document.body.classList.contains('mc-parts')).toBe(true);
    expect(rows().map(rowName)).toEqual(['left', 'right']);
    expect(el('parts-count').textContent).toBe('2 parts');
    // Each row shows its triangle count, as text.
    expect(rows().map((row) => row.querySelector('.mc-part-tris')?.textContent)).toEqual([
      '12',
      '12',
    ]);
    expect(meshes()[0].geometry.groups).toHaveLength(0);
  });

  it('stays out of the way of a one-part model, and the menu says why', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]) });
    expect(el('parts').hidden).toBe(true);
    expect(el<HTMLButtonElement>('btn-parts').hidden).toBe(true);
    expect(document.body.classList.contains('mc-parts')).toBe(false);
    openMenuAt();
    expect(menuRow('Parts')).toBeUndefined();
    menuRow('View')!.click();
    expect(menuRow('Parts')).toBeUndefined();
  });

  it('opens and closes from the toolbar, the close button and the menu', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    el('btn-parts').click();
    expect(el('parts').hidden).toBe(true);
    expect(el('btn-parts').classList.contains('active')).toBe(false);
    openMenuAt();
    // Top level of the menu, not under View.
    expect(menuRow('Parts')!.getAttribute('aria-disabled')).toBeNull();
    menuRow('Parts')!.click();
    expect(el('parts').hidden).toBe(false);
    el('parts-close').click();
    expect(el('parts').hidden).toBe(true);
  });

  it('hides a part by its checkbox, drawing the rest with one group each', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    showBox(rowNamed('left')).click();
    expect(el('parts-count').textContent).toBe('1 of 2 shown');
    expect(groupsOf()).toEqual([
      [0, 12, 1],
      [12, 12, 0],
    ]);
    expect(Array.isArray(meshes()[0].material)).toBe(true);
    expect(showBox(rowNamed('left')).checked).toBe(false);
    // Not rebuilt: the same geometry, the same triangles.
    expect(meshes()[0].geometry.getAttribute('position').count).toBe(72);
    el('parts-show-all').click();
    expect(meshes()[0].geometry.groups).toHaveLength(0);
    expect(Array.isArray(meshes()[0].material)).toBe(false);
    expect(el<HTMLButtonElement>('parts-show-all').disabled).toBe(true);
  });

  it('selects a row on a click, tints that part, and clears on a second click', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    rowNamed('right').click();
    expect(selectedNames()).toEqual(['right']);
    expect(groupsOf()).toEqual([
      [0, 12, 0],
      [12, 12, 2],
    ]);
    const [base, hidden, highlight] = meshes()[0].material as Three.MeshStandardMaterial[];
    expect(hidden.visible).toBe(false);
    expect(highlight.emissive.getHex()).not.toBe(base.emissive.getHex());
    rowNamed('right').click();
    expect(selectedNames()).toEqual([]);
    expect(meshes()[0].geometry.groups).toHaveLength(0);
  });

  it('isolates a part and frames the camera on its bounds, then shows all', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    const isolate = rowNamed('right').querySelector<HTMLButtonElement>('.mc-part-isolate')!;
    isolate.click();
    expect(groupsOf()).toEqual([
      [0, 12, 1],
      [12, 12, 0],
    ]);
    // The pair is centred on x = 15, so the right box (centre x = 25) sits 10 to
    // the right of the middle, 5 up, and on the middle line in depth.
    const target = drawn.controls!.target;
    expect(target.x).toBeCloseTo(10, 4);
    expect(target.y).toBeCloseTo(5, 4);
    expect(target.z).toBeCloseTo(0, 4);
    el('parts-show-all').click();
    expect(meshes()[0].geometry.groups).toHaveLength(0);
  });

  it('picks a part with a click and not with a drag, and clears on empty space', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    expect(sweep()).toEqual(new Set(['left', 'right']));
    // A click that lands on nothing clears the selection.
    const canvas = document.querySelector('#viewport canvas') as HTMLCanvasElement;
    rowNamed('left').click();
    expect(selectedNames()).toEqual(['left']);
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 2, clientY: 2 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 2, clientY: 2 }));
    expect(selectedNames()).toEqual([]);
    // A drag (the pointer moved more than a few pixels) selects nothing.
    rowNamed('left').click();
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 300 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 460, clientY: 300 }));
    expect(selectedNames()).toEqual(['left']);
  });

  it('does not pick through a hidden part', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    showBox(rowNamed('left')).click();
    expect(sweep()).toEqual(new Set(['right']));
  });

  it('does not pick a model hidden by Compare with, and clears the selection', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    send({ type: 'compare', format: 'stl', name: 'c.stl', bytes: boxStl([0, 0, 0], [1, 1, 1]) });
    await vi.waitFor(() => expect(meshes()).toHaveLength(2));
    rowNamed('left').click();
    expect(selectedNames()).toEqual(['left']);
    openMenuAt();
    [...document.querySelectorAll<HTMLElement>('.mc-menu-item')]
      .find((item) => (item.textContent ?? '').startsWith('Compare with'))
      ?.dispatchEvent(new MouseEvent('mouseenter'));
    menuRow('Show two.stl')!.click();
    expect(meshes()[0].visible).toBe(false);
    expect(sweep()).toEqual(new Set());
    expect(selectedNames()).toEqual([]);
  });

  it('cuts only the parts that are shown', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    el('btn-section').click();
    // Two boxes at Z = 5: eight sides of two triangles, two vertices each.
    expect(sectionOutlines()).toEqual([32]);
    showBox(rowNamed('left')).click();
    expect(sectionOutlines()).toEqual([16]);
    el('parts-show-all').click();
    expect(sectionOutlines()).toEqual([32]);
  });

  it('copies the parts list as a Markdown table from the menu', async () => {
    await import('../src/webview/stl');
    load({ name: 'two.stl', bytes: TWO_BOXES() });
    let copied = '';
    (document as unknown as { execCommand: () => boolean }).execCommand = () => {
      const event = new Event('copy', { cancelable: true });
      Object.assign(event, { clipboardData: { setData: (_t: string, v: string) => (copied = v) } });
      document.dispatchEvent(event);
      return true;
    };
    openMenuAt();
    menuRow('Copy parts list')!.click();
    expect(copied).toBe(
      [
        '| Part | Assembly | Qty | Triangles |',
        '| --- | --- | ---: | ---: |',
        '| left |  | 1 | 12 |',
        '| right |  | 1 | 12 |',
      ].join('\n'),
    );
    expect(el('mc-toast').textContent).toBe('Copied parts list');
  });

  describe('with the sample assembly', () => {
    const assembly = () =>
      readFileSync(join(__dirname, '..', 'sample-assembly.step')).toString('base64');
    async function openAssembly(): Promise<void> {
      await import('../src/webview/stl');
      load({
        format: 'step',
        name: 'sample-assembly.step',
        bytes: assembly(),
        stepEngineUri: 'webview:/media/occt-import-js.wasm.gz',
      });
      await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0), { timeout: 20000 });
    }

    it('shows the tree, with the repeated peg as one row of quantity 2', async () => {
      await openAssembly();
      expect(rows().map(rowName)).toEqual(['Demo assembly', 'Mounting kit', 'Plate', 'Peg']);
      expect(rowNamed('Peg').querySelector('.mc-part-qty')?.textContent).toBe('x2');
      expect(el('parts-count').textContent).toBe('3 parts');
      // The row opens onto its two instances.
      rowNamed('Peg').querySelector<HTMLButtonElement>('.mc-part-toggle')!.click();
      expect(rowsNamed('Peg')).toHaveLength(3);
    }, 30000);

    it('cascades an assembly checkbox to its children, with a mixed state between', async () => {
      await openAssembly();
      showBox(rowNamed('Mounting kit')).click();
      expect(groupsOf()).toEqual([[0, 36, 1]]);
      expect(rows().every((row) => !showBox(row).checked)).toBe(true);
      // Showing the pegs shows both instances; the plate stays hidden.
      showBox(rowNamed('Peg')).click();
      expect(groupsOf()).toEqual([
        [0, 12, 1],
        [12, 24, 0],
      ]);
      expect(showBox(rowNamed('Peg')).checked).toBe(true);
      expect(showBox(rowNamed('Mounting kit')).indeterminate).toBe(true);
      expect(showBox(rowNamed('Demo assembly')).indeterminate).toBe(true);
      expect(showBox(rowNamed('Plate')).checked).toBe(false);
      // Checking the mixed assembly shows everything.
      showBox(rowNamed('Demo assembly')).click();
      expect(meshes()[0].geometry.groups).toHaveLength(0);
    }, 30000);

    it('keeps keyboard focus on the disclosure button after it is activated', async () => {
      await openAssembly();
      const toggle = () =>
        rowNamed('Mounting kit').querySelector<HTMLButtonElement>('.mc-part-toggle')!;
      // Collapse, then expand again: both replace every row.
      for (const label of ['Collapse Mounting kit', 'Expand Mounting kit']) {
        const before = toggle();
        before.focus();
        expect(document.activeElement).toBe(before);
        expect(before.getAttribute('aria-label')).toBe(label);
        before.click();
        expect(before.isConnected).toBe(false);
        expect(document.activeElement).toBe(toggle());
      }
    }, 30000);

    it('selects the row of a picked part, opening the assembly that holds it', async () => {
      await openAssembly();
      // Fold the whole tree away, then pick: the row must come back.
      rowNamed('Demo assembly').querySelector<HTMLButtonElement>('.mc-part-toggle')!.click();
      expect(rows().map(rowName)).toEqual(['Demo assembly']);
      const found = sweep();
      expect(found.has('Plate') || found.has('Peg')).toBe(true);
      expect(rowsNamed('Mounting kit')).toHaveLength(1);
    }, 30000);
  });
});

describe('3D viewer plain G-code', () => {
  const sample = () => readFileSync(join(__dirname, '..', 'sample.gcode'));
  const encode = (text: string) => Buffer.from(text).toString('base64');
  const gcodeLoad = (text: string | Buffer, extra: Record<string, unknown> = {}) =>
    load({
      format: 'gcode',
      name: 'part.gcode',
      bytes: typeof text === 'string' ? encode(text) : text.toString('base64'),
      ...extra,
    });
  const lineSets = (): Three.LineSegments[] => {
    const found: Three.LineSegments[] = [];
    drawn.scene?.traverse((object) => {
      if ((object as Three.LineSegments).isLineSegments) {
        found.push(object as Three.LineSegments);
      }
    });
    return found;
  };
  // The toolpath's own lines, the one with a color per vertex.
  const toolpath = () => lineSets().find((lines) => lines.geometry.hasAttribute('color'));

  it('reads sample.gcode: layers, the print summary, and no parts panel', async () => {
    await import('../src/webview/stl');
    gcodeLoad(sample(), { name: 'sample.gcode' });
    expect(stats()).toBe('Reading sample.gcode…');
    await vi.waitFor(() => expect(stats()).toMatch(/^G-code/));
    const lines = stats().split('\n');
    expect(lines[0]).toBe('G-code');
    expect(lines[1]).toMatch(/^5 layers, [\d,]+ moves$/);
    // A 20 mm square from its outer perimeter's centreline, over layers at Z 0.2 to 1.0.
    expect(lines[2]).toBe('19.60 × 19.60 × 0.80 mm');
    expect(el('layers').hidden).toBe(false);
    expect(el('layer-label').textContent).toBe('Layer 5 / 5 · Z 1.00 mm');
    el('layer-down').click();
    expect(el('layer-label').textContent).toBe('Layer 4 / 5 · Z 0.80 mm');
    expect(el('parts').hidden).toBe(true);
    expect(el<HTMLButtonElement>('btn-parts').hidden).toBe(true);
    expect(el<HTMLButtonElement>('btn-section').disabled).toBe(true);
    expect(toolpath()).toBeDefined();
  });

  it('draws the bed the file names, with no setting asking for one', async () => {
    await import('../src/webview/stl');
    gcodeLoad(sample(), { name: 'sample.gcode', showBed: false, bedSize: '10x10x10' });
    await vi.waitFor(() => expect(stats()).toMatch(/^G-code/));
    // sample.gcode ends with a bed_shape of 250 x 210 and a max_print_height of 210.
    expect(stats()).toMatch(/Bed 250 × 210 × 210 mm: fits$/);
  });

  it('puts the bed where the file puts it, and says when the print is off it', async () => {
    await import('../src/webview/stl');
    const text = [
      'M83',
      ';LAYER_CHANGE',
      ';Z:0.2',
      'G1 X-120 Y-100',
      'G1 X-100 Y-100 E1',
      '; bed_shape = -110x-110,110x-110,110x110,-110x110',
      '',
    ].join('\n');
    gcodeLoad(text);
    await vi.waitFor(() => expect(stats()).toMatch(/^G-code/));
    // The print starts 10 mm past the bed's edge.
    expect(stats()).toMatch(/Bed 220 × 220 mm: does not fit$/);
  });

  it('shows no bed when the file names none and showBed is off', async () => {
    await import('../src/webview/stl');
    const text = 'M83\n;LAYER_CHANGE\n;Z:0.2\nG1 X10 Y10\nG1 X20 Y10 E1\n';
    gcodeLoad(text, { showBed: false });
    await vi.waitFor(() => expect(stats()).toMatch(/^G-code/));
    expect(stats()).not.toMatch(/Bed /);
  });

  it('falls back to markcopy.stl.bedSize when the file names none and showBed is on', async () => {
    await import('../src/webview/stl');
    const text = 'M83\n;LAYER_CHANGE\n;Z:0.2\nG1 X10 Y10\nG1 X20 Y10 E1\n';
    gcodeLoad(text, { showBed: true, bedSize: '180x180x180' });
    await vi.waitFor(() => expect(stats()).toMatch(/^G-code/));
    expect(stats()).toMatch(/Bed 180 × 180 × 180 mm: fits$/);
  });

  it('colors Prusa and Cura feature names, and the fallback for an unknown one', async () => {
    await import('../src/webview/stl');
    const text = [
      'M83',
      ';LAYER:0',
      ';TYPE:WALL-OUTER',
      'G1 X10 Y10',
      'G1 X20 Y10 E1',
      ';TYPE:Top solid infill',
      'G1 X20 Y20 E1',
      ';TYPE:SOMETHING-NEW',
      'G1 X10 Y20 E1',
      '',
    ].join('\n');
    gcodeLoad(text);
    await vi.waitFor(() => expect(toolpath()).toBeDefined());
    const THREE = await import('three');
    const colors = toolpath()!.geometry.getAttribute('color').array;
    const expectColor = (segment: number, hex: number) => {
      const want = new THREE.Color(hex);
      expect(colors[segment * 6]).toBeCloseTo(want.r, 5);
      expect(colors[segment * 6 + 1]).toBeCloseTo(want.g, 5);
      expect(colors[segment * 6 + 2]).toBeCloseTo(want.b, 5);
    };
    expectColor(0, 0xff7d38);
    expectColor(1, 0xf04a4a);
    expectColor(2, 0x8a8f98);
  });

  it('says so when there is nothing to draw, and for a file that is not G-code at all', async () => {
    await import('../src/webview/stl');
    gcodeLoad('G21\nG90\nM104 S200\n');
    await vi.waitFor(() =>
      expect(stats()).toBe('This G-code file has no extrusion moves to show.'),
    );
    gcodeLoad('this is a readme, not G-code\n');
    await vi.waitFor(() =>
      expect(stats()).toBe('This G-code file has no extrusion moves to show.'),
    );
  });

  it('still offers Open as Text when the G-code has nothing to draw', async () => {
    await import('../src/webview/stl');
    gcodeLoad('G21\nG90\nM104 S200\n');
    await vi.waitFor(() =>
      expect(stats()).toBe('This G-code file has no extrusion moves to show.'),
    );
    openMenuAt();
    const row = menuRow('Open as Text');
    expect(row).toBeDefined();
    row!.click();
    expect(posted).toContainEqual({ type: 'openAsText' });
  });

  it('offers Open as Text for G-code only, and asks the host for it', async () => {
    await import('../src/webview/stl');
    gcodeLoad(sample(), { name: 'sample.gcode' });
    await vi.waitFor(() => expect(stats()).toMatch(/^G-code/));
    openMenuAt();
    const row = menuRow('Open as Text');
    expect(row).toBeDefined();
    row!.click();
    expect(posted).toContainEqual({ type: 'openAsText' });

    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]) });
    openMenuAt();
    expect(menuRow('Open as Text')).toBeUndefined();
  });

  it('does not offer Open as Text for a sliced print file', async () => {
    await import('../src/webview/stl');
    load({ format: '3mf', name: 'part.gcode.3mf', bytes: slicedPrint() });
    await vi.waitFor(() => expect(stats()).toMatch(/^Sliced print/));
    openMenuAt();
    expect(menuRow('Open as Text')).toBeUndefined();
  });
});

describe('3D viewer OBJ', () => {
  const read = (name: string) => readFileSync(join(__dirname, '..', name));
  const objBytes = (text: string) => Buffer.from(text).toString('base64');
  const sample = () => ({
    format: 'obj',
    name: 'sample.obj',
    bytes: read('sample.obj').toString('base64'),
    mtl: [{ name: 'sample.mtl', text: read('sample.mtl').toString('utf8') }],
    materialNotes: [],
  });
  const rotation = () => meshes()[0].parent?.rotation.x;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
  });

  const openMenu = (): void => {
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const view = [...document.querySelectorAll<HTMLElement>('.mc-menu-item')].find((item) =>
      (item.textContent ?? '').startsWith('View'),
    );
    view?.dispatchEvent(new MouseEvent('mouseenter'));
  };
  const menuItem = (label: string): HTMLElement | undefined =>
    [...document.querySelectorAll<HTMLElement>('.mc-menu-item')].find(
      (item) => item.textContent?.replace('✓', '').replace('▸', '').trim() === label,
    );

  // A triangle in the XY plane whose vn says +Y: a recomputed normal would be +Z,
  // so which one the geometry holds says whether the file's was kept.
  const normalOfFirstVertex = (): number[] =>
    Array.from(meshes()[0].geometry.getAttribute('normal').array.slice(0, 3));
  const slanted = (face: string) => objBytes(`v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 1 0\n${face}\n`);

  it('reads the sample: colored, unitless, with the file normals and its two parts', async () => {
    await import('../src/webview/stl');
    load(sample());
    expect(stats()).toBe('Reading sample.obj…');
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    // 18 triangles; 5 wide, 5 tall, 5 deep in the file's own X Y Z, no unit.
    expect(stats()).toMatch(/^18 triangles\n5\.00 × 5\.00 × 5\.00\nGrid /);
    expect(material(meshes()[0]).vertexColors).toBe(true);
    expect(meshes()[0].geometry.hasAttribute('normal')).toBe(true);
    // Two objects: the Parts panel opens by itself, one row each.
    expect(el('parts').hidden).toBe(false);
    expect(
      [...document.querySelectorAll('#parts-list .mc-part-name')].map((n) => n.textContent),
    ).toEqual(['walls', 'roof']);
  });

  it('keeps the normals the file gives when every face vertex has one', async () => {
    await import('../src/webview/stl');
    load({ format: 'obj', name: 'tri.obj', bytes: slanted('f 1//1 2//1 3//1') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    expect(normalOfFirstVertex()).toEqual([0, 1, 0]);
  });

  it('computes the normals when a face vertex has none', async () => {
    await import('../src/webview/stl');
    load({ format: 'obj', name: 'tri.obj', bytes: slanted('f 1//1 2//1 3') });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    expect(normalOfFirstVertex()[2]).toBeCloseTo(1);
  });
  it('draws in markcopy.stl.meshColor when there is no .mtl, and says the file was not found', async () => {
    await import('../src/webview/stl');
    load({
      ...sample(),
      mtl: [],
      materialNotes: ['Materials file not found: sample.mtl'],
      meshColor: '#ff0000',
    });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    expect(material(meshes()[0]).vertexColors).toBe(false);
    expect(material(meshes()[0]).color.getHexString()).toBe('ff0000');
    expect(stats()).toMatch(/\nMaterials file not found: sample\.mtl$/);
  });

  it('starts Y-up whatever markcopy.stl.upAxis says, and the menu switches it without writing the setting', async () => {
    await import('../src/webview/stl');
    load({ ...sample(), upAxis: 'z' });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    // No turn: the file's Y is the viewer's up.
    expect(rotation()).toBeCloseTo(0);
    openMenu();
    expect(menuItem('Up Axis')).toBeDefined();
    menuItem('Up Axis')!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(menuItem('Y')!.textContent).toContain('✓');
    menuItem('Z')!.click();
    expect(rotation()).toBeCloseTo(-Math.PI / 2);
    // The window's own choice: the shared STL and STEP setting is left alone.
    expect(posted.filter((m) => m.type === 'updateSetting')).toEqual([]);
    // Back to Y, and a newly opened OBJ starts Y-up again.
    openMenu();
    menuItem('Up Axis')!.dispatchEvent(new MouseEvent('mouseenter'));
    menuItem('Y')!.click();
    expect(rotation()).toBeCloseTo(0);
  });

  it('starts the next OBJ Y-up again after one was switched to Z', async () => {
    await import('../src/webview/stl');
    load(sample());
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    openMenu();
    menuItem('Up Axis')!.dispatchEvent(new MouseEvent('mouseenter'));
    menuItem('Z')!.click();
    load(sample());
    await vi.waitFor(() => expect(stats()).toMatch(/^18 triangles/));
    expect(rotation()).toBeCloseTo(0);
  });

  it('leaves an STL on markcopy.stl.upAxis, which still writes it', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [10, 20, 30]), upAxis: 'z' });
    expect(rotation()).toBeCloseTo(-Math.PI / 2);
    openMenu();
    menuItem('Up Axis')!.dispatchEvent(new MouseEvent('mouseenter'));
    menuItem('Y')!.click();
    expect(posted.filter((m) => m.type === 'updateSetting')).toEqual([
      { type: 'updateSetting', key: 'stl.upAxis', value: 'y' },
    ]);
  });

  it('says why an OBJ could not be read, and refuses one past the bounds', async () => {
    await import('../src/webview/stl');
    load({ format: 'obj', name: 'bad.obj', bytes: objBytes('v 0 0 0\nf 1 2 3\n') });
    await vi.waitFor(() => expect(stats()).toMatch(/vertex that has not been declared/));
    load({ format: 'obj', name: 'none.obj', bytes: objBytes('# nothing\n') });
    await vi.waitFor(() => expect(stats()).toMatch(/no faces to show/));
    load({
      format: 'obj',
      name: 'compiled.obj',
      bytes: Buffer.from([0x64, 0x86, 0, 0, 1]).toString('base64'),
    });
    await vi.waitFor(() => expect(stats()).toMatch(/compiled object file/));
  });

  it('shows the host refusal of a compiled .obj with a button that asks for the text editor', async () => {
    await import('../src/webview/stl');
    send({
      type: 'error',
      name: 'main.obj',
      path: '/src/main.obj',
      message: 'This .obj is a compiled object file, not a 3D model.',
      openAsText: true,
    });
    expect(stats()).toContain('compiled object file');
    const button = el('stats').querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('Open as text');
    // The readout lets the pointer through; the button has to take it.
    expect(button.style.pointerEvents).toBe('auto');
    button.click();
    expect(posted).toContainEqual({ type: 'openAsText' });
    // No other error carries one.
    send({ type: 'error', message: 'Too big.' });
    expect(el('stats').querySelector('button')).toBeNull();
  });

  it('ignores a .mtl payload that is not what the host sends', async () => {
    await import('../src/webview/stl');
    load({
      ...sample(),
      mtl: [
        { name: 5, text: 'x' },
        null,
        { name: 'big.mtl', text: 'x'.repeat(4 * 1024 * 1024 + 1) },
        'text',
      ],
      materialNotes: [7, 'one note'],
    });
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    expect(material(meshes()[0]).vertexColors).toBe(false);
    expect(stats()).toMatch(/\none note$/);
  });

  it('compares an OBJ with an STL, in the compared model color', async () => {
    await import('../src/webview/stl');
    load({ bytes: boxStl([0, 0, 0], [4, 4, 4]), siblings: ['sample.obj'] });
    send({ type: 'compare', ...sample() });
    await vi.waitFor(() => expect(meshes()).toHaveLength(2));
    expect(stats()).toContain('sample.obj  18 triangles');
  });

  it('compares an STL with an OBJ and keeps the OBJ Y-up default for the OBJ when it is first', async () => {
    await import('../src/webview/stl');
    load(sample());
    await vi.waitFor(() => expect(meshes()).toHaveLength(1));
    send({ type: 'compare', format: 'stl', name: 'a.stl', bytes: boxStl([0, 0, 0], [1, 1, 1]) });
    await vi.waitFor(() => expect(meshes()).toHaveLength(2));
    expect(rotation()).toBeCloseTo(0);
  });
});
