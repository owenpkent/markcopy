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

/** Drop control and text-direction characters, so a name from the file cannot disguise itself. */
export function printable(text: string, keepLineBreaks = false): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (!unwanted(text.charCodeAt(i), keepLineBreaks)) {
      out += text[i];
    }
  }
  return out;
}
