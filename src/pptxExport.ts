// Turning the preview into a .pptx file.
//
// The sibling of src/docxExport.ts: same seam, same reason to exist alongside
// Save as PDF rather than instead of it (structure survives, not just the
// picture of a page), and the same split of responsibility with the webview,
// which rasterizes diagrams and equations and inlines local images before
// handing over one string of well-formed XHTML. Everything past that string is
// unit-testable and untouched by the `vscode` module.
//
// Where it stops mirroring docxExport.ts: a slide is not a page that reflows,
// it is a fixed canvas, so the seam here also has to decide where one slide
// ends and the next begins. See src/pptx/write/build.ts for that half.
import { buildDeck, type PptxReport } from './pptx/write/build';
import { buildPackage } from './pptx/write/package';
import { parseXhtml } from './ooxml/xhtml';

export type { PptxReport } from './pptx/write/build';

export interface PptxOptions {
  /** Deck title, written to the file properties. */
  title: string;
  /** Injectable so a test does not depend on the clock. */
  now?: Date;
  /** Slide size. Default '16:9'. */
  slideSize?: '16:9' | '4:3';
}

export interface PptxResult {
  bytes: Uint8Array;
  report: PptxReport;
}

/**
 * Convert one serialized preview into the bytes of a .pptx file.
 *
 * Throws only when the input is not well-formed XML, which would mean the
 * webview sent something other than what it serializes.
 */
export function htmlToPptx(bodyXhtml: string, options: PptxOptions): PptxResult {
  const root = parseXhtml(bodyXhtml);
  const slideSize = options.slideSize ?? '16:9';
  const built = buildDeck(root, { slideSize });
  const bytes = buildPackage({
    slides: built.slides,
    media: built.media,
    title: options.title,
    created: isoSeconds(options.now ?? new Date()),
    slideSize,
  });
  return { bytes, report: built.report };
}

/**
 * A one-line account of what the export produced, or undefined when there is
 * nothing worth interrupting the reader about.
 *
 * Missing alt text leads, for the same reason it leads in reportSummary for
 * docx: it is the one problem that silently defeats the point of exporting
 * structure at all, and the one the reader can still fix in the Markdown
 * source. Overflow follows because unlike a docx page, a slide that runs past
 * its bottom edge is not something the file format will ever fix by reflowing.
 */
export function reportSummary(report: PptxReport): string | undefined {
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
  if (report.overflowed > 0) {
    notes.push(`${count(report.overflowed, 'slide')} likely run past the bottom edge`);
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
