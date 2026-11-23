// @vitest-environment node
//
// runFileInfoTask: the work the file-information worker does, called directly.
// It is free of the editor API so that it can run in a worker thread; the same
// property lets it run here. What matters about its contract is that it never
// throws (a worker that threw would look like a crash), that only a ReadError
// is marked `expected` (its message is shown as written; anything else is a
// bug and gets a generic lead-in), and that its result survives the copy a
// thread boundary makes.
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Every open the task makes, and a hook that runs just before the first read
// through the handle it gets. Both exist for the replaced-file regression below.
const spy = vi.hoisted(() => ({
  opens: 0,
  beforeFirstRead: undefined as (() => void) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      spy.opens++;
      const handle = await actual.open(...args);
      let first = true;
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        read: (...readArgs: unknown[]) => {
          if (first) {
            first = false;
            const hook = spy.beforeFirstRead;
            spy.beforeFirstRead = undefined;
            hook?.();
          }
          return (handle.read as (...a: unknown[]) => Promise<unknown>)(...readArgs);
        },
      };
    },
  };
});

import type * as FsPromises from 'node:fs/promises';
import { runFileInfoTask, type FileInfoRequest } from '../src/fileInfoTask';
import { buildPe, iconBitmap } from './pe/fixture';
import { buildElf } from './pkg/elfFixture';

const dir = mkdtempSync(join(tmpdir(), 'markcopy-task-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const icon = {
  id: 1,
  width: 16,
  height: 16,
  bitCount: 32,
  data: iconBitmap({
    width: 16,
    height: 16,
    bitCount: 32,
    rgba: Array.from({ length: 256 }, () => [9, 8, 7, 255]),
  }),
};

const exeBytes = (): Uint8Array =>
  buildPe({
    version: { fileVersion: [3, 1, 4, 1], strings: [['ProductName', 'Pie Tool']] },
    icons: [icon],
  });

describe('an executable', () => {
  it('is read by path', async () => {
    const path = join(dir, 'tool.exe');
    writeFileSync(path, exeBytes());

    const result = await runFileInfoTask({ kind: 'exe', fileName: 'tool.exe', path });

    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'exe') {
      expect(result.info.version?.strings).toContainEqual(['ProductName', 'Pie Tool']);
    } else {
      throw new Error('not an executable result');
    }
  });

  it('is read from bytes, to the same answer as by path', async () => {
    const bytes = exeBytes();
    const path = join(dir, 'same.exe');
    writeFileSync(path, bytes);

    const byBytes = await runFileInfoTask({ kind: 'exe', fileName: 'same.exe', bytes });
    const byPath = await runFileInfoTask({ kind: 'exe', fileName: 'same.exe', path });

    expect(byBytes.ok).toBe(true);
    expect(byBytes).toEqual(byPath);
  });

  it('survives structuredClone, icon bytes included, as it must to cross a thread', async () => {
    const result = await runFileInfoTask({ kind: 'exe', fileName: 'a.exe', bytes: exeBytes() });
    if (!result.ok || result.kind !== 'exe') {
      throw new Error('not an executable result');
    }
    expect(result.info.icon?.png.length).toBeGreaterThan(8);

    const copy = structuredClone(result);

    expect(copy).toEqual(result);
    if (!copy.ok || copy.kind !== 'exe') {
      throw new Error('not an executable result');
    }
    expect(Array.from(copy.info.icon!.png)).toEqual(Array.from(result.info.icon!.png));
  });
});

describe('a package', () => {
  it('is read by path and from bytes', async () => {
    const bytes = buildElf();
    const path = join(dir, 'libdemo.so');
    writeFileSync(path, bytes);

    const byPath = await runFileInfoTask({ kind: 'package', fileName: 'libdemo.so', path });
    const byBytes = await runFileInfoTask({ kind: 'package', fileName: 'libdemo.so', bytes });

    expect(byPath.ok).toBe(true);
    expect(byPath).toMatchObject({ ok: true, kind: 'package' });
    expect(byBytes).toEqual(byPath);
  });

  it('survives structuredClone', async () => {
    const result = await runFileInfoTask({
      kind: 'package',
      fileName: 'libdemo.so',
      bytes: buildElf(),
    });

    expect(structuredClone(result)).toEqual(result);
  });
});

describe('what goes wrong', () => {
  it('gives { ok: false } and not an exception for a path that is not there', async () => {
    const result = await runFileInfoTask({
      kind: 'exe',
      fileName: 'missing.exe',
      path: join(dir, 'missing.exe'),
    });

    // The file system's own error is a bug as far as the reader is concerned:
    // it is not a message written to be shown.
    expect(result).toMatchObject({ ok: false, expected: false });
    expect((result as { message: string }).message).toMatch(/ENOENT|no such file/i);
  });

  it('marks the reader own ReadError as expected, for a file that is not the format', async () => {
    const text = new TextEncoder().encode(
      'plain text, not a program, and long enough to look like a file\n'.repeat(4),
    );

    const exe = await runFileInfoTask({ kind: 'exe', fileName: 'x.exe', bytes: text });
    const pkg = await runFileInfoTask({ kind: 'package', fileName: 'x.deb', bytes: text });

    expect(exe).toMatchObject({ ok: false, expected: true });
    expect(pkg).toMatchObject({ ok: false });
    expect((exe as { message: string }).message).toContain('MZ');
  });

  it('gives { ok: false, expected: false } for a request that names neither path nor bytes', async () => {
    const result = await runFileInfoTask({ kind: 'exe', fileName: 'x.exe' } as FileInfoRequest);

    expect(result).toEqual({ ok: false, expected: false, message: 'the request named no file.' });
  });
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('the digest of a result', () => {
  it('is the size and SHA-256 of the file on disk', async () => {
    const bytes = exeBytes();
    const path = join(dir, 'digest.exe');
    writeFileSync(path, bytes);

    const result = await runFileInfoTask({ kind: 'exe', fileName: 'digest.exe', path });

    expect(result.ok && result.digest).toEqual({ size: bytes.length, sha256: sha256(bytes) });
  });

  it('is of the given bytes, for a request that carries them', async () => {
    const bytes = buildElf();

    const result = await runFileInfoTask({ kind: 'package', fileName: 'a.so', bytes });

    expect(result.ok && result.digest).toEqual({ size: bytes.length, sha256: sha256(bytes) });
  });
});

// A rebuild or a finished download renames a new file over the old name. The
// task opened the path in one place and the host in another, so a rename
// between the two gave a page with one version's details beside the other's
// hash. Now the task opens the path once, and reads the metadata and hashes
// through that handle.
describe('a file replaced while it is being read', () => {
  const peWith = (description: string): Uint8Array =>
    buildPe({ version: { strings: [['FileDescription', description]] } });
  // Different in size as well as in text, so a mixed page cannot pass by luck.
  const versionA = peWith('Version A');
  const versionB = Uint8Array.from([
    ...peWith('Version B, which is the newer one'),
    ...new Array(500).fill(7),
  ]);

  beforeEach(() => {
    spy.opens = 0;
    spy.beforeFirstRead = undefined;
  });

  // Whether this platform lets a name be renamed over while it is open. POSIX
  // does; Windows usually refuses (EPERM or EBUSY), and then the open-once
  // form below is the proof, which holds on every platform.
  const canRenameOverOpenFile = ((): boolean => {
    const probe = join(dir, 'probe.bin');
    const other = join(dir, 'probe-new.bin');
    writeFileSync(probe, 'a');
    writeFileSync(other, 'b');
    const fd = openSync(probe, 'r');
    try {
      renameSync(other, probe);
      return true;
    } catch {
      return false;
    } finally {
      closeSync(fd);
    }
  })();

  const expectVersionA = (result: Awaited<ReturnType<typeof runFileInfoTask>>): void => {
    if (!result.ok || result.kind !== 'exe') {
      throw new Error('not an executable result');
    }
    const strings = result.info.version?.strings ?? [];
    expect(strings).toContainEqual(['FileDescription', 'Version A']);
    expect(result.digest.size).toBe(versionA.length);
    expect(result.digest.sha256).toBe(sha256(versionA));
  };

  it('opens the path exactly once, and reports one version throughout', async () => {
    const path = join(dir, 'once.exe');
    writeFileSync(path, versionA);

    const result = await runFileInfoTask({ kind: 'exe', fileName: 'once.exe', path });

    expect(spy.opens).toBe(1);
    expectVersionA(result);
  });

  it.skipIf(!canRenameOverOpenFile)(
    'keeps the details, size and hash of the version it opened when the path is replaced mid-read',
    async () => {
      const path = join(dir, 'replaced.exe');
      const sibling = join(dir, 'replaced.exe.new');
      writeFileSync(path, versionA);
      writeFileSync(sibling, versionB);
      spy.beforeFirstRead = () => renameSync(sibling, path);

      const result = await runFileInfoTask({ kind: 'exe', fileName: 'replaced.exe', path });

      expect(spy.beforeFirstRead).toBeUndefined();
      expect(spy.opens).toBe(1);
      expectVersionA(result);
    },
  );
});
