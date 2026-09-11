// Escaping, for the writers.
//
// Word and PowerPoint reject a malformed part the same way and for the same
// reason, so the rules about what XML can carry are not either format's to own.
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

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/**
 * W3CDTF to the second, which is what the OPC core properties expect.
 *
 * Shared by docxExport.ts and pptxExport.ts: both write the same timestamp
 * shape into docProps/core.xml, and this module already exists to hold the
 * OOXML writing concerns the two formats have in common rather than each
 * other's.
 */
export function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
