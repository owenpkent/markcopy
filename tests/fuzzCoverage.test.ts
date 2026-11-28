// Fuzz coverage is a rule, not a habit: every parser module is mapped to the fuzz
// targets that reach it in fuzz/coverage.json, or says why it is not a parser.
// Pure file reads; nothing is fuzzed here. See docs/FUZZING-STRATEGY.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Manifest {
  folders: string[];
  parsers: Record<string, { targets: string[]; minLineCoverage: number }>;
  notParsers: Record<string, string>;
}

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(
  readFileSync(path.join(root, 'fuzz/coverage.json'), 'utf8'),
) as Manifest;
const GUIDE = 'See docs/FUZZING-STRATEGY.md ("Coverage manifest").';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, dir)).sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) {
      out.push(...tsFiles(rel));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}

// The matrix of the nightly workflow: `target: [a, b, ...]`, read as text so no
// YAML dependency is needed.
function workflowTargets(): string[] {
  const yml = readFileSync(path.join(root, '.github/workflows/fuzz.yml'), 'utf8');
  const match = /^\s*target:\s*\[([^\]]*)\]/m.exec(yml);
  if (!match) {
    throw new Error('no `target: [...]` list in .github/workflows/fuzz.yml');
  }
  return match[1]
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// The target files, as run.js names them.
const targetFiles = readdirSync(path.join(root, 'fuzz/targets'))
  .filter((f) => f.endsWith('.fuzz.ts'))
  .map((f) => f.replace(/\.fuzz\.ts$/, ''))
  .sort();

describe('fuzz coverage manifest', () => {
  it('lists every file in the parser folders as a parser or as not a parser', () => {
    const unlisted = manifest.folders
      .flatMap(tsFiles)
      .filter((f) => !(f in manifest.parsers) && !(f in manifest.notParsers));
    expect(
      unlisted,
      `Not in fuzz/coverage.json: ${unlisted.join(', ')}. Add each to "parsers" with the fuzz ` +
        'target(s) that reach it and a minLineCoverage (a fuzz target, seeds and dictionary ' +
        `tokens in the same PR), or to "notParsers" with a one-line reason. ${GUIDE}`,
    ).toEqual([]);
  });

  it('lists no file twice', () => {
    const both = Object.keys(manifest.parsers).filter((f) => f in manifest.notParsers);
    expect(both, `In both "parsers" and "notParsers": ${both.join(', ')}. ${GUIDE}`).toEqual([]);
  });

  it('names only files that exist', () => {
    const missing = [...Object.keys(manifest.parsers), ...Object.keys(manifest.notParsers)].filter(
      (f) => !existsSync(path.join(root, f)),
    );
    expect(
      missing,
      `Listed but missing (renamed or deleted?): ${missing.join(', ')}. ${GUIDE}`,
    ).toEqual([]);
  });

  it('gives every parser a target and a threshold, and every non-parser a reason', () => {
    for (const [file, entry] of Object.entries(manifest.parsers)) {
      expect(entry.targets.length, `${file} has no targets`).toBeGreaterThan(0);
      expect(
        Number.isFinite(entry.minLineCoverage) &&
          entry.minLineCoverage >= 0 &&
          entry.minLineCoverage <= 100,
        `${file}: minLineCoverage must be 0 to 100`,
      ).toBe(true);
    }
    for (const [file, reason] of Object.entries(manifest.notParsers)) {
      expect(reason.trim().length, `${file} has no reason`).toBeGreaterThan(10);
    }
  });

  it('names only fuzz targets that exist and run nightly', () => {
    const matrix = workflowTargets();
    const named = new Set(Object.values(manifest.parsers).flatMap((p) => p.targets));
    const unknown = [...named].filter((t) => !matrix.includes(t));
    expect(
      unknown,
      `Not in the fuzz.yml matrix: ${unknown.join(', ')}. A target in coverage.json needs ` +
        `fuzz/targets/<name>.fuzz.ts (or a variant of one) and a matrix entry. ${GUIDE}`,
    ).toEqual([]);
  });

  it('runs every fuzz target file in the nightly matrix', () => {
    const matrix = workflowTargets();
    const missing = targetFiles.filter((t) => !matrix.includes(t));
    expect(
      missing,
      `fuzz/targets has files the nightly matrix does not run: ${missing.join(', ')}`,
    ).toEqual([]);
    // Every matrix entry is a target file or a variant (image-png, pkg-rpm, ...) of one.
    const stray = matrix.filter(
      (t) => !targetFiles.includes(t) && !targetFiles.includes(t.split('-')[0]),
    );
    expect(stray, `Matrix entries with no target file: ${stray.join(', ')}`).toEqual([]);
  });
});
