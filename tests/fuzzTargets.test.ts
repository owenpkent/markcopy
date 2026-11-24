// @vitest-environment node
// Every fuzz target loads as the fuzzer loads it (built by fuzz/build.js to
// out/fuzz/) and runs clean over its committed seeds. The nightly fuzz run is
// not part of CI, so without this a target that stops loading is found only
// when someone reads a red nightly job: the 3mf target failed to load for three
// nights after src/webview/threeMf.ts gained an import the old build list
// lacked (docs/FUZZING-STRATEGY.md).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

describe('fuzz targets', () => {
  it('all load from the fuzz build and replay their seed corpus without a finding', () => {
    // A child process, so the targets load under plain Node as Jazzer.js runs
    // them, not under Vitest's transform and DOM.
    const run = spawnSync(process.execPath, [join(root, 'fuzz/replay.js')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    // stderr may carry esbuild warnings (import.meta in a module built as
    // CommonJS); a failure is a non-zero exit with "failure(s)" in it.
    expect(run.stderr, run.stdout).not.toMatch(/failure\(s\)/);
    expect(run.status, run.stderr).toBe(0);
    const targets = readdirSync(join(root, 'fuzz/targets')).filter((f) => f.endsWith('.fuzz.ts'));
    for (const file of targets) {
      expect(run.stdout).toContain(`${file.replace(/\.fuzz\.ts$/, '')}: `);
    }
  }, 150_000);
});
