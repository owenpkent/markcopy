import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { ensureTexRoot, removeQuietly } from './texCompile';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The last successfully compiled PDF, kept apart from the compiler's output.
 *
 * The build directory is reused, and a later failed build can delete or
 * overwrite the PDF in it (pdfTeX and MiKTeX remove it when a rebuild exits
 * non-zero). The preview keeps showing the last good bytes, so "open in the
 * default app" has to open those same bytes, not whatever the engine left.
 * The bytes are held in memory and written to a private directory only when
 * the reader asks to open them.
 */
export class PdfSnapshot {
  private bytes: Buffer | undefined;
  private dir: string | undefined;
  private written: { path: string; bytes: Buffer } | undefined;
  private seq = 0;

  /** Record a good compile. Failed builds never call this. */
  set(bytes: Buffer): void {
    this.bytes = bytes;
  }

  /** Write the last good PDF out and return its path, or undefined before one exists. */
  async materialize(stem: string): Promise<string | undefined> {
    const bytes = this.bytes;
    if (!bytes) {
      return undefined;
    }
    if (this.written && this.written.bytes.equals(bytes)) {
      if (await exists(this.written.path)) {
        return this.written.path; // unchanged since the last write: reuse it
      }
      this.written = undefined;
    }
    // Another window's sweepTexRoot can remove a directory that sat untouched
    // long enough, so check it is still there rather than writing into nothing.
    if (!this.dir || !(await exists(this.dir))) {
      this.dir = await mkdtemp(join(await ensureTexRoot(), 'open-'));
    }
    const base = parse(stem).name || 'document';
    // A Windows PDF reader locks the file it has open, so rewriting the same
    // name fails with EBUSY or EPERM. A fresh name opens beside it instead.
    let path = join(this.dir, `${base}.pdf`);
    try {
      await writeFile(path, bytes);
    } catch {
      path = join(this.dir, `${base}-${++this.seq}.pdf`);
      await writeFile(path, bytes);
    }
    this.written = { path, bytes };
    return path;
  }

  async dispose(): Promise<void> {
    this.bytes = undefined;
    this.written = undefined;
    const dir = this.dir;
    this.dir = undefined;
    if (dir) {
      await removeQuietly(dir);
    }
  }
}
