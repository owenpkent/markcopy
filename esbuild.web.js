// Bundles the browser-side webview code. Three outputs:
//   media/webview.js     markdown preview (iife, classic <script>)
//   media/pdf.js         PDF preview (esm, <script type="module">)
//   media/pdf.worker.js  pdf.js worker (esm module worker)
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
};

async function run(options) {
  const ctx = await esbuild.context(options);
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

async function main() {
  await Promise.all([
    // Markdown preview: classic script, bundles mermaid + html-to-image.
    run({
      ...shared,
      entryPoints: ['src/webview/main.ts'],
      format: 'iife',
      outfile: 'media/webview.js',
      loader: { '.css': 'text' },
    }),
    // PDF preview + pdf.js worker: ES modules.
    run({
      ...shared,
      entryPoints: [
        { in: 'src/webview/pdf.ts', out: 'pdf' },
        { in: 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs', out: 'pdf.worker' },
      ],
      format: 'esm',
      outdir: 'media',
    }),
  ]);
  if (watch) {
    console.log('[esbuild] watching webview bundles...');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
