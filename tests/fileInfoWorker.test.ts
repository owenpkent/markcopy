// @vitest-environment node
//
// The real worker, built the way esbuild.js builds it and started the way the
// preview starts it. tests/fileInfoTask.test.ts covers what the task does, and
// tests/isolate.test.ts covers the limits with scripts of its own; this file is
// the join between them: the bundle runs standalone (it has no `vscode`), takes
// its request as workerData, and answers with a result that has crossed the
// thread, including for a hostile file.
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFileInfoTask, type FileInfoRequest, type FileInfoResult } from '../src/fileInfoTask';
import { runInWorker } from '../src/isolate';
import { buildPe } from './pe/fixture';
import { buildElf } from './pkg/elfFixture';
import { buildXar } from './pkg/xarFixture';

let dir: string;
let worker: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'markcopy-worker-test-'));
  worker = join(dir, 'fileInfoWorker.js');
  buildSync({
    entryPoints: [join(__dirname, '..', 'src', 'fileInfoWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: worker,
    logLevel: 'silent',
  });
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileWith(name: string, bytes: Uint8Array | string): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const heap = (): number => {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
};
const LIMIT = 64 * 1024 * 1024;

const read = (request: FileInfoRequest): Promise<FileInfoResult> =>
  runInWorker<FileInfoResult>(worker, request);

describe('the bundled file-information worker', () => {
  it('reads an executable from disk, to the same answer as the task in process', async () => {
    const path = fileWith(
      'tool.exe',
      buildPe({ version: { strings: [['ProductName', 'Pie Tool']] } }),
    );
    const request: FileInfoRequest = { kind: 'exe', fileName: 'tool.exe', path };

    const result = await read(request);

    expect(result.ok).toBe(true);
    expect(result).toEqual(await runFileInfoTask(request));
  });

  it('reads a package from disk', async () => {
    const path = fileWith('libdemo.so', buildElf());

    const result = await read({ kind: 'package', fileName: 'libdemo.so', path });

    expect(result).toMatchObject({ ok: true, kind: 'package' });
  });

  it('reads bytes the host handed it, for a file that is not on a local disk', async () => {
    const result = await read({
      kind: 'package',
      fileName: 'libdemo.so',
      bytes: buildElf(),
    });

    expect(result).toMatchObject({ ok: true, kind: 'package' });
  });

  it('answers { ok: false, expected: true } for a file that is not the format', async () => {
    const path = fileWith('plain.exe', 'plain text, not a program\n'.repeat(10));

    const result = await read({ kind: 'exe', fileName: 'plain.exe', path });

    expect(result).toMatchObject({ ok: false, expected: true });
  });

  describe('on hostile files', () => {
    it('answers for a macOS installer whose directory name is a megabyte long, and the host heap is undisturbed', async () => {
      // From tests/pkg/hostileMac.test.ts: the name was once copied into every
      // child's path.
      const name = 'D'.repeat(1024 * 1024);
      const kids = '<file><name>a</name><type>file</type></file>'.repeat(1000);
      const toc = `<xar><toc><file><name>${name}</name><type>directory</type>${kids}</file></toc></xar>`;
      const path = fileWith('bomb.pkg', buildXar({ rawToc: toc }));
      const before = heap();

      const result = await read({ kind: 'package', fileName: 'bomb.pkg', path });

      expect(result).toMatchObject({ ok: true, kind: 'package' });
      expect(heap() - before).toBeLessThan(LIMIT);
    });

    it('answers with a notice for a table of contents with more elements than any real one', async () => {
      const toc = `<xar><toc>${'<a/>'.repeat(300_000)}</toc></xar>`;
      const path = fileWith('elements.pkg', buildXar({ rawToc: toc }));
      const before = heap();

      const result = await read({ kind: 'package', fileName: 'elements.pkg', path });

      expect(result).toMatchObject({ ok: false, expected: true });
      expect(heap() - before).toBeLessThan(LIMIT);
    });
  });
});
