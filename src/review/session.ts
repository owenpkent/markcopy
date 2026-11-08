import * as vscode from 'vscode';
import { escapeGlobName } from '../globEscape';
import { reviewMarkdown } from './markdown';
import type { ReviewErrorMessage } from './protocol';
import {
  copyToast,
  EditError,
  loadSidecar,
  markdownName,
  removeNoteText,
  restoreNoteText,
  sidecarName,
  type RemovedNote,
  type ReviewMedia,
  type SidecarLoad,
  type SidecarNote,
} from './sidecar';
import { isReviewDelete, isReviewRestore } from './validate';

// The part of a notes session that does not depend on what the notes are about:
// the watcher, the serial edit queue, the atomic writes, the reread-and-post
// cycle and the check that another program has not replaced the file. Video Notes
// (src/videoReview.ts) and Image Notes (src/imageReview.ts) are subclasses that
// say what a state message looks like and how a note is added.

/** The file system provider's file-not-found, however the host or a test spells it. */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'FileNotFound' || code === 'ENOENT';
}

/** A note this panel deleted, held so Restore can bring it back. One level deep. */
interface HeldNote extends RemovedNote {
  /** It was written by this panel, so it counts for the replaced-notes check again. */
  wasWritten: boolean;
}

/** What a queued edit decided: the new text, or the reason it will not happen. */
export type Change = { text: string; added?: string; applied?: () => void } | string;

const idsOf = (loaded: SidecarLoad | undefined): string[] => (loaded?.notes ?? []).map((n) => n.id);

/**
 * One edit queue per sidecar, shared by every panel on it (the same image can be
 * open in two groups). Each edit re-reads the file inside its turn, so a second
 * panel's add sees the first one's note and takes the next id, instead of both
 * allocating the same id and one silently overwriting the other.
 */
const sidecarQueues = new Map<string, Promise<void>>();

/** The fields every state message carries; a subclass adds its own and the `type`. */
export interface StateFields {
  sidecar: string | null;
  notes: SidecarNote[];
  readOnly: string | null;
  restorable: string | null;
  added: string | null;
}

/** How the read-only message names each kind of review. */
const MEDIA_NOUN: Record<ReviewMedia, string> = {
  video: 'a video',
  image: 'an image',
  audio: 'an audio',
};

/**
 * One panel's notes mode. Owns the watcher and the edit queue, all scoped to the
 * panel. Nothing runs until notes mode is on, so a plain preview costs nothing.
 */
export abstract class NotesSession {
  private active = false;
  protected disposed = false;
  private watcher: vscode.FileSystemWatcher | undefined;
  // Bumped by every post, so a slow read that started before a newer one (the
  // watcher often fires twice for one save) cannot post stale notes last.
  private generation = 0;
  private editing = false;
  // The sidecar text this panel last wrote, so the watcher event it raises is not
  // answered with a second post.
  private lastWritten: string | undefined;
  // A note this panel saved whose `added` has not reached the page yet. It rides
  // on whichever post goes out next, so a newer post that supersedes the edit's
  // own one still carries it, and the page's draft is never left waiting.
  private unacked: string | null = null;
  private tmpCount = 0;
  // Ids of notes this panel added and has not deleted: if one vanishes in a reload,
  // another program replaced the file.
  protected readonly written = new Set<string>();
  private held: HeldNote | undefined;
  /** The media file's name, e.g. `clip.mp4` or `photo.png`. */
  protected readonly sourceName: string;
  private readonly dir: vscode.Uri;

  /**
   * `setting` is the `markcopy.*` key that turns notes on without a sidecar
   * (`video.review`, `image.review`, `audio.review`).
   */
  protected constructor(
    protected readonly source: vscode.Uri,
    protected readonly webview: vscode.Webview,
    protected readonly media: ReviewMedia,
    private readonly setting: string,
  ) {
    const p = source.path;
    this.sourceName = p.substring(p.lastIndexOf('/') + 1);
    this.dir = vscode.Uri.joinPath(source, '..');
  }

  // Hooks -------------------------------------------------------------------

  /** The state message for the page, from the fields every session shares. */
  protected abstract stateMessage(loaded: SidecarLoad | undefined, fields: StateFields): unknown;

  /** Called on each post with the freshly loaded sidecar, before the state goes out. */
  protected afterLoad(_loaded: SidecarLoad | undefined): void {
    // Nothing by default; video starts its probe here.
  }

  // Names --------------------------------------------------------------------

  protected get sidecarFile(): string {
    return sidecarName(this.sourceName, this.media);
  }

  protected get markdownFile(): string {
    return markdownName(this.sourceName, this.media);
  }

  private get sidecarUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, this.sidecarFile);
  }

  /**
   * `loadSidecar`, plus the rule that a panel only edits its own kind of review:
   * a video's sidecar seen by an image panel (or the reverse) is read-only.
   */
  protected load(text: string): SidecarLoad {
    const loaded = loadSidecar(text);
    if (loaded.media !== undefined && loaded.media !== this.media) {
      return {
        notes: [],
        readOnly: `Not ${MEDIA_NOUN[this.media]} review (this file is for ${MEDIA_NOUN[loaded.media]})`,
        fps: loaded.fps,
        media: loaded.media,
      };
    }
    return loaded;
  }

  // Lifecycle ----------------------------------------------------------------

  /** After the webview's `ready`: notes mode comes on if a sidecar exists or the setting is true. */
  async onReady(): Promise<void> {
    const setting = vscode.workspace
      .getConfiguration('markcopy', this.source)
      .get<boolean>(this.setting, false);
    // An unreadable sidecar is still a sidecar: turn on and let post() report it.
    const exists = await this.read().then(
      (text) => text !== undefined,
      () => true,
    );
    if (setting || exists) {
      await this.enable();
    }
  }

  /** Turn notes mode on (idempotent) and post the state. */
  async enable(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.active) {
      this.active = true;
      // A RelativePattern on the media file's folder, not the workspace, so a file
      // opened from outside the workspace is watched as well.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.dir, escapeGlobName(this.sidecarFile)),
      );
      const reload = () => void this.reload();
      watcher.onDidChange(reload);
      watcher.onDidCreate(reload);
      watcher.onDidDelete(reload);
      this.watcher = watcher;
    }
    await this.post();
  }

  /** Build the markdown from the sidecar, save it beside the sidecar, and copy it. */
  copy(): Promise<void> {
    // Through the edit queue, so a slow copy cannot rename an older export over
    // the Markdown a later edit has already written.
    return this.enqueue(() => this.copyNow());
  }

  private async copyNow(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let text: string | undefined;
    try {
      text = await this.read();
    } catch (err) {
      this.error(`Could not read ${this.sidecarFile} (${String(err)})`);
      return;
    }
    if (text === undefined) {
      this.error('There are no notes to copy yet');
      return;
    }
    const loaded = this.load(text);
    if (!loaded.file) {
      this.error(`Cannot copy: ${loaded.readOnly ?? 'the notes file is not valid'}`);
      return;
    }
    const markdown = reviewMarkdown(loaded.file);
    const name = this.markdownFile;
    try {
      await this.writeAtomic(vscode.Uri.joinPath(this.dir, name), markdown);
    } catch (err) {
      this.error(`Could not save ${name} (${String(err)})`);
      return;
    }
    await vscode.env.clipboard.writeText(markdown);
    void this.webview.postMessage({
      type: 'toast',
      message: copyToast(loaded.notes.length, name),
    });
  }

  delete(msg: unknown): Promise<void> {
    return this.enqueue(() =>
      this.commit((text, loaded) => {
        if (text === undefined || !isReviewDelete(msg, idsOf(loaded))) {
          return 'That note is no longer in the notes file';
        }
        const gone = removeNoteText(text, msg.id);
        if (!gone) {
          return 'That note is no longer in the notes file';
        }
        return {
          text: gone.text,
          applied: () => {
            this.held = { ...gone.removed, wasWritten: this.written.delete(msg.id) };
          },
        };
      }),
    );
  }

  restore(msg: unknown): Promise<void> {
    return this.enqueue(() =>
      this.commit((text, loaded) => {
        const held = this.held;
        if (!isReviewRestore(msg) || !held) {
          return 'There is no deleted note to restore';
        }
        if (text === undefined || idsOf(loaded).includes(held.id)) {
          // Not restorable any more: the note is back already, or its file is gone.
          this.held = undefined;
          return `${held.id} cannot be restored`;
        }
        return {
          text: restoreNoteText(text, held),
          applied: () => {
            if (held.wasWritten) {
              this.written.add(held.id);
            }
            this.held = undefined;
          },
        };
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  // Machinery for subclasses' `add` -------------------------------------------

  protected enqueue(job: () => Promise<void>, failed?: 'add'): Promise<void> {
    const key = this.sidecarUri.toString();
    const before = sidecarQueues.get(key) ?? Promise.resolve();
    const run = before.then(job).catch((err) => {
      this.editing = false;
      this.error(
        err instanceof EditError ? err.message : `Could not save the notes (${String(err)})`,
        failed,
      );
    });
    sidecarQueues.set(key, run);
    // Drop the entry once idle, unless a later edit has queued behind this one.
    void run.then(() => {
      if (sidecarQueues.get(key) === run) {
        sidecarQueues.delete(key);
      }
    });
    return run;
  }

  /**
   * Re-read the sidecar, refuse if it is read-only, let `change` apply one
   * operation to the fresh text, write the sidecar and then the markdown, and
   * post the result. The markdown is derived output, so it is written only here
   * and in Copy, never from a reload.
   */
  protected async commit(
    change: (text: string | undefined, loaded: SidecarLoad | undefined) => Change,
    createsFile = false,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Only an add creates the file, and it is the one edit whose draft the page can take back.
    const failed = createsFile ? 'add' : undefined;
    this.editing = true;
    let text: string | undefined;
    try {
      text = await this.read();
    } catch (err) {
      // Not "absent": writing now would replace a file that is there but unreadable.
      this.editing = false;
      this.error(`Could not read ${this.sidecarFile} (${String(err)})`, failed);
      return;
    }
    const loaded = text === undefined ? undefined : this.load(text);
    if (loaded?.readOnly || (!createsFile && loaded === undefined)) {
      this.editing = false;
      this.error(
        loaded?.readOnly
          ? `The notes file is read-only: ${loaded.readOnly}`
          : 'The notes file is no longer there',
        failed,
      );
      return;
    }
    const result = change(text, loaded);
    if (typeof result === 'string') {
      this.editing = false;
      this.error(result, failed);
      return;
    }
    // A splice that misjudged the layout must never reach the disk.
    const candidate = this.load(result.text);
    if (!candidate.file || candidate.readOnly) {
      this.editing = false;
      this.error('That change would leave the notes file invalid, so nothing was saved', failed);
      return;
    }
    try {
      await this.writeAtomic(this.sidecarUri, result.text);
    } catch (err) {
      this.editing = false;
      this.error(`Could not save ${this.sidecarFile} (${String(err)})`, failed);
      return;
    }
    this.lastWritten = result.text;
    result.applied?.();
    const name = this.markdownFile;
    try {
      await this.writeAtomic(vscode.Uri.joinPath(this.dir, name), reviewMarkdown(candidate.file));
    } catch (err) {
      this.error(`Saved the notes, but could not write ${name} (${String(err)})`);
    }
    this.editing = false;
    if (result.added) {
      this.unacked = result.added;
    }
    await this.post();
  }

  /** Write beside the target and rename over it, so a reader never sees half a file. */
  private async writeAtomic(target: vscode.Uri, content: string): Promise<void> {
    const base = target.path.substring(target.path.lastIndexOf('/') + 1);
    const tmp = vscode.Uri.joinPath(
      this.dir,
      `.${base}.${Date.now().toString(36)}${(this.tmpCount++).toString(36)}.tmp`,
    );
    try {
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(content, 'utf8'));
      await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
    } catch (err) {
      await Promise.resolve(vscode.workspace.fs.delete(tmp)).catch(() => undefined);
      throw err;
    }
  }

  /**
   * The sidecar's text, or undefined when there is none. Any other failure (no
   * permission, an I/O error) throws: the file may well be there, and treating it
   * as absent would let the next add replace it.
   */
  private async read(): Promise<string | undefined> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(this.sidecarUri)).toString('utf8');
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  /** The file changed on disk. Our own write is already on screen, so it is not posted again. */
  private async reload(): Promise<void> {
    try {
      if (this.lastWritten !== undefined && (await this.read()) === this.lastWritten) {
        return;
      }
    } catch {
      // post() reads again and says so.
    }
    await this.post();
  }

  /**
   * Post the panel's state, read fresh from disk, so a newer external edit is
   * never replaced by older text. A saved note still waiting for its `added`
   * (`unacked`) goes out with it; if that read fails, the text this panel last
   * wrote stands in, because a failed reread must not leave a saved note
   * unacknowledged.
   */
  protected async post(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = ++this.generation;
    let text: string | undefined;
    try {
      text = await this.read();
    } catch (err) {
      if (generation !== this.generation || this.disposed) {
        return;
      }
      if (this.unacked === null || this.lastWritten === undefined) {
        // Leave the panel as it is: an unreadable file is not an empty one.
        this.error(`Could not read ${this.sidecarFile} (${String(err)})`);
        return;
      }
      text = this.lastWritten;
    }
    // A newer post is on its way and carries `unacked` with it.
    if (generation !== this.generation || this.disposed) {
      return;
    }
    const added = this.unacked;
    this.unacked = null;
    const loaded = text === undefined ? undefined : this.load(text);
    this.afterLoad(loaded);
    // Not mid-edit: a read between our write and our bookkeeping would show a note
    // we are about to count (or stop counting) as missing.
    if (!this.editing && !loaded?.readOnly) {
      const present = new Set(idsOf(loaded));
      const gone = [...this.written].filter((id) => !present.has(id));
      if (gone.length > 0) {
        gone.forEach((id) => this.written.delete(id));
        this.error('Notes were replaced by another program');
      }
    }
    void this.webview.postMessage(
      this.stateMessage(loaded, {
        sidecar: loaded ? this.sidecarFile : null,
        notes: loaded?.notes ?? [],
        readOnly: loaded?.readOnly ?? null,
        restorable: this.held?.id ?? null,
        added,
      }),
    );
  }

  protected error(message: string, failed?: 'add'): void {
    // The same shape in both protocols (src/review/protocol.ts, imageProtocol.ts).
    const msg: ReviewErrorMessage = failed
      ? { type: 'reviewError', message, failed }
      : { type: 'reviewError', message };
    void this.webview.postMessage(msg);
  }
}
