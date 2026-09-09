// The two escapes every markup writer in the extension needs.
//
// They live in their own module rather than in the renderer because the DOCX
// writer needs them too (src/docx/ooxml.ts) and must not drag markdown-it and
// highlight.js into its import graph to get them. Two copies is the alternative,
// and a copy is where a fix to one of them goes missing.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
