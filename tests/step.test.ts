// @vitest-environment node
// Coverage for src/webview/step.ts. The real Open CASCADE engine runs here, in
// Node, from the raw wasm in node_modules (the webview gets the gzipped copy).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import occtimportjs from 'occt-import-js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
// The same patch esbuild.web.js applies when bundling the glue.
const { patchOcctGlue } = createRequire(__filename)('../scripts/occt-no-eval') as {
  patchOcctGlue: (source: string) => string;
};
import { stepHeaderProblem } from '../src/webview/modelSniff';
import {
  StepError,
  loadStepEngine,
  readStep,
  resetStepEngine,
  type OcctEngine,
  type OcctMesh,
} from '../src/webview/step';

const DIST = join(__dirname, '..', 'node_modules', 'occt-import-js', 'dist');
const WASM = join(DIST, 'occt-import-js.wasm');
const GLUE = join(DIST, 'occt-import-js.js');
const sample = () => new Uint8Array(readFileSync(join(__dirname, '..', 'sample.step')));

type Factory = (options: { wasmBinary: Uint8Array }) => Promise<unknown>;

// Run glue source where code from strings is refused, as the 3D viewer's CSP
// does ('wasm-unsafe-eval' but no 'unsafe-eval'), and return its factory.
function glueWithoutEval(source: string): Factory {
  const mod: { exports: unknown } = { exports: {} };
  const context = vm.createContext(
    {
      module: mod,
      exports: mod.exports,
      WebAssembly,
      TextDecoder,
      console,
      setTimeout,
      clearTimeout,
    },
    { codeGeneration: { strings: false, wasm: true } },
  );
  vm.runInContext(source, context);
  const exported = mod.exports as Factory | { default: Factory };
  return typeof exported === 'function' ? exported : exported.default;
}

// The real-engine cases run the glue as it is bundled: patched, without eval.
let engine: OcctEngine;
beforeAll(async () => {
  const wasmBinary = readFileSync(WASM);
  const factory = glueWithoutEval(patchOcctGlue(readFileSync(GLUE, 'utf8')));
  engine = (await factory({ wasmBinary })) as OcctEngine;
}, 60_000);

describe('the engine glue under the viewer CSP', () => {
  it('fails unpatched, because embind builds bindings with new Function', async () => {
    const wasmBinary = readFileSync(WASM);
    const run = async () => glueWithoutEval(readFileSync(GLUE, 'utf8'))({ wasmBinary });
    await expect(run()).rejects.toThrow(/Code generation from strings/);
  }, 60_000);

  it('patches both string-compiled invokers and nothing else builds code', () => {
    const patched = patchOcctGlue(readFileSync(GLUE, 'utf8'));
    expect(patched).not.toMatch(/newFunc\(Function\b|new Function\b|\beval\(/);
    expect(patched).toContain('var invokerFn=function(...args){');
    expect(patched).toContain('var invokerFunction=function(obj,func,destructorsRef,args){');
  });

  it('refuses glue it does not recognise, so an upgrade cannot ship unpatched', () => {
    expect(() => patchOcctGlue('var x=1;')).toThrow(/expected one embind craftInvokerFunction/);
  });

  it('matches the unpatched engine on the sample', async () => {
    const plain = (await occtimportjs({ wasmBinary: readFileSync(WASM) })) as OcctEngine;
    const a = readStep(plain, sample());
    const b = readStep(engine, sample());
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    expect(Array.from(b.colors)).toEqual(Array.from(a.colors));
  }, 60_000);
});

// A stand-in engine returning `meshes`, for the cases the real one cannot make.
function fake(result: { success: boolean; meshes?: OcctMesh[] }): OcctEngine {
  return { ReadStepFile: () => result };
}
const STEP = new TextEncoder().encode('ISO-10303-21;\nHEADER;');
const quad = (extra: Partial<OcctMesh> = {}): OcctMesh => ({
  attributes: { position: { array: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] } },
  index: { array: [0, 1, 2, 0, 2, 3] },
  ...extra,
});

describe('stepHeaderProblem', () => {
  it('accepts the STEP magic, with a BOM or leading blanks', () => {
    expect(stepHeaderProblem(STEP)).toBeNull();
    expect(stepHeaderProblem(new Uint8Array([0xef, 0xbb, 0xbf, ...STEP]))).toBeNull();
    expect(stepHeaderProblem(new TextEncoder().encode('\r\n  ISO-10303-21;'))).toBeNull();
  });

  it('rejects anything else', () => {
    expect(stepHeaderProblem(new TextEncoder().encode('solid cube'))).toMatch(
      /does not start with ISO-10303-21/,
    );
    expect(stepHeaderProblem(new Uint8Array(0))).not.toBeNull();
  });
});

describe('readStep', () => {
  it('reads the sample box: 12 triangles, 20 x 10 x 5 mm, with its own color', () => {
    const model = readStep(engine, sample());
    expect(model.positions.length).toBe(12 * 9);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    model.positions.forEach((v, i) => {
      lo[i % 3] = Math.min(lo[i % 3], v);
      hi[i % 3] = Math.max(hi[i % 3], v);
    });
    expect(lo).toEqual([0, 0, 0]);
    expect(hi).toEqual([20, 10, 5]);
    expect(model.colored).toBe(true);
    expect(model.colors[0]).toBeGreaterThan(model.colors[2]);
    expect(model.normals).not.toBeNull();
  });

  it('says when the engine cannot read the file', () => {
    const garbage = new TextEncoder().encode('ISO-10303-21;\nDATA;\n#1=NOT_A_THING(;\nENDSEC;');
    expect(() => readStep(engine, garbage)).toThrow(StepError);
    expect(() => readStep(engine, garbage)).toThrow(/could not read this file/);
  });

  it('refuses a file that is not STEP without calling the engine', () => {
    const spy = vi.fn();
    expect(() => readStep({ ReadStepFile: spy }, new TextEncoder().encode('solid x'))).toThrow(
      /not a STEP file/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports an engine that throws', () => {
    const throwing: OcctEngine = {
      ReadStepFile: () => {
        throw new Error('boom');
      },
    };
    expect(() => readStep(throwing, STEP)).toThrow(/boom/);
  });

  it('says so when a valid file holds no solid', () => {
    expect(() => readStep(fake({ success: true, meshes: [] }), STEP)).toThrow(
      /holds no solid geometry/,
    );
    expect(() => readStep(fake({ success: true }), STEP)).toThrow(/holds no solid geometry/);
  });

  it('refuses over the triangle cap before the merged arrays are allocated', () => {
    const alloc = vi.spyOn(globalThis, 'Float32Array');
    const model = fake({ success: true, meshes: [quad(), quad(), quad()] });
    alloc.mockClear();
    expect(() => readStep(model, STEP, { maxTriangles: 5 })).toThrow(/above the 5 MarkCopy/);
    expect(alloc).not.toHaveBeenCalled();
    alloc.mockRestore();
  });

  it('colors a face by its range, else the solid, else the fallback', () => {
    const colored = quad({
      color: [0, 1, 0],
      brep_faces: [{ first: 0, last: 0, color: [1, 0, 0] }],
    });
    const model = readStep(fake({ success: true, meshes: [colored, quad()] }), STEP, {
      fallbackColor: [0, 0, 1],
    });
    const rgb = (triangle: number) =>
      Array.from(model.colors.slice(triangle * 9, triangle * 9 + 3));
    expect(rgb(0)).toEqual([1, 0, 0]);
    expect(rgb(1)).toEqual([0, 1, 0]);
    expect(rgb(2)).toEqual([0, 0, 1]);
    expect(model.colored).toBe(true);
  });

  it('is uncolored when nothing in the file is', () => {
    const model = readStep(fake({ success: true, meshes: [quad()] }), STEP);
    expect(model.colored).toBe(false);
  });

  it('refuses a triangle that points outside its vertices', () => {
    const bad = quad({ index: { array: [0, 1, 99] } });
    expect(() => readStep(fake({ success: true, meshes: [bad] }), STEP)).toThrow(
      /outside its mesh/,
    );
  });

  it('drops the normals when any mesh lacks them', () => {
    const withNormals = quad({
      attributes: {
        position: { array: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] },
        normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1] },
      },
    });
    expect(readStep(fake({ success: true, meshes: [withNormals] }), STEP).normals).not.toBeNull();
    expect(
      readStep(fake({ success: true, meshes: [withNormals, quad()] }), STEP).normals,
    ).toBeNull();
  });
});

describe('loadStepEngine', () => {
  it('starts the engine once, from the inflated bytes, and caches it', async () => {
    resetStepEngine();
    const bytes = readFileSync(WASM);
    const fetchWasm = vi.fn(async () => new Uint8Array(bytes).buffer);
    const factory = vi.fn(async (options: { wasmBinary: ArrayBuffer }) => {
      expect(options.wasmBinary.byteLength).toBe(bytes.byteLength);
      return engine;
    });
    const first = await loadStepEngine('webview:engine.gz', { fetchWasm, factory });
    const second = await loadStepEngine('webview:engine.gz', { fetchWasm, factory });
    expect(first).toBe(engine);
    expect(second).toBe(first);
    expect(fetchWasm).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so reopening a file tries again', async () => {
    resetStepEngine();
    const fetchWasm = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new ArrayBuffer(8));
    const factory = vi.fn(async () => engine);
    await expect(loadStepEngine('u', { fetchWasm, factory })).rejects.toThrow(
      /Could not load the STEP engine/,
    );
    await expect(loadStepEngine('u', { fetchWasm, factory })).resolves.toBe(engine);
    resetStepEngine();
  });

  it('reports an engine that will not start', async () => {
    resetStepEngine();
    const factory = vi.fn(async () => {
      throw new Error('bad wasm');
    });
    await expect(
      loadStepEngine('u', { fetchWasm: async () => new ArrayBuffer(8), factory }),
    ).rejects.toThrow(/Could not start the STEP engine/);
    resetStepEngine();
  });

  it('inflates the gzipped engine the build ships', async () => {
    resetStepEngine();
    const raw = new Uint8Array(readFileSync(WASM));
    const gz = gzipSync(raw, { level: 9 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob([gz]), { status: 200 })),
    );
    let seen = 0;
    const factory = async (options: { wasmBinary: ArrayBuffer }) => {
      seen = options.wasmBinary.byteLength;
      return engine;
    };
    await loadStepEngine('webview:engine.gz', { factory });
    expect(seen).toBe(raw.byteLength);
    vi.unstubAllGlobals();
    resetStepEngine();
  }, 30_000);
});
