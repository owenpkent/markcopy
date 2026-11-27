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
}

const report = createRequire(__filename)('../fuzz/coverage-report.js') as Report;
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
});
