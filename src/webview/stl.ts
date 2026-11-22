// Browser-side 3D viewer for the MarkCopy STL, 3MF, GLB and STEP previews.
// Bundled on its own into media/stl.js (see esbuild.web.js) so Three.js only
// loads when a model is opened, never for the Markdown, CSV, or PDF previews.
//
// Every model stays in its file's own coordinates. One group, `modelRoot`,
// carries the turn that makes the file's up axis the viewer's and the shift that
// stands the model on the grid. That is what lets the rest speak in the file's
// numbers: a section is "Z = 12" as the design has it, the grid lines fall on
// the file's whole millimetres, a second model overlays the first where their
// coordinates agree, and a sliced print sits where the bed puts it.
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
import { ThreeMfError, UNIT_LABELS, read3mf } from './threeMf';
import { GlbError, readGlb } from './glb';
import { StepError, loadStepEngine, readStep } from './step';
import { formatDuration, parseGcode, readSliceInfo, type Toolpath } from './gcode';
import {
  AXIS_NAMES,
  bounds,
  fitsBed,
  fmt,
  formatSectionReport,
  gridStep,
  lineSpans,
  parseBedSize,
  planeAxes,
  sectionSegments,
  spanEdges,
  unionBounds,
  type Axis,
  type Bounds,
} from './meshSection';
import { createSectionView, type SectionOutline } from './stlSection';
import {
  HIDDEN,
  HIGHLIGHT,
  NORMAL,
  buildPartModel,
  drawGroups,
  findLeaf,
  leafBounds,
  partsMarkdown,
  stlPartTree,
  type DrawState,
  type PartItem,
  type PartModel,
  type PartNode,
} from './parts';
import { createPartsPanel } from './partsPanel';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

type Format = 'stl' | '3mf' | 'glb' | 'step';

interface LoadMessage {
  type: 'load';
  // Absent from an older host: STL.
  format?: Format;
  name: string;
  // The full file system path, for the menu's Copy as > Full Path.
  path: string;
  // Base64 from the extension host, but typed loosely because the transport can
  // reshape a payload; toBytes() normalizes whatever arrives. See stlInfo.ts.
  bytes: unknown;
  showGrid: boolean;
  meshColor: string;
  upAxis?: string;
  showBed?: boolean;
  bedSize?: string;
  // The models the host offers under Compare with, as the labels to show.
  siblings?: unknown;
}

// A second model to lay over the first (Compare with).
interface CompareMessage {
  type: 'compare';
  format?: Format;
  name: string;
  bytes: unknown;
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

// The host's confirmation after Save View as PNG writes the file, or its reason
// for refusing a model to compare.
interface ToastMessage {
  type: 'toast';
  message: string;
}

type HostMessage = LoadMessage | CompareMessage | ThemeMessage | ErrorMessage | ToastMessage;

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewportEl = byId<HTMLDivElement>('viewport');
const statsEl = byId<HTMLDivElement>('stats');
const btnFit = byId<HTMLButtonElement>('btn-fit');
const btnWireframe = byId<HTMLButtonElement>('btn-wireframe');
const btnGrid = byId<HTMLButtonElement>('btn-grid');
const btnSection = byId<HTMLButtonElement>('btn-section');
const btnParts = byId<HTMLButtonElement>('btn-parts');
const partsEl = byId<HTMLDivElement>('parts');
const menuEl = byId<HTMLDivElement>('mc-menu');
const toastEl = byId<HTMLDivElement>('mc-toast');
const sectionEl = byId<HTMLDivElement>('section');
const sectionCanvas = byId<HTMLCanvasElement>('section-canvas');
const sectionRange = byId<HTMLInputElement>('section-range');
const sectionNumber = byId<HTMLInputElement>('section-value');
const sectionAxisButtons = ['section-x', 'section-y', 'section-z'].map((id) =>
  byId<HTMLButtonElement>(id),
);
const layersEl = byId<HTMLDivElement>('layers');
const layerRange = byId<HTMLInputElement>('layer-range');
const layerLabel = byId<HTMLSpanElement>('layer-label');
const layerOnly = byId<HTMLInputElement>('layer-only');

const partsPanel = createPartsPanel(
  {
    list: byId<HTMLDivElement>('parts-list'),
    count: byId<HTMLSpanElement>('parts-count'),
    showAll: byId<HTMLButtonElement>('parts-show-all'),
  },
  {
    onChange: () => applyParts(),
    onIsolate: (item) => frameParts(item),
  },
);
byId('parts-close').addEventListener('click', () => setPartsOpen(false));

const contextMenu = createMenu(menuEl);
const sectionView = createSectionView(sectionCanvas, byId<HTMLDivElement>('section-readout'));

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
// The section cut clips each model's own material, not the grid or the bed.
renderer.localClippingEnabled = true;
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

// Holds the models in file coordinates; see the note at the top of the file.
const modelRoot = new THREE.Group();
scene.add(modelRoot);
// Grid and bed outline, in viewer coordinates on the y = 0 plane.
const floor = new THREE.Group();
scene.add(floor);

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
interface Model {
  name: string;
  kind: 'mesh' | 'toolpath';
  object: THREE.Mesh | THREE.LineSegments;
  // A mesh's three looks, drawn through geometry groups (see applyParts): as is,
  // hidden, and tinted for the selected part. `object.material` is `base`, or all
  // three as an array while a part is hidden or selected. Wireframe and the
  // section's clipping are set on every one.
  materials?: {
    base: THREE.MeshStandardMaterial;
    hidden: THREE.MeshStandardMaterial;
    highlight: THREE.MeshStandardMaterial;
  };
  // The parts tree: leaves are triangle ranges of `positions`. Absent for a
  // toolpath.
  parts?: PartNode;
  // A mesh's triangles, nine floats each, in file coordinates: what the section
  // tool cuts. Empty for a toolpath.
  positions: Float32Array;
  box: Bounds;
  // The model's size along its file's X, Y and Z, in its file's unit, as shown.
  // Taken when the file is read: a compared model is rescaled to the first
  // model's unit afterwards, and its readout should still be its own.
  dims: string;
  triangles: number;
  // The unit as shown ('mm'), or '' when the format has none (STL).
  unit: string;
  mmPerUnit: number;
  // 3MF and G-code are Z-up by definition, and a GLB is turned Z-up when it is
  // read; an STL and a STEP file follow markcopy.stl.upAxis.
  fixedZUp: boolean;
  // CSS color that stands for this model in the readouts and the section.
  swatch: string;
  toolpath?: Toolpath;
  // The slicer's print summary, a line per fact, for a sliced print file.
  summary?: string[];
}

type Built = Model | string;

const MM_PER_UNIT: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

// The second model of a comparison, picked to stand apart from the default
// mesh blue and from most colors a 3MF brings.
const OTHER_COLOR = '#f0883e';
const SECTION_COLOR = 0xffd33d;

let primary: Model | null = null;
let other: Model | null = null;
let siblings: string[] = [];
let showGridSetting = true;
let showBedSetting = false;
let bedSizeSetting = '256x256x256';
let upAxis: 'z' | 'y' = 'z';
let wireframeActive = false;
let fileName = '';
let filePath = '';
let currentTheme = document.body.dataset.mcTheme || 'auto';
// The model's size once turned upright, in viewer axes (y is up).
const worldSize = new THREE.Vector3(1, 1, 1);
const boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
let floorNote = '';

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
function backgroundColor(): string {
  const styles = getComputedStyle(document.body);
  return (
    styles.getPropertyValue('--mc-stl-bg').trim() ||
    styles.getPropertyValue('--vscode-editor-background').trim() ||
    '#1e1e1e'
  );
}

function syncBackground(): void {
  try {
    renderer.setClearColor(new THREE.Color(backgroundColor()), 1);
  } catch {
    // An unparseable color would otherwise leave the canvas mid-render; fall
    // back rather than lose the model over a theme value.
    renderer.setClearColor(new THREE.Color('#1e1e1e'), 1);
  }
  invalidate();
}

// Guard against malformed/malicious STL before allocating: a binary header can
// over-claim its triangle count and make STLLoader allocate tens of GB.
function buildStl(name: string, raw: Uint8Array, color: THREE.Color, swatch: string): Built {
  const check = checkStl(raw);
  if (!check.ok) {
    return check.reason ?? 'Could not load this STL file.';
  }
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  try {
    // STL carries no unit, so the readout gives none; the grid and the bed
    // take it as millimetres, as every slicer does.
    const geometry = new STLLoader().parse(buffer);
    const positions = geometry.getAttribute('position').array as Float32Array;
    // Never the file's own colors: an STL can carry a color attribute (a Magics
    // header makes the loader add one), and an STL has always been drawn in
    // markcopy.stl.meshColor.
    return meshModel(name, geometry, positions, color, swatch, {
      unit: '',
      mmPerUnit: 1,
      fixedZUp: false,
      colored: false,
      parts: stlPartTree(geometry.groups, geometry.userData.groupNames, positions.length / 9),
    });
  } catch (err) {
    return `Could not parse this STL file (${String(err)}).`;
  }
}

// read3mf bounds every allocation itself (see threeMf.ts). A sliced print file
// comes back as G-code rather than a model, and is drawn as its toolpaths.
function build3mf(name: string, raw: Uint8Array, color: THREE.Color, swatch: string): Built {
  try {
    const content = read3mf(raw, { fallbackColor: [color.r, color.g, color.b] });
    if (content.kind === 'sliced') {
      return toolpathModel(name, content.gcode, content.plates, content.sliceInfo);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(content.positions, 3));
    if (content.colors) {
      geometry.setAttribute('color', new THREE.BufferAttribute(content.colors, 3));
    }
    return meshModel(name, geometry, content.positions, color, swatch, {
      unit: UNIT_LABELS[content.unit] ?? content.unit,
      mmPerUnit: MM_PER_UNIT[content.unit] ?? 1,
      fixedZUp: true,
      colored: content.colors !== null,
      parts: content.parts,
    });
  } catch (err) {
    return err instanceof ThreeMfError
      ? err.message
      : `Could not read this 3MF file (${String(err)}).`;
  }
}

function meshModel(
  name: string,
  geometry: THREE.BufferGeometry,
  // The geometry's own triangles, nine floats each, in file coordinates.
  positions: Float32Array,
  color: THREE.Color,
  swatch: string,
  // `colored`: whether the geometry's per-vertex colors are the file's own and
  // are to be drawn.
  // `keepNormals`: the geometry's normals are the file's own smooth ones (STEP,
  // GLB) and are kept. Otherwise they are worked out from the triangles: an STL
  // always gets that, since STLLoader attaches facet normals that a file may
  // leave zero or wrong.
  about: {
    unit: string;
    mmPerUnit: number;
    fixedZUp: boolean;
    colored: boolean;
    keepNormals?: boolean;
    parts: PartNode;
  },
): Model {
  const { unit, mmPerUnit, fixedZUp, colored: vertexColors } = about;
  if (!about.keepNormals || !geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }
  // A colored 3MF carries its colors per vertex, with markcopy.stl.meshColor
  // already filled in where the file gives none, so the material stays white.
  const material = new THREE.MeshStandardMaterial({
    color: vertexColors ? new THREE.Color(0xffffff) : color,
    vertexColors,
    metalness: 0.1,
    roughness: 0.7,
    wireframe: wireframeActive,
  });
  const hidden = material.clone();
  hidden.visible = false;
  const highlight = material.clone();
  tint(highlight);
  return {
    name,
    kind: 'mesh',
    object: new THREE.Mesh(geometry, material),
    materials: { base: material, hidden, highlight },
    parts: about.parts,
    positions,
    box: bounds(positions),
    triangles: Math.floor(positions.length / 9),
    unit,
    mmPerUnit,
    fixedZUp,
    swatch,
    dims: sizeText(bounds(positions), unit),
  };
}

// The selected part's tint: the theme's accent as a glow over its own color.
function tint(material: THREE.MeshStandardMaterial): void {
  const accent = getComputedStyle(document.body).getPropertyValue('--mc-accent').trim();
  try {
    material.emissive.set(accent || '#4493f8');
  } catch {
    material.emissive.set('#4493f8');
  }
  material.emissiveIntensity = 0.55;
}

// Colors for the slicer's feature names, close to the ones Bambu Studio and
// OrcaSlicer use for the same lines. First match wins, so the more specific
// name comes first.
const FEATURE_COLORS: Array<[RegExp, number]> = [
  [/support interface/i, 0x1f8a3b],
  [/support/i, 0x3fd65b],
  [/overhang/i, 0x4f6bed],
  [/outer|external/i, 0xff7d38],
  [/inner|perimeter|wall/i, 0xf2c94c],
  [/top/i, 0xf04a4a],
  [/bottom/i, 0x7a6ff0],
  [/internal solid|solid infill/i, 0xa35ad6],
  [/bridge/i, 0x4d9ad9],
  [/gap/i, 0x9aa0a6],
  [/infill/i, 0xc0453a],
  [/skirt|brim/i, 0x00a085],
  [/prime|wipe/i, 0x8fd18a],
];

function toolpathModel(
  name: string,
  gcode: string,
  plates: number,
  sliceInfo: string | undefined,
): Built {
  const path = parseGcode(gcode);
  if (path.segments === 0) {
    return 'This sliced print file has no extrusion moves to show.';
  }
  const palette = path.features.map((feature) => {
    const match = FEATURE_COLORS.find(([pattern]) => pattern.test(feature));
    return new THREE.Color(match ? match[1] : 0x8a8f98);
  });
  // Two vertices per segment, both the color of the segment's feature.
  const colors = new Float32Array(path.segments * 6);
  for (let i = 0; i < path.segments; i++) {
    const c = palette[path.feature[i]] ?? palette[0];
    colors.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(path.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const info = sliceInfo === undefined ? { filaments: [] } : readSliceInfo(sliceInfo);
  const facts: string[] = [];
  if (info.printSeconds !== undefined) {
    facts.push(formatDuration(info.printSeconds));
  }
  if (info.weightGrams !== undefined) {
    facts.push(`${fmt(info.weightGrams)} g`);
  }
  const materials = [...new Set(info.filaments.map((f) => f.type).filter(Boolean))];
  if (materials.length > 0) {
    facts.push(materials.join(', '));
  }
  const summary = [`Sliced print${plates > 1 ? `, plate 1 of ${plates}` : ''}`];
  if (facts.length > 0) {
    summary.push(facts.join(' · '));
  }
  summary.push(
    `${path.layerEnd.length.toLocaleString()} layers, ${path.segments.toLocaleString()} moves` +
      (path.truncated ? ' (more than the preview draws; the rest is left out)' : ''),
  );
  return {
    name,
    kind: 'toolpath',
    object: new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true })),
    positions: new Float32Array(0),
    box: { min: path.min, max: path.max },
    dims: sizeText({ min: path.min, max: path.max }, 'mm'),
    triangles: 0,
    unit: 'mm',
    mmPerUnit: 1,
    fixedZUp: true,
    swatch: '#ff7d38',
    toolpath: path,
    summary,
  };
}

// A GLB is read by three's GLTFLoader after glb.ts has refused what it cannot
// show and bounded the triangle count (see glb.ts). It comes back Z-up, with
// every node's transform and each material's color baked in, so it is a single
// geometry like a 3MF's. glTF fixes its up axis, so markcopy.stl.upAxis does not
// apply (fixedZUp). glTF's unit is the metre but files rarely mean it, so the
// readout is unitless like an STL's.
async function buildGlb(
  name: string,
  raw: Uint8Array,
  color: THREE.Color,
  swatch: string,
): Promise<Built> {
  try {
    const content = await readGlb(raw, { fallbackColor: [color.r, color.g, color.b] });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(content.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(content.colors, 3));
    if (content.normals) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(content.normals, 3));
    }
    return meshModel(name, geometry, content.positions, color, swatch, {
      unit: '',
      mmPerUnit: 1,
      fixedZUp: true,
      colored: true,
      keepNormals: true,
      parts: content.parts,
    });
  } catch (err) {
    return err instanceof GlbError ? err.message : `Could not read this GLB file (${String(err)}).`;
  }
}

// A STEP file is tessellated by the Open CASCADE engine (step.ts), started
// once per webview. The engine is asked for millimetres. STEP does not fix an up
// axis (CAD systems differ: SOLIDWORKS defaults to Y-up), so the model follows
// markcopy.stl.upAxis like an STL, Z-up by default.
async function buildStep(
  name: string,
  raw: Uint8Array,
  color: THREE.Color,
  swatch: string,
): Promise<Built> {
  try {
    showProgress(`Loading STEP engine…`);
    const engine = await loadStepEngine();
    showProgress(`Reading ${name}…`);
    // Let that paint before the tessellation holds the thread.
    await new Promise((resolve) => window.setTimeout(resolve, 16));
    const content = readStep(engine, raw, { fallbackColor: [color.r, color.g, color.b] });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(content.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(content.colors, 3));
    if (content.normals) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(content.normals, 3));
    }
    return meshModel(name, geometry, content.positions, color, swatch, {
      unit: 'mm',
      mmPerUnit: 1,
      fixedZUp: false,
      colored: content.colored,
      keepNormals: true,
      parts: content.parts,
    });
  } catch (err) {
    return err instanceof StepError
      ? err.message
      : `Could not read this STEP file (${String(err)}).`;
  }
}

// The status line while a model is read, or the toast when it is a comparison.
let progress: (text: string) => void = (text) => showStats([text]);
function showProgress(text: string): void {
  progress(text);
}

function parseColor(css: string): THREE.Color {
  try {
    return new THREE.Color(css);
  } catch {
    return new THREE.Color('#8ab4f8');
  }
}

async function build(
  format: Format | undefined,
  name: string,
  raw: Uint8Array,
  css: string,
): Promise<Built> {
  const color = parseColor(css);
  switch (format) {
    case '3mf':
      return build3mf(name, raw, color, css);
    case 'glb':
      return buildGlb(name, raw, color, css);
    case 'step':
      return buildStep(name, raw, color, css);
    default:
      return buildStl(name, raw, color, css);
  }
}

function disposeModel(model: Model): void {
  modelRoot.remove(model.object);
  model.object.geometry.dispose();
  if (model.materials) {
    for (const material of Object.values(model.materials)) {
      material.dispose();
    }
  } else {
    (model.object.material as THREE.Material).dispose();
  }
}

// The material a mesh is drawn with when nothing is hidden or selected.
function meshMaterial(model: Model): THREE.MeshStandardMaterial | null {
  return model.materials?.base ?? null;
}

// Every look of a mesh, for what has to hold for all of them (wireframe, the
// section's clipping).
function eachMaterial(model: Model, apply: (material: THREE.MeshStandardMaterial) => void): void {
  if (model.materials) {
    apply(model.materials.base);
    apply(model.materials.hidden);
    apply(model.materials.highlight);
  }
}

function models(): Model[] {
  return [primary, other].filter((m): m is Model => m !== null);
}

// ---------------------------------------------------------------------------
// Placement, grid and bed
// ---------------------------------------------------------------------------
function zUp(): boolean {
  return primary?.fixedZUp === true || upAxis === 'z';
}

function sceneBox(): Bounds {
  if (!primary) {
    return { min: [0, 0, 0], max: [1, 1, 1] };
  }
  return other ? unionBounds(primary.box, other.box) : primary.box;
}

// Turn the file's up axis to the viewer's (+Y), centre the models over the
// origin and rest their lowest point on y = 0, where the grid is drawn.
function place(): void {
  const { min, max } = sceneBox();
  const cx = (min[0] + max[0]) / 2;
  if (zUp()) {
    // A quarter turn about X takes file (x, y, z) to viewer (x, z, -y).
    modelRoot.rotation.set(-Math.PI / 2, 0, 0);
    modelRoot.position.set(-cx, -min[2], (min[1] + max[1]) / 2);
    worldSize.set(max[0] - min[0], max[2] - min[2], max[1] - min[1]);
  } else {
    modelRoot.rotation.set(0, 0, 0);
    modelRoot.position.set(-cx, -min[1], -(min[2] + max[2]) / 2);
    worldSize.set(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }
  modelRoot.updateMatrixWorld(true);
  boundingSphere.center.set(0, worldSize.y / 2, 0);
  boundingSphere.radius = Math.max(worldSize.length() / 2, 1e-6);
  rebuildFloor();
  applySection();
  invalidate();
}

function lineSet(points: number[], color: number, opacity: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return new THREE.LineSegments(geometry, material);
}

// The grid is ruled in the file's own units at a fixed spacing (1, 5, 10 ...),
// a heavier line every tenth, and its lines fall on the file's whole numbers,
// so a square of it is a known size and the origin sits on a crossing. The bed
// outline is the printer's build area at true size.
function rebuildFloor(): void {
  for (const child of [...floor.children]) {
    floor.remove(child);
    const lines = child as THREE.LineSegments;
    lines.geometry.dispose();
    (lines.material as THREE.Material).dispose();
  }
  floorNote = '';
  if (!primary) {
    return;
  }
  const unit = primary.unit ? ` ${primary.unit}` : '';
  const ox = modelRoot.position.x;
  const oz = modelRoot.position.z;
  const foot = Math.max(worldSize.x, worldSize.z, 1e-6);
  let x0 = -worldSize.x / 2 - foot / 4;
  let x1 = worldSize.x / 2 + foot / 4;
  let z0 = -worldSize.z / 2 - foot / 4;
  let z1 = worldSize.z / 2 + foot / 4;

  const bedMm = showBedSetting ? parseBedSize(bedSizeSetting) : null;
  let bedNote = '';
  if (bedMm) {
    const scale = primary.mmPerUnit;
    const w = bedMm[0] / scale;
    const d = bedMm[1] / scale;
    const h = bedMm[2] / scale;
    // A sliced print has a real place on the bed (its coordinates are the
    // bed's); a model has none yet, so the bed is centred under it.
    const sliced = primary.kind === 'toolpath';
    const bx0 = sliced ? ox : -w / 2;
    const bz1 = sliced ? oz : d / 2;
    const bx1 = bx0 + w;
    const bz0 = bz1 - d;
    const { min, max } = primary.box;
    const fits = sliced
      ? min[0] >= -1e-6 && min[1] >= -1e-6 && max[0] <= w && max[1] <= d && max[2] <= h
      : fitsBed(
          [worldSize.x * scale, worldSize.z * scale, worldSize.y * scale],
          [bedMm[0], bedMm[1], bedMm[2]],
        );
    const color = fits ? 0x58a6ff : 0xf85149;
    const rect = (y: number) => [
      ...[bx0, y, bz0, bx1, y, bz0],
      ...[bx1, y, bz0, bx1, y, bz1],
      ...[bx1, y, bz1, bx0, y, bz1],
      ...[bx0, y, bz1, bx0, y, bz0],
    ];
    floor.add(lineSet(rect(0), color, 0.95));
    if (Number.isFinite(h)) {
      const posts = [
        ...[bx0, 0, bz0, bx0, h, bz0],
        ...[bx1, 0, bz0, bx1, h, bz0],
        ...[bx1, 0, bz1, bx1, h, bz1],
        ...[bx0, 0, bz1, bx0, h, bz1],
      ];
      floor.add(lineSet([...rect(h), ...posts], color, 0.3));
    }
    x0 = Math.min(x0, bx0);
    x1 = Math.max(x1, bx1);
    z0 = Math.min(z0, bz0);
    z1 = Math.max(z1, bz1);
    const size = bedMm.filter(Number.isFinite).map(String).join(' × ');
    bedNote = `Bed ${size} mm: ${fits ? 'fits' : 'does not fit'}`;
  }

  const step = gridStep(Math.max(x1 - x0, z1 - z0), 40);
  const major = step * 10;
  // Out to the next heavy line on each side, counted from the file's origin.
  x0 = ox + Math.floor((x0 - ox) / major) * major;
  x1 = ox + Math.ceil((x1 - ox) / major) * major;
  z0 = oz + Math.floor((z0 - oz) / major) * major;
  z1 = oz + Math.ceil((z1 - oz) / major) * major;
  const nx = Math.round((x1 - x0) / step);
  const nz = Math.round((z1 - z0) / step);
  if (showGridSetting && nx <= 2000 && nz <= 2000) {
    const minor: number[] = [];
    const heavy: number[] = [];
    for (let k = 0; k <= nx; k++) {
      (k % 10 === 0 ? heavy : minor).push(x0 + k * step, 0, z0, x0 + k * step, 0, z1);
    }
    for (let k = 0; k <= nz; k++) {
      (k % 10 === 0 ? heavy : minor).push(x0, 0, z0 + k * step, x1, 0, z0 + k * step);
    }
    floor.add(lineSet(minor, 0x808080, 0.22));
    floor.add(lineSet(heavy, 0x808080, 0.6));
    floorNote = `Grid ${step}${unit}`;
  }
  if (bedNote) {
    floorNote = floorNote ? `${floorNote} · ${bedNote}` : bedNote;
  }
  btnGrid.classList.toggle('active', showGridSetting);
}

// Frames the model from `preset`'s direction at the distance that fits its
// bounding sphere. 'isometric' is the angle a freshly loaded model opens at.
function fitView(preset: ViewPreset = 'isometric'): void {
  const [dx, dy, dz] = VIEW_PRESETS[preset];
  frameSphere(boundingSphere.center, boundingSphere.radius, new THREE.Vector3(dx, dy, dz));
}

// Puts the camera `direction` away from `center`, far enough to hold a sphere of
// `radius`.
function frameSphere(center: THREE.Vector3, radius: number, direction: THREE.Vector3): void {
  const fovRadians = (camera.fov * Math.PI) / 180;
  // A narrow viewport (the section or parts panel open beside it) needs more
  // distance for the same sphere than a wide one.
  const narrow = Math.max(Math.min(1, aspect()), 0.2);
  const distance = (radius * 1.6) / Math.sin(fovRadians / 2) / narrow;
  camera.position.copy(center).addScaledVector(direction.clone().normalize(), distance);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 100 + radius * 4;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  invalidate();
}

// The toolbar buttons and the menu's checkboxes share these, so the two never
// disagree about what is on.
function setWireframe(on: boolean): void {
  wireframeActive = on;
  btnWireframe.classList.toggle('active', on);
  for (const model of models()) {
    eachMaterial(model, (material) => (material.wireframe = on));
  }
  invalidate();
}

function toggleWireframe(): void {
  setWireframe(!wireframeActive);
}

function toggleGrid(): void {
  showGridSetting = !showGridSetting;
  rebuildFloor();
  renderStats();
  invalidate();
}

function toggleBed(): void {
  showBedSetting = !showBedSetting;
  if (showBedSetting && !parseBedSize(bedSizeSetting)) {
    toast('markcopy.stl.bedSize is not a size such as 256x256x256', 3200);
  }
  rebuildFloor();
  renderStats();
  invalidate();
}

function setUpAxis(value: 'z' | 'y'): void {
  upAxis = value;
  vscode.postMessage({ type: 'updateSetting', key: 'stl.upAxis', value });
  if (primary) {
    place();
    fitView();
    renderStats();
  }
}

// ---------------------------------------------------------------------------
// Readout
// ---------------------------------------------------------------------------
type StatLine = string | { swatch: string; text: string };

function showError(message: string): void {
  statsEl.textContent = message;
  // Wrap: an error sentence under `white-space: pre` would otherwise run off the
  // side of the viewport. The stats readout still needs pre for its own newline.
  statsEl.style.whiteSpace = 'pre-wrap';
  statsEl.style.maxWidth = 'calc(100vw - 32px)';
}

function showStats(lines: StatLine[]): void {
  statsEl.textContent = '';
  statsEl.style.whiteSpace = 'pre';
  statsEl.style.maxWidth = '';
  lines.forEach((line, i) => {
    if (i > 0) {
      statsEl.append('\n');
    }
    if (typeof line === 'string') {
      statsEl.append(line);
      return;
    }
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = line.swatch;
    statsEl.append(swatch, line.text);
  });
}

/** The model's size along the file's own X, Y and Z, with its unit when it has one. */
function dimensions(model: Model): string {
  return model.dims;
}

function sizeText({ min, max }: Bounds, unit: string): string {
  const size = [0, 1, 2].map((a) => fmt(max[a] - min[a])).join(' × ');
  return unit ? `${size} ${unit}` : size;
}

function renderStats(): void {
  if (!primary) {
    return;
  }
  const lines: StatLine[] = [];
  if (primary.kind === 'toolpath') {
    lines.push(...(primary.summary ?? []), dimensions(primary));
  } else if (other) {
    for (const model of [primary, other]) {
      lines.push({
        swatch: model.swatch,
        text: `${model.name}  ${model.triangles.toLocaleString()} triangles  ${dimensions(model)}`,
      });
    }
  } else {
    lines.push(`${primary.triangles.toLocaleString()} triangles`, dimensions(primary));
  }
  if (floorNote) {
    lines.push(floorNote);
  }
  showStats(lines);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function loadModel(msg: LoadMessage): void {
  fileName = msg.name;
  filePath = msg.path ?? '';
  showGridSetting = msg.showGrid !== false;
  showBedSetting = msg.showBed === true;
  bedSizeSetting = typeof msg.bedSize === 'string' ? msg.bedSize : '256x256x256';
  upAxis = msg.upAxis === 'y' ? 'y' : 'z';
  compareGeneration++;
  siblings = Array.isArray(msg.siblings)
    ? msg.siblings.filter((s): s is string => typeof s === 'string').slice(0, 20)
    : [];
  const raw = toBytes(msg.bytes);

  // An empty payload means the file never made it across, which is a different
  // problem from a bad file; do not report it as a malformed STL.
  if (raw.byteLength === 0) {
    showError(
      `MarkCopy received no data for ${msg.name}. The file is empty, or the preview could not decode the message.`,
    );
    return;
  }

  const css = msg.meshColor || '#8ab4f8';
  if (!msg.format || msg.format === 'stl') {
    showPrimary(buildStl(msg.name, raw, parseColor(css), css));
    return;
  }
  // Unpacking and reading a slicer project, a GLB or a STEP file runs to
  // seconds for a few million triangles, all on this thread. Say so first, and
  // give the browser a frame to paint it before the parse holds the thread.
  progress = (text) => showStats([text]);
  showStats([`Reading ${msg.name}…`]);
  const format = msg.format;
  window.setTimeout(() => void build(format, msg.name, raw, css).then(showPrimary), 16);
}

function showPrimary(built: Built): void {
  if (typeof built === 'string') {
    showError(built);
    return;
  }
  compareGeneration++;
  closeSection();
  for (const model of models()) {
    disposeModel(model);
  }
  other = null;
  primary = built;
  modelRoot.add(built.object);
  setParts(built);

  const sliced = built.kind === 'toolpath';
  // A sliced print is a position on a bed, so the bed is part of the picture.
  showBedSetting = showBedSetting || sliced;
  btnWireframe.disabled = sliced;
  btnSection.disabled = sliced;
  layersEl.hidden = !sliced;
  if (built.toolpath) {
    layerRange.max = String(built.toolpath.layerEnd.length);
    layerOnly.checked = false;
    setLayer(built.toolpath.layerEnd.length);
  }
  place();
  fitView();
  renderStats();
}

function loadCompare(msg: CompareMessage): void {
  if (!primary || primary.kind !== 'mesh') {
    toast('Open a model first to compare against');
    return;
  }
  const raw = toBytes(msg.bytes);
  toast(`Reading ${msg.name}…`, 60000);
  progress = (text) => toast(text, 60000);
  const generation = ++compareGeneration;
  window.setTimeout(async () => {
    const built = await build(msg.format, msg.name, raw, OTHER_COLOR);
    if (generation !== compareGeneration) {
      // Superseded while it was being built (a newer comparison, Stop
      // Comparing, or a new primary model): drop it without showing anything.
      if (typeof built !== 'string') {
        built.object.geometry.dispose();
        (built.object.material as THREE.Material).dispose();
      }
      return;
    }
    if (typeof built === 'string') {
      toast(built, 5000);
      return;
    }
    if (built.kind !== 'mesh') {
      built.object.geometry.dispose();
      toast('A sliced print file has no model to compare', 4000);
      return;
    }
    setOther(built);
    toast(`Comparing with ${msg.name}`);
  }, 16);
}

// Counts comparison requests. A build is asynchronous (a STEP file waits for
// its engine), so each one remembers the number it started under and is
// discarded if that is no longer the latest.
let compareGeneration = 0;

function stopComparing(): void {
  compareGeneration++;
  setOther(null);
}

function setOther(model: Model | null): void {
  if (other) {
    disposeModel(other);
  }
  other = model;
  if (model && primary) {
    // Both models share one coordinate group, and the section and its numbers
    // read both position arrays in the first model's unit. A part exported in
    // centimetres beside the same part in millimetres would otherwise sit at a
    // tenth of the size and show as a difference that is not there.
    const ratio = model.mmPerUnit / primary.mmPerUnit;
    if (Number.isFinite(ratio) && ratio > 0 && ratio !== 1) {
      // Scales the position attribute in place, which is model.positions.
      model.object.geometry.scale(ratio, ratio, ratio);
      model.box = bounds(model.positions);
    }
    // Where the two models share a surface, the first one shows; the second is
    // pushed a hair back so the pair does not flicker.
    const material = model.object.material as THREE.MeshStandardMaterial;
    // One flat color, the one its swatch and its section outline have. A 3MF's
    // own colors would leave two versions of a part looking the same.
    material.vertexColors = false;
    material.color.set(OTHER_COLOR);
    material.needsUpdate = true;
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 2;
    material.wireframe = wireframeActive;
    modelRoot.add(model.object);
  }
  if (primary) {
    primary.object.visible = true;
    place();
    fitView();
    renderStats();
  }
}

function toggleVisible(model: Model): void {
  model.object.visible = !model.object.visible;
  applySection();
  invalidate();
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------
// The tree beside the model. Hiding, isolating and highlighting a part only
// re-draws ranges of the one merged geometry: the groups below name the ranges
// and the material each is drawn with, so the geometry is never rebuilt.
//
// What a hidden part leaves behind: the 3D view and the section cut (outline,
// measurements and Copy as > Section Measurements). What it does not: the
// model's bounds, so the grid, the print bed fit check, the dimensions, the
// triangle count and the section's range stay those of the whole file, and
// Compare with still lays the other model over the whole one.
let partModel: PartModel | null = null;
let partsOpen = false;
// The triangles that are shown, for the section; rebuilt when visibility moves.
let cutCache: Float32Array | null = null;

function partsAvailable(): boolean {
  return primary?.kind === 'mesh' && partModel !== null && partModel.leaves.length >= 2;
}

// Called when a model is loaded: a model of two or more parts opens the panel.
function setParts(built: Model): void {
  const model = built.parts && built.kind === 'mesh' ? buildPartModel(built.parts) : null;
  partModel = model && model.leaves.length >= 1 ? model : null;
  const multi = partModel !== null && partModel.leaves.length >= 2;
  partsPanel.setModel(multi ? partModel : null);
  cutCache = null;
  btnParts.hidden = !multi;
  // Starts every part shown; also drops the groups a multi-solid STL arrives with.
  applyParts();
  setPartsOpen(multi);
}

function setPartsOpen(on: boolean): void {
  partsOpen = on && partsAvailable();
  document.body.classList.toggle('mc-parts', partsOpen);
  partsEl.hidden = !partsOpen;
  btnParts.classList.toggle('active', partsOpen);
  btnParts.setAttribute('aria-pressed', String(partsOpen));
  onResize();
}

function togglePartsPanel(): void {
  setPartsOpen(!partsOpen);
}

// Draw each part as the panel says: hidden parts not at all, the selected one
// tinted. Adjacent ranges in one state are one group.
function applyParts(): void {
  if (!primary || primary.kind !== 'mesh' || !primary.materials) {
    return;
  }
  const mesh = primary.object as THREE.Mesh;
  const model = partsPanel.model();
  const { base, hidden, highlight } = primary.materials;
  const selection = partsPanel.selection();
  cutCache = null;
  mesh.geometry.clearGroups();
  if (!model || (partsPanel.allVisible() && !selection)) {
    mesh.material = base;
  } else {
    const stateOf = (leaf: number): DrawState =>
      !partsPanel.isVisible(leaf)
        ? HIDDEN
        : selection && leaf >= selection[0] && leaf < selection[1]
          ? HIGHLIGHT
          : NORMAL;
    for (const group of drawGroups(model.segments, stateOf, primary.triangles)) {
      // Groups count vertices, three to a triangle.
      mesh.geometry.addGroup(group.start * 3, group.count * 3, group.state);
    }
    mesh.material = [base, hidden, highlight];
  }
  if (sectionOn) {
    applySection();
  }
  invalidate();
}

// The triangles the section cuts: every one, unless parts are hidden.
function cutPositions(model: Model): Float32Array {
  const parts = partsPanel.model();
  if (model !== primary || !parts || partsPanel.allVisible()) {
    return model.positions;
  }
  if (!cutCache) {
    const groups = drawGroups(
      parts.segments,
      (leaf) => (partsPanel.isVisible(leaf) ? NORMAL : HIDDEN),
      model.triangles,
    ).filter((group) => group.state !== HIDDEN);
    const out = new Float32Array(groups.reduce((sum, group) => sum + group.count * 9, 0));
    let at = 0;
    for (const group of groups) {
      out.set(model.positions.subarray(group.start * 9, (group.start + group.count) * 9), at);
      at += group.count * 9;
    }
    cutCache = out;
  }
  return cutCache;
}

// Isolate: bring the camera, from where it is, to the part's bounds.
function frameParts(item: PartItem): void {
  const parts = partsPanel.model();
  if (!primary || !parts) {
    return;
  }
  const box = leafBounds(primary.positions, parts.leaves, item.leafFrom, item.leafTo);
  if (!box) {
    return;
  }
  // The box is in file coordinates; modelRoot carries it to the viewer's.
  const world = new THREE.Box3(
    new THREE.Vector3(...box.min),
    new THREE.Vector3(...box.max),
  ).applyMatrix4(modelRoot.matrixWorld);
  const sphere = world.getBoundingSphere(new THREE.Sphere());
  const direction = camera.position.clone().sub(controls.target);
  if (direction.lengthSq() < 1e-12) {
    direction.set(1, 1, 1);
  }
  frameSphere(sphere.center, Math.max(sphere.radius, 1e-6), direction);
}

// Picking: a click that is not a drag. The first visible part under the pointer
// is found by binary search over the leaf ranges (findLeaf).
const raycaster = new THREE.Raycaster();
const CLICK_SLOP = 4;

function pickPart(clientX: number, clientY: number): number {
  const parts = partsPanel.model();
  // Three still intersects an invisible object: a model hidden by Compare with is not pickable.
  if (!primary || primary.kind !== 'mesh' || !parts || !primary.object.visible) {
    return -1;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return -1;
  }
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  // The render loop only refreshes these when it paints, and a damped camera or
  // a just-placed model may be ahead of the last frame.
  camera.updateMatrixWorld();
  modelRoot.updateMatrixWorld(true);
  raycaster.setFromCamera(ndc, camera);
  for (const hit of raycaster.intersectObject(primary.object, false)) {
    if (hit.faceIndex === undefined || hit.faceIndex === null) {
      continue;
    }
    // Not onto what the section has cut away.
    if (sectionOn && clipPlane.distanceToPoint(hit.point) < 0) {
      continue;
    }
    const leaf = findLeaf(parts.segments, hit.faceIndex);
    // Not through a hidden part.
    if (leaf >= 0 && partsPanel.isVisible(leaf)) {
      return leaf;
    }
  }
  return -1;
}

let pressedAt: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  pressedAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  const down = pressedAt;
  pressedAt = null;
  if (!down || e.button !== 0 || !partsOpen) {
    return;
  }
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP) {
    return;
  }
  const leaf = pickPart(e.clientX, e.clientY);
  if (leaf >= 0) {
    partsPanel.selectLeaf(leaf);
  } else {
    partsPanel.clearSelection();
  }
});
btnParts.addEventListener('click', togglePartsPanel);

// ---------------------------------------------------------------------------
// Sliced prints: layer slider
// ---------------------------------------------------------------------------
let layer = 1;

function setLayer(value: number): void {
  const path = primary?.toolpath;
  if (!primary || !path) {
    return;
  }
  const count = path.layerEnd.length;
  layer = Math.min(Math.max(Math.round(value) || 1, 1), count);
  layerRange.value = String(layer);
  const end = path.layerEnd[layer - 1];
  const start = layerOnly.checked && layer > 1 ? path.layerEnd[layer - 2] : 0;
  // Two vertices per segment.
  primary.object.geometry.setDrawRange(start * 2, (end - start) * 2);
  layerLabel.textContent = `Layer ${layer} / ${count} · Z ${fmt(path.layerZ[layer - 1])} mm`;
  invalidate();
}

layerRange.addEventListener('input', () => setLayer(Number(layerRange.value)));
layerOnly.addEventListener('change', () => setLayer(layer));
byId('layer-down').addEventListener('click', () => setLayer(layer - 1));
byId('layer-up').addEventListener('click', () => setLayer(layer + 1));

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------
// The cut is a plane across one of the file's axes. The 3D view clips the model
// at it and traces the cut; the panel beside it draws the cut flat and measures
// it (stlSection.ts). Both are recomputed from the triangles each time the
// plane moves, which for a few million triangles is tens of milliseconds, so
// the slider only marks the section stale and the render loop does the work.
let sectionOn = false;
let sectionAxis: Axis = 2;
let sectionValue = 0;
let sectionStale = false;
let sectionOutlines: SectionOutline[] = [];
const clipPlane = new THREE.Plane();
const sectionLines = new THREE.Group();
modelRoot.add(sectionLines);

function sectionRangeOf(axis: Axis): [number, number] {
  const { min, max } = sceneBox();
  return [min[axis], max[axis]];
}

// One click of the minus and plus buttons: a round step a few hundred of which
// span the model (0.1 on a 20 mm part, 1 on a 250 mm one).
function sectionStep(): number {
  const [lo, hi] = sectionRangeOf(sectionAxis);
  return gridStep(hi - lo, 250);
}

function openSection(): void {
  if (!primary || primary.kind !== 'mesh') {
    toast('No model to section');
    return;
  }
  sectionOn = true;
  document.body.classList.add('mc-section');
  sectionEl.hidden = false;
  btnSection.classList.add('active');
  onResize();
  // Across the up axis first: the cut a slicer's layer view shows.
  setSectionAxis(zUp() ? 2 : 1);
  fitView();
}

function closeSection(): void {
  if (!sectionOn) {
    return;
  }
  sectionOn = false;
  document.body.classList.remove('mc-section');
  sectionEl.hidden = true;
  btnSection.classList.remove('active');
  clearSectionLines();
  sectionOutlines = [];
  sectionView.setData(null);
  for (const model of models()) {
    eachMaterial(model, (material) => {
      material.clippingPlanes = null;
      material.side = THREE.FrontSide;
      material.needsUpdate = true;
    });
  }
  onResize();
  if (primary) {
    fitView();
  }
}

function toggleSection(): void {
  if (sectionOn) {
    closeSection();
  } else {
    openSection();
  }
}

function setSectionAxis(axis: Axis): void {
  sectionAxis = axis;
  const [lo, hi] = sectionRangeOf(axis);
  sectionValue = (lo + hi) / 2;
  applySection();
}

function setSectionValue(value: number): void {
  if (!Number.isFinite(value)) {
    return;
  }
  const [lo, hi] = sectionRangeOf(sectionAxis);
  sectionValue = Math.min(Math.max(value, lo), hi);
  sectionStale = true;
  invalidate();
}

function clearSectionLines(): void {
  for (const child of [...sectionLines.children]) {
    sectionLines.remove(child);
    const lines = child as THREE.LineSegments;
    lines.geometry.dispose();
    (lines.material as THREE.Material).dispose();
  }
}

function applySection(): void {
  sectionStale = false;
  if (!sectionOn || !primary) {
    return;
  }
  const [lo, hi] = sectionRangeOf(sectionAxis);
  sectionValue = Math.min(Math.max(sectionValue, lo), hi);
  sectionRange.min = String(lo);
  sectionRange.max = String(hi);
  sectionRange.value = String(sectionValue);
  sectionNumber.step = String(sectionStep());
  // Not while it is being typed in: rewriting the field mid-number moves the
  // caret and eats the digit just entered.
  if (document.activeElement !== sectionNumber) {
    sectionNumber.value = fmt(sectionValue);
  }
  sectionAxisButtons.forEach((button, i) => button.classList.toggle('active', i === sectionAxis));

  // Keep what is below the plane. Clipping planes are in viewer coordinates, so
  // the file-space plane goes through the same transform as the models.
  const normal = new THREE.Vector3(0, 0, 0).setComponent(sectionAxis, -1);
  clipPlane.set(normal, sectionValue);
  clipPlane.applyMatrix4(modelRoot.matrixWorld);

  const [ua, va] = planeAxes(sectionAxis);
  clearSectionLines();
  sectionOutlines = [];
  for (const model of models()) {
    const material = meshMaterial(model);
    if (!material) {
      continue;
    }
    if (!material.clippingPlanes) {
      eachMaterial(model, (each) => {
        each.clippingPlanes = [clipPlane];
        // The cut opens the model, so its inside faces have to draw too.
        each.side = THREE.DoubleSide;
        each.needsUpdate = true;
      });
    }
    if (!model.object.visible) {
      continue;
    }
    const segments = sectionSegments(cutPositions(model), sectionAxis, sectionValue);
    sectionOutlines.push({ label: model.name, color: model.swatch, segments });

    // The same outline in 3D, on the cut. Drawn over the model (no depth test)
    // so it reads from any angle.
    const points = new Float32Array((segments.length / 4) * 6);
    for (let i = 0, o = 0; i + 3 < segments.length; i += 4, o += 6) {
      points[o + sectionAxis] = points[o + 3 + sectionAxis] = sectionValue;
      points[o + ua] = segments[i];
      points[o + va] = segments[i + 1];
      points[o + 3 + ua] = segments[i + 2];
      points[o + 3 + va] = segments[i + 3];
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: model === primary ? SECTION_COLOR : new THREE.Color(model.swatch),
        depthTest: false,
      }),
    );
    lines.renderOrder = 2;
    sectionLines.add(lines);
  }

  const { min, max } = sceneBox();
  sectionView.setData({
    outlines: sectionOutlines,
    u: [min[ua], max[ua]],
    v: [min[va], max[va]],
    uName: AXIS_NAMES[ua],
    vName: AXIS_NAMES[va],
  });
  invalidate();
}

// What Copy as > Section Measurements writes: the crossings along the two lines
// of the crosshair (or through the middle of the model when nothing is pointed
// at), for each model on screen.
function sectionReport(): string {
  const [ua, va] = planeAxes(sectionAxis);
  const { min, max } = sceneBox();
  const at = sectionView.point() ?? { u: (min[ua] + max[ua]) / 2, v: (min[va] + max[va]) / 2 };
  const unit = primary?.unit ?? '';
  return sectionOutlines
    .map((outline) =>
      formatSectionReport(outline.label, sectionAxis, sectionValue, unit, [
        { fixed: 'v', value: at.v, crossings: spanEdges(lineSpans(outline.segments, 'v', at.v)) },
        { fixed: 'u', value: at.u, crossings: spanEdges(lineSpans(outline.segments, 'u', at.u)) },
      ]),
    )
    .join('\n\n');
}

sectionRange.addEventListener('input', () => setSectionValue(Number(sectionRange.value)));
sectionNumber.addEventListener('input', () => {
  if (sectionNumber.value.trim() !== '') {
    setSectionValue(Number(sectionNumber.value));
  }
});
sectionNumber.addEventListener('blur', () => (sectionNumber.value = fmt(sectionValue)));
byId('section-down').addEventListener('click', () => {
  // Onto the step's own multiples, so repeated clicks read 12.0, 11.9, 11.8.
  const step = sectionStep();
  setSectionValue((Math.ceil(sectionValue / step - 1e-6) - 1) * step);
});
byId('section-up').addEventListener('click', () => {
  const step = sectionStep();
  setSectionValue((Math.floor(sectionValue / step + 1e-6) + 1) * step);
});
byId('section-close').addEventListener('click', closeSection);
sectionAxisButtons.forEach((button, i) =>
  button.addEventListener('click', () => setSectionAxis(i as Axis)),
);

btnFit.addEventListener('click', () => {
  if (primary) {
    fitView();
  }
});
btnWireframe.addEventListener('click', toggleWireframe);
btnGrid.addEventListener('click', toggleGrid);
btnSection.addEventListener('click', toggleSection);

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

async function copyPng(blob: Blob | null, done: string): Promise<void> {
  if (blob && navigator.clipboard && 'write' in navigator.clipboard) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(done);
  } else {
    toast('PNG copy not supported here');
  }
}

async function copyViewPng(): Promise<void> {
  if (!primary) {
    toast('No model to copy');
    return;
  }
  try {
    await copyPng(await snapshotBlob(), 'Copied view as PNG');
  } catch {
    toast('Could not read the current view');
  }
}

// The section canvas is transparent over the panel, so the copy gets the
// panel's background painted under it rather than a see-through PNG.
async function copySectionPng(): Promise<void> {
  try {
    const flat = document.createElement('canvas');
    flat.width = sectionCanvas.width;
    flat.height = sectionCanvas.height;
    const ctx = flat.getContext('2d');
    if (!ctx) {
      toast('PNG copy not supported here');
      return;
    }
    ctx.fillStyle = backgroundColor();
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(sectionCanvas, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => flat.toBlob(resolve, 'image/png'));
    await copyPng(blob, 'Copied section as PNG');
  } catch {
    toast('Could not read the section');
  }
}

function saveViewPng(): void {
  if (!primary) {
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

function copyAsEntries(): MenuEntry[] {
  const noModel = !primary;
  const entries: MenuEntry[] = [
    { kind: 'item', label: 'File Name', run: () => copyText(fileName, 'Copied file name') },
    { kind: 'item', label: 'Full Path', run: () => copyText(filePath, 'Copied path') },
    {
      kind: 'item',
      label: 'Dimensions',
      run: () => copyText(primary ? dimensions(primary) : '', 'Copied dimensions'),
      disabled: noModel,
    },
  ];
  if (primary?.kind === 'toolpath') {
    const summary = [fileName, ...(primary.summary ?? []), dimensions(primary)].join('\n');
    entries.push({
      kind: 'item',
      label: 'Print Summary',
      run: () => copyText(summary, 'Copied print summary'),
    });
  } else {
    entries.push({
      kind: 'item',
      label: 'Triangle Count',
      run: () => copyText(String(primary?.triangles ?? ''), 'Copied triangle count'),
      disabled: noModel,
    });
  }
  if (sectionOn) {
    entries.push({
      kind: 'item',
      label: 'Section Measurements',
      run: () => copyText(sectionReport(), 'Copied section measurements'),
    });
  }
  return entries;
}

// The models the host found beside this one, likeliest previous version first,
// then a file picker for anything else. The host opens only names it offered.
function compareEntries(): MenuEntry[] {
  const entries: MenuEntry[] = siblings.map((name) => ({
    kind: 'radio',
    label: name,
    checked: other?.name === name,
    run: () => vscode.postMessage({ type: 'compare', name }),
  }));
  if (entries.length > 0) {
    entries.push({ kind: 'divider' });
  }
  entries.push({
    kind: 'item',
    label: 'Browse…',
    run: () => vscode.postMessage({ type: 'compareBrowse' }),
  });
  if (primary && other) {
    const shown = (model: Model): MenuEntry => ({
      kind: 'checkbox',
      label: `Show ${model.name}`,
      checked: model.object.visible,
      run: () => toggleVisible(model),
    });
    entries.push({ kind: 'divider' }, shown(primary), shown(other), {
      kind: 'item',
      label: 'Stop Comparing',
      run: () => stopComparing(),
    });
  }
  return entries;
}

function viewEntries(): MenuEntry[] {
  const noModel = !primary;
  const entries: MenuEntry[] = [
    { kind: 'item', label: 'Fit View', run: () => fitView(), disabled: noModel },
    ...VIEW_LABELS.map(([label, preset]): MenuEntry => ({
      kind: 'item',
      label,
      run: () => fitView(preset),
      disabled: noModel,
    })),
    { kind: 'divider' },
  ];
  if (primary?.kind !== 'toolpath') {
    entries.push(
      { kind: 'checkbox', label: 'Wireframe', checked: wireframeActive, run: toggleWireframe },
      { kind: 'checkbox', label: 'Section', checked: sectionOn, run: toggleSection },
      {
        kind: 'checkbox',
        label: 'Parts',
        checked: partsOpen,
        run: togglePartsPanel,
        disabled: !partsAvailable(),
      },
    );
  }
  entries.push(
    { kind: 'checkbox', label: 'Grid', checked: showGridSetting, run: toggleGrid },
    { kind: 'checkbox', label: 'Print Bed', checked: showBedSetting, run: toggleBed },
  );
  // An STL and a STEP file leave the question open; 3MF and G-code are Z-up by
  // definition, and a GLB is turned Z-up when it is read.
  if (primary && !primary.fixedZUp) {
    const axis = (label: string, value: 'z' | 'y'): MenuEntry => ({
      kind: 'radio',
      label,
      checked: upAxis === value,
      run: () => setUpAxis(value),
    });
    entries.push(
      { kind: 'divider' },
      { kind: 'submenu', label: 'Up Axis', entries: [axis('Z', 'z'), axis('Y', 'y')] },
    );
  }
  return entries;
}

function buildMenu(): MenuEntry[] {
  const noModel = !primary;
  const menu: MenuEntry[] = [
    { kind: 'item', label: 'Copy View as PNG', run: () => void copyViewPng(), disabled: noModel },
    { kind: 'item', label: 'Save View as PNG…', run: saveViewPng, disabled: noModel },
  ];
  if (sectionOn) {
    menu.push({ kind: 'item', label: 'Copy Section as PNG', run: () => void copySectionPng() });
  }
  if (primary?.kind === 'mesh' && primary.parts) {
    const tree = primary.parts;
    menu.push({
      kind: 'item',
      label: 'Copy parts list',
      run: () => copyText(partsMarkdown(tree), 'Copied parts list'),
    });
  }
  menu.push(
    { kind: 'divider' },
    { kind: 'submenu', label: 'Copy as', entries: copyAsEntries() },
    { kind: 'divider' },
    { kind: 'submenu', label: 'View', entries: viewEntries() },
  );
  if (primary?.kind === 'mesh') {
    menu.push({ kind: 'submenu', label: 'Compare with', entries: compareEntries() });
  }
  menu.push(
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
  );
  return menu;
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

// The same for a press anywhere else on the page (the toolbar, the section
// panel, the layer bar), which the viewport's listener never sees. There the
// press still does its own job as well: closing a menu on the way to a slider
// should not cost a second click.
document.addEventListener(
  'pointerdown',
  (e) => {
    const target = e.target as Node | null;
    const outside = !contextMenu.owns(e.target) && !(target && viewportEl.contains(target));
    if (contextMenu.isOpen() && outside) {
      contextMenu.hide();
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
  sectionView.redraw();
  if (primary?.materials) {
    tint(primary.materials.highlight);
  }
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (!fromHost(event)) {
    return;
  }
  const msg = event.data;
  if (msg?.type === 'load') {
    loadModel(msg);
  } else if (msg?.type === 'compare') {
    loadCompare(msg);
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

function onResize(): void {
  camera.aspect = aspect();
  camera.updateProjectionMatrix();
  renderer.setSize(viewportEl.clientWidth, viewportEl.clientHeight);
  sectionView.redraw();
  invalidate();
}

window.addEventListener('resize', onResize);

function animate(): void {
  requestAnimationFrame(animate);
  if (sectionStale) {
    applySection();
  }
  // OrbitControls returns true while damping is still easing the camera, so the
  // loop keeps painting through the tail of a drag and then stops.
  if (controls.update() || needsRender) {
    renderer.render(scene, camera);
    needsRender = false;
  }
}
animate();

vscode.postMessage({ type: 'ready' });
