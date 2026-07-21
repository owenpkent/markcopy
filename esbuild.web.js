// Bundles the browser-side webview code. Three outputs:
//   media/webview.js     markdown preview (esm module, code-split chunks)
//   media/pdf.js         PDF preview (esm, <script type="module">)
//   media/pdf.worker.js  pdf.js worker (esm module worker)
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// KaTeX renders client-side in the webview, so its stylesheet and fonts must be
// served from `media/`. The CSS references fonts by relative `fonts/...` URLs, so
// keep the same layout (media/katex/katex.min.css + media/katex/fonts/*).
function copyKatexAssets() {
  const src = path.join(__dirname, 'node_modules', 'katex', 'dist');
  const dest = path.join(__dirname, 'media', 'katex');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(src, 'katex.min.css'), path.join(dest, 'katex.min.css'));
  fs.cpSync(path.join(src, 'fonts'), path.join(dest, 'fonts'), { recursive: true });
}

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
  copyKatexAssets();
  await Promise.all([
    // Markdown preview: ES module with code splitting so mermaid, katex,
    // html-to-image, and turndown load lazily as separate media/chunk-*.js files
    // instead of bloating the initial media/webview.js.
    run({
      ...shared,
      entryPoints: [{ in: 'src/webview/main.ts', out: 'webview' }],
      format: 'esm',
      splitting: true,
      outdir: 'media',
      chunkNames: 'chunk-[name]-[hash]',
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
