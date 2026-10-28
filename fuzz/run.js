// Runs one Jazzer.js target: node fuzz/run.js <target> [seconds]
// The time budget also comes from FUZZ_SECONDS (default 60). The evolved corpus
// lives in fuzz/.corpus/<target>/ (untracked) and is seeded from the committed
// fuzz/corpus/<target>/; crashing inputs land in fuzz/crashes/<target>/.
const { spawnSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
const seconds = Number(process.argv[3] ?? process.env.FUZZ_SECONDS ?? 60);
const root = path.resolve(__dirname, '..');
const targetFile = path.join(root, 'out/fuzz/fuzz/targets', `${target}.fuzz.js`);
if (!target || !existsSync(path.join(root, 'fuzz/targets', `${target}.fuzz.ts`))) {
  console.error('usage: node fuzz/run.js <target> [seconds]; targets are fuzz/targets/*.fuzz.ts');
  process.exit(2);
}
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error(`invalid time budget: ${process.argv[3] ?? process.env.FUZZ_SECONDS}`);
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
const jazzer = require.resolve('@jazzer.js/core/dist/cli.js');
const result = spawnSync(
  process.execPath,
  [
    jazzer,
    targetFile,
    evolved,
    '--sync',
    '--includes',
    path.join('out', 'fuzz', 'src') + path.sep,
    '--includes',
    path.join('out', 'fuzz', 'fuzz') + path.sep,
    '--',
    `-max_total_time=${Math.floor(seconds)}`,
    '-timeout=10',
    '-rss_limit_mb=2048',
    `-artifact_prefix=${crashes}${path.sep}`,
  ],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
