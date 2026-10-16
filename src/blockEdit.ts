// Pure planning for the Markdown preview's in-place block edit. Kept free of the
// vscode API so the bounds and staleness rules can be unit tested; extension.ts
// turns the returned offsets into a Range and applies them as a WorkspaceEdit.

/** The longest replacement text the host accepts from a webview. */
export const MAX_BLOCK_EDIT_CHARS = 1_000_000;

export type Eol = '\n' | '\r\n';
export const EOL_LF: Eol = '\n';
export const EOL_CRLF: Eol = '\r\n';

export interface BlockEditRequest {
  startLine: unknown;
  endLine: unknown;
  original: unknown;
  text: unknown;
}

export type BlockEditPlan =
  | {
      ok: true;
      // Offsets into the document text: [start, end) is replaced by `text`.
      start: number;
      end: number;
      text: string;
    }
  | {
      ok: false;
      // `invalid` is a malformed message and is dropped silently; `stale` means
      // the lines are no longer what the webview showed and the user is told.
      reason: 'invalid' | 'stale';
    };

function toLf(value: string): string {
  return value.replace(/\r\n|\r/g, '\n');
}

/**
 * Work out which span of `docText` a block edit replaces.
 *
 * The span runs from the start of `startLine` to the end of the content of line
 * `endLine - 1`, and deliberately stops before that line's terminator: the
 * terminator then stays as it is, so the last line of a document with no trailing
 * newline needs no special case and a CRLF document keeps its CRLFs. The
 * replacement has its newlines rewritten to `eol`.
 *
 * `original` is the lines [startLine, endLine) joined with `\n`. If the document
 * no longer holds exactly that, the plan is refused.
 */
export function planBlockEdit(
  docText: string,
  eol: '\n' | '\r\n',
  msg: BlockEditRequest,
): BlockEditPlan {
  const { startLine, endLine, original, text } = msg;
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    typeof original !== 'string' ||
    typeof text !== 'string' ||
    text.length > MAX_BLOCK_EDIT_CHARS ||
    original.length > MAX_BLOCK_EDIT_CHARS
  ) {
    return { ok: false, reason: 'invalid' };
  }

  // Line starts and content ends, splitting exactly as VS Code does (\r\n, \r, \n).
  const starts: number[] = [0];
  const ends: number[] = [];
  const breaks = /\r\n|\r|\n/g;
  let m: RegExpExecArray | null;
  while ((m = breaks.exec(docText)) !== null) {
    ends.push(m.index);
    starts.push(m.index + m[0].length);
  }
  ends.push(docText.length);
  const lineCount = starts.length;

  if (startLine < 0 || startLine >= endLine || endLine > lineCount) {
    return { ok: false, reason: 'invalid' };
  }

  const start = starts[startLine];
  const end = ends[endLine - 1];
  if (toLf(docText.slice(start, end)) !== toLf(original)) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true, start, end, text: toLf(text).replace(/\n/g, eol) };
}
