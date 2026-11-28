import { htmlToDocx } from '../../src/docxExport';
import { htmlToPptx } from '../../src/pptxExport';
import { isExpectedXmlError } from './expected';

// The Word and PowerPoint writers take the serialized preview as XHTML, which
// DOMPurify has cleaned but whose text, attributes (colspan, rowspan, style,
// src) and nesting still come from a document the user did not write. A
// malformed document is the parser's documented refusal; anything that parses
// must come out as a zip container in both formats, and the same input twice
// must give the same report.
const NOW = new Date('2026-01-01T00:00:00Z');

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function fuzz(data: Buffer): void {
  const xhtml = data.toString('utf8');
  let docx;
  try {
    docx = htmlToDocx(xhtml, { title: 'fuzz', now: NOW });
  } catch (err) {
    if (isExpectedXmlError(err)) return;
    throw err;
  }
  if (!isZip(docx.bytes)) {
    throw new Error('docx export is not a zip container');
  }
  // The zip stamps its entries with the clock, so the bytes differ between
  // two runs a few seconds apart; what the builder decided does not.
  const again = htmlToDocx(xhtml, { title: 'fuzz', now: NOW });
  if (JSON.stringify(docx.report) !== JSON.stringify(again.report)) {
    throw new Error('docx report is not deterministic');
  }
  const deck = htmlToPptx(xhtml, {
    title: 'fuzz',
    now: NOW,
    slideSize: data.length % 2 ? '4:3' : '16:9',
  });
  if (!isZip(deck.bytes)) {
    throw new Error('pptx export is not a zip container');
  }
}
