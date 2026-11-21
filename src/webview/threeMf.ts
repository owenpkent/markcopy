// Reading a 3MF package into the flat triangle list the 3D preview draws.
//
// A .3mf is an OPC zip, like an Office document, holding one or more XML model
// parts. The root model lists objects (a mesh of vertices and triangles, or a
// set of components that place other objects with a transform) and a build of
// the objects to print. Slicers (Bambu Studio, PrusaSlicer, Cura) write the
// meshes into separate parts under 3D/Objects/ and point at them with the
// Production extension's p:path, so following that attribute is what makes
// their project files open at all.
//
// Everything a hostile file could use to make this allocate is bounded before
// the allocation happens: the zip goes through the same two-layer limits as a
// workbook (src/ooxml/zip.ts), the XML goes through the same entity-inert SAX
// reader (src/ooxml/xml.ts), and the triangle count, which components can
// multiply (an object placed a thousand times, each placing another a thousand
// times), is totalled with memoisation and refused above the STL cap before a
// single output float is allocated.
//
// No DOM or Three.js dependency, so it is unit-tested in tests/threeMf.test.ts.
import { openZip, partForRels, partText, resolveTarget, OpcError, type Parts } from '../ooxml/zip';
import { attr, walkXml } from '../ooxml/xml';
import { MAX_STL_BYTES, MAX_TRIANGLES } from './stlInfo';

/** A 3MF the preview will not or cannot draw, with a message written to be shown. */
export class ThreeMfError extends Error {}

export interface ThreeMfModel {
  /** Nine floats per triangle, in the file's own Z-up coordinates and units. */
  positions: Float32Array;
  /**
   * Linear RGB per vertex, parallel to `positions`, or null when the file
   * assigns no colors. Corners without a color of their own get the fallback.
   */
  colors: Float32Array | null;
  triangles: number;
  /** The root model's unit: `millimeter` unless the file says otherwise. */
  unit: string;
}

export interface ThreeMfOptions {
  /** Linear RGB for faces the file does not color. */
  fallbackColor?: readonly [number, number, number];
  maxTriangles?: number;
}

const MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const DEFAULT_ROOT = '3D/3dmodel.model';

// The file cap is the STL one, for the same transport reason (see stlInfo.ts).
// Inflated model XML runs to roughly 60 bytes per triangle, so a 256 MiB part is
// already past four million triangles. The total stays well under the largest
// string V8 will build from one part, which is what partText() does.
const LIMITS = {
  maxFileBytes: MAX_STL_BYTES,
  maxEntries: 1000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 384 * 1024 * 1024,
};

// Real files nest components two or three deep. A chain deeper than this is
// either a cycle the id check missed or an attempt to exhaust the stack.
const MAX_DEPTH = 64;

/** Short unit labels for the dimensions readout, keyed by the spec's unit names. */
export const UNIT_LABELS: Record<string, string> = {
  micron: 'µm',
  millimeter: 'mm',
  centimeter: 'cm',
  inch: 'in',
  foot: 'ft',
  meter: 'm',
};

// A 4x3 affine transform in the spec's own order, m00 m01 m02 m10 ... m32, for
// row vectors: x' = x*m00 + y*m10 + z*m20 + m30, and so on.
type Matrix = readonly number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface Mesh {
  vertices: Grow<Float32Array>;
  // v1 v2 v3 per triangle.
  triangles: Grow<Int32Array>;
  // pid (interned, -1 for none), p1, p2, p3 (-1 for none) per triangle; only
  // allocated once a triangle carries a property.
  props: Grow<Int32Array> | null;
}

interface ObjectDef {
  pid: number;
  pindex: number;
  mesh: Mesh | null;
  components: Component[];
}

interface Component {
  objectId: string;
  path: string | null;
  transform: Matrix;
}

interface ModelPart {
  unit: string;
  objects: Map<string, ObjectDef>;
  // Property group id -> interned index. Groups may be referenced before they
  // appear (the spec forbids it, writers do it anyway), so ids are interned on
  // first sight and filled in when the group itself is read.
  groupIndex: Map<string, number>;
  // Linear RGB triples per group, or null for a group with no color to give
  // (textures, composites, multiproperties): those faces take the fallback.
  groups: Array<Float32Array | null>;
  build: Component[];
}

/** Parse `bytes` as a 3MF package. Throws ThreeMfError with a showable message. */
export function parse3mf(bytes: Uint8Array, options: ThreeMfOptions = {}): ThreeMfModel {
  return parseParts(unpack(bytes), options);
}

// The G-code parts in plate order: plate_2 before plate_10.
function gcodeParts(parts: Parts): string[] {
  const natural = new Intl.Collator('en', { numeric: true });
  return [...parts.keys()].filter((p) => p.toLowerCase().endsWith('.gcode')).sort(natural.compare);
}

function unpack(bytes: Uint8Array): Parts {
  try {
    return openZip(bytes, {
      limits: LIMITS,
      noun: '3MF file',
      notZip: 'this file is not a 3MF package (it is not a zip archive).',
    });
  } catch (err) {
    throw err instanceof OpcError ? new ThreeMfError(sentence(err.message)) : err;
  }
}

function parseParts(parts: Parts, options: ThreeMfOptions): ThreeMfModel {
  const maxTriangles = options.maxTriangles ?? MAX_TRIANGLES;
  const fallback = options.fallbackColor ?? [0.25, 0.45, 0.94];

  const rootPath = findRoot(parts);
  const cache = new Map<string, ModelPart>();
  const load = (path: string): ModelPart => {
    let part = cache.get(path);
    if (!part) {
      const xml = partText(parts, path);
      if (xml === undefined) {
        throw new ThreeMfError(
          `The 3MF file refers to a model part it does not contain (${path}).`,
        );
      }
      part = readModel(xml, path);
      cache.set(path, part);
    }
    return part;
  };
  const root = load(rootPath);
  if (root.build.length === 0) {
    throw new ThreeMfError(nothingToShow(parts, 'has nothing in its build to show'));
  }

  // Pass 1: how many triangles the build expands to, and whether any of them
  // has a color. Memoised per object, so a fan-out of instances costs one visit
  // per object, not one per instance.
  const counts = new Map<string, number>();
  const visiting = new Set<string>();
  let colored = false;
  const count = (path: string, id: string, depth: number): number => {
    const key = `${path}#${id}`;
    const known = counts.get(key);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(key) || depth > MAX_DEPTH) {
      throw new ThreeMfError('This 3MF file has components that contain themselves.');
    }
    visiting.add(key);
    const part = load(path);
    const obj = lookup(part, id, path);
    let n = 0;
    if (obj.mesh) {
      n += obj.mesh.triangles.length / 3;
      if ((obj.pid >= 0 || obj.mesh.props) && part.groups.some((g) => g !== null)) {
        colored = true;
      }
    }
    for (const c of obj.components) {
      n += count(c.path ? resolveTarget(path, c.path) : path, c.objectId, depth + 1);
      if (n > maxTriangles) {
        break;
      }
    }
    visiting.delete(key);
    counts.set(key, n);
    return n;
  };

  let total = 0;
  for (const item of root.build) {
    total += count(item.path ? resolveTarget(rootPath, item.path) : rootPath, item.objectId, 0);
    if (total > maxTriangles) {
      throw new ThreeMfError(
        `This 3MF model has more than ${maxTriangles.toLocaleString()} triangles, MarkCopy's limit.`,
      );
    }
  }
  if (total === 0) {
    throw new ThreeMfError(nothingToShow(parts, 'has no triangles to show'));
  }

  // Pass 2: write every placed triangle, transformed into build coordinates.
  const positions = new Float32Array(total * 9);
  const colors = colored ? new Float32Array(total * 9) : null;
  let tri = 0;
  // The count bounds the triangles written, not the placements walked: a
  // subtree that holds no triangles adds nothing to the total however many
  // times it is placed, so forty levels of doubled empty components would pass
  // the cap and then be visited a trillion times here. Pass 1 already knows
  // every object's count, so a placement of nothing is skipped before its
  // transform is composed. What is left to walk holds at least one triangle
  // per visit, which the cap does bound.
  const holdsTriangles = (path: string, id: string): boolean =>
    (counts.get(`${path}#${id}`) ?? 0) > 0;
  const emit = (path: string, id: string, m: Matrix): void => {
    const part = load(path);
    const obj = lookup(part, id, path);
    if (obj.mesh) {
      tri = writeMesh(obj, part, m, positions, colors, tri, fallback, path);
    }
    for (const c of obj.components) {
      const childPath = c.path ? resolveTarget(path, c.path) : path;
      if (holdsTriangles(childPath, c.objectId)) {
        emit(childPath, c.objectId, multiply(c.transform, m));
      }
    }
  };
  for (const item of root.build) {
    const itemPath = item.path ? resolveTarget(rootPath, item.path) : rootPath;
    if (holdsTriangles(itemPath, item.objectId)) {
      emit(itemPath, item.objectId, item.transform);
    }
  }

  return { positions, colors, triangles: total, unit: root.unit };
}

// The root model part: the target of the package's 3D model relationship, or
// the conventional path when the relationships are missing or say nothing.
function findRoot(parts: Parts): string {
  const rels = partText(parts, '_rels/.rels');
  let target: string | undefined;
  if (rels !== undefined) {
    // Malformed relationships are not fatal: the conventional path below is
    // where nearly every writer puts the model anyway.
    tryWalk(rels, {
      open(name, attrs) {
        if (target === undefined && name === 'Relationship' && attr(attrs, 'Type') === MODEL_REL) {
          const value = attr(attrs, 'Target');
          if (value && attr(attrs, 'TargetMode') !== 'External') {
            target = resolveTarget(partForRels('_rels/.rels'), value);
          }
        }
      },
    });
  }
  for (const candidate of [target, DEFAULT_ROOT]) {
    if (candidate && parts.has(candidate)) {
      return candidate;
    }
  }
  const any = [...parts.keys()].find((p) => p.toLowerCase().endsWith('.model'));
  if (any) {
    return any;
  }
  throw new ThreeMfError('This 3MF file has no 3D model part.');
}

// A sliced print file (Bambu Studio's and OrcaSlicer's .gcode.3mf) keeps the
// G-code and plate thumbnails and drops the meshes, so an empty build there is
// expected rather than a broken file, and worth saying so.
function nothingToShow(parts: Parts, what: string): string {
  const sliced = gcodeParts(parts).length > 0;
  return sliced
    ? 'This is a sliced print file: it holds G-code and thumbnails but no model to show. Open the project .3mf it was sliced from instead.'
    : `This 3MF file ${what}.`;
}

function tryWalk(xml: string, handlers: Parameters<typeof walkXml>[1]): void {
  try {
    walkXml(xml, handlers);
  } catch {
    // Whatever was read before the error stands.
  }
}

function lookup(part: ModelPart, id: string, path: string): ObjectDef {
  const obj = part.objects.get(id);
  if (!obj) {
    throw new ThreeMfError(`The 3MF file refers to object ${id}, which ${path} does not define.`);
  }
  return obj;
}

function readModel(xml: string, path: string): ModelPart {
  const part: ModelPart = {
    unit: 'millimeter',
    objects: new Map(),
    groupIndex: new Map(),
    groups: [],
    build: [],
  };
  const intern = (id: string): number => {
    let index = part.groupIndex.get(id);
    if (index === undefined) {
      index = part.groups.length;
      part.groupIndex.set(id, index);
      part.groups.push(null);
    }
    return index;
  };

  let obj: ObjectDef | null = null;
  let objId = '';
  let section: '' | 'vertices' | 'triangles' | 'components' | 'build' = '';
  // The color group being read, and its colors so far.
  let group: number | null = null;
  let groupColors: number[] = [];

  try {
    walkXml(xml, {
      open(name, attrs) {
        switch (name) {
          case 'model':
            part.unit = attr(attrs, 'unit') ?? part.unit;
            break;
          case 'object': {
            objId = attr(attrs, 'id') ?? '';
            const pid = attr(attrs, 'pid');
            obj = {
              pid: pid === undefined ? -1 : intern(pid),
              pindex: index(attr(attrs, 'pindex')),
              mesh: null,
              components: [],
            };
            break;
          }
          case 'mesh':
            if (obj) {
              obj.mesh = {
                vertices: new Grow(Float32Array),
                triangles: new Grow(Int32Array),
                props: null,
              };
            }
            break;
          case 'vertices':
          case 'triangles':
          case 'components':
          case 'build':
            section = name;
            break;
          case 'vertex':
            if (section === 'vertices' && obj?.mesh) {
              obj.mesh.vertices.push3(num(attrs, 'x'), num(attrs, 'y'), num(attrs, 'z'));
            }
            break;
          case 'triangle':
            if (section === 'triangles' && obj?.mesh) {
              readTriangle(obj.mesh, attrs, intern);
            }
            break;
          case 'component':
            if (section === 'components' && obj) {
              obj.components.push(placement(attrs));
            }
            break;
          case 'item':
            if (section === 'build') {
              part.build.push(placement(attrs));
            }
            break;
          case 'basematerials':
          case 'colorgroup':
            group = intern(attr(attrs, 'id') ?? '');
            groupColors = [];
            break;
          case 'base':
          case 'color':
            if (group !== null) {
              const value = attr(attrs, name === 'base' ? 'displaycolor' : 'color');
              groupColors.push(...parseColor(value));
            }
            break;
        }
      },
      close(name) {
        switch (name) {
          case 'object':
            if (obj && objId) {
              part.objects.set(objId, obj);
            }
            obj = null;
            break;
          case 'vertices':
          case 'triangles':
          case 'components':
          case 'build':
            section = '';
            break;
          case 'basematerials':
          case 'colorgroup':
            if (group !== null) {
              part.groups[group] = Float32Array.from(groupColors);
            }
            group = null;
            break;
        }
      },
    });
  } catch (err) {
    if (err instanceof ThreeMfError) {
      throw err;
    }
    throw new ThreeMfError(`Could not read ${path} in this 3MF file (${String(err)}).`);
  }
  return part;
}

function readTriangle(mesh: Mesh, attrs: Record<string, string>, intern: (id: string) => number) {
  mesh.triangles.push3(
    vertexIndex(attrs, 'v1'),
    vertexIndex(attrs, 'v2'),
    vertexIndex(attrs, 'v3'),
  );
  const pid = attr(attrs, 'pid');
  const p1 = attr(attrs, 'p1');
  if (pid === undefined && p1 === undefined && !mesh.props) {
    return;
  }
  if (!mesh.props) {
    // Back-fill the triangles read before the first one with a property.
    mesh.props = new Grow(Int32Array);
    for (let i = 0; i < mesh.triangles.length / 3 - 1; i++) {
      mesh.props.push4(-1, -1, -1, -1);
    }
  }
  mesh.props.push4(
    pid === undefined ? -1 : intern(pid),
    index(p1),
    index(attr(attrs, 'p2')),
    index(attr(attrs, 'p3')),
  );
}

function writeMesh(
  obj: ObjectDef,
  part: ModelPart,
  m: Matrix,
  out: Float32Array,
  colors: Float32Array | null,
  start: number,
  fallback: readonly [number, number, number],
  path: string,
): number {
  const mesh = obj.mesh as Mesh;
  const v = mesh.vertices.data;
  const vertexCount = mesh.vertices.length / 3;
  const t = mesh.triangles.data;
  const props = mesh.props?.data;
  const triCount = mesh.triangles.length / 3;
  // A mirroring transform turns the faces inside out; swapping two corners keeps
  // them facing outward, so the lighting does not go dark on mirrored parts.
  const flip = determinant(m) < 0;
  // Corner order within a triangle: 0 1 2, or 0 2 1 when mirrored.
  const second = flip ? 2 : 1;
  const third = flip ? 1 : 2;
  const corner = (vi: number, o: number): void => {
    if (vi < 0 || vi >= vertexCount) {
      throw new ThreeMfError(
        `A triangle in ${path} names vertex ${vi}, but that mesh has ${vertexCount} vertices.`,
      );
    }
    const x = v[vi * 3];
    const y = v[vi * 3 + 1];
    const z = v[vi * 3 + 2];
    out[o] = x * m[0] + y * m[3] + z * m[6] + m[9];
    out[o + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
    out[o + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
  };
  let tri = start;
  for (let i = 0; i < triCount; i++, tri++) {
    const o = tri * 9;
    corner(t[i * 3], o);
    corner(t[i * 3 + second], o + 3);
    corner(t[i * 3 + third], o + 6);
    if (!colors) {
      continue;
    }
    const pid = props && props[i * 4] >= 0 ? props[i * 4] : obj.pid;
    const p1 = props && props[i * 4 + 1] >= 0 ? props[i * 4 + 1] : obj.pindex;
    const palette = pid >= 0 ? part.groups[pid] : null;
    // p2 and p3 default to p1: a triangle with one property is one flat color.
    const pick = (slot: number, offset: number): void => {
      const own = props ? props[i * 4 + slot] : -1;
      const p = slot === 1 || own < 0 ? p1 : own;
      if (palette && p >= 0 && p * 3 + 2 < palette.length) {
        colors[offset] = palette[p * 3];
        colors[offset + 1] = palette[p * 3 + 1];
        colors[offset + 2] = palette[p * 3 + 2];
      } else {
        colors[offset] = fallback[0];
        colors[offset + 1] = fallback[1];
        colors[offset + 2] = fallback[2];
      }
    };
    pick(1, o);
    pick(1 + second, o + 3);
    pick(1 + third, o + 6);
  }
  return tri;
}

function placement(attrs: Record<string, string>): Component {
  const objectId = attr(attrs, 'objectid');
  if (!objectId) {
    throw new ThreeMfError('This 3MF file places an object without saying which.');
  }
  const transform = attr(attrs, 'transform');
  return {
    objectId,
    path: attr(attrs, 'path') ?? null,
    transform: transform === undefined ? IDENTITY : parseMatrix(transform),
  };
}

export function parseMatrix(text: string): Matrix {
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length !== 12 || !values.every(Number.isFinite)) {
    throw new ThreeMfError(
      `This 3MF file has a transform that is not 12 numbers ("${text.slice(0, 80)}").`,
    );
  }
  return values;
}

/** `a` then `b`: the transform that applies `a` to a point first, then `b`. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(12);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = r === 3 ? b[9 + c] : 0;
      for (let k = 0; k < 3; k++) {
        sum += a[r * 3 + k] * b[k * 3 + c];
      }
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

function determinant(m: Matrix): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

function num(attrs: Record<string, string>, name: string): number {
  const value = Number(attr(attrs, name));
  if (!Number.isFinite(value)) {
    throw new ThreeMfError(`This 3MF file has a vertex whose ${name} is not a number.`);
  }
  return value;
}

function vertexIndex(attrs: Record<string, string>, name: string): number {
  const value = index(attr(attrs, name));
  if (value < 0) {
    throw new ThreeMfError(`This 3MF file has a triangle whose ${name} is not a vertex index.`);
  }
  return value;
}

/** A non-negative integer attribute, or -1 when absent or malformed. */
function index(raw: string | undefined): number {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) {
    return -1;
  }
  const value = Number(raw);
  return value <= 0x7fffffff ? value : -1;
}

// sRGB byte to linear, the space Three.js shades vertex colors in.
const LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** `#RRGGBB` or `#RRGGBBAA` as linear RGB; alpha is ignored. Malformed is mid grey. */
export function parseColor(value: string | undefined): [number, number, number] {
  const match = /^\s*#([0-9a-f]{6})(?:[0-9a-f]{2})?\s*$/i.exec(value ?? '');
  if (!match) {
    return [LINEAR[128], LINEAR[128], LINEAR[128]];
  }
  const hex = Number.parseInt(match[1], 16);
  return [LINEAR[(hex >> 16) & 0xff], LINEAR[(hex >> 8) & 0xff], LINEAR[hex & 0xff]];
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A typed array that doubles as it fills, so a mesh of a million vertices is a
// few reallocations rather than a million boxed numbers in a JS array.
type Typed = Float32Array | Int32Array;
class Grow<T extends Typed> {
  data: T;
  length = 0;
  constructor(private readonly make: new (n: number) => T) {
    this.data = new make(1024);
  }
  private reserve(n: number): void {
    if (this.length + n > this.data.length) {
      const next = new this.make(Math.max(this.data.length * 2, this.length + n));
      next.set(this.data);
      this.data = next;
    }
  }
  push3(a: number, b: number, c: number): void {
    this.reserve(3);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  push4(a: number, b: number, c: number, d: number): void {
    this.reserve(4);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
    this.data[this.length++] = d;
  }
}
