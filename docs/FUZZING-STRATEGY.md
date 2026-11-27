# Fuzzing and unit-test strategy

**Status: P0 to P2 done and P3 partly done, 2026-11-23 (see [Status](#status)).** Written after the executable (#252), package (#253) and
isolated-reader (#254) merges and the 3D format merges (#245 to #249) added more
hostile-input parsing than everything before them. It records what was measured, what
mature projects do for the same formats, and the order the work is done in. The
binary readers (`src/pe/`, `src/pkg/`, `src/binary/` and the worker that runs them)
come first. [TESTING](TESTING.md#fuzzing) says how to run the targets;
[FUZZING-PRIOR-ART](FUZZING-PRIOR-ART.md) is the earlier VLC and GIMP study this builds
on. Update the measurements here when they are re-taken, with the date.

## What can go wrong

Every reader here is TypeScript, so out-of-bounds writes and use-after-free, the
dominant bug class in C parsers, do not occur. What a hostile file can still do:

| Failure                  | What it costs                                                       | Example in this repo                                                   |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Unbounded allocation     | The worker (or, before #254, the extension host) runs out of memory | The 642-byte package that took the host to 4 GB (SECURITY.md)          |
| Unbounded time           | A preview that never finishes; a stalled host before #254           | Caps that multiply (pages times entries times members)                 |
| Escaped exception        | A generic "reader failed" page instead of a message                 | `RangeError` from a `DataView` past the buffer                         |
| Wrong or misleading page | The page says something the file did not, or shows engine text      | `function Object() { [native code] }` (found 2026-11-23, below)        |
| Markup or URL injection  | Script or a link in the webview                                     | Mitigated by escaping and CSP; asserted by `markdown-html` and `links` |
| Path or command reach    | A file read or a process started from a name in the file            | OBJ `mtllib` names (host reads `.mtl` files), ffmpeg and LaTeX paths   |

A memory-safe language moves the weight from crashes to resource cost and output
correctness, so a fuzz target that only reports exceptions misses most of what can
go wrong. Google's guidance on fuzz targets asks for determinism, speed, small memory
and no global state ([good-fuzz-target](https://github.com/google/fuzzing/blob/master/docs/good-fuzz-target.md));
the Trail of Bits handbook lists invariants, differential testing and round trips as
oracles beside crashes ([appsec.guide](https://appsec.guide/docs/fuzzing/)). Both
point the same way: decide what a correct answer looks like and check it.

## Baseline, measured 2026-11-23

**Nightly status.** The `3mf` target has failed every night since 2026-11-22, the first
run after the parts tree (#246) merged. It never ran an input: `src/webview/threeMf.ts`
now imports `./parts`, and `fuzz/build.js` builds only a hand-kept list of webview
files, which does not include it, so the built target throws `Cannot find module
'./parts'` at load. No issue was opened because the report job files one only when a
crash input exists. Three nights of a red job went unnoticed.

**Fuzz reach.** Bundling each target with esbuild and listing the `src/` files in its
metafile shows which modules no target reaches. Leaving out the UI-only webview files
(menus, panels, players), these parse or shape untrusted input and no target reaches
them:

| Area           | Unreached                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Binary readers | `src/binary/file.ts` (file-backed ranged reads), `src/fileInfoTask.ts`, `src/isolate.ts`         |
| 3D             | `src/webview/glb.ts`, `obj.ts`, `step.ts`, `modelSniff.ts` (OBJ `mtllib` names, header sniffing) |
| Audio          | `src/audioProbe.ts` (ffprobe JSON with every tag in the file)                                    |
| Other          | `src/webview/pdfRecolour.ts`, `src/review/*` beyond the YAML parser, `src/stlSiblings.ts`        |

`pe` and `pkg` reach their readers, but with no seed corpus and no dictionary each
starts every night from bytes with a header written over them.

**Unit coverage.** `vitest --coverage` (v8) over `src/`: 88.6% of lines and 83.3% of
branches overall. The new binary readers are well tested by line and weaker by branch,
and the missed branches are mostly the guards a hostile file is meant to hit:

| Module                  | Lines | Branches | Missed branches are mostly                              |
| ----------------------- | ----- | -------- | ------------------------------------------------------- |
| `src/pkg/xar.ts`        | 95.6  | 85.0     | zlib header checks, TOC attribute fallbacks             |
| `src/pkg/rpm.ts`        | 95.9  | 88.7     | string-scan budget, PGP subpacket length forms          |
| `src/pkg/decompress.ts` | 94.6  | 89.5     | zstd frame count, skippable frames, block-size refusals |
| `src/pkg/msi.ts`        | 97.1  | 90.0     | summary property types, code pages                      |
| `src/pkg/axml.ts`       | 93.3  | 90.9     | string-pool and chunk bounds                            |
| `src/pkg/zipRange.ts`   | 96.9  | 92.0     | DER walk in signature files                             |
| `src/pe/signer.ts`      | 95.8  | 89.3     | certificate fields absent or malformed                  |
| `src/isolate.ts`        | 89.3  | 66.7     | a worker that cannot start, an `error` that is not OOM  |
| `src/webview/glb.ts`    | 90.9  | 76.3     | accessor and buffer-view bounds, sparse accessors       |

Two `findFfmpeg` tests in `tests/videoProxy.test.ts` fail on a machine with ffmpeg on
`PATH`, and `tests/binary/text.test.ts`'s timing test times out under coverage
instrumentation. Neither is a product bug; both are listed under the plan.

**Oracle gaps.**

- The `pkg` target's memory check reads `process.memoryUsage().heapUsed`, which does
  not count `ArrayBuffer` backing stores, and every `Uint8Array` a decompressor or a
  table reader allocates lives there. The worker's `maxOldGenerationSizeMb` has the
  same blind spot (`src/isolate.ts` says so). A typed-array blow-up passes both and is
  stopped only by libFuzzer's `-rss_limit_mb=2048`.
- The `pe` target has no cost checks at all, and was not rerun after the icon reader
  was added.
- No target checks the rendered page beyond its size.

**Found while measuring.** Several lookup tables in the binary renderers are plain
objects indexed by text from the file, so a file can name a member of
`Object.prototype`. An executable whose manifest requests `level="constructor"`
renders as `constructor (function Object() { [native code] })`, and an MSI whose
summary template is `constructor;1033` shows its platform as `function Object() {
[native code] }` (`__proto__` gives `[object Object]`). The text is escaped, so this is
not injection, but the page states something the file did not. The same pattern is in
`deb.ts` (`COMPRESSION[suffix]`), `alpine.ts` (`SCRIPTS[name]`) and the AXML attribute
objects (`axml.ts`, where an attribute named `__proto__` is silently dropped). No
target found it because nothing throws.

## What mature projects do for these formats

From the OSS-Fuzz build scripts and project pages (fetched 2026-11-23):

- **One target per format, plus a catch-all.** assimp builds 15 harnesses: a generic
  importer, a round trip (import, then export to every format), post-processing with a
  fuzz-chosen set of steps, and one per format including OBJ, glTF, GLB and 3MF
  ([assimp build.sh](https://raw.githubusercontent.com/google/oss-fuzz/master/projects/assimp/build.sh)).
  yara builds each file in `tests/oss-fuzz/` as its own binary with its own corpus and
  dictionary ([yara build.sh](https://raw.githubusercontent.com/google/oss-fuzz/master/projects/yara/build.sh)).
  elfutils has three targets over libelf and libdwfl
  ([elfutils build.sh](https://raw.githubusercontent.com/google/oss-fuzz/master/projects/elfutils/build.sh)).
  VLC does the same with one binary per demuxer (see FUZZING-PRIOR-ART).
- **One harness for an archive family works only with good seeds.** libarchive fuzzes
  every format through one harness with no dictionary, and makes up for it with its
  test-suite files and the whole corkami `pocs` collection as seeds
  ([libarchive build.sh](https://raw.githubusercontent.com/google/oss-fuzz/master/projects/libarchive/build.sh)).
  MarkCopy's `pkg` target is in the same position without the seeds.
- **Seeds are small, individual files, kept with the target, and crash inputs are
  added back** ([OSS-Fuzz ideal integration](https://google.github.io/oss-fuzz/advanced-topics/ideal-integration/)).
- **Structure-aware fuzzing when checksums or lengths gate the parser**
  ([structure-aware-fuzzing](https://github.com/google/fuzzing/blob/master/docs/structure-aware-fuzzing.md)).
  Jazzer.js has no custom-mutator hook (none documented; the research pass found none),
  so structure goes in the harness: write the magic and fixed fields, and let
  `FuzzedDataProvider` (in `@jazzer.js/core`) choose counts, offsets and sizes.

The bug classes in those projects' advisories that carry over to TypeScript:

- **Count times stride against the buffer.** In C this overflows; in JavaScript it does
  not wrap but yields a huge count that drives a loop or an allocation. glTF accessors,
  ELF and PE tables, MSI and CFB sector tables all have the shape.
- **Sector and chain tables.** libgsf's OLE reader had an integer overflow in the
  sector allocation table and unvalidated sector sizes (CVE-2024-42415,
  [TALOS-2024-2069](https://talosintelligence.com/vulnerability_reports/TALOS-2024-2069)).
  The TypeScript forms are a FAT chain that loops and a declared sector count far above
  the file; `src/pkg/cfb.ts` caps both, and the fuzzer should be pointed at them.
- **XML tables of contents.** libarchive's xar reader over-read on a crafted TOC
  (CVE-2017-14166, [NVD](https://nvd.nist.gov/vuln/detail/CVE-2017-14166)). For MarkCopy
  the risks are entity expansion and depth, which `src/binary/xml.ts` bounds.
- **Names that become paths.** Apktool wrote outside its output folder from `../` in a
  resources string pool (reported as CVE-2026-39973,
  [NVD](https://nvd.nist.gov/vuln/detail/CVE-2026-39973); not verified independently).
  MarkCopy writes nothing from a package, but the OBJ preview does read files named by
  the file, so `mtlNameProblem` gets a property target.
- **Open CASCADE.** The research pass reported a 2026 batch of OCCT CVEs in its STEP,
  IGES, STL and OBJ readers (for example
  [CVE-2026-42481](https://osv.dev/vulnerability/CVE-2026-42481); not verified
  independently) and found no public fuzz harness for OCCT. MarkCopy runs it as
  WebAssembly in the 3D webview, so a fault costs the webview. That is the boundary
  relied on; MarkCopy fuzzes its own code around the engine, not the engine.

Jazzer.js itself is maintained: 4.0.0 was released on 2026-04-15 and the repository was
last pushed on 2026-11-09 (checked through the GitHub API). It ships five bug
detectors, all on by default: command injection, path traversal, prototype pollution,
remote code execution (`eval` and `Function`) and SSRF
([bug-detectors](https://github.com/CodeIntelligenceTesting/jazzer.js/blob/main/docs/bug-detectors.md)).
`--mode=regression` replays a corpus once without mutating
([fuzz-settings](https://github.com/CodeIntelligenceTesting/jazzer.js/blob/main/docs/fuzz-settings.md)).

## Principles

1. **A target is only as good as its oracle.** Every binary target checks, per input:
   the documented error class or a result; time; JavaScript heap _plus_ array buffers;
   page size; and the page's content (no engine text such as `[native code]`,
   `[object Object]`, `undefined` or `NaN` where a value belongs, and only the markup
   the renderer emits).
2. **Differential where two paths exist.** The worker reads a file through
   `fileSource` (short reads, a real handle); the targets read through `bytesSource`.
   The same bytes through both, and through a source that answers in random short
   pieces, must give the same page. Reading the same input twice must too
   (determinism, no state kept between files).
3. **Per format, plus the catch-all.** A target whose first gate is a magic number
   spends most of a night failing it. The `pkg` target gets per-format variants, as
   `image` has (`pkg-elf`, `pkg-rpm`, ...), each seeded with that format's files. The
   catch-all stays, because routing is itself code under test.
4. **Seeds come from the fixture builders.** The unit tests already build every package
   and executable shape in code (`tests/pkg/*Fixture.ts`, `tests/pe/fixture.ts`). A
   script writes small seeds from them, so the corpus is reproducible, licence-free and
   never a binary of unknown origin. Real files from public test suites can be added
   later, licence checked, under the size caps in TESTING.
5. **Dictionaries per format**: magics, tag numbers, section and table names, XML
   element names, and the prototype names (`constructor`, `__proto__`) that found the
   bug above.
6. **The harness is tested on every pull request.** `npm test` loads every built target
   and replays its committed seeds, so a target that cannot load fails CI the day it
   breaks, not three nights later. The nightly report also opens an issue when a target
   fails without a crash input.
7. **A finding becomes three things**: the fix, a unit test with the input, and the
   input in the seed corpus.

## Plan

Ordered by risk; each step lands with its tests and its measurement.

### P0. Harness integrity

- `fuzz/build.js` derives the files to build from each target's imports (an esbuild
  metafile pass) instead of a hand-kept list. Fixes `3mf` and every future import.
- `tests/fuzzTargets.test.ts`: builds the targets once, loads each, and replays every
  file in its `fuzz/corpus/<name>/` through it.
- `fuzz.yml`: the report job opens or updates `Fuzz target broken: <target>` when a job
  fails with no crash input.

### P1. Binary readers (executables, packages, worker)

- Cost oracle for `pe`; both targets count `arrayBuffers` and `external` with the heap.
- Page oracle for both: the content checks in principle 1.
- Fix the prototype-name lookups (`Object.hasOwn` or a `Map`) in `pe/render.ts`,
  `msi.ts`, `deb.ts`, `alpine.ts`, and build AXML attributes on `Object.create(null)`;
  unit tests with `constructor` and `__proto__` for each.
- Per-format `pkg-<format>` variants in `fuzz/run.js` and the nightly matrix.
- `scripts/make-fuzz-seeds.ts` writes seeds for `pe` and every `pkg` format from the
  fixture builders; seeds committed under the TESTING caps.
- Dictionaries `fuzz/dict/pe.dict` and `fuzz/dict/pkg.dict`.
- `file-source` differential target: `bytesSource` against a short-read file source
  and against a second read, over the `pkg` and `pe` shapes.
- Unit tests for the guard branches listed in the coverage table (zstd frame limits,
  xar zlib header, rpm string budget and PGP lengths, msi property types, axml pool
  bounds, isolate start failure and non-OOM errors).

### P2. 3D readers

- `glb` target (`readGlb`, async): output arrays agree in length, triangle count at
  most the cap, every part range inside the model.
- `obj` target: `readObj` with `parseMtl` over MTL text taken from the same input,
  same invariants; `mtlNameProblem` property: an accepted name has no separator, no
  `..`, no colon, no leading dot and no control character.
- `step` target: `readStep` with a stand-in engine whose result is built from the
  input by `FuzzedDataProvider` (meshes, indices outside the vertex range, face color
  ranges, a node tree with cycles and depth). This fuzzes MarkCopy's handling of what
  the engine returns, not OCCT.

### P3. Everything else unreached

- `audio-probe` target over `shapeAudioProbe` (tag text, lengths, numbers), beside
  `video-probe`.
- `stlSiblings`, `pdfRecolour`'s operator filter, and the review timeline as small
  property targets when time allows.
- Make the `findFfmpeg` tests independent of the machine's `PATH`, and give the
  `printable` timing test a budget that survives coverage instrumentation.

## Status

Done on 2026-11-23: all of P0, P1 and P2; from P3, the `audio-probe` target and both
flaky tests (`findFfmpeg` now uses a platform whose only candidate is probed on
`PATH`; the `printable` timing test passes in a normal run and times out only under
coverage instrumentation, so it was left alone). Still open from P3: `stlSiblings`,
`pdfRecolour` and the review timeline. Also open: branch coverage of `glb.ts` (79%),
`zipRange.ts` and `pe/signer.ts`, and a merge of the new evolved corpora on Linux
once a few nightlies have run.

What the work found, each now fixed with a unit test and its input kept as a seed:

| Found by                                 | What                                                                                                  | Reachable from a real file?                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Measuring (the page oracle's motivation) | Lookup tables keyed by file text reached `Object.prototype` (PE execution level, MSI platform)        | Yes                                                  |
| Measuring                                | The `3mf` target had not loaded for three nights; no issue was opened                                 | n/a (harness)                                        |
| Measuring                                | `heapUsed` alone hid array-buffer growth from the `pkg` cost check                                    | n/a (harness)                                        |
| `glb` target, within 20 s                | A JSON list that is not a list (`"scenes":[{"nodes":0}]`) threw a `TypeError` instead of a `GlbError` | Yes                                                  |
| `step` target                            | The assembly walk had no visit cap: a shared node is exponential, a cycle endless                     | Not known: the engine builds a fresh object per node |
| `audio-probe` target                     | A fractional channel count rounded to "0 channels"                                                    | No: ffprobe reports whole numbers                    |
| Writing `file-source`                    | The target itself first shaped package inputs wrongly; a planted short-read bug showed it was blind   | n/a (harness)                                        |

## Measurements, 2026-11-23

Linux, one core, local runs straight through Jazzer.js 4 (the nightly runs are 10
minutes each). `cov` and `ft` are libFuzzer's edge and feature counts at the end of the
run; one run each, so a difference of a few percent is noise.

| Run                                        | Time | Runs      | cov                    | ft                        | Findings  |
| ------------------------------------------ | ---- | --------- | ---------------------- | ------------------------- | --------- |
| `pe`, as before (no seeds, no dictionary)  | 60 s | 234,959   | 431                    | 991                       | 0         |
| `pe`, 14 seeds and `pe.dict`               | 60 s | 178,345   | 846                    | 2158                      | 0         |
| `pkg`, as before (no seeds, no dictionary) | 60 s | 301,677   | 564                    | 966                       | 0         |
| `pkg`, 27 seeds and `pkg.dict`             | 60 s | 164,772   | 3156                   | 7233                      | 0         |
| `file-source`, 41 seeds                    | 30 s | 37,979    | 3445                   | 6065                      | 0         |
| `pkg-elf` / `rpm` / `deb` / `msi`          | 30 s | 65k-123k  | 486 / 557 / 541 / 820  | 1163 / 1637 / 1411 / 2397 | 0         |
| `pkg-xar` / `zip` / `alpine` / `dmg`       | 30 s | 110k-140k | 576 / 1132 / 407 / 381 | 1361 / 2558 / 1112 / 741  | 0         |
| `glb`                                      | 30 s | 198,363   | 479                    | 1018                      | 1 (fixed) |
| `obj`                                      | 30 s | 378,069   | 404                    | 1820                      | 0         |
| `step`, million-visit cap                  | 30 s | 2,601     | 249                    | 999                       | 0         |
| `audio-probe`                              | 30 s | 279,624   | 130                    | 292                       | 1 (fixed) |

Seeds and dictionaries doubled `pe`'s reach and multiplied `pkg`'s by 5.6 in the same
time. A per-format variant's `cov` counts one reader and is not comparable with the
catch-all's, which counts all of them. `step` ran under 100 inputs a second because a
shared node made each input walk up to a million nodes; with the target's own cap of
20,000 (`maxNodeVisits`) the same 129 inputs replay in 68 ms instead of 2,108 ms.

Unit coverage after the guard tests (v8, whole suite, 3,676 tests): 88.8% of lines and
83.9% of branches overall (from 88.6 and 83.3). By branch: `decompress.ts` 89.5 to
99.1, `xar.ts` 85.0 to 97.2, `axml.ts` 90.9 to 98.5, `rpm.ts` 88.7 to 92.8, `msi.ts`
90.0 to 93.4, `step.ts` 90.8 to 93.4, `audioProbe.ts` 92.7 to 95.2; `isolate.ts` gained
the worker-start failures.

## Readers added after 2026-11-23, covered 2026-11-26

The binary readers that merged after the first fuzzing pass (Mach-O, Go build
information, DEX, the RPM payload check, stored digests, the Authenticode image hash,
signer detail, zip and Office encryption labels) were reached only by the general
`pe` and `pkg` targets, with seeds that did not hold them. Each now has seeds that
exercise it; five readers that sit behind a whole file whose structure does not
survive mutation also have a target of their own, which takes the reader's own input
directly. A focused target's first input byte picks the stage and the rest is the
input, so one corpus covers every stage.

| Reader                                                       | Reached by                                           | What the target or seeds do                                                                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mach-O and universal binaries (`macho.ts`)                   | `pkg-macho`                                          | Seeds with every load command the reader decodes, encrypted images, a wide fat header, and a Java class file that carries the fat magic. The universal shape keeps a plausible count.     |
| Go build information (`goBuildInfo.ts`)                      | `go-buildinfo`, and `pkg-elf` and `pe` seeds         | Stage 0 parses module text; stages 1 and 2 read a section, as written or with the magic and a pointer width written over its start. Caps on rows and settings, no control characters.     |
| DEX summary and digests (`dex.ts`)                           | `dex`, and `pkg-zip` seeds                           | The input is a `classes.dex` in a small stored or deflated zip (and a second file), read through `readPackage` with the shared oracle. Adler-32 is checked against a plain definition.    |
| RPM payload walker and streaming decompressors               | `cpio`, and `pkg-rpm` seeds with real stored digests | Stage 0 walks a cpio stream whole, in pieces of the input's choosing and byte by byte, and the names, finish flag and refusal must be identical. Stages 1 to 3 run gzip, zstd and xz.     |
| Stored digests (`storedDigest.ts`)                           | `pkg-rpm`, `pkg-alpine` and `pkg-zip` seeds          | Seeds whose digests match and whose digests do not.                                                                                                                                       |
| PE: Rich header, long section names, load config, image hash | `pe` seeds                                           | A Rich header, a COFF string table behind `/4` names, 32 and 64-bit load configurations, and signed images whose digest is right, wrong, SHA-1 or SHA-256.                                |
| Signer detail DER, APK signing block v2 and v3 (`signer.ts`) | `signer`, and `pe` and `pkg-zip` seeds               | Stage 0 PKCS #7, 1 a bare certificate, 2 and 3 the signing block value. Nothing may throw; the signer count is capped, a thumbprint is 40 hex digits, no field holds a control character. |
| ELF extended counts, GNU property notes, Go notes            | `pkg-elf` seeds                                      | `PN_XNUM` and `SHT_NULL` counts, x86 and Arm property notes, a property that runs past its note, the Go build ID.                                                                         |
| Zip encryption labels                                        | `pkg-zip` seeds                                      | WinZip AE-1 and AE-2 fields, ZipCrypto, and strong encryption.                                                                                                                            |
| Office `EncryptionInfo` (`ooxml/encrypted.ts`)               | `ooxml-encrypted`                                    | Stage 0 the stream (agile, standard, extensible), stage 1 a whole compound file. The notice is one short line without control characters, and a refusal always comes with a notice.       |

The first run of `ooxml-encrypted` found, in 2 seconds, an agile description whose
`cipherAlgorithm` held a control character, which reached the message the preview shows.
`describeEncryptionInfo` now runs the attribute values through `printable`; the input is a
seed and the unit test is in `tests/ooxmlEncrypted.test.ts`. The first run of `signer` stopped
on its own oracle (a `Signer` field present but undefined), which was a bug in the target.

Smoke runs, 2026-11-26, Windows, one process, 25 s each, straight through Jazzer.js
(the nightly runs are 10 minutes). One run each; no findings after the fix above.

| Target            | Runs    | cov  | ft   |
| ----------------- | ------- | ---- | ---- |
| `cpio`            | 293,904 | 230  | 838  |
| `dex`             | 105,322 | 300  | 396  |
| `go-buildinfo`    | 196,130 | 338  | 1320 |
| `signer`          | 359,204 | 410  | 1042 |
| `ooxml-encrypted` | 99,968  | 246  | 591  |
| `pkg-macho`       | 133,899 | 563  | 1233 |
| `pkg-elf`         | 115,506 | 756  | 1809 |
| `pkg-rpm`         | 65,034  | 878  | 2407 |
| `pkg-zip`         | 88,886  | 1529 | 3416 |
| `pe`              | 70,747  | 1437 | 3052 |

Dictionaries: `pkg.dict` and `pe.dict` gained the Mach-O magics and load command ids, the Go
magic and module text keys, the DEX magics, cpio magics and `TRAILER!!!`, WinZip AES fields,
the APK signing block ids, and the ELF property note markers; each focused target has a
dictionary of its own.

## Measuring progress

Re-take, with the date, after each step: the unreached table (the esbuild metafile
pass), branch coverage of the binary modules, and per-target `cov`/`ft` and runs per
second from a 60 s local run on Linux (merge does not record coverage on Windows, see
TESTING). A step is done when its targets run clean for a nightly, their seeds are
committed, and the numbers here are updated.
