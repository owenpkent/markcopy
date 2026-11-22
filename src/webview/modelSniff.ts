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

const GCODE_SNIFF_BYTES = 64 * 1024;

/**
 * Why a file cannot be read as plain-text G-code, or null. Prusa's binary
 * G-code starts with `GCDE` whatever its extension; any other file with a NUL
 * byte in its first 64 KiB is not text.
 */
export function gcodeProblem(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x47 && bytes[1] === 0x43 && bytes[2] === 0x44 && bytes[3] === 0x45) {
    return 'binary G-code (.bgcode) is not supported';
  }
  const end = Math.min(bytes.length, GCODE_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) {
      return 'it contains binary data (a NUL byte), so it is not text G-code';
    }
  }
  return null;
}

/** What the 3D viewer says of a .obj that is a compiled object file, not a model. */
export const OBJ_BINARY_MESSAGE = 'This .obj is a compiled object file, not a 3D model.';

// The first bytes of the object files compilers write, which share the .obj
// extension: ELF, Mach-O (both byte orders, 32 and 64 bit) and an `ar` archive.
const BINARY_MAGICS: number[][] = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xfe, 0xed, 0xfa, 0xce],
  [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e], // !<arch>
  [0x00, 0x00, 0xff, 0xff], // COFF "bigobj"
];
// The machine field a COFF object (MSVC, clang-cl, MinGW) starts with, little
// endian: i386, x64, ARM Thumb-2, ARM64, Itanium.
const COFF_MACHINES = [0x014c, 0x8664, 0x01c4, 0xaa64, 0x0200];

/** How much of the start of a file is looked at for a NUL byte. */
const SNIFF_BYTES = 64 * 1024;

/**
 * Whether a .obj is binary: a COFF, ELF or Mach-O header, or a NUL byte in its
 * first 64 KiB. A Wavefront OBJ is text. Cheap enough for the host.
 */
export function objIsBinary(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && COFF_MACHINES.includes(bytes[0] | (bytes[1] << 8))) {
    return true;
  }
  if (BINARY_MAGICS.some((magic) => magic.every((b, i) => bytes[i] === b))) {
    return true;
  }
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

/** The most .mtl files read for one model, and the largest. */
export const MAX_MTL_FILES = 8;
export const MAX_MTL_BYTES = 4 * 1024 * 1024;

/**
 * The .mtl file names an OBJ's `mtllib` lines give, in order, without repeats and
 * no more than MAX_MTL_FILES + 1 (one more than is read, so the caller can say
 * some were left out). A name is the whole rest of the line, as three.js reads it:
 * Blender writes `mtllib my model.mtl` unquoted. Works on bytes, so the host does
 * not decode a file of hundreds of megabytes to find a few lines.
 */
export function objMtlNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const key = 'mtllib';
  let i = 0;
  while (i < bytes.length && names.length <= MAX_MTL_FILES) {
    let end = bytes.indexOf(0x0a, i);
    if (end < 0) {
      end = bytes.length;
    }
    let s = i;
    while (s < end && (bytes[s] === 0x20 || bytes[s] === 0x09)) {
      s++;
    }
    let match = end - s > key.length;
    for (let k = 0; match && k < key.length; k++) {
      match = bytes[s + k] === key.charCodeAt(k);
    }
    if (match && (bytes[s + key.length] === 0x20 || bytes[s + key.length] === 0x09)) {
      // A name is a file name; a longer run of bytes is not one.
      const stop = Math.min(end, s + key.length + 1024);
      const name = new TextDecoder().decode(bytes.subarray(s + key.length, stop)).trim();
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
    i = end + 1;
  }
  return names;
}

/**
 * Whether a `mtllib` name may be read: a bare file name ending in .mtl, in the
 * OBJ's own folder. Anything that could point elsewhere is refused: a path
 * separator of either kind, `..`, a drive letter or a URI scheme (any colon), a
 * leading dot, a control character. Returns the reason, or null when allowed.
 */
export function mtlNameProblem(name: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
    return 'not a usable file name';
  }
  if (/[\\/]/.test(name)) {
    return 'a path, not a file name in the same folder';
  }
  if (name.includes(':')) {
    return 'a drive or a URI, not a file name in the same folder';
  }
  if (name.startsWith('.') || name.includes('..')) {
    return 'not a file name in the same folder';
  }
  if (!name.toLowerCase().endsWith('.mtl')) {
    return 'not a .mtl file';
  }
  return null;
}
