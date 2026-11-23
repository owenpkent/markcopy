# Security

## Dependency monitoring

Dependabot security alerts and automatic security update pull requests are enabled.
Weekly version updates are configured in `dependabot.yml`, with compatibility
exclusions for dependencies tied to the project's Node and VS Code versions.

CodeQL (`codeql.yml`) analyses the TypeScript sources with the `security-extended` suite on
pushes to main, pull requests and weekly. Findings appear under the repository's Security
tab (Code scanning). Generated bundles and vendored assets are excluded in
`.github/codeql/codeql-config.yml`.

`npm audit` is clean as of the move to `@vscode/vsce` 4 and `ovsx` 1.3 on Node 22,
and again after `ovsx` 1.4 and jsdom 31 (2026-11-12).
That removed the only advisory with no fixed release, `braces`
(GHSA-vfj7-8cjw-p6xm), which vsce 3 reached through `secretlint`, `globby`,
`fast-glob` and `micromatch` and which `ovsx` 1.2 pulled in again through its
nested vsce 3. None of that chain was ever bundled into the extension. Check
`npm audit` again after any dependency change.

Every GitHub Action in the workflows is pinned by full commit SHA with its version in a trailing comment, so a moved tag cannot change what CI runs. Dependabot's `github-actions` ecosystem opens weekly pull requests that update the SHA and the comment together. The `github/codeql-action` steps are grouped into one pull request, because `init` and `analyze` must run the same CodeQL version.

The `package.json` overrides for `@vscode/test-cli` replace vulnerable versions of
`diff` and `serialize-javascript` used by its nested Mocha 11 dependency. Remove
these overrides when the CLI resolves patched versions without them. The direct Mocha
dependency uses version 12 and does not need these overrides.

The root `package.json` override for `@azure/msal-node`, which `@vscode/vsce` pulls
in through `@azure/identity`, moves it from 6 to 7 to fix
[GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) in MSAL's
authorization code flow. Every released `@azure/identity` still declares
`msal-node ^6`, but both majors share the same `msal-common` 16 core. The override
was checked by packaging a VSIX and by requesting a token through
`ClientSecretCredential`, which reached Entra ID and failed cleanly with invalid
credentials. Publishing with `--azure-credential` is not exercised, because releases
authenticate with a personal access token (see [RELEASING](../docs/RELEASING.md)).
It is a root override rather than one scoped under `@vscode/vsce` because npm 10,
which CI uses, rejects the scoped form during `npm ci` as out of sync with the
lockfile. Remove this override when `@azure/identity` accepts a patched `msal-node`.

The root `package.json` override for `minimatch` moves every copy in the
development tree (under `@vscode/vsce`, ESLint, Mocha, and `@vscode/test-cli`)
from 9 and 10 to 11 to fix
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), a
denial of service through globparts amplification. It is checked by the full
unit and integration suites and by confirming that `vsce ls` packages the same file
list, since `vsce` uses `minimatch` to apply `.vscodeignore`. Remove this override
once those packages depend on `minimatch` 11 themselves.

The root `package.json` override for `glob` moves the 10 and 13 copies under
`@vscode/test-cli` (its own, its nested Mocha 11, and `c8` through `test-exclude`)
to 14.0.3 to fix
[GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), an
AbortSignal cancellation bypass. glob 14 requires `minimatch` 11, which the override
above already supplies. The integration suite still discovers and runs every test
file through the CLI. Remove this override when `@vscode/test-cli` resolves a
patched `glob` on its own.

The `package.json` override for `mermaid` makes it use the project's own `katex`
(`"$katex"` resolves to the direct dependency's version) instead of a nested copy
from its `^0.16` range. This keeps one KaTeX version in the lockfile, so Mermaid's
math labels use the same markup as the KaTeX CSS the preview loads, and the webview
build emits one KaTeX chunk instead of two. Remove this override when Mermaid's own
`katex` range includes the project's version.

## Threat model

MarkCopy renders untrusted content (any Markdown, CSV/TSV, spreadsheet, Word document, presentation, executable, package or installer, PDF, STL model, or image you open) into a webview. It can render Mermaid diagrams from fenced code, parses PDFs with pdf.js, and parses STL meshes with Three.js, and decodes GIFs with the browser. The areas that matter are script execution in the preview, diagram rendering, PDF parsing, unpacking and parsing a workbook, parsing a mesh whose header declares its own size, writing an edited CSV cell back to the file, and running a browser to render a PDF export.

LaTeX preview adds a more privileged parser boundary: it runs an installed TeX
engine against the opened source and its included files. Video, GIF, and image previews hand
media to Chromium and can optionally run ffprobe and ffmpeg. Word export parses
webview-produced XHTML and writes an OOXML package, including external links.

## Webview messages

A webview is untrusted: it renders content from files you did not write, so the messages it posts to the extension host are treated as input, not as commands. Each preview has a `parse<Surface>Message` function in `src/messages/` (no `vscode` import) that accepts exactly the message shapes its handler acts on and returns `undefined` for anything else; the host handlers switch over the parsed result only. Messages that write a setting go through per-surface allow-lists in `src/messages/settings.ts`: the Markdown, CSV, spreadsheet, deck and Word previews may write `theme`, `syncScroll`, `autoPreview`, `math` and `footnotes`; the video viewer `theme`, `video.loop`, `video.autoplay` and `video.review`; the image viewer `theme`, `image.background` and `image.review`; the PDF, LaTeX, GIF and STL viewers `theme` only. Each key is checked together with the type or enumerated value it takes. Settings that name an executable (`video.ffmpegPath`, `pdf.browserPath`, `tex.enginePath`) are not on any list, so a page cannot point the host at a program. A CSV cell edit is refused past column 500,000 rather than padding a row to that width, and a toast message must be a string.

Messages in the other direction are checked too. Every webview's `message` listener first asks `fromHost()` (`src/webview/fromHost.ts`) whether the event came from the extension host, which VS Code delivers from the webview's outer frame: the event's origin must equal the page's own, or its source must be the parent window. Anything else is dropped before its payload is read. The video viewer never takes a media address from a message: the host writes the file's webview URI and the URI its ffmpeg proxy will have (the proxy's name is fixed per panel before any encode) into the page as `data-mc-src` and `data-mc-proxy-src`, and the `load` message only says which of the two to play, as the audio viewer already did for its one file. The PDF viewer, which the PDF editor, the LaTeX preview and the screenshot harness all host, reads its worker script's address from an attribute the host wrote into the page, not from a message, so the one URL it fetches is never message-supplied; a page without the attribute shows an error instead of fetching.

Known gap: the PDF and LaTeX viewers write the `comments` array of a `saveComments` message to the document's `.mccomments.json` sidecar without checking the shape of its entries, so a page can still write any array there. The sidecar is data beside the document and is never executed.

The parsers are unit-tested and fuzzed (see [Fuzzing](../docs/TESTING.md#fuzzing)). The nightly Jazzer.js run also covers the zip, workbook, deck, Word, XML, CSV, Video and Image Notes, Markdown, GIF, image, STL, Windows executable, package and installer, and video probe parsers, link handling and sanitized Markdown output, and opens a `Fuzz crash:` issue when an input makes one fail. That is a way of finding bugs, not a guarantee: a clean run covers the inputs the fuzzer reached. It also only finds what a target treats as failure. The `pkg` target ran half a million inputs clean while the memory cases above existed, because a reader that spends a gigabyte and returns a small page throws nothing; it now fails an input that takes over three seconds, grows the heap by over 256 MB, or makes a page of over 4 MB.

## Content Security Policy

The webview is served with a strict CSP and a fresh nonce per load:

```
default-src 'none';
img-src ${cspSource} https: data: blob:;
style-src ${cspSource} 'unsafe-inline';
font-src  ${cspSource} data:;
connect-src ${cspSource};
script-src 'nonce-${nonce}' 'strict-dynamic';
```

- Only the nonce-tagged bundle script can run. Inline scripts injected through Markdown `html: true` content cannot execute. `'strict-dynamic'` lets that nonce'd entry module import its own code-split chunks (`media/chunk-*.js`) without each one needing its own nonce; it does not relax anything else the policy already refuses.
- `img-src` allows `https:`, `data:`, and `blob:` so remote images, embedded images, Mermaid SVGs, and html-to-image output display.
- `connect-src ${cspSource}` is scoped to the webview's own origin only. It exists so `html-to-image` can fetch and embed KaTeX's web fonts when rasterizing a math equation to PNG (**Copy Equation as PNG**); Mermaid never needed this directive because it renders with system fonts. Being same-origin, it cannot be used to reach any external host.
- All local assets (the script and stylesheet) are loaded through `webview.asWebviewUri`. `localResourceRoots` itself is not one fixed folder: it always includes the extension's own `media` folder, and the Markdown/CSV preview also grants the document's workspace folder (or, lacking one, the document's own directory) so relative local images resolve. The read-only PDF, LaTeX, STL, and spreadsheet editors keep `localResourceRoots` to just `media`, since each receives its content as bytes (or, for the spreadsheet, already-rendered markup) rather than a document-relative URI. The video editor also adds the video's own directory and the ffmpeg proxy directory, since it streams the file by URI rather than loading it into memory.

The PDF and LaTeX previews share one policy (the LaTeX preview renders through the same pdf.js viewer): the shared-preview policy above, but with a bare `script-src 'nonce-${nonce}'` (their bundle is not code-split, so `'strict-dynamic'` is not needed), `worker-src ${cspSource} blob:` added for the pdf.js worker, and `connect-src ${cspSource} blob: data:`. Neither adds `https:` to `img-src`, because a PDF is rendered to a canvas from bytes the extension supplies, not from remote resources.

The 3D preview (STL, 3MF, GLB, STEP, OBJ) is the most restrictive of the seven webview surfaces (shared preview, PDF, LaTeX, video, GIF, image, and 3D): `default-src 'none'`, a bare nonced `script-src`, and `style-src` / `font-src` scoped to `${cspSource}`, with no `img-src`, `worker-src`, or `media-src` at all. It draws into a WebGL canvas from bytes the extension supplies. It has exactly two additions, both for STEP files, and no other webview has either: `'wasm-unsafe-eval'` in `script-src`, which lets the Open CASCADE engine (occt-import-js, WebAssembly) compile and nothing else (it does not permit `eval()` or `new Function()`, and scripts are still nonce-only). The engine's Emscripten glue would otherwise need `'unsafe-eval'`: embind builds each binding with `new Function`. `scripts/occt-no-eval.js` replaces both such invokers with the closure form Emscripten emits under `-sDYNAMIC_EXECUTION=0` when `esbuild.web.js` bundles the glue, fails the build if the glue no longer matches, and `tests/step.test.ts` runs the patched glue in a Node context that refuses code from strings, and `connect-src ${cspSource}`, for the one fetch it makes, the gzipped engine `media/occt-import-js.wasm.gz`, from the extension's own `media/` folder (inside `localResourceRoots`). The webview derives that URL from its own bundle's location and ignores any URL in a message, so a message cannot point the fetch elsewhere. Nothing is fetched from the network, and GLB textures are removed before parsing so `img-src` stays absent. `tests/stlEditor.test.ts` asserts the policy and that no other source file contains `'wasm-unsafe-eval'`. The engine is LGPL-2.1 (occt-import-js and Open CASCADE Technology), its WebAssembly shipped unmodified as its own file with its license texts beside it (`media/license.occt-import-js.txt`, `media/license.occt.txt`), so a rebuilt copy can replace it. GLB and STEP files are hostile input like the others: a GLB is bounded by triangle count from its JSON before the loader runs, and the loader is handed only a pruned copy (the default scene's triangles, positions, normals and colors) whose every accessor is bounds-checked first, bufferless ones included, and whose buffer views together may not exceed the BIN chunk (the loader copies each view whole, so overlapping views would copy the same bytes again), and refused if it needs a compression MarkCopy does not decode or buffers outside the file; a STEP file is bounded by the size cap before it is read and by the triangle cap before the merged arrays are allocated, and both parse in the webview, so a hostile file costs the webview and not the extension host. An OBJ adds one host-side read and no webview capability. The host reads the `.mtl` files an OBJ's `mtllib` lines name, from the OBJ's own folder only: a name must be a bare file name ending in `.mtl` (a path separator of either kind, `..`, a colon so a drive letter or a URI, an absolute or UNC path, a leading dot and control characters are refused before any file system call), at most 8 files are read, each must be a regular file and not a symlink, at most 4 MiB, with no NUL byte, and the webview checks the payload again. The webview parses them itself (`newmtl`, `Kd`, `d`) and ignores every `map_*` line, so MTLLoader and its texture loading are not used, nothing is fetched and `img-src` stays absent. The OBJ is counted line by line before three's `OBJLoader` allocates anything and refused past the triangle cap, 3 x that many vertices, 20,000 objects and groups, 50,000 material switches, a 256 KiB line or a face index that names no vertex. A compiled `.obj` is refused by the host with a message; its **Open as text** button posts `openAsText`, which carries no data and makes the host open its own document in VS Code's default editor. `tests/obj.test.ts` and `tests/stlEditor.test.ts` cover the path rules and the caps, and `openAsText` is in the `messages` fuzz target. The video preview sits between the two: `media-src ${cspSource} blob:` for the `<video>` element and `img-src ${cspSource} blob: data:` for frame capture, but still no `connect-src` or `worker-src` (see [Video preview](#video-preview)).

## Mermaid

Mermaid is initialized with `securityLevel: 'strict'`, which sanitizes diagram-supplied HTML and blocks click bindings from diagram source. The SVG it returns is then passed through DOMPurify (with `foreignObject` re-allowed and set as an HTML integration point, since Mermaid draws every node and edge label as HTML inside one) before it is written into the page, the same defense in depth the rendered Markdown gets. A diagram that fails to parse renders an inline error message rather than executing anything.

## PDF preview

PDFs open in a read-only custom editor. The extension host reads the file with `workspace.fs.readFile` and hands the bytes to the webview; pdf.js parses and rasterises them entirely locally, with no network fetch. It runs under the same strict CSP as the rest of the webview: with no `'unsafe-eval'`, pdf.js detects the restriction and disables its eval-based fast paths. PDF parsing runs in a worker loaded from the bundled `media/pdf.worker.js`; page canvas rendering runs in the webview. The editor is read-only and never writes back to the PDF.

## LaTeX preview

Opening a `.tex`, `.ltx`, or `.latex` file can run `latexmk`, Tectonic, or a
bare TeX engine in the source file's directory. The selected executable comes
from the machine-scoped `markcopy.tex.enginePath` setting or fixed discovery,
and is launched with an argument array rather than a shell. MarkCopy does not
add `-shell-escape` (or its equivalent), but this is not an OS sandbox: TeX
engines can read files available to the process and use their own file
primitives, and local engine or latexmk configuration can affect a run.

Treat untrusted LaTeX as code and open it only with the same trust you would
give an installed compiler. Output is kept
under a hashed temporary directory, compilation is stopped after 45 seconds
without output or on cancellation, and the directory is removed when the last
preview closes (abandoned directories are swept after 24 hours).

## PDF export

**Save as PDF** starts an installed Chrome, Edge, or Chromium: it writes the export page to a temporary directory and runs the browser over it with `--headless --print-to-pdf` (see [PDF export](../docs/ARCHITECTURE.md#pdf-export) for the full command line). LaTeX and video preview can also start locally installed tools.

- **The executable is not taken from the document.** It is either the `markcopy.pdf.browserPath` setting or one of a fixed list of known install paths for the platform, and it is spawned with an argument array, never through a shell, so nothing in a document can influence the command. That setting is machine-scoped, so it can only come from your own user settings: a `.vscode/settings.json` travelling with a cloned repository cannot point MarkCopy at a program to run, even in a workspace you have trusted.
- **The page carries no scripts.** The exported body is the preview's own DOM, which has already been through DOMPurify, so a `<script>` in the source Markdown is long gone before the export sees it. The one exception is the fallback route (no browser installed), whose page carries a `window.print()` MarkCopy wrote itself. The only other setting reaching that page, `markcopy.pdf.pageSize`, is checked against the three values it may take before it is written into a `<style>`, since the `enum` in package.json constrains the settings editor and not the file.
- **The browser runs on a throwaway profile** (`--user-data-dir` in a fresh `mkdtemp` directory, plus `--disable-extensions` and `--disable-sync`), so the render touches none of your browsing profile, cookies, or extensions. The directory, page included, is deleted however the render ends.
- **Remote images in a document are still fetched**, by the headless browser this time rather than the preview, because the export keeps `https:` image sources as they are. This is the same network access the preview already had, but it is worth knowing it happens outside the webview too.
- **One file is written, where you chose it.** The destination comes from a save dialog; the export never picks a path on your behalf. The browser renders to a scratch file inside the throwaway directory and the finished PDF is moved into place afterwards, so a render that fails leaves whatever was already at that path untouched.

## HTML in Markdown

`markdown-it` is configured with `html: true`, so raw HTML in a document is passed through to the preview before the rendered result is sanitized by DOMPurify. The CSP prevents any inline script in that HTML from running, but be aware that raw HTML is still rendered and remote images may load. If you open Markdown from an untrusted source, this is the surface to keep in mind.

## Video preview

The video webview reads the VS Code webview resource URI of the file (rooted at
the video's own directory) and of its possible ffmpeg proxy from attributes the
host wrote into the page, never from a message, and uses a CSP with `media-src`
limited to that origin and `blob:`; it does not fetch arbitrary network media. The browser's media demuxer and
decoder still process the file, so malformed media can consume resources or
trigger a vulnerability in the host's Chromium build.

When Chromium cannot decode a file, MarkCopy may probe and transcode it with
the machine-scoped `markcopy.video.ffmpegPath` executable (or fixed discovery).
ffprobe and ffmpeg receive the source and destination as argument-vector
values, never through a shell. The proxy is written under a temporary
directory, is subject to a 120-second no-progress cancellation, and is
deleted when the preview closes. This does not sandbox ffmpeg or limit the
source file's size; use a trusted ffmpeg build and treat untrusted media as
hostile input.

Review mode reads a `<stem>.review.yaml` file beside the video. It writes that
file when a note is added, deleted or restored, and writes
`<stem>.review.md` beside it on those edits and on the **Copy Notes as
Markdown** action, all without a save dialog. These are the silent writes in the
video preview; the precedent is the PDF preview's `<file>.pdf.mccomments.json`.

- **The path is the host's.** Both names come from the open document's own file
  name and folder. The webview's `reviewEnable` and `reviewCopy` messages carry
  no data, so the page cannot name a path, a content or a destination.
- **Only on an explicit action, from a valid file.** Nothing is written on open
  or when the file changes. Copy re-reads the sidecar, and a missing, invalid or
  non-version-1 file is refused with an error. An edit also re-reads the sidecar
  and is refused when it is read-only (parse or schema failure, another
  version); the sidecar is never overwritten in that state. Only the first note
  on a video with no sidecar creates one.
- **Edit messages are validated on the host.** `reviewAdd`, `reviewDelete`
  and `reviewRestore` carry data from the page, so each is
  checked before any write (`reviewAddError`, `isReviewDelete`,
  `isReviewRestore`): extra fields refused, finite times with
  `out` after `at` and both within the duration plus one frame when it is
  known, note text a string of at most 10,000 characters, an optional pin
  (`point`) of two finite numbers from 0 to 1, and ids that exist in the file
  just read. Ids and timestamps are made by the host. Edits run one at
  a time through a queue, so a second cannot act on a stale read.
- **Edits touch only what they change.** The new text is a splice of the
  original file, not a re-serialisation, so fields MarkCopy does not edit are
  kept byte for byte (see [ARCHITECTURE](../docs/ARCHITECTURE.md#video-review)).
- **Parsed as data.** The sidecar is parsed with the `yaml` package and checked
  against the review schema (unknown fields rejected, numbers finite, version 1
  only); the text of a note is rendered as text, never as HTML.
- **No half files.** The sidecar and the Markdown each go to a dot-prefixed
  temporary file in the same folder and are renamed over the target; the temporary file is deleted if
  either step fails. A copy replaces an existing `<stem>.review.md`, and a file
  by that name is derived output, never read back.
- **A watcher on the sidecar** only re-reads it, through a `RelativePattern` on
  the video's folder, and is disposed with the panel.
- **The clipboard is written by the host** (`vscode.env.clipboard`), not by the
  page. Marker desktop does not re-read its notes before saving, so editing one
  video in both tools at once can lose notes; this is data loss, not a security
  boundary.

## Word export

Save as Word converts the sanitized, serialized preview XHTML in memory and
writes the resulting `.docx` only after the user chooses a destination. The
host parser uses the same XML handling as the workbook reader, so DTD entity
expansion and XXE are not enabled. Images are accepted only as validated PNG,
JPEG, or GIF data, and unsupported or remote image sources are skipped by the
host rather than embedded. Remote images may still have been fetched by the
preview webview while the export clone was being prepared.

Links are preserved as external Word relationships. Opening an exported file
in Word or another office application may therefore follow those links or
prompt for network access; exporting does not make linked content trusted.

Table spans are untrusted input. DOMPurify keeps `colspan` and `rowspan`
attributes verbatim, the browser's clamp applies to the DOM property rather
than to the attribute the serializer copies out, and both the Word and the
PowerPoint writer expand a table into one output cell per grid position. A raw
`<td colspan="10000">` in Markdown therefore used to reach the host as ten
thousand grid columns of synchronous XML building. `src/ooxml/tableLimits.ts`
is the shared guard: spans are read as plain positive integers (anything else
means 1, as in a browser; leading zeros carry no value, so `0000000002` is 2)
and clamped to the browser's own limits (1,000 columns, 65,534 rows), with a
value of more than nine significant digits clamped to the limit rather than
parsed. A table whose grid would exceed 1,000 columns or 250,000 cells is
replaced by a note in the document and counted in the export summary before
either writer starts expanding it, and the column count itself stops as soon as
the table passes either limit instead of expanding further.

## Word preview

A `.docx` is the same hostile-input surface as a workbook or deck, and `src/docx/read/` reads it in the extension host under the same guards: the guarded unpacker in `src/ooxml/zip.ts` (256 MB file, 1,000 entries, 64 MB per inflated part, 256 MB total), the saxes parser that never expands a DTD entity, and the same DOMPurify pass and CSP in the webview. Beyond that:

- **Links are filtered by scheme.** Only `http`, `https`, and `mailto` become a link; `file:`, `javascript:`, `ftp:`, a UNC path, and a relationship that is not marked external are shown as plain text. The hostile part of a hyperlink is its target, and `readExternalRels` is the only place an external relationship is read; the target is never fetched, only shown as a link the reader clicks.
- **Images are never fetched.** An embedded picture is read from the package and sent to the webview beside the markup, base64 in its own `media` messages, each distinct part once (128 MiB total, 32 MiB per image; past that a picture is a placeholder). The markup carries only a `data-mc-media` reference, and the webview (`src/webview/ooxmlMedia.ts`) accepts an item only with a well-formed id and a MIME type from the reader's own table before turning it into a `blob:` URL; a linked picture (`r:link`) is a placeholder, so opening a document cannot make a network request or leak credentials to a share.
- **Output is escaped.** Every piece of text is HTML-escaped and every attribute value is attribute-escaped before it reaches the preview. Bookmark names become element ids with a fixed prefix and a restricted character set.
- **Bounded work.** Style `basedOn` chains are cycle-safe and capped, table nesting is capped, and the walk stops at a paragraph budget. Generated output has its own document-wide budget (16 MiB): every chart table is charged against it per reference, not once per unique part, so a document that repeats one chart cannot multiply the preview's size; once it is spent, the extras become placeholders and the preview says so. An image reference is a short attribute, so repeating a picture costs nothing beyond its one copy. Equation text is capped at 100,000 characters before conversion, and an oversized equation is dropped. A crafted document therefore costs a bounded amount of time and memory.
- **Parts read.** Beyond the body, styles, numbering, and notes, the reader opens the header and footer parts a section names, `comments.xml` and `commentsExtended.xml`, and the chart parts the body references, always through the guarded unpacker. Header, footer, and comment content goes through the same escaping as the body, and a chart is drawn only from its cached values (no embedded workbook is opened). Each is bounded by the paragraph budget, a text box nesting limit, and chart row and series caps, and a malformed part is skipped rather than failing the preview.
- **Read-only.** The preview never writes to the document, and macros in a `.docm` are not read, let alone run.

## Executable info preview

An executable is the most hostile file MarkCopy opens, so the preview is built around not doing anything with it. `src/pe/` reads a `.exe`, `.dll`, `.sys`, `.ocx`, `.scr`, `.cpl` or `.efi` in the extension host as bytes and nothing else: the file is never run, loaded, mapped or handed to the OS. Beyond the DOMPurify pass and CSP in the webview:

- **"Open in Default App" is removed.** For an executable the default app is the file itself, so opening it that way would run it. The webview hides the row for this kind, and the host ignores the `openExternal` message for this preview (`opensInDefaultApp` in `src/ooxmlEditor.ts`), so a page that posts it anyway launches nothing.
- **Reads are ranged and bounded.** A file on disk is read in ranges through a file handle, so its size never becomes the size of a buffer. Every offset the file supplies is checked against its real size, every table has a cap, and the reader will touch at most 16 MiB of any one file, so a hostile or truncated file yields a notice or a per-table warning, not a crash or an unbounded allocation. A file on a virtual or remote file system is read whole and refused above 64 MB. The SHA-256 is computed only up to 256 MB.
- **Strings are cleaned and escaped.** Text from the file (version strings, names, paths, signer names) has control and bidirectional-override characters removed, so a name cannot be displayed as another, is HTML-escaped, and is sanitized again by the webview.
- **The icon is re-encoded or size-checked.** A bitmap icon is decoded in the host under the format's own limit of 256 pixels a side and sent as a PNG the host wrote. An icon that is already a PNG is sent as is only when its header states at most 1024 pixels a side, and is then decoded by the webview like any image in a Word document.
- **The signature is not verified.** The preview reports that an embedded Authenticode signature is present and the signer, organization, issuer and validity dates the file names. It does not verify the signature, the hash, the chain, revocation or expiry, and the page says so. These are claims the file makes about itself, not a verdict on whether to trust it.
- **Read-only.** The preview never writes to the file.

## Package info preview

A package or installer is a file whose purpose is to run code on a machine, so the preview is built around not doing anything with it. `src/pkg/` reads a `.deb`, `.udeb`, `.rpm`, `.msi`, `.dmg`, `.pkg`, `.apk`, `.jar`, `.war`, `.ear`, `.vsix`, `.whl`, `.nupkg`, `.snupkg`, `.so`, `.elf`, `.ko`, `*.so.*` or `.AppImage` in the extension host as bytes and nothing else: the file is never installed, run, mounted, unpacked to disk or handed to the OS. Beyond the DOMPurify pass and CSP in the webview:

- **"Open in Default App" is removed.** The default app for a package is an installer, and for a `.jar` or an AppImage it is the file itself, so opening it that way would run it. The webview hides the row for this kind, and the host ignores the `openExternal` message for this preview (`opensInDefaultApp` in `src/ooxmlEditor.ts`), so a page that posts it anyway launches nothing.
- **Reads are ranged and bounded.** A file on disk is read in ranges through a file handle by the shared `RangeReader` (`src/binary/reader.ts`): 64 KiB pages, a budget of 32 MiB of them per file (16 MiB for an executable), and a 16 MiB limit on any single read. Every offset the file supplies is checked against its real size, and every table and loop has a named cap, so a hostile or truncated file yields a notice or a warning, not a crash or an unbounded allocation. A file on a virtual or remote file system is read whole and refused above 64 MB. The SHA-256 is computed only up to 256 MB.
- **The format comes from the bytes.** `readPackage` picks a reader from the file's leading bytes (and a disk image's trailer), not its extension, and a file that is none of them gets a notice.
- **Decompression is bounded.** Only a Debian package's control archive (gzip, xz or zstd) and the front of an Alpine package are inflated, and a zip entry only up to the caller's cap. Every helper in `src/pkg/decompress.ts` is capped on both the compressed input and the output and stops as soon as the output reaches the cap, so a small file that expands to gigabytes ends in an error, not an out-of-memory. Data archives and payloads are never decompressed.
- **What a reader may allocate is bounded, not only what it may read.** A cap on how many strings a table holds bounds nothing if each may be long, or if one string is named by every entry. An audit on 2026-11-23 found six files, from 250 bytes to 2 MB, that each took the extension host past 4 GB and aborted it (an Android manifest whose string pool named one 16 KB string 100,000 times, a Windows Installer Property table, two RPM header shapes, a macOS installer's directory name, and a Zstandard frame declaring a 1.9 GiB window behind frames the check did not look past), and several that only held it for seconds. Every reader now follows the same rules: a string from the file is cut to a named cap before it is cleaned or kept; a string addressed by index or offset is decoded once and shared; where a count multiplies a size there is a cap on the total; nothing is built in full to take one element or to count; and every Zstandard frame and gzip member is checked, not the first. XML is parsed by `src/binary/xml.ts` under a budget of elements and depth, because a tree costs about a hundred times its text. Behind all of them, `bound()` in `src/pkg/index.ts` cuts any reader's result to a page of at most a megabyte of text before it is rendered, and a cell is clipped when drawn. The root of the largest cases was in the shared text cleaner, which appended a character at a time: the engine keeps such a string as a chain of nodes of about 32 bytes each until it is flattened, so cleaning a string cost thirty times its length.
- **Scripts are never shown or run.** The page says only that maintainer scripts, scriptlets, custom actions or build scripts exist, since that is what tells a reader an install will run code.
- **Strings are cleaned and escaped.** Text from the file has control and bidirectional-override characters removed, so a name cannot be displayed as another, is HTML-escaped once in `src/binary/html.ts`, and is sanitized again by the webview. Entry names from an archive are only displayed, never used as a path.
- **Signatures are not verified.** The page reports who the file names as its signer (a certificate name, or for an RPM an OpenPGP key ID) and that nothing was checked: not the signature, the hash, the chain, revocation or expiry. An Android package signed only with scheme v2 or later shows the scheme without a signer. These are claims the file makes about itself, not a verdict on whether to trust it.
- **Two runtime dependencies were added.** `fzstd` (zstd decompression) and `xz-decompress` (xz decompression, with WebAssembly embedded in the package) are both MIT licensed and have no dependencies of their own. They are used only for a Debian package's control archive, and both run under the output cap above.
- **Read-only.** The preview never writes to the file.

## CSV grid and cell editing

A CSV or TSV file is parsed in the extension host and emitted as an HTML table. Every cell value is HTML-escaped on the way out, and the result still passes through the same DOMPurify sanitize step and CSP as Markdown, so a cell containing `<img src=x onerror=...>` renders as that literal text.

The grid's size is bounded on every axis and on their product. Every row is padded out to the widest record, so a header of a few thousand fields over many one-field rows would multiply a small file into a cell for every row/column pair. `markcopy.csv.maxRows` caps rows, `markcopy.csv.maxColumns` caps columns, and `CSV_MAX_CELLS` in `src/csv.ts` caps the total the grid draws, all applied before any markup is built. Only trailing columns are cut, so a cell's position in its row is still its field's position in the record and the editing coordinates below stay honest.

Cell editing is the one place MarkCopy writes to a file rather than only reading one, so it is deliberately narrow:

- An edit only ever happens in response to a user action in the grid, and only against the document currently being previewed. The webview cannot name a different file: it sends a line, a column, and a value, and the host resolves those against the previewed document's URI.
- The host re-parses the document itself to locate the field, rather than trusting offsets from the webview, and rejects the message outright if the field, the line, or the value is not the expected shape.
- Edits are applied as a `WorkspaceEdit`, so they are ordinary undoable editor changes and respect read-only files rather than writing to disk directly.
- The render carries a document version that the grid echoes back; a mismatch drops the edit instead of applying it against stale line numbers.
- Only the edited field's own source span is replaced, so an edit cannot rewrite or reformat any other part of the file.

## Markdown block editing

Edit mode in the Markdown preview is the second place MarkCopy writes to a file, under the same rules as cell editing: the webview names lines and text, never a file; the host applies a `WorkspaceEdit` to the previewed Markdown document only, so edits are undoable and respect read-only files, and nothing is saved automatically. The host validates the `editBlock` message itself (integer lines with `0 <= startLine < endLine <= lineCount`, string fields, text capped at 1,000,000 characters, and a `docKey` that must equal the document the preview currently shows, so an edit in flight when a side preview is retargeted cannot land in the new file) and refuses the edit unless the document's current text for those lines equals the `original` the webview started from, so a stale editor cannot overwrite a newer change. The editor backdrop is built from HTML-escaped pieces only, and the rendered preview still goes through DOMPurify unchanged.

## Spreadsheet preview

An `.xlsx` is a zip of XML parts, which makes it a hostile-input surface before a single tag is parsed. `src/xlsx/` reads it in the extension host, never in the webview, and the resulting HTML goes through the same DOMPurify sanitize and the same CSP as everything else.

- **Decompression is bounded.** A few hundred kilobytes on disk can inflate to gigabytes in memory, so `src/ooxml/zip.ts` caps the file size before unzipping (256 MB, the same as the inflate total, and the only bound on an entry whose header understates its size), the entry count, the size of any single inflated part, and the running total across all of them. Nothing is ever written to disk, so a malicious entry name (`../../etc/passwd`, an absolute path) has nothing to act on: names are only ever map keys.
- **External relationships are refused.** A workbook can point outside its own package at another workbook on a share, a remote image, or a DDE/OLE link. Following one turns opening a file into a network fetch, which on Windows can hand your credentials to whatever host it names. Any relationship marked `TargetMode="External"` is dropped.
- **Entity expansion cannot happen.** The parser (saxes) resolves the five predefined XML entities and never expands entities declared in a DTD, so the classic billion-laughs expansion and XXE are inert here structurally rather than by a check that could be forgotten. A test pins this, so replacing the parser with one that does expand them fails the suite rather than the extension host.
- **The preview is read-only.** MarkCopy never writes to a workbook, so it cannot corrupt one. There is no equivalent of the CSV grid's cell writeback.
- **Formulas are never evaluated.** A cell showing a formula's result is showing the value the file already had cached; MarkCopy does not compute anything.
- **Column ranges are validated before they are expanded.** A `<col>` element's `min`/`max` is an inclusive range the reader walks to record widths and hidden columns. Both bounds have to be safe positive integers in order, and the range is intersected with `markcopy.xlsx.maxColumns` before the loop runs; a malformed element is skipped whole. Without this a negative `min` expanded thousands of columns left of A, and a `min` beyond the safe-integer range (where `c + 1 === c`) made the loop never advance and stalled the extension host for good.

## STL preview

A binary STL is an 80-byte header, a uint32 triangle count, then 50 bytes per triangle. The count is the file telling the parser how much memory to allocate, and Three.js's `STLLoader` believes it: it sizes its `Float32Array`s from that number without checking the file is large enough to hold that many triangles. An 84-byte file declaring `0xFFFFFFFF` triangles therefore asks for tens of gigabytes, which is a denial of service against the whole window from a file small enough to arrive in an email.

`checkStl()` in `src/webview/stlInfo.ts` runs before any allocation. Its binary-versus-ASCII classification is a byte-for-byte restatement of the pinned `STLLoader`'s own test (a length matching the header's count is binary; otherwise lowercase `solid` at offsets 0 through 4 is ASCII; anything else is binary), and it has to stay one: the binary guards below apply to what `checkStl()` calls binary, the loader allocates from the header count on what _it_ calls binary, and any header the two classified differently was a file that skipped the guards. An earlier, friendlier sniff (case-insensitive, leading whitespace allowed, `facet` required) let `SOLID facet` pass as ASCII and reach the loader as binary. A test runs the same fixtures through the real loader to keep the two in agreement. It refuses three shapes:

- **A count the file cannot back.** If `84 + triangles * 50` exceeds the actual byte length, the file is corrupt or crafted and is rejected with a message in the panel. This is the amplification case above.
- **A count above `MAX_TRIANGLES` (~5.4 million).** A self-consistent 256 MB model is not an attack, but it is not something to hand a WebGL context either.
- **A file above `MAX_STL_BYTES` (256 MiB).** This one applies to ASCII as well as binary. ASCII STL cannot amplify, because it is parsed facet by facet and bounded by the real file length, but bounded is not the same as small: a multi-gigabyte ASCII file is still a frozen webview. `MAX_TRIANGLES` is derived from this cap so the two can never drift apart.

The size check runs in the extension host, off `stat`, before the file is read. Everything else runs on the bytes the host has read, still in the host, before they are base64-encoded and sent. The webview re-checks on arrival: the host-side pass is about not doing pointless work, the webview-side pass is the actual guard on the allocation.

The byte cap is set by the transport, not the renderer. The host ships the file as base64, and Node's maximum string length (536,870,888) means `Buffer.toString('base64')` throws above roughly 384 MiB of input. A cap above that would let a file pass every check and then fail in the host with a string-length error, which reads to the user as MarkCopy refusing a file it had just accepted.

The message payload is treated as untrusted too, separately from the file. The host sends base64 rather than a `Uint8Array` because `webview.postMessage` JSON-encodes, and JSON turns a typed array into a numeric-keyed object roughly 13x the size. `toBytes()` decodes it, and its fallback branches never size an allocation from an unvalidated `length`: a bare `{length: n}` is refused rather than expanded into `n` zero bytes, and a numeric key past the payload cap returns empty rather than throwing `RangeError` or reserving gigabytes.

Both guards are pure functions with no DOM or Three.js dependency, unit-tested in `tests/stlInfo.test.ts`, which is why they can be asserted at all. As with the PDF viewer, the editor is read-only, the bytes come from `workspace.fs.readFile`, and nothing is fetched over the network.

## Clipboard

Copy actions only ever write to the clipboard, and only in response to a user action (a menu click or command). MarkCopy never reads the clipboard. The STL viewer has no copy actions at all: a triangle soup has nothing meaningful to put on a clipboard.

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than opening a public issue.

- **Preferred:** GitHub private vulnerability reporting. Open the repository's Security tab and choose **Report a vulnerability**, or go straight to <https://github.com/owenpkent/markcopy/security/advisories/new>. The report stays private between you and the maintainer, and a fix can be developed in a private fork.
- **Alternative:** the contact form at <https://www.owenpkent.com/>, if you do not want to use GitHub.

Include the VS Code version, OS, a minimal reproducing file (`.md`, `.csv`, `.tsv`, `.xlsx`, `.pptx`, `.docx`, `.pdf`, `.tex`, `.stl`, a video such as `.mp4`, or `.gif`), and the observed behavior.

### Response times

- **Acknowledgement:** within 3 business days.
- **Target fix:** within 30 days for anything exploitable by opening a file, and within 90 days for everything else. If a fix will slip past its target, the reporter is told why and given a new date.

### Advisories

Each fixed security issue gets a GitHub Security Advisory, and a CVE is requested from GitHub, which is a CVE Numbering Authority. The advisory is published once the fixed release is live on both the VS Code Marketplace and Open VSX, so the fix is available before the details are. The CHANGELOG's Security entry for that release links the advisory. The reporter is credited unless they ask not to be. See [RELEASING](../docs/RELEASING.md#phase-2-publish-to-the-registries) for the publishing step.

## GIF preview

The GIF viewer reads the file on the extension host (refusing anything above
64 MiB before it is read) and posts it to the webview as base64, where it is
parsed by a small header scanner in `src/webview/gifInfo.ts` and decoded by
Chromium's `ImageDecoder`. The scanner never decodes pixels, bounds every read
by the buffer's length, and advances on every step, so malformed input ends the
scan rather than looping. The CSP is `default-src 'none'` with `img-src`
limited to the webview origin, `blob:`, and `data:`, `style-src` and `font-src`
limited to the webview origin (plus inline styles), and a bare nonced
`script-src`; there is no `media-src`, `connect-src`, or `worker-src`. The
webview may ask the host to save a PNG frame (through a save dialog), open the
document in the default app, reveal it, or write `markcopy.theme`; the host
checks the setting key and value against an allowlist of that one setting. As
with video, the browser's decoder still processes the file, so a malformed GIF
could consume resources or trigger a vulnerability in the host's Chromium build.

## Image preview

The image viewer reads the file on the extension host (refusing anything above
64 MiB before it is read) and posts it to the webview as base64. A small header
parser in `src/webview/imageInfo.ts` reads the magic bytes and reports the
type, and the webview builds a `Blob` from that sniffed type, never from the
file extension; bytes it does not recognise are shown as an error rather than
handed to the decoder. The parser reads only the header, bounds every read by
the buffer's length, and never allocates in proportion to a size the file
declares. An SVG is drawn only through an `<img>` element: it is never parsed
into the page or inlined, so it runs no script and loads no external resource.
It reaches the `<img>` as a `data:image/svg+xml;base64,` URL rather than a Blob
URL (so an SVG with `<foreignObject>` can still be exported to PNG); that is
still an image load under the same restrictions. A UTF-16 SVG is decoded with
`TextDecoder` only, for sniffing and for **Copy SVG Source**.
The CSP, unchanged by this, is `default-src 'none'` with `img-src` limited to the webview origin,
`blob:`, and `data:`, `style-src` and `font-src` limited to the webview origin
(plus inline styles), and a bare nonced `script-src`; there is no
`connect-src`, `media-src`, or `worker-src`. The webview may ask the host to
save a PNG (through a save dialog), open the document in the default app,
reveal it, step to the previous or next image in the folder (`navigate`), edit
its Image Notes (below), or write `markcopy.theme`, `markcopy.image.background`
or `markcopy.image.review`; the host checks the key and value against an
allowlist of those three settings. `navigate` carries only a step of 1 or -1:
the host lists the folder itself, keeps the extensions the editor claims, and
opens the neighbour, so the page cannot name a file. The host
also watches the opened file (a `FileSystemWatcher` on its folder and exact
base name, with glob characters escaped so the name matches literally) and
reloads it when it changes; the watcher reads that same URI and nothing the
webview names. As with
GIF, the browser's decoder still processes the file, so a malformed image could
consume resources or trigger a vulnerability in the host's Chromium build. The
parser and the message validator are unit-tested and fuzzed (see
[Fuzzing](../docs/TESTING.md#fuzzing)).

### Image Notes

Image Notes is the video preview's review mode applied to a still picture, and
its rules are the ones listed under [Video preview](#video-preview): the same
`NotesSession` (`src/review/session.ts`) does the reading and writing. The
sidecar is `<full file name>.review.yaml` (`photo.png.review.yaml`), with
`photo.png.review.md` beside it, and both names come from the open document, not
from the page. `reviewEnable` and `reviewCopy` carry no data. `reviewAdd`,
`reviewDelete` and `reviewRestore` are checked on the host before any write
(`imageReviewAddError` in `src/review/validate.ts`): extra fields refused, at
most one of a `point` (two finite numbers from 0 to 1) and a `region` (four
finite numbers, a positive size, inside the picture), text of at most 10,000
characters, and ids that exist in the file just read. Writes are silent, atomic
(a temporary file renamed over the target) and queued; nothing is written on
open; and a file that is not an image review (a video's, another version, broken
YAML) is shown read-only and never overwritten. Two panels on one image share
one edit queue, so neither can act on a stale read of the other's change.
