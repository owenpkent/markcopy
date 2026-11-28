// @vitest-environment node
// The coverage report must never delete what is already in --out, and a parser with
// no build output must not read as covered. Every directory here is a fresh
// mkdtemp under the OS temp directory; nothing touches the repo.
// See docs/FUZZING-STRATEGY.md ("Coverage manifest").
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface Row {
  file: string;
  covered: number;
  total: number;
  percent: number;
  min: number;
  missing: boolean;
  below: boolean;
}
interface Report {
  prepareOutput(outDir: string): string;
  writeReport(outDir: string, markdown: string, data: unknown): void;
  scoreParser(
    file: string,
    entry: { targets: string[]; minLineCoverage: number },
    perTarget: Map<string, Map<string, unknown[]>>,
    repoRoot?: string,
  ): Row;
  reachedByTargets(repoRoot?: string): Set<string>;
}

const report = createRequire(__filename)('../fuzz/coverage-report.js') as Report;
const fuzzBuild = createRequire(__filename)('../fuzz/build.js') as {
  build(root?: string): Promise<void>;
};
const made: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'markcopy-covtest-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fuzz coverage report output', () => {
  it('keeps the other contents of an existing output directory', () => {
    const out = path.join(freshDir(), 'reports');
    mkdirSync(path.join(out, 'nested'), { recursive: true });
    writeFileSync(path.join(out, 'sentinel.txt'), 'keep me');
    writeFileSync(path.join(out, 'nested', 'deep.txt'), 'keep me too');
    writeFileSync(path.join(out, 'fuzz-coverage.md'), 'stale');

    report.prepareOutput(out);
    report.writeReport(out, 'new report\n', { rows: [] });

    expect(readFileSync(path.join(out, 'sentinel.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(path.join(out, 'nested', 'deep.txt'), 'utf8')).toBe('keep me too');
    expect(readFileSync(path.join(out, 'fuzz-coverage.md'), 'utf8')).toBe('new report\n');
    expect(JSON.parse(readFileSync(path.join(out, 'fuzz-coverage.json'), 'utf8'))).toEqual({
      rows: [],
    });
  });

  it('creates a missing output directory, parents included', () => {
    const out = path.join(freshDir(), 'a', 'b');
    report.prepareOutput(out);
    expect(existsSync(out)).toBe(true);
  });
});

describe('fuzz coverage of a parser with no build output', () => {
  it('is flagged and below a positive minimum, never 100%', () => {
    const repo = freshDir();
    const row = report.scoreParser(
      'src/pkg/gone.ts',
      { targets: ['pkg-gone'], minLineCoverage: 70 },
      new Map(),
      repo,
    );
    expect(row.missing).toBe(true);
    expect(row.below).toBe(true);
    expect(row.percent).toBe(0);
    expect(row.total).toBe(0);
  });

  it('is flagged even with a minimum of 0', () => {
    const row = report.scoreParser(
      'src/pkg/gone.ts',
      { targets: ['pkg-gone'], minLineCoverage: 0 },
      new Map(),
      freshDir(),
    );
    expect(row.missing).toBe(true);
    expect(row.below).toBe(true);
  });

  it('is flagged when only an earlier build left its output behind', () => {
    // Two reports in a row over the same out/fuzz/, as on a developer's machine:
    // the parser is built the first time, then loses its last fuzz import. esbuild
    // leaves the old .js and .js.map in place; only reached.json says what this
    // build emitted.
    const repo = freshDir();
    const file = 'src/pkg/kept.ts';
    const out = path.join(repo, 'out/fuzz/src/pkg');
    mkdirSync(out, { recursive: true });
    mkdirSync(path.join(repo, 'src/pkg'), { recursive: true });
    writeFileSync(path.join(repo, file), 'export const x = 1;\n');
    writeFileSync(path.join(out, 'kept.js'), 'exports.x = 1;\n');
    // One segment: built line 1, column 0, is source 0, line 1, column 0.
    writeFileSync(
      path.join(out, 'kept.js.map'),
      JSON.stringify({ version: 3, sources: ['../../../../src/pkg/kept.ts'], mappings: 'AAAA' }),
    );
    const entry = { targets: ['pkg-kept'], minLineCoverage: 0 };
    const built = path.join(repo, 'out/fuzz/reached.json');

    writeFileSync(built, JSON.stringify([file]));
    const first = report.scoreParser(file, entry, new Map(), repo);
    expect(first).toMatchObject({ covered: 0, total: 1, missing: false, below: false });

    writeFileSync(built, JSON.stringify(['src/pkg/other.ts']));
    const second = report.scoreParser(file, entry, new Map(), repo);
    expect(second).toMatchObject({ covered: 0, total: 0, missing: true, below: true });
  });

  it('is flagged when the build left no record of what it emitted', () => {
    const repo = freshDir();
    const out = path.join(repo, 'out/fuzz/src/pkg');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'kept.js.map'), '{}');
    const row = report.scoreParser(
      'src/pkg/kept.ts',
      { targets: ['pkg-kept'], minLineCoverage: 0 },
      new Map(),
      repo,
    );
    expect(row.missing).toBe(true);
    expect(report.reachedByTargets(repo).size).toBe(0);
  });

  it('is flagged when its only importer is a helper that no fuzz target uses', async () => {
    // The real build, over a small tree: one runnable target that reaches one
    // parser, and a support module in fuzz/targets/ that nothing imports and
    // that is the only importer of a second parser.
    const repo = freshDir();
    mkdirSync(path.join(repo, 'fuzz/targets'), { recursive: true });
    mkdirSync(path.join(repo, 'src/pkg'), { recursive: true });
    writeFileSync(path.join(repo, 'src/pkg/used.ts'), 'export const used = (): number => 1;\n');
    writeFileSync(path.join(repo, 'src/pkg/orphan.ts'), 'export const orphan = (): number => 2;\n');
    writeFileSync(
      path.join(repo, 'fuzz/targets/one.fuzz.ts'),
      "import { used } from '../../src/pkg/used';\nexport const fuzz = (): number => used();\n",
    );
    writeFileSync(
      path.join(repo, 'fuzz/targets/helper.ts'),
      "import { orphan } from '../../src/pkg/orphan';\nexport const help = (): number => orphan();\n",
    );

    await fuzzBuild.build(repo);

    // The helper and what it imports are still compiled, as support modules are.
    expect(existsSync(path.join(repo, 'out/fuzz/src/pkg/orphan.js.map'))).toBe(true);
    expect([...report.reachedByTargets(repo)].sort()).toEqual([
      'fuzz/targets/one.fuzz.ts',
      'src/pkg/used.ts',
    ]);
    const entry = { targets: ['one'], minLineCoverage: 0 };
    expect(report.scoreParser('src/pkg/used.ts', entry, new Map(), repo).missing).toBe(false);
    const orphan = report.scoreParser('src/pkg/orphan.ts', entry, new Map(), repo);
    expect(orphan).toMatchObject({ total: 0, missing: true, below: true });

    // Once a runnable target uses the helper, the same parser is scored.
    writeFileSync(
      path.join(repo, 'fuzz/targets/one.fuzz.ts'),
      "import { help } from './helper';\nexport const fuzz = (): number => help();\n",
    );
    await fuzzBuild.build(repo);
    expect(report.scoreParser('src/pkg/orphan.ts', entry, new Map(), repo).missing).toBe(false);
    // And the parser the target dropped is now the one that is missing, with its
    // output from the first build still on disk.
    expect(existsSync(path.join(repo, 'out/fuzz/src/pkg/used.js.map'))).toBe(true);
    expect(report.scoreParser('src/pkg/used.ts', entry, new Map(), repo).missing).toBe(true);
  });
});
