// @vitest-environment node
//
// inspectFile: the host's way into a file for the executable and package
// previews. (readRange has its own tests in tests/exeEditor.test.ts.)
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stat = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({ workspace: { fs: { stat, readFile } } }));

import { ReadError } from '../src/binary/reader';
import { inspectFile } from '../src/fileInspect';
import type * as vscode from 'vscode';

const dir = mkdtempSync(join(tmpdir(), 'markcopy-inspect-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  stat.mockReset();
  readFile.mockReset();
});

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const remote = { scheme: 'vscode-remote', path: '/x/pkg.deb', fsPath: '/x/pkg.deb' } as vscode.Uri;

describe('inspectFile: a file on disk', () => {
  it('returns the size, what the reader returned, and the SHA-256', async () => {
    const bytes = Uint8Array.from({ length: 3000 }, (_, i) => i % 251);
    const path = join(dir, 'a.bin');
    writeFileSync(path, bytes);
    const uri = { scheme: 'file', path, fsPath: path } as vscode.Uri;

    const got = await inspectFile(uri, async (source) => {
      const head = await source.read(10, 5);
      return { size: source.size, head: Array.from(head) };
    });

    expect(got.size).toBe(3000);
    expect(got.sha256).toBe(sha(bytes));
    expect(got.hashNote).toBeUndefined();
    expect(got.result).toEqual({ size: 3000, head: [10, 11, 12, 13, 14] });
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('hashes an empty file', async () => {
    const path = join(dir, 'empty.bin');
    writeFileSync(path, new Uint8Array(0));
    const got = await inspectFile(
      { scheme: 'file', path, fsPath: path } as vscode.Uri,
      async () => 1,
    );
    expect(got.size).toBe(0);
    expect(got.sha256).toBe(sha(new Uint8Array(0)));
  });

  it('rejects when the file is missing, and when the reader throws', async () => {
    const missing = join(dir, 'missing.bin');
    await expect(
      inspectFile({ scheme: 'file', path: missing, fsPath: missing } as vscode.Uri, async () => 1),
    ).rejects.toThrow();

    const path = join(dir, 'b.bin');
    writeFileSync(path, 'x');
    await expect(
      inspectFile({ scheme: 'file', path, fsPath: path } as vscode.Uri, async () => {
        throw new ReadError('nope.');
      }),
    ).rejects.toBeInstanceOf(ReadError);
  });
});

describe('inspectFile: a file that is not on a local disk', () => {
  it('reads it through workspace.fs and hashes what it read', async () => {
    const bytes = Uint8Array.from({ length: 500 }, (_, i) => i % 7);
    stat.mockResolvedValue({ size: 500 });
    readFile.mockResolvedValue(bytes);

    const got = await inspectFile(remote, async (source) => ({
      size: source.size,
      byte: (await source.read(8, 1))[0],
    }));

    expect(got.result).toEqual({ size: 500, byte: 1 });
    expect(got.size).toBe(500);
    expect(got.sha256).toBe(sha(bytes));
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('accepts a file of exactly 64 MiB', async () => {
    stat.mockResolvedValue({ size: 64 * 1024 * 1024 });
    readFile.mockResolvedValue(new Uint8Array(4));
    await expect(inspectFile(remote, async () => 1)).resolves.toBeDefined();
  });

  it('refuses a file over 64 MiB with a ReadError, before reading it', async () => {
    stat.mockResolvedValue({ size: 64 * 1024 * 1024 + 1 });
    const read = vi.fn();

    await expect(inspectFile(remote, read)).rejects.toBeInstanceOf(ReadError);

    expect(readFile).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
