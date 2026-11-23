import type * as vscode from 'vscode';
import { posix } from 'node:path';
import { escapeAttr } from './escape';
import { inspectFile } from './fileInspect';
import { ICON_MEDIA_ID, PeError, readPe, renderPeHtml, type PeInfo } from './pe';
import {
  OoxmlEditorProvider,
  describeReadError,
  type OoxmlSession,
  type RenderResult,
} from './ooxmlEditor';

// Nothing about an executable's metadata depends on a setting, so these are
// only the ones the shared shell itself draws from.
const REDRAW_SETTINGS = ['markcopy.theme', 'markcopy.styleProfile', 'markcopy.wrapCode'];

export interface Inspection {
  info: PeInfo;
  sha256?: string;
  hashNote?: string;
}

/** Read a file's PE metadata and its SHA-256. Nothing here runs or loads it. */
export async function inspectExecutable(uri: vscode.Uri): Promise<Inspection> {
  const { result, sha256, hashNote } = await inspectFile(uri, readPe);
  return { info: result, sha256, hashNote };
}

// A read-only custom editor for Windows executables (.exe, .dll, .sys and the
// other PE images), built on the same scaffold as the workbook, deck and Word
// editors. Without it VS Code shows "the file is not displayed because it is
// binary"; with it the file's version details, signer, architecture, hash and
// tables are a page of ordinary headings and tables in the shared shell, so
// the context menu's copies and the three exports work on them.
//
// The file is read as bytes and never run, loaded or handed to the OS:
// `opensInDefaultApp` is off because the default app for an executable is the
// executable itself.
export class ExeEditorProvider extends OoxmlEditorProvider {
  public static readonly viewType = 'markcopy.exePreview';
  protected readonly viewType = ExeEditorProvider.viewType;
  protected readonly kind = 'exe';
  protected readonly redrawSettings = REDRAW_SETTINGS;
  protected override readonly opensInDefaultApp = false;

  protected createSession(document: vscode.CustomDocument): OoxmlSession {
    return { render: () => this.renderExecutable(document.uri) };
  }

  private async renderExecutable(uri: vscode.Uri): Promise<RenderResult> {
    const { info, sha256, hashNote } = await inspectExecutable(uri);
    return {
      html: renderPeHtml(info, { fileName: posix.basename(uri.path), sha256, hashNote }),
      // The icon rides the same channel a Word document's pictures do.
      media: info.icon
        ? [
            {
              id: ICON_MEDIA_ID,
              mime: 'image/png',
              base64: Buffer.from(info.icon.png).toString('base64'),
            },
          ]
        : undefined,
    };
  }

  protected errorHtml(err: unknown): string {
    const message = describeReadError(err, (e) => e instanceof PeError);
    return `<div class="mc-exe"><p class="mc-exe-note">MarkCopy could not preview this file: ${escapeAttr(message)}</p></div>`;
  }
}
