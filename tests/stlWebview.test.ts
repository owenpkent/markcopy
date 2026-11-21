// Coverage for src/webview/stl.ts, the STL and 3MF viewer: its handling of host
// replies, and what it builds for a model.
//
// jsdom has no WebGL, so the renderer and OrbitControls are replaced with
// stand-ins. Everything else is the real Three.js, loader included, so the
// geometry and material a file ends up with are the ones the webview makes;
// what the frame looks like is checked by hand (see docs/TESTING.md).
//
// The DOM mirrors the ids written by src/stlEditor.ts's html().
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Three from 'three';

// The scene the viewer last asked the renderer to draw, which is the way in to
// the meshes it built.
const drawn = vi.hoisted(() => ({ scene: undefined as Three.Scene | undefined }));

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

const BODY = `
  <div id="viewport"></div>
  <div id="toolbar">
    <button id="btn-fit"></button>
    <button id="btn-wireframe"></button>
    <button id="btn-grid"></button>
  </div>
  <div id="stats"></div>
  <div id="mc-menu" hidden></div>
  <div id="mc-toast" hidden></div>`;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = BODY;
  drawn.scene = undefined;
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn() }));
  vi.stubGlobal('requestAnimationFrame', () => 0);
});

const stats = () => document.getElementById('stats')?.textContent ?? '';

function send(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.origin }));
}

function load(extra: Record<string, unknown>): void {
  send({
    type: 'load',
    format: 'stl',
    name: 'part.stl',
    path: '/models/part.stl',
    showGrid: true,
    meshColor: '#8ab4f8',
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

// A one-triangle binary STL. With `magicsColor`, its header carries the
// "COLOR=" marker Materialise Magics writes, which makes STLLoader attach a
// per-vertex color attribute to the geometry.
function triangleStl(magicsColor?: [number, number, number]): string {
  const out = Buffer.alloc(84 + 50);
  if (magicsColor) {
    out.write('COLOR=', 0, 'latin1');
    out.set([...magicsColor, 255], 6);
  }
  out.writeUInt32LE(1, 80);
  // Corners (0,0,0), (1,0,0), (0,1,0); the normal is left zero.
  out.writeFloatLE(1, 84 + 12 + 12);
  out.writeFloatLE(1, 84 + 12 + 24 + 4);
  return out.toString('base64');
}

describe('STL webview host replies', () => {
  it('shows the confirmation the host sends after Save View as PNG', async () => {
    await import('../src/webview/stl');
    const toast = document.getElementById('mc-toast') as HTMLDivElement;
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
  it('draws an STL in the configured mesh color', async () => {
    await import('../src/webview/stl');
    load({ bytes: triangleStl(), meshColor: '#00ff00' });
    expect(stats()).toBe('1 triangles\n1.00 × 1.00 × 0.00');
    const [mesh] = meshes();
    expect(material(mesh).vertexColors).toBe(false);
    expect(material(mesh).color.getHexString()).toBe('00ff00');
  });

  it('keeps the configured color for an STL that carries colors of its own', async () => {
    // The loader gives this file a color attribute; the viewer has never drawn
    // an STL's own colors, and 3MF support must not start doing so by accident.
    await import('../src/webview/stl');
    load({ bytes: triangleStl([255, 0, 0]), meshColor: '#00ff00' });
    const [mesh] = meshes();
    expect(mesh.geometry.hasAttribute('color')).toBe(true);
    expect(material(mesh).vertexColors).toBe(false);
    expect(material(mesh).color.getHexString()).toBe('00ff00');
  });

  it('draws a colored 3MF in its own colors, with its unit in the readout', async () => {
    await import('../src/webview/stl');
    const bytes = readFileSync(join(__dirname, '..', 'sample.3mf')).toString('base64');
    load({ format: '3mf', name: 'sample.3mf', bytes, meshColor: '#00ff00' });
    await vi.waitFor(() => expect(stats()).toBe('24 triangles\n25.00 × 10.00 × 10.00 mm'));
    const [mesh] = meshes();
    expect(material(mesh).vertexColors).toBe(true);
    expect(material(mesh).color.getHexString()).toBe('ffffff');
  });
});
