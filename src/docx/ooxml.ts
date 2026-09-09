// Escaping and the handful of unit conversions the writer needs.

// Characters XML 1.0 has no representation for at all. Word rejects a document
// containing one outright, and they reach us from the DOM often enough (a stray
// 0x0B pasted into a CSV cell, an ANSI escape captured in a code fence) that
// stripping is the only safe policy: an unopenable .docx is a worse outcome than
// a lost control character. Tab, newline and carriage return are deliberately
// not in the set; they are legal XML and the writer gives each a meaning.
// The control characters are the entire point of the class, so the rule that
// warns about them has nothing to tell us here.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * Drop the characters XML has no representation for.
 *
 * Applied twice on purpose, at both ends of the pipeline: to the string the
 * webview serialized, because a parser rejects the document outright and one
 * stray 0x0B would cost the whole export, and again to generated text, because
 * not every string written into a part comes back through the parser.
 */
export function stripInvalidXml(s: string): string {
  return s.replace(INVALID_XML, '');
}

export function escapeXml(s: string): string {
  return stripInvalidXml(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}

/** Letter portrait at 1" margins: 8.5in - 2in of margin, in twentieths of a point. */
export const CONTENT_WIDTH_TWIPS = 9360;

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/**
 * A Word bookmark name for an HTML `id`.
 *
 * Word requires a name that starts with a letter and holds no spaces, and
 * silently drops a bookmark longer than 40 characters. Anchors minted by
 * markdown-it-anchor are slugs of the heading text, so they routinely exceed
 * that; a hash of the original keeps two long headings that share a prefix from
 * collapsing onto the same bookmark.
 */
export function bookmarkName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, '_');
  const prefixed = /^[A-Za-z]/.test(cleaned) ? cleaned : `mc_${cleaned}`;
  if (prefixed.length <= 40) {
    return prefixed;
  }
  return `${prefixed.slice(0, 32)}_${hash32(id).toString(36).slice(0, 7)}`;
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
