// Browser-side STL viewer for the MarkCopy STL preview. Bundled on its own into
// media/stl.js (see esbuild.web.js) so Three.js only loads when an .stl file is
// opened, never for the Markdown, CSV, or PDF previews.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createMenu, revealLabel, type MenuEntry } from './menu';
import { fromHost } from './fromHost';
import {
  VIEW_PRESETS,
  checkStl,
  createRightClickGate,
  toBytes,
  viewFileName,
  type ViewPreset,
} from './stlInfo';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

interface LoadMessage {
  type: 'load';
  name: string;
  // The full file system path, for the menu's Copy as > Full Path.
  path: string;
  // Base64 from the extension host, but typed loosely because the transport can
  // reshape a payload; toBytes() normalizes whatever arrives. See stlInfo.ts.
  bytes: unknown;
  showGrid: boolean;
  meshColor: string;
}

interface ThemeMessage {
  type: 'setTheme';
  value: string;
}

// The host refused the file before sending it (too large, or checkStl said no).
// It carries the reason so the viewport can say what happened instead of sitting
// blank while the explanation goes to a notification toast. The name and path
// ride along so the menu's File Name and Full Path still work.
interface ErrorMessage {
  type: 'error';
  message: string;
  name?: string;
  path?: string;
}

// The host's confirmation after Save View as PNG writes the file.
interface ToastMessage {
  type: 'toast';
  message: string;
}

type HostMessage = LoadMessage | ThemeMessage | ErrorMessage | ToastMessage;

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const viewportEl = document.getElementById('viewport') as HTMLDivElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const btnFit = document.getElementById('btn-fit') as HTMLButtonElement;
const btnWireframe = document.getElementById('btn-wireframe') as HTMLButtonElement;
const btnGrid = document.getElementById('btn-grid') as HTMLButtonElement;
const menuEl = document.getElementById('mc-menu') as HTMLDivElement;
const toastEl = document.getElementById('mc-toast') as HTMLDivElement;

const contextMenu = createMenu(menuEl);

// Set by anything that changes what a frame would look like. The render loop
// otherwise repaints an unchanging scene forever, which on a laptop is a GPU
// spinning on a tab nobody is looking at. Declared before the first
// syncBackground() call below, which invalidates; only the bundler's rewrite
// of top-level `let` to `var` hid that ordering before.
let needsRender = true;

function invalidate(): void {
  needsRender = true;
}

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(50, aspect(), 0.01, 10000);
camera.position.set(1, 1, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(viewportEl.clientWidth, viewportEl.clientHeight);
viewportEl.appendChild(renderer.domElement);
syncBackground();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

// Lighting: a soft hemisphere fill plus a directional key light so the mesh
// reads with some shading regardless of orientation.
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(1, 2, 1.5);
scene.add(dirLight);

let gridHelper: THREE.GridHelper | null = null;
let mesh: THREE.Mesh | null = null;
let boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
let showGridSetting = true;
let wireframeActive = false;
let fileName = '';
let filePath = '';
let currentTheme = document.body.dataset.mcTheme || 'auto';
let dimensionsText = '';
let triangleCount = 0;

let toastTimer = 0;
function toast(text: string, ms = 1600): void {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

function aspect(): number {
  return viewportEl.clientWidth / Math.max(1, viewportEl.clientHeight);
}

// The viewport background follows `markcopy.theme` the same way the Markdown and
// PDF previews do: the host writes the setting to body[data-mc-theme], the
// stylesheet in stlEditor.ts maps it to --mc-stl-bg, and 'auto' resolves that to
// the VS Code editor background.
function syncBackground(): void {
  const styles = getComputedStyle(document.body);
  const bg =
    styles.getPropertyValue('--mc-stl-bg').trim() ||
    styles.getPropertyValue('--vscode-editor-background').trim() ||
    '#1e1e1e';
  try {
    renderer.setClearColor(new THREE.Color(bg), 1);
  } catch {
    // An unparseable color would otherwise leave the canvas mid-render; fall
    // back rather than lose the model over a theme value.
    renderer.setClearColor(new THREE.Color('#1e1e1e'), 1);
  }
  invalidate();
}

function setGridVisible(visible: boolean): void {
  if (gridHelper) {
    gridHelper.visible = visible;
  }
  btnGrid.classList.toggle('active', visible);
  invalidate();
}

function rebuildGrid(footprint: number): void {
  if (gridHelper) {
    scene.remove(gridHelper);
    gridHelper.dispose();
  }
  const size = Math.max(footprint * 2, 0.01);
  const divisions = 20;
  gridHelper = new THREE.GridHelper(size, divisions);
  gridHelper.position.set(boundingSphere.center.x, 0, boundingSphere.center.z);
  scene.add(gridHelper);
  setGridVisible(showGridSetting);
}

// Frames the model from `preset`'s direction at the distance that fits its
// bounding sphere. 'isometric' is the angle a freshly loaded model opens at.
function fitView(preset: ViewPreset = 'isometric'): void {
  const fovRadians = (camera.fov * Math.PI) / 180;
  const distance = (boundingSphere.radius * 1.6) / Math.sin(fovRadians / 2);
  const [dx, dy, dz] = VIEW_PRESETS[preset];
  const direction = new THREE.Vector3(dx, dy, dz).normalize();
  camera.position.copy(boundingSphere.center).addScaledVector(direction, distance);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 100 + boundingSphere.radius * 4;
  camera.updateProjectionMatrix();
  controls.target.copy(boundingSphere.center);
  controls.update();
  invalidate();
}

// The toolbar buttons and the menu's checkboxes share these, so the two never
// disagree about what is on.
function setWireframe(on: boolean): void {
  wireframeActive = on;
  btnWireframe.classList.toggle('active', on);
  if (mesh) {
    (mesh.material as THREE.MeshStandardMaterial).wireframe = on;
  }
  invalidate();
}

function toggleWireframe(): void {
  setWireframe(!wireframeActive);
}

function toggleGrid(): void {
  showGridSetting = !showGridSetting;
  setGridVisible(showGridSetting);
}

function showError(message: string): void {
  statsEl.textContent = message;
  // Wrap: an error sentence under `white-space: pre` would otherwise run off the
  // side of the viewport. The stats readout still needs pre for its own newline.
  statsEl.style.whiteSpace = 'pre-wrap';
  statsEl.style.maxWidth = 'calc(100vw - 32px)';
}

function showStats(text: string): void {
  statsEl.textContent = text;
  statsEl.style.whiteSpace = 'pre';
  statsEl.style.maxWidth = '';
}

function loadModel(msg: LoadMessage): void {
  fileName = msg.name;
  filePath = msg.path ?? '';
  const raw = toBytes(msg.bytes);

  // An empty payload means the file never made it across, which is a different
  // problem from a bad file; do not report it as a malformed STL.
  if (raw.byteLength === 0) {
    showError(
      `MarkCopy received no data for ${msg.name}. The file is empty, or the preview could not decode the message.`,
    );
    return;
  }

  // Guard against malformed/malicious STL before allocating: a binary header can
  // over-claim its triangle count and make STLLoader allocate tens of GB.
  const check = checkStl(raw);
  if (!check.ok) {
    showError(check.reason ?? 'Could not load this STL file.');
    return;
  }

  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;

  const loader = new STLLoader();
  let geometry: THREE.BufferGeometry;
  try {
    geometry = loader.parse(buffer);
  } catch (err) {
    showError(`Could not parse this STL file (${String(err)}).`);
    return;
  }
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  // Center the model in X/Z and rest its bottom on the y = 0 plane, so the
  // grid drawn at y = 0 always sits directly under the model.
  geometry.translate(-center.x, -box.min.y, -center.z);
  geometry.computeBoundingSphere();
  geometry.computeVertexNormals();

  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(msg.meshColor || '#8ab4f8'),
    metalness: 0.1,
    roughness: 0.7,
    wireframe: wireframeActive,
  });
  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  boundingSphere = (geometry.boundingSphere as THREE.Sphere).clone();
  showGridSetting = msg.showGrid !== false;
  rebuildGrid(Math.max(size.x, size.z));
  fitView();

  triangleCount = geometry.attributes.position.count / 3;
  dimensionsText = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
  showStats(`${triangleCount.toLocaleString()} triangles\n${dimensionsText}`);
  invalidate();
}

btnFit.addEventListener('click', () => {
  if (mesh) {
    fitView();
  }
});

btnWireframe.addEventListener('click', toggleWireframe);
btnGrid.addEventListener('click', toggleGrid);

// ---------------------------------------------------------------------------
// Copy and save actions
// ---------------------------------------------------------------------------
// WebGL clears the drawing buffer once a frame is presented, so a canvas read
// later is blank. Render and read in the same task instead of paying for
// preserveDrawingBuffer on every frame. toBlob snapshots the bitmap when it is
// called, so the async encode that follows is safe.
function snapshotBlob(): Promise<Blob | null> {
  renderer.render(scene, camera);
  return new Promise((resolve) => renderer.domElement.toBlob(resolve, 'image/png'));
}

async function copyViewPng(): Promise<void> {
  if (!mesh) {
    toast('No model to copy');
    return;
  }
  try {
    const blob = await snapshotBlob();
    if (blob && navigator.clipboard && 'write' in navigator.clipboard) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied view as PNG');
    } else {
      toast('PNG copy not supported here');
    }
  } catch {
    toast('Could not read the current view');
  }
}

function saveViewPng(): void {
  if (!mesh) {
    toast('No model to save');
    return;
  }
  try {
    renderer.render(scene, camera);
    // The host owns the save dialog and the write, so the view crosses as a
    // base64 payload; one PNG is small enough for postMessage.
    const data = renderer.domElement.toDataURL('image/png');
    vscode.postMessage({
      type: 'saveFrame',
      data: data.slice(data.indexOf(',') + 1),
      name: viewFileName(fileName),
    });
  } catch {
    toast('Could not read the current view');
  }
}

function copyText(text: string, label: string): void {
  if (!text) {
    toast('Nothing to copy');
    return;
  }
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  if (!ok) {
    void navigator.clipboard?.writeText(text);
  }
  toast(label);
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
const VIEW_LABELS: Array<[string, ViewPreset]> = [
  ['Front', 'front'],
  ['Back', 'back'],
  ['Left', 'left'],
  ['Right', 'right'],
  ['Top', 'top'],
  ['Bottom', 'bottom'],
  ['Isometric', 'isometric'],
];

function buildMenu(): MenuEntry[] {
  const noModel = !mesh;
  return [
    { kind: 'item', label: 'Copy View as PNG', run: () => void copyViewPng(), disabled: noModel },
    { kind: 'item', label: 'Save View as PNG…', run: saveViewPng, disabled: noModel },
    { kind: 'divider' },
    {
      kind: 'submenu',
      label: 'Copy as',
      entries: [
        { kind: 'item', label: 'File Name', run: () => copyText(fileName, 'Copied file name') },
        { kind: 'item', label: 'Full Path', run: () => copyText(filePath, 'Copied path') },
        {
          kind: 'item',
          label: 'Dimensions',
          run: () => copyText(dimensionsText, 'Copied dimensions'),
          disabled: noModel,
        },
        {
          kind: 'item',
          label: 'Triangle Count',
          run: () => copyText(String(triangleCount), 'Copied triangle count'),
          disabled: noModel,
        },
      ],
    },
    { kind: 'divider' },
    {
      kind: 'submenu',
      label: 'View',
      entries: [
        { kind: 'item', label: 'Fit View', run: () => fitView(), disabled: noModel },
        ...VIEW_LABELS.map(([label, preset]): MenuEntry => ({
          kind: 'item',
          label,
          run: () => fitView(preset),
          disabled: noModel,
        })),
        { kind: 'divider' },
        { kind: 'checkbox', label: 'Wireframe', checked: wireframeActive, run: toggleWireframe },
        { kind: 'checkbox', label: 'Grid', checked: showGridSetting, run: toggleGrid },
      ],
    },
    { kind: 'divider' },
    { kind: 'submenu', label: 'Preferences', entries: themeItems() },
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'Open in Default App',
      run: () => vscode.postMessage({ type: 'openExternal' }),
    },
    {
      kind: 'item',
      label: revealLabel(),
      run: () => vscode.postMessage({ type: 'revealInOS' }),
    },
  ];
}

// OrbitControls pans on a right-button drag, and `contextmenu` fires at mouseup
// on Windows but at mousedown elsewhere, so the menu has to wait to see whether
// the button was dragged. See createRightClickGate in stlInfo.ts.
const rightClick = createRightClickGate();
let pendingMenu: { x: number; y: number } | null = null;

function openMenu(pageX: number, pageY: number): void {
  contextMenu.show(pageX, pageY, buildMenu());
}

// While the menu is open, a press outside it should only dismiss it. Capture on
// the viewport runs before OrbitControls' listener on the canvas inside it.
viewportEl.addEventListener(
  'pointerdown',
  (e) => {
    if (contextMenu.isOpen() && !contextMenu.owns(e.target)) {
      contextMenu.hide();
      e.stopPropagation();
      rightClick.cancel();
      return;
    }
    if (e.button === 2) {
      rightClick.down(e.clientX, e.clientY);
    }
  },
  true,
);

window.addEventListener('pointermove', (e) => rightClick.move(e.clientX, e.clientY), true);
window.addEventListener(
  'pointerup',
  (e) => {
    if (e.button !== 2) {
      return;
    }
    if (rightClick.up(e.clientX, e.clientY, e.timeStamp) === 'open' && pendingMenu) {
      openMenu(pendingMenu.x, pendingMenu.y);
    }
    pendingMenu = null;
  },
  true,
);
window.addEventListener(
  'pointercancel',
  () => {
    rightClick.cancel();
    pendingMenu = null;
  },
  true,
);

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const verdict = rightClick.contextmenu(e.timeStamp);
  if (verdict === 'open') {
    openMenu(e.pageX, e.pageY);
  } else if (verdict === 'defer') {
    pendingMenu = { x: e.pageX, y: e.pageY };
  }
});

// The Auto/Light/Dark/Green radio group, identical to the other previews'
// Theme submenu; picking one persists the shared markcopy.theme.
function themeItems(): MenuEntry[] {
  const entry = (label: string, value: string): MenuEntry => ({
    kind: 'radio',
    label,
    checked: currentTheme === value,
    run: () => setTheme(value),
  });
  return [
    {
      kind: 'submenu',
      label: 'Theme',
      entries: [
        entry('Auto', 'auto'),
        entry('Light', 'light'),
        entry('Dark', 'dark'),
        entry('Green on black', 'green'),
      ],
    },
  ];
}

function setTheme(value: string): void {
  applyTheme(value);
  vscode.postMessage({ type: 'updateSetting', key: 'theme', value });
}

function applyTheme(value: string): void {
  currentTheme = value;
  document.body.dataset.mcTheme = value;
  syncBackground();
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (!fromHost(event)) {
    return;
  }
  const msg = event.data;
  if (msg?.type === 'load') {
    loadModel(msg);
  } else if (msg?.type === 'setTheme') {
    applyTheme(msg.value);
  } else if (msg?.type === 'error') {
    fileName = msg.name ?? fileName;
    filePath = msg.path ?? filePath;
    showError(msg.message);
  } else if (msg?.type === 'toast') {
    toast(msg.message);
  }
});

window.addEventListener('resize', () => {
  camera.aspect = aspect();
  camera.updateProjectionMatrix();
  renderer.setSize(viewportEl.clientWidth, viewportEl.clientHeight);
  invalidate();
});

function animate(): void {
  requestAnimationFrame(animate);
  // OrbitControls returns true while damping is still easing the camera, so the
  // loop keeps painting through the tail of a drag and then stops.
  if (controls.update() || needsRender) {
    renderer.render(scene, camera);
    needsRender = false;
  }
}
animate();

vscode.postMessage({ type: 'ready' });
