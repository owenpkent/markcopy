// Link handling for the PDF viewer: what a link annotation points at, which
// page and spot a destination names, and where a link's box sits on its page.
// Free of the DOM and of pdf.js imports so tests can drive it with plain objects.
import { parseLinkUrl } from '../pdfLinkUrl';

/** What clicking a link does. */
export type LinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'dest'; dest: string | unknown[] }
  | { kind: 'named'; action: 'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage' };

/** The parts of a pdf.js annotation this module reads. */
export interface LinkAnnotation {
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: unknown;
  action?: string;
}

const NAMED_ACTIONS = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);

/**
 * The target of a Link annotation, or null when it has none MarkCopy follows
 * (JavaScript, a remote or launch action, a scheme outside http, https and
 * mailto). The host checks an external address again before opening it.
 */
export function linkTargetOf(annot: LinkAnnotation): LinkTarget | null {
  if (annot.subtype !== 'Link') {
    return null;
  }
  if (typeof annot.url === 'string') {
    const url = parseLinkUrl(annot.url);
    return url === undefined ? null : { kind: 'url', url };
  }
  if (typeof annot.dest === 'string' || Array.isArray(annot.dest)) {
    return { kind: 'dest', dest: annot.dest };
  }
  if (typeof annot.action === 'string' && NAMED_ACTIONS.has(annot.action)) {
    return { kind: 'named', action: annot.action as 'NextPage' };
  }
  return null;
}

/** The two document calls a destination needs; `PDFDocumentProxy` has both. */
export interface DestinationSource {
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: never): Promise<number>;
}

/** A resolved destination: a 0-based page and, when it names one, a spot in PDF user space. */
export interface Destination {
  pageIndex: number;
  left: number | null;
  top: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Resolve a named or explicit destination to a page, and the point the view
 * should land on when the destination gives one (`XYZ`, `FitH`, `FitBH`,
 * `FitV`, `FitBV`, `FitR`). A page given as an object is a page reference,
 * resolved by the document; a plain integer is a 0-based index, as a GoTo in
 * some producers writes it. Null for anything it cannot place.
 */
export async function resolveDestination(
  doc: DestinationSource,
  dest: string | unknown[] | null | undefined,
  pageCount = Infinity,
): Promise<Destination | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) {
      return null;
    }
    const target = explicit[0];
    let pageIndex: number;
    if (target !== null && typeof target === 'object') {
      pageIndex = await doc.getPageIndex(target as never);
    } else if (typeof target === 'number' && Number.isInteger(target)) {
      pageIndex = target;
    } else {
      return null;
    }
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
      return null;
    }
    const mode = (explicit[1] as { name?: unknown } | null)?.name;
    let left: number | null = null;
    let top: number | null = null;
    if (mode === 'XYZ') {
      left = num(explicit[2]);
      top = num(explicit[3]);
    } else if (mode === 'FitH' || mode === 'FitBH') {
      top = num(explicit[2]);
    } else if (mode === 'FitV' || mode === 'FitBV') {
      left = num(explicit[2]);
    } else if (mode === 'FitR') {
      left = num(explicit[2]);
      top = num(explicit[5]);
    }
    return { pageIndex, left, top };
  } catch {
    return null;
  }
}

/** A box on a page as percentages of its width and height, so zoom needs no re-layout. */
export interface PercentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The part of a pdf.js viewport used to place a link. */
export interface RectViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

/**
 * The box of a link `rect` (PDF user space) on a page, from the viewport at any
 * one scale. Null for a rect that is malformed or has no area.
 */
export function linkBox(viewport: RectViewport, rect: number[] | undefined): PercentBox | null {
  if (!Array.isArray(rect) || rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) {
    return null;
  }
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (!(width > 0) || !(height > 0) || !(viewport.width > 0) || !(viewport.height > 0)) {
    return null;
  }
  return {
    left: (left / viewport.width) * 100,
    top: (top / viewport.height) * 100,
    width: (width / viewport.width) * 100,
    height: (height / viewport.height) * 100,
  };
}

/** The 1-based page a named action leads to from `current`, clamped to the document. */
export function namedActionPage(
  action: 'NextPage' | 'PrevPage' | 'FirstPage' | 'LastPage',
  current: number,
  pageCount: number,
): number {
  const raw =
    action === 'NextPage'
      ? current + 1
      : action === 'PrevPage'
        ? current - 1
        : action === 'FirstPage'
          ? 1
          : pageCount;
  return Math.min(pageCount, Math.max(1, raw));
}
