// Replays every committed seed through its built target once: node fuzz/replay.js [target...]
// (npm run fuzz:replay). No mutation and no Jazzer.js: each target module is
// loaded from out/fuzz/ exactly as the fuzzer loads it, and every file in
// fuzz/corpus/<target>/ is passed to its fuzz function. A target that cannot
// load, or a seed that makes one throw, fails the run. tests/fuzzTargets.test.ts
// runs this on every pull request, so a broken target is caught the day it
// breaks rather than by the nightly run.
//
// A target that takes variants (image-<format>, pkg-<format>) is replayed in
// its catch-all form only; the variants read the same seeds.
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { build } = require('./build');

const root = path.resolve(__dirname, '..');

function seedsOf(target) {
  const dir = path.join(root, 'fuzz/corpus', target);
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const file = path.join(d, name);
      if (statSync(file).isDirectory()) {
        walk(file);
      } else {
        out.push(file);
      }
    }
  };
  walk(dir);
  return out;
}

async function replay(names) {
  process.chdir(root);
  // The coverage report builds once and replays each target in its own process.
  if (!process.env.FUZZ_REPLAY_NO_BUILD) {
    await build();
  }
  const all = readdirSync(path.join(root, 'fuzz/targets'))
    .filter((f) => f.endsWith('.fuzz.ts'))
    .map((f) => f.replace(/\.fuzz\.ts$/, ''))
    .sort();
  const targets = names.length > 0 ? names : all;
  const failures = [];
  const summary = [];
  for (const target of targets) {
    if (!all.includes(target)) {
      failures.push(`${target}: no such target`);
      continue;
    }
    let mod;
    try {
      mod = require(path.join(root, 'out/fuzz/fuzz/targets', `${target}.fuzz.js`));
    } catch (err) {
      failures.push(`${target}: does not load: ${err && err.message}`);
      continue;
    }
    if (typeof mod.fuzz !== 'function') {
      failures.push(`${target}: exports no fuzz function`);
      continue;
    }
    const seeds = seedsOf(target);
    let failed = 0;
    for (const seed of seeds) {
      try {
        await mod.fuzz(readFileSync(seed));
      } catch (err) {
        failed++;
        failures.push(
          `${target}: ${path.relative(root, seed)}: ${(err && err.stack) || String(err)}`,
        );
      }
    }
    summary.push(`${target}: ${seeds.length} seeds${failed ? `, ${failed} failed` : ''}`);
  }
  return { failures, summary };
}

module.exports = { replay, seedsOf };

if (require.main === module) {
  replay(process.argv.slice(2)).then(
    ({ failures, summary }) => {
      console.log(summary.join('\n'));
      if (failures.length > 0) {
        console.error(`\n${failures.length} failure(s):\n${failures.join('\n\n')}`);
        process.exit(1);
      }
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
