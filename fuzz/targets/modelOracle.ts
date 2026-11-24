// What every 3D model a reader hands the viewer must satisfy, shared by the
// glb, obj and step targets. The viewer sizes its buffers and draw ranges from
// these arrays and the parts tree, so a miscount is a finding, not a silent
// overdraw (the same reasoning as the gcode target).
import {
  MAX_PART_DEPTH,
  MAX_PART_NAME,
  MAX_PART_NODES,
  type PartNode,
} from '../../src/webview/parts';

export interface ModelArrays {
  positions: Float32Array;
  colors: Float32Array | null;
  normals: Float32Array | null;
  parts: PartNode;
}

export function checkModel(label: string, model: ModelArrays, maxTriangles: number): void {
  const fail = (what: string): never => {
    throw new Error(`${label}: ${what}`);
  };
  const { positions, colors, normals, parts } = model;
  if (positions.length % 9 !== 0) {
    fail(`${positions.length} position floats is not whole triangles`);
  }
  const triangles = positions.length / 9;
  if (triangles > maxTriangles) {
    fail(`${triangles} triangles is over the cap of ${maxTriangles}`);
  }
  if (colors !== null && colors.length !== positions.length) {
    fail(`${colors.length} color floats for ${positions.length} position floats`);
  }
  if (normals !== null && normals.length !== positions.length) {
    fail(`${normals.length} normal floats for ${positions.length} position floats`);
  }
  let nodes = 0;
  const walk = (node: PartNode, depth: number): void => {
    if (++nodes > MAX_PART_NODES + 1) {
      fail(`the parts tree has more than ${MAX_PART_NODES} nodes`);
    }
    if (depth > MAX_PART_DEPTH + 1) {
      fail(`the parts tree is deeper than ${MAX_PART_DEPTH}`);
    }
    if (typeof node.name !== 'string' || node.name.length > MAX_PART_NAME + 16) {
      fail(`a part name of ${String(node.name?.length)} characters`);
    }
    for (const [start, count] of node.ranges) {
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(count) ||
        start < 0 ||
        count < 0 ||
        start + count > triangles
      ) {
        fail(`part range [${start}, ${count}] is outside ${triangles} triangles`);
      }
    }
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  };
  walk(parts, 0);
}
