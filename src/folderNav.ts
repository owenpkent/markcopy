import * as vscode from 'vscode';

// Folder stepping shared by the image and audio viewers: list the folder's files
// of the viewer's kind in Explorer order, and open the previous or next one in
// the same tab's place. Each viewer passes the predicate for its own extensions.

// Explorer-like order: case-insensitive, with digit runs compared as numbers, so
// photo2 comes before photo10.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** True when a file name ends in one of `extensions` (lower case, no dot), in any case. */
export function hasExtension(name: string, extensions: readonly string[]): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && extensions.includes(name.slice(dot + 1).toLowerCase());
}

/**
 * The folder's files that pass `isMatch`, in Explorer order. The current file is
 * always included, even if the listing missed it.
 */
export function sortedFiles(
  names: readonly string[],
  current: string,
  isMatch: (name: string) => boolean,
): string[] {
  const set = new Set(names.filter(isMatch));
  set.add(current);
  return [...set].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The file `step` places from `current`, wrapping round at either end. */
export function stepFile(files: readonly string[], current: string, step: number): string {
  const index = files.indexOf(current);
  if (index < 0 || files.length === 0) {
    return current;
  }
  const n = files.length;
  return files[(((index + step) % n) + n) % n];
}

function nameOf(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf('/') + 1);
}

/** The file's folder siblings that pass `isMatch`, in Explorer order; just this one if it cannot be read. */
export async function listFolderFiles(
  uri: vscode.Uri,
  isMatch: (name: string) => boolean,
): Promise<string[]> {
  const name = nameOf(uri);
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(uri, '..'));
    const files = entries
      .filter(([, type]) => (type & vscode.FileType.File) !== 0)
      .map(([entry]) => entry);
    return sortedFiles(files, name, isMatch);
  } catch {
    return [name];
  }
}

/** Where `uri` sits among its folder's matching files, for the viewer's Back and Next. */
export async function folderPosition(
  uri: vscode.Uri,
  isMatch: (name: string) => boolean,
): Promise<{ index: number; count: number }> {
  const files = await listFolderFiles(uri, isMatch);
  return { index: files.indexOf(nameOf(uri)) + 1, count: files.length };
}

/**
 * Show the previous or next file of the folder in this tab's place: open it with
 * the same viewer in the same group (and the same preview flag), then close the
 * tab it replaces. The folder is listed afresh, so files added since the panel
 * opened count.
 */
export async function navigateFolder(
  uri: vscode.Uri,
  panel: vscode.WebviewPanel,
  viewType: string,
  isMatch: (name: string) => boolean,
  step: number,
): Promise<void> {
  const name = nameOf(uri);
  const target = stepFile(await listFolderFiles(uri, isMatch), name, step);
  if (target === name) {
    return;
  }
  const findTab = () =>
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === viewType &&
          tab.input.uri.toString() === uri.toString() &&
          tab.group.viewColumn === panel.viewColumn,
      );
  const before = findTab();
  await vscode.commands.executeCommand(
    'vscode.openWith',
    vscode.Uri.joinPath(uri, '..', target),
    viewType,
    {
      viewColumn: panel.viewColumn,
      preview: before?.isPreview ?? false,
    },
  );
  // A preview tab is replaced by the new one; a pinned tab is still there.
  const after = findTab();
  if (after) {
    await vscode.window.tabGroups.close(after, true);
  }
}
