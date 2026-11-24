import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export function missing(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOENT' || code === 'FileNotFound';
}

/** Replace the sidecar itself, never a target reached through a symbolic link. */
export async function replaceSidecar(uri: vscode.Uri, bytes?: Uint8Array): Promise<void> {
  if (uri.scheme === 'file') {
    const info = await lstat(uri.fsPath).catch((err: unknown) => {
      if (missing(err)) return undefined;
      throw err;
    });
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new Error('The comments file must be a regular file, not a symbolic link.');
    }
    if (bytes === undefined) {
      if (info) await unlink(uri.fsPath);
      return;
    }
    const temp = join(dirname(uri.fsPath), `.${basename(uri.fsPath)}.${randomUUID()}.tmp`);
    // Exclusive creation protects the temporary path too. Renaming replaces a
    // link swapped in after lstat instead of following it to another file.
    // Keep the existing file's permission bits; a new file gets 0o666 (umask applies).
    const mode = info ? info.mode & 0o777 : 0o666;
    const handle = await open(temp, 'wx', mode);
    try {
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      await rename(temp, uri.fsPath);
    } finally {
      await unlink(temp).catch((err: unknown) => {
        if (!missing(err)) throw err;
      });
    }
    return;
  }

  const info = await vscode.workspace.fs.stat(uri).then(
    (value) => value,
    (err: unknown) => {
      if (missing(err)) return undefined;
      throw err;
    },
  );
  if (info && (!(info.type & vscode.FileType.File) || info.type & vscode.FileType.SymbolicLink)) {
    throw new Error('The comments file must be a regular file, not a symbolic link.');
  }
  if (bytes === undefined) {
    if (info) await vscode.workspace.fs.delete(uri);
    return;
  }
  const temp = uri.with({ path: `${uri.path}.${randomUUID()}.tmp` });
  try {
    await vscode.workspace.fs.writeFile(temp, bytes);
    await vscode.workspace.fs.rename(temp, uri, { overwrite: true });
  } finally {
    await vscode.workspace.fs.delete(temp).then(undefined, (err: unknown) => {
      if (!missing(err)) throw err;
    });
  }
}
