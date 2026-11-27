// Line coverage of the parser modules from a replay of the committed fuzz seeds:
//   node fuzz/coverage-report.js [--out <dir>]        (npm run fuzz:coverage)
// Replays every target named in fuzz/coverage.json in its own process with
// NODE_V8_COVERAGE set, maps V8's ranges on the built files in out/fuzz/ back to
// the .ts sources through the source maps esbuild writes, and compares each
// parser's line coverage, unioned over its listed targets, with its
// minLineCoverage. Writes <dir>/fuzz-coverage.md and <dir>/fuzz-coverage.json
// (default fuzz/coverage-report/), and the markdown to $GITHUB_STEP_SUMMARY when set.
//
// What the number is, and is not:
//  - It is the committed seeds replayed once, with no mutation and no evolved
//    corpus, so it is a floor on what the nightly fuzzer reaches.
//  - A variant target (pkg-rpm, image-png, ...) is replayed as its catch-all
//    (pkg, image), which reads every seed of every format.
//  - A source line counts as covered when the first token of any built line that
//    maps to it ran. That is V8 block coverage seen through a source map, so it
//    is close to, but not identical with, what c8 reports on the .ts files.
//  - Lines the build removes (types, comments) are not counted. A file with no
//    executable lines is reported as having none and passes.
// Exit status: 0 when the report was written (a file below threshold is not an
// error here; the workflow turns it into an issue), 1 when a replay failed.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// A source map's `mappings`: [generatedLine][segments] of
// {col, source, line}, decoded from base64 VLQ.
function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  let origLine = 0;
  for (const text of mappings.split(';')) {
    let genCol = 0;
    const segments = [];
    for (const seg of text.split(',')) {
      if (seg === '') continue;
      const fields = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >> 1) : value >> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += fields[0];
      if (fields.length >= 4) {
        source += fields[1];
        origLine += fields[2];
        segments.push({ col: genCol, source, line: origLine });
      }
    }
    lines.push(segments);
  }
  return lines;
}

// The executable lines of a built file, as [{offset, sourceLine}] where offset
// is the character offset of the line's first token and sourceLine is the
// 1-based line of the source file it maps to.
function builtLines(jsFile, sourcePath) {
  const code = fs.readFileSync(jsFile, 'utf8');
  const map = JSON.parse(fs.readFileSync(`${jsFile}.map`, 'utf8'));
  const mapped = decodeMappings(map.mappings);
  const own = map.sources.findIndex(
    (s) => path.resolve(path.dirname(`${jsFile}.map`), s) === sourcePath,
  );
  const out = [];
  let offset = 0;
  code.split('\n').forEach((text, index) => {
    const first = text.search(/\S/);
    const start = offset;
    offset += text.length + 1;
    // Blank lines and lines of closing punctuation are not statements.
    if (first === -1 || /^[\s\]})[{(,;]*$/.test(text)) return;
    const segments = mapped[index] ?? [];
    let hit;
    for (const seg of segments) {
      if (seg.col <= first && seg.source === own) hit = seg;
    }
    hit ??= segments.find((s) => s.source === own);
    if (hit) out.push({ offset: start + first, sourceLine: hit.line + 1 });
  });
  return { lines: out, length: code.length };
}

// The count V8 recorded at every character offset of one script: the innermost
// range that contains it.
function countsByOffset(functions, length) {
  const ranges = [];
  for (const fn of functions) {
    for (const r of fn.ranges) ranges.push(r);
  }
  ranges.sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
  const counts = new Int32Array(length + 1).fill(-1);
  for (const r of ranges) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, length + 1));
  return counts;
}

function readCoverage(dir) {
  // URL -> functions, merged over the files one process writes.
  const scripts = new Map();
  if (!fs.existsSync(dir)) return scripts;
  for (const name of fs.readdirSync(dir)) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const script of data.result ?? []) {
      scripts.set(script.url, [...(scripts.get(script.url) ?? []), ...script.functions]);
    }
  }
  return scripts;
}

// The replay target for a manifest target: variants read the catch-all's seeds.
function replayName(target) {
  return target.replace(/^(image|pkg)-.+$/, '$1');
}

function main() {
  const args = process.argv.slice(2);
  const outDir = path.resolve(root, args[args.indexOf('--out') + 1] || 'fuzz/coverage-report');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'fuzz/coverage.json'), 'utf8'));
  const parsers = manifest.parsers;

  const targets = [
    ...new Set(Object.values(parsers).flatMap((p) => p.targets.map(replayName))),
  ].sort();
  const raw = path.join(outDir, 'v8');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(raw, { recursive: true });

  // Build once; each replay then skips its own build.
  const build = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const failed = [];
  const perTarget = new Map();
  for (const target of targets) {
    const dir = path.join(raw, target);
    const run = spawnSync(process.execPath, [path.join(__dirname, 'replay.js'), target], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: dir, FUZZ_REPLAY_NO_BUILD: '1' },
    });
    if (run.status !== 0) {
      failed.push(
        `${target}: ${(run.stderr || run.stdout).trim().split('\n').slice(0, 6).join(' | ')}`,
      );
    }
    perTarget.set(target, readCoverage(dir));
  }

  const rows = [];
  for (const [file, entry] of Object.entries(parsers).sort()) {
    const jsFile = path.join(root, 'out/fuzz', file.replace(/\.ts$/, '.js'));
    let total = 0;
    const covered = new Set();
    const byTarget = {};
    if (fs.existsSync(`${jsFile}.map`)) {
      const built = builtLines(jsFile, path.join(root, file));
      const universe = built.lines;
      total = new Set(universe.map((l) => l.sourceLine)).size;
      const url = pathToFileURL(jsFile).href;
      for (const target of entry.targets.map(replayName)) {
        const functions = perTarget.get(target)?.get(url);
        if (!functions) continue;
        const counts = countsByOffset(functions, built.length);
        const own = new Set();
        for (const l of universe) {
          if (counts[l.offset] > 0) {
            covered.add(l.sourceLine);
            own.add(l.sourceLine);
          }
        }
        byTarget[target] = total === 0 ? 100 : Math.round((1000 * own.size) / total) / 10;
      }
    }
    const percent = total === 0 ? 100 : (100 * covered.size) / total;
    rows.push({
      file,
      targets: entry.targets,
      covered: covered.size,
      total,
      percent: Math.round(percent * 10) / 10,
      byTarget,
      min: entry.minLineCoverage,
      below: percent < entry.minLineCoverage,
    });
  }

  const below = rows.filter((r) => r.below);
  const lines = [
    '## Fuzz coverage of the parsers',
    '',
    `Line coverage of the committed seeds replayed through ${targets.length} targets (no mutation, no evolved corpus), unioned over the targets each parser lists in \`fuzz/coverage.json\`. ${rows.length} parsers, ${below.length} below threshold.`,
    '',
    '| Parser | Targets | Lines | Coverage | Minimum | |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...rows.map(
      (r) =>
        `| \`${r.file}\` | ${r.targets.join(', ')} | ${r.covered}/${r.total} | ${r.percent}% | ${r.min}% | ${r.below ? 'below' : 'ok'} |`,
    ),
  ];
  if (failed.length > 0) {
    lines.push('', 'Replays that failed:', ...failed.map((f) => `- ${f}`));
  }
  const markdown = `${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(outDir, 'fuzz-coverage.md'), markdown);
  fs.writeFileSync(
    path.join(outDir, 'fuzz-coverage.json'),
    JSON.stringify({ rows, below: below.map((r) => r.file), failed }, null, 2),
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  console.log(markdown);
  fs.rmSync(raw, { recursive: true, force: true });
  if (failed.length > 0) process.exit(1);
}

module.exports = { decodeMappings, replayName };

if (require.main === module) main();
