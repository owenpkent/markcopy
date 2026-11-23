import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { escapeAttr } from './escape';
import {
  bytesSource,
  formatBytes,
  ICON_MEDIA_ID,
  PeError,
  readPe,
  renderPeHtml,
  type PeInfo,
} from './pe';
import {
  OoxmlEditorProvider,
  describeReadError,
  type OoxmlSession,
  type RenderResult,
} from './ooxmlEditor';

// Nothing about an executable's metadata depends on a setting, so these are
// only the ones the shared shell itself draws from.
const REDRAW_SETTINGS = ['markcopy.theme', 'markcopy.styleProfile', 'markcopy.wrapCode'];

// Hashing reads every byte, which the metadata does not: past this size the
// preview shows the headers at once rather than keep a disk busy for a number
// most readers of a multi-gigabyte installer did not open the file to get.
const HASH_LIMIT = 256 * 1024 * 1024;

// A file that is not on a local disk (a virtual or remote file system) can only
// be read whole, so it has to fit in memory to be read at all.
const WHOLE_FILE_LIMIT = 64 * 1024 * 1024;

const HASH_CHUNK = 1024 * 1024;

export interface Inspection {
  info: PeInfo;
  sha256?: string;
  hashNote?: string;
}

async function hashFile(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK, Math.max(size, 1)));
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) {
      break;
    }
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

/**
 * Read a file's PE metadata and its SHA-256.
 *
 * A file on disk is read in ranges through a file handle, so the size of the
 * file never becomes the size of a buffer. Nothing here runs or loads it.
 */
export async function inspectExecutable(uri: vscode.Uri): Promise<Inspection> {
  if (uri.scheme === 'file') {
    const handle = await open(uri.fsPath, 'r');
    try {
      const size = (await handle.stat()).size;
      const info = await readPe({
        size,
        read: async (offset, length) => {
          const buffer = new Uint8Array(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return buffer.subarray(0, bytesRead);
        },
      });
      return size <= HASH_LIMIT
        ? { info, sha256: await hashFile(handle, size) }
        : {
            info,
            hashNote: `Not computed for files over ${formatBytes(HASH_LIMIT).split(' (')[0]}`,
          };
    } finally {
      await handle.close();
    }
  }
  const { size } = await vscode.workspace.fs.stat(uri);
  if (size > WHOLE_FILE_LIMIT) {
    throw new PeError(
      `it is ${formatBytes(size).split(' (')[0]} and not on a local disk, where MarkCopy reads files of up to ${formatBytes(WHOLE_FILE_LIMIT).split(' (')[0]}.`,
    );
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    info: await readPe(bytesSource(bytes)),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
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
