// @vitest-environment node
//
// runFileInfoTask: the work the file-information worker does, called directly.
// It is free of the editor API so that it can run in a worker thread; the same
// property lets it run here. What matters about its contract is that it never
// throws (a worker that threw would look like a crash), that only a ReadError
// is marked `expected` (its message is shown as written; anything else is a
// bug and gets a generic lead-in), and that its result survives the copy a
// thread boundary makes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
