// @vitest-environment node
// fuzz/run.js hands a variant's environment to every Jazzer child it starts,
// a merge included, so `fuzz:merge -- pkg-msi` minimizes against msi shapes.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nodeRequire = createRequire(import.meta.url);
const runJs = join(__dirname, '../fuzz/run.js');

interface Call {
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

/** Paths run.js tried to delete, create or copy into; none of them reach the disk. */
let writes: string[] = [];

function runWith(argv: string[]): Call[] {
  const cp = nodeRequire('node:child_process');
  const fs = nodeRequire('node:fs');
  // run.js clears fuzz/.corpus-min/<target>/ before a merge and seeds
  // fuzz/.corpus/ before a run, in the real checkout. Stub every write so a
  // test never deletes a minimized corpus someone kept.
  writes = [];
  for (const name of ['rmSync', 'mkdirSync', 'cpSync']) {
    vi.spyOn(fs, name).mockImplementation(((target: string, dest?: unknown) => {
      writes.push(typeof dest === 'string' ? dest : target);
    }) as never);
  }
  const readdirSync = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: string, ...rest: unknown[]) =>
    String(dir).includes('.corpus-min') ? ['kept'] : readdirSync(dir, ...rest)) as never);
  const calls: Call[] = [];
  vi.spyOn(cp, 'spawnSync').mockImplementation(((_cmd: string, args: string[], opts: any) => {
    calls.push({ args, env: opts?.env });
    return { status: 0 };
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', runJs, ...argv]);
  delete nodeRequire.cache[runJs];
  try {
    nodeRequire(runJs);
  } catch (err) {
    if ((err as Error).message !== 'exit') {
      throw err;
    }
  }
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FUZZ_PKG_FORMAT;
});

describe('fuzz/run.js', () => {
  it('gives a package-variant merge the same format variable as a run', () => {
    const calls = runWith(['merge', 'pkg-msi']);
    const merge = calls.find((c) => c.args.includes('-merge=1'));
    expect(merge?.env?.FUZZ_PKG_FORMAT).toBe('msi');
    expect(writes.some((p) => p.replace(/\\/g, '/').endsWith('fuzz/.corpus-min/pkg'))).toBe(true);
  });

  it('leaves the format variable unset for the catch-all merge', () => {
    const merge = runWith(['merge', 'pkg']).find((c) => c.args.includes('-merge=1'));
    expect(merge).toBeDefined();
    expect(merge?.env?.FUZZ_PKG_FORMAT).toBeUndefined();
  });

  it('gives a package-variant run the format variable too', () => {
    const run = runWith(['pkg-rpm', '1']).find((c) =>
      c.args.some((a) => a.startsWith('-max_total')),
    );
    expect(run?.env?.FUZZ_PKG_FORMAT).toBe('rpm');
  });
});
