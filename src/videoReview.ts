import type * as vscode from 'vscode';
import type { ReviewNote, ReviewStateMessage } from './review/protocol';
import { NotesSession, type StateFields } from './review/session';
import {
  addNoteText,
  loadSidecar,
  localTimestamp,
  newSidecarId,
  newSidecarText,
  resolveFps,
  type SidecarLoad,
} from './review/sidecar';
import { isReviewAdd, reviewAddError } from './review/validate';
import type { ReviewFile } from './review/schema';

export {
  MAX_NOTE_TEXT,
  isReviewAdd,
  isReviewDelete,
  isReviewRestore,
  reviewAddError,
  type ReviewBounds,
} from './review/validate';
// The sidecar code (names, reading, validating, PyYAML-faithful writing) lives in
// src/review/sidecar.ts so Image Notes shares it; it is re-exported here.
export * from './review/sidecar';

// The host half of video review: a notes session over the `<stem>.review.yaml`
// sidecar that also resolves the frame rate from a probe. The machinery it shares
// with Image Notes is in src/review/session.ts. See docs/VIDEO-REVIEW-DESIGN.md.

/** What the host's one ffprobe run says about the video; 0 where it has no answer. */
export interface ProbeInfo {
  /** Average frame rate. */
  fps: number;
  durationSec: number;
}

/**
 * One video panel's review mode: the shared notes session plus the probed frame
 * rate, which decides a new sidecar's fps and the duration times are checked against.
 */
export class ReviewSession extends NotesSession {
  // undefined until the probe lands; its fps is 0 if the file has no average rate.
  private probeInfo: ProbeInfo | undefined;
  private probePromise: Promise<void> | undefined;

  /** `probe` resolves the video's average frame rate and duration, 0 where unknown. */
  constructor(
    source: vscode.Uri,
    webview: vscode.Webview,
    private readonly probe: () => Promise<ProbeInfo>,
  ) {
    super(source, webview, 'video', 'video.review');
  }

  /**
   * Add a note at the playhead or over a range. The first note creates the
   * sidecar, so a probe still in flight is awaited: it decides the new file's fps
   * and the duration the times are checked against.
   */
  add(msg: unknown): Promise<void> {
    return this.enqueue(async () => {
      await this.probePromise;
      await this.commit((text, loaded) => {
        const bounds = {
          durationSec: this.probeInfo?.durationSec,
          fps: resolveFps(loaded?.fps, this.probeInfo?.fps).fps,
        };
        const bad = reviewAddError(msg, bounds);
        if (bad || !isReviewAdd(msg, bounds)) {
          return bad ?? 'That note is not valid';
        }
        const base = text ?? newSidecarText(this.sourceName, bounds.fps, newSidecarId());
        const file = loaded?.file ?? (loadSidecar(base).file as ReviewFile);
        const note = {
          at: msg.at,
          out: msg.out,
          text: msg.text,
          point: msg.point,
          created: localTimestamp(new Date()),
        };
        const next = addNoteText(base, note, file);
        return { text: next.text, added: next.id, applied: () => this.written.add(next.id) };
      }, true);
    }, 'add');
  }

  protected override afterLoad(loaded: SidecarLoad | undefined): void {
    // Only a sidecar without a usable fps needs the probe.
    if (loaded?.fps === undefined && this.probeInfo === undefined) {
      void this.startProbe();
    }
  }

  protected override stateMessage(
    loaded: SidecarLoad | undefined,
    fields: StateFields,
  ): ReviewStateMessage {
    return {
      type: 'review',
      ...resolveFps(loaded?.fps, this.probeInfo?.fps),
      ...fields,
      notes: fields.notes as ReviewNote[],
    };
  }

  /** The probe, started once; its answer lands in `probeInfo` and is posted. */
  private startProbe(): Promise<void> {
    this.probePromise ??= this.probe()
      .catch(() => ({ fps: 0, durationSec: 0 }))
      .then((info) => {
        this.probeInfo = info;
        void this.post();
      });
    return this.probePromise;
  }
}
