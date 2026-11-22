// Bundles the browser-side webview code. Eight outputs:
//   media/webview.js     markdown preview (esm module, code-split chunks)
//   media/pdf.js         PDF preview (esm, <script type="module">)
//   media/pdf.worker.js  pdf.js worker (esm module worker)
//   media/stl.js         3D preview: STL, 3MF, GLB, STEP, OBJ (esm, bundles Three.js
//                        and the STEP engine's JS glue)
//   media/video.js       video preview (esm)
//   media/gif.js         GIF preview (esm)
//   media/image.js       image preview (esm)
//   media/audio.js       audio preview (esm)
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { patchOcctGlue } = require('./scripts/occt-no-eval');

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

// Code splitting names each chunk by content hash (`chunk-[name]-[hash]`), so a
// rebuild writes new files beside the old ones instead of over them. Clear the
// previous build's chunks first: `vsce package` ships everything in `media/`, and
// leftovers grew the 0.13.0 VSIX to 865 files, where a clean 0.14.0 build is 185.
// Only these gitignored names are removed; a watch session still accumulates
// chunks until the next full build.
function removeStaleChunks() {
  const dir = path.join(__dirname, 'media');
  for (const name of fs.readdirSync(dir)) {
    if (/^chunk-.+\.js(\.map)?$/.test(name)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

// The STEP engine (occt-import-js, Open CASCADE compiled to WebAssembly) is
// 7.6 MB raw, so it ships gzipped (about 3 MB) as its own file beside the
// bundles: media/occt-import-js.wasm.gz, fetched and inflated only when a STEP
// file opens (src/webview/step.ts). It stays a separate, replaceable file, not
// inlined into a bundle, because the engine is LGPL-2.1; its two license files
// sit next to it. The raw .wasm is never copied, so the VSIX never holds it.
function copyStepEngine() {
  const src = path.join(__dirname, 'node_modules', 'occt-import-js', 'dist');
  const dest = path.join(__dirname, 'media');
  const gz = zlib.gzipSync(fs.readFileSync(path.join(src, 'occt-import-js.wasm')), { level: 9 });
  fs.writeFileSync(path.join(dest, 'occt-import-js.wasm.gz'), gz);
  for (const name of ['license.occt-import-js.txt', 'license.occt.txt']) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
  }
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
  removeStaleChunks();
  copyKatexAssets();
  copyStepEngine();
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
    // STL preview: its own entry point rather than a chunk of the Markdown
    // bundle, so Three.js is only fetched when an .stl file is opened.
    run({
      ...shared,
      entryPoints: [{ in: 'src/webview/stl.ts', out: 'stl' }],
      format: 'esm',
      outdir: 'media',
      // occt-import-js's Emscripten glue requires fs, path and crypto, but only
      // on its Node code paths, which a webview never takes.
      alias: {
        fs: './src/webview/emptyModule.ts',
        path: './src/webview/emptyModule.ts',
        crypto: './src/webview/emptyModule.ts',
      },
      // The glue builds embind bindings with `new Function`, which the 3D
      // viewer's CSP refuses; swap in the eval-free form (scripts/occt-no-eval.js).
      plugins: [
        {
          name: 'occt-no-eval',
          setup(build) {
            build.onLoad({ filter: /occt-import-js[\\/]dist[\\/]occt-import-js\.js$/ }, (args) => ({
              contents: patchOcctGlue(fs.readFileSync(args.path, 'utf8')),
              loader: 'js',
            }));
          },
        },
      ],
    }),
    // Video preview: tiny (no media library, the <video> element does the
    // work), but its own entry point so it does not drag in the Markdown
    // preview's bundle just to show a player.
    run({
      ...shared,
      entryPoints: [{ in: 'src/webview/video.ts', out: 'video' }],
      format: 'esm',
      outdir: 'media',
    }),
    // GIF preview: small and self-contained like the video one (the browser's
    // ImageDecoder does the decoding), so it is its own entry point too.
    run({
      ...shared,
      entryPoints: [{ in: 'src/webview/gif.ts', out: 'gif' }],
      format: 'esm',
      outdir: 'media',
    }),
    // Image preview: the GIF viewer's sibling for still pictures and SVG, drawn
    // by a plain <img>, so it is its own entry point as well.
    run({
      ...shared,
      entryPoints: [{ in: 'src/webview/image.ts', out: 'image' }],
      format: 'esm',
      outdir: 'media',
    }),
    // Audio preview: the video viewer's sibling, driven by a plain <audio>
    // element, so it is its own entry point as well.
    run({
      ...shared,
      entryPoints: [{ in: 'src/webview/audio.ts', out: 'audio' }],
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
