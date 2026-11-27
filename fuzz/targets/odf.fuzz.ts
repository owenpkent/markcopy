import { encryptionRows, scanManifest, type OdfEncryption } from '../../src/pkg/odf';
import { CostError, MAX_MILLISECONDS, hasControl } from './binaryOracle';
import { zipOf } from './miniZip';
import { readAndCheck } from './pkg.fuzz';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// An OpenDocument file is a zip whose `mimetype` entry names the kind and whose
// META-INF/manifest.xml carries, for each encrypted part, a manifest:encryption-data
// element in the clear (src/pkg/odf.ts). The manifest is scanned with patterns,
// not parsed, so the scan is what is fuzzed. The pkg target reaches it only
// through a zip whose first entries are named exactly, so here the input is the
// manifest, and a zip is built around it for the full page.
//
// The first byte picks the stage:
//   0  scanManifest and encryptionRows on the bytes as manifest text
//   1  the same text as META-INF/manifest.xml in an OpenDocument text file, read
//      through readPackage with the shared page and cost oracle
//   2  as 1, with the second byte choosing the kind in the mimetype entry and the
//      manifest stored deflated
const MODES = 3;
const MIME = 'application/vnd.oasis.opendocument.';
const KINDS = [
  'text',
  'spreadsheet',
  'presentation',
  'graphics',
  'text-template',
  'chart',
  'formula',
  'image',
  'database',
  'unknown-kind',
];
const MAX_ENTRIES = 100_000;
const MAX_LABEL = 100;

function checkScan(found: OdfEncryption): void {
  if (found.total > MAX_ENTRIES || found.encrypted > found.total) {
    throw new CostError(`${found.encrypted} of ${found.total} entries`);
  }
  if (found.algorithms.length > found.encrypted || found.derivations.length > found.encrypted) {
    throw new Error('more distinct labels than encrypted entries');
  }
  for (const label of [...found.algorithms, ...found.derivations]) {
    if (hasControl(label) || label.length > MAX_LABEL) {
      throw new Error(`a label of ${label.length} characters or with a control character`);
    }
  }
  const rows = encryptionRows(found);
  if ((rows === undefined) !== (found.encrypted === 0)) {
    throw new Error('rows are shown only when an entry is encrypted');
  }
  for (const [label, value] of rows ?? []) {
    if (hasControl(label) || hasControl(value)) {
      throw new Error('a row holds a control character');
    }
  }
}

// readPackage is async, so this target is too.
export async function fuzz(data: Buffer): Promise<void> {
  if (data.length === 0) {
    return;
  }
  const mode = data[0] % MODES;
  const started = performance.now();
  if (mode === 0) {
    checkScan(scanManifest(data.subarray(1).toString('utf8')));
  } else {
    const kind = mode === 2 && data.length > 1 ? KINDS[data[1] % KINDS.length] : 'text';
    const manifest = data.subarray(mode === 2 ? 2 : 1);
    await readAndCheck(
      zipOf([
        { name: 'mimetype', data: Buffer.from(MIME + kind), deflate: false },
        { name: 'content.xml', data: Buffer.from('<x/>'), deflate: false },
        { name: 'META-INF/manifest.xml', data: manifest, deflate: mode === 2 },
      ]),
      'fuzz.odt',
    );
  }
  if (performance.now() - started > MAX_MILLISECONDS) {
    throw new CostError(`${data.length} bytes took too long`);
  }
}
