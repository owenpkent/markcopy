// Coverage for src/webview/threeMf.ts: reading a 3MF package into the triangle
// list the 3D preview draws, and refusing the packages it must not draw. The
// packages are built here with fflate, so each test shows the XML it reads.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  ThreeMfError,
  multiply,
  parse3mf,
  parseColor,
  parseMatrix,
  read3mf,
} from '../src/webview/threeMf';

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const MAT = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

// One right triangle in the XY plane, at the origin.
const TRIANGLE_MESH = `<mesh>
  <vertices>
    <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
  </vertices>
  <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
</mesh>`;

function model(resources: string, build: string, attrs = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE}" xmlns:p="${PROD}" xmlns:m="${MAT}" ${attrs}>
  <resources>${resources}</resources>
  <build>${build}</build>
</model>`;
}

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

function single(resources: string, build: string, attrs = ''): Uint8Array {
  return pack({ '_rels/.rels': RELS, '3D/3dmodel.model': model(resources, build, attrs) });
}

const ONE = single(`<object id="1" type="model">${TRIANGLE_MESH}</object>`, '<item objectid="1"/>');

function refusal(bytes: Uint8Array, maxTriangles?: number): string {
  try {
    parse3mf(bytes, { maxTriangles });
  } catch (err) {
    expect(err).toBeInstanceOf(ThreeMfError);
    return (err as Error).message;
  }
  throw new Error('expected parse3mf to refuse the package');
}

describe('parse3mf', () => {
  it('reads a single mesh with its unit and no colors', () => {
    const out = parse3mf(ONE);
    expect(out.triangles).toBe(1);
    expect(Array.from(out.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(out.colors).toBeNull();
    expect(out.unit).toBe('millimeter');
  });

  it('reads build items, objects and components as parts, named from the name attributes', () => {
    const bytes = single(
      `<object id="1" name="Peg">${TRIANGLE_MESH}</object>
       <object id="2" name="Kit"><components>
         <component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
         <component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/>
       </components></object>
       <object id="3">${TRIANGLE_MESH}</object>`,
      '<item objectid="2"/><item objectid="3"/>',
    );
    const { parts } = parse3mf(bytes);
    expect(parts.children.map((c) => c.name)).toEqual(['Kit', 'Part 1']);
    const [kit, loose] = parts.children;
    expect(kit.children.map((c) => [c.name, c.ranges])).toEqual([
      ['Peg', [[0, 1]]],
      ['Peg', [[1, 1]]],
    ]);
    expect(loose.ranges).toEqual([[2, 1]]);
  });

  it('cleans object names: controls out, length capped', () => {
    const bytes = single(
      `<object id="1" name="a&#10;b${'x'.repeat(500)}">${TRIANGLE_MESH}</object>`,
      '<item objectid="1"/>',
    );
    const [part] = parse3mf(bytes).parts.children;
    expect(part.name.startsWith('a bx')).toBe(true);
    expect(part.name.length).toBe(200);
  });

  it('gives a part for each placement, so ranges cover every triangle once', () => {
    const bytes = single(
      `<object id="1">${TRIANGLE_MESH}</object>`,
      Array.from({ length: 50 }, () => '<item objectid="1"/>').join(''),
    );
    const { parts, triangles } = parse3mf(bytes);
    expect(triangles).toBe(50);
    expect(parts.children.map((c) => c.ranges[0])).toEqual(
      Array.from({ length: 50 }, (_, i) => [i, 1]),
    );
  });

  it('reports the unit the file declares', () => {
    const xml = model(`<object id="1">${TRIANGLE_MESH}</object>`, '<item objectid="1"/>');
    const inches = pack({
      '_rels/.rels': RELS,
      '3D/3dmodel.model': xml.replace('unit="millimeter"', 'unit="inch"'),
    });
    expect(parse3mf(inches).unit).toBe('inch');
  });

  it('applies a build item transform', () => {
    const bytes = single(
      `<object id="1">${TRIANGLE_MESH}</object>`,
      '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/>',
    );
    expect(Array.from(parse3mf(bytes).positions)).toEqual([10, 20, 30, 11, 20, 30, 10, 21, 30]);
  });

  it('places each instance of a component, composing its transform before the item', () => {
    // Object 2 places object 1 twice, scaled by 2 and offset in X; the item
    // then moves the whole assembly up in Z.
    const bytes = single(
      `<object id="1">${TRIANGLE_MESH}</object>
       <object id="2"><components>
         <component objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/>
         <component objectid="1" transform="2 0 0 0 2 0 0 0 2 5 0 0"/>
       </components></object>`,
      '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 7"/>',
    );
    const out = parse3mf(bytes);
    expect(out.triangles).toBe(2);
    expect(Array.from(out.positions)).toEqual([
      0, 0, 7, 2, 0, 7, 0, 2, 7, 5, 0, 7, 7, 0, 7, 5, 2, 7,
    ]);
  });

  it('follows p:path into the separate object parts slicers write', () => {
    const bytes = pack({
      '_rels/.rels': RELS,
      '3D/3dmodel.model': model(
        `<object id="2"><components>
           <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 3 0 0"/>
         </components></object>`,
        '<item objectid="2"/>',
      ),
      '3D/Objects/object_1.model': model(`<object id="1">${TRIANGLE_MESH}</object>`, ''),
    });
    expect(Array.from(parse3mf(bytes).positions)).toEqual([3, 0, 0, 4, 0, 0, 3, 1, 0]);
  });

  it('finds the root model through the package relationships', () => {
    const bytes = pack({
      '_rels/.rels': RELS.replace('/3D/3dmodel.model', '/3D/part.model'),
      '3D/part.model': model(`<object id="1">${TRIANGLE_MESH}</object>`, '<item objectid="1"/>'),
    });
    expect(parse3mf(bytes).triangles).toBe(1);
  });

  it('colors faces from base materials and color groups, filling the rest with the fallback', () => {
    const fallback = [0.1, 0.2, 0.3] as const;
    const bytes = single(
      `<basematerials id="5"><base name="Red" displaycolor="#FF0000FF"/></basematerials>
       <m:colorgroup id="6"><m:color color="#00FF00"/><m:color color="#0000FF"/></m:colorgroup>
       <object id="1" pid="5" pindex="0">${TRIANGLE_MESH}</object>
       <object id="2"><mesh>
         <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
         <triangles><triangle v1="0" v2="1" v3="2" pid="6" p1="0" p2="1" p3="1"/></triangles>
       </mesh></object>
       <object id="3">${TRIANGLE_MESH}</object>`,
      '<item objectid="1"/><item objectid="2"/><item objectid="3"/>',
    );
    const out = parse3mf(bytes, { fallbackColor: fallback });
    const colors = Array.from(out.colors ?? []).map((c) => Math.round(c * 100) / 100);
    expect(colors).toEqual([
      // Object 1: red from its object-level base material, on every corner.
      1, 0, 0, 1, 0, 0, 1, 0, 0,
      // Object 2: green, then blue, blue, per corner.
      0, 1, 0, 0, 0, 1, 0, 0, 1,
      // Object 3 names no material.
      0.1, 0.2, 0.3, 0.1, 0.2, 0.3, 0.1, 0.2, 0.3,
    ]);
  });

  it('keeps a mirrored instance facing outward by swapping two corners', () => {
    const bytes = single(
      `<object id="1">${TRIANGLE_MESH}</object>`,
      '<item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/>',
    );
    // Corners 0, 2, 1 of the mirrored triangle.
    expect(Array.from(parse3mf(bytes).positions)).toEqual([0, 0, 0, 0, 1, 0, -1, 0, 0]);
  });
});

describe('parse3mf refusals', () => {
  it('refuses a file that is not a zip', () => {
    expect(refusal(strToU8('solid not a 3mf'))).toMatch(/not a 3MF package/);
  });

  it('refuses a part whose header claims more than its bytes could inflate to', () => {
    // The sample package, with the uncompressed size of its first part
    // rewritten to 180 MB in the central directory, where the reader takes it
    // from. Nothing else changes, so the file is still under two kilobytes.
    const bytes = Uint8Array.from(ONE);
    const view = new DataView(bytes.buffer);
    let patched = false;
    for (let i = 0; i + 28 < bytes.length && !patched; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 180 * 1024 * 1024, true);
        patched = true;
      }
    }
    expect(patched).toBe(true);
    expect(refusal(bytes)).toMatch(/claims more data than it can hold/);

    // Raising the compressed size to match the claim does not help: a part
    // cannot be bigger than the archive it is in.
    for (let i = 0; i + 28 < bytes.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 20, 10 * 1024 * 1024, true);
        break;
      }
    }
    expect(refusal(bytes)).toMatch(/claims more data than it can hold/);
  });

  it('refuses a package with no model part', () => {
    expect(refusal(pack({ '[Content_Types].xml': '<Types/>' }))).toMatch(/no 3D model part/);
  });

  it('refuses an empty build', () => {
    expect(refusal(single(`<object id="1">${TRIANGLE_MESH}</object>`, ''))).toMatch(
      /nothing in its build/,
    );
  });

  it('explains a sliced print file, which carries G-code and no mesh', () => {
    const bytes = pack({
      '_rels/.rels': RELS,
      '3D/3dmodel.model': model('', ''),
      'Metadata/plate_1.gcode': 'G28',
    });
    expect(refusal(bytes)).toMatch(/sliced print file/);
  });

  it('refuses a build item naming an object that is not defined', () => {
    expect(refusal(single('', '<item objectid="9"/>'))).toMatch(/object 9/);
  });

  it('refuses a p:path to a part the package does not contain', () => {
    const bytes = single(
      `<object id="2"><components><component p:path="/3D/Objects/gone.model" objectid="1"/></components></object>`,
      '<item objectid="2"/>',
    );
    expect(refusal(bytes)).toMatch(/does not contain/);
  });

  it('refuses components that contain themselves', () => {
    const bytes = single(
      `<object id="1"><components><component objectid="2"/></components></object>
       <object id="2"><components><component objectid="1"/></components></object>`,
      '<item objectid="1"/>',
    );
    expect(refusal(bytes)).toMatch(/contain themselves/);
  });

  it('refuses a triangle naming a vertex the mesh does not have', () => {
    const bytes = single(
      `<object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`,
      '<item objectid="1"/>',
    );
    expect(refusal(bytes)).toMatch(/names vertex 1/);
  });

  it('refuses a vertex coordinate that is not a number', () => {
    const bytes = single(
      `<object id="1"><mesh><vertices><vertex x="zero" y="0" z="0"/></vertices></mesh></object>`,
      '<item objectid="1"/>',
    );
    expect(refusal(bytes)).toMatch(/x is not a number/);
  });

  it('refuses an instancing fan-out past the triangle cap without expanding it', () => {
    // Forty levels, each placing the one below twice: 2^40 triangles declared
    // by a file of a few kilobytes. The count is memoised, so this is refused
    // in forty steps rather than a trillion.
    const levels = [`<object id="0">${TRIANGLE_MESH}</object>`];
    for (let i = 1; i <= 40; i++) {
      levels.push(
        `<object id="${i}"><components><component objectid="${i - 1}"/><component objectid="${i - 1}"/></components></object>`,
      );
    }
    const started = Date.now();
    expect(refusal(single(levels.join(''), '<item objectid="40"/>'))).toMatch(/more than/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('skips placements that hold no triangles instead of walking each one', () => {
    // The same forty levels of doubling, but over an object with nothing in
    // it, beside one ordinary triangle. The total is 1, well under any cap,
    // so only skipping the empty subtree keeps this from 2^40 visits.
    const levels = ['<object id="0"><components/></object>'];
    for (let i = 1; i <= 40; i++) {
      levels.push(
        `<object id="${i}"><components><component objectid="${i - 1}"/><component objectid="${i - 1}"/></components></object>`,
      );
    }
    const bytes = single(
      `${levels.join('')}<object id="99">${TRIANGLE_MESH}</object>`,
      '<item objectid="40"/><item objectid="99" transform="1 0 0 0 1 0 0 0 1 0 0 3"/>',
    );
    const started = Date.now();
    const out = parse3mf(bytes);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.triangles).toBe(1);
    expect(Array.from(out.positions)).toEqual([0, 0, 3, 1, 0, 3, 0, 1, 3]);
  });

  it('still draws the triangles that sit under an otherwise empty branch', () => {
    // An assembly with one empty part and one real one, two levels down.
    const bytes = single(
      `<object id="1"><components/></object>
       <object id="2">${TRIANGLE_MESH}</object>
       <object id="3"><components><component objectid="1"/><component objectid="2"/></components></object>
       <object id="4"><components><component objectid="3"/><component objectid="1"/></components></object>`,
      '<item objectid="4"/>',
    );
    expect(parse3mf(bytes).triangles).toBe(1);
  });

  it('refuses a model above the triangle cap it is given', () => {
    expect(
      refusal(
        single(
          `<object id="1">${TRIANGLE_MESH}</object>`,
          '<item objectid="1"/><item objectid="1"/>',
        ),
        1,
      ),
    ).toMatch(/more than 1 triangles/);
  });
});

describe('read3mf', () => {
  it('returns a model as a model', () => {
    const content = read3mf(ONE);
    expect(content.kind).toBe('model');
    expect(content.kind === 'model' && content.triangles).toBe(1);
  });

  it('returns the first plate of a sliced print file as G-code, with the summary', () => {
    const content = read3mf(
      pack({
        '_rels/.rels': RELS,
        '3D/3dmodel.model': model('', ''),
        'Metadata/plate_10.gcode': 'G1 X10',
        'Metadata/plate_2.gcode': 'G1 X2',
        'Metadata/slice_info.config': '<config/>',
      }),
    );
    expect(content).toEqual({
      kind: 'sliced',
      gcode: 'G1 X2',
      plates: 2,
      sliceInfo: '<config/>',
    });
  });

  it('still refuses an empty package that has no G-code either', () => {
    expect(() => read3mf(single('', ''))).toThrow(/nothing in its build/);
  });

  it('does not take G-code as an excuse for a broken model', () => {
    const bytes = pack({
      '_rels/.rels': RELS,
      '3D/3dmodel.model': model('', '<item objectid="9"/>'),
      'Metadata/plate_1.gcode': 'G1 X1',
    });
    expect(() => read3mf(bytes)).toThrow(/object 9/);
  });
});

describe('3MF helpers', () => {
  it('composes transforms so the first argument applies first', () => {
    const scale = parseMatrix('2 0 0 0 2 0 0 0 2 0 0 0');
    const shift = parseMatrix('1 0 0 0 1 0 0 0 1 5 0 0');
    // Scale then shift: (1,0,0) -> (2,0,0) -> (7,0,0).
    expect(multiply(scale, shift).slice(9)).toEqual([5, 0, 0]);
    // Shift then scale: (1,0,0) -> (6,0,0) -> (12,0,0), so translation 10.
    expect(multiply(shift, scale).slice(9)).toEqual([10, 0, 0]);
  });

  it('refuses a transform that is not twelve numbers', () => {
    expect(() => parseMatrix('1 0 0')).toThrow(ThreeMfError);
  });

  it('reads colors as linear RGB and ignores alpha', () => {
    expect(parseColor('#FFFFFF80')).toEqual([1, 1, 1]);
    expect(parseColor('#000000')).toEqual([0, 0, 0]);
    expect(parseColor('#808080')[0]).toBeCloseTo(0.2158, 3);
    expect(parseColor('red')[0]).toBeCloseTo(0.2158, 3);
  });
});
