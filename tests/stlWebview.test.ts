// Coverage for src/webview/stl.ts's handling of host replies. jsdom has no
// WebGL, so Three.js, its loader and OrbitControls are replaced with inert
// stand-ins; the WebGL output itself is checked by hand (see docs/TESTING.md).
//
// The DOM mirrors the ids written by src/stlEditor.ts's html().
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Anything Three.js hands back: every property read, call, and construction
// returns another stand-in, and assignments are accepted and ignored. The
// renderer's canvas is the one value that has to be real, since the viewer
// appends it to the page.
function inert(): unknown {
  const target = function () {
    /* stand-in */
  };
  const proxy: unknown = new Proxy(target, {
    get: (_t, key) => (key === 'domElement' ? document.createElement('canvas') : proxy),
    set: () => true,
    apply: () => proxy,
    construct: () => proxy as object,
  });
  return proxy;
}

vi.mock('three', () => {
  const names = [
    'Scene',
    'PerspectiveCamera',
    'WebGLRenderer',
    'HemisphereLight',
    'DirectionalLight',
    'Color',
    'GridHelper',
    'Mesh',
    'Sphere',
    'Vector3',
    'Box3',
    'MeshStandardMaterial',
  ];
  return Object.fromEntries(names.map((n) => [n, inert()]));
});
vi.mock('three/examples/jsm/loaders/STLLoader.js', () => ({ STLLoader: inert() }));
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({ OrbitControls: inert() }));

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
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn() }));
  vi.stubGlobal('requestAnimationFrame', () => 0);
});

describe('STL webview host replies', () => {
  it('shows the confirmation the host sends after Save View as PNG', async () => {
    await import('../src/webview/stl');
    const toast = document.getElementById('mc-toast') as HTMLDivElement;
    expect(toast.hidden).toBe(true);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'toast', message: 'Frame saved' },
        origin: window.origin,
      }),
    );

    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toBe('Frame saved');
  });
});
