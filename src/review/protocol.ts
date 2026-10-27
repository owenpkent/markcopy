// Messages between the video preview's host (src/videoReview.ts) and its webview
// (src/webview/videoReview.ts) for review mode. See docs/VIDEO-REVIEW-DESIGN.md.
// Types only, so both bundles can import it without pulling in code.

/** A sidecar note as the webview sees it: the fields it shows, nothing it may edit. */
export interface ReviewNote {
  id: string;
  /** Seconds in source time. */
  at: number;
  /** Seconds, greater than `at`, for a range note. */
  out?: number;
  text: string;
  /** `note`, or `keep` / `reject` from cutline. Shown, never changed. */
  kind: string;
  done: boolean;
  /** As written by the kit: local time, `YYYY-MM-DDTHH:MM:SS`. */
  created: string;
}

/**
 * Where the frame rate came from. `pending` while the host is still probing; the
 * webview shows timecodes at `fps` but labels the rate as not yet known.
 */
export type FpsSource = 'sidecar' | 'probe' | 'assumed' | 'pending';

/**
 * Host to webview, after every load, probe and reload. The first one puts the
 * webview into review mode.
 */
export interface ReviewStateMessage {
  type: 'review';
  fps: number;
  fpsSource: FpsSource;
  /** The sidecar's file name for display, or null when the video has none yet. */
  sidecar: string | null;
  notes: ReviewNote[];
  /** Why the sidecar cannot be edited (parse or schema failure, other version), or null. */
  readOnly: string | null;
  /** The id of the note Restore would bring back (one level, this panel only), or null. */
  restorable: string | null;
  /** The id of the note this panel just added, so the webview can select it; else null. */
  added: string | null;
}

/** Host to webview: an error for the toast. */
export interface ReviewErrorMessage {
  type: 'reviewError';
  message: string;
}

export type ReviewHostMessage = ReviewStateMessage | ReviewErrorMessage;

/**
 * Webview to host. `reviewEnable`: the user turned review mode on from the menu;
 * the host resolves fps, loads any sidecar and answers with `review`.
 * `reviewCopy`: build the markdown from the sidecar, write `<stem>.review.md`
 * and put the text on the clipboard; the host answers with the existing `toast`.
 *
 * The edits carry data from the page, so the host checks each with an exported
 * validator before acting, and answers every one with `review` (or `reviewError`).
 * Times are seconds in source time. The host allocates ids; the page never does.
 */
export type ReviewWebviewMessage =
  | { type: 'reviewEnable' }
  | { type: 'reviewCopy' }
  | { type: 'reviewAdd'; at: number; out?: number; text: string }
  | { type: 'reviewSetDone'; id: string; done: boolean }
  | { type: 'reviewDelete'; id: string }
  | { type: 'reviewRestore' };
