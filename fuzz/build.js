// Transpiles the fuzz targets, and every src/ file they import, to CommonJS
// under out/fuzz/, one output file per input file (no bundling). Jazzer.js
// instruments by file path, so keeping src/ as separate files lets it
// instrument only our code and leave node_modules alone. Source maps point
// stack traces back at the .ts files.
//
// The files to build are read from the targets' own imports (an esbuild
// metafile pass that writes nothing), not from a hand-kept list. A list went
// stale once: threeMf.ts began importing ./parts, the list did not have it,
// and the 3mf target failed to load every night until it was noticed.
// src/webview/ holds browser code that needs a DOM, so building only what a
// target reaches also keeps that code out.
//
// Every build also writes out/fuzz/reached.json: the sources a runnable target
// (a *.fuzz.ts file, which is all the fuzzer and the replay load) imports,
// directly or through other files, in this build. The coverage report scores
// only those, for two reasons. esbuild leaves the output of earlier builds in
// out/fuzz/, so a file there may belong to a source nothing reaches any more.
// And the build compiles every file in fuzz/targets/, support modules
// included, so a parser imported only by a helper that no target uses is
// compiled without ever being run.
const esbuild = require('esbuild');
const { globSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const slash = (f) => f.replace(/\\/g, '/');

/** Every .ts file in fuzz/targets/ under `root`: the runnable targets and their support modules. */
function targetFiles(root = process.cwd()) {
  return globSync('fuzz/targets/*.ts', { cwd: root })
    .filter((f) => !f.endsWith('.d.ts'))
    .map(slash);
}

/** The src/ files the `roots` import, directly or through other files. */
async function reachedSources(roots = targetFiles(), root = process.cwd()) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: roots,
    bundle: true,
    write: false,
    metafile: true,
    outdir: 'out/fuzz-graph',
    platform: 'node',
    packages: 'external',
    external: ['vscode'],
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs).filter(
    (f) => f.startsWith('src/') && f.endsWith('.ts') && !f.endsWith('.d.ts'),
  );
}

async function build(root = process.cwd()) {
  const targets = targetFiles(root);
  const entryPoints = [...new Set([...(await reachedSources(targets, root)), ...targets])];
  await esbuild.build({
    absWorkingDir: root,
    entryPoints,
    outdir: 'out/fuzz',
    outbase: '.',
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: 'linked',
    sourcesContent: false,
    logLevel: 'warning',
  });
  const runnable = targets.filter((f) => f.endsWith('.fuzz.ts'));
  const reached = [...new Set([...(await reachedSources(runnable, root)), ...runnable])].sort();
  mkdirSync(path.join(root, 'out/fuzz'), { recursive: true });
  writeFileSync(path.join(root, 'out/fuzz/reached.json'), `${JSON.stringify(reached, null, 2)}\n`);
}

module.exports = { build, reachedSources, targetFiles };

if (require.main === module) {
  build().catch(() => process.exit(1));
}
