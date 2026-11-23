import type * as vscode from 'vscode';
import { posix } from 'node:path';
import { escapeAttr } from './escape';
import { inspectFile } from './fileInspect';
import { PackageError, readPackage, renderPackageHtml } from './pkg';
import {
  OoxmlEditorProvider,
  describeReadError,
  type OoxmlSession,
  type RenderResult,
} from './ooxmlEditor';

// Nothing about a package's metadata depends on a setting, so these are only
// the ones the shared shell itself draws from.
const REDRAW_SETTINGS = ['markcopy.theme', 'markcopy.styleProfile', 'markcopy.wrapCode'];

// A read-only custom editor for packages and installers: Debian and RPM
// packages, Windows Installer databases, macOS disk images and installer
// packages, Android and Alpine packages, Java archives, VS Code extensions,
// Python wheels, NuGet packages, and Linux shared objects and AppImages. Built
// on the same scaffold as the executable info page (src/exeEditor.ts), and for
// the same reason: VS Code shows nothing for these, and the question a reader
// has about one ("what is this, what version, who made it, what does it
// need") is answered by a page of tables.
//
// The file is read as bytes and never installed, run or handed to the OS:
// `opensInDefaultApp` is off because the default app for a package is an
// installer, and for an AppImage or a .jar it is the file itself.
export class PackageEditorProvider extends OoxmlEditorProvider {
  public static readonly viewType = 'markcopy.packagePreview';
  protected readonly viewType = PackageEditorProvider.viewType;
  protected readonly kind = 'package';
  protected readonly redrawSettings = REDRAW_SETTINGS;
  protected override readonly opensInDefaultApp = false;

  protected createSession(document: vscode.CustomDocument): OoxmlSession {
    return { render: () => this.renderPackage(document.uri) };
  }

  private async renderPackage(uri: vscode.Uri): Promise<RenderResult> {
    const fileName = posix.basename(uri.path);
    const { result, size, sha256, hashNote } = await inspectFile(uri, (source) =>
      readPackage(source, fileName),
    );
    return {
      html: renderPackageHtml(result, { fileName, fileSize: size, sha256, hashNote }),
    };
  }

  protected errorHtml(err: unknown): string {
    const message = describeReadError(err, (e) => e instanceof PackageError);
    return `<div class="mc-exe"><p class="mc-exe-note">MarkCopy could not preview this file: ${escapeAttr(message)}</p></div>`;
  }
}
