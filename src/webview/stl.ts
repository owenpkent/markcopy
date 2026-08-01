// Browser-side STL viewer for the MarkCopy STL preview. Bundled on its own into
// media/stl.js (see esbuild.web.js) so Three.js only loads when an .stl file is
// opened, never for the Markdown, CSV, or PDF previews.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { checkStl, toBytes } from './stlInfo';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

interface LoadMessage {
  type: 'load';
  name: string;
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

type HostMessage = LoadMessage | ThemeMessage;

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const viewportEl = document.getElementById('viewport') as HTMLDivElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const btnFit = document.getElementById('btn-fit') as HTMLButtonElement;
const btnWireframe = document.getElementById('btn-wireframe') as HTMLButtonElement;
const btnGrid = document.getElementById('btn-grid') as HTMLButtonElement;

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
}

function setGridVisible(visible: boolean): void {
  if (gridHelper) {
    gridHelper.visible = visible;
  }
  btnGrid.classList.toggle('active', visible);
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

function fitView(): void {
  const fovRadians = (camera.fov * Math.PI) / 180;
  const distance = (boundingSphere.radius * 1.6) / Math.sin(fovRadians / 2);
  const direction = new THREE.Vector3(1, 0.75, 1).normalize();
  camera.position.copy(boundingSphere.center).addScaledVector(direction, distance);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 100 + boundingSphere.radius * 4;
  camera.updateProjectionMatrix();
  controls.target.copy(boundingSphere.center);
  controls.update();
}

function showError(message: string): void {
  statsEl.textContent = message;
}

function loadModel(msg: LoadMessage): void {
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

  const triangles = geometry.attributes.position.count / 3;
  statsEl.textContent =
    `${triangles.toLocaleString()} triangles\n` +
    `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
}

let wireframeActive = false;

btnFit.addEventListener('click', () => {
  if (mesh) {
    fitView();
  }
});

btnWireframe.addEventListener('click', () => {
  wireframeActive = !wireframeActive;
  btnWireframe.classList.toggle('active', wireframeActive);
  if (mesh) {
    (mesh.material as THREE.MeshStandardMaterial).wireframe = wireframeActive;
  }
});

btnGrid.addEventListener('click', () => {
  showGridSetting = !showGridSetting;
  setGridVisible(showGridSetting);
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  if (msg?.type === 'load') {
    loadModel(msg);
  } else if (msg?.type === 'setTheme') {
    document.body.dataset.mcTheme = msg.value;
    syncBackground();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = aspect();
  camera.updateProjectionMatrix();
  renderer.setSize(viewportEl.clientWidth, viewportEl.clientHeight);
});

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

vscode.postMessage({ type: 'ready' });
