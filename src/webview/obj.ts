// Reads a Wavefront OBJ model (.obj) into one triangle soup with a color per
// vertex, the shape the 3D viewer's single-geometry pipeline (section, compare,
// print bed, parts) takes from a 3MF or a GLB. Browser side, no DOM: tests run it
// under jsdom.
//
// OBJ is text, and three's OBJLoader holds every face it reads in plain JS number
// arrays (8 bytes a float, a normal and a UV beside each position), so a file is
// scanned first, line by line, WITHOUT allocating per vertex: the vertices,
// triangles (an n-gon is n-2), objects and materials are counted and every face
// index is checked against what was declared so far. Past the caps, or on an
// index that points nowhere, the file is refused before OBJLoader runs.
//
// Colors come from the .mtl files the host read from the OBJ's own folder and
// sent along (see src/stlEditor.ts): parsed HERE, never by MTLLoader, and every
// texture line is ignored, so nothing is fetched and the CSP stays as it is. A
// material's Kd is the color; per-vertex colors (`v x y z r g b`) win where a
// mesh has them for every vertex.
//
// Parts: one per `o` object, else one per `g` group, else the whole file. Several
// materials inside one object are ONE part. OBJLoader makes one mesh per o/g line
// (and renames its starting, implicit object on the first one), which the scan
// mirrors to map meshes back to their lines.
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OBJ_BINARY_MESSAGE, objIsBinary } from './modelSniff';
import { PartTreeBuilder, type PartNode } from './parts';
import { MAX_TRIANGLES } from './stlInfo';

/** An OBJ the viewer cannot or will not show; the message is for the person. */
export class ObjError extends Error {}

// A mesh has no use for more vertices than three times its triangles.
export const MAX_OBJ_VERTICES = MAX_TRIANGLES * 3;
// A line longer than this is not a model line (an n-gon of this many characters
// has tens of thousands of corners).
export const MAX_OBJ_LINE = 256 * 1024;
// o and g lines together, and usemtl lines: each starts a mesh or a range.
export const MAX_OBJ_OBJECTS = 20_000;
export const MAX_OBJ_MATERIAL_USES = 50_000;
// Materials, and the length of one .mtl line, that are read from .mtl files.
export const MAX_MTL_MATERIALS = 20_000;
const MAX_MTL_LINE = 4096;

/** One object or group in the file: what OBJLoader turns into one mesh. */
export interface ObjSegment {
  kind: 'o' | 'g' | '';
  name: string;
  /** Which `o` line it sits under, counted from 1 (0 before the first), and that line's name. */
  object: number;
  objectName: string;
  triangles: number;
  /** An `l` or `p` line is in it: OBJLoader then makes lines or points, not a mesh. */
  linesOrPoints: boolean;
}

export interface ObjScan {
  vertices: number;
  triangles: number;
  /** Every face vertex has a normal that exists, so the file's `vn` can be kept. */
  allNormals: boolean;
  segments: ObjSegment[];
}

export interface ScanLimits {
  maxTriangles?: number;
  maxVertices?: number;
  maxLine?: number;
  maxObjects?: number;
  maxMaterialUses?: number;
}

const OBJECT_LINE = /^[og]\s*(.+)?/;

// A face index resolved against the count declared so far, as OBJLoader does:
// 1 is the first, -1 the last. Zero and anything out of range point at nothing.
function resolves(token: string, count: number): boolean {
  const index = parseInt(token, 10);
  if (!Number.isFinite(index) || index === 0) {
    return false;
  }
  const at = index > 0 ? index - 1 : index + count;
  return at >= 0 && at < count;
}

/**
 * Counts what a file holds and checks every face index, without building
 * anything per vertex. Throws ObjError past a cap or on a bad index. The loop
 * mirrors OBJLoader's line classification (by first character) so that the
 * counts are what the loader will go on to allocate.
 */
export function scanObj(text: string, limits: ScanLimits = {}): ObjScan {
  const maxTriangles = limits.maxTriangles ?? MAX_TRIANGLES;
  const maxVertices = limits.maxVertices ?? MAX_OBJ_VERTICES;
  const maxLine = limits.maxLine ?? MAX_OBJ_LINE;
  const maxObjects = limits.maxObjects ?? MAX_OBJ_OBJECTS;
  const maxUses = limits.maxMaterialUses ?? MAX_OBJ_MATERIAL_USES;

  // The loader joins a line continued with a backslash before it splits lines.
  let source = text;
  if (source.indexOf('\r\n') !== -1) {
    source = source.replace(/\r\n/g, '\n');
  }
  if (source.indexOf('\\\n') !== -1) {
    source = source.replace(/\\\n/g, '');
  }

  let vertices = 0;
  let normals = 0;
  let uvs = 0;
  let triangles = 0;
  let uses = 0;
  let allNormals = true;
  // The loader's implicit first object: the first o or g line renames it.
  let current: ObjSegment = {
    kind: '',
    name: '',
    object: 0,
    objectName: '',
    triangles: 0,
    linesOrPoints: false,
  };
  let named = false;
  let objects = 0;
  let objectName = '';
  const segments: ObjSegment[] = [current];

  let at = 0;
  let lineNo = 0;
  while (at <= source.length) {
    let end = source.indexOf('\n', at);
    if (end < 0) {
      end = source.length;
    }
    lineNo++;
    if (end - at > maxLine) {
      throw new ObjError(
        `Line ${lineNo} of this OBJ file is ${Math.round((end - at) / 1024).toLocaleString()} KiB long, past the ${Math.round(maxLine / 1024)} KiB the preview reads.`,
      );
    }
    const line = source.slice(at, end).trimStart();
    at = end + 1;
    if (line.length === 0) {
      continue;
    }
    const first = line.charAt(0);
    if (first === '#') {
      continue;
    }
    if (first === 'v') {
      const kind = line.slice(1, 2);
      if (kind === ' ' || kind === '\t') {
        vertices++;
      } else if (kind === 'n' && /\s/.test(line.charAt(2))) {
        normals++;
      } else if (kind === 't' && /\s/.test(line.charAt(2))) {
        uvs++;
      }
      if (vertices > maxVertices || normals > maxVertices || uvs > maxVertices) {
        throw new ObjError(
          `This OBJ file declares more than ${maxVertices.toLocaleString()} vertices, normals or texture coordinates, past what the preview opens.`,
        );
      }
    } else if (first === 'f') {
      const tokens = line
        .slice(1)
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      for (const token of tokens) {
        const parts = token.split('/');
        if (!resolves(parts[0], vertices)) {
          throw new ObjError(
            `Line ${lineNo} of this OBJ file uses a vertex that has not been declared (${token.slice(0, 40)}).`,
          );
        }
        if (parts[2] === undefined || parts[2] === '' || !resolves(parts[2], normals)) {
          allNormals = false;
        }
      }
      const n = Math.max(0, tokens.length - 2);
      triangles += n;
      current.triangles += n;
      if (triangles > maxTriangles) {
        throw new ObjError(
          `This OBJ file has more than ${maxTriangles.toLocaleString()} triangles, past what the preview opens.`,
        );
      }
    } else if (first === 'l' || first === 'p') {
      current.linesOrPoints = true;
    } else {
      const object = OBJECT_LINE.exec(line);
      if (object !== null) {
        const name = (object[1] ?? '').trim();
        const kind = first === 'o' ? 'o' : 'g';
        if (kind === 'o') {
          objects++;
          objectName = name;
        }
        if (!named) {
          // The loader's own rule: the first o or g names the object that
          // was already open, faces and all.
          named = true;
          current.kind = kind;
          current.name = name;
          current.object = objects;
          current.objectName = objectName;
        } else {
          current = {
            kind,
            name,
            object: objects,
            objectName,
            triangles: 0,
            linesOrPoints: false,
          };
          segments.push(current);
        }
        if (segments.length > maxObjects) {
          throw new ObjError(
            `This OBJ file has more than ${maxObjects.toLocaleString()} objects and groups, past what the preview opens.`,
          );
        }
      } else if (line.startsWith('usemtl ') && ++uses > maxUses) {
        throw new ObjError(
          `This OBJ file switches material more than ${maxUses.toLocaleString()} times, past what the preview opens.`,
        );
      }
    }
  }
  return { vertices, triangles, allNormals: allNormals && triangles > 0, segments };
}

// ---------------------------------------------------------------------------
// .mtl
// ---------------------------------------------------------------------------

export interface MtlFile {
  name: string;
  text: string;
}

export interface MtlMaterial {
  /** Diffuse color, sRGB 0..1, as the file gives it. */
  kd: [number, number, number] | null;
  /** From `d`, or 1 - `Tr`. Read, but the preview draws every surface opaque. */
  opacity: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * The materials of some .mtl files: `newmtl` starts one, `Kd r g b` is its color
 * (one number is a grey) and `d` or `Tr` its opacity. Every other line is
 * ignored, in particular every `map_*` texture line and `bump`, so nothing in a
 * .mtl can name a file or a URL to load. A later definition of a name wins.
 */
export function parseMtl(files: ReadonlyArray<MtlFile>): Map<string, MtlMaterial> {
  const materials = new Map<string, MtlMaterial>();
  for (const file of files) {
    let current: MtlMaterial | null = null;
    for (const raw of file.text.split('\n')) {
      if (raw.length > MAX_MTL_LINE) {
        continue;
      }
      const line = raw.trim();
      if (line.length === 0 || line.charAt(0) === '#') {
        continue;
      }
      const words = line.split(/\s+/);
      const key = words[0].toLowerCase();
      if (key === 'newmtl') {
        if (materials.size >= MAX_MTL_MATERIALS && !materials.has(line.slice(6).trim())) {
          current = null;
          continue;
        }
        current = { kd: null, opacity: 1 };
        materials.set(line.slice(6).trim(), current);
      } else if (current && key === 'kd') {
        const nums = words.slice(1, 4).map(Number);
        if (nums.length > 0 && nums.every((n) => Number.isFinite(n))) {
          const [r, g = r, b = r] = nums;
          current.kd = [clamp01(r), clamp01(g), clamp01(b)];
        }
      } else if (current && (key === 'd' || key === 'tr')) {
        // `d -halo 0.5` puts the number last.
        const value = Number(words[words.length - 1]);
        if (Number.isFinite(value)) {
          current.opacity = clamp01(key === 'd' ? value : 1 - value);
        }
      }
    }
  }
  return materials;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ObjModel {
  /** Nine floats per triangle, in the file's own axes. */
  positions: Float32Array;
  /** Three floats per vertex, linear; null when nothing in the file is colored. */
  colors: Float32Array | null;
  /** Three floats per vertex when every face vertex had a normal; else null. */
  normals: Float32Array | null;
  /** One leaf per o object, else per g group, else one for the file. */
  parts: PartNode;
}

export interface ObjOptions {
  /** The .mtl files the host read from the OBJ's folder. */
  mtl?: ReadonlyArray<MtlFile>;
  /** The color of a surface with no material color (markcopy.stl.meshColor), linear. */
  fallbackColor?: [number, number, number];
  limits?: ScanLimits;
}

interface Piece {
  mesh: THREE.Mesh;
  triangles: number;
  segment: ObjSegment | null;
}

// The loader reports an unrecognised line with console.warn, once per line: a
// file of a million of them would be a million warnings.
function quietly<T>(run: () => T): T {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return run();
  } finally {
    console.warn = warn;
  }
}

function srgb(rgb: [number, number, number]): [number, number, number] {
  const c = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

export function readObj(bytes: Uint8Array, options: ObjOptions = {}): ObjModel {
  if (objIsBinary(bytes)) {
    throw new ObjError(OBJ_BINARY_MESSAGE);
  }
  const text = new TextDecoder().decode(bytes);
  const scan = scanObj(text, options.limits);
  if (scan.triangles === 0) {
    throw new ObjError(
      'This OBJ file has no faces to show. The preview draws triangles and polygons, not points or lines.',
    );
  }

  // Bounded above. Only now does anything get allocated per vertex.
  const group = quietly(() => new OBJLoader().parse(text));
  const meshes = group.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh === true);

  const total = meshes.reduce((n, m) => n + m.geometry.getAttribute('position').count / 3, 0);
  const positions = new Float32Array(total * 9);
  const materials = parseMtl(options.mtl ?? []);
  const fallback = options.fallbackColor ?? [0.54, 0.7, 0.97];
  const colors = new Float32Array(total * 9);
  let colored = false;
  const normals = scan.allNormals ? new Float32Array(total * 9) : null;

  // Which o or g line each mesh came from: the segments that make a mesh, in
  // order. If the loader disagrees (it should not), each mesh is its own part.
  const expected = scan.segments.filter((s) => s.triangles > 0 && !s.linesOrPoints);
  const mapped =
    expected.length === meshes.length &&
    expected.every((s, i) => s.triangles === meshes[i].geometry.getAttribute('position').count / 3);
  const pieces: Piece[] = meshes.map((mesh, i) => ({
    mesh,
    triangles: mesh.geometry.getAttribute('position').count / 3,
    segment: mapped
      ? expected[i]
      : {
          kind: 'g',
          name: mesh.name,
          object: 0,
          objectName: '',
          triangles: 0,
          linesOrPoints: false,
        },
  }));

  const rgbOf = new Map<string, [number, number, number]>();
  const colorOf = (name: string): [number, number, number] | null => {
    const known = rgbOf.get(name);
    if (known) {
      return known;
    }
    const kd = materials.get(name)?.kd;
    if (!kd) {
      return null;
    }
    const linear = srgb(kd);
    rgbOf.set(name, linear);
    return linear;
  };

  let offset = 0; // in triangles
  const starts: number[] = [];
  for (const { mesh, triangles } of pieces) {
    starts.push(offset);
    const geometry = mesh.geometry;
    const pos = geometry.getAttribute('position').array;
    positions.set(pos, offset * 9);
    if (normals) {
      const nor = geometry.getAttribute('normal')?.array;
      if (nor && nor.length === pos.length) {
        normals.set(nor, offset * 9);
      }
    }

    // Colors: the material's Kd per range, then the file's own vertex colors
    // over it where it has them for every vertex of this mesh.
    const base = offset * 9;
    const vertexCount = triangles * 3;
    for (let v = 0; v < vertexCount; v++) {
      colors.set(fallback, base + v * 3);
    }
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const ranges = Array.isArray(mesh.material)
      ? geometry.groups.map((g) => ({
          start: g.start,
          count: g.count,
          name: list[g.materialIndex ?? 0]?.name ?? '',
        }))
      : [{ start: 0, count: vertexCount, name: list[0]?.name ?? '' }];
    for (const range of ranges) {
      const rgb = colorOf(range.name);
      if (!rgb) {
        continue;
      }
      colored = true;
      const to = Math.min(vertexCount, range.start + range.count);
      for (let v = Math.max(0, range.start); v < to; v++) {
        colors.set(rgb, base + v * 3);
      }
    }
    const own = geometry.getAttribute('color')?.array;
    if (own && own.length === pos.length) {
      colors.set(own, base);
      colored = true;
    }
    offset += triangles;
  }

  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      throw new ObjError('This OBJ file has vertex coordinates that are not numbers.');
    }
  }
  let keepNormals = normals;
  if (normals) {
    for (let i = 0; i < normals.length; i++) {
      if (!Number.isFinite(normals[i])) {
        keepNormals = null;
        break;
      }
    }
  }
  for (const { mesh } of pieces) {
    mesh.geometry.dispose();
  }

  return {
    positions,
    colors: colored ? colors : null,
    normals: keepNormals,
    parts: objParts(pieces, starts, total),
  };
}

// One leaf per `o` object when the file has any (a `g` inside it belongs to it),
// else one per `g` group, else one for the whole file. A part's meshes are its
// ranges, so an object with several materials is ONE part. Exported for tests.
export function objParts(
  pieces: ReadonlyArray<{ triangles: number; segment: ObjSegment | null }>,
  starts: ReadonlyArray<number>,
  total: number,
): PartNode {
  const builder = new PartTreeBuilder(total);
  const byObject = pieces.some((p) => p.segment?.kind === 'o');
  const byGroup = !byObject && pieces.some((p) => p.segment?.kind === 'g');
  if (!byObject && !byGroup) {
    builder.leaf('', [[0, total]]);
    return builder.finish();
  }
  let name = '';
  let ranges: Array<[number, number]> = [];
  const flush = (): void => {
    if (ranges.length > 0) {
      builder.leaf(name, ranges);
    }
    ranges = [];
  };
  let key = '';
  pieces.forEach((piece, i) => {
    const seg = piece.segment;
    // An o object's groups belong to it; a group before any o line stands alone.
    const under = !byGroup && seg !== null && seg.object > 0;
    const next = under ? `o${seg.object}` : `s${i}`;
    if (next !== key || i === 0) {
      flush();
      key = next;
      name = under ? seg.objectName : (seg?.name ?? '');
    }
    const last = ranges[ranges.length - 1];
    if (last && last[0] + last[1] === starts[i]) {
      last[1] += piece.triangles;
    } else {
      ranges.push([starts[i], piece.triangles]);
    }
  });
  flush();
  return builder.finish();
}
