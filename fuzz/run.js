// Runs one Jazzer.js target: node fuzz/run.js <target> [seconds]
// Minimizes a corpus: node fuzz/run.js merge <target> [corpus-dir]  (npm run fuzz:merge)
// `image-<format>` (png, jpeg, webp, bmp, ico, avif, svg) runs the image target with
// FUZZ_IMAGE_FORMAT=<format>, so its inputs reach that format's header parser. Its
// corpus is fuzz/.corpus/image-<format>/, seeded from the files in fuzz/corpus/image/
// whose extension is that format's (.jpg and .jpeg for jpeg).
// A dictionary at fuzz/dict/<target>.dict, when present, is passed with -dict.
// The time budget also comes from FUZZ_SECONDS (default 60). The evolved corpus
// lives in fuzz/.corpus/<target>/ (untracked) and is seeded from the committed
// fuzz/corpus/<target>/; crashing inputs land in fuzz/crashes/<target>/.
const { spawnSync } = require('node:child_process');
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} = require('node:fs');
const path = require('node:path');

const merge = process.argv[2] === 'merge';
const args = merge ? process.argv.slice(3) : process.argv.slice(2);
const requested = args[0];
const variant = /^image-(png|jpeg|webp|bmp|ico|avif|svg)$/.exec(requested ?? '')?.[1];
const target = variant ? 'image' : requested;
const seconds = merge ? 1 : Number(args[1] ?? process.env.FUZZ_SECONDS ?? 60);
const root = path.resolve(__dirname, '..');
const targetFile = path.join(root, 'out/fuzz/fuzz/targets', `${target}.fuzz.js`);
if (!target || !existsSync(path.join(root, 'fuzz/targets', `${target}.fuzz.ts`))) {
  console.error(
    'usage: node fuzz/run.js [merge] <target> [seconds|corpus-dir]; targets are fuzz/targets/*.fuzz.ts',
  );
  process.exit(2);
}
// Whole seconds, at least one: libFuzzer reads -max_total_time=0 as no limit
// at all, so a fractional budget rounded down would run forever.
if (!Number.isInteger(seconds) || seconds < 1) {
  console.error(
    `invalid time budget: ${args[1] ?? process.env.FUZZ_SECONDS} (whole seconds, at least 1)`,
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

const evolved = path.join(root, 'fuzz/.corpus', requested);
// An async target (paste-export awaits a lazy import) must not run in sync mode:
// Jazzer.js would drop its promises unawaited and memory would grow without end.
const targetSource = readFileSync(path.join(root, 'fuzz/targets', `${target}.fuzz.ts`), 'utf8');
const isAsync = /export\s+async\s+function\s+fuzz\b/.test(targetSource);
if (merge) {
  // libFuzzer -merge=1 copies into the FIRST directory only the inputs that add
  // coverage over the rest, so the result is a fresh minimized corpus in
  // fuzz/.corpus-min/<target>/ (untracked). The inputs are the committed seeds
  // and the evolved corpus, or the directory given as the last argument (for
  // example a cached nightly corpus downloaded and unpacked).
  const fresh = path.join(root, 'fuzz/.corpus-min', target);
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  const inputs = args[1]
    ? [path.resolve(args[1])]
    : [path.join(root, 'fuzz/corpus', target), evolved].filter((d) => existsSync(d));
  const jazzerCli = require.resolve('@jazzer.js/core/dist/cli.js');
  const mergeRun = spawnSync(
    process.execPath,
    [
      jazzerCli,
      targetFile,
      fresh,
      ...inputs,
      ...(isAsync ? [] : ['--sync']),
      '--timeout=10000',
      '--includes',
      path.join('out', 'fuzz', 'src') + path.sep,
      '--includes',
      path.join('out', 'fuzz', 'fuzz') + path.sep,
      '--',
      '-merge=1',
      '-rss_limit_mb=2048',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (mergeRun.status === 0 && readdirSync(fresh).length === 0) {
    // Measured on Windows with Jazzer.js 4: the merge runs, but libFuzzer records
    // no coverage features for any input, so it keeps nothing. Do not trust an
    // empty result; run the merge on Linux (the CI runners, or a container).
    console.error(
      `merge kept no inputs for ${target}: either the corpus adds no coverage or this platform does not report it`,
    );
    process.exit(3);
  }
  process.exit(mergeRun.status ?? 1);
}
const crashes = path.join(root, 'fuzz/crashes', requested);
mkdirSync(evolved, { recursive: true });
mkdirSync(crashes, { recursive: true });
const seeds = path.join(root, 'fuzz/corpus', target);
if (existsSync(seeds)) {
  const wanted = variant === 'jpeg' ? ['.jpg', '.jpeg'] : [`.${variant}`];
  cpSync(seeds, evolved, {
    recursive: true,
    force: false,
    filter: (src) => !variant || statSync(src).isDirectory() || wanted.includes(path.extname(src)),
  });
}

// Run from the crash directory's parent so libFuzzer's crash-<hash> files land
// in a predictable place: -artifact_prefix sets it explicitly.
// A target whose harness leaks (DOMPurify under jsdom holds on to every
// document it parses) declares `export const SESSION_SECONDS = <n>`, and its
// budget is spent in fresh processes of at most that length. They share the
// evolved corpus, so coverage carries from one session to the next.
const sessionMatch = /export\s+const\s+SESSION_SECONDS\s*=\s*(\d+)/.exec(targetSource);
const sessionSeconds = sessionMatch ? Number(sessionMatch[1]) : seconds;
// A dictionary of format tokens (fuzz/dict/<target>.dict, libFuzzer syntax) lets
// the mutator splice in keywords and magic numbers it would take far longer to
// invent byte by byte. Optional: a target without one runs as before.
const dictFile = path.join(root, 'fuzz/dict', `${target}.dict`);
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
      ...(existsSync(dictFile) ? [`-dict=${dictFile}`] : []),
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: variant ? { ...process.env, FUZZ_IMAGE_FORMAT: variant } : process.env,
    },
  );

for (let left = seconds; left > 0; left -= sessionSeconds) {
  const result = runSession(Math.min(left, sessionSeconds));
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
