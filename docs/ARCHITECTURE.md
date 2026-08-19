# Architecture

MarkCopy is a custom-webview VS Code extension that previews five kinds of document through three webviews. Markdown, CSV/TSV, and spreadsheets share one: the Node extension host renders each to HTML (`markdown-it`, `src/csv.ts`, and `src/xlsx/` respectively) and the webview displays it. PDF and STL each have their own, where the host only supplies bytes and the rendering happens in the webview (pdf.js, and Three.js). In all of them, interaction (context menu, clipboard, Mermaid, PNG capture, CSV cell editing) happens in the webview. This split is deliberate: the webview is a browser context, and the clipboard operations we need (writing `text/html`, capturing PNGs) only exist there.

## Big picture

```
 ┌──────────────────────────┐        postMessage        ┌───────────────────────────┐
 │  Extension host (Node)    │  ───────────────────────► │  Webview (browser/iframe) │
 │  src/extension.ts         │   render / scrollToLine / │  src/webview/main.ts      │
 │  src/render.ts (markdown) │   copyAll                 │  media/preview.css        │
 │  src/csv.ts    (csv/tsv)  │  ◄─────────────────────── │                           │
 │  markdown-it, highlight.js│   revealLine / toast /    │  Mermaid, html-to-image,  │
 │  source-line mapping      │   ready                   │  context menu, clipboard  │
 └──────────────────────────┘                           └───────────────────────────┘
        dist/extension.js                                        media/webview.js
        (esbuild.js, node)                                   (esbuild.web.js, browser)
```

All three take the same path. The host decides how to turn the open document into
HTML (`markdown-it` for Markdown, `src/csv.ts` for CSV/TSV, `src/xlsx/` for a
workbook) and sends it in the same `render` message with a `kind` field; the
webview sanitizes the HTML, picks its layout from `kind`, and otherwise treats
them identically. That is why the context menu, the clipboard actions, the themes,
the PDF export, and scroll sync all work on a CSV grid or a spreadsheet sheet
without knowing what it is. A workbook reaches that same webview from a custom
editor rather than from `update()`, because it is binary and never becomes a
TextDocument (see [Spreadsheet preview](#spreadsheet-preview)).

The PDF preview uses the same host/webview split with its own custom editor and bundle:

```
 ┌──────────────────────────┐        load (bytes,        ┌───────────────────────────┐
 │  Extension host (Node)    │        workerSrc)          │  PDF webview (browser)    │
 │  src/pdfEditor.ts         │  ───────────────────────► │  src/webview/pdf.ts       │
 │  workspace.fs.readFile    │  ◄─────────────────────── │  pdf.js + module worker   │
 │  (CustomReadonlyEditor)   │        ready / toast       │  canvas render, copy      │
 └──────────────────────────┘                           └───────────────────────────┘
        dist/extension.js                          media/pdf.js + media/pdf.worker.js
```

Five entry bundles (plus the Markdown webview's lazily-loaded `media/chunk-*.js` files) are produced from one TypeScript source tree by two esbuild scripts:

- `esbuild.js` bundles `src/extension.ts` to `dist/extension.js` for Node (`vscode` left external).
- `esbuild.web.js` bundles the browser code: `src/webview/main.ts` to `media/webview.js` as an ES-module, code-split build (Mermaid, KaTeX, html-to-image, and Turndown load lazily via dynamic `import()` as separate `media/chunk-*.js` files, only when first needed; DOMPurify stays eager), `src/webview/pdf.ts` plus the pdf.js worker to `media/pdf.js` and `media/pdf.worker.js` (esm), and `src/webview/stl.ts` to `media/stl.js` (esm, Three.js bundled in). Code-splitting drops the initial `media/webview.js` from roughly 8.5MB to about 19KB, since the heavy libraries are only fetched on demand (a diagram or equation present, Copy as PNG, Copy as Markdown).

See [PDF preview](#pdf-preview) below for the PDF data flow in detail.

`tsc --noEmit` type-checks the whole tree; esbuild does the actual transpiling and bundling. `tsconfig.json` uses `module: ESNext` and `moduleResolution: Bundler` so the ESM-only dependencies (Mermaid, markdown-it-anchor) type-check cleanly.

## File map

| File                             | Role                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`               | Activation, command registration, webview panel lifecycle, the host half of two-way scroll sync, PDF export orchestration, host side of the message protocol.                                                                                                                                                                                                          |
| `src/render.ts`                  | The shared `markdown-it` instance: GFM options, highlight.js, anchors, Mermaid fence placeholders, `markdown-it-texmath` math placeholders, source-line mapping, and the `env.resolveImage` image-src hook.                                                                                                                                                            |
| `src/preview-utils.ts`           | Pure, VS Code-independent helpers: `localImageRef` (classifies an image `src` so the host knows whether/how to rewrite it), `previewKind` (which renderer a document gets, by language id with a file-extension fallback), and `shouldAutoPreview` (the auto-open/retarget decision). Kept out of `extension.ts` so they're unit-testable without the `vscode` module. |
| `src/csv.ts`                     | CSV/TSV support on the host: an RFC 4180 parser (quoted fields, embedded delimiters/newlines, BOM, CRLF/LF/CR, per-record source lines, a row cap that still counts what it skipped), delimiter sniffing biased by the document's own type, and the grid HTML. Pure, unit-tested.                                                                                      |
| `src/webview/main.ts`            | Everything in the preview: rendering the HTML, Mermaid, KaTeX (`renderKatex`), building the Markdown preview's context-menu entry tree (see [Context menu](#context-menu)), all clipboard writes, PNG capture, inline styling, HTML-to-Markdown (Turndown), scroll sync.                                                                                               |
| `src/webview/menu.ts`            | The shared context-menu engine (`MenuEntry`, `MenuController`, `createMenu`) used by both webviews: panel rendering, submenu nesting, and keyboard navigation (see [Context menu](#context-menu)).                                                                                                                                                                     |
| `src/webview/scrollSync.ts`      | The anchor interpolation behind two-way scroll sync (`offsetForLine`, `lineForOffset`, `sample`). Pure, unit-tested (see [Scroll sync](#scroll-sync)).                                                                                                                                                                                                                 |
| `src/pdfExport.ts`               | Save as PDF on the host: locating a headless Chromium-family browser, its `--print-to-pdf` command line, running it, and assembling the export page and its print stylesheet. No `vscode` import, so it is unit-testable (see [PDF export](#pdf-export)).                                                                                                              |
| `src/pdfEditor.ts`               | The read-only custom editor for `.pdf`: builds the webview, reads file bytes, hands them to the PDF webview, and reads/writes the sidecar comments JSON file.                                                                                                                                                                                                          |
| `src/webview/pdf.ts`             | The PDF preview: virtualised pdf.js rendering (canvas + text layer, zoom, the page indicator with go-to-page, dark/green bitmap recolouring), per-page text extraction, comment pins, the copy actions (page PNG, page text, all text, selection), and building its context-menu entry tree (see [Context menu](#context-menu)).                                       |
| `src/webview/table.ts`           | CSV/TSV table serialization for the clipboard (RFC 4180). Skips cells marked `data-mc-ignore`, which is how the CSV grid's row-number gutter stays out of copies, and copies a grid's cell text verbatim (a Markdown table's is still trimmed). Pure, unit-tested.                                                                                                     |
| `src/webview/csvTable.ts`        | Drag-to-resize columns for the CSV grid: freezes the browser's computed widths onto the `<col>` elements on first drag and switches to `table-layout: fixed`, plus double-click auto-fit, keyboard resizing, and `resetColumnWidths`. Unit-tested against the real grid markup.                                                                                        |
| `src/webview/csvEdit.ts`         | Cell selection, arrow-key navigation, and inline editing for the CSV grid. A commit posts an `editCell` message instead of mutating the DOM (see [CSV editing](#csv-editing)). Unit-tested against the real grid markup.                                                                                                                                               |
| `src/previewShell.ts`            | The HTML document served to every webview that hosts the shared preview bundle: stylesheet links, the CSP (including the `'strict-dynamic'` the code-split chunks need), and the `#content` / `#mc-menu` / `#mc-toast` nodes. Shared by the Markdown/CSV preview and the spreadsheet editor, which differ only in the `data-vscode-context` webview id.                |
| `src/xlsxEditor.ts`              | The read-only custom editor for `.xlsx` / `.xlsm`: reads the file, renders the requested sheet, and posts it on the ordinary `render` message. Ships no webview bundle of its own (see [Spreadsheet preview](#spreadsheet-preview)).                                                                                                                                   |
| `src/xlsx/`                      | The OOXML reader, free of the `vscode` module and unit-tested: `zip.ts` (the OPC container and its size limits), `xml.ts` (a saxes pull-parsing layer), `workbook.ts` (sheets, the date system, shared strings), `styles.ts` (style index to number format, and applying it), `sheet.ts` (rows, cells, merges), `render.ts` (the grid HTML), `index.ts` (the entry).   |
| `src/webview/markdownConvert.ts` | HTML-to-Markdown conversion via Turndown. Pure, unit-tested.                                                                                                                                                                                                                                                                                                           |
| `tests/`                         | Vitest unit tests over the pure logic, including the shared menu engine (`tests/menu.test.ts`).                                                                                                                                                                                                                                                                        |
| `tests/webview/harness.ts`       | Boots the real preview bundle in jsdom and drives it: render, right-click, walk the menu, read the clipboard. Stands in for `execCommand`, `ClipboardEvent`, and layout, none of which jsdom has.                                                                                                                                                                      |
| `tests/e2e/`                     | Webview E2E over that harness: the context menu and its copy flavors, the sheet grid and tab strip, scroll sync. `harnessContract.e2e.test.ts` pins the harness's copies of the shell HTML and `SYNC_ECHO_MS` against their sources.                                                                                                                                   |
| `test-integration/`              | VS Code integration tests (Mocha + @vscode/test-electron), including which editor claims a `.xlsx` / `.xlsm` / `.pdf`.                                                                                                                                                                                                                                                 |
| `media/preview.css`              | GitHub styling, PDF layout, context menu (including `.mc-menu--sub`, `.mc-menu-item--submenu`, `.mc-menu-arrow` for nested submenu panels), toast, highlight.js token colors.                                                                                                                                                                                          |
| `src/stlEditor.ts`               | The read-only custom editor for `.stl`: builds the webview (its own self-contained HTML, not the shared shell, since the viewer has no copy menu), reads file bytes, and hands them to the STL webview as base64.                                                                                                                                                      |
| `src/webview/stl.ts`             | The STL preview: a Three.js scene with `OrbitControls` (mouse-only orbit/pan/zoom), `STLLoader` parsing, camera fit, the wireframe/grid toolbar, and the triangle-count and bounding-box overlay.                                                                                                                                                                      |
| `src/webview/stlInfo.ts`         | STL sniffing and the guards that run before `STLLoader` allocates: binary-vs-ASCII detection, the header triangle count, and `toBytes` normalizing whatever the message transport delivers. No DOM or Three.js dependency, so it is unit-tested (see [STL preview](#stl-preview)).                                                                                     |
| `esbuild.js` / `esbuild.web.js`  | The bundlers. `esbuild.web.js` emits `webview.js` (esm, code-split into `media/chunk-*.js`), `pdf.js` and `pdf.worker.js` (esm), `stl.js` (esm, Three.js bundled), and copies the KaTeX stylesheet and fonts into `media/katex/` (generated, gitignored).                                                                                                              |

## Rendering pipeline

1. The user opens the preview. `openPreview` creates a `WebviewPanel` (beside the editor, `retainContextWhenHidden: true`) and sets its HTML shell.
2. `update()` reads the document text, calls `md.render(source, { resolveImage })` (see [Local images](#local-images) below), and posts a `render` message carrying the HTML, the raw source, the active style profile, the theme (`markcopy.theme`), any `markcopy.mermaid` config, and the current `syncScroll` / `autoPreview` settings.
3. In the webview, `render()` sets `#content.innerHTML`, applies the style profile and theme to `body` (`dataset.style`, `dataset.mcTheme`), splits the source into `sourceLines` (used later for block "copy as Markdown"), (re)initializes Mermaid with the theme and any `markcopy.mermaid` config, then upgrades every Mermaid placeholder into an SVG and every math placeholder into a KaTeX render (see [Math (KaTeX)](#math-katex) below).
4. On each edit, `onDidChangeTextDocument` re-runs `update()`, so the preview is live. Those runs are coalesced over an 80ms window: a Markdown document is cheap to re-render per keystroke, but a CSV costs a delimiter sniff, a full parse, and a string-built grid of up to `markcopy.csv.maxRows` rows. A cell edit's own writeback calls `update()` directly instead, cancelling anything pending, so the grid learns the new document version without waiting out the debounce (see [CSV editing](#csv-editing)).

### Source-line mapping

`render.ts` tags top-level block tokens with `data-source-line` (the token's starting line). This attribute powers two features:

- **Scroll sync:** see [Scroll sync](#scroll-sync) below.
- **Block Markdown (the "Markdown" row under Copy as for a block):** for a clicked block, the webview finds its `data-source-line`, finds the next block's line, and slices `sourceLines` between them (verbatim source). The "Markdown" row under Copy as for a selection is different: it converts just the selected HTML to Markdown with Turndown (`turndown` + `turndown-plugin-gfm`), so partial and multi-block selections come through exactly.

### Scroll sync

Both directions map through the same structure: a list of `Anchor`s (`{ line, offset }`) pairing each `data-source-line` block with its offset in the scroll container. `src/webview/scrollSync.ts` holds the arithmetic, free of the DOM and unit-tested: `offsetForLine` and `lineForOffset` interpolate linearly between the two anchors bracketing their argument, so the sync tracks a drag continuously instead of snapping from one block to the next, and round-trips a position back to itself rather than drifting as the two surfaces bounce off each other. A synthetic final anchor pairs the end of the document with the container's maximum scroll, so the last screenful maps proportionally too. Measured anchors at or past that maximum are dropped first, since the preview keeps 120px of room to scroll past the end and a closing block sitting in it would otherwise leave the synthetic anchor unable to extend the list. For a grid truncated by `markcopy.csv.maxRows` the end is the last rendered row, not the file's last line, which would otherwise interpolate the final pixels across every unrendered row.

Anchors are measured once and cached, because a long document has hundreds of them and re-measuring every scroll frame costs a forced layout each time. The cache is dropped on render, on resize, and whenever the content's height changes underneath it (a late image, font, or diagram settling). Candidates over `MAX_ANCHORS` (600) are thinned by `sample()`: a 5000-row CSV grid contributes one candidate per row, and interpolating across a sampled subset is visually identical. A candidate is anything carrying `data-source-line`, which covers both layouts: `src/render.ts` puts one on each Markdown block, and `src/csv.ts` puts one on every grid body row. The grid's header row is excluded deliberately, since it is sticky and its position tracks the scroll rather than the content, so `csv.ts` omits the attribute there. An empty attribute value is skipped rather than read as line 0. The CSV layout also scrolls its own `.mc-csv-wrap` rather than the page, which `scroller()` accounts for.

The two surfaces drive each other, so every move one makes returns as a request to move the other. Two symmetric rules break the loop instead of letting them fight:

- The webview does not report a scroll it performed itself (`suppressSync` / `syncSuppressedUntil`), and drops an incoming `scrollToLine` that arrives within `SYNC_ECHO_MS` (250ms) of the reader's own scrolling, since it can only be the echo of what they are already doing.
- The host does not echo a visible-range change caused by its own `revealRange` (`revealEcho` / `revealedAt` in `extension.ts`).

`markcopy.syncScroll` gates both directions: `syncScrollEnabled()` is checked in the host's visible-ranges listener and again in `revealEditorLine`, so with the setting off neither surface follows the other.

### Local images

`render.ts`'s `rewriteImageSrc` routes every rendered `<img>` through an optional `env.resolveImage(src)` hook; when no hook is supplied (plain unit tests, for instance) the `src` passes through unchanged. In the running extension, `extension.ts` supplies that hook: `preview-utils.ts`'s `localImageRef` classifies the `src` first, so remote (`http(s):`), `data:`, `blob:`, and already-resolved URIs are left alone while relative and absolute paths are flagged for resolution. `resolveImageSrc` then resolves a flagged path against the document's URI and turns it into a webview-safe URI with `webview.asWebviewUri`. For that URI to actually load, the webview's `localResourceRoots` must cover the target folder, so `resourceRoots()` widens it to the document's workspace folder (or its own directory, if it isn't inside a workspace), and `openPreview` re-applies `panel.webview.options` whenever the previewed document changes.

### Math (KaTeX)

Math rendering mirrors how Mermaid diagrams are handled, so the same DOMPurify-adjacent path is reused rather than adding a second one. `render.ts` parses `$...$` and `$$...$$` with `markdown-it-texmath` (dollars delimiters, gated on `markcopy.math`) and emits inert placeholders instead of rendering KaTeX on the host: `<span class="mc-math" data-display="0">TeX</span>` for inline math and `<div class="mc-math" data-display="1" data-source-line="N">TeX</div>` for display math, with the raw TeX also stashed in `data-tex` for the copy actions. The webview's `renderKatex()` (in `src/webview/main.ts`) finds every `.mc-math` placeholder **after** DOMPurify has already sanitized the rendered HTML and calls `katex.render()` on its stored TeX, exactly mirroring the Mermaid placeholder-then-upgrade pattern. Keeping KaTeX's own markup out of the sanitizer path avoids DOMPurify stripping or fighting KaTeX's generated `<span>` soup.

Right-clicking an equation offers top-level **Copy Equation** (PNG, via `html-to-image`, reusing the existing `copyPng` path) and **Copy as > LaTeX** (rewraps the `data-tex` value in `$...$` or `$$...$$` depending on `data-display`). The "Markdown" row under Copy as, for either a selection or a block, also restores the original LaTeX for any equation in scope via a Turndown rule, instead of serializing the rendered KaTeX markup.

### Auto-open preview

`extension.ts` listens on `vscode.window.onDidChangeActiveTextEditor` and asks `shouldAutoPreview` (in `preview-utils.ts`) whether to open or retarget the preview. It requires the `markcopy.autoPreview` setting to be on, the focused document to be Markdown on an on-disk file (`scheme === 'file'`, so untitled buffers never trigger it), and the document to be absent from `dismissedPreviews`, a `Set` the extension keeps for documents whose preview the user closed this session. The preview opens with `preserveFocus: true` so the cursor stays in the editor. `panel.onDidDispose` adds the current document back to `dismissedPreviews` so a closed preview does not spring back open on the next focus change; an explicit `markcopy.openPreview` clears the dismissal for that document.

Because the extension activates on `onLanguage:markdown` (its only activation event), a Markdown editor that's already active when the extension activates never fires `onDidChangeActiveTextEditor`, since that event only fires on a _change_ of focus. `activate()` runs the same auto-preview check once more directly, against `vscode.window.activeTextEditor`, so the file that triggered activation gets a preview too, not just the next file you switch to.

Retargeting an existing preview to a different document is careful not to grow a third editor column. If VS Code opened the newly-focused Markdown file as a tab in the preview panel's own column (which it does when that column was the active group), `openPreview` moves that editor back to `ViewColumn.One` before retargeting. And revealing the retargeted preview always uses the panel's own existing `viewColumn`, never `ViewColumn.Beside`, so retargeting can't itself spawn a new column.

## Context menu

Both webviews build their right-click menu the same way. `src/webview/menu.ts` is a shared engine, exporting `MenuEntry`, `MenuController`, and `createMenu(root)`; `main.ts` and `pdf.ts` each call it with a tree of entries built for whatever the user clicked. Neither webview implements its own `showMenu` anymore: that logic (positioning, event handling, submenu panels, keyboard navigation) lives once in `menu.ts`, and `main.ts` / `pdf.ts` are reduced to building `MenuEntry[]` trees and wiring `run()` callbacks to the existing copy and settings functions. This replaced two near-duplicate `showMenu` implementations that used to live one in each file.

A `MenuEntry` is one of six kinds:

- `item`: a plain clickable action (`label`, `run`).
- `submenu`: a nested panel (`label`, `entries`), for example "Copy as" or "Preferences".
- `label`: a non-interactive group heading, used to split "Copy as" into per-context sections (for example `SELECTION` and `TABLE`) when more than one element is in scope.
- `divider`: a horizontal rule.
- `radio`: a mutually exclusive checked option (the Theme entries).
- `checkbox`: an independently toggled option (Sync scroll, Auto-open preview, Math).

`createMenu(root)` renders the root panel into the host page's `#mc-menu` div and appends nested submenu panels to `<body>` (class `mc-menu mc-menu--sub`) as they're opened, one panel per depth. `MenuController` tracks which panel is open at which depth and drives keyboard navigation: opening the menu focuses its first row (so the arrow keys work without tabbing in first, and because focusing a non-editable element leaves the document's text selection intact for the `Copy Selection` actions), ArrowUp/ArrowDown move within a panel, ArrowRight or Enter opens a highlighted submenu, ArrowLeft or Escape steps back out to the parent panel (or closes the menu entirely from the root), and Enter/Space activates the highlighted item, radio, or checkbox. New CSS in `media/preview.css` (`.mc-menu--sub`, `.mc-menu-item--submenu`, `.mc-menu-arrow`) styles the nested panels and the arrow glyph marking a row as a submenu. `tests/menu.test.ts` unit-tests the engine.

Three details of the engine exist because submenu panels are siblings of the root rather than descendants of the row that opened them. Nothing connects a row to its panel structurally, so `openSubmenu` names each end for the other (`aria-controls` on the row, `aria-labelledby` on the panel, both cleared on close) to keep the accessibility tree honest about where "Copy as, submenu, expanded" leads. The pointer path from a row to its panel is diagonal and clips the rows in between, so hovering a non-submenu row only _queues_ the dismissal of anything deeper, on a 150ms timer that reaching any panel cancels. And because panel chrome (padding, dividers, group headings) has no click behavior of its own, each panel swallows clicks that reach it, since the document-level handler both webviews use to close the menu cannot otherwise tell a stray click inside the menu from a click outside it.

`main.ts`'s `buildMenu()` builds the Markdown preview's tree: a top-level `Copy <Noun>` item for the most specific element in scope (precedence Selection > Code > Table > Diagram > Equation > Block) in that element's primary format, a `Copy as` submenu with every remaining format for the element(s) in scope, `Copy Whole Document`, `Save as PDF…`, and a `Preferences` submenu (a nested `Theme` submenu, then the Sync scroll / Auto-open preview / Math checkboxes and `MarkCopy Settings…`). `pdf.ts`'s equivalent builds `Copy Selection` (only when text is selected), `Copy Page N as PNG` (only over a rendered page), a `Copy as` submenu (`Page N Text`, `All Text`), `Add Comment Here` (only over a page), and its own `Preferences` submenu (the Hand/Pointer tool toggle, the Dark/Light Pages toggle, and a nested `Theme` submenu).

The net effect is a much shorter top level: the Markdown preview's was up to 19 rows (16 even on a plain paragraph, since an 11-row settings block was appended unconditionally) and is now at most 6; the PDF viewer's was up to 13 and is now at most 5. No action was removed, every one of them just moved one level down into `Copy as` or `Preferences`.

## Message protocol

Host to webview:

| Type           | Payload                                                                                         | Effect                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render`       | `html`, `source`, `kind`, `styleProfile`, `theme`, `mermaidConfig`, `syncScroll`, `autoPreview` | Replace preview content, apply the theme, (re)initialize and render Mermaid, wire up the CSV grid's resize handles, and refresh the settings menu's state. `kind` is `markdown` or `csv` and selects the layout. |
| `scrollToLine` | `line`                                                                                          | Scroll the preview to that source line, interpolated between the blocks either side of it (see [Scroll sync](#scroll-sync)). Ignored while the reader is scrolling the preview themselves.                       |
| `copyAll`      | none                                                                                            | Copy the whole document as rich text.                                                                                                                                                                            |

Webview to host:

| Type            | Payload                                 | Effect                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revealLine`    | `line`                                  | Reveal that line at the top of the editor. Clamped to the document's line count, and ignored when `markcopy.syncScroll` is off (see [Scroll sync](#scroll-sync)).                                                                                                                                                                                       |
| `toast`         | `text`                                  | Show a status-bar message.                                                                                                                                                                                                                                                                                                                              |
| `ready`         | none                                    | Signals the webview script has loaded.                                                                                                                                                                                                                                                                                                                  |
| `updateSetting` | `key`, `value`                          | Persist a `markcopy.*` setting from the in-preview menu, written to the scope where the setting is already defined (a WorkspaceFolder or Workspace override if present, else Global User scope) so a workspace value isn't shadowed by a Global write (`applySetting` / `settingTarget` in `extension.ts`); the config-change listener then re-renders. |
| `openSettings`  | none                                    | Run `markcopy.openSettings`, opening the native Settings UI scoped to the extension.                                                                                                                                                                                                                                                                    |
| `pdfHtml`       | `bodyHtml`                              | Serialized preview markup for [PDF export](#pdf-export); the host wraps it in a standalone page and renders that to a PDF file.                                                                                                                                                                                                                         |
| `selectSheet`   | `index`                                 | Show another sheet of a workbook. The host re-reads and re-renders; the webview holds no workbook state of its own, exactly as it holds no Markdown or CSV state. Sent only by the spreadsheet preview (see [Spreadsheet preview](#spreadsheet-preview)).                                                                                               |
| `editCell`      | `line`, `column`, `value`, `docVersion` | One edited CSV cell. The host rewrites that field in the document (see [CSV editing](#csv-editing)); `docVersion` is the version this grid was rendered from, and the edit is refused if lines have moved since, so a stale grid cannot edit the wrong row.                                                                                             |

The spreadsheet preview uses this same protocol rather than one of its own, which is the point of the design: `XlsxEditorProvider` posts the same `render` message (with `kind: 'xlsx'`, `source: ''`, and `syncScroll: false`, since there is no source text and no editor to sync with) and handles `ready`, `pdfHtml`, `updateSetting`, `openSettings`, and `toast` exactly as `extension.ts` does. `selectSheet` is the only addition. It does not handle `revealLine` or `editCell`: a workbook has no visible text editor to reveal into, and no addressable lines to write a cell back to.

The PDF preview uses its own message protocol: the webview posts `ready`, and the host replies with `load` (`data`: the file bytes as a base64 string, `workerSrc`: the pdf.js worker URI, `comments`: the parsed sidecar comments array). The bytes are base64-encoded because a `Uint8Array` does not survive `postMessage` serialization to the webview; `pdf.ts` decodes it back to a `Uint8Array` before handing it to pdf.js. Most copy actions run entirely in the webview with no further host round-trip. Two messages are the exception. Comments: the webview posts `saveComments` (`comments`: the full current array) back to the host whenever a pin is added, edited, or deleted, and `pdfEditor.ts` writes that array to the sidecar JSON file, deleting the file when the array is empty. The Preferences > Theme submenu: picking a theme posts `updateSetting` (`key`, `value`) so the host persists `markcopy.theme`, written the same scope-aware way as the Markdown preview (a WorkspaceFolder or Workspace override if present, else Global), so the setting is shared with the Markdown preview rather than being PDF-only.

## CSV editing

The CSV grid is editable, and the design principle is that **the document is the only state**. The grid never mutates itself on commit: `src/webview/csvEdit.ts` posts an `editCell` message and waits. The host rewrites the field, VS Code fires `onDidChangeTextDocument`, and the preview re-renders from the new text. Three things fall out of that for free: the file and the grid can never disagree, `Ctrl+Z` works because the change is an ordinary `WorkspaceEdit`, and an edit made in the text editor shows up in the grid identically to one made in the grid.

Writing the value back is the part worth care. The naive approach, reserialising the whole record from its parsed cells, would silently reformat the rest of the row: quoting we would not have chosen (`"unnecessarily quoted"`) would be dropped, and a hand-maintained file would churn on every edit. So the parser records a `FieldSpan` (`start`/`end` offsets into the original text) for every field alongside its value, and `cellEdit` returns a replacement for **that one span**. Every other byte in the file, quoting and line endings included, is untouched. `formatField` adds quotes back only when the new value actually needs them, and is the exact inverse of what the parser reads, so a value round-trips unchanged.

Two guards keep an edit from landing in the wrong place:

- **Records are addressed by the source line they start on**, not by a rendered row index. Row indices shift when `markcopy.csv.headerRow` or `maxRows` changes; a starting line is stable, and no two records share one.
- **The render message carries `docVersion`**, the version the grid was drawn from, which it echoes back with the edit. The host accepts it while those line numbers still mean what they meant: either the version still matches, or nothing has added or removed a line since (`lineCountVersion` records when that last happened). A cell edit rewrites a field inside a single line, so line numbers survive one. Requiring an exact match instead would swallow edits, because MarkCopy's own writeback bumps the version and the grid only learns the new one once the re-render reaches it, so typing quickly across two cells would lose the second. An edit that does move lines (committing a value containing a newline) fails the check and is refused; the re-render already in flight carries the truth.

A ragged row (fewer fields than the grid is wide) is grown in place: `cellEdit` appends just enough delimiters to reach the edited column. Because each render replaces the grid wholesale, the focused cell is remembered as a (record line, column) pair and re-seated after the re-render a commit triggers, so typing down a column is not interrupted.

## Clipboard

This is the core of MarkCopy, and the reason for the host/webview split.

### Why writing happens in the webview

`vscode.env.clipboard.writeText` is text-only; there is no rich-HTML API on the extension host. Rich copy therefore has to run in the webview, which is a browser context with a full Clipboard API.

### Why the `copy`-event trick, not `navigator.clipboard.write`

The async Clipboard API (`navigator.clipboard.write` with a `ClipboardItem`) can be blocked inside the VS Code webview iframe by its Permissions-Policy on some versions and platforms. The reliable path is a synchronous `copy`-event handler plus `document.execCommand('copy')`:

```js
function writeClipboard(html, plain) {
  const onCopy = (e) => {
    if (html) e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', plain);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  if (!ok) navigator.clipboard?.writeText(plain); // last-ditch fallback
}
```

Every rich or text copy writes `text/plain` as well, so targets that cannot take HTML still receive content.

### Why styles are inlined

Gmail and Outlook strip `<style>` blocks and external CSS, honoring only inline `style` attributes. `inlineStyledHtml()` clones the target node, walks every element, and copies a whitelist of computed properties (font, color, background, borders, padding, margin, alignment, list style, white-space) onto inline styles. That is what makes a pasted table or heading keep its look in an email.

Before reading computed styles, the source is briefly tagged with an `mc-force-light` class that overrides the palette to light values. This keeps copies dark-on-light even when the preview is displayed in a dark theme (a dark preview would otherwise inline light text that pastes invisibly into a white document). The class is added and removed synchronously within the copy call, so the on-screen preview never repaints.

### PNG copy

`copyPng()` uses `html-to-image`'s `toBlob()` at 2x pixel ratio, then writes an `image/png` `ClipboardItem`. This is the one place the async Clipboard API is used, because image writes are not expressible through the `copy`-event path. If the environment blocks it, the user sees a toast rather than a silent failure. The same path handles top-level **Copy Equation**; rasterizing a KaTeX equation additionally requires `html-to-image` to fetch KaTeX's web fonts, which is why the CSP has a same-origin `connect-src` (see [Content Security Policy](#content-security-policy)).

## PDF export

**Save as PDF** reuses the on-screen render rather than re-rendering the document: the preview already holds fully upgraded KaTeX HTML, Mermaid SVGs, and highlighted code, so `exportPdf()` clones `#content`, prepares the clone, and posts its `innerHTML` to the host as a `pdfHtml` message. Preparing the clone does three things the raw DOM can't be shipped without:

- **Relight Mermaid.** Mermaid bakes theme colors into each SVG at render time (the same reason the host re-renders diagrams on a theme change, see [Theming](#theming)), so a diagram rendered for a dark preview is dark-filled with light labels: invisible black boxes on the forced-light PDF page. `relightMermaid()` re-renders every `.mc-mermaid` from the source stashed in `data-mermaid-src` at render time, with `theme: 'default'`, then restores the on-screen config via `initMermaid()`. Text, KaTeX, and code need no such treatment: they inherit color from CSS, which the PDF page forces light.
- **Inline local images.** `inlineImages()` replaces every webview-hosted `src` with a `data:` URI so the images survive on a plain `file://` page outside the webview; remote `https:` and already-inlined `data:` sources are left alone.
- **Strip `data-source-line`.** The scroll-sync attributes are preview-only noise in an exported document.

The host (`exportPdf` in `src/extension.ts`) wraps the markup in a standalone HTML page carrying `preview.css` and the KaTeX stylesheet with its fonts inlined (`buildPdfPage` in `src/pdfExport.ts`), forces the light palette for a clean printout, and renders it to the file the user picked in a save dialog. The rendering is done by a headless Chromium-family browser (`--headless --print-to-pdf`), located by `findBrowser()`: the `markcopy.pdf.browserPath` setting if set, else the usual Edge/Chrome/Chromium/Brave install locations for the platform. The page and the browser's throwaway profile both live in one `mkdtemp` directory, deleted however the render ends, and the finished PDF is handed to the OS with `openExternal`.

Three details of that command line matter (`printArgs`):

- **`--no-pdf-header-footer` and `--print-to-pdf-no-header`** (the current and older spellings; Chromium ignores switches it does not recognize). Without them the output carries the furniture the interactive print dialog adds by default: the document title across the top of every page and the `file://…` URL across the bottom.
- **`--user-data-dir`** pointed at a fresh directory. Without it, launching a browser the user already has open just hands the URL to the running process, which prints nothing at all.
- **`--headless`, not `--headless=new`.** Recent Chromium maps the bare flag to the new mode anyway, while builds predating `=new` would fail to parse it and open a visible window instead of printing.

A browser that cannot open the page still exits 0 and still writes a PDF (of its error page), so `renderPdf()` treats a suspiciously small output file as a failure rather than trusting the exit code. If no browser is found, or a render fails, `printViaBrowser()` is the fallback: it writes the page to the extension's `globalStorageUri` and opens it in the default browser with a `window.print()` on load, which is what the export used to do for everyone. Because `globalStorageUri` uses the `vscode-userdata:` scheme, which the OS shell has no handler for, the file is reopened as a plain `file:` URI (`vscode.Uri.file(fileUri.fsPath)`) before `openExternal`, or the browser hand-off fails.

### Print stylesheet

`pdfCss()` layers print rules over `preview.css`. Most of them undo something the on-screen preview needs and paper does not, and the two that matter most are the ones a naive print stylesheet gets wrong:

- **Only atomic things forbid an internal break.** A blanket `pre, table { break-inside: avoid }` cannot be honoured for a block taller than a page; a browser that cannot honour it pushes the block onto a fresh page anyway and leaves the rest of the previous page blank. Tall blocks are allowed to split (`break-inside: auto`) and `thead { display: table-header-group }` repeats a table's header on every page it spans, so a long table reads correctly wherever it breaks. `break-inside: avoid` is kept only for images, diagrams, equations, and table rows.
- **Nothing may rely on scrolling.** `overflow: auto` on a `pre` or a table is a horizontal scrollbar on screen and a silent clip in print, losing whatever does not fit the page width. Both become `overflow: visible` with wrapping (`white-space: pre-wrap`, `overflow-wrap: anywhere`). Relatedly, the export page's `<body>` deliberately omits `data-mc-kind`: a CSV preview uses it to become a viewport-tall flex column that scrolls internally, and on paper that would clip everything past the first page's worth of rows instead of paginating.

`print-color-adjust: exact` is also set, because Chromium otherwise drops background colours from a print and flattens every code block, table header, and blockquote to plain white.

## PDF preview

`.pdf` files are handled by `PdfEditorProvider`, a `CustomReadonlyEditorProvider` registered for the `markcopy.pdfPreview` view type (contributed with `priority: default`, since VS Code has no built-in PDF viewer). On open, the provider reads the file with `workspace.fs.readFile` and, once the webview posts `ready`, sends the bytes, the worker URI, and any saved comments (read from the sidecar JSON file) in a `load` message. Nothing is fetched over the network.

In the webview, `src/webview/pdf.ts` builds one placeholder `<div class="mc-page">` per page up front (sized from the page's scale-1 viewport) but does not rasterise anything yet; an `IntersectionObserver` (`rootMargin: '150% 0px'`) rasterises a page's canvas and text layer only once it nears the viewport, and tears both down again once it scrolls away, so memory use stays bounded regardless of how many pages the PDF has. Each page's canvas is rendered above display resolution (at least 2x, or the device pixel ratio if higher) so text stays sharp, clamped to a roughly 16.7-million-pixel budget (`MAX_CANVAS_PIXELS`) so the canvas itself never grows large enough to trigger the browser's own blur-inducing downscale. A pdf.js `TextLayer` of transparent, selectable spans is rendered over each canvas from the same `getTextContent()` call used for the copy actions, so highlighting text on a page is real text selection, not a canvas artifact.

Starting the pdf.js worker takes an extra step: the worker script can't be constructed directly from its `webview-resource:` URI, since that origin differs from the webview document's `vscode-webview://` origin and `new Worker(workerSrc)` throws a `SecurityError`. Instead, `pdf.ts` `fetch`es the worker script and wraps it in a same-origin `Blob`, then starts `new Worker(blobUrl, { type: 'module' })` from that. The PDF webview's CSP adds `worker-src ${cspSource} blob:` and `connect-src ${cspSource} blob: data:` to allow the fetch and the blob worker. Any load failure (bad bytes, worker error) is caught by `error` / `unhandledrejection` handlers and shown as a visible message in the panel instead of a silent blank page.

Zoom is stepped through fixed preset levels (50, 67, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400 percent) rather than continuous, so the label and re-raster targets stay predictable. A floating toolbar (bottom-right) has minus/plus buttons and a percentage that resets to 100 percent on click; Ctrl and plus / Ctrl and minus / Ctrl and 0, and Ctrl plus the mouse wheel do the same. Changing the zoom level immediately resizes every page's placeholder (so scroll position and layout stay correct) but debounces the actual re-raster by 120ms after the last step, so scrolling quickly through zoom levels doesn't rasterise every intermediate one.

`scale`, not an index into the preset list, is the source of truth, because fit width can land between two presets: it divides the pane's `clientWidth` (less a 32px margin, so the page neither butts against the edges nor trips a horizontal scrollbar) by the base width of the page currently under the midline, then clamps into the preset range. It is a mode rather than a one-shot, so a window or pane resize re-fits (debounced by 120ms) until any manual zoom turns it off; the button carries the state as `aria-pressed`. Its icon is Folio's `fit-width` glyph, inlined as a `currentColor`-stroked SVG (no icon dependency, and it follows the toolbar's foreground in every theme) and centred with flexbox, since an inline SVG would otherwise sit on the text baseline. Stepping finds the neighbouring preset by value, so plus/minus from a fitted 137 percent goes to 150/125 percent rather than back to wherever the zoom last was.

Every scale change preserves the reading position. `captureZoomAnchor()` records the point under the middle of the viewport as fractions of its page's box (clamped to the page, since the fixed gaps between pages must not be scaled), and `restoreZoomAnchor()` scrolls that point back under the middle once the placeholders have been resized. Without it the scroll offset keeps its pixel value while the pages above it change size, which slides the view onto a different page, further the deeper into the document the reader is.

The same toolbar carries a page indicator (`3 / 12`). The current page is whichever page sits under the vertical middle of the viewport, recomputed by `pageAtViewportCenter()` on scroll (throttled to one scan per animation frame, and the scan bails out at the first page that starts below the midline, since wrappers are in document order) and again when the zoom debounce settles, because a zoom step changes page heights under a fixed scroll position without firing a scroll event. A jump's own scroll skips the recompute once (`pageJumpScrollPending`), so a target page too short to reach the midline still reads as current instead of being overwritten by its neighbour. The indicator, like the zoom percentage, is a real button, so both are keyboard-reachable; activating it swaps it for a number input: Enter jumps to that page (clamped to range) via `scrollIntoView`, Escape or blur cancels, and keydown propagation is stopped so the viewer's own shortcuts don't fire while typing.

### PDF theming, tools, comments, and scrollbars

PDF page recolouring is applied to the rendered canvas bitmap at render time, not a CSS filter or a pdf.js rendering mode. After `page.render()` finishes, `pdf.ts` recolours the pixels in place based on the page's target appearance. For dark mode it sets `globalCompositeOperation = 'difference'` and fills the canvas with white, which is an exact colour inversion (no hue rotation) of the actual pixels. For the green theme it takes that white-on-black inversion one step further, multiplying it by a phosphor green (`#00ff00`, matching the green palette's `--mc-fg` and GNOME Terminal's "Green on black" profile) so the page reads as green-on-black phosphor; `multiply` leaves the black background black. An earlier version used a CSS filter (`filter: invert(1) hue-rotate(180deg)` on the canvas element, the same trick used by [Folio](https://github.com/owenpkent/folio)), but a CSS filter forces the browser to re-rasterise the layer at CSS resolution, which blurs pages on HiDPI displays; baking the recolour into the bitmap keeps the oversampled render crisp.

Which recolour a page gets is decided by `pageAppearance()` in `pdf.ts`, returning one of `normal` (true colours), `inverted` (dark), or `green` (the phosphor variant). It follows `markcopy.theme` like the Markdown preview: `green` yields the phosphor look, `dark` (or auto mode on a dark VS Code theme) yields the inversion, everything else stays `normal`. The PDF viewer carries the same **Theme** submenu as the Markdown preview (**Auto** / **Light** / **Dark** / **Green on black**), nested under its **Preferences** submenu; picking one posts `updateSetting` to persist the shared `markcopy.theme` (see [Message protocol](#message-protocol)) and re-tints the pages. Separately, a session-only **Dark Pages** / **Light Pages** quick toggle (`pageMode` in `pdf.ts`, one of `auto` / `normal` / `inverted`) does a one-off inversion that overrides the appearance without changing the saved theme. Either way, toggling clears every rendered page and re-rasterises the visible ones, since the recolour is baked into the bitmap rather than a live filter. **Copy Page as PNG** still copies the page in true colours for every appearance: for `inverted` it fast-inverts a throwaway copy of the canvas back, and for `green` (where the phosphor multiply is not exactly reversible) it re-rasterises the page clean. A `forced-color-adjust: none` rule on the page root keeps Windows High Contrast from recoloring page content.

Because pages now have a real text layer, `pdf.ts` no longer treats every drag as a pan. The **Preferences** submenu toggles between a **Hand Tool (Drag to Scroll)** and a **Pointer Tool (Select Text)** (`mode` in `pdf.ts`, `'hand'` or `'pointer'`, starting in hand mode). Hand mode drags anywhere on the page area to pan (pointer events, with pointer capture so a drag that leaves the webview still delivers `move`/`up`, and the cursor switching between `grab` and `grabbing` via the `mc-grabbing` body class); pointer mode leaves drags to the browser's native text selection instead.

Comments are pin notes: right-click a page and choose **Add Comment Here** to drop a pin at the click position (stored as a fraction of the page's width/height, `xPct`/`yPct`, so pins stay put across zoom) and open an editable note popover; clicking an existing pin reopens that popover to edit or delete it. Comments persist to a sidecar JSON file next to the PDF, `<filename>.pdf.mccomments.json`, written and deleted by `pdfEditor.ts`'s `writeComments` (an empty array deletes the file) so the PDF itself is never modified; the webview sends the full current array via a `saveComments` message on every add, edit, or delete, and receives the saved array back in the `load` message's `comments` field when the PDF is reopened.

The PDF view also gets always-visible, styled scrollbars, scoped to the PDF page's root element (`html.mc-pdf-root`) so the Markdown preview's scrollbars are unaffected.

## Spreadsheet preview

An `.xlsx` is binary, so it never becomes a `vscode.TextDocument`. Every load-bearing part of the preview pipeline is TextDocument-shaped (`update()` renders from `doc.getText()`, live updates hang off `onDidChangeTextDocument`, `previewKind()` keys off `languageId`, the CSV writeback applies a `WorkspaceEdit` over byte offsets), so none of it reaches. `contributes.customEditors` plus `workspace.fs.readFile` is the route, the same one the PDF viewer takes.

Where it differs from the PDF viewer, deliberately: **it ships no webview code of its own.** `XlsxEditorProvider` serves the same `htmlShell()` as the Markdown/CSV preview, loads the same `media/webview.js`, and posts the same `render` message. The host renders a sheet into the CSV grid's exact markup, so the sheet inherits the context menu, every **Copy as** flavor, column resizing, the four palettes, and Save as PDF without a line of new webview code. `src/webview/pdf.ts` is a thousand lines largely because that reuse was not attempted there; the only new webview code here is a click handler that posts `selectSheet`.

Three properties fall out of the markup rather than out of conditions in the webview, which is what keeps them from being lost to a refactor:

- **Read-only.** `src/csv.ts` marks its grid `data-mc-editable`, and `csvEdit.ts` wires only tables carrying it. A sheet omits it. A cell edit has nowhere to go: the document is a binary workbook, not a text file with addressable lines.
- **Out of scroll sync.** A sheet emits no `data-source-line`, so the anchor list is empty and there is nothing to report. There is no visible text editor to reveal into either way.
- **Chrome stays out of copies.** The sheet tab strip and the row-number gutter carry `data-mc-ignore`. So does the column-letter header row, which labels the grid rather than being part of it, and `tableToDelimited` drops a row that contributes no data cells so it does not become a blank line.

Parsing runs on the host, in `src/xlsx/`, free of the `vscode` module. That is where this feature's bugs live (serial-to-date arithmetic, format-code resolution, merge geometry, the `t="s"` versus `t="str"` distinction), and keeping it pure means vitest reaches all of it with no webview and no bundle. Two format details worth knowing, because previews get them wrong: a cell's `s` indexes `cellXfs`, not `cellStyleXfs`, and date-ness is decided by the format **code**, never by the format id (the common "14-22 means date" heuristic misses builtins 45 to 47 and the East Asian blocks, and anything from 164 up means whatever that file says).

The container is hostile input before a tag is parsed, so `zip.ts` caps file size, entry count, per-entry size, and total inflated size, and refuses external relationships (`externalLinks`, remote images, DDE/OLE links), which are SSRF and, on Windows, credential-leak vectors. Entity expansion needs no defence: saxes resolves only the five predefined XML entities and never expands DTD-declared ones, so a billion-laughs payload is inert. `tests/xlsx/reader.test.ts` pins that, so swapping the parser for one that does expand them fails the suite rather than the extension host.

## STL preview

Ported from [MeshView](https://github.com/owenpkent/meshview), which this supersedes. It takes the same `contributes.customEditors` + `workspace.fs.readFile` route as the PDF and spreadsheet previews, and like the PDF viewer it ships its own webview bundle. Unlike the spreadsheet preview it cannot reuse `htmlShell()` and `media/webview.js` at all: there is no HTML document to render into, only a `<canvas>` a WebGL renderer draws into, and no copy actions to hang off the shared context menu. A triangle soup has no text, tables, or images to put on a clipboard. So `src/stlEditor.ts` serves a small self-contained page and `src/webview/stl.ts` drives Three.js inside it.

Three.js is its own esbuild entry point (`media/stl.js`, ~547 KB minified) rather than a lazy chunk of `media/webview.js`, so it is fetched only when an `.stl` is opened and the Markdown, CSV, and PDF previews pay nothing for it.

Two decisions in `src/webview/stlInfo.ts` are the load-bearing ones, and both are about not trusting a length:

- **The file is hostile input.** A binary STL is an 80-byte header, a uint32 triangle count, then 50 bytes per triangle, and `STLLoader` sizes its `Float32Array`s from that count without checking the file is big enough to hold them. A crafted 84-byte file declaring `0xFFFFFFFF` triangles asks for tens of gigabytes. `checkStl()` runs first and refuses any file whose declared count needs more bytes than the file has, or exceeds `MAX_TRIANGLES` (~5.4 million), or is simply larger than `MAX_STL_BYTES` (256 MiB). That last one applies to ASCII too: an ASCII parse cannot amplify, but a multi-gigabyte one still freezes the webview. The checks run host-side (the size off `stat`, before a byte is read) as well as in the webview, so a hostile file is never read, encoded, and shipped just to be refused on arrival.
- **The message payload is hostile input too.** The host sends base64 rather than a `Uint8Array` because `webview.postMessage` JSON-encodes, and JSON turns a typed array into a numeric-keyed object roughly 13x the size (a 5 MB model becomes ~67 MB of JSON). `toBytes()` decodes that, and its fallback branches never allocate from an unvalidated `length`: a bare `{length: n}` is refused rather than fabricated into `n` zero bytes, which would otherwise sniff as a valid empty STL and hide a transport bug as a file problem.

Both are pure and unit-tested in `tests/stlInfo.test.ts`, which is the point of keeping them out of the Three.js path.

## Theming

`media/preview.css` defines the palette as CSS custom properties (`--mc-fg`, `--mc-bg`, `--mc-border`, code/table/link colors, and the highlight.js tokens), with GitHub-light values as the default. A single selector block overrides them with GitHub-dark values, so the rest of the stylesheet references variables and never repeats a color.

The `markcopy.theme` setting (`auto` / `light` / `dark`) is passed to the webview in the `render` message and applied as a `data-mc-theme` attribute on `body`. The STL viewer follows the same attribute, but resolves it to a single `--mc-stl-bg` custom property, since all it has to tint is the WebGL clear color behind the model. The dark override fires when:

- `body[data-mc-theme='dark']` (forced dark), or
- `body.vscode-dark` / `body.vscode-high-contrast` and `data-mc-theme` is not `light` and not `dark` (auto mode following the VS Code theme).

Because auto mode keys off VS Code's own `vscode-dark` body class, the CSS palette updates live when the editor theme switches. Mermaid diagrams are pre-rendered SVGs with baked-in colors, so to re-theme them the host also re-renders on `onDidChangeActiveColorTheme`, and on `onDidChangeConfiguration` for `markcopy.theme` / `markcopy.mermaid`. The PDF editor reads the theme setting when it opens.

Copies stay light regardless of the displayed theme: see `.mc-force-light` under [Clipboard](#clipboard).

## Content Security Policy

The webview HTML declares a strict CSP with a per-load nonce:

```
default-src 'none';
img-src ${cspSource} https: data: blob:;
style-src ${cspSource} 'unsafe-inline';
font-src  ${cspSource} data:;
connect-src ${cspSource};
script-src 'nonce-${nonce}' 'strict-dynamic';
```

Only the nonce-tagged bundle can execute, and it loads as `<script type="module">`. `'strict-dynamic'` is what makes the code-split build work under CSP: the nonce'd entry module can `import()` its sibling `media/chunk-*.js` chunks (Mermaid, KaTeX, html-to-image, Turndown) even though those chunks carry no nonce of their own, because `'strict-dynamic'` propagates trust from the entry module to the scripts it loads. `blob:` and `data:` image sources are allowed so Mermaid SVGs and html-to-image output render. All local assets are referenced through `webview.asWebviewUri`. `connect-src ${cspSource}` was added for math: rasterizing an equation to PNG (`copyPng`, see [PNG copy](#png-copy)) needs `html-to-image` to `fetch` and inline KaTeX's web fonts, which requires a `connect-src` grant; Mermaid never needed one because it renders with system fonts. The directive is scoped to the webview's own origin, so it cannot reach any external host.

See [SECURITY.md](../.github/SECURITY.md) for the threat model.

## Testing

Three automated layers. Two of them match the two runtimes; the third sits between, and exists because "inside a webview" turned out to be less out of reach than it looks:

- **Unit (`tests/`, vitest + jsdom).** Covers the pure, host-independent logic: markdown-it rendering and source-line mapping (`src/render.ts`), CSV/TSV parsing, delimiter sniffing and grid rendering (`src/csv.ts`, `tests/csv.test.ts`), CSV column resizing and cell editing driven against the real grid markup (`src/webview/csvTable.ts` and `src/webview/csvEdit.ts`, with `tests/csvEditModel.test.ts` covering the field spans and the document edits they produce), CSV/TSV clipboard serialization (`src/webview/table.ts`), HTML-to-Markdown conversion (`src/webview/markdownConvert.ts`), image-src classification plus the preview-kind and auto-preview decisions (`src/preview-utils.ts`, `tests/preview-utils.test.ts`), scroll-sync interpolation (`src/webview/scrollSync.ts`, `tests/scrollSync.test.ts`), the PDF export's browser discovery, command line, export page, and print stylesheet (`src/pdfExport.ts`, `tests/pdfExport.test.ts`), and STL sniffing plus the allocation guards that run before `STLLoader` (`src/webview/stlInfo.ts`, `tests/stlInfo.test.ts`). These were extracted from `main.ts` / `extension.ts` specifically so they import without a DOM or the VS Code API. Run with `npm test`.
- **Webview E2E (`tests/e2e/`, on `tests/webview/harness.ts`).** Boots the real bundle (`src/webview/main.ts`) in jsdom against the host's own renderers, then drives it the way a reader does: right-click an element, walk the context menu, read the clipboard flavors that come out. Covers which rows the menu offers for a given target, what each copy action writes, the sheet grid and its tab strip, what a sheet hands the host to print, and scroll sync in both directions including the echo suppression that keeps preview and editor from fighting. Nothing in it reassembles the bundle's steps, which is the whole point: a transform can be correct while the menu row that calls it has been deleted, and only this layer notices. The STL viewer is not here: it is a separate bundle with no shared shell and no clipboard surface, and what it does need (WebGL) jsdom has no more than canvas. Run with `npm test`.
- **Integration (`test-integration/`, Mocha + `@vscode/test-electron`).** Runs the built extension in a downloaded VS Code instance (`.vscode-test.mjs` config, compiled via `tsconfig.integration.json` to `out/`) and asserts activation, command registration (including `markcopy.openSettings`), configuration defaults (including the `autoPreview` default), that the preview panel opens, that focusing an on-disk Markdown file auto-opens a preview for it, and which editor claims a `.xlsx`, `.xlsm`, `.pdf`, or `.stl`. Custom editors are contributed entirely through `package.json`, so a selector that stops matching is invisible to every other layer and leaves a workbook opening as binary junk. Run with `npm run test:integration`; on Linux and CI it needs a display (`xvfb-run`).

The webview layer inherits jsdom's blind spots: no canvas (so `Copy as PNG` and the PDF viewer's rasterisation), no `innerText` (so the plain-text half of a rich-text copy), no layout (scroll sync runs against a synthetic one the harness installs), and no stylesheet (so nothing can tell a legible palette from an applied one). Those rows stay in the manual pass, marked in [TESTING.md](TESTING.md). All three automated layers run in CI (see [CONTRIBUTING](../.github/CONTRIBUTING.md#tests)).

## Future ideas

- **Shared `pdf-core` with Folio.** The PDF preview shares techniques with [Folio](https://github.com/owenpkent/folio) (a Tauri + React desktop PDF viewer), most visibly the dark-mode inversion technique (originally a CSS filter ported by hand, now a canvas-bitmap inversion for HiDPI crispness). If the overlap grows (text extraction, page-to-PNG, reading-mode filters, outline/nav), consider extracting a small **framework-agnostic** TypeScript core both projects import, keeping each UI separate. Deliberately not done yet: today the shared surface is thin and the runtimes differ (Tauri desktop vs. sandboxed VS Code webview), so copying the one technique beat taking on a shared dependency. Extract only once the duplication is actually felt.
- **PDF comments/annotations.** Basic pin comments already exist: right-click **Add Comment Here** drops a pin with an editable note, persisted to a sidecar JSON file (see [PDF theming, tools, comments, and scrollbars](#pdf-theming-tools-comments-and-scrollbars)). The open design question for anything beyond that is deeper persistence, and it drives everything else:
  - _Sidecar JSON_ (what's implemented today, `<filename>.pdf.mccomments.json` beside the file) keeps the PDF read-only and is git-friendly, but comments are only visible in MarkCopy.
  - _Embed into the PDF_ (real `/Annots` via a writer like `pdf-lib`) makes them portable to any viewer, but requires switching the read-only custom editor to a writable one with a save flow, plus a new dependency.
  - _In-memory only_ is fine for prototyping the interaction before committing to storage.

  Pages now have a pdf.js text layer, so word-level text selection works; region- or highlight-style annotations (as opposed to today's point pins) are still unimplemented.
