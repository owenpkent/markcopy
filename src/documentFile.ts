import * as vscode from 'vscode';
import { open } from 'node:fs/promises';

export const MAX_OFFICE_BYTES = 256 * 1024 * 1024;
export const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_BYTES = 64 * 1024 * 1024;

/** Read a document only after checking its size, with a bounded local allocation. */
export async function readDocument(
  uri: vscode.Uri,
  maxBytes: number = MAX_OFFICE_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Invalid document size limit.');
  }
  const limit = uri.scheme === 'file' ? maxBytes : Math.min(maxBytes, MAX_REMOTE_BYTES);
  const checkSize = (size: number): void => {
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
      throw new Error(`This file exceeds the ${Math.ceil(limit / 1024 / 1024)} MB preview limit.`);
    }
  };
  if (uri.scheme !== 'file') {
    // Providers expose whole-file reads only. Check both sides of that call;
    // unlike local reads, their allocation cannot be bounded by this API.
    checkSize((await vscode.workspace.fs.stat(uri)).size);
    const bytes = await vscode.workspace.fs.readFile(uri);
    checkSize(bytes.length);
    return bytes;
  }

  const handle = await open(uri.fsPath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error('Only regular files can be previewed.');
    }
    checkSize(info.size);
    // readFile() can grow its buffer if the file grows after stat(). Allocate
    // once from the same handle's checked size, and reject a changing file.
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw new Error('The file changed while it was being read. Reopen the preview.');
      }
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead > 0) {
      throw new Error('The file changed while it was being read. Reopen the preview.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
