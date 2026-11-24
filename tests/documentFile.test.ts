// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const provider = vi.hoisted(() => ({ stat: vi.fn(), readFile: vi.fn() }));
vi.mock('vscode', () => ({ workspace: { fs: provider } }));

import { readDocument } from '../src/documentFile';

const owned: string[] = [];
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  for (const dir of owned.splice(0)) {
    expect(basename(dir).startsWith('markcopy-document-test-')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'markcopy-document-test-'));
  owned.push(dir);
  const fsPath = join(dir, 'document');
  await writeFile(fsPath, content);
  return { scheme: 'file', fsPath } as never;
}

describe('document reads before parsing', () => {
  it('reads a local document exactly at the limit', async () => {
    const uri = await fixture('document');
    expect(Buffer.from(await readDocument(uri, 8)).toString()).toBe('document');
    expect(provider.readFile).not.toHaveBeenCalled();
  });

  it('refuses a local document above the limit', async () => {
    await expect(readDocument(await fixture('document'), 7)).rejects.toThrow('preview limit');
  });

  it('supports an empty local file', async () => {
    expect(await readDocument(await fixture(''), 0)).toHaveLength(0);
  });

  it('does not fetch an oversized remote file', async () => {
    provider.stat.mockResolvedValue({ size: 9 });
    await expect(readDocument({ scheme: 'remote' } as never, 8)).rejects.toThrow('preview limit');
    expect(provider.readFile).not.toHaveBeenCalled();
  });

  it('caps whole remote reads at 64 MiB even when the document limit is larger', async () => {
    provider.stat.mockResolvedValue({ size: 64 * 1024 * 1024 + 1 });
    await expect(readDocument({ scheme: 'remote' } as never)).rejects.toThrow('64 MB');
    expect(provider.readFile).not.toHaveBeenCalled();
  });

  it('refuses a remote file that grew between stat and read', async () => {
    provider.stat.mockResolvedValue({ size: 2 });
    provider.readFile.mockResolvedValue(new Uint8Array(4));
    await expect(readDocument({ scheme: 'remote' } as never, 3)).rejects.toThrow('preview limit');
  });

  it('returns a bounded remote file', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    provider.stat.mockResolvedValue({ size: bytes.length });
    provider.readFile.mockResolvedValue(bytes);
    expect(await readDocument({ scheme: 'remote' } as never, 3)).toBe(bytes);
  });
});
