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
// esbuild leaves the output of earlier builds in out/fuzz/, so a file there
// may belong to a source no target reaches any more. Each build therefore
// writes out/fuzz/built.json, the sources it built this time, and the coverage
// report scores only those.
const esbuild = require('esbuild');
const { globSync, writeFileSync } = require('node:fs');

const targets = globSync('fuzz/targets/*.ts').filter((f) => !f.endsWith('.d.ts'));

async function reachedSources() {
  const result = await esbuild.build({
    entryPoints: targets,
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

async function build() {
  const entryPoints = [...new Set([...(await reachedSources()), ...targets])];
  await esbuild.build({
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
  const built = entryPoints.map((f) => f.replace(/\\/g, '/')).sort();
  writeFileSync('out/fuzz/built.json', `${JSON.stringify(built, null, 2)}\n`);
}

module.exports = { build, reachedSources };

if (require.main === module) {
  build().catch(() => process.exit(1));
}
