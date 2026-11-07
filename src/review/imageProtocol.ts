// Messages between the image preview's host (src/imageReview.ts) and its webview
// (src/webview/imageReview.ts) for Image Notes. The sidecar is the OK Studio
// review format with `media: image` (okstudio-video-kit, review.schema.json):
// notes carry no time, and may be anchored to a pin or a rectangular region.
// Types only, so both bundles can import it without pulling in code.

/** `[x, y]`, each 0 to 1 of the picture from the left and the top. */
export type ImagePoint = [number, number];

/**
 * `[x, y, w, h]`, each 0 to 1 of the picture: the top-left corner from the left
 * and top edges, then the width and height. Positive size, inside the picture.
 */
export type ImageRegion = [number, number, number, number];

/** A sidecar note as the webview sees it. */
export interface ImageNote {
  id: string;
  text: string;
  /** `note`, or `keep` / `reject` from another tool. Shown, never changed. */
  kind: string;
  done: boolean;
  /** As written by the kit: local time, `YYYY-MM-DDTHH:MM:SS`. */
  created: string;
  author?: string;
  /** A pin. Never together with `region`. */
  point?: ImagePoint;
  /** An area. Never together with `point`. Neither means the whole image. */
  region?: ImageRegion;
}

/**
 * Host to webview, after every enable, edit and reload. The first one puts the
 * webview into notes mode.
 */
export interface ImageReviewStateMessage {
  type: 'review';
  /** The sidecar's file name for display, or null when the image has none yet. */
  sidecar: string | null;
  notes: ImageNote[];
  /** Why the sidecar cannot be edited (parse or schema failure, not an image review), or null. */
  readOnly: string | null;
  /** The id of the note Restore would bring back (one level, this panel only), or null. */
  restorable: string | null;
  /** The id of the note this panel just added, so the webview can select it; else null. */
  added: string | null;
}

/** Host to webview: an error for the toast. */
export interface ImageReviewErrorMessage {
  type: 'reviewError';
  message: string;
  /** Set when the error answers a `reviewAdd` that was not saved, so the draft is given back. */
  failed?: 'add';
}

export type ImageReviewHostMessage = ImageReviewStateMessage | ImageReviewErrorMessage;

/**
 * Webview to host. `reviewEnable`: notes mode was turned on from the menu; the
 * host loads any sidecar and answers with `review`. `reviewCopy`: build the
 * Markdown, write `<name>.review.md` beside the image, copy it, and answer with
 * the existing `toast`. Edits are checked host-side before anything is written,
 * and answered with `review` or `reviewError`. The host allocates ids.
 *
 * A `reviewAdd` has at most one of `point` and `region`; neither means the note
 * is about the whole image.
 */
export type ImageReviewWebviewMessage =
  | { type: 'reviewEnable' }
  | { type: 'reviewCopy' }
  | { type: 'reviewAdd'; text: string; point?: ImagePoint; region?: ImageRegion }
  | { type: 'reviewDelete'; id: string }
  | { type: 'reviewRestore' };
