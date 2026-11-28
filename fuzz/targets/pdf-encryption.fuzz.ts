import { readPdfEncryption } from '../../src/pdfEncryption';
import { CostError, MAX_MILLISECONDS, hasControl } from './binaryOracle';

export { CostError, MAX_HEAP_GROWTH, MAX_HTML_CHARS, MAX_MILLISECONDS } from './binaryOracle';

// The PDF preview shows what a file declares about its encryption, read by the
// extension host from the unencrypted trailer before the webview's pdf.js opens
// it (src/pdfEncryption.ts). It finds the last `startxref`, follows it to a
// trailer dictionary or a cross-reference stream, and parses the /Encrypt
// dictionary (direct, or the one object a reference names) with a small
// tokenising parser. It documents that it never throws, and the label it returns
// goes into the page, so the label is checked as text.
//
// A random input never has that structure, so the first byte picks a frame
// around the rest:
//   0  the bytes as they are
//   1  the rest is the Encrypt dictionary's text, in object 9 of a classic PDF
//      whose trailer refers to it
//   2  the same, but the trailer is the dictionary of a cross-reference stream
//   3  the rest is written directly after `/Encrypt` in the trailer
const MODES = 4;
const MAX_LABEL = 300;
const MAX_PERMISSIONS = 400;

function frame(mode: number, text: string): Uint8Array {
  let body = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  let reference = '9 0 R';
  const objectAt = body.length;
  if (mode === 3) {
    reference = text;
  } else {
    body += `9 0 obj\n${text}\nendobj\n`;
  }
  const at = body.length;
  if (mode === 2) {
    // The entry for object 9: type 1, a 4-byte offset, generation 0.
    const entry = String.fromCharCode(1, 0, 0, objectAt >> 8, objectAt & 0xff, 0);
    body += `10 0 obj\n<< /Type /XRef /Size 11 /Index [9 1] /W [1 4 1] /Root 1 0 R /Encrypt ${reference} /Length 6 >>\nstream\n${entry}\nendstream\nendobj\n`;
  } else {
    const entry = `${String(objectAt).padStart(10, '0')} 00000 n \n`;
    body += `xref\n0 1\n0000000000 65535 f \n9 1\n${entry}trailer\n<< /Size 10 /Root 1 0 R /Encrypt ${reference} >>\n`;
  }
  body += `startxref\n${at}\n%%EOF\n`;
  return Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
}

function check(bytes: Uint8Array): void {
  const started = performance.now();
  const found = readPdfEncryption(bytes);
  if (performance.now() - started > MAX_MILLISECONDS) {
    throw new CostError(`${bytes.length} bytes took too long`);
  }
  // Deterministic: nothing is kept between files.
  if (JSON.stringify(readPdfEncryption(bytes)) !== JSON.stringify(found)) {
    throw new Error('two readings of the same bytes differ');
  }
  if (found === undefined) {
    return;
  }
  if (!found.label.startsWith('Encrypted: ') || found.label.length > MAX_LABEL) {
    throw new Error(
      `a label of ${found.label.length} characters: ${JSON.stringify(found.label.slice(0, 80))}`,
    );
  }
  if (hasControl(found.label)) {
    throw new Error(
      `the label holds a control character: ${JSON.stringify(found.label.slice(0, 80))}`,
    );
  }
  if (found.permissions !== undefined) {
    if (
      found.permissions.length > MAX_PERMISSIONS ||
      !/^The file (restricts: |declares no restrictions)/.test(found.permissions) ||
      hasControl(found.permissions)
    ) {
      throw new Error(`permissions ${JSON.stringify(found.permissions.slice(0, 80))}`);
    }
  }
}

export function fuzz(data: Buffer): void {
  if (data.length === 0) {
    return;
  }
  const mode = data[0] % MODES;
  const rest = data.subarray(1);
  check(mode === 0 ? rest : frame(mode, rest.toString('latin1')));
}
