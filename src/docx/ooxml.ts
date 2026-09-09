// Escaping and the handful of unit conversions the writer needs.
import { escapeHtml } from '../escape';

// Characters XML 1.0 has no representation for at all. Word rejects a document
// containing one outright, and they reach us from the DOM often enough (a stray
// 0x0B pasted into a CSV cell, an ANSI escape captured in a code fence) that
// stripping is the only safe policy: an unopenable .docx is a worse outcome than
// a lost control character. Tab, newline and carriage return are deliberately
// not in the set; they are legal XML and the writer gives each a meaning.
//
// Lone surrogates are in the set for the same reason and arrive the same way:
// half an emoji left behind by a truncating paste. A well-formed pair is matched
// first so it survives; whatever the alternation reaches after that is a half
// with no partner, which XML forbids just as firmly as a 0x0B.
// The control characters are the entire point of the class, so the rule that
// warns about them has nothing to tell us here.
const INVALID_XML =
  // eslint-disable-next-line no-control-regex
  /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/g;

/**
 * Drop the characters XML has no representation for.
 *
 * Applied twice on purpose, at both ends of the pipeline: to the string the
 * webview serialized, because a parser rejects the document outright and one
 * stray 0x0B would cost the whole export, and again to generated text, because
 * not every string written into a part comes back through the parser.
 */
export function stripInvalidXml(s: string): string {
  return s.replace(INVALID_XML, (m) => (m.length === 2 ? m : ''));
}

export function escapeXml(s: string): string {
  return escapeHtml(stripInvalidXml(s));
}

export function escapeAttr(s: string): string {
  // Newline, carriage return and tab become numeric references rather than
  // surviving literally: XML attribute-value normalization turns each into a
  // space when the document is read back, which would flatten the multi-line alt
  // text of a diagram or an equation into one run-on line.
  return escapeXml(s)
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;')
    .replace(/"/g, '&quot;');
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
 * that.
 *
 * The hash is unconditional because cleaning loses information in both
 * directions: `a-b`, `a.b` and `a b` all clean to `a_b`, and two long headings
 * that share a prefix clean to the same 32 characters. Either way Word keeps the
 * first bookmark of a duplicated name and every link to the other one lands on
 * it. 32 + `_` + at most 7 base-36 digits is exactly the 40 Word allows.
 */
export function bookmarkName(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, '_');
  const prefixed = /^[A-Za-z]/.test(cleaned) ? cleaned : `mc_${cleaned}`;
  return `${prefixed.slice(0, 32)}_${hash32(id).toString(36)}`;
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
