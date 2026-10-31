# Security and fuzzing in VLC and GIMP: prior art for MarkCopy

**Status: research note, 2026-10-30.** Two mature desktop projects that parse untrusted
files all day, read for what they do about it and what MarkCopy can borrow. Every claim
with a source is cited inline; claims that could not be confirmed say so. MarkCopy's own
setup is described in [SECURITY](../.github/SECURITY.md) and
[TESTING](TESTING.md#fuzzing) and is summarized at the end for the comparison.

## VLC (VideoLAN)

**Reporting and advisories.** The security page gives a security contact address at
videolan.org, welcomes signed mail, and asks for responsible disclosure. It states no
embargo window, no CVE process and no bounty
([videolan.org/security](https://www.videolan.org/security/)). Advisories come in two
shapes: a Security Bulletin per release, which can cover many issues, and standalone
Security Advisories for single bugs. Recent bulletins cite most issues by GitLab issue
number rather than CVE; the 3.0.22 bulletin (December 2025) lists one CVE against about
twenty issues
([SB-VLC3022](https://www.videolan.org/security/sb-vlc3022.html)). VideoLAN does not
issue advisories for third-party libraries. Fixes ship in point releases and the
bulletin is tied to the release. The stated mitigation is the same every time: do not
open untrusted files, and ASLR and DEP "help reduce the likeliness of code execution,
but may be bypassed" ([SB-VLC309](https://images.videolan.org/security/sb-vlc309.html)).

**Bug bounty.** The EU-FOSSA programme ran a VLC bounty on HackerOne. Jean-Baptiste
Kempf attributed the unusually large security content of VLC 3.0.7 (33 fixes, two
critical) to it ([BetaNews](https://betanews.com/2019/06/11/vlc-3-0-7-security-fixes/)).
Payout totals differ between press sources and the launch date is reported
inconsistently, so neither is recorded here.

**Fuzzing.** VLC is in OSS-Fuzz
([projects/vlc](https://github.com/google/oss-fuzz/tree/master/projects/vlc)) with
libFuzzer, AFL++ and honggfuzz under ASan and UBSan. The integration was discussed on
vlc-devel in April 2021
([thread](https://mailman.videolan.org/pipermail/vlc-devel/2021-April/143177.html)); the
acceptance date was not confirmed. The in-tree harness is one driver, `vlc-demux-run.c`,
built four ways: with and without decoders, and as a standalone runner or a libFuzzer
target ([test/Makefile.am](https://raw.githubusercontent.com/videolan/vlc/master/test/Makefile.am)).
The first version was added in 2017 and ran under AFL or libFuzzer
([commit](https://mailman.videolan.org/pipermail/vlc-commits/2017-September/043146.html)).
Three design points stand out:

- **One binary per format, chosen by name.** The harness selects the demuxer or decoder
  from `argv[0]`, so OSS-Fuzz builds one copy per format
  (`vlc-demux-dec-libfuzzer-mp4` and so on). A February 2025 change made this work with
  renamed binaries so no wrapper script is needed
  ([commit](https://mailman.videolan.org/pipermail/vlc-commits/2025-February/071123.html)).
  The OSTIF audit counted 27 fuzzers: 26 per format and one catch-all.
- **Corpus and dictionaries live in their own repository**
  ([vlc-fuzz-corpus](https://code.videolan.org/VideoLAN.org/vlc-fuzz-corpus)). The
  presence of a dictionary such as `mp4.dict` is what makes OSS-Fuzz generate that
  format's fuzzer. Some seeds are generated at build time by a script (TS, PS, HEIF and
  others) rather than committed
  ([build.sh](https://raw.githubusercontent.com/google/oss-fuzz/master/projects/vlc/build.sh)).
- **Asserts off, dependencies partly instrumented.** The ASan build defines `NDEBUG` so
  an assert does not stop the fuzzer before the deeper code. FFmpeg is linked
  uninstrumented, while many smaller codec libraries are instrumented.

The Trail of Bits audit for OSTIF (February to March 2025) found stub seeds, oversized
seeds and thin dictionaries in that corpus, and recommended and wrote harnesses for
code that had none: the CSS parser, JSON, URL parsing and SAT>IP
([report](https://ostif.org/wp-content/uploads/2026/04/OSTIF-libVLC-Report-2-1.pdf)).
The 3.0.22 bulletin credits OSS-Fuzz for out-of-bounds reads in the ty, CVD, Ogg, NSV,
SRT and MJPEG modules, unbounded recursion in WebVTT, and an invalid free in ASF.

**Architecture.** Modules run in the player's process. No sandboxing on any platform was
found, nor any documented contributor policy on parsing untrusted input, nor evidence of
fuzzing in VLC's own CI beyond OSS-Fuzz. The audit also flagged supply-chain gaps:
Docker images pinned by tag, non-HTTPS contrib downloads, manual dependency management,
and a self-update path with HTTP lookups and weak hashes. The dominant bug class in the
bulletins is out-of-bounds reads and writes in demuxers, decoders and subtitle parsers.

## GIMP

**Reporting and advisories.** GNOME's policy is a form at security.gnome.org or a
confidential GitLab issue, after which the maintainer notifies the GNOME security team
([Discourse](https://discourse.gnome.org/t/reminder-please-report-security-issues-to-gnome-security/25605)).
An archived 2022 gimp.org page named a `security` mail alias; no current page was
found, gimp.org/security returns 404, and the repository has no `SECURITY.md`. GIMP
publishes no advisories of its own. Disclosure happens through ZDI and CVE records, the
`NEWS` file ("Vulnerabilities fixed: ZDI-CAN-..."), and distribution trackers.

**Fix cadence.** The 2023 DDS, PSD and PSP batch (CVE-2023-44441 to 44444) shipped in
2.10.36 on 2023-11-07, described on oss-security as "fixed immediately"
([oss-sec](https://seclists.org/oss-sec/2023/q4/227)). The XWD integer overflow
CVE-2025-2760 was reported to the vendor on 2025-01-22, fixed in 3.0.0 on 2025-03-16 and
published 2025-04-07, about eleven weeks
([ZDI-25-203](https://www.zerodayinitiative.com/advisories/ZDI-25-203/)). The 2.10 line
got those fixes later by distribution backport (Debian DLA-4342-1 for XWD, FLI and ICO).
ZDI advisories against GIMP loaders were still being published in 2026 (PSP, APNG), and
the 3.2 to 3.3 development notes list a dozen ZDI-CAN fixes across TIFF, PSD, SGI, PNG,
PSP, PAA, PVR and ILBM.

**Fuzzing.** GIMP, GEGL and babl are not in OSS-Fuzz (checked against
`google/oss-fuzz/projects`), and the tree has no fuzz targets or fuzzing CI job; `app/tests`
holds unit tests and CI runs the Tartan static analyser. Hanno Böck reported in 2017
that GIMP was "not fuzzing friendly" and that the importers looked unmaintained, after
his own fuzzing found FLI, TGA, XCF, GBR and PSP bugs (CVE-2017-17785, CVE-2017-17789)
([oss-sec](https://seclists.org/oss-sec/2017/q4/425),
[openwall](https://www.openwall.com/lists/oss-security/2017/12/19/5)). Ricerca Security
fuzzed GEGL with AFL for about two weeks and found 134 unique crashes
([write-up](https://ricercasecurity.blogspot.com/2023/07/fuzzing-farm-1-fuzzing-gegl-with-fuzzuf.html)).
So fuzzing of GIMP's own loaders has been external only. The libraries GIMP delegates
to for the common formats (libpng, libjpeg-turbo, libtiff, libwebp, openjpeg, libheif,
libavif) are all in OSS-Fuzz; the hand-written plug-ins for the long tail (PSD, DDS,
PSP, XWD, FLI, ICO and others) are not, and that is exactly where the advisories land.

**Architecture.** File loaders are separate plug-in executables that talk to the core
over a wire protocol. The developer docs say this makes GIMP robust against crashes but
that it "currently doesn't have any sandboxing ability" and plug-ins have the same
rights as the GIMP process (seen in a mirror of `devel-docs/README.md`, not confirmed
against current upstream). A crash in a loader does not take down GIMP; a compromised
loader runs as the user. The only sandbox is Flatpak's whole-app one. Nothing in GIMP
3's plug-in model adds isolation.

**Bug classes** in the advisories, which are the lessons for any header parser:

- integer overflow before allocation (XWD, CVE-2025-2760; PSP, CVE-2023-44443);
- heap overflow from unvalidated lengths and dimensions (DDS, CVE-2023-44441; PSD,
  CVE-2023-44442; DCM, CVE-2025-10922);
- off-by-one (PSP, CVE-2023-44444);
- out-of-bounds write from unvalidated input (FLI, CVE-2025-2761 and CVE-2017-17785);
- unsigned underflow (PSD, CVE-2026-59090, listed as unresolved in one tracker);
- zero width or height crashing a loader
  ([issue 475](https://gitlab.gnome.org/GNOME/gimp/issues/475)).

## Side by side

| Question                     | VLC                                  | GIMP                                    | MarkCopy today                                            |
| ---------------------------- | ------------------------------------ | --------------------------------------- | --------------------------------------------------------- |
| Private reporting channel    | Yes, mail                            | GNOME form or confidential issue        | Yes, contact form in SECURITY.md                          |
| Own advisories               | Bulletins and advisories per release | None; ZDI, CVE, NEWS                    | Changelog "Security" subsection per release               |
| CVE assignment               | Inconsistent, mostly issue numbers   | Via ZDI and distributions               | None                                                      |
| Continuous fuzzing           | OSS-Fuzz, 27 targets, three engines  | None in-tree; libraries fuzzed upstream | Nightly Jazzer.js, 16 targets, 60 min each, corpus cached |
| Per-format targets           | Yes, one binary per format           | n/a                                     | Mostly per parser; `image` is one catch-all over formats  |
| Dictionaries                 | Yes, per format, in corpus repo      | n/a                                     | No                                                        |
| Seed corpus                  | Separate repo, partly generated      | n/a                                     | 166 KB committed, hand-built headers                      |
| Where untrusted parsing runs | In the player process                | Plug-in process, user privileges        | Extension host (zip, Office, CSV); webview (image, GIF)   |
| Memory-safety bug class      | Dominant                             | Dominant                                | Absent (TypeScript); analogs are hangs, blowups, throws   |
| Static analysis in CI        | Recommended by audit, not confirmed  | Tartan                                  | ESLint, strict TypeScript; no CodeQL                      |

## What MarkCopy should take from this

The two big lessons are not about tooling. First, **the bugs land in the hand-written
long tail**, not in the well-trodden decoders: GIMP's advisories are all in its own
plug-ins while libpng and friends sit in OSS-Fuzz, and VLC's are in demuxers and
subtitle parsers rather than FFmpeg. MarkCopy's position is the GIMP one, done right:
the image and GIF viewers read only headers and hand pixel decoding to Chromium, which
is fuzzed upstream. The place to keep the attention is the hand-written parsers
(`imageInfo`, `gifInfo`, `stlInfo`, the OOXML readers, CSV, the review YAML), and the
rule already in [IMAGE-DESIGN](IMAGE-DESIGN.md), bound every read and never allocate
proportional to a declared size, is the TypeScript form of GIMP's missing overflow
checks.

Second, **process isolation is not a sandbox**. GIMP's plug-in processes keep the
application up but run as the user; VLC has neither. MarkCopy's webview parsers sit
behind the VS Code webview sandbox and a CSP, which is strictly better than both. Its
host-side parsers (zip, workbook, deck, Word, CSV) run in the extension host, which is
VLC's position, but in a memory-safe language, so the realistic failure is denial of
service: an unbounded loop, an allocation blow-up, a regular expression that
backtracks, or an exception that escapes to the message handler. The fuzz targets
should keep treating a timeout or an RSS limit hit as a finding, which `fuzz/run.js`
already does with `-timeout` and `-rss_limit_mb`.

Concrete, cheap improvements, in the order worth doing them:

1. **Dictionaries per target** ([#158](https://github.com/owenpkent/markcopy/issues/158)). Jazzer.js passes libFuzzer flags through, and
   `-dict=` with box names, chunk types, XML element names and CSV delimiters is the
   single biggest coverage win VLC's setup has and MarkCopy's lacks. The Trail of Bits
   finding that thin dictionaries hold OSS-Fuzz back applies in reverse here.
2. **Real seeds, minimized** ([#159](https://github.com/owenpkent/markcopy/issues/159)). The committed corpora are hand-built headers, which is
   the "stub seeds" finding from the VLC audit. Add a few real small files per format
   (an actual camera JPEG with EXIF, a real AVIF, a real PSD-exported PNG) and run
   `-merge=1` occasionally so the cached corpus does not grow with redundant inputs.
3. **Split `image` by format** ([#160](https://github.com/owenpkent/markcopy/issues/160)). Like VLC's one binary per demuxer, a target per
   sniffed format (or an environment variable the one target reads) lets the fuzzer
   spend its hour inside one parser instead of mostly failing the magic-byte check.
4. **Request CVEs through GitHub** ([#161](https://github.com/owenpkent/markcopy/issues/161)). GitHub is a CVE Numbering Authority; enabling
   private vulnerability reporting and publishing a GitHub Security Advisory for each
   fixed issue costs nothing and gives distributors and users something to track, which
   is the gap both VLC (issue numbers instead of CVEs) and GIMP (no advisories) show.
   The changelog's Security subsection stays as the human-readable record.
5. **CodeQL on the default branch** ([#162](https://github.com/owenpkent/markcopy/issues/162)). It is free for public repositories, covers
   JavaScript and TypeScript, and is the automated analysis gate the VLC audit asked for
   and GIMP added with Tartan.
6. **Pin by digest, fetch over HTTPS** ([#163](https://github.com/owenpkent/markcopy/issues/163)). The audit's supply-chain findings against VLC
   prompted a check of MarkCopy's own workflows: every action in `ci.yml` and
   `fuzz.yml` is already pinned by commit SHA, so nothing to do here beyond keeping it
   that way when Dependabot bumps them.

## Not confirmed

VLC: the OSS-Fuzz acceptance date, who assigns VLC's CVEs, any fuzzing in VLC's own CI,
Coverity use, and any contributor policy on untrusted input (the VideoLAN GitLab blocked
automated fetches). GIMP: a current official reporting page, the exact 3.0.x release for
most 2025 and 2026 ZDI items, any statement from current maintainers on fuzzing, and
Flatpak permissions. Bounty payout figures for EU-FOSSA differ between press sources and
are omitted.
