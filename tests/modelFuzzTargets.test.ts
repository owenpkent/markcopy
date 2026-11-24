// Regression tests for the glb, obj, step and audio-probe fuzz targets and the
// model checks they share (fuzz/targets/modelOracle.ts): each target accepts
// real inputs and junk, builds the structure it claims to, and its checks fail
// the outputs they exist to catch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asGlb, fuzz as fuzzGlb, glbOf } from '../fuzz/targets/glb.fuzz';
import { checkMtlName, fuzz as fuzzObj } from '../fuzz/targets/obj.fuzz';
import { engineResult, fuzz as fuzzStep } from '../fuzz/targets/step.fuzz';
import { checkDetails, fuzz as fuzzAudio } from '../fuzz/targets/audio-probe.fuzz';
import { checkModel } from '../fuzz/targets/modelOracle';
import { readGlb } from '../src/webview/glb';

const root = join(__dirname, '..');
const leaf = (ranges: Array<[number, number]>) => ({ name: 'p', children: [], ranges });

describe('checkModel', () => {
  const tri = new Float32Array(9);

  it('passes a consistent model', () => {
    checkModel('m', { positions: tri, colors: tri, normals: null, parts: leaf([[0, 1]]) }, 10);
  });

  it('fails arrays that disagree, a model over the cap, and a part outside the model', () => {
    const bad = [
      { positions: new Float32Array(8), colors: null, normals: null, parts: leaf([]) },
      { positions: tri, colors: new Float32Array(3), normals: null, parts: leaf([]) },
      { positions: tri, colors: null, normals: new Float32Array(18), parts: leaf([]) },
      { positions: tri, colors: null, normals: null, parts: leaf([[0, 2]]) },
      { positions: tri, colors: null, normals: null, parts: leaf([[-1, 1]]) },
      { positions: tri, colors: null, normals: null, parts: leaf([[0.5, 0]]) },
    ];
    for (const model of bad) {
      expect(() => checkModel('m', model, 10)).toThrow();
    }
    expect(() =>
      checkModel(
        'm',
        { positions: new Float32Array(27), colors: null, normals: null, parts: leaf([]) },
        2,
      ),
    ).toThrow(/cap/);
  });
});

describe('glb fuzz target', () => {
  it('wraps JSON and a binary chunk into a GLB the reader accepts', async () => {
    const sample = readFileSync(join(root, 'sample.glb'));
    const seed = readFileSync(join(root, 'fuzz/corpus/glb/sample-colored-cube.seed'));
    const rebuilt = asGlb(seed);
    const [a, b] = await Promise.all([readGlb(sample), readGlb(rebuilt)]);
    expect(b.positions).toEqual(a.positions);
  });

  it('pads chunks to four bytes and states the total length', () => {
    const glb = glbOf(Buffer.from('{"a":1}'), Buffer.of(1, 2, 3));
    expect(glb.length % 4).toBe(0);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    expect(glb.readUInt32LE(12)).toBe(8);
  });

  it('accepts the seeds, junk, and an empty input', async () => {
    await fuzzGlb(readFileSync(join(root, 'fuzz/corpus/glb/sample-colored-cube.seed')));
    await fuzzGlb(Buffer.alloc(0));
    await fuzzGlb(
      Buffer.from(
        '{"asset":{"version":"2.0"},"meshes":[{"primitives":[{"attributes":{"POSITION":9}}]}]}\0',
      ),
    );
    await fuzzGlb(Buffer.alloc(500, 0xff));
  });
});

describe('obj fuzz target', () => {
  it('allows bare .mtl names and refuses everything that could point elsewhere', () => {
    checkMtlName('model.mtl');
    checkMtlName('my model.MTL');
    for (const name of [
      '../x.mtl',
      'a/b.mtl',
      'a\\b.mtl',
      'C:x.mtl',
      '.x.mtl',
      'a..b.mtl',
      'x\u0000.mtl',
      'x.obj',
      '',
    ]) {
      // checkMtlName only throws when mtlNameProblem wrongly allows a name.
      expect(() => checkMtlName(name)).not.toThrow();
    }
  });

  it('accepts the seeds, junk, and an empty input', () => {
    for (const seed of ['sample-with-mtl.seed', 'groups-normals-negative-index.obj']) {
      fuzzObj(readFileSync(join(root, 'fuzz/corpus/obj', seed)));
    }
    fuzzObj(Buffer.alloc(0));
    fuzzObj(
      Buffer.from(
        'mtllib ../../etc/passwd\nmtllib a.mtl\nv 0 0 0\nf 1 1 1\n\0newmtl a\nKd 1 0 0\n',
      ),
    );
    fuzzObj(Buffer.alloc(500, 0x0a));
  });
});

describe('step fuzz target', () => {
  it('builds the same engine result from the same input', () => {
    const seed = readFileSync(join(root, 'fuzz/corpus/step/pattern-dense.seed'));
    expect(JSON.stringify(engineResult(seed))).toBe(JSON.stringify(engineResult(seed)));
  });

  it('builds meshes and trees from the seeds, not only refusals', () => {
    let meshes = 0;
    for (const seed of ['pattern-dense.seed', 'pattern-sparse.seed', 'pattern-high.seed']) {
      meshes +=
        engineResult(readFileSync(join(root, 'fuzz/corpus/step', seed))).meshes?.length ?? 0;
    }
    expect(meshes).toBeGreaterThan(0);
  });

  it('accepts the seeds, junk, and an empty input', () => {
    for (const seed of ['pattern-dense.seed', 'pattern-sparse.seed', 'pattern-high.seed']) {
      fuzzStep(readFileSync(join(root, 'fuzz/corpus/step', seed)));
    }
    fuzzStep(Buffer.alloc(0));
    for (let fill = 0; fill < 256; fill += 17) {
      fuzzStep(Buffer.alloc(400, fill));
    }
  });
});

describe('audio-probe fuzz target', () => {
  it('accepts real ffprobe output and junk', () => {
    for (const ext of ['mp3', 'flac', 'ogg', 'm4a', 'wav', 'opus']) {
      fuzzAudio(readFileSync(join(root, `fuzz/corpus/audio-probe/ffprobe-${ext}.json`)));
    }
    fuzzAudio(
      Buffer.from(
        '{"format":{"tags":{"title":"\\u0007bell"}},"streams":[{"codec_type":"audio","codec_name":"constructor"}]}',
      ),
    );
    fuzzAudio(Buffer.from('not json'));
  });

  it('fails details the panel could not show as they are', () => {
    expect(() => checkDetails({ codec: 'x'.repeat(81) })).toThrow();
    expect(() => checkDetails({ sampleRate: Number.NaN })).toThrow();
    expect(() => checkDetails({ tags: { title: 'a\u0007b' } })).toThrow();
    expect(() => checkDetails({ ['extra' as 'codec']: 'x' })).toThrow();
    checkDetails({ codec: 'FLAC', sampleRate: 44100, tags: { comment: 'one\ntwo' } });
  });
});
