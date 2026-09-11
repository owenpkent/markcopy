// The Word-specific corners of the writer. The escaping every OOXML writer
// needs lives in src/ooxml/write.ts and is re-exported here, so nothing inside
// src/docx has to know it moved.
export { escapeAttr, escapeXml, stripInvalidXml, XML_DECL } from '../ooxml/write';

/** Letter portrait at 1" margins: 8.5in - 2in of margin, in twentieths of a point. */
export const CONTENT_WIDTH_TWIPS = 9360;

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
