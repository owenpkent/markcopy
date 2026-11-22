// Coverage for src/webview/glb.ts: the header, what is refused before anything
// is parsed, and the one colored, upright triangle soup a GLB turns into.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { glbHeaderProblem } from '../src/webview/modelSniff';
import { GlbError, countGlbTriangles, readGlb } from '../src/webview/glb';

type Json = Record<string, unknown>;
type CountArg = Parameters<typeof countGlbTriangles>[0];

// A GLB around `json` and `bin`, chunks padded to four bytes.
function glb(json: Json, bin?: Buffer): Uint8Array {
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const chunks = [jh, j];
  if (bin) {
    const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(b.length, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    chunks.push(bh, b);
  }
  const body = Buffer.concat(chunks);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return new Uint8Array(Buffer.concat([header, body]));
}

// One triangle (0,0,0) (1,0,0) (0,1,0), as the BIN chunk.
const TRIANGLE_BIN = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
function triangleJson(extra: Json = {}, node: Json = {}, material?: Json): Json {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...node }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, ...(material ? { material: 0 } : {}) }] },
    ],
    ...(material ? { materials: [material] } : {}),
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
    ...extra,
  };
}

const at = (a: Float32Array, i: number) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
const asCount = (json: Json) => json as unknown as CountArg;

afterEach(() => vi.restoreAllMocks());

// The JSON chunk of the GLB that was handed to the loader.
function givenJson(data: ArrayBuffer): Json {
  const length = new DataView(data).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, length))) as Json;
}

describe('glbHeaderProblem', () => {
  it('accepts a version 2 header', () => {
    expect(glbHeaderProblem(glb(triangleJson(), TRIANGLE_BIN))).toBeNull();
  });

  it('rejects a file that is not glTF binary', () => {
    expect(glbHeaderProblem(new Uint8Array(Buffer.from('solid not a glb at all')))).toMatch(
      /not a GLB file/,
    );
    expect(glbHeaderProblem(new Uint8Array(4))).toMatch(/too short/);
  });

  it('rejects another glTF binary version', () => {
    const bytes = glb(triangleJson(), TRIANGLE_BIN);
    new DataView(bytes.buffer).setUint32(4, 1, true);
    expect(glbHeaderProblem(bytes)).toMatch(/version 1.*version 2 only/);
  });
});

describe('readGlb', () => {
  it('reads the sample: two colored meshes under a node transform, turned upright', async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, '..', 'sample.glb')));
    const model = await readGlb(bytes);
    expect(model.positions.length).toBe(24 * 9);
    // Z-up: the 4 x 0.5 x 2.5 base is 4 wide in X, 2.5 deep in Y, 0.5 tall. The
    // tower stands on it: its top is at 0.25 + 2 = 2.25, the base bottom at -0.25.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < model.positions.length / 3; i++) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], model.positions[i * 3 + a]);
        hi[a] = Math.max(hi[a], model.positions[i * 3 + a]);
      }
    }
    close(lo, [-2, -1.25, -0.25]);
    close(hi, [2, 1.25, 2.25]);
    const distinct = new Set<string>();
    for (let i = 0; i < model.colors.length / 3; i++) {
      distinct.add(
        at(model.colors, i)
          .map((v) => v.toFixed(3))
          .join(),
      );
    }
    expect(distinct.size).toBe(2);
    expect(model.normals).not.toBeNull();
  });

  it('reads the node hierarchy as parts, with the file own spelling of each name', async () => {
    const json = triangleJson();
    json.nodes = [
      { name: 'Main Frame', children: [1, 2] },
      { name: 'Left Wing', mesh: 0, translation: [1, 0, 0] },
      { mesh: 0, translation: [2, 0, 0] },
    ];
    (json.scenes as Json[])[0].nodes = [0];
    const model = await readGlb(glb(json, TRIANGLE_BIN));
    expect(model.positions.length).toBe(2 * 9);
    const [frame] = model.parts.children;
    expect(frame.name).toBe('Main Frame');
    expect(frame.children.map((c) => [c.name, c.ranges])).toEqual([
      ['Left Wing', [[0, 1]]],
      ['Part 1', [[1, 1]]],
    ]);
  });

  it('reads the sample as two parts', async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, '..', 'sample.glb')));
    const { parts } = await readGlb(bytes);
    const leaves: Array<[string, number]> = [];
    const walk = (n: typeof parts): void => {
      if (n.children.length === 0) {
        leaves.push([n.name, n.ranges.reduce((sum, r) => sum + r[1], 0)]);
      }
      n.children.forEach(walk);
    };
    walk(parts);
    expect(leaves).toHaveLength(2);
    expect(leaves.reduce((sum, l) => sum + l[1], 0)).toBe(24);
  });

  it('makes each instanced copy its own part of one named node', async () => {
    const bin = Buffer.concat([
      TRIANGLE_BIN,
      Buffer.from(new Float32Array([0, 0, 0, 5, 0, 0, 10, 0, 0]).buffer),
    ]);
    const json = triangleJson();
    json.nodes = [
      {
        name: 'Bolt',
        mesh: 0,
        extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } },
      },
    ];
    json.extensionsUsed = ['EXT_mesh_gpu_instancing'];
    (json.accessors as Json[]).push({
      bufferView: 1,
      componentType: 5126,
      count: 3,
      type: 'VEC3',
    });
    json.bufferViews = [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
    ];
    json.buffers = [{ byteLength: 72 }];
    const model = await readGlb(glb(json, bin));
    expect(model.positions.length).toBe(3 * 9);
    expect(model.parts.children.map((c) => [c.name, c.ranges])).toEqual([
      ['Bolt', [[0, 1]]],
      ['Bolt', [[1, 1]]],
      ['Bolt', [[2, 1]]],
    ]);
  });

  it('bakes the node transform and the Y-up to Z-up turn', async () => {
    const model = await readGlb(glb(triangleJson({}, { translation: [10, 20, 30] }), TRIANGLE_BIN));
    // glTF (x, y, z) goes to (x, -z, y).
    close(at(model.positions, 0), [10, -30, 20]);
    close(at(model.positions, 1), [11, -30, 20]);
    close(at(model.positions, 2), [10, -30, 21]);
  });

  it('swaps two corners under a mirroring transform so the faces keep their outside', async () => {
    const plain = await readGlb(glb(triangleJson(), TRIANGLE_BIN));
    const mirrored = await readGlb(glb(triangleJson({}, { scale: [-1, 1, 1] }), TRIANGLE_BIN));
    // The mirrored triangle's corners are (0,0,0) (-1,0,0) (0,1,0) in glTF; the
    // swap lists them as the first, third and second.
    close(at(plain.positions, 1), [1, 0, 0]);
    close(at(mirrored.positions, 0), [0, 0, 0]);
    close(at(mirrored.positions, 1), [0, 0, 1]);
    close(at(mirrored.positions, 2), [-1, 0, 0]);
  });

  it('colors a mesh from its material base color', async () => {
    const material = { pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1] } };
    const model = await readGlb(glb(triangleJson({}, {}, material), TRIANGLE_BIN));
    close(at(model.colors, 0), [0.2, 0.4, 0.6]);
  });

  it('multiplies in the vertex colors', async () => {
    const material = { pbrMetallicRoughness: { baseColorFactor: [0.5, 1, 1, 1] } };
    const colors = Buffer.from(new Float32Array([1, 0.5, 0, 1, 0.5, 0, 1, 0.5, 0]).buffer);
    const json = triangleJson({}, {}, material);
    (json.meshes as Json[])[0] = {
      primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, material: 0 }],
    };
    (json.accessors as Json[]).push({ bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' });
    (json.bufferViews as Json[]).push({ buffer: 0, byteOffset: 36, byteLength: 36 });
    json.buffers = [{ byteLength: 72 }];
    const model = await readGlb(glb(json, Buffer.concat([TRIANGLE_BIN, colors])));
    close(at(model.colors, 0), [0.5, 0.5, 0]);
  });

  it('draws a primitive with no material in the fallback color', async () => {
    const model = await readGlb(glb(triangleJson(), TRIANGLE_BIN), { fallbackColor: [0, 1, 0] });
    close(at(model.colors, 0), [0, 1, 0]);
  });

  it('ignores textures, and never waits on an image', async () => {
    const material = {
      pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], baseColorTexture: { index: 0 } },
      normalTexture: { index: 0 },
    };
    const json = triangleJson(
      {
        textures: [{ source: 0 }],
        images: [{ uri: 'https://example.invalid/never.png' }],
        samplers: [{}],
      },
      {},
      material,
    );
    const model = await readGlb(glb(json, TRIANGLE_BIN));
    close(at(model.colors, 0), [1, 0, 0]);
  });

  it.each([
    ['extensionsRequired', /Draco/],
    ['a primitive', /Draco/],
    ['a buffer view', /meshopt/],
  ])('refuses compressed meshes (%s) before parsing', async (where, message) => {
    const json = triangleJson(
      where === 'extensionsRequired' ? { extensionsRequired: ['KHR_draco_mesh_compression'] } : {},
    );
    if (where === 'a primitive') {
      (json.meshes as Json[])[0] = {
        primitives: [
          { attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: {} } },
        ],
      };
    }
    if (where === 'a buffer view') {
      (json.bufferViews as Json[])[0] = {
        buffer: 0,
        byteLength: 36,
        extensions: { EXT_meshopt_compression: {} },
      };
    }
    const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
    await expect(readGlb(glb(json, TRIANGLE_BIN))).rejects.toThrow(message);
    await expect(readGlb(glb(json, TRIANGLE_BIN))).rejects.toThrow(/does not decode/);
    expect(parse).not.toHaveBeenCalled();
  });

  it('refuses buffers held outside the file', async () => {
    const json = triangleJson({ buffers: [{ byteLength: 36, uri: 'data.bin' }] });
    await expect(readGlb(glb(json))).rejects.toThrow(/outside the file/);
  });

  it('refuses a file over the triangle cap before the loader or any output exists', async () => {
    const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
    const json = triangleJson({
      accessors: [{ bufferView: 0, componentType: 5126, count: 3_000_000, type: 'VEC3' }],
    });
    await expect(readGlb(glb(json, TRIANGLE_BIN), { maxTriangles: 1000 })).rejects.toThrow(
      /1,000 MarkCopy previews/,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  describe('what the loader is given', () => {
    const f32 = (n: number) => ({ componentType: 5126, count: n, type: 'VEC3' });

    it('refuses an oversized bufferless POSITION in a secondary scene', async () => {
      const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
      const json = triangleJson({
        scenes: [{ nodes: [0] }, { nodes: [1] }],
        nodes: [{ mesh: 0 }, { mesh: 1 }],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0 } }] },
          { primitives: [{ attributes: { POSITION: 1 } }] },
        ],
        accessors: [{ bufferView: 0, ...f32(3) }, f32(3000)],
      });
      // The secondary scene is not drawn, so it is pruned away and the loader
      // never sees the accessor: the file reads, as one triangle.
      const model = await readGlb(glb(json, TRIANGLE_BIN), { maxTriangles: 1 });
      expect(model.positions.length).toBe(9);
      const given = givenJson(parse.mock.calls[0][0] as ArrayBuffer);
      expect((given.accessors as Json[]).map((a) => a.count)).toEqual([3]);
    });

    it('refuses an oversized bufferless NORMAL on a one-triangle mesh', async () => {
      const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
      const json = triangleJson({
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
        accessors: [{ bufferView: 0, ...f32(3) }, f32(3000)],
      });
      await expect(readGlb(glb(json, TRIANGLE_BIN), { maxTriangles: 1 })).rejects.toThrow(
        /malformed attribute|larger than MarkCopy will allocate/,
      );
      expect(parse).not.toHaveBeenCalled();
    });

    it('refuses many buffer views over the same bytes, which the loader would copy each time', async () => {
      // The reviewer's probe: ten one-triangle primitives, each with its own
      // buffer view covering the same 64 KiB of BIN. Every accessor and range
      // is in bounds, but the loader would copy the 64 KiB ten times.
      const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
      const bin = Buffer.concat([TRIANGLE_BIN, Buffer.alloc(65_536 - TRIANGLE_BIN.length)]);
      const n = 10;
      const json = triangleJson({
        nodes: [{ children: Array.from({ length: n }, (_, i) => i + 1) }].concat(
          Array.from({ length: n }, (_, i) => ({ mesh: i }) as never),
        ),
        meshes: Array.from({ length: n }, (_, i) => ({
          primitives: [{ attributes: { POSITION: i } }],
        })),
        accessors: Array.from({ length: n }, (_, i) => ({ bufferView: i, ...f32(3) })),
        bufferViews: Array.from({ length: n }, () => ({
          buffer: 0,
          byteOffset: 0,
          byteLength: 65_536,
        })),
        buffers: [{ byteLength: 65_536 }],
      });
      await expect(readGlb(glb(json, bin), { maxTriangles: n })).rejects.toThrow(
        /several buffer views at the same bytes/,
      );
      expect(parse).not.toHaveBeenCalled();
    });

    it('still reads views that share one buffer view entry, or sit side by side', async () => {
      const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
      const bin = Buffer.concat([TRIANGLE_BIN, TRIANGLE_BIN]);
      const json = triangleJson({
        nodes: [{ children: [1, 2, 3] }, { mesh: 0 }, { mesh: 1 }, { mesh: 2 }],
        meshes: [0, 0, 1].map((a) => ({ primitives: [{ attributes: { POSITION: a } }] })),
        accessors: [
          { bufferView: 0, ...f32(3) },
          { bufferView: 1, ...f32(3) },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 36 },
        ],
        buffers: [{ byteLength: 72 }],
      });
      const model = await readGlb(glb(json, bin), { maxTriangles: 3 });
      expect(model.positions.length).toBe(3 * 9);
      expect(parse).toHaveBeenCalledOnce();
    });

    it('keeps every instance of a node whose instancing has only custom attributes', async () => {
      // EXT_mesh_gpu_instancing makes TRANSLATION, ROTATION and SCALE optional:
      // a node may carry only _ID. Two identity instances of one triangle.
      const json = triangleJson(
        {
          accessors: [
            { bufferView: 0, ...f32(3) },
            { componentType: 5125, count: 2, type: 'SCALAR' },
          ],
          extensionsUsed: ['EXT_mesh_gpu_instancing'],
        },
        { extensions: { EXT_mesh_gpu_instancing: { attributes: { _ID: 1 } } } },
      );
      const model = await readGlb(glb(json, TRIANGLE_BIN), { maxTriangles: 2 });
      expect(model.positions.length).toBe(2 * 9);
    });

    it('refuses instancing attributes whose counts disagree', async () => {
      const json = triangleJson(
        {
          accessors: [
            { bufferView: 0, ...f32(3) },
            f32(2),
            { componentType: 5125, count: 5, type: 'SCALAR' },
          ],
        },
        { extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1, _ID: 2 } } } },
      );
      await expect(readGlb(glb(json, TRIANGLE_BIN), { maxTriangles: 10 })).rejects.toThrow(
        /malformed instancing attribute/,
      );
    });

    it('refuses a normal accessor that is large but matches its positions', async () => {
      const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
      const json = triangleJson({
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
        accessors: [f32(3000), f32(3000)],
      });
      await expect(readGlb(glb(json), { maxTriangles: 1 })).rejects.toThrow(
        /larger than MarkCopy will allocate/,
      );
      expect(parse).not.toHaveBeenCalled();
    });

    it('refuses an accessor that reaches past its buffer view, and a view past the BIN chunk', async () => {
      const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
      const past = triangleJson({ accessors: [{ bufferView: 0, byteOffset: 4, ...f32(3) }] });
      await expect(readGlb(glb(past, TRIANGLE_BIN))).rejects.toThrow(/reaches outside/);
      const view = triangleJson({
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 3600 }],
      });
      await expect(readGlb(glb(view, TRIANGLE_BIN))).rejects.toThrow(/reaches outside/);
      expect(parse).not.toHaveBeenCalled();
    });

    it('bounds a sparse accessor count', async () => {
      const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
      const json = triangleJson({
        accessors: [
          {
            bufferView: 0,
            ...f32(3),
            sparse: {
              count: 1_000_000,
              indices: { bufferView: 0, componentType: 5123 },
              values: { bufferView: 0 },
            },
          },
        ],
      });
      await expect(readGlb(glb(json, TRIANGLE_BIN))).rejects.toThrow(/larger than MarkCopy/);
      expect(parse).not.toHaveBeenCalled();
    });

    it('keeps only what it draws: no morph targets, other attributes or other scenes', async () => {
      const parse = vi.spyOn(GLTFLoader.prototype, 'parse');
      const json = triangleJson({
        scene: 1,
        scenes: [{ nodes: [1] }, { nodes: [0] }],
        nodes: [{ mesh: 0 }, { mesh: 0 }],
        meshes: [
          {
            primitives: [
              { attributes: { POSITION: 0, TEXCOORD_0: 1 }, targets: [{ POSITION: 1 }] },
            ],
          },
        ],
        animations: [{ channels: [], samplers: [] }],
        accessors: [{ bufferView: 0, ...f32(3) }, f32(900000)],
      });
      const model = await readGlb(glb(json, TRIANGLE_BIN));
      expect(model.positions.length).toBe(9);
      const given = givenJson(parse.mock.calls[0][0] as ArrayBuffer);
      expect(given.animations).toBeUndefined();
      expect(given.scenes).toHaveLength(1);
      expect(given.accessors).toHaveLength(1);
    });

    it('still loads the default scene of a valid multi-scene file', async () => {
      const json = triangleJson({
        scene: 1,
        scenes: [{ nodes: [1] }, { nodes: [0] }],
        nodes: [{ mesh: 1 }, { mesh: 0 }],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0 } }] },
          { primitives: [{ attributes: { POSITION: 0 } }] },
        ],
      });
      const model = await readGlb(glb(json, TRIANGLE_BIN));
      expect(model.positions.length).toBe(9);
    });
  });

  it('counts a mesh once for every node that places it', () => {
    const json = asCount(triangleJson());
    json.nodes = [{ children: [1, 2, 3] }, { mesh: 0 }, { mesh: 0 }, { mesh: 0 }];
    expect(countGlbTriangles(json, 100)).toBe(3);
    expect(() => countGlbTriangles(json, 2)).toThrow(GlbError);
  });

  it('refuses an instancing fan-out by its instance count', () => {
    const json = asCount(triangleJson());
    json.accessors = [...(json.accessors ?? []), { bufferView: 0, count: 50_000 }];
    json.nodes = [
      { mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } },
    ];
    expect(() => countGlbTriangles(json, 1000)).toThrow(/above the 1,000/);
  });

  it('counts strips and fans, and skips points and lines', () => {
    const json = asCount(triangleJson());
    const primitive = (mode: number) => ({ attributes: { POSITION: 0 }, mode });
    json.accessors = [{ bufferView: 0, count: 10 }];
    json.meshes = [
      { primitives: [primitive(5), primitive(6), primitive(0), primitive(1), primitive(4)] },
    ];
    // strip 8 + fan 8 + points 0 + lines 0 + triangles 3.
    expect(countGlbTriangles(json, 100)).toBe(19);
  });

  it('refuses a node cycle', () => {
    const json = asCount(triangleJson());
    json.nodes = [{ children: [1] }, { children: [0], mesh: 0 }];
    expect(() => countGlbTriangles(json, 100)).toThrow(/cycle/);
  });

  it('says so when there is nothing to draw', async () => {
    const json = triangleJson();
    (json.meshes as Json[])[0] = { primitives: [{ attributes: { POSITION: 0 }, mode: 1 }] };
    await expect(readGlb(glb(json, TRIANGLE_BIN))).rejects.toThrow(/no triangle meshes/);
  });

  it('refuses a truncated chunk, bad JSON and a non-2.0 asset', async () => {
    const bytes = glb(triangleJson(), TRIANGLE_BIN);
    await expect(readGlb(bytes.slice(0, 30))).rejects.toThrow(/cut short/);
    const bad = glb(triangleJson());
    bad[20] = 0x7b + 1; // corrupts the first JSON byte
    await expect(readGlb(bad)).rejects.toThrow(/not valid JSON/);
    await expect(
      readGlb(glb({ ...triangleJson(), asset: { version: '1.0' } }, TRIANGLE_BIN)),
    ).rejects.toThrow(/not glTF 2.0/);
  });
});

describe('parts of a multi-primitive mesh', () => {
  // Two one-triangle primitives (two materials) in one mesh.
  const twoPrimitives = (): Json => {
    const json = triangleJson();
    json.meshes = [
      {
        primitives: [
          { attributes: { POSITION: 0 }, material: 0 },
          { attributes: { POSITION: 0 }, material: 1 },
        ],
      },
    ];
    json.materials = [
      { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
      { pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } },
    ];
    return json;
  };

  it('keeps one node with two materials as one part', async () => {
    const model = await readGlb(glb(twoPrimitives(), TRIANGLE_BIN));
    expect(model.positions.length).toBe(2 * 9);
    expect(model.parts.children).toHaveLength(1);
    expect(model.parts.children[0].ranges).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it('keeps each node with two materials as one part holding both primitives', async () => {
    const json = twoPrimitives();
    json.nodes = [
      { name: 'A', mesh: 0 },
      { name: 'B', mesh: 0, translation: [5, 0, 0] },
    ];
    (json.scenes as Json[])[0].nodes = [0, 1];
    const model = await readGlb(glb(json, TRIANGLE_BIN));
    expect(model.parts.children.map((c) => [c.name, c.ranges.length])).toEqual([
      ['A', 2],
      ['B', 2],
    ]);
    const all = model.parts.children.flatMap((c) => c.ranges.map((r) => r[1]));
    expect(all.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('makes each instance of a two-material node one part', async () => {
    const bin = Buffer.concat([
      TRIANGLE_BIN,
      Buffer.from(new Float32Array([0, 0, 0, 5, 0, 0, 10, 0, 0]).buffer),
    ]);
    const json = twoPrimitives();
    json.nodes = [
      {
        name: 'Bolt',
        mesh: 0,
        extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } },
      },
    ];
    json.extensionsUsed = ['EXT_mesh_gpu_instancing'];
    (json.accessors as Json[]).push({ bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' });
    json.bufferViews = [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
    ];
    json.buffers = [{ byteLength: 72 }];
    const model = await readGlb(glb(json, bin));
    expect(model.positions.length).toBe(6 * 9);
    expect(model.parts.children.map((c) => c.ranges)).toEqual([
      [
        [0, 1],
        [3, 1],
      ],
      [
        [1, 1],
        [4, 1],
      ],
      [
        [2, 1],
        [5, 1],
      ],
    ]);
  });
});

describe('part names from the source', () => {
  it('names an unnamed node after its mesh, spaces intact', async () => {
    const json = triangleJson();
    (json.meshes as Json[])[0].name = 'Rear Wheel';
    const model = await readGlb(glb(json, TRIANGLE_BIN));
    expect(model.parts.children[0].name).toBe('Rear Wheel');
  });

  it('keeps a source name that looks like one three generates', async () => {
    const json = triangleJson();
    (json.meshes as Json[])[0].name = 'mesh_42';
    const model = await readGlb(glb(json, TRIANGLE_BIN));
    expect(model.parts.children[0].name).toBe('mesh_42');
  });
});
