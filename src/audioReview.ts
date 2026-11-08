import type * as vscode from 'vscode';
import type { AudioReviewStateMessage, ReviewNote } from './review/protocol';
import { NotesSession, type StateFields } from './review/session';
import type { ReviewFile } from './review/schema';
import {
  addNoteText,
  loadSidecar,
  localTimestamp,
  newAudioSidecarText,
  newSidecarId,
  type SidecarLoad,
} from './review/sidecar';
import { audioReviewAddError, isAudioReviewAdd } from './review/validate';

// The host half of Audio Notes: a notes session over `<name>.review.yaml`, the OK
// Studio review format with `media: audio`. The sidecar is named after the whole
// file name (`song.mp3.review.yaml`) so `song.mp3` and `song.mp4` never share one.
// An audio file has no frames, so there is no frame rate to probe or assume: notes
// are wall-clock seconds, and this adds only the check of an add and the state
// message; the watcher, queue and writes are in src/review/session.ts.
//
// The viewer streams the file and the host never decodes it, so the duration is
// unknown here and an add has no upper time bound beyond the schema's own rules.

export class AudioReviewSession extends NotesSession {
  constructor(source: vscode.Uri, webview: vscode.Webview) {
    super(source, webview, 'audio', 'audio.review');
  }

  /** Add a note at a time or over a range. The first one creates the sidecar. */
  add(msg: unknown): Promise<void> {
    return this.enqueue(
      () =>
        this.commit((text, loaded) => {
          const bad = audioReviewAddError(msg);
          if (bad || !isAudioReviewAdd(msg)) {
            return bad ?? 'That note is not valid';
          }
          const base = text ?? newAudioSidecarText(this.sourceName, newSidecarId());
          const file = loaded?.file ?? (loadSidecar(base).file as ReviewFile);
          const next = addNoteText(
            base,
            { at: msg.at, out: msg.out, text: msg.text, created: localTimestamp(new Date()) },
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
  ): AudioReviewStateMessage {
    return { type: 'review', ...fields, notes: fields.notes as ReviewNote[] };
  }
}
