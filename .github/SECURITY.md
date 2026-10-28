# Security

## Dependency monitoring

Dependabot security alerts and automatic security update pull requests are enabled.
Weekly version updates are configured in `dependabot.yml`, with compatibility
exclusions for dependencies tied to the project's Node and VS Code versions.

`npm audit` is clean as of the move to `@vscode/vsce` 4 and `ovsx` 1.3 on Node 22.
That removed the only advisory with no fixed release, `braces`
(GHSA-vfj7-8cjw-p6xm), which vsce 3 reached through `secretlint`, `globby`,
`fast-glob` and `micromatch` and which `ovsx` 1.2 pulled in again through its
nested vsce 3. None of that chain was ever bundled into the extension. Check
`npm audit` again after any dependency change.

The `package.json` overrides for `@vscode/test-cli` replace vulnerable versions of
`diff` and `serialize-javascript` used by its nested Mocha 11 dependency. Remove
these overrides when the CLI resolves patched versions without them. The direct Mocha
dependency uses version 12 and does not need these overrides.

The `package.json` override for `mermaid` makes it use the project's own `katex`
(`"$katex"` resolves to the direct dependency's version) instead of a nested copy
from its `^0.16` range. This keeps one KaTeX version in the lockfile, so Mermaid's
math labels use the same markup as the KaTeX CSS the preview loads, and the webview
build emits one KaTeX chunk instead of two. Remove this override when Mermaid's own
`katex` range includes the project's version.

## Threat model

MarkCopy renders untrusted content (any Markdown, CSV/TSV, spreadsheet, Word document, presentation, PDF, or STL model you open) into a webview. It can render Mermaid diagrams from fenced code, parses PDFs with pdf.js, and parses STL meshes with Three.js, and decodes GIFs with the browser. The areas that matter are script execution in the preview, diagram rendering, PDF parsing, unpacking and parsing a workbook, parsing a mesh whose header declares its own size, writing an edited CSV cell back to the file, and running a browser to render a PDF export.

LaTeX preview adds a more privileged parser boundary: it runs an installed TeX
engine against the opened source and its included files. Video and GIF previews hand
media to Chromium and can optionally run ffprobe and ffmpeg. Word export parses
webview-produced XHTML and writes an OOXML package, including external links.

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

The STL preview is the most restrictive of the six webview surfaces (shared preview, PDF, LaTeX, video, GIF, and STL): `default-src 'none'`, a bare nonced `script-src`, and `style-src` / `font-src` scoped to `${cspSource}`, with no `img-src`, `connect-src`, `worker-src`, or `media-src` at all. It draws into a WebGL canvas from bytes the extension supplies and has nothing to fetch. The video preview sits between the two: `media-src ${cspSource} blob:` for the `<video>` element and `img-src ${cspSource} blob: data:` for frame capture, but still no `connect-src` or `worker-src` (see [Video preview](#video-preview)).

## Mermaid

Mermaid is initialized with `securityLevel: 'strict'`, which sanitizes diagram-supplied HTML and blocks click bindings from diagram source. A diagram that fails to parse renders an inline error message rather than executing anything.

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

The video webview receives a VS Code webview resource URI rooted at the video's own
directory and uses a CSP with `media-src` limited to that origin and `blob:`;
it does not fetch arbitrary network media. The browser's media demuxer and
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

A `.docx` is the same hostile-input surface as a workbook or deck, and `src/docx/read/` reads it in the extension host under the same guards: the guarded unpacker in `src/ooxml/zip.ts` (25 MB file, 1,000 entries, 64 MB per inflated part, 256 MB total), the saxes parser that never expands a DTD entity, and the same DOMPurify pass and CSP in the webview. Beyond that:

- **Links are filtered by scheme.** Only `http`, `https`, and `mailto` become a link; `file:`, `javascript:`, `ftp:`, a UNC path, and a relationship that is not marked external are shown as plain text. The hostile part of a hyperlink is its target, and `readExternalRels` is the only place an external relationship is read; the target is never fetched, only shown as a link the reader clicks.
- **Images are never fetched.** An embedded picture is read from the package and inlined as a `data:` URI (16 MiB total budget, charged for every reference, so a picture repeated many times cannot multiply the preview's size); a linked picture (`r:link`) is a placeholder, so opening a document cannot make a network request or leak credentials to a share.
- **Output is escaped.** Every piece of text is HTML-escaped and every attribute value is attribute-escaped before it reaches the preview. Bookmark names become element ids with a fixed prefix and a restricted character set.
- **Bounded work.** Style `basedOn` chains are cycle-safe and capped, table nesting is capped, and the walk stops at a paragraph budget. Generated output has its own document-wide budget (16 MiB): every image reference and every chart table is charged against it, not just each unique part once, so a document that repeats one picture or chart cannot multiply the preview's size; once it is spent, the extras become placeholders and the preview says so. Equation text is capped at 100,000 characters before conversion, and an oversized equation is dropped. A crafted document therefore costs a bounded amount of time and memory.
- **Parts read.** Beyond the body, styles, numbering, and notes, the reader opens the header and footer parts a section names, `comments.xml` and `commentsExtended.xml`, and the chart parts the body references, always through the guarded unpacker. Header, footer, and comment content goes through the same escaping as the body, and a chart is drawn only from its cached values (no embedded workbook is opened). Each is bounded by the paragraph budget, a text box nesting limit, and chart row and series caps, and a malformed part is skipped rather than failing the preview.
- **Read-only.** The preview never writes to the document, and macros in a `.docm` are not read, let alone run.

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

- **Decompression is bounded.** A few hundred kilobytes on disk can inflate to gigabytes in memory, so `src/ooxml/zip.ts` caps the file size before unzipping (25 MB), the entry count, the size of any single inflated part, and the running total across all of them. Nothing is ever written to disk, so a malicious entry name (`../../etc/passwd`, an absolute path) has nothing to act on: names are only ever map keys.
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

Please report suspected vulnerabilities privately via the contact form at <https://www.owenpkent.com/> rather than opening a public issue. Include the VS Code version, OS, a minimal reproducing file (`.md`, `.csv`, `.xlsx`, `.pdf`, or `.stl`), and the observed behavior. You will get an acknowledgement and a fix timeline.

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
