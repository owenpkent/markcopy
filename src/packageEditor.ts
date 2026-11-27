import { FileInfoEditorProvider } from './fileInfoEditor';
import type { Digest } from './fileInspect';
import type { FileInfoResult } from './fileInfoTask';
import type { RenderResult } from './ooxmlEditor';
import { renderPackageHtml } from './pkg';

// A read-only custom editor for packages and installers: Debian and RPM
// packages, Windows Installer databases, macOS disk images and installer
// packages, Android and Alpine packages, Java archives, VS Code extensions,
// Python wheels, NuGet packages, and Linux shared objects and AppImages. VS
// Code shows nothing for these, and the question a reader has about one ("what
// is this, what version, who made it, what does it need") is answered by a
// page of tables.
//
// How the file is approached (asked for first, read in a worker, never
// installed or run) is FileInfoEditorProvider's, shared with the executable
// preview. This class says only which reader runs and how its result is drawn.
export class PackageEditorProvider extends FileInfoEditorProvider {
  public static readonly viewType = 'markcopy.packagePreview';
  protected readonly viewType: string = PackageEditorProvider.viewType;
  protected readonly kind = 'package';
  protected readonly infoKind = 'package';
  protected readonly noun: string = 'Package or installer';
  protected readonly promise: string =
    'Reading it shows what the package is, its version, what it depends on, whether installing it runs scripts, what is inside, and its SHA-256.';

  protected renderInfo(
    result: Extract<FileInfoResult, { ok: true }>,
    fileName: string,
    digest: Digest,
  ): RenderResult {
    if (result.kind !== 'package') {
      throw new Error('the reader answered for a different kind of file.');
    }
    return {
      html: renderPackageHtml(result.info, {
        fileName,
        fileSize: digest.size,
        sha256: digest.sha256,
        hashNote: digest.hashNote,
      }),
    };
  }
}
