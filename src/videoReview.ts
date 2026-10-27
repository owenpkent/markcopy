import * as vscode from 'vscode';
import { parseDocument } from 'yaml';
import type { FpsSource, ReviewNote, ReviewStateMessage } from './review/protocol';
import { reviewMarkdown } from './review/markdown';
import type { ReviewFile } from './review/schema';

// The host half of video review: finds, reads, validates and watches the
// `<stem>.review.yaml` sidecar, resolves the frame rate, and writes the markdown
// hand-off. Phase 1 only reads the sidecar; see docs/VIDEO-REVIEW-DESIGN.md.
// Everything here that does not touch vscode is exported so it can be tested.

/**
 * `clip.mp4` -> `clip`. Only the last extension goes, as in the kit's
 * `review_path` (Python's `Path.stem`): `a.b.mov` -> `a.b`, `noext` stays, and a
 * leading or trailing dot is not an extension.
 */
export function reviewStem(videoName: string): string {
  const dot = videoName.lastIndexOf('.');
  return dot <= 0 || dot === videoName.length - 1 ? videoName : videoName.slice(0, dot);
}

export function sidecarName(videoName: string): string {
  return `${reviewStem(videoName)}.review.yaml`;
}

export function markdownName(videoName: string): string {
  return `${reviewStem(videoName)}.review.md`;
}

/** The result of reading a sidecar's text. */
export interface SidecarLoad {
  /** The validated content, or undefined when it failed to parse or validate. */
  file?: ReviewFile;
  notes: ReviewNote[];
  /** Why the sidecar cannot be edited, or null when it is a valid version 1 file. */
  readOnly: string | null;
  /** The file's own `fps`, when it is a positive number. */
  fps?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isUnit = (v: unknown): boolean => isNumber(v) && v >= 0 && v <= 1;
const isPair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(isUnit);

const KINDS = ['note', 'keep', 'reject'];
const STATUSES = ['none', 'needs_review', 'in_progress', 'approved', 'rejected'];
const TOOLS = ['arrow', 'line', 'box', 'free'];

/** A key the schema does not list: it sets additionalProperties false everywhere. */
function unknownKey(obj: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(obj).find((k) => !allowed.includes(k));
}

function noteError(note: unknown, index: number): string | null {
  const at = `notes[${index}]`;
  if (!isObject(note)) {
    return `${at} is not a mapping`;
  }
  const extra = unknownKey(note, [
    'id',
    'target',
    'at',
    'out',
    'kind',
    'text',
    'color',
    'author',
    'point',
    'done',
    'applied_op',
    'checkpoint',
    'drawing',
    'created',
  ]);
  if (extra) {
    return `${at} has an unknown field "${extra}"`;
  }
  for (const key of ['id', 'target', 'at', 'kind', 'done', 'created']) {
    if (!(key in note)) {
      return `${at} is missing "${key}"`;
    }
  }
  if (!isString(note.id)) {
    return `${at}.id must be a string`;
  }
  if (note.target !== 'source' && note.target !== 'render') {
    return `${at}.target must be source or render`;
  }
  if (!isNumber(note.at) || note.at < 0) {
    return `${at}.at must be a number of seconds, 0 or more`;
  }
  if ('out' in note && (!isNumber(note.out) || note.out <= 0)) {
    return `${at}.out must be a positive number of seconds`;
  }
  if (isNumber(note.out) && note.out <= note.at) {
    return `${at}.out must be greater than at`;
  }
  if (!isString(note.kind) || !KINDS.includes(note.kind)) {
    return `${at}.kind must be note, keep or reject`;
  }
  if ((note.kind === 'keep' || note.kind === 'reject') && note.target !== 'source') {
    return `${at} is a ${note.kind} note and must have target source`;
  }
  if (typeof note.done !== 'boolean') {
    return `${at}.done must be true or false`;
  }
  if (!isString(note.created)) {
    return `${at}.created must be a string`;
  }
  for (const key of ['text', 'color', 'author']) {
    if (key in note && !isString(note[key])) {
      return `${at}.${key} must be a string`;
    }
  }
  for (const key of ['applied_op', 'checkpoint']) {
    if (key in note && note[key] !== null && !isString(note[key])) {
      return `${at}.${key} must be a string or null`;
    }
  }
  if ('point' in note && !isPair(note.point)) {
    return `${at}.point must be two numbers from 0 to 1`;
  }
  if ('drawing' in note) {
    if (!Array.isArray(note.drawing)) {
      return `${at}.drawing must be a list`;
    }
    for (const d of note.drawing) {
      const valid =
        isObject(d) &&
        !unknownKey(d, ['tool', 'color', 'points']) &&
        TOOLS.includes(d.tool as string) &&
        Array.isArray(d.points) &&
        d.points.every(isPair) &&
        (!('color' in d) || isString(d.color));
      if (!valid) {
        return `${at}.drawing has an invalid entry`;
      }
    }
  }
  return null;
}

/**
 * The first way `data` departs from review.schema.json plus the kit's cross-field
 * rules, or null when it is a valid version 1 sidecar.
 */
export function reviewFileError(data: unknown): string | null {
  if (!isObject(data)) {
    return 'The file is not a review document';
  }
  const extra = unknownKey(data, [
    'version',
    'id',
    'source',
    'fps',
    'next_note_id',
    'asset',
    'notes',
  ]);
  if (extra) {
    return `Unknown field "${extra}"`;
  }
  for (const key of ['version', 'source', 'fps']) {
    if (!(key in data)) {
      return `Missing "${key}"`;
    }
  }
  if (data.version !== 1) {
    return `Version ${String(data.version)} is not supported (only version 1 is)`;
  }
  if (!isString(data.source) || !data.source) {
    return '"source" must be a file name';
  }
  if (!isNumber(data.fps) || data.fps <= 0) {
    return '"fps" must be a positive number';
  }
  if ('id' in data && (!isString(data.id) || !data.id)) {
    return '"id" must be a non-empty string';
  }
  if (
    'next_note_id' in data &&
    (!isNumber(data.next_note_id) || !Number.isInteger(data.next_note_id) || data.next_note_id < 1)
  ) {
    return '"next_note_id" must be a whole number, 1 or more';
  }
  if ('asset' in data) {
    const asset = data.asset;
    if (!isObject(asset) || unknownKey(asset, ['rating', 'status', 'keywords', 'notes'])) {
      return '"asset" is not valid';
    }
    if (
      'rating' in asset &&
      (!isNumber(asset.rating) ||
        !Number.isInteger(asset.rating) ||
        asset.rating < 0 ||
        asset.rating > 5)
    ) {
      return '"asset.rating" must be a whole number from 0 to 5';
    }
    if ('status' in asset && !STATUSES.includes(asset.status as string)) {
      return '"asset.status" is not a known status';
    }
    if ('keywords' in asset && !(Array.isArray(asset.keywords) && asset.keywords.every(isString))) {
      return '"asset.keywords" must be a list of strings';
    }
    if ('notes' in asset && !isString(asset.notes)) {
      return '"asset.notes" must be a string';
    }
  }
  if ('notes' in data) {
    if (!Array.isArray(data.notes)) {
      return '"notes" must be a list';
    }
    for (let i = 0; i < data.notes.length; i++) {
      const err = noteError(data.notes[i], i);
      if (err) {
        return err;
      }
    }
  }
  return null;
}

function toReviewNote(n: Record<string, unknown>): ReviewNote {
  const note: ReviewNote = {
    id: n.id as string,
    at: n.at as number,
    text: isString(n.text) ? n.text : '',
    kind: isString(n.kind) ? n.kind : 'note',
    done: n.done === true,
    created: isString(n.created) ? n.created : '',
  };
  if (isNumber(n.out) && n.out > note.at) {
    note.out = n.out;
  }
  return note;
}

/** The notes of a document that parsed but failed validation, as far as they make sense. */
function lenientNotes(data: unknown): ReviewNote[] {
  if (!isObject(data) || !Array.isArray(data.notes)) {
    return [];
  }
  return data.notes
    .filter((n) => isObject(n) && isString(n.id) && isNumber(n.at) && n.at >= 0)
    .map((n) => toReviewNote(n as Record<string, unknown>));
}

/** Read a sidecar's text: parse, validate, and say why it is read-only if it is. */
export function loadSidecar(text: string): SidecarLoad {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { notes: [], readOnly: `Not valid YAML (${doc.errors[0].message.split('\n')[0]})` };
  }
  const data: unknown = doc.toJS();
  const fps = isObject(data) && isNumber(data.fps) && data.fps > 0 ? data.fps : undefined;
  const error = reviewFileError(data);
  if (error) {
    return { notes: lenientNotes(data), readOnly: error, fps };
  }
  const file = data as ReviewFile;
  return {
    file,
    notes: (file.notes ?? []).map((n) => toReviewNote(n as unknown as Record<string, unknown>)),
    readOnly: null,
    fps: file.fps,
  };
}

/**
 * Sidecar, then probe, then 30. `probeFps` is undefined while the probe is in
 * flight and 0 when it ran and found nothing usable.
 */
export function resolveFps(
  sidecarFps: number | undefined,
  probeFps: number | undefined,
): { fps: number; fpsSource: FpsSource } {
  if (sidecarFps !== undefined && sidecarFps > 0) {
    return { fps: sidecarFps, fpsSource: 'sidecar' };
  }
  if (probeFps === undefined) {
    return { fps: 30, fpsSource: 'pending' };
  }
  return probeFps > 0 ? { fps: probeFps, fpsSource: 'probe' } : { fps: 30, fpsSource: 'assumed' };
}

/** The toast after a copy: `Copied 3 notes, saved clip.review.md`. */
export function copyToast(count: number, markdownFile: string): string {
  return `Copied ${count} ${count === 1 ? 'note' : 'notes'}, saved ${markdownFile}`;
}

/**
 * One panel's review mode. Owns the watcher and the probed fps, both scoped to
 * the panel. Nothing runs until review mode is on, so a plain preview costs
 * nothing.
 */
export class ReviewSession {
  private active = false;
  private disposed = false;
  private watcher: vscode.FileSystemWatcher | undefined;
  // undefined until the probe lands, then the average rate, or 0 if it has none.
  private probeFps: number | undefined;
  private probing = false;
  // Bumped by every post, so a slow read that started before a newer one (the
  // watcher often fires twice for one save) cannot post stale notes last.
  private generation = 0;
  private readonly videoName: string;
  private readonly dir: vscode.Uri;

  /** `probe` resolves the video's average frame rate, or 0 when it cannot. */
  constructor(
    private readonly source: vscode.Uri,
    private readonly webview: vscode.Webview,
    private readonly probe: () => Promise<number>,
  ) {
    const p = source.path;
    this.videoName = p.substring(p.lastIndexOf('/') + 1);
    this.dir = vscode.Uri.joinPath(source, '..');
  }

  private get sidecarUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, sidecarName(this.videoName));
  }

  /** After the webview's `ready`: review mode comes on if a sidecar exists or the setting is true. */
  async onReady(): Promise<void> {
    const setting = vscode.workspace
      .getConfiguration('markcopy', this.source)
      .get<boolean>('video.review', false);
    if (setting || (await this.read()) !== undefined) {
      await this.enable();
    }
  }

  /** Turn review mode on (idempotent) and post the state. */
  async enable(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.active) {
      this.active = true;
      // A RelativePattern on the video's folder, not the workspace, so a video
      // opened from outside the workspace is watched as well.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.dir, sidecarName(this.videoName)),
      );
      const reload = () => void this.post();
      watcher.onDidChange(reload);
      watcher.onDidCreate(reload);
      watcher.onDidDelete(reload);
      this.watcher = watcher;
    }
    await this.post();
  }

  /** Build the markdown from the sidecar, save it beside the sidecar, and copy it. */
  async copy(): Promise<void> {
    const text = await this.read();
    if (text === undefined) {
      this.error('There are no notes to copy yet');
      return;
    }
    const loaded = loadSidecar(text);
    if (!loaded.file) {
      this.error(`Cannot copy: ${loaded.readOnly ?? 'the notes file is not valid'}`);
      return;
    }
    const markdown = reviewMarkdown(loaded.file);
    const name = markdownName(this.videoName);
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

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  /** Write beside the target and rename over it, so a reader never sees half a file. */
  private async writeAtomic(target: vscode.Uri, content: string): Promise<void> {
    const tmp = vscode.Uri.joinPath(
      this.dir,
      `.${markdownName(this.videoName)}.${Date.now().toString(36)}.tmp`,
    );
    try {
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(content, 'utf8'));
      await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
    } catch (err) {
      await Promise.resolve(vscode.workspace.fs.delete(tmp)).catch(() => undefined);
      throw err;
    }
  }

  /** The sidecar's text, or undefined when there is none. */
  private async read(): Promise<string | undefined> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(this.sidecarUri)).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private async post(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = ++this.generation;
    const text = await this.read();
    if (generation !== this.generation || this.disposed) {
      return;
    }
    const loaded = text === undefined ? undefined : loadSidecar(text);
    // Only a sidecar without a usable fps needs the probe.
    if (loaded?.fps === undefined && this.probeFps === undefined && !this.probing) {
      this.probing = true;
      void this.probe().then(
        (fps) => this.probed(fps),
        () => this.probed(0),
      );
    }
    const msg: ReviewStateMessage = {
      type: 'review',
      ...resolveFps(loaded?.fps, this.probeFps),
      sidecar: loaded ? sidecarName(this.videoName) : null,
      notes: loaded?.notes ?? [],
      readOnly: loaded?.readOnly ?? null,
    };
    void this.webview.postMessage(msg);
  }

  private probed(fps: number): void {
    this.probeFps = fps;
    this.probing = false;
    void this.post();
  }

  private error(message: string): void {
    void this.webview.postMessage({ type: 'reviewError', message });
  }
}
