// Turning the preview into a .docx file.
//
// The counterpart to Save as PDF, and deliberately not a replacement for it. A
// PDF is a picture of a page: it keeps the images and the layout, and that is
// all it keeps. A .docx keeps the *structure* -- headings with outline levels,
// tables with a marked header row, lists that are lists, images that carry their
// alt text -- which is what Word's Read Aloud, Immersive Reader, and every
// screen reader need in order to read a document rather than recite it. It is
// also still editable when it lands, which a printed page never is.
//
// The webview does the part only a browser can do: it re-renders Mermaid in the
// light theme, rasterizes diagrams and equations (keeping their source as alt
// text), inlines local images as data URIs, and serializes the result as XML
// rather than HTML so a strict parser can read it. Everything from that string
// on happens here, and nothing here touches the `vscode` module, so it is all
// unit-testable.
import { buildDocument, type DocxReport } from './docx/build';
import { buildPackage } from './docx/package';
import { parseXhtml } from './docx/parse';

export type { DocxReport } from './docx/build';

export interface DocxOptions {
  /** Document title, written to the file properties. Word wants one. */
  title: string;
  /** Injectable so a test does not depend on the clock. */
  now?: Date;
}

export interface DocxResult {
  bytes: Uint8Array;
  report: DocxReport;
}

/**
 * Convert one serialized preview into the bytes of a .docx file.
 *
 * Throws only when the input is not well-formed XML, which would mean the
 * webview sent something other than what it serializes.
 */
export function htmlToDocx(bodyXhtml: string, options: DocxOptions): DocxResult {
  const root = parseXhtml(bodyXhtml);
  const built = buildDocument(root);
  const bytes = buildPackage({
    bodyXml: built.bodyXml,
    media: built.media,
    rels: built.rels,
    nums: built.nums,
    title: options.title,
    created: isoSeconds(options.now ?? new Date()),
  });
  return { bytes, report: built.report };
}

/**
 * A one-line account of what the export produced, or undefined when there is
 * nothing worth interrupting the reader about.
 *
 * Missing alt text leads, because it is the one problem that silently defeats
 * the whole point of exporting to .docx rather than to PDF, and the one the
 * reader can still fix in the Markdown source.
 */
export function reportSummary(report: DocxReport): string | undefined {
  const notes: string[] = [];
  if (report.imagesMissingAlt > 0) {
    notes.push(
      `${count(report.imagesMissingAlt, 'image')} without alt text ` +
        '(a screen reader will skip past them)',
    );
  }
  if (report.imagesSkipped > 0) {
    notes.push(`${count(report.imagesSkipped, 'image')} could not be embedded`);
  }
  return notes.length === 0 ? undefined : notes.join('; ');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** W3CDTF to the second, which is what the OPC core properties expect. */
function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
