// Runs one Jazzer.js target: node fuzz/run.js <target> [seconds]
// The time budget also comes from FUZZ_SECONDS (default 60). The evolved corpus
// lives in fuzz/.corpus/<target>/ (untracked) and is seeded from the committed
// fuzz/corpus/<target>/; crashing inputs land in fuzz/crashes/<target>/.
const { spawnSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
const seconds = Number(process.argv[3] ?? process.env.FUZZ_SECONDS ?? 60);
const root = path.resolve(__dirname, '..');
const targetFile = path.join(root, 'out/fuzz/fuzz/targets', `${target}.fuzz.js`);
if (!target || !existsSync(path.join(root, 'fuzz/targets', `${target}.fuzz.ts`))) {
  console.error('usage: node fuzz/run.js <target> [seconds]; targets are fuzz/targets/*.fuzz.ts');
  process.exit(2);
}
// Whole seconds, at least one: libFuzzer reads -max_total_time=0 as no limit
// at all, so a fractional budget rounded down would run forever.
if (!Number.isInteger(seconds) || seconds < 1) {
  console.error(
    `invalid time budget: ${process.argv[3] ?? process.env.FUZZ_SECONDS} (whole seconds, at least 1)`,
  );
  process.exit(2);
}

const build = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const evolved = path.join(root, 'fuzz/.corpus', target);
const crashes = path.join(root, 'fuzz/crashes', target);
mkdirSync(evolved, { recursive: true });
mkdirSync(crashes, { recursive: true });
const seeds = path.join(root, 'fuzz/corpus', target);
if (existsSync(seeds)) {
  cpSync(seeds, evolved, { recursive: true, force: false });
}

// Run from the crash directory's parent so libFuzzer's crash-<hash> files land
// in a predictable place: -artifact_prefix sets it explicitly.
// An async target (paste-export awaits a lazy import) must not run in sync mode:
// Jazzer.js would drop its promises unawaited and memory would grow without end.
const targetSource = readFileSync(path.join(root, 'fuzz/targets', `${target}.fuzz.ts`), 'utf8');
const isAsync = /export\s+async\s+function\s+fuzz\b/.test(targetSource);
// A target whose harness leaks (DOMPurify under jsdom holds on to every
// document it parses) declares `export const SESSION_SECONDS = <n>`, and its
// budget is spent in fresh processes of at most that length. They share the
// evolved corpus, so coverage carries from one session to the next.
const sessionMatch = /export\s+const\s+SESSION_SECONDS\s*=\s*(\d+)/.exec(targetSource);
const sessionSeconds = sessionMatch ? Number(sessionMatch[1]) : seconds;
const jazzer = require.resolve('@jazzer.js/core/dist/cli.js');
const runSession = (budget) =>
  spawnSync(
    process.execPath,
    [
      jazzer,
      targetFile,
      evolved,
      ...(isAsync ? [] : ['--sync']),
      // Per-input timeout. Jazzer hands libFuzzer its own -timeout from this
      // option (default 5 s), overriding one passed after `--`.
      '--timeout=10000',
      '--includes',
      path.join('out', 'fuzz', 'src') + path.sep,
      '--includes',
      path.join('out', 'fuzz', 'fuzz') + path.sep,
      '--',
      `-max_total_time=${budget}`,
      '-rss_limit_mb=2048',
      `-artifact_prefix=${crashes}${path.sep}`,
    ],
    { cwd: root, stdio: 'inherit' },
  );

for (let left = seconds; left > 0; left -= sessionSeconds) {
  const result = runSession(Math.min(left, sessionSeconds));
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
