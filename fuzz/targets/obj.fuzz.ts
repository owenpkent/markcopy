import { mtlNameProblem, objMtlNames } from '../../src/webview/modelSniff';
import { ObjError, parseMtl, readObj } from '../../src/webview/obj';
import { checkModel } from './modelOracle';

// An OBJ names the .mtl files it wants on `mtllib` lines, and the extension
// host reads them from the OBJ's folder: that is the one place a 3D file makes
// the host touch the file system. So this target checks two things.
//
// 1. The names. objMtlNames finds them and mtlNameProblem decides which may be
//    read. A name it allows must be a bare file name in the same folder: no
//    separator of either kind, no colon (a drive or a URI), no leading dot, no
//    `..`, no control character, ending in .mtl, at most 255 characters. An
//    allowed name that breaks one of those is a finding.
// 2. The model. The input is an OBJ up to the first NUL byte and the text of
//    one .mtl file after it. readObj counts the file before three's OBJLoader
//    allocates anything and refuses it with an ObjError past the caps; anything
//    else, or arrays and parts that disagree (fuzz/targets/modelOracle.ts), is a
//    finding. The caps are far below the viewer's so a run is not spent
//    allocating a large mesh.
export const MAX_TRIANGLES = 50_000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function checkMtlName(name: string): void {
  if (mtlNameProblem(name) !== null) {
    return;
  }
  const broken =
    name.length === 0 ||
    name.length > 255 ||
    /[\\/:]/.test(name) ||
    name.startsWith('.') ||
    name.includes('..') ||
    CONTROL.test(name) ||
    !name.toLowerCase().endsWith('.mtl');
  if (broken) {
    throw new Error(`mtlNameProblem allowed ${JSON.stringify(name)}`);
  }
}

export function fuzz(data: Buffer): void {
  const nul = data.indexOf(0);
  const obj = nul < 0 ? data : data.subarray(0, nul);
  const mtlText = nul < 0 ? '' : data.subarray(nul + 1).toString('utf8');

  for (const name of objMtlNames(obj)) {
    checkMtlName(name);
  }
  // A name straight from the input too, so the rule is fuzzed on its own and
  // not only on what a mtllib line can carry.
  checkMtlName(data.subarray(0, 300).toString('utf8'));

  const mtl = [{ name: 'fuzz.mtl', text: mtlText }];
  parseMtl(mtl);
  let model;
  try {
    model = readObj(obj, {
      mtl,
      limits: {
        maxTriangles: MAX_TRIANGLES,
        maxVertices: MAX_TRIANGLES * 3,
        maxObjects: 2000,
        maxMaterialUses: 5000,
      },
    });
  } catch (err) {
    if (err instanceof ObjError) {
      return;
    }
    throw err;
  }
  checkModel('obj', model, MAX_TRIANGLES);
}
