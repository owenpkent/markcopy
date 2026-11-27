// Rebuilds the seed corpus for the pe and pkg fuzz targets from the unit tests'
// fixture builders (fuzz/seeds.ts), so no binary of unknown origin is committed.
// The script owns fuzz/corpus/pe/, pkg/, file-source/, polyglot/ and key-encodings/: it empties them and
// rewrites them, so a seed it no longer makes does not linger. The output is
// deterministic; a rerun gives identical bytes.
//
// Usage: node scripts/make-fuzz-seeds.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const corpus = path.join(root, 'fuzz', 'corpus');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markcopy-seeds-'));
  const bundle = path.join(tmp, 'seeds.cjs');
  try {
    await esbuild.build({
      entryPoints: [path.join(root, 'fuzz', 'seeds.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode'],
      logLevel: 'error',
    });
    for (const dir of ['pe', 'pkg', 'file-source', 'polyglot', 'key-encodings']) {
      fs.rmSync(path.join(corpus, dir), { recursive: true, force: true });
    }
    const env = { ...process.env };
    delete env.FUZZ_PKG_FORMAT;
    execFileSync(process.execPath, [bundle, corpus], { stdio: 'inherit', env });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
