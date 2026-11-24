import { FuzzedDataProvider } from '@jazzer.js/core/dist/FuzzedDataProvider';
import {
  StepError,
  readStep,
  type OcctEngine,
  type OcctMesh,
  type OcctNode,
  type OcctResult,
} from '../../src/webview/step';
import { checkModel } from './modelOracle';

// A STEP file is tessellated by Open CASCADE (occt-import-js, WebAssembly) in
// the 3D webview, and MarkCopy's own code is what turns the engine's answer
// into one triangle soup and a parts tree: merging meshes, face colors by
// range, the assembly walk. This target fuzzes that code, not the engine. A
// stand-in engine returns a result built from the input by FuzzedDataProvider:
// meshes with indices past their vertices, short or missing normals, colors of
// the wrong length, face ranges that overlap or run off the end, mesh
// references to nothing, deep trees, a node that is its own child. The engine
// itself is third-party code that runs in the webview sandbox (see
// docs/FUZZING-STRATEGY.md for why it is the boundary, not a target).
//
// A StepError is readStep's documented answer; anything else, or a model whose
// arrays and parts disagree (fuzz/targets/modelOracle.ts), is a finding.
export const MAX_TRIANGLES = 50_000;
// The walk's visit cap, far below the viewer's million: a shared node makes the
// walk exponential, and at the default every such input spent 150 ms or more
// reaching the cap, which held the whole target to under 100 runs a second.
export const MAX_NODE_VISITS = 20_000;

const HEADER = new TextEncoder().encode(
  'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n',
);

function numbers(p: FuzzedDataProvider, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count && p.remainingBytes > 0; i++) {
    const pick = p.consumeIntegralInRange(0, 15);
    out.push(
      pick === 0
        ? Number.NaN
        : pick === 1
          ? Number.POSITIVE_INFINITY
          : pick === 2
            ? -0
            : // Two bytes a coordinate, so an input of a few KB still describes meshes.
              p.consumeIntegralInRange(-32768, 32767) / 16,
    );
  }
  return out;
}

function color(p: FuzzedDataProvider): number[] | undefined {
  if (!p.consumeBoolean()) {
    return undefined;
  }
  return numbers(p, p.consumeIntegralInRange(0, 4)).map((x) => (p.consumeBoolean() ? x : x / 1e6));
}

function mesh(p: FuzzedDataProvider): OcctMesh {
  const vertices = p.consumeIntegralInRange(0, 48);
  const position = numbers(p, vertices * 3);
  const indexCount = p.consumeIntegralInRange(0, 90);
  const index: number[] = [];
  for (let i = 0; i < indexCount && p.remainingBytes > 0; i++) {
    index.push(
      p.consumeIntegralInRange(0, 9) === 0
        ? p.consumeIntegralInRange(-3, vertices + 3) + (p.consumeBoolean() ? 0.5 : 0)
        : p.consumeIntegralInRange(0, Math.max(0, vertices - 1)),
    );
  }
  const triangles = Math.floor(index.length / 3);
  const faces: NonNullable<OcctMesh['brep_faces']> = [];
  const faceCount = p.consumeIntegralInRange(0, 5);
  for (let i = 0; i < faceCount; i++) {
    faces.push({
      first: p.consumeIntegralInRange(-2, triangles + 2),
      last: p.consumeIntegralInRange(-2, triangles + 2),
      color: color(p) ?? null,
    });
  }
  const normalShape = p.consumeIntegralInRange(0, 3);
  return {
    name: p.consumeBoolean() ? p.consumeString(p.consumeIntegralInRange(0, 300)) : undefined,
    color: color(p),
    brep_faces: faces.length > 0 ? faces : undefined,
    attributes: {
      position: { array: position },
      normal:
        normalShape === 0
          ? undefined
          : {
              array: numbers(
                p,
                normalShape === 1 ? vertices * 3 : p.consumeIntegralInRange(0, vertices * 3),
              ),
            },
    },
    index: { array: index },
  };
}

function tree(p: FuzzedDataProvider, meshes: number, depth: number, all: OcctNode[]): OcctNode {
  const node: OcctNode = {};
  all.push(node);
  if (p.consumeBoolean()) {
    node.name = p.consumeString(p.consumeIntegralInRange(0, 300));
  }
  if (p.consumeBoolean()) {
    node.meshes = Array.from({ length: p.consumeIntegralInRange(0, 4) }, () =>
      p.consumeIntegralInRange(-1, meshes + 1),
    );
  }
  const children = depth > 80 || p.remainingBytes === 0 ? 0 : p.consumeIntegralInRange(0, 3);
  if (children > 0) {
    node.children = [];
    for (let i = 0; i < children; i++) {
      const roll = p.consumeIntegralInRange(0, 31);
      // Now and then an earlier node again: shared, or an ancestor (a cycle).
      node.children.push(
        roll === 0 && all.length > 0
          ? all[p.consumeIntegralInRange(0, all.length - 1)]
          : tree(p, meshes, depth + 1, all),
      );
    }
  }
  return node;
}

/** The engine's answer the input describes. */
export function engineResult(data: Buffer): OcctResult {
  const p = new FuzzedDataProvider(data);
  // The shape is decided first, while the input lasts. Once it runs out the
  // provider answers every range with its minimum, so 0 is the ordinary case
  // (success, meshes present, a tree) and the odd ones are the top values.
  const success = p.consumeIntegralInRange(0, 15) !== 15;
  const noMeshList = p.consumeIntegralInRange(0, 15) === 15;
  const noRoot = p.consumeIntegralInRange(0, 7) === 7;
  const count = p.consumeIntegralInRange(1, 6);
  const meshes: OcctMesh[] = [];
  for (let i = 0; i < count && p.remainingBytes > 0; i++) {
    meshes.push(mesh(p));
  }
  return {
    success,
    meshes: noMeshList ? undefined : meshes,
    root: noRoot ? undefined : tree(p, meshes.length, 0, []),
  };
}

export function fuzz(data: Buffer): void {
  const engine: OcctEngine = { ReadStepFile: () => engineResult(data) };
  let model;
  try {
    model = readStep(engine, HEADER, {
      maxTriangles: MAX_TRIANGLES,
      maxNodeVisits: MAX_NODE_VISITS,
    });
  } catch (err) {
    if (err instanceof StepError) {
      return;
    }
    throw err;
  }
  checkModel('step', model, MAX_TRIANGLES);
}
