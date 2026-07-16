// Bundles the browser-side webview code (+ mermaid, html-to-image) -> media/webview.js
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    outfile: 'media/webview.js',
    loader: { '.css': 'text' }
  });
  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching webview...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
