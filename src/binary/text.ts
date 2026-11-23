// Cleaning text that came out of the file before it is shown.
//
// Written against code points rather than as a regular expression, so the
// source carries no invisible characters of its own.

function unwanted(code: number, keepLineBreaks: boolean): boolean {
  if (code === 0x09 || code === 0x0a) {
    return !keepLineBreaks;
  }
  return (
    // C0 and C1 controls, and DEL.
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    // Line and paragraph separators.
    code === 0x2028 ||
    code === 0x2029 ||
    // Bidirectional embeddings, overrides and isolates. A right-to-left
    // override is how "exe.fdp" gets displayed as "pdf.exe"; nothing a version
    // string or a signer name legitimately needs is lost with them.
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

// The longest run handed to String.fromCharCode at once: its arguments go on
// the stack, and a run of megabytes would overflow it.
const CHUNK = 8192;

/**
 * Drop control and text-direction characters, so a name from the file cannot disguise itself.
 *
 * A string with nothing to drop, which is nearly every one, is returned as it
 * came. One that needs cleaning is rebuilt from a buffer of code units. It
 * must not be built by appending a character at a time: the engine represents
 * each append as a node of some 32 bytes holding the two halves, so a string
 * cleaned that way and then kept costs about thirty times its length until
 * something flattens it. A file that names one long string from a hundred
 * thousand table entries turned 16 KB into 4 GB that way.
 */
export function printable(text: string, keepLineBreaks = false): string {
  let first = 0;
  while (first < text.length && !unwanted(text.charCodeAt(first), keepLineBreaks)) {
    first++;
  }
  if (first === text.length) {
    return text;
  }
  const units = new Uint16Array(text.length - 1);
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (i < first || !unwanted(code, keepLineBreaks)) {
      units[count++] = code;
    }
  }
  let out = '';
  for (let at = 0; at < count; at += CHUNK) {
    out += String.fromCharCode(...units.subarray(at, Math.min(count, at + CHUNK)));
  }
  return out;
}

const ELLIPSIS = String.fromCharCode(0x2026);

/**
 * At most `max` characters of `text`, marked when it was cut.
 *
 * For a value about to be kept or shown: a cap on how many strings a table may
 * hold bounds nothing if each of them may be megabytes long.
 */
export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + ELLIPSIS : text;
}
