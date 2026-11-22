// The cheap header checks for GLB and STEP files. No imports, so the extension
// host can run them before base64-encoding a file without pulling in three.js
// or the STEP engine, which only the webview bundle holds.

const GLB_MAGIC = 0x46546c67; // "glTF", little-endian

/** Whether the first twelve bytes are a GLB header. Cheap enough for the host. */
export function glbHeaderProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 12) {
    return 'it is too short to be a GLB file.';
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    return 'it does not start with the glTF binary header, so it is not a GLB file.';
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    return `it is glTF binary version ${version}, and MarkCopy reads version 2 only.`;
  }
  return null;
}

/** Whether the file begins like a STEP exchange file, after any BOM or blanks. */
export function stepHeaderProblem(bytes: Uint8Array): string | null {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    i = 3;
  }
  while (i < bytes.length && (bytes[i] === 0x20 || (bytes[i] >= 0x09 && bytes[i] <= 0x0d))) {
    i++;
  }
  const magic = 'ISO-10303-21;';
  for (let k = 0; k < magic.length; k++) {
    if (bytes[i + k] !== magic.charCodeAt(k)) {
      return 'it does not start with ISO-10303-21;, so it is not a STEP file.';
    }
  }
  return null;
}
