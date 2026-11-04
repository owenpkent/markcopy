// Transpiles src/ and fuzz/targets/ to CommonJS under out/fuzz/, one output file
// per input file (no bundling). Jazzer.js instruments by file path, so keeping
// src/ as separate files lets it instrument only our code and leave
// node_modules alone. Source maps point stack traces back at the .ts files.
const esbuild = require('esbuild');
const { globSync } = require('node:fs');

// src/webview/ holds browser code that needs a DOM, so only the modules a
// target imports are built: pure helpers, and the paste converter, which the
// target runs under jsdom.
const pureWebview = [
  'gifInfo',
  'imageInfo',
  'stlInfo',
  'videoInfo',
  'links',
  'markdownConvert',
].map((n) => `src/webview/${n}.ts`);

const entryPoints = [
  ...globSync('src/**/*.ts', { exclude: (name) => name === 'webview' }),
  ...pureWebview,
  ...globSync('fuzz/targets/*.ts'),
].filter((f) => !f.endsWith('.d.ts'));

esbuild
  .build({
    entryPoints,
    outdir: 'out/fuzz',
    outbase: '.',
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: 'linked',
    sourcesContent: false,
    logLevel: 'warning',
  })
  .catch(() => process.exit(1));
