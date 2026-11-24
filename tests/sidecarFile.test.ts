// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

vi.mock('vscode', () => ({ workspace: { fs: {} } }));
import { replaceSidecar } from '../src/sidecarFile';

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) {
    expect(basename(dir).startsWith('markcopy-sidecar-test-')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'markcopy-sidecar-test-'));
  owned.push(dir);
  return dir;
}
const uri = (fsPath: string) => ({ scheme: 'file', fsPath }) as never;

describe('sidecar replacement', () => {
  it('creates and replaces a sidecar without leaving temporary files', async () => {
    const dir = await directory();
    const file = join(dir, 'notes.json');
    await replaceSidecar(uri(file), Buffer.from('first'));
    await replaceSidecar(uri(file), Buffer.from('second'));
    expect(await readFile(file, 'utf8')).toBe('second');
    expect(await readdir(dir)).toEqual(['notes.json']);
    await replaceSidecar(uri(file));
    await replaceSidecar(uri(file));
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps the permission bits of an existing sidecar', async ({ skip }) => {
    if (process.platform === 'win32') {
      skip();
      return;
    }
    const dir = await directory();
    const file = join(dir, 'notes.json');
    await writeFile(file, 'first', { mode: 0o640 });
    await chmod(file, 0o640);
    await replaceSidecar(uri(file), Buffer.from('second'));
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it('refuses directory targets', async () => {
    const dir = await directory();
    await expect(replaceSidecar(uri(dir), Buffer.from('notes'))).rejects.toThrow('regular file');
  });

  it('refuses a linked sidecar without changing its target', async ({ skip }) => {
    const dir = await directory();
    const target = join(dir, 'original');
    const link = join(dir, 'notes.json');
    await writeFile(target, 'keep this');
    try {
      await symlink(target, link, 'file');
    } catch (err) {
      if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') {
        skip();
        return;
      }
      throw err;
    }
    await expect(replaceSidecar(uri(link), Buffer.from('notes'))).rejects.toThrow('symbolic link');
    await expect(replaceSidecar(uri(link))).rejects.toThrow('symbolic link');
    expect(await readFile(target, 'utf8')).toBe('keep this');
    expect((await readdir(dir)).sort()).toEqual(['notes.json', 'original']);
  });
});
