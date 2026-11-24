// Reads a STEP file (.step, .stp) into one colored triangle soup for the 3D
// viewer, using occt-import-js: Open CASCADE compiled to WebAssembly. Browser
// side, with the engine handed in so tests can run it in Node.
//
// The engine is 7.6 MB raw, so it ships gzipped as its own file
// (media/occt-import-js.wasm.gz, see esbuild.web.js) and is fetched only when a
// STEP file opens. The JS glue (~97 KB) is bundled into media/stl.js. The glue
// is given the decompressed bytes as `wasmBinary`, so it never fetches anything
// itself. The file stays a separate, replaceable file because the engine is
// LGPL-2.1; see .github/SECURITY.md and the notices beside it.
import occtimportjs from 'occt-import-js';
import { stepHeaderProblem } from './modelSniff';
import { MAX_TRIANGLES } from './stlInfo';
import { PartTreeBuilder, type PartNode } from './parts';

/** A STEP file the viewer cannot show; the message is for the person. */
export class StepError extends Error {}

// More nodes than this is not an assembly to preview: it is a loop, or a tree
// that would cost more to walk than to refuse.
const MAX_NODE_VISITS = 1_000_000;

export interface OcctMesh {
  name?: string;
  color?: number[];
  brep_faces?: Array<{ first: number; last: number; color: number[] | null }>;
  attributes: {
    position: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index: { array: ArrayLike<number> };
}

/** A node of the assembly tree: `meshes` index the result's `meshes`. */
export interface OcctNode {
  name?: string;
  meshes?: number[];
  children?: OcctNode[];
}

export interface OcctResult {
  success: boolean;
  root?: OcctNode;
  meshes?: OcctMesh[];
}

export interface OcctEngine {
  ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
}

/** Fine enough that a fillet reads as round, coarse enough to stay quick. */
export const STEP_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

export interface StepModel {
  /** Nine floats per triangle, millimetres, the file's own axes. */
  positions: Float32Array;
  /** Three floats per vertex. */
  colors: Float32Array;
  /** Three floats per vertex, when the engine gave a normal for every vertex. */
  normals: Float32Array | null;
  /** Whether the file colored anything; false means colors is all the fallback. */
  colored: boolean;
  /** The assembly tree: leaves are triangle ranges of `positions`. */
  parts: PartNode;
}

export interface StepOptions {
  maxTriangles?: number;
  /** Nodes the assembly walk may visit before it refuses the file (MAX_NODE_VISITS). */
  maxNodeVisits?: number;
  fallbackColor?: [number, number, number];
}

/**
 * Tessellate a STEP file with `engine` and merge every solid into one triangle
 * soup with a color per vertex: a face's own color, else its solid's, else the
 * fallback. The triangle total is checked before the merged arrays exist.
 */
export function readStep(
  engine: OcctEngine,
  bytes: Uint8Array,
  options: StepOptions = {},
): StepModel {
  const max = options.maxTriangles ?? MAX_TRIANGLES;
  const fallback = options.fallbackColor ?? [0.25, 0.45, 0.94];
  const problem = stepHeaderProblem(bytes);
  if (problem) {
    throw new StepError(`This file cannot be read: ${problem}`);
  }
  let result: OcctResult;
  try {
    result = engine.ReadStepFile(bytes, STEP_PARAMS);
  } catch (err) {
    throw new StepError(`The STEP engine could not read this file (${String(err)}).`);
  }
  if (!result || !result.success) {
    throw new StepError(
      'The STEP engine could not read this file. It may be damaged or use a part of STEP it does not support.',
    );
  }
  // `root` refers to meshes by their place in the engine's own list, so keep
  // that index while dropping the ones with nothing to draw.
  const all = result.meshes ?? [];
  const keep: number[] = [];
  all.forEach((m, i) => {
    if (m?.index?.array?.length >= 3) {
      keep.push(i);
    }
  });
  const meshes = keep.map((i) => all[i]);
  let triangles = 0;
  for (const mesh of meshes) {
    triangles += Math.floor(mesh.index.array.length / 3);
    if (triangles > max) {
      throw new StepError(
        `This STEP file tessellates to ${triangles.toLocaleString()} triangles or more, above the ${max.toLocaleString()} MarkCopy previews.`,
      );
    }
  }
  if (triangles === 0) {
    throw new StepError('This STEP file holds no solid geometry to show.');
  }

  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  const normals = new Float32Array(triangles * 9);
  let allNormals = true;
  let colored = false;
  let at = 0;
  // Where each kept mesh landed, as `[first triangle, count]`, by engine index.
  const placed = new Map<number, [number, number]>();
  for (const [k, mesh] of meshes.entries()) {
    placed.set(keep[k], [at / 9, Math.floor(mesh.index.array.length / 3)]);
    const position = mesh.attributes?.position?.array;
    const normal = mesh.attributes?.normal?.array;
    const index = mesh.index.array;
    const vertices = position ? Math.floor(position.length / 3) : 0;
    const hasNormals = !!normal && normal.length >= vertices * 3;
    const count = Math.floor(index.length / 3);
    // One color per triangle: the solid's, overlaid by each face's range.
    const solid = validColor(mesh.color);
    const perTriangle: Array<[number, number, number] | null> = new Array(count).fill(solid);
    for (const face of mesh.brep_faces ?? []) {
      const color = validColor(face?.color);
      if (color) {
        const last = Math.min(count - 1, Math.floor(face.last));
        for (let t = Math.max(0, Math.floor(face.first)); t <= last; t++) {
          perTriangle[t] = color;
        }
      }
    }
    for (let t = 0; t < count; t++) {
      const color = perTriangle[t];
      colored ||= color !== null;
      const [r, g, b] = color ?? fallback;
      for (let k = 0; k < 3; k++) {
        const v = index[t * 3 + k];
        if (!(v >= 0 && v < vertices)) {
          throw new StepError('The STEP engine returned a triangle that points outside its mesh.');
        }
        positions[at] = position![v * 3];
        positions[at + 1] = position![v * 3 + 1];
        positions[at + 2] = position![v * 3 + 2];
        if (hasNormals) {
          normals[at] = normal![v * 3];
          normals[at + 1] = normal![v * 3 + 1];
          normals[at + 2] = normal![v * 3 + 2];
        } else {
          allNormals = false;
        }
        colors[at] = r;
        colors[at + 1] = g;
        colors[at + 2] = b;
        at += 3;
      }
    }
  }
  return {
    positions,
    colors,
    normals: allNormals ? normals : null,
    colored,
    parts: stepParts(result.root, all, placed, triangles, options.maxNodeVisits ?? MAX_NODE_VISITS),
  };
}

// The engine's assembly tree as parts. Its root is the document, not a part, so
// its contents sit at the top. A mesh the tree never names (or a result with no
// tree at all) is still a part, so every triangle belongs to one.
function stepParts(
  root: OcctNode | undefined,
  all: OcctMesh[],
  placed: Map<number, [number, number]>,
  total: number,
  maxVisits: number,
): PartNode {
  const builder = new PartTreeBuilder(total);
  const used = new Set<number>();
  const meshLeaf = (index: unknown, name: unknown): void => {
    if (typeof index !== 'number' || used.has(index)) {
      return;
    }
    const range = placed.get(index);
    if (range) {
      used.add(index);
      builder.leaf(name || all[index]?.name, [range]);
    }
  };
  // An explicit stack: the tree is the file's, and may be as deep as it likes.
  type Step = { node: OcctNode; top: boolean } | 'end';
  const todo: Step[] = root && typeof root === 'object' ? [{ node: root, top: true }] : [];
  let visits = 0;
  while (todo.length > 0) {
    const step = todo.pop() as Step;
    if (step === 'end') {
      builder.end();
      continue;
    }
    // A guard on the walk itself, as glb.ts has. The engine builds a fresh
    // object per node, but nothing here should rely on that: a node reachable
    // twice is walked twice, so a shared node makes the walk exponential and a
    // cycle makes it endless (the step fuzz target found both, 2026-11-23).
    if (++visits > maxVisits) {
      throw new StepError(
        'This STEP file has an assembly tree too large to show, or one that loops.',
      );
    }
    const { node, top } = step;
    const own = Array.isArray(node.meshes) ? node.meshes : [];
    const kids = Array.isArray(node.children) ? node.children : [];
    if (!top && kids.length === 0 && own.length === 1) {
      // A part: the node's name is the part's.
      meshLeaf(own[0], node.name);
      continue;
    }
    if (!top) {
      builder.begin(node.name);
      todo.push('end');
    }
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i] && typeof kids[i] === 'object') {
        todo.push({ node: kids[i], top: false });
      }
    }
    // The node's own meshes come before its children: they are written now, the
    // children are popped after.
    for (const index of own) {
      meshLeaf(index, '');
    }
  }
  for (const index of placed.keys()) {
    meshLeaf(index, '');
  }
  return builder.finish();
}

function validColor(color: number[] | null | undefined): [number, number, number] | null {
  return Array.isArray(color) &&
    color.length >= 3 &&
    color.slice(0, 3).every((c) => Number.isFinite(c))
    ? [color[0], color[1], color[2]]
    : null;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------
let engine: Promise<OcctEngine> | null = null;

/**
 * Where the gzipped engine is served from: beside the bundle that is running,
 * never from a value a message carries. The query (a cache-busting token the
 * host puts on the bundle's own URL) is kept so a new version is fetched anew.
 */
export function stepEngineUrl(base: string = import.meta.url): string {
  const own = new URL(base);
  const url = new URL('occt-import-js.wasm.gz', own);
  url.search = own.search;
  return url.href;
}

/** The gzipped engine, fetched and inflated by the browser. */
async function fetchWasm(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new StepError(`Could not load the STEP engine (${res.status} ${res.statusText}).`);
  }
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

/**
 * Start the engine, once for the life of the webview. A failure is not cached,
 * so reopening a file tries again.
 */
export function loadStepEngine(
  deps: {
    fetchWasm?: (url: string) => Promise<ArrayBuffer>;
    factory?: (options: { wasmBinary: ArrayBuffer }) => Promise<unknown>;
  } = {},
): Promise<OcctEngine> {
  if (!engine) {
    const get = deps.fetchWasm ?? fetchWasm;
    const make = deps.factory ?? occtimportjs;
    const started = (async () => {
      let wasmBinary: ArrayBuffer;
      try {
        wasmBinary = await get(stepEngineUrl());
      } catch (err) {
        throw err instanceof StepError
          ? err
          : new StepError(`Could not load the STEP engine (${String(err)}).`);
      }
      try {
        return (await make({ wasmBinary })) as OcctEngine;
      } catch (err) {
        throw new StepError(`Could not start the STEP engine (${String(err)}).`);
      }
    })();
    engine = started;
    started.catch(() => {
      if (engine === started) {
        engine = null;
      }
    });
  }
  return engine;
}

/** Forget the cached engine. For tests. */
export function resetStepEngine(): void {
  engine = null;
}
