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
// the parse cannot wait on one, and img-src stays as narrow as it was. Every
// mesh's world transform is then baked into one merged, non-indexed geometry.
//
// glTF is Y-up and the viewer's models are Z-up (modelRoot turns them upright),
// so the merged geometry is turned from Y-up to Z-up here, once, and the model
// is flagged Z-up like a 3MF is. See the note on `yUpToZUp` below.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glbHeaderProblem } from './modelSniff';
import { MAX_TRIANGLES } from './stlInfo';

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
}

export interface GlbOptions {
  maxTriangles?: number;
  /** The color of a primitive with no material (markcopy.stl.meshColor), linear. */
  fallbackColor?: [number, number, number];
}

interface Accessor {
  count?: number;
  bufferView?: number;
}
interface Primitive {
  attributes?: Record<string, number>;
  indices?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}
interface GltfNode {
  mesh?: number;
  children?: number[];
  extensions?: { EXT_mesh_gpu_instancing?: { attributes?: Record<string, number> } };
}
interface Gltf {
  asset?: { version?: string };
  extensionsRequired?: string[];
  extensionsUsed?: string[];
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ primitives?: Primitive[] }>;
  accessors?: Accessor[];
  bufferViews?: Array<{ extensions?: Record<string, unknown> }>;
  buffers?: Array<{ uri?: string }>;
  images?: unknown[];
  textures?: unknown[];
  samplers?: unknown[];
  materials?: unknown[];
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

// Drop everything texture-shaped from the JSON, and every reference to it, so
// the loader has no image to fetch or decode. A material keeps its factors.
function stripTextures(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripTextures);
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (/Texture$/.test(key) && item && typeof item === 'object') {
        delete record[key];
      } else {
        stripTextures(item);
      }
    }
  }
}

function withoutTextures(
  json: Gltf,
  bin: Uint8Array | null,
  fallback: [number, number, number] | undefined,
): ArrayBuffer {
  const copy = JSON.parse(JSON.stringify(json)) as Gltf;
  if (fallback) {
    // A primitive with no material would be drawn in three's default white.
    // Give those one material of the setting's color instead.
    const bare = (copy.meshes ?? [])
      .flatMap((m) => m.primitives ?? [])
      .filter((p) => typeof (p as { material?: unknown }).material !== 'number');
    if (bare.length > 0) {
      const materials = (copy.materials ??= []) as unknown[];
      materials.push({
        pbrMetallicRoughness: { baseColorFactor: [...fallback, 1], metallicFactor: 0 },
      });
      for (const p of bare) {
        (p as { material?: number }).material = materials.length - 1;
      }
    }
  }
  delete copy.images;
  delete copy.textures;
  delete copy.samplers;
  stripTextures(copy.materials);
  stripTextures((copy as { extensions?: unknown }).extensions);
  const text = new TextEncoder().encode(JSON.stringify(copy));
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

function loadScene(data: ArrayBuffer): Promise<THREE.Object3D> {
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
        done((gltf: { scene: THREE.Object3D }) => resolve(gltf.scene)),
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
}

function collect(scene: THREE.Object3D): Piece[] {
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
      pieces.push({ mesh, matrices });
    } else {
      pieces.push({ mesh, matrices: [mesh.matrixWorld.clone()] });
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

function bake(pieces: Piece[], triangles: number): GlbModel {
  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  let allNormals = true;
  const vertex = new THREE.Vector3();
  const normalVector = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let at = 0;
  for (const { mesh, matrices } of pieces) {
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
  const scene = await loadScene(withoutTextures(json, bin, options.fallbackColor));
  const model = bake(collect(scene), triangles);
  if (model.positions.length === 0) {
    throw new GlbError('This GLB file holds no triangle meshes to show.');
  }
  return model;
}
