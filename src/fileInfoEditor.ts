import * as vscode from 'vscode';
import { posix } from 'node:path';
import { formatBytes, pageHead } from './binary/html';
import { printable } from './binary/text';
import { ReadError } from './binary/reader';
import { escapeAttr, escapeHtml } from './escape';
import { digestFile, remoteBytes, type Digest } from './fileInspect';
import type { FileInfoRequest, FileInfoResult } from './fileInfoTask';
import { runInWorker } from './isolate';
import {
  OoxmlEditorProvider,
  describeReadError,
  type OoxmlSession,
  type RenderResult,
} from './ooxmlEditor';

// The scaffold both file-information previews are built on: the executable
// info page (src/exeEditor.ts) and the package info page
// (src/packageEditor.ts). They differ in which reader runs and how its result
// is drawn. Everything about how carefully the file is approached is the same,
// and lives here so that it cannot differ:
//
// 1. Nothing is read until the reader of the page asks. Opening one of these
//    files, which a single click in the Explorer does, shows its name and size
//    and a button. The file's contents are untouched until the button, or the
//    "MarkCopy: Read This File" command, says to read them.
// 2. The reading is done in a worker thread with a heap limit and a time limit
//    (src/isolate.ts), not in the extension host. A file that defeats a
//    reader's own caps ends the worker and the page says so.
// 3. The file is never run, loaded, installed or handed to the OS:
//    `opensInDefaultApp` is off.

/** What the last draw of a page amounted to, for the command and for tests. */
export interface FileInfoOutcome {
  /** `waiting`: the confirmation page. `read`: the file's page. `failed`: a notice. */
  state: 'waiting' | 'read' | 'failed';
  /** How many warnings the reader put on the page. */
  warnings: number;
  /** The notice, when the read failed. */
  message?: string;
}

/** Read a file somewhere safe. The default starts a worker; tests read in process. */
export type FileInfoReader = (request: FileInfoRequest) => Promise<FileInfoResult>;

// The settings these pages are drawn from. `fileInfo.confirm` is here so that
// turning it off reads a file whose page is waiting, without reopening it.
const REDRAW_SETTINGS = [
  'markcopy.theme',
  'markcopy.styleProfile',
  'markcopy.wrapCode',
  'markcopy.fileInfo.confirm',
];

// Every open page, by document, so the command can reach the one in front.
const pages = new Map<string, { confirm: () => Promise<FileInfoOutcome> }>();

/**
 * Read the file whose page is open on `uri`, as its button does.
 * Resolves with what the page then shows, or undefined when no such page is open.
 */
export function readFileInfo(uri: vscode.Uri): Promise<FileInfoOutcome> | undefined {
  return pages.get(uri.toString())?.confirm();
}

export abstract class FileInfoEditorProvider extends OoxmlEditorProvider {
  protected readonly redrawSettings = REDRAW_SETTINGS;
  protected override readonly opensInDefaultApp = false;

  /** Which reader the worker runs. */
  protected abstract readonly infoKind: FileInfoRequest['kind'];
  /** What the confirmation page calls this kind of file, in the singular. */
  protected abstract readonly noun: string;
  /** One sentence on what reading the file will show. */
  protected abstract readonly promise: string;

  /** Turn what the worker found into the page. */
  protected abstract renderInfo(
    result: Extract<FileInfoResult, { ok: true }>,
    fileName: string,
    digest: Digest,
  ): RenderResult;

  /**
   * How a file is read. A worker in the product; tests replace it with a call
   * in their own process, where there is no bundled worker script to start.
   */
  public reader: FileInfoReader = (request) =>
    runInWorker<FileInfoResult>(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'fileInfoWorker.js').fsPath,
      request,
    );

  private readonly extensionUri: vscode.Uri;

  constructor(...args: ConstructorParameters<typeof OoxmlEditorProvider>) {
    super(...args);
    this.extensionUri = args[0].extensionUri;
  }

  protected createSession(
    document: vscode.CustomDocument,
    redraw: () => Promise<void>,
  ): OoxmlSession {
    const key = document.uri.toString();
    // Per page, not per provider: one provider serves every open file, and a
    // yes to one file is not a yes to the next.
    let confirmed = false;
    let outcome: FileInfoOutcome = { state: 'waiting', warnings: 0 };
    const mustAsk = (): boolean =>
      vscode.workspace
        .getConfiguration('markcopy', document.uri)
        .get<boolean>('fileInfo.confirm', true);
    const confirm = async (): Promise<FileInfoOutcome> => {
      confirmed = true;
      await redraw();
      return outcome;
    };
    pages.set(key, { confirm });
    return {
      render: async () => {
        if (!confirmed && mustAsk()) {
          outcome = { state: 'waiting', warnings: 0 };
          return { html: await this.waitingHtml(document.uri) };
        }
        try {
          const { page, warnings } = await this.read(document.uri);
          outcome = { state: 'read', warnings };
          return page;
        } catch (err) {
          outcome = {
            state: 'failed',
            warnings: 0,
            message: describeReadError(err, (e) => e instanceof ReadError),
          };
          throw err;
        }
      },
      handleMessage: async (msg) => {
        if (msg.type === 'readFile') {
          await confirm();
        }
      },
      dispose: () => {
        pages.delete(key);
      },
    };
  }

  private async read(uri: vscode.Uri): Promise<{ page: RenderResult; warnings: number }> {
    const fileName = posix.basename(uri.path);
    const bytes = await remoteBytes(uri);
    const request: FileInfoRequest = bytes
      ? { kind: this.infoKind, fileName, bytes }
      : { kind: this.infoKind, fileName, path: uri.fsPath };
    // The hash is not parsing: it streams the file through a digest a megabyte
    // at a time, in the host, while the worker reads. If it fails the page
    // still has everything else.
    const [result, digest] = await Promise.all([
      this.reader(request),
      digestFile(uri, bytes).catch((): Digest => ({
        size: bytes?.length ?? 0,
        hashNote: 'Could not be computed',
      })),
    ]);
    if (!result.ok) {
      throw result.expected ? new ReadError(result.message) : new Error(result.message);
    }
    return {
      page: this.renderInfo(result, fileName, digest),
      warnings: result.info.warnings.length,
    };
  }

  // The page a file opens on. It is built from the file's name and, from the
  // file system, its size: nothing in it comes from inside the file.
  private async waitingHtml(uri: vscode.Uri): Promise<string> {
    let size = '';
    try {
      size = `, ${formatBytes((await vscode.workspace.fs.stat(uri)).size)}`;
    } catch {
      // A file that cannot be found says so when it is read.
    }
    const head = pageHead(printable(posix.basename(uri.path)), [
      `<p>${escapeHtml(this.noun)}${escapeHtml(size)}</p>`,
    ]);
    return (
      `<div class="mc-exe mc-info-waiting">${head}` +
      `<p><strong>MarkCopy has not read this file.</strong> ${escapeHtml(this.promise)}</p>` +
      '<p>The file is only read. It is never run, installed or opened by anything else, and ' +
      'the reading is done in a separate worker with a memory limit and a time limit, so a ' +
      'damaged or hostile file cannot take the editor down with it.</p>' +
      '<p><button type="button" class="mc-info-read" data-mc-action="read-file">Read this file</button></p>' +
      '<p class="mc-exe-note">The same from the keyboard: run <strong>MarkCopy: Read This File</strong> ' +
      'from the Command Palette. To read these files as soon as they are opened, turn off ' +
      '<strong>MarkCopy: File Info: Confirm</strong> in Settings.</p></div>'
    );
  }

  protected errorHtml(err: unknown): string {
    const message = describeReadError(err, (e) => e instanceof ReadError);
    return `<div class="mc-exe"><p class="mc-exe-note">MarkCopy could not preview this file: ${escapeAttr(message)}</p></div>`;
  }
}
