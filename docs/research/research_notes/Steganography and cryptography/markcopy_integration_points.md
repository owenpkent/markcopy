# MarkCopy integration points for steganography detection and crypto features

All findings come from reading the repository at W:\dev\markcopy (main at 9630bc3, 2026-11-26). Paths are relative to that root. Line numbers are from the working tree and may drift. No web sources were used, so "Source" links below are repo files.

## 1. Architecture, security model and the worker pipeline

### Takeaway

Hidden-data detection fits best as a new section on the existing read-only, confirm-first, worker-isolated "file info" pipeline (and as pure host-side byte parsers for images and Markdown text). Anything that writes or encrypts must follow the host-validated message model and the "never modify the source file" stance, so embedding features belong behind an explicit save dialog and a new, separate message allowlist.

### Cited Findings

Host/webview split

- The extension host does file I/O, parsing and rendering; the webview is untrusted and only handles interaction, clipboard and canvas work. Rich clipboard writes must run in the webview (execCommand 'copy' trick); the host has only text clipboard. — docs/ARCHITECTURE.md "Clipboard" (line 344 on), AGENTS.md
- Every webview message is parsed by a `parse<Surface>Message` function in `src/messages/` (no `vscode` import) that accepts only exact shapes and returns undefined otherwise. Settings writes go through per-surface allowlists in `src/messages/settings.ts`. Host-to-webview messages are checked by `fromHost()` (`src/webview/fromHost.ts`). — .github/SECURITY.md "Webview messages" (line 78)
- Messages carry no file names or paths from the page: `readFile`, `reviewEnable`, `reviewCopy` carry no data; `navigate` carries only +1 or -1 and the host lists the folder. — .github/SECURITY.md, docs/ARCHITECTURE.md "Image preview" (line 820)

CSP and sanitization

- Shared preview CSP (src/previewShell.ts lines 36-52): `default-src 'none'`, `img-src ${cspSource} data: blob:` (plus `https:` only if `markcopy.allowRemoteImages`, user-scope only), `style-src ... 'unsafe-inline'`, `connect-src ${cspSource} blob:`, `script-src 'nonce-X' 'strict-dynamic'`.
- Image viewer CSP (src/imageEditor.ts lines 270-279): no `connect-src`, `worker-src` or `media-src`, bare nonced `script-src`, `localResourceRoots` is `media/` only. PDF viewer CSP (src/pdfEditor.ts lines 121-128) adds `worker-src ${cspSource} blob:` and `connect-src ${cspSource} blob: data:`. 3D viewer is the strictest and is the only one with `'wasm-unsafe-eval'` (STEP only). — .github/SECURITY.md "Content Security Policy" (line 88)
- Markdown is rendered in the host with markdown-it `html: true` (src/render.ts line 29), then sanitized again in the webview with `DOMPurify.sanitize(html)` (src/webview/main.ts line 311). Diagrams go through a separate DOMPurify call allowing `foreignObject` (src/webview/diagramHtml.ts line 14).
- Restricted Mode: capability `untrustedWorkspaces: limited`; every external-program path checks `workspace.isTrusted` (e.g. src/extension.ts line 1477, src/audioEditor.ts line 181, src/videoEditor.ts lines 577 and 806, src/texEditor.ts line 321). Restricted settings: `allowRemoteImages`, `video.ffmpegPath`, `pdf.browserPath`, `tex.*`. — SECURITY.md "Threat model" (line 67)

Worker-thread file-info pipeline

- `src/fileInfoEditor.ts` is the shared provider for the exe and package previews. First render is a confirmation page built only from the file name and the size from `fs.stat`; **Read this file** posts `{type:'readFile'}` (no data) or command `markcopy.fileInfo.read` (src/extension.ts line 404). `markcopy.fileInfo.confirm` (default true, package.json line 928) turns the gate off. Confirmation is per open page; later on-disk changes redraw without asking again. — docs/ARCHITECTURE.md lines 554-573, SECURITY.md "Executable info preview" (line 238)
- `FileInfoEditorProvider.read()` (src/fileInfoEditor.ts lines 160-190) builds a `FileInfoRequest {kind:'exe'|'package', fileName, path?|bytes?}`. Remote/virtual files are read whole by the host (`remoteBytes`, src/fileInspect.ts line 27) and refused above 64 MB; time limit is `DEFAULT_ISOLATION.timeoutMs + size/HASH_BYTES_PER_SECOND`.
- `runInWorker()` (src/isolate.ts line 40) starts `dist/fileInfoWorker.js` with `resourceLimits` 256 MB old generation, 32 MB young, 4 MB stack, 15 s timer (DEFAULT_ISOLATION line 30). Heap or time overrun ends the worker and the page shows a notice. A worker is a thread in the same process, not a sandbox, and memory outside the JS heap (typed arrays, WASM) is bounded only by readers' own caps. — src/isolate.ts header comment
- `src/fileInfoWorker.ts` is a 12-line entry: `runFileInfoTask(workerData)` then `postMessage`. `src/fileInfoTask.ts` (line 32 `runFileInfoTask`) opens one `FileHandle`, builds `fileSource(handle,size)`, calls the reader, then `digestHandle` on the same handle so details and hash describe one file. `FileInfoRequest.kind` is a closed union (`'exe' | 'package'`) and `FileInfoResult` is a discriminated union; a new reader means a new `kind`. Keep `vscode` out of the worker's imports (AGENTS.md).
- `esbuild.js` builds two host bundles (`dist/extension.js` about 3.7 MB, `dist/fileInfoWorker.js` about 412 KB as of the last build) and `esbuild.web.js` builds webviews into `media/` (code-split chunks, `chunk-*.js`).

Ranged reader and helpers

- `src/binary/reader.ts`: `ByteSource {size, read(offset,length)}` (line 25), `bytesSource` (line 31), `RangeReader` (line 55) with 64 KiB pages, default budget 256 pages (16 MiB) and `maxRead` 4 MiB; throws `ReadError` (line 22) whose message is written to be shown. Package reader raises the budget to 512 pages (32 MiB). `TRUNCATED` message at line 53.
- `src/binary/file.ts`: `fileSource(handle,size)`, `digestHandle` (SHA-256 via `node:crypto` `createHash`, 1 MiB chunks, `HASH_LIMIT` 256 MiB, lines 28-52), `digestBytes` (line 56).
- `src/binary/text.ts`: `printable(text, keepLineBreaks)` strips C0/C1 controls, DEL, U+2028/2029 and bidi U+202A-202E and U+2066-2069 (lines 5-24); `clip(text,max)` (line 71). Written with code points, so the source has no invisible characters.
- `src/binary/html.ts`: `table`, `grid`, `block`, `properties`, `pageHead`, `formatBytes`, `MAX_CELL_CHARS` 4096. `src/binary/xml.ts`: `parseXmlBounded` (saxes under an element/depth budget). `src/binary/own.ts`: `own()` prototype-safe lookup.
- `src/fileInspect.ts`: `inspectFile`, `remoteBytes`, shares Digest with the previews.
- `src/pkg/model.ts` section model (`PropertySection`, `TableSection`, `TextSection`, `PackageInfo`, `rows()`, `propertySection`, `tableSection`) and `bound()` in `src/pkg/index.ts` line 49 (40 sections, 500 rows a table, 2,048 characters a cell, 1 MB of text).

Security philosophy to carry over

- "A page states what the file establishes, and no more": signatures are reported only when the format's structure is present; nothing is verified, and pages say so (SECURITY.md lines 238-266). A hidden-data detector must use the same wording discipline: "contains N trailing bytes after the PNG IEND chunk" and not "contains a hidden message".
- Strings from files are cut (`clip`), cleaned (`printable`), HTML-escaped once in `src/binary/html.ts`, and sanitized again in the webview.
- Read-only: previews never write to the source file. Writes elsewhere are sidecars via exclusive temp file and rename (src/sidecarFile.ts lines 25 and 60, `randomUUID` from node:crypto) or save dialogs (Save as PNG).

### Inferences

- A "hidden data" report is a natural third file-info kind (or a section appended to existing results) that reuses `FileInfoRequest`, `RangeReader`, `printable`, `bound`, the confirm gate and the worker.
- Findings must be worded as structural facts with offsets and sizes (matching the "does not verify" tone) to fit the project's review history, which repeatedly rejected overclaiming pages.

### Gaps

- Not read: the full ARCHITECTURE.md (443 KB) and TESTING.md (176 KB); only relevant sections were sampled.

## 2. What already exists that is stego-adjacent

### Takeaway

There is no steganography, EXIF, XMP or metadata-chunk display today, and no invisible-Unicode warning in the Markdown copy path. The closest existing signals are the PE overlay row, ZIP EOCD/trailer handling, hidden spreadsheet sheets, the bidi/control stripping in `printable`, audio tag display, and raw `html: true` Markdown.

### Cited Findings

- PE overlay: `info.overlay = {offset,size}` is computed from the end of the last section raw data, ignoring the certificate table when it sits at the tail (src/pe/read.ts lines 596-601, type at line 146); rendered as "N after the image, as an installer's payload is" (src/pe/render.ts lines 173-176). The certificate table is walked entry by entry with caps (read.ts lines 544-590, `MAX_CERTIFICATES`, `MAX_SIGNATURE_BYTES`). The overlay is sized, not scanned or classified.
- ASN.1/PKCS #7 walking exists: src/pe/signer.ts (`readSigner`, `signerCount`, `isSignerInfo`), reused conceptually for zip-based signature checks in src/pkg/zipRange.ts (`isSignature` line 528, `readV1Signatures` line 713, `MAX_SIGNING_PAIRS` 64 for the APK signing block).
- Image sniffing: `sniffImage()` (src/webview/imageInfo.ts line 413) reads only magic bytes and header dimensions for PNG, JPEG, WebP, BMP, ICO, AVIF (`isAvif` line 194) and SVG (`parseSvg` line 65, `svgEncoding` line 277 with BOM and UTF-16 detection). It walks no PNG chunks, no JPEG marker segments, and reports nothing after the image. `MAX_IMAGE_BYTES` is 64 MiB (line 11); the host reads the whole file and posts base64 (src/imageEditor.ts lines 226-251). GIF header parsing (`parseGif`, src/webview/gifInfo.ts line 58) walks blocks for frames and loop count; `MAX_GIF_BYTES` 64 MiB. It does not surface comment or application extension blocks (not confirmed by reading; see Gaps).
- No metadata display for images: `rg` for exif, iTXt, tEXt, XMP, ICC, APP1 across src returns no image-metadata code. The only "exif" mention is the EXIF-rotated copy note in docs/COPY-MATRIX.md (Images section, lines 340-360), which relies on the browser's decoder.
- Audio: ffprobe tags (all of `format_tags` and `stream_tags`) are read and cleaned, values capped at 1000 characters (src/audioProbe.ts lines 11-22, `cleanTag` line 73). Needs ffprobe and a trusted workspace. Video probe is analogous.
- PDF: pdf.js (`pdfjs-dist ^6.5.438`) renders pages to canvas via `getDocument({data})` (src/webview/pdf.ts line 203); `rg` finds no use of metadata, attachments or JS-action APIs. Host reads PDFs through `readDocument(uri, MAX_PDF_BYTES)` (src/pdfEditor.ts line 63, src/documentFile.ts). A Blob script URL is created at src/webview/pdf.ts line 193 (recolour feature) under the nonce CSP.
- OOXML: `src/ooxml/zip.ts` `openZip(bytes, options)` (line 79) is an in-memory fflate reader with caps (`DEFAULT_LIMITS` lines 20-30: file 256 MB, 1000 entries, 64 MB per entry, 256 MB total) and `partText`, `normalizePath`, `resolveTarget`, `partForRels`. Readers cover word comments (src/docx/read/comments.ts, context.ts) and hidden xlsx sheets/rows/columns are tracked (src/xlsx/workbook.ts lines 17 and 67-69; src/xlsx/sheet.ts lines 18, 31, 117-183) but hidden things are simply not shown, with no "N hidden sheets" flag. No reading of docProps, customXml, vbaProject or embedded objects (rg found docProps only in the pptx writer, src/pptx/write/package.ts line 30).
- Zip central-directory reader for ranged access: src/pkg/zipRange.ts, `openZip(reader)` line 226; EOCD scan over the last 65,557 bytes (lines 24-27, 144-162) with a rule that the comment must end at or before the file end ("trailing bytes", line 152). Caps `MAX_ZIP_ENTRIES` 100,000, `MAX_DIRECTORY_BYTES` 12 MiB (lines 34-37). `readTextEntry`/`readBytesEntry` (lines 483, 504). `ZipArchive`/`ZipEntry` types at lines 58-76. Compression helpers: src/pkg/decompress.ts (`gunzipBounded`, `unzstdBounded`, `unxzBounded`, `readCompressed`, `ByteSink`, all output-capped).
- Other structure parsers reusable as walkers: ELF (src/pkg/elf.ts, AppImage payload size), CFB/OLE (src/pkg/cfb.ts, used for MSI), AR (ar.ts), tar (tar.ts), xar (xar.ts), DMG (dmg.ts), AXML (axml.ts), RPM/Deb/Alpine readers. TLV/DER helpers sit in src/pe/signer.ts.
- Unicode safety: `printable()` strips bidi controls and C0/C1 only from text taken out of binary files (exe, pkg, and related) so names cannot masquerade (src/binary/text.ts). It does not touch zero-width characters (U+200B-200F, U+2060-2064, U+FEFF mid-text), variation selectors, Unicode tag characters (U+E0000-E007F), or confusables, and it is not applied to Markdown, CSV, docx, xlsx or pptx text. A repo-wide `rg` for bidi, zero-width, homoglyph and U+202x finds only this file and a comment in src/docx/ or src/ooxml/write.ts about XML-illegal characters (line 17).
- Markdown copy and render paths: Markdown is rendered with raw HTML allowed (src/render.ts line 29); `scanTag` skips HTML comments when scanning (src/render.ts lines 313 and 463); the webview's plain-text and rich-text copy reads `textContent`/computed styles (src/webview/main.ts lines 830-934, 1250, 1332-1428). Nothing flags hidden text, HTML comments, `display:none`, zero-width characters or bidi overrides when copying Markdown to a paste target. DOMPurify keeps most formatting HTML, so hidden spans could survive into rich-text copy (not tested; see Gaps).
- Image Notes (review): sidecar `<name>.review.yaml` and `.review.md`, shared NotesSession in src/review/session.ts and src/imageReview.ts; the schema is owned by okstudio-video-kit and MarkCopy follows it byte-faithfully (per project memory). Any new sidecar-based "findings" file would collide with that convention; prefer in-page display or a separate, clearly named sidecar.

### Inferences

- Cheapest high-value additions: (a) a bidi/zero-width/tag-character/variation-selector detector for Markdown and CSV text with a count surfaced in the status area and optionally on copy; (b) trailing-data-after-IEND/EOI/EOCD checks and chunk/segment inventory for images and zip-based files; (c) an "N hidden sheets, rows, columns" and embedded-object report for OOXML; (d) PE overlay classification (entropy, magic of overlay start).
- Because `printable()` already encodes the project's judgement on bidi and controls, a Unicode detector should live beside it in src/binary/text.ts (or a new src/binary/hidden.ts) and reuse the same code-point style.

### Gaps

- GIF comment/application extension handling not verified in src/webview/gifInfo.ts beyond the header; check before proposing a GIF check.
- Did not test whether DOMPurify output retains hidden text through Copy as Rich Text.
- The PDF viewer's handling of embedded files, JavaScript, and XMP is only inferred from absent API calls in src/webview/pdf.ts; the pdf.js worker may still parse them.

## 3. Formats opened, and where a "hidden data" check would run

### Takeaway

Fourteen custom editors are registered (package.json customEditors). Binary formats with ranged readers already run in the worker; image, GIF and PDF bytes currently go to the webview as base64 or data, so any structural check should run on the host or in a worker before posting, not in the webview.

### Cited Findings

Editors, priority and patterns (package.json contributes.customEditors; lowercase patterns, each also uppercase):

- markdownPreview (option): md, markdown, mdown, mkd, mdx. csvPreview (option): csv, tsv, tab. texPreview (option): tex, ltx, latex.
- pdfPreview (default): pdf. xlsxPreview: xlsx, xlsm. pptxPreview: pptx, pptm. docxPreview: docx, docm.
- exePreview: exe, dll, sys, ocx, scr, cpl, efi. packagePreview: deb, udeb, rpm, msi, dmg, pkg, apk, jar, war, ear, vsix, whl, nupkg, snupkg, so, elf, ko, so.*, appimage.
- stlPreview: stl, 3mf, glb, step, stp, gcode, gco, obj. audioPreview: mp3, wav, ogg, oga, opus, flac, m4a, aac. videoPreview: mov, mp4, m4v, mkv, webm, avi, wmv, flv, mpg, mpeg, 3gp. gifPreview: gif. imagePreview: png, jpg, jpeg, webp, bmp, ico, avif, svg.

Where checks would run under the current rules

- Executables and packages: worker (existing). Add sections in `readPe` and `readPackage` results, or a `kind: 'hidden'` task. Confirmation gate already applies to these types.
- Images (png, jpg, webp, bmp, ico, avif, svg), GIF: the host reads the whole file (up to 64 MiB) in src/imageEditor.ts; a parser written without `vscode` could run there or in the worker. Chunk and marker walkers (PNG chunks, JPEG segments, RIFF chunks for WebP, ISO-BMFF boxes for AVIF, GIF blocks) are not yet in the repo. The existing "format comes from the bytes" principle applies (IMAGE-DESIGN, ARCHITECTURE line 820).
- PDF: bytes available on host (`readDocument`). Structural scan (trailer, `%%EOF` trailing data, /EmbeddedFile, /JS, /OpenAction, incremental updates, XMP) is a host or worker byte scan; pdf.js in the webview should not be asked for it because of CSP and the "page cannot name a file" rule.
- OOXML (docx, xlsx, pptx): host, already in memory through `openZip` (src/ooxml/zip.ts) with a 256 MB file cap; checks for hidden sheets, hidden text runs (w:vanish), customXml, vbaProject.bin, embeddings, docProps, comments and revisions fit here. Note the OOXML readers run in the extension host today, not the worker; the worker pattern was introduced only for the exe and package readers after the 2026-11-23 audit.
- Zip central directory and trailing data: reuse src/pkg/zipRange.ts (ranged) for any zip, including jar, apk, docx.
- Markdown, CSV, TeX: text is a VS Code TextDocument in the host; a code-point scan for bidi, zero-width, tag characters and variation selectors is cheap and can run in the host render step or in the webview (src/render.ts pipeline). CSV cell editing writes back to the file, so any "strip invisible characters" action there needs the existing block-edit validation path (src/blockEdit.ts, `documentFile.ts`).
- Audio, video: ffprobe tags only (requires trusted workspace and ffprobe); no byte-level container reader in the repo. ID3 and MP4 box walking would be new.
- 3D: GLB, 3MF, OBJ, STL readers in src/webview (obj.ts, glb.ts, threeMf.ts, stl.ts) run in the webview with its own CSP; they are not stego targets in practice.

### Inferences

- A single `src/hidden/` module family (pure, no `vscode`) with one `scanXxx(source: ByteSource)` per format, dispatched by magic bytes like `readPackage`, would run in the worker for any format and be called from the image/PDF/OOXML editors via `runInWorker`. This extends the existing `kind` union.
- For images the shortest path is a new section in the image status area or a "File details" panel, opened by a command, not an automatic scan, to respect the "read only when asked" convention.

### Gaps

- No existing worker path for image or PDF files; the worker entry assumes only `exe` and `package`.

## 4. Dependencies, crypto and bundle size

### Takeaway

Only Node's built-in SHA-256 is used; there are no crypto, image-decoder or steganalysis libraries, and no WebCrypto use in the webview. Dependencies are small and MIT licensed.

### Cited Findings

- package.json runtime dependencies: dompurify ^3.4.18, fflate ^0.8.3, fzstd 0.1.1, highlight.js ^11.12.0, katex ^0.19.1, markdown-it ^15.0.3 (+anchor, footnote, texmath), numfmt, occt-import-js ^0.0.23 (WASM, STEP), pdfjs-dist ^6.5.438, saxes ^6, three ^0.187.0, turndown (+gfm), xz-decompress 0.2.3 (embedded WASM), yaml ^2.9.1. Dev: esbuild, vitest, jsdom, mermaid, @jazzer.js/core, @vscode/vsce, ovsx, html-to-image, typescript-eslint, prettier.
- `node:crypto` uses: `createHash('sha256')` in src/binary/file.ts lines 6, 41, 57 (worker-safe); src/texCompile.ts line 22 and 477 (cache key); src/pdfExport.ts lines 11 and 458 (CSP script hash); `randomBytes`/`randomUUID` in src/sidecarFile.ts, src/review/sidecar.ts, src/videoProxy.ts. src/webview/emptyModule.ts stands in for Node built-ins (fs, path, crypto) when bundling occt-import-js for the webview. `rg` finds no `crypto.subtle` or `getRandomValues` in src/webview.
- No image decoder dependency: raster decoding is the browser's (Chromium canvas). A pixel-level LSB or chi-square analysis would need decoded pixels: in the webview via a canvas `getImageData` (allowed by the CSP, the image viewer already uses a canvas for PNG export and the page is untainted, see src/imageEditor.ts line 18 comment) or a pure-JS PNG decoder (fflate for inflate already bundled) in the worker.
- The engine floor is VS Code 1.90 (package.json line 19), Node 20 in the extension host (AGENTS.md "Dependency compatibility"); Node 20 supports `node:crypto` AES-GCM, scrypt and PBKDF2 natively, so an encryption feature needs no new dependency on the host. WebCrypto (`crypto.subtle`) is available in a Chromium webview but needs a secure context; VS Code webviews are served from a `vscode-webview://` origin and this repo never relied on it (not verified; see Gaps).
- AGENTS.md: "Do not bypass dependency conflicts with `--force`"; manifest and lockfile change together; run `npm audit` after changes; review `.github/dependabot.yml` for major bumps. SECURITY.md "Dependency monitoring" (line 3) describes monitoring policy; "Two runtime dependencies were added" is the precedent for justifying new ones in SECURITY.md (line 264).
- Bundle sizes (listing taken at research time): dist/extension.js 3.7 MB, dist/fileInfoWorker.js 412 KB, media/ holds many mermaid chunks and a total of about 30 MB (ls output). The worker bundle is small, so a hidden-data reader adds kilobytes, while a new decoder or crypto library would be the notable cost.

### Inferences

- Detection of structural hiding (trailing data, extra chunks, metadata, invisible Unicode) needs zero new dependencies. Statistical stego detection (chi-square, RS analysis, sample-pair) needs only pixel arrays and a few hundred lines of pure TypeScript.
- Embedding and extraction using node:crypto (AES-256-GCM with scrypt) can live in the host with no dependency; any new third-party crypto library would conflict with the project's minimal-dependency record.

### Gaps

- Not verified: whether `crypto.subtle` works in the VS Code webview in the repo's supported range.
- Did not measure bundle impact; dist sizes are from file listing only.

## 5. Tests, fuzzing and fixtures a new reader must follow

### Takeaway

Every new byte reader is expected to ship with unit tests built from in-repo fixture builders (no committed binaries of unknown origin), a Jazzer.js fuzz target with seeds and a dictionary, an oracle for cost and page content, and prototype-name safety.

### Cited Findings

- Unit tests: vitest, `npm test`, half the cores (`maxWorkers` in vitest.config.ts); run one command at a time; integration tests only when the maintainer asks. Run vitest from `W:\dev\markcopy` with a capital drive letter in PowerShell (project memory). — AGENTS.md "Validation"
- Layout: tests/pe (fixture.ts, reader, render, icon), tests/pkg (one `*Fixture.ts` builder per format plus tests, e.g. rpmFixture.ts, zipFixture.ts, hostileMac.test.ts, bound.test.ts, dispatch tests), tests/binary (file, html, own, reader, text, xml), tests/fileInfoTask.test.ts, fileInfoWorker.test.ts, fileInfoEditor.test.ts, isolate.test.ts, fileInspect.test.ts, imageInfo.test.ts, imageEditor.test.ts, gifInfo.test.ts, tests/e2e (webview E2E on jsdom, includes fileInfoRead.e2e.test.ts), test-integration (Mocha in real VS Code).
- Fuzz: `npm run fuzz` (fuzz/run.js), `fuzz:merge`, `fuzz:replay`; targets in fuzz/targets (*.fuzz.ts: 3mf, audio-probe, csv, docx, file-source, gcode, glb, image, markdown, markdown-html, messages, obj, paste-export, pe, pkg, review, step, stl, video-probe, xlsx, xml, zip, links ...), seeds in fuzz/corpus/<target>/, dictionaries in fuzz/dict/<target>.dict, `fuzz/seeds.ts` generates PE and pkg seeds from the test fixture builders (deterministic, `Date.now` pinned, max 8 KiB each), shared helpers `fuzz/targets/binaryOracle.ts`, `expected.ts`. `tests/fuzzTargets.test.ts`, `fuzzRun.test.ts`, `binaryOracle.test.ts` load every target and replay seeds in `npm test`, so a broken target fails the suite. Nightly Jazzer run opens `Fuzz crash:` and `Fuzz target broken:` issues. — docs/FUZZING-STRATEGY.md, SECURITY.md line 84
- Oracles worth reusing (FUZZING-STRATEGY "P1"): cost oracle counting `heapUsed`, `arrayBuffers` and `external`; page oracle checking rendered content (no raw control characters, no prototype leaks); `Object.hasOwn` or `Map` lookups instead of `table[key]`; `file-source` differential target comparing `bytesSource` to a short-read file source. The strategy's audit (2026-11-23) found six sub-2 MB files taking the host past 4 GB, which is the stated reason for the worker.
- Rules every reader follows (ARCHITECTURE lines 574-604, SECURITY.md 251-266): cut each string with `clip` before cleaning, never build strings a character at a time, cap tables and loops, check every offset against real size, decompress only with the bounded helpers, report damage as per-section warnings, bind the output with `bound()`.
- Docs the repo expects updated with behaviour changes: README, docs/guide/* (files.md, settings.md), docs/ARCHITECTURE.md, docs/TESTING.md (manual coverage), CHANGELOG, docs/COPY-MATRIX.md for any copy action, SECURITY.md sections. "Record measured results, not assumed coverage." — AGENTS.md

### Inferences

- A new stego/hidden-data reader should add: fixture builders that construct the hidden payloads (PNG with trailing data, text chunk, JPEG with APP segments and trailer, zip with prepended data and comment), a `hidden` fuzz target with seeds from those builders, and a page oracle.

### Gaps

- Did not read tests/fuzzTargets.test.ts or fuzz/run.js to see exactly how a target is registered; check before adding one.

## 6. Constraints on UI, settings and copy

### Takeaway

UI must use the Primer-based `--mc-*` tokens and blue accent, not alex-style or okstudio-style; settings follow the `markcopy.<area>.<name>` pattern with documented scope and restricted-configuration rules.

### Cited Findings

- Tokens in media/preview.css: `--mc-fg`, `--mc-bg`, `--mc-border`, `--mc-code-bg`, `--mc-pre-bg`, `--mc-quote-fg`, `--mc-th-bg`, `--mc-link`, `--mc-error-fg`, `--mc-error-bg`, `--mc-row-alt`, `--mc-row-hover`, `--mc-accent` (#0969da light, #4493f8 dark), `--mc-muted-fg` (lines 13-27 and 46-60). Edit the source stylesheet, not bundles (AGENTS.md). Headless screenshot before handing a page to the maintainer (project memory).
- Settings: 50+ `markcopy.*` keys in package.json configuration, documented in docs/guide/settings.md (table: key, type, default, description; e.g. line 39 for `fileInfo.confirm`). Image-specific: `markcopy.image.background`, `markcopy.image.review`. Settings writable from webviews are on an allowlist in src/messages/settings.ts. Restricted configurations are listed in package.json capabilities; any setting that launches programs or reaches the network must be added there.
- "Open in Default App" is removed for exe and packages because it would run them (`opensInDefaultApp` in src/ooxmlEditor.ts, `NO_LAUNCH_KINDS` in src/webview/main.ts). Any feature that extracts a hidden payload must not open or run it; show it as text or hex, or save it only through a save dialog.
- The extension is read-only for binaries; the only source-file write is CSV cell and Markdown block editing, validated host-side. Writing image copies uses Save as PNG through a dialog (docs/COPY-MATRIX.md "Images").
- COPY-MATRIX must be updated if copy actions change: image menu rows (Copy Image as PNG, Save as PNG, Copy as Markdown/HTML/Data URI/File name/Full path, Copy SVG Source); data URI is capped at 4 MiB (`MAX_DATA_URI_BYTES`, src/webview/imageInfo.ts line 13). Copy as PNG re-encodes through a canvas, which drops any appended data and most metadata; this is a de facto "sanitizing copy" worth documenting.
- IMAGE-DESIGN.md "Out of scope": editing of any kind (crop, resize, rotate, conversion other than PNG). An embed feature on images would reopen that scope decision.

### Inferences

- A "Copy Image as PNG (strip metadata)" behavior already exists implicitly. A visible "what this strips" note and an Unicode-sanitizing "Copy as plain text (cleaned)" are concrete, low-risk copy features that fit COPY-MATRIX.
- Embedding or encryption features would be the first source-file or new-file writers outside Save as PNG and sidecars, so they need their own SECURITY.md section, a save-dialog-only output path, and a webview message allowlist entry with host validation, and should not be on by default.

### Gaps

- Did not read docs/guide/settings.md fully or the restricted-configuration list in package.json.
- IMAGE-DESIGN.md and README.md were read only in part (verdict, out of scope, headings); README feature list not summarized.

## Candidate extension points, summarized

1. src/binary/text.ts neighbour: invisible-Unicode scan (zero-width, bidi, tag characters U+E0000-E007F, variation selectors, mid-text BOM) for Markdown, CSV, TeX and text pulled from docx/xlsx/pptx; surface as a count and an optional cleaned copy.
2. New `src/hidden/` byte readers on `ByteSource`/`RangeReader` for PNG, JPEG, GIF, WebP, BMP, PDF, zip, with trailing-data and metadata inventories; run in the worker as a new `FileInfoRequest.kind`, behind the existing confirm setting.
3. PE overlay and package follow-ups: classify the overlay (src/pe/read.ts line 596) and zip prepended or trailing data (src/pkg/zipRange.ts EOCD scan).
4. OOXML hidden-content report using `openZip` and existing readers (hidden sheets, rows, columns, vanish runs, customXml, embeddings, vbaProject).
5. Optional pixel analysis through the image viewer's existing untainted canvas (webview) or a pure-JS decoder in the worker.
6. Optional embed or extract and encrypt or decrypt: host-only with `node:crypto`, save-dialog output, new message allowlist, new SECURITY.md section; conflicts with the "read-only previews" and image "out of scope: editing" statements and needs an explicit maintainer decision.
