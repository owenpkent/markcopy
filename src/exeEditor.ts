import type * as vscode from 'vscode';
import { FileInfoEditorProvider } from './fileInfoEditor';
import { inspectFile, type Digest } from './fileInspect';
import type { FileInfoResult } from './fileInfoTask';
import type { RenderResult } from './ooxmlEditor';
import { ICON_MEDIA_ID, readPe, renderPeHtml, type PeInfo } from './pe';

export interface Inspection {
  info: PeInfo;
  sha256?: string;
  hashNote?: string;
}

/**
 * Read a file's PE metadata and its SHA-256, in this process.
 *
 * The preview does not use this: it reads in a worker (see
 * src/fileInfoEditor.ts). Kept for tests of the reader against a real file.
 */
export async function inspectExecutable(uri: vscode.Uri): Promise<Inspection> {
  const { result, sha256, hashNote } = await inspectFile(uri, readPe);
  return { info: result, sha256, hashNote };
}

// A read-only custom editor for Windows executables (.exe, .dll, .sys and the
// other PE images). Without it VS Code shows "the file is not displayed
// because it is binary"; with it the file's version details, signer,
// architecture, hash and tables are a page of ordinary headings and tables in
// the shared shell, so the context menu's copies and the three exports work on
// them.
//
// How the file is approached (asked for first, read in a worker, never run) is
// FileInfoEditorProvider's, shared with the package preview. This class says
// only which reader runs and how its result is drawn.
export class ExeEditorProvider extends FileInfoEditorProvider {
  public static readonly viewType = 'markcopy.exePreview';
  protected readonly viewType = ExeEditorProvider.viewType;
  protected readonly kind = 'exe';
  protected readonly infoKind = 'exe';
  protected readonly noun = 'Windows executable';
  protected readonly promise =
    'Reading it shows its version details, architecture, SHA-256, who it says signed it, and what it imports and exports.';

  protected renderInfo(
    result: Extract<FileInfoResult, { ok: true }>,
    fileName: string,
    digest: Digest,
  ): RenderResult {
    if (result.kind !== 'exe') {
      throw new Error('the reader answered for a different kind of file.');
    }
    const { info } = result;
    return {
      html: renderPeHtml(info, { fileName, sha256: digest.sha256, hashNote: digest.hashNote }),
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
}
