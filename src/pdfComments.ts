export interface PdfComment {
  id: string;
  page: number;
  xPct: number;
  yPct: number;
  text: string;
}

export const MAX_COMMENTS_BYTES = 2 * 1024 * 1024;
/** Per-note and per-document limits, shared with the webview so it can stop short of them. */
export const MAX_COMMENT_TEXT = 16_384;
export const MAX_COMMENT_COUNT = 2000;
export const MAX_COMMENT_TOTAL_TEXT = 256 * 1024;

function parseComment(item: unknown): PdfComment | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return undefined;
  }
  const { id, page, xPct, yPct, text } = item as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    id.length > 128 ||
    !/^[a-zA-Z0-9_-]+$/.test(id) ||
    typeof page !== 'number' ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    typeof xPct !== 'number' ||
    !Number.isFinite(xPct) ||
    xPct < 0 ||
    xPct > 1 ||
    typeof yPct !== 'number' ||
    !Number.isFinite(yPct) ||
    yPct < 0 ||
    yPct > 1 ||
    typeof text !== 'string' ||
    text.length > MAX_COMMENT_TEXT
  ) {
    return undefined;
  }
  return { id, page, xPct, yPct, text };
}

/** Validate both persisted comments and webview requests before using them. */
export function parseComments(raw: unknown): PdfComment[] | undefined {
  const lenient = parseCommentsLenient(raw);
  return lenient.complete ? lenient.comments : undefined;
}

/**
 * Keep every entry that passes validation and report whether all of them did.
 * Used to show what can be shown from a sidecar that strict validation rejects,
 * so the host can then refuse to overwrite it.
 */
export function parseCommentsLenient(raw: unknown): { comments: PdfComment[]; complete: boolean } {
  if (!Array.isArray(raw)) {
    return { comments: [], complete: false };
  }
  let complete = raw.length <= MAX_COMMENT_COUNT;
  const comments: PdfComment[] = [];
  const ids = new Set<string>();
  let textLength = 0;
  for (const item of raw.slice(0, MAX_COMMENT_COUNT)) {
    const comment = parseComment(item);
    if (
      !comment ||
      ids.has(comment.id) ||
      textLength + comment.text.length > MAX_COMMENT_TOTAL_TEXT
    ) {
      complete = false;
      continue;
    }
    textLength += comment.text.length;
    ids.add(comment.id);
    comments.push(comment);
  }
  return { comments, complete };
}
