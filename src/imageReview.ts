import type * as vscode from 'vscode';
import type { ImageNote, ImageReviewStateMessage } from './review/imageProtocol';
import { NotesSession, type StateFields } from './review/session';
import {
  addNoteText,
  loadSidecar,
  localTimestamp,
  newImageSidecarText,
  newSidecarId,
  type SidecarLoad,
} from './review/sidecar';
import type { ReviewFile } from './review/schema';
import { imageReviewAddError, isImageReviewAdd } from './review/validate';

// The host half of Image Notes: a notes session over `<name>.review.yaml`, the OK
// Studio review format with `media: image`. An image has nothing to probe and its
// notes have no time, so this adds only the check of an add and the state message;
// the watcher, queue and writes are in src/review/session.ts. The sidecar is named
// after the whole file name (`photo.png.review.yaml`).

export class ImageReviewSession extends NotesSession {
  constructor(source: vscode.Uri, webview: vscode.Webview) {
    super(source, webview, 'image', 'image.review');
  }

  /** Add a note over the whole image, at a pin, or over an area. The first one creates the sidecar. */
  add(msg: unknown): Promise<void> {
    return this.enqueue(
      () =>
        this.commit((text, loaded) => {
          const bad = imageReviewAddError(msg);
          if (bad || !isImageReviewAdd(msg)) {
            return bad ?? 'That note is not valid';
          }
          const base = text ?? newImageSidecarText(this.sourceName, newSidecarId());
          const file = loaded?.file ?? (loadSidecar(base).file as ReviewFile);
          const next = addNoteText(
            base,
            {
              text: msg.text,
              point: msg.point,
              region: msg.region,
              created: localTimestamp(new Date()),
            },
            file,
          );
          return { text: next.text, added: next.id, applied: () => this.written.add(next.id) };
        }, true),
      'add',
    );
  }

  protected override stateMessage(
    _loaded: SidecarLoad | undefined,
    fields: StateFields,
  ): ImageReviewStateMessage {
    return { type: 'review', ...fields, notes: fields.notes as ImageNote[] };
  }
}
