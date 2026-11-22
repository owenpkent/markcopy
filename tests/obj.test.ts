// Coverage for src/webview/obj.ts and the OBJ checks in modelSniff.ts: what is
// refused before three's OBJLoader runs, the .mtl reader and the name rules, the
// colors, the parts and the normals the one triangle soup an OBJ turns into has.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_MTL_FILES,
  OBJ_BINARY_MESSAGE,
  mtlNameProblem,
  objIsBinary,
  objMtlNames,
} from '../src/webview/modelSniff';
import { ObjError, parseMtl, readObj, scanObj } from '../src/webview/obj';

afterEach(() => vi.restoreAllMocks());

const bytes = (text: string) => new TextEncoder().encode(text);
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

// Four vertices and a quad, a triangle beside it; nothing else.
const QUAD_AND_TRIANGLE = [
  'v 0 0 0',
  'v 1 0 0',
  'v 1 1 0',
  'v 0 1 0',
  'v 2 0 0',
  'f 1 2 3 4',
  'f 2 5 3',
  '',
].join('\n');

const MTL = (name: string, kd: string, extra = '') => `newmtl ${name}\nKd ${kd}\n${extra}`;

describe('the binary sniff', () => {
  it('finds a NUL byte in the first 64 KiB', () => {
    expect(objIsBinary(Uint8Array.from([...ascii('v 0 0 0\n'), 0, ...ascii('f 1 1 1')]))).toBe(
      true,
    );
    expect(objIsBinary(bytes(QUAD_AND_TRIANGLE))).toBe(false);
    // Past 64 KiB is not looked at: a NUL there is the loader's business.
    const late = new Uint8Array(70 * 1024).fill(0x20);
    late[late.length - 1] = 0;
    expect(objIsBinary(late)).toBe(false);
  });

  it('knows the COFF, ELF and Mach-O headers even with no NUL in sight', () => {
    // x64 COFF: machine 0x8664, little endian.
    expect(objIsBinary(Uint8Array.from([0x64, 0x86, 0x41, 0x42, 0x43]))).toBe(true);
    // i386 COFF, then ARM64.
    expect(objIsBinary(Uint8Array.from([0x4c, 0x01, 0x41, 0x42]))).toBe(true);
    expect(objIsBinary(Uint8Array.from([0x64, 0xaa, 0x41, 0x42]))).toBe(true);
    // ELF and Mach-O.
    expect(objIsBinary(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]))).toBe(true);
    expect(objIsBinary(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 7]))).toBe(true);
    expect(objIsBinary(bytes('# a comment\nv 1 2 3\n'))).toBe(false);
  });

  it('is refused by readObj with the compiled object file message', () => {
    expect(() => readObj(Uint8Array.from([0x64, 0x86, 1, 0, 2]))).toThrow(OBJ_BINARY_MESSAGE);
    expect(OBJ_BINARY_MESSAGE).toBe('This .obj is a compiled object file, not a 3D model.');
  });
});

describe('scanObj, before the loader', () => {
  it('counts an n-gon as n-2 triangles', () => {
    const scan = scanObj(QUAD_AND_TRIANGLE);
    expect(scan.triangles).toBe(3); // 2 for the quad, 1 for the triangle
    expect(scan.vertices).toBe(5);
    const hex = ['v 0 0 0', 'v 1 0 0', 'v 2 1 0', 'v 2 2 0', 'v 1 3 0', 'v 0 2 0', 'f 1 2 3 4 5 6'];
    expect(scanObj(hex.join('\n')).triangles).toBe(4);
    // A line and a point are not triangles, and a two-corner face is none either.
    expect(scanObj('v 0 0 0\nv 1 0 0\nl 1 2\nf 1 2\n').triangles).toBe(0);
  });

  it('refuses past the triangle cap, the vertex cap, a long line, and too many objects, without running the loader', () => {
    const parse = vi.spyOn(OBJLoader.prototype, 'parse');
    const cube = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n';
    // Three triangles against a cap of two: caught on the face that crosses it.
    expect(() =>
      readObj(bytes(`${cube}f 1 2 3\nf 1 2 3\nf 1 2 3\n`), { limits: { maxTriangles: 2 } }),
    ).toThrow(/more than 2 triangles/);
    // One n-gon of five corners is three triangles.
    expect(() =>
      readObj(bytes(`${cube}v 1 1 1\nv 2 2 2\nf 1 2 3 4 5\n`), { limits: { maxTriangles: 2 } }),
    ).toThrow(/more than 2 triangles/);
    expect(() => readObj(bytes(`${cube}v 1 1 1\n`), { limits: { maxVertices: 3 } })).toThrow(
      /more than 3 vertices/,
    );
    expect(() =>
      readObj(bytes(`# ${'x'.repeat(2000)}\n${cube}`), { limits: { maxLine: 1000 } }),
    ).toThrow(/Line 1 .* long/);
    expect(() => readObj(bytes(`${cube}o a\no b\no c\n`), { limits: { maxObjects: 2 } })).toThrow(
      /more than 2 objects/,
    );
    expect(() =>
      readObj(bytes(`${cube}usemtl a\nusemtl b\nusemtl c\n`), { limits: { maxMaterialUses: 2 } }),
    ).toThrow(/switches material more than 2 times/);
    expect(parse).not.toHaveBeenCalled();
  });

  it('refuses a face that names a vertex that does not exist, which the loader would turn into NaN', () => {
    const parse = vi.spyOn(OBJLoader.prototype, 'parse');
    for (const face of ['f 1 2 9', 'f 1 2 0', 'f 1 2 -9', 'f 1 2 x', 'f 1 2 3 4']) {
      expect(() => readObj(bytes(`v 0 0 0\nv 1 0 0\nv 0 1 0\n${face}\n`))).toThrow(
        /vertex that has not been declared/,
      );
    }
    // A forward reference is the same: only what is declared so far counts.
    expect(() => readObj(bytes('f 1 2 3\nv 0 0 0\nv 1 0 0\nv 0 1 0\n'))).toThrow(ObjError);
    expect(parse).not.toHaveBeenCalled();
    // Negative indices count back from the last vertex.
    expect(scanObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n').triangles).toBe(1);
  });

  it('runs the loader once the file passes, and refuses a file with no faces without it', () => {
    const parse = vi.spyOn(OBJLoader.prototype, 'parse');
    expect(() => readObj(bytes('v 0 0 0\nv 1 1 1\n'))).toThrow(/no faces/);
    expect(parse).not.toHaveBeenCalled();
    readObj(bytes(QUAD_AND_TRIANGLE));
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('refuses coordinates that are not numbers', () => {
    expect(() => readObj(bytes('v 0 0 0\nv 1 0 0\nv a b c\nf 1 2 3\n'))).toThrow(/not numbers/);
  });

  it('reads the same file when lines are joined by a backslash or end in CRLF', () => {
    const text = 'v 0 0 0\r\nv 1 0 0\r\nv 1 1 0\r\nv 0 1 0\r\nf 1 2 \\\r\n3 4\r\n';
    expect(scanObj(text).triangles).toBe(2);
    expect(readObj(bytes(text)).positions.length).toBe(2 * 9);
  });
});

describe('the .mtl name rules', () => {
  it('takes a bare .mtl file name', () => {
    for (const name of ['sample.mtl', 'My Model.MTL', 'a.b.mtl', 'ünï.mtl']) {
      expect(mtlNameProblem(name)).toBeNull();
    }
  });

  it('refuses a path, a traversal, a drive, a URI and anything else that points elsewhere', () => {
    for (const name of [
      '',
      '../secret.mtl',
      '..\\secret.mtl',
      'sub/a.mtl',
      'sub\\a.mtl',
      '/etc/passwd.mtl',
      'C:\\Windows\\a.mtl',
      'C:a.mtl',
      'file:///etc/a.mtl',
      'https://example.com/a.mtl',
      '\\\\server\\share\\a.mtl',
      '..',
      '.hidden.mtl',
      'a..b.mtl',
      'a.mtl:stream',
      'a\u0000.mtl',
      'a\n.mtl',
      'notes.txt',
      'x'.repeat(300) + '.mtl',
    ]) {
      expect(mtlNameProblem(name), JSON.stringify(name)).not.toBeNull();
    }
  });

  it('lists the mtllib names, whole lines, without repeats, capped, from bytes', () => {
    const text = [
      '# mtllib commented.mtl',
      'mtllib my model.mtl',
      '  mtllib\tindented.mtl',
      'mtllib my model.mtl',
      'mtllibx not.mtl',
      'v 0 0 0',
      ...Array.from({ length: 20 }, (_, i) => `mtllib m${i}.mtl`),
    ].join('\r\n');
    const names = objMtlNames(bytes(text));
    expect(names.slice(0, 3)).toEqual(['my model.mtl', 'indented.mtl', 'm0.mtl']);
    expect(names).not.toContain('not.mtl');
    // One more than is read, so the caller can say some were left out.
    expect(names).toHaveLength(MAX_MTL_FILES + 1);
  });
});

describe('parseMtl', () => {
  it('reads Kd and d per newmtl, and a lone number as a grey', () => {
    const m = parseMtl([
      {
        name: 'a.mtl',
        text: [
          MTL('red', '1 0 0', 'd 0.5\n'),
          MTL('grey', '0.25'),
          'newmtl glass\nKd 0 0.5 1\nTr 0.75\n',
          'newmtl clamp\nKd 2 -1 0.5\n',
          'newmtl spectral\nKd spectral foo.rfl\n',
        ].join('\n'),
      },
    ]);
    expect(m.get('red')).toEqual({ kd: [1, 0, 0], opacity: 0.5 });
    expect(m.get('grey')?.kd).toEqual([0.25, 0.25, 0.25]);
    expect(m.get('glass')).toEqual({ kd: [0, 0.5, 1], opacity: 0.25 });
    expect(m.get('clamp')?.kd).toEqual([1, 0, 0.5]);
    expect(m.get('spectral')?.kd).toBeNull();
  });

  it('ignores every texture line, so nothing in a .mtl names a file to load', () => {
    const m = parseMtl([
      {
        name: 'a.mtl',
        text: [
          'newmtl tex',
          'Kd 0.1 0.2 0.3',
          'map_Kd http://evil.example/x.png',
          'map_Kd 1 1 1',
          'map_Bump ../../secret.png',
          'bump file:///etc/passwd',
          'map_d C:\\x.png',
          '',
        ].join('\n'),
      },
    ]);
    expect([...m.keys()]).toEqual(['tex']);
    expect(m.get('tex')).toEqual({ kd: [0.1, 0.2, 0.3], opacity: 1 });
  });

  it('keeps a later definition, reads several files, and ignores a Kd before any newmtl', () => {
    const m = parseMtl([
      { name: 'a.mtl', text: 'Kd 1 1 1\nnewmtl x\nKd 1 0 0\n' },
      { name: 'b.mtl', text: 'newmtl x\nKd 0 1 0\nnewmtl y\nKd 0 0 1\n' },
    ]);
    expect(m.get('x')?.kd).toEqual([0, 1, 0]);
    expect(m.get('y')?.kd).toEqual([0, 0, 1]);
    expect(m.size).toBe(2);
  });

  it('ignores a line longer than it reads', () => {
    const m = parseMtl([{ name: 'a.mtl', text: `newmtl x\nKd 1 0 0 ${' '.repeat(5000)}\n` }]);
    expect(m.get('x')?.kd).toBeNull();
  });
});

// Two objects; "walls" uses two materials, "roof" one; quads and a triangle.
const HOUSE = [
  'mtllib house.mtl',
  'v 0 0 0',
  'v 1 0 0',
  'v 1 1 0',
  'v 0 1 0',
  'v 2 0 0',
  'v 2 1 0',
  'o walls',
  'usemtl plaster',
  'f 1 2 3 4',
  'usemtl slab',
  'f 2 5 6 3',
  'o roof',
  'usemtl tiles',
  'f 3 6 4',
  '',
].join('\n');
const HOUSE_MTL = [MTL('plaster', '1 0 0'), MTL('slab', '0 1 0'), MTL('tiles', '0 0 1')].join('\n');

// The sRGB 0..1 channel as the linear value the vertex colors hold.
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

describe('readObj colors', () => {
  const fallback: [number, number, number] = [0.2, 0.4, 0.6];

  it('colors each range from its material Kd, read as sRGB', () => {
    const { positions, colors } = readObj(bytes(HOUSE), {
      mtl: [{ name: 'house.mtl', text: HOUSE_MTL }],
      fallbackColor: fallback,
    });
    expect(positions.length / 9).toBe(5);
    const c = colors as Float32Array;
    // walls: triangles 0,1 plaster (red); 2,3 slab (green); roof triangle 4 blue.
    const at = (tri: number) => Array.from(c.slice(tri * 9, tri * 9 + 3));
    expect(at(0)).toEqual([1, 0, 0]);
    expect(at(1)).toEqual([1, 0, 0]);
    expect(at(2)).toEqual([0, 1, 0]);
    expect(at(3)).toEqual([0, 1, 0]);
    expect(at(4)).toEqual([0, 0, 1]);
    const half = readObj(bytes(HOUSE), {
      mtl: [{ name: 'house.mtl', text: MTL('plaster', '0.5 0.5 0.5') }],
    }).colors as Float32Array;
    expect(half[0]).toBeCloseTo(linear(0.5), 5);
  });

  it('uses the default color for a material the .mtl does not define, and for no .mtl at all', () => {
    const partial = readObj(bytes(HOUSE), {
      mtl: [{ name: 'house.mtl', text: MTL('plaster', '1 0 0') }],
      fallbackColor: fallback,
    }).colors as Float32Array;
    expect(Array.from(partial.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(partial.slice(2 * 9, 2 * 9 + 3)).map((x) => +x.toFixed(4))).toEqual(fallback);
    // Nothing colored at all: no color attribute, so the viewer draws markcopy.stl.meshColor.
    expect(readObj(bytes(HOUSE), { fallbackColor: fallback }).colors).toBeNull();
    expect(
      readObj(bytes(HOUSE), { mtl: [{ name: 'x.mtl', text: 'newmtl other\nKd 1 1 1\n' }] }).colors,
    ).toBeNull();
  });

  it('uses per-vertex colors (v x y z r g b) when every vertex has them, over the material', () => {
    const text = [
      'v 0 0 0 1 0 0',
      'v 1 0 0 0 1 0',
      'v 0 1 0 0 0 1',
      'usemtl plaster',
      'f 1 2 3',
      '',
    ].join('\n');
    const { colors } = readObj(bytes(text), {
      mtl: [{ name: 'a.mtl', text: MTL('plaster', '0.3 0.3 0.3') }],
    });
    expect(Array.from(colors as Float32Array)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('ignores colors that only some vertices have, rather than misaligning them', () => {
    const text = ['v 0 0 0 1 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3', ''].join('\n');
    expect(readObj(bytes(text)).colors).toBeNull();
  });

  it('never fetches anything: a texture reference in the .obj or .mtl is not followed', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const text = `${HOUSE}usemap http://evil.example/a.png\nmap_Kd x.png\n`;
    readObj(bytes(text), {
      mtl: [{ name: 'a.mtl', text: `${HOUSE_MTL}\nmap_Kd http://evil.example/x.png\n` }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('readObj parts', () => {
  const ranges = (text: string) =>
    readObj(bytes(text)).parts.children.map((p) => [p.name, p.ranges]);

  it('is one part per o object, and a multi-material object is ONE part', () => {
    expect(ranges(HOUSE)).toEqual([
      ['walls', [[0, 4]]],
      ['roof', [[4, 1]]],
    ]);
  });

  it('is one part per g group when there is no o line', () => {
    const text = HOUSE.replace('o walls', 'g walls').replace('o roof', 'g roof');
    expect(ranges(text)).toEqual([
      ['walls', [[0, 4]]],
      ['roof', [[4, 1]]],
    ]);
  });

  it('puts the g groups of an o object into it', () => {
    const text = [
      'v 0 0 0',
      'v 1 0 0',
      'v 0 1 0',
      'o body',
      'g left',
      'f 1 2 3',
      'g right',
      'f 1 2 3',
      'o lid',
      'f 1 2 3',
      '',
    ].join('\n');
    expect(ranges(text)).toEqual([
      ['body', [[0, 2]]],
      ['lid', [[2, 1]]],
    ]);
  });

  it('is the whole file as one part when it has no o or g line', () => {
    const parts = readObj(bytes(QUAD_AND_TRIANGLE)).parts;
    expect(parts.children).toHaveLength(1);
    expect(parts.children[0].ranges).toEqual([[0, 3]]);
  });

  it('gives faces before the first o line to that object, as the loader does', () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3', 'o only', 'f 1 2 3', ''].join('\n');
    expect(ranges(text)).toEqual([['only', [[0, 2]]]]);
  });

  it('skips an object that is only lines or points', () => {
    const text = [
      'v 0 0 0',
      'v 1 0 0',
      'v 0 1 0',
      'o wire',
      'l 1 2',
      'o solid',
      'f 1 2 3',
      '',
    ].join('\n');
    expect(ranges(text)).toEqual([['solid', [[0, 1]]]]);
  });
});

describe('readObj normals', () => {
  const tri = (face: string, extra = '') =>
    ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vn 0 0 1', 'vn 0 0 -1', extra, face, ''].join('\n');

  it('keeps the file vn only when every face vertex has one', () => {
    const every = readObj(bytes(tri('f 1//1 2//2 3//1')));
    expect(Array.from(every.normals as Float32Array)).toEqual([0, 0, 1, 0, 0, -1, 0, 0, 1]);
    expect(readObj(bytes(tri('f 1//1 2//2 3'))).normals).toBeNull();
    expect(readObj(bytes(tri('f 1 2 3'))).normals).toBeNull();
    // A vn index that points nowhere is not a normal.
    expect(readObj(bytes(tri('f 1//1 2//2 3//9'))).normals).toBeNull();
    // v/vt/vn counts too.
    expect(readObj(bytes(tri('f 1/1/1 2/1/2 3/1/1', 'vt 0 0'))).normals).not.toBeNull();
  });

  it('reads the sample: normals kept, three materials, two parts', () => {
    const obj = new Uint8Array(readFileSync(join(__dirname, '..', 'sample.obj')));
    const mtl = readFileSync(join(__dirname, '..', 'sample.mtl'), 'utf8');
    const model = readObj(obj, { mtl: [{ name: 'sample.mtl', text: mtl }] });
    expect(model.positions.length / 9).toBe(18); // 6 quads + 4 triangles + 1 quad, as triangles
    expect(model.normals).not.toBeNull();
    expect(model.colors).not.toBeNull();
    expect(model.parts.children.map((p) => p.name)).toEqual(['walls', 'roof']);
    expect(model.parts.children[0].ranges).toEqual([[0, 12]]);
    expect(model.parts.children[1].ranges).toEqual([[12, 6]]);
  });
});
