// Where the reader was in each PDF, so reopening one picks up there. Ported from
// Folio's reading-position feature (docs/reading-position.md there): the page,
// the zoom and the fit mode are remembered, a document back at its top at the
// default zoom has nothing worth resuming, and a saved page past the end of the
// file is evidence the file is about something else, so it is ignored rather
// than clamped.
//
// This module never imports `vscode`: the store works on anything shaped like a
// Memento, which lets tests drive it. Everything read back from storage and
// everything a webview posts is untrusted and checked here.

/** The zoom presets of the PDF viewer (src/webview/pdf.ts ZOOM_LEVELS): its bounds. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
/** Past this the least recently used entries go. */
export const MAX_POSITIONS = 200;
/** The longest document URI string kept as a key. */
export const MAX_KEY_LENGTH = 2048;
/** A sanity cap on a page number; no PDF has this many pages. */
const MAX_PAGE = 1_000_000;

export const POSITIONS_KEY = 'markcopy.pdfPositions';

export interface PdfPosition {
  /** 1-based page at the top of the view. */
  page: number;
  /** Fraction (0 to 1) of that page's height scrolled past the top of the view. */
  y: number;
  /** Zoom as a scale factor, 1 being 100 %. */
  zoom: number;
  /** Fit width was on, so the zoom is re-derived from the pane rather than restored. */
  fitWidth: boolean;
}

interface Entry extends PdfPosition {
  at: number;
}

/** The slice of vscode.Memento the store uses. */
export interface PositionMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** A position, or undefined for anything that is not exactly one. */
export function validatePosition(raw: unknown): PdfPosition | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const { page, y, zoom, fitWidth } = raw as Record<string, unknown>;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    return undefined;
  }
  if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1) {
    return undefined;
  }
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) {
    return undefined;
  }
  if (typeof fitWidth !== 'boolean') {
    return undefined;
  }
  return { page, y, zoom, fitWidth };
}

/** The top of the document at the default zoom: nothing to resume. */
export function isReset(p: PdfPosition): boolean {
  return p.page === 1 && p.y < 0.02 && !p.fitWidth && p.zoom === 1;
}

function readAll(memento: PositionMemento): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const stored = memento.get<unknown>(POSITIONS_KEY);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return entries;
  }
  for (const [key, value] of Object.entries(stored)) {
    if (key.length > MAX_KEY_LENGTH) {
      continue;
    }
    const position = validatePosition(value);
    const at = (value as Record<string, unknown>).at;
    if (position && typeof at === 'number' && Number.isFinite(at)) {
      entries.set(key, { ...position, at });
    }
  }
  return entries;
}

/** The remembered position for a document, or undefined. */
export function findPosition(memento: PositionMemento, key: string): PdfPosition | undefined {
  const entry = readAll(memento).get(key);
  if (!entry) {
    return undefined;
  }
  return { page: entry.page, y: entry.y, zoom: entry.zoom, fitWidth: entry.fitWidth };
}

/**
 * Remember where the reader is. Back at the top at the default zoom deletes the
 * document's entry instead, so the list stays small. Keeps the newest
 * MAX_POSITIONS entries by time of last write.
 */
export async function savePosition(
  memento: PositionMemento,
  key: string,
  position: PdfPosition,
  now: number = Date.now(),
): Promise<void> {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || !validatePosition(position)) {
    return;
  }
  const entries = readAll(memento);
  if (isReset(position)) {
    if (!entries.delete(key)) {
      return;
    }
  } else {
    // Delete first so a re-insert moves the key to the end of the Map order.
    entries.delete(key);
    entries.set(key, { ...position, at: now });
  }
  let kept = [...entries];
  if (kept.length > MAX_POSITIONS) {
    kept = kept.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_POSITIONS);
  }
  await memento.update(POSITIONS_KEY, Object.fromEntries(kept));
}
