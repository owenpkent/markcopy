// Reads a binary glTF 2.0 file (.glb) into one triangle soup with a color per
// vertex, the shape the 3D viewer's single-geometry pipeline (section, compare,
// print bed) takes from a 3MF. Browser side, no DOM: tests run it under jsdom.
//
// The file is read in two steps. First the JSON chunk is read here, by hand,
// before anything reaches three's GLTFLoader: that is where compression the
// viewer cannot decode is refused, and where the triangle count is totalled from
// accessor counts (through the node tree, so a node that places one mesh many
// times is counted every time) and checked against the cap before a single
// vertex array exists. Then a copy of the file with its textures, images and
// samplers removed goes to GLTFLoader, so no image is ever fetched or decoded,
// the parse cannot wait on one, and img-src stays as narrow as it was. That copy
// is pruned to the default scene's triangles (see `pruneGlb`) and every accessor
// left in it is bounds-checked first, since the loader allocates whatever an
// accessor declares, including accessors with no data behind them. Every
// mesh's world transform is then baked into one merged, non-indexed geometry.
//
// glTF is Y-up and the viewer's models are Z-up (modelRoot turns them upright),
// so the merged geometry is turned from Y-up to Z-up here, once, and the model
// is flagged Z-up like a 3MF is. See the note on `yUpToZUp` below.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glbHeaderProblem } from './modelSniff';
import { MAX_TRIANGLES } from './stlInfo';
import { PartTreeBuilder, type PartNode } from './parts';

/** A GLB the viewer cannot or will not show; the message is for the person. */
export class GlbError extends Error {}

const MAGIC = 0x46546c67; // "glTF", little-endian (see modelSniff.ts)
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"
const MAX_NODE_DEPTH = 64;
// A guard on the walk itself: a glTF with a million nodes is not a model.
const MAX_NODE_VISITS = 1_000_000;
const REFUSED_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco',
  EXT_meshopt_compression: 'meshopt',
};

export interface GlbModel {
  /** Nine floats per triangle, Z-up, every node's transform applied. */
  positions: Float32Array;
  /** Three floats per vertex: the material's base color times COLOR_0, linear. */
  colors: Float32Array;
  /** Three floats per vertex, Z-up, when every mesh had normals; else null. */
  normals: Float32Array | null;
  /** The node hierarchy: leaves are triangle ranges of `positions`. */
  parts: PartNode;
}

export interface GlbOptions {
  maxTriangles?: number;
  /** The color of a primitive with no material (markcopy.stl.meshColor), linear. */
  fallbackColor?: [number, number, number];
}

interface Accessor {
  type?: string;
  componentType?: number;
  count?: number;
  normalized?: boolean;
  bufferView?: number;
  byteOffset?: number;
  sparse?: {
    count?: number;
    indices?: { bufferView?: number; byteOffset?: number; componentType?: number };
    values?: { bufferView?: number; byteOffset?: number };
  };
}
interface BufferViewDef {
  buffer?: number;
  byteOffset?: number;
  byteLength?: number;
  byteStride?: number;
  extensions?: Record<string, unknown>;
}
interface Primitive {
  attributes?: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}
interface GltfNode {
  name?: unknown;
  mesh?: number;
  children?: number[];
  matrix?: unknown;
  translation?: unknown;
  rotation?: unknown;
  scale?: unknown;
  extensions?: { EXT_mesh_gpu_instancing?: { attributes?: Record<string, number> } };
}
interface Gltf {
  asset?: { version?: string };
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ name?: unknown; primitives?: Primitive[] }>;
  accessors?: Accessor[];
  bufferViews?: BufferViewDef[];
  buffers?: Array<{ uri?: string; byteLength?: number }>;
  images?: unknown[];
  textures?: unknown[];
  samplers?: unknown[];
  materials?: unknown[];
  extensions?: unknown;
}

interface Chunks {
  json: Gltf;
  /** The BIN chunk, when the file has one, with its 8-byte chunk header. */
  bin: Uint8Array | null;
}

function readChunks(bytes: Uint8Array): Chunks {
  const problem = glbHeaderProblem(bytes);
  if (problem) {
    throw new GlbError(`This file cannot be read: ${problem}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json: Gltf | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length > bytes.byteLength - start) {
      throw new GlbError('This GLB file is cut short: a chunk runs past the end of the file.');
    }
    if (type === CHUNK_JSON && json === null) {
      try {
        json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length))) as Gltf;
      } catch {
        throw new GlbError('The JSON chunk of this GLB file is not valid JSON.');
      }
    } else if (type === CHUNK_BIN && bin === null) {
      bin = bytes.subarray(start, start + length);
    }
    offset = start + ((length + 3) & ~3);
  }
  if (json === null || typeof json !== 'object') {
    throw new GlbError(
      'This GLB file has no JSON chunk, so there is no scene description to read.',
    );
  }
  return { json, bin };
}

function refuseCompression(json: Gltf): void {
  const names = new Set<string>([...(json.extensionsRequired ?? [])]);
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      for (const key of Object.keys(primitive.extensions ?? {})) {
        names.add(key);
      }
    }
  }
  // meshopt marks the buffer views it compressed, not the primitives.
  for (const view of json.bufferViews ?? []) {
    for (const key of Object.keys(view?.extensions ?? {})) {
      names.add(key);
    }
  }
  for (const [name, label] of Object.entries(REFUSED_EXTENSIONS)) {
    if (names.has(name)) {
      throw new GlbError(
        `This GLB file uses ${label} mesh compression (${name}), which MarkCopy does not decode. Re-export it without compression to preview it.`,
      );
    }
  }
}

function primitiveTriangles(primitive: Primitive, accessors: Accessor[], max: number): number {
  const position = primitive.attributes?.POSITION;
  if (typeof position !== 'number') {
    return 0;
  }
  const source = typeof primitive.indices === 'number' ? primitive.indices : position;
  const count = accessors[source]?.count;
  // Accessors that are not backed by a buffer view are all zeros, allocated at
  // full size by the loader; bound those separately, since the file's own size
  // does not bound them. The rest cannot exceed what the file holds.
  for (const index of [position, primitive.indices]) {
    const accessor = typeof index === 'number' ? accessors[index] : undefined;
    if (accessor && accessor.bufferView === undefined && (accessor.count ?? 0) > max * 3) {
      throw new GlbError('This GLB file declares an accessor larger than MarkCopy will allocate.');
    }
  }
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    return 0;
  }
  const mode = primitive.mode ?? 4;
  if (mode === 4) {
    return Math.floor(count / 3);
  }
  if (mode === 5 || mode === 6) {
    return Math.max(0, count - 2);
  }
  return 0; // points and lines draw no surface
}

/**
 * The triangles the default scene expands to, totalled from the JSON alone.
 * Memoised per node, so a node reachable many ways is visited once; a cycle or
 * nesting past 64 levels is refused.
 */
export function countGlbTriangles(json: Gltf, max: number): number {
  const nodes = json.nodes ?? [];
  const accessors = json.accessors ?? [];
  const meshes = json.meshes ?? [];
  const perMesh = new Map<number, number>();
  const meshTriangles = (index: number): number => {
    let total = perMesh.get(index);
    if (total === undefined) {
      total = 0;
      for (const primitive of meshes[index]?.primitives ?? []) {
        total += primitiveTriangles(primitive, accessors, max);
      }
      perMesh.set(index, total);
    }
    return total;
  };
  const memo = new Map<number, number>();
  const active = new Set<number>();
  let visits = 0;
  const walk = (index: number, depth: number): number => {
    const known = memo.get(index);
    if (known !== undefined) {
      return known;
    }
    const node = nodes[index];
    if (!node || typeof node !== 'object') {
      return 0;
    }
    if (depth > MAX_NODE_DEPTH || active.has(index) || ++visits > MAX_NODE_VISITS) {
      throw new GlbError('This GLB file nests its nodes too deeply, or in a cycle.');
    }
    active.add(index);
    let own = typeof node.mesh === 'number' ? meshTriangles(node.mesh) : 0;
    const instancing = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
    if (instancing) {
      const first = Object.values(instancing)[0];
      const copies = typeof first === 'number' ? (accessors[first]?.count ?? 0) : 0;
      own *= Math.max(0, copies);
    }
    let total = own;
    for (const child of node.children ?? []) {
      if (typeof child === 'number') {
        total += walk(child, depth + 1);
      }
    }
    active.delete(index);
    memo.set(index, total);
    if (total > max) {
      throw new GlbError(tooMany(total, max));
    }
    return total;
  };
  const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
  const roots = json.scenes?.[sceneIndex]?.nodes ?? json.scenes?.[0]?.nodes ?? [];
  let total = 0;
  for (const root of roots) {
    if (typeof root === 'number') {
      total += walk(root, 0);
    }
    if (total > max) {
      throw new GlbError(tooMany(total, max));
    }
  }
  return total;
}

function tooMany(total: number, max: number): string {
  return `This GLB file holds ${total.toLocaleString()} triangles or more, above the ${max.toLocaleString()} MarkCopy previews.`;
}

const ACCESSOR_COMPONENTS = new Map<string, number>([
  ['SCALAR', 1],
  ['VEC2', 2],
  ['VEC3', 3],
  ['VEC4', 4],
]);
const COMPONENT_BYTES = new Map<number, number>([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);
const INDEX_COMPONENTS = new Set([5121, 5123, 5125]);
// Elements across every accessor the loader is left with, per triangle of the
// cap: positions, normals, colors and indices, with room to spare.
const ELEMENTS_PER_TRIANGLE = 48;

const tooBig = () =>
  new GlbError('This GLB file declares an accessor larger than MarkCopy will allocate.');
const outside = () =>
  new GlbError('This GLB file has an accessor that reaches outside the data it points at.');
const overlapping = () =>
  new GlbError(
    'This GLB file points several buffer views at the same bytes, more than MarkCopy will copy.',
  );
const malformed = (what: string) => new GlbError(`This GLB file has a malformed ${what}.`);

function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function numbers(value: unknown, length: number): number[] | undefined {
  return Array.isArray(value) &&
    value.length === length &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (value as number[]).slice()
    : undefined;
}

interface OutPrimitive {
  attributes: { POSITION: number; NORMAL?: number; COLOR_0?: number };
  indices?: number;
  material?: number;
  mode: number;
}
interface OutNode {
  name?: string;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  mesh?: number;
  children?: number[];
  extensions?: { EXT_mesh_gpu_instancing: { attributes: Record<string, number> } };
}

/** A file-given name, if it is a non-empty string, capped at 200 characters. */
function nameOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : undefined;
}

/**
 * The part of the file the preview draws, as a new glTF: the default scene's
 * node subtree, the triangle meshes those nodes use (POSITION, indices, NORMAL
 * and COLOR_0 only, no morph targets), each material's base color factor, and
 * the accessors, buffer views and buffer those reference. Everything else
 * (other scenes, animations, skins, cameras, textures, images, samplers) is
 * left behind, so the loader never sees it. A primitive with no material gets
 * one in `fallback`, which would otherwise be drawn in three's default white.
 *
 * Every accessor that is kept is checked here, before the loader allocates
 * anything: its count against the vertex budget (an accessor with no buffer view
 * is allocated at full size, whatever the file's own size), its sparse count,
 * its extent against its buffer view and the buffer view against the BIN chunk,
 * and the total across all of them. Anything over is refused. Objects are built
 * from fixed property names and Maps, never keyed by a name the file chose.
 */
export function pruneGlb(
  json: Gltf,
  binLength: number | null,
  max: number,
  fallback: [number, number, number] | undefined,
): Gltf {
  const accessors = json.accessors ?? [];
  const views = json.bufferViews ?? [];
  const vertexLimit = 3 * max + 2;
  const elementLimit = ELEMENTS_PER_TRIANGLE * max;
  let elements = 0;

  const outAccessors: Accessor[] = [];
  const accessorMap = new Map<number, number>();
  const outViews: BufferViewDef[] = [];
  const viewMap = new Map<number, number>();
  // The loader copies every buffer view it is given whole, one copy per view
  // entry, so views that overlap would each copy the same bytes again. Views
  // that do not overlap fit in the BIN chunk, so the kept views together may not
  // exceed it: that bounds the loader's copies by the file's own size.
  let viewBytes = 0;

  const useView = (index: unknown, needBytes: number, offset: number): number => {
    if (!wholeNumber(index)) {
      throw malformed('buffer view reference');
    }
    const view = views[index];
    if (!view || typeof view !== 'object' || binLength === null) {
      throw outside();
    }
    const { byteOffset = 0, byteLength, buffer, byteStride } = view;
    if (buffer !== 0 || !wholeNumber(byteLength) || !wholeNumber(byteOffset)) {
      throw outside();
    }
    if (byteOffset + byteLength > binLength || offset + needBytes > byteLength) {
      throw outside();
    }
    let slot = viewMap.get(index);
    if (slot === undefined) {
      viewBytes += byteLength;
      if (viewBytes > binLength) {
        throw overlapping();
      }
      const out: BufferViewDef = { buffer: 0, byteOffset, byteLength };
      if (wholeNumber(byteStride)) {
        out.byteStride = byteStride;
      }
      slot = outViews.push(out) - 1;
      viewMap.set(index, slot);
    }
    return slot;
  };

  // `kind` says what the accessor is for, and so which shapes it may have.
  const useAccessor = (
    index: unknown,
    kind: 'position' | 'normal' | 'color' | 'index' | 'instance',
  ): number => {
    if (!wholeNumber(index)) {
      throw malformed('accessor reference');
    }
    const known = accessorMap.get(index);
    if (known !== undefined) {
      return known;
    }
    const a = accessors[index];
    if (!a || typeof a !== 'object') {
      throw malformed('accessor reference');
    }
    const components = ACCESSOR_COMPONENTS.get(String(a.type));
    const bytes = COMPONENT_BYTES.get(Number(a.componentType));
    if (components === undefined || bytes === undefined || !wholeNumber(a.count)) {
      throw malformed('accessor');
    }
    if (
      ((kind === 'position' || kind === 'normal') && components !== 3) ||
      (kind === 'color' && components < 3) ||
      (kind === 'index' && (components !== 1 || !INDEX_COMPONENTS.has(Number(a.componentType))))
    ) {
      throw malformed('accessor');
    }
    if (a.count > vertexLimit) {
      throw tooBig();
    }
    elements += a.count * components;
    const out: Accessor = {
      type: a.type,
      componentType: a.componentType,
      count: a.count,
    };
    if (a.normalized === true) {
      out.normalized = true;
    }
    const elementBytes = components * bytes;
    if (a.bufferView !== undefined) {
      const offset = a.byteOffset ?? 0;
      if (!wholeNumber(offset) || !wholeNumber(a.bufferView)) {
        throw malformed('accessor');
      }
      const stride = views[a.bufferView]?.byteStride ?? elementBytes;
      if (!wholeNumber(stride) || stride < elementBytes) {
        throw malformed('buffer view');
      }
      const extent = a.count === 0 ? 0 : stride * (a.count - 1) + elementBytes;
      out.bufferView = useView(a.bufferView, extent, offset);
      out.byteOffset = offset;
    }
    const s = a.sparse;
    if (s !== undefined) {
      if (!s || !wholeNumber(s.count) || s.count > a.count) {
        throw tooBig();
      }
      elements += s.count * (components + 1);
      const indexType = Number(s.indices?.componentType);
      const indexBytes = COMPONENT_BYTES.get(indexType);
      const indexAt = s.indices?.byteOffset ?? 0;
      const valueAt = s.values?.byteOffset ?? 0;
      if (
        indexBytes === undefined ||
        !INDEX_COMPONENTS.has(indexType) ||
        !wholeNumber(indexAt) ||
        !wholeNumber(valueAt)
      ) {
        throw malformed('accessor');
      }
      out.sparse = {
        count: s.count,
        indices: {
          bufferView: useView(s.indices?.bufferView, s.count * indexBytes, indexAt),
          byteOffset: indexAt,
          componentType: indexType,
        },
        values: {
          bufferView: useView(s.values?.bufferView, s.count * elementBytes, valueAt),
          byteOffset: valueAt,
        },
      };
    }
    if (elements > elementLimit) {
      throw tooBig();
    }
    const slot = outAccessors.push(out) - 1;
    accessorMap.set(index, slot);
    return slot;
  };

  // Materials keep the base color factor and nothing else: colors are all the
  // preview draws.
  const outMaterials: unknown[] = [];
  const materialMap = new Map<number, number>();
  const useMaterial = (index: unknown): number | undefined => {
    if (!wholeNumber(index)) {
      return undefined;
    }
    let slot = materialMap.get(index);
    if (slot === undefined) {
      const def = json.materials?.[index] as
        { pbrMetallicRoughness?: { baseColorFactor?: unknown } } | undefined;
      if (!def || typeof def !== 'object') {
        return undefined;
      }
      const factor = numbers(def.pbrMetallicRoughness?.baseColorFactor, 4);
      slot =
        outMaterials.push(factor ? { pbrMetallicRoughness: { baseColorFactor: factor } } : {}) - 1;
      materialMap.set(index, slot);
    }
    return slot;
  };
  let fallbackMaterial: number | undefined;

  const outMeshes: Array<{ name?: string; primitives: OutPrimitive[] }> = [];
  const meshMap = new Map<number, number>();
  const useMesh = (index: number): number | undefined => {
    const known = meshMap.get(index);
    if (known !== undefined) {
      return known;
    }
    const mesh = json.meshes?.[index];
    if (!mesh || typeof mesh !== 'object') {
      return undefined;
    }
    const primitives: OutPrimitive[] = [];
    for (const p of mesh.primitives ?? []) {
      const mode = p?.mode ?? 4;
      const position = p?.attributes?.POSITION;
      // Points and lines draw no surface, and a primitive with no POSITION has
      // none either.
      if (!p || ![4, 5, 6].includes(mode) || position === undefined) {
        continue;
      }
      const out: OutPrimitive = {
        attributes: { POSITION: useAccessor(position, 'position') },
        mode,
      };
      const normal = p.attributes?.NORMAL;
      const color = p.attributes?.COLOR_0;
      // The glTF rule: every attribute of a primitive has the vertex count.
      for (const other of [normal, color]) {
        if (other !== undefined && accessors[other]?.count !== accessors[position]?.count) {
          throw malformed('attribute');
        }
      }
      if (normal !== undefined) {
        out.attributes.NORMAL = useAccessor(normal, 'normal');
      }
      if (color !== undefined) {
        out.attributes.COLOR_0 = useAccessor(color, 'color');
      }
      if (p.indices !== undefined) {
        out.indices = useAccessor(p.indices, 'index');
      }
      let material = useMaterial(p.material);
      if (material === undefined && fallback) {
        fallbackMaterial ??=
          outMaterials.push({
            pbrMetallicRoughness: { baseColorFactor: [...fallback, 1], metallicFactor: 0 },
          }) - 1;
        material = fallbackMaterial;
      }
      if (material !== undefined) {
        out.material = material;
      }
      primitives.push(out);
    }
    const meshName = nameOf(mesh.name);
    const slot = outMeshes.push(meshName ? { name: meshName, primitives } : { primitives }) - 1;
    meshMap.set(index, slot);
    return slot;
  };

  const outNodes: OutNode[] = [];
  const nodeMap = new Map<number, number>();
  let usesInstancing = false;
  const useNode = (index: number): number | undefined => {
    const known = nodeMap.get(index);
    if (known !== undefined) {
      return known;
    }
    const node = json.nodes?.[index];
    if (!node || typeof node !== 'object') {
      return undefined;
    }
    const out: OutNode = {};
    // Kept for the parts tree, which reads node and mesh names; parts.ts cleans them.
    const nodeName = nameOf(node.name);
    if (nodeName) out.name = nodeName;
    const slot = outNodes.push(out) - 1;
    nodeMap.set(index, slot);
    const matrix = numbers(node.matrix, 16);
    const translation = numbers(node.translation, 3);
    const rotation = numbers(node.rotation, 4);
    const scale = numbers(node.scale, 3);
    if (matrix) out.matrix = matrix;
    if (translation) out.translation = translation;
    if (rotation) out.rotation = rotation;
    if (scale) out.scale = scale;
    if (wholeNumber(node.mesh)) {
      const mesh = useMesh(node.mesh);
      if (mesh !== undefined) {
        out.mesh = mesh;
      }
    }
    const instancing = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
    if (instancing && out.mesh !== undefined) {
      const attributes: Record<string, number> = {};
      for (const name of ['TRANSLATION', 'ROTATION', 'SCALE'] as const) {
        if (instancing[name] !== undefined) {
          attributes[name] = useAccessor(instancing[name], 'instance');
        }
      }
      // The instance count, read as countGlbTriangles reads it: the first
      // attribute's count, which the extension requires every attribute to share.
      const first = Object.values(instancing)[0];
      const copies = typeof first === 'number' ? accessors[first]?.count : undefined;
      for (const index of Object.values(instancing)) {
        if (!wholeNumber(index) || accessors[index]?.count !== copies) {
          throw malformed('instancing attribute');
        }
      }
      // An instanced node may carry only custom attributes (such as _ID), all
      // three transforms being optional. Those are dropped above, and three
      // would then draw one plain mesh, losing the other instances. Give it a
      // zero TRANSLATION of the same count instead: an accessor with no buffer
      // view is zero-filled, and it is budgeted like any other.
      if (Object.keys(attributes).length === 0 && wholeNumber(copies)) {
        if (copies > vertexLimit) {
          throw tooBig();
        }
        elements += copies * 3;
        if (elements > elementLimit) {
          throw tooBig();
        }
        attributes.TRANSLATION =
          outAccessors.push({ type: 'VEC3', componentType: 5126, count: copies }) - 1;
      }
      usesInstancing = true;
      out.extensions = { EXT_mesh_gpu_instancing: { attributes } };
    }
    const children: number[] = [];
    for (const child of node.children ?? []) {
      const c = wholeNumber(child) ? useNode(child) : undefined;
      if (c !== undefined) {
        children.push(c);
      }
    }
    if (children.length > 0) {
      out.children = children;
    }
    return slot;
  };

  const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
  const roots = json.scenes?.[sceneIndex]?.nodes ?? json.scenes?.[0]?.nodes ?? [];
  const sceneNodes: number[] = [];
  for (const root of roots) {
    const slot = wholeNumber(root) ? useNode(root) : undefined;
    if (slot !== undefined) {
      sceneNodes.push(slot);
    }
  }

  const pruned: Gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes: outNodes,
    meshes: outMeshes,
    accessors: outAccessors,
    bufferViews: outViews,
    materials: outMaterials,
  };
  if (binLength !== null && outViews.length > 0) {
    pruned.buffers = [{ byteLength: binLength }];
  }
  if (usesInstancing) {
    pruned.extensionsUsed = ['EXT_mesh_gpu_instancing'];
  }
  return pruned;
}

// The pruned glTF and the BIN chunk as a GLB for the loader.
function encodeGlb(pruned: Gltf, bin: Uint8Array | null): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(pruned));
  const jsonLength = (text.length + 3) & ~3;
  const binLength = bin ? (bin.byteLength + 3) & ~3 : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total).fill(0x20);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  if (bin) {
    const at = 20 + jsonLength;
    out.fill(0, at, total);
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out.buffer;
}

interface Loaded {
  scene: THREE.Object3D;
  /** The loader's map from each object it made to the glTF node, mesh and primitive it came from. */
  associations: ReadonlyMap<unknown, { nodes?: number } | undefined>;
}

function loadScene(data: ArrayBuffer): Promise<Loaded> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new GlbError('Reading this GLB file timed out.')),
      60_000,
    );
    const done =
      <T>(fn: (value: T) => void) =>
      (value: T) => {
        clearTimeout(timer);
        fn(value);
      };
    try {
      new GLTFLoader().parse(
        data,
        '',
        done((gltf: GLTF) =>
          resolve({ scene: gltf.scene, associations: gltf.parser.associations }),
        ),
        done((err: unknown) =>
          reject(new GlbError(`Could not read this GLB file (${errorText(err)}).`)),
        ),
      );
    } catch (err) {
      clearTimeout(timer);
      reject(new GlbError(`Could not read this GLB file (${errorText(err)}).`));
    }
  });
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

interface Piece {
  mesh: THREE.Mesh;
  /** World matrices to place it at: one, or one per instance. */
  matrices: THREE.Matrix4[];
  /** `[first triangle, count]` per placement, filled in by bake. */
  ranges: Array<[number, number]>;
  /** The (pruned) source node this was drawn for, when the loader says. */
  node?: number;
}

// The glTF node an object belongs to: its own association, or the nearest
// ancestor's (a multi-primitive mesh is a Group holding one Mesh per primitive).
function nodeOf(object: THREE.Object3D, associations: Loaded['associations']): number | undefined {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    const node = associations.get(o)?.nodes;
    if (node !== undefined) {
      return node;
    }
  }
  return undefined;
}

function collect(scene: THREE.Object3D, associations: Loaded['associations']): Piece[] {
  scene.updateMatrixWorld(true);
  const pieces: Piece[] = [];
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute('position')) {
      return;
    }
    const instanced = object as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      const matrices: THREE.Matrix4[] = [];
      for (let i = 0; i < instanced.count; i++) {
        const local = new THREE.Matrix4();
        instanced.getMatrixAt(i, local);
        matrices.push(new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, local));
      }
      pieces.push({ mesh, matrices, ranges: [], node: nodeOf(object, associations) });
    } else {
      pieces.push({
        mesh,
        matrices: [mesh.matrixWorld.clone()],
        ranges: [],
        node: nodeOf(object, associations),
      });
    }
  });
  return pieces;
}

function materialColor(material: THREE.Material | undefined): THREE.Color {
  const color = (material as THREE.MeshStandardMaterial | undefined)?.color;
  return color?.isColor ? color : new THREE.Color(1, 1, 1);
}

// glTF is Y-up and the viewer's models are Z-up. A quarter turn about X takes
// glTF (x, y, z) to (x, -z, y): up becomes +Z and the model's front (+Z in glTF)
// faces -Y, the way a Z-up CAD model's front does. It is a rotation, so winding
// and handedness survive. Baked here rather than left to markcopy.stl.upAxis
// because glTF fixes its up axis by specification, where an STL does not: the
// setting is for formats that leave the choice to the file, and GLB (like 3MF)
// ignores it.
function yUpToZUp(x: number, y: number, z: number, out: Float32Array, at: number): void {
  out[at] = x;
  out[at + 1] = -z;
  out[at + 2] = y;
}

function bake(pieces: Piece[], triangles: number): Omit<GlbModel, 'parts'> {
  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  let allNormals = true;
  const vertex = new THREE.Vector3();
  const normalVector = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let at = 0;
  for (const piece of pieces) {
    const { mesh, matrices } = piece;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const vertexColor = geometry.getAttribute('color');
    const normal = geometry.getAttribute('normal');
    if (!normal) {
      allNormals = false;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const total = index ? index.count : position.count;
    const groups = geometry.groups.length > 0 ? geometry.groups : null;
    for (const matrix of matrices) {
      const firstTriangle = at / 9;
      normalMatrix.getNormalMatrix(matrix);
      // A mirrored placement flips the winding; swap two corners so the faces
      // keep facing outward, as the 3MF reader does.
      const mirrored = matrix.determinant() < 0;
      for (let corner = 0; corner + 2 < total; corner += 3) {
        let material = materials[0];
        if (groups) {
          const group = groups.find((g) => corner >= g.start && corner < g.start + g.count);
          if (!group) {
            continue;
          }
          material = materials[group.materialIndex ?? 0] ?? materials[0];
        }
        const base = materialColor(material);
        if (at + 9 > positions.length) {
          return { positions, colors, normals: allNormals ? normals : null };
        }
        for (let k = 0; k < 3; k++) {
          const slot = mirrored ? (k === 0 ? 0 : 3 - k) : k;
          const i = index ? index.getX(corner + slot) : corner + slot;
          vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
          yUpToZUp(vertex.x, vertex.y, vertex.z, positions, at);
          if (normal) {
            normalVector.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
            yUpToZUp(normalVector.x, normalVector.y, normalVector.z, normals, at);
          }
          let r = base.r;
          let g = base.g;
          let b = base.b;
          if (vertexColor) {
            r *= vertexColor.getX(i);
            g *= vertexColor.getY(i);
            b *= vertexColor.getZ(i);
          }
          colors[at] = r;
          colors[at + 1] = g;
          colors[at + 2] = b;
          at += 3;
        }
      }
      piece.ranges.push([firstTriangle, at / 9 - firstTriangle]);
    }
  }
  // Fewer triangles than the JSON promised (a primitive the loader dropped):
  // hand back exactly what was written.
  const n = allNormals ? normals : null;
  return at === positions.length
    ? { positions, colors, normals: n }
    : {
        positions: positions.slice(0, at),
        colors: colors.slice(0, at),
        normals: n ? n.slice(0, at) : null,
      };
}

/**
 * Read a GLB into one colored triangle soup, Z-up. Refuses what MarkCopy does
 * not decode (Draco, meshopt), external buffers, and anything over the triangle
 * cap, all before the loader or any output array is allocated.
 */
export async function readGlb(bytes: Uint8Array, options: GlbOptions = {}): Promise<GlbModel> {
  const max = options.maxTriangles ?? MAX_TRIANGLES;
  const { json, bin } = readChunks(bytes);
  if (!json.asset || String(json.asset.version).split('.')[0] !== '2') {
    throw new GlbError('This GLB file is not glTF 2.0.');
  }
  refuseCompression(json);
  if ((json.buffers ?? []).some((buffer) => buffer?.uri !== undefined)) {
    throw new GlbError(
      'This GLB file refers to buffers outside the file, which the preview cannot load. Re-export it with everything embedded.',
    );
  }
  const triangles = countGlbTriangles(json, max);
  if (triangles === 0) {
    throw new GlbError(
      'This GLB file holds no triangle meshes to show (points and lines are not drawn).',
    );
  }
  const pruned = pruneGlb(json, bin ? bin.byteLength : null, max, options.fallbackColor);
  const { scene, associations } = await loadScene(encodeGlb(pruned, bin));
  const pieces = collect(scene, associations);
  const model = bake(pieces, triangles);
  if (model.positions.length === 0) {
    throw new GlbError('This GLB file holds no triangle meshes to show.');
  }
  return { ...model, parts: glbParts(pruned, pieces, model.positions.length / 9) };
}

// The node hierarchy as parts, read from the pruned source JSON rather than from
// three's objects (which are not one per node: a mesh with several materials is a
// Group of Meshes). The loader's associations say which source node each drawn
// mesh came from. A node is one part holding the ranges of all its primitives; a
// node that places a mesh many times (EXT_mesh_gpu_instancing) is one part per
// copy, and an instanced node with nothing under it puts them straight into its
// parent, so the quantity row is the part itself. A name is the node's, else its
// mesh's, else left for "Part N".
function glbParts(pruned: Gltf, pieces: Piece[], total: number): PartNode {
  const builder = new PartTreeBuilder(total);
  const byNode = new Map<number, Piece[]>();
  for (const piece of pieces) {
    if (piece.node !== undefined) {
      const list = byNode.get(piece.node);
      if (list) {
        list.push(piece);
      } else {
        byNode.set(piece.node, [piece]);
      }
    }
  }
  const nodes = (pruned.nodes ?? []) as unknown as OutNode[];
  const meshes = (pruned.meshes ?? []) as unknown as Array<{ name?: string }>;
  const seen = new Set<number>();
  const leaves = (index: number, name: string): void => {
    const list = byNode.get(index) ?? [];
    // Every primitive of a placement has the same number of placements.
    const placements = list.length > 0 ? Math.min(...list.map((p) => p.ranges.length)) : 0;
    for (let k = 0; k < placements; k++) {
      builder.leaf(
        name,
        list.map((p) => p.ranges[k]),
      );
    }
  };
  // Depth is bounded by countGlbTriangles (64 nodes), before this runs; `seen`
  // keeps a hostile cycle from being walked twice.
  const visit = (index: number): void => {
    const node = nodes[index];
    if (!node || seen.has(index)) {
      return;
    }
    seen.add(index);
    const meshName = node.mesh !== undefined ? meshes[node.mesh]?.name : undefined;
    const name = node.name ?? meshName ?? '';
    const kids = node.children ?? [];
    if (kids.length === 0) {
      leaves(index, name);
      return;
    }
    builder.begin(node.name ?? '');
    leaves(index, name);
    for (const child of kids) {
      visit(child);
    }
    builder.end();
  };
  for (const root of pruned.scenes?.[0]?.nodes ?? []) {
    visit(root);
  }
  return builder.finish();
}
