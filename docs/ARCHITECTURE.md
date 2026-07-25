# Architecture

MarkCopy is a custom-webview VS Code extension with two previews: Markdown and PDF. For Markdown, the Node extension host renders to HTML and the webview displays it; for PDF, the host only supplies bytes and pdf.js renders in the webview. In both, all interaction (context menu, clipboard, Mermaid, PNG capture) happens in the webview. This split is deliberate: the webview is a browser context, and the clipboard operations we need (writing `text/html`, capturing PNGs) only exist there.

## Big picture

```
 ┌──────────────────────────┐        postMessage        ┌───────────────────────────┐
 │  Extension host (Node)    │  ───────────────────────► │  Webview (browser/iframe) │
 │  src/extension.ts         │   render / scrollToLine / │  src/webview/main.ts      │
 │  src/render.ts            │   copyAll                 │  media/preview.css        │
 │                           │  ◄─────────────────────── │                           │
 │  markdown-it, highlight.js│   revealLine / toast /    │  Mermaid, html-to-image,  │
 │  source-line mapping      │   ready                   │  context menu, clipboard  │
 └──────────────────────────┘                           └───────────────────────────┘
        dist/extension.js                                        media/webview.js
        (esbuild.js, node)                                   (esbuild.web.js, browser)
```

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

Four entry bundles (plus the Markdown webview's lazily-loaded `media/chunk-*.js` files) are produced from one TypeScript source tree by two esbuild scripts:

- `esbuild.js` bundles `src/extension.ts` to `dist/extension.js` for Node (`vscode` left external).
- `esbuild.web.js` bundles the browser code: `src/webview/main.ts` to `media/webview.js` as an ES-module, code-split build (Mermaid, KaTeX, html-to-image, and Turndown load lazily via dynamic `import()` as separate `media/chunk-*.js` files, only when first needed; DOMPurify stays eager), and `src/webview/pdf.ts` plus the pdf.js worker to `media/pdf.js` and `media/pdf.worker.js` (esm). Code-splitting drops the initial `media/webview.js` from roughly 8.5MB to about 19KB, since the heavy libraries are only fetched on demand (a diagram or equation present, Copy as PNG, Copy as Markdown).

See [PDF preview](#pdf-preview) below for the PDF data flow in detail.

`tsc --noEmit` type-checks the whole tree; esbuild does the actual transpiling and bundling. `tsconfig.json` uses `module: ESNext` and `moduleResolution: Bundler` so the ESM-only dependencies (Mermaid, markdown-it-anchor) type-check cleanly.

## File map

| File                             | Role                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`               | Activation, command registration, webview panel lifecycle, editor-to-preview scroll sync, host side of the message protocol.                                                                                                                                                                                                     |
| `src/render.ts`                  | The shared `markdown-it` instance: GFM options, highlight.js, anchors, Mermaid fence placeholders, `markdown-it-texmath` math placeholders, source-line mapping, and the `env.resolveImage` image-src hook.                                                                                                                      |
| `src/preview-utils.ts`           | Pure, VS Code-independent helpers: `localImageRef` (classifies an image `src` so the host knows whether/how to rewrite it) and `shouldAutoPreview` (the auto-open/retarget decision). Kept out of `extension.ts` so they're unit-testable without the `vscode` module.                                                           |
| `src/webview/main.ts`            | Everything in the preview: rendering the HTML, Mermaid, KaTeX (`renderKatex`), building the Markdown preview's context-menu entry tree (see [Context menu](#context-menu)), all clipboard writes, PNG capture, inline styling, HTML-to-Markdown (Turndown), scroll sync.                                                         |
| `src/webview/menu.ts`            | The shared context-menu engine (`MenuEntry`, `MenuController`, `createMenu`) used by both webviews: panel rendering, submenu nesting, and keyboard navigation (see [Context menu](#context-menu)).                                                                                                                               |
| `src/pdfEditor.ts`               | The read-only custom editor for `.pdf`: builds the webview, reads file bytes, hands them to the PDF webview, and reads/writes the sidecar comments JSON file.                                                                                                                                                                    |
| `src/webview/pdf.ts`             | The PDF preview: virtualised pdf.js rendering (canvas + text layer, zoom, the page indicator with go-to-page, dark/green bitmap recolouring), per-page text extraction, comment pins, the copy actions (page PNG, page text, all text, selection), and building its context-menu entry tree (see [Context menu](#context-menu)). |
| `src/webview/table.ts`           | CSV/TSV table serialization (RFC 4180). Pure, unit-tested.                                                                                                                                                                                                                                                                       |
| `src/webview/markdownConvert.ts` | HTML-to-Markdown conversion via Turndown. Pure, unit-tested.                                                                                                                                                                                                                                                                     |
| `tests/`                         | Vitest unit tests over the pure logic, including the shared menu engine (`tests/menu.test.ts`).                                                                                                                                                                                                                                  |
| `test-integration/`              | VS Code integration tests (Mocha + @vscode/test-electron).                                                                                                                                                                                                                                                                       |
| `media/preview.css`              | GitHub styling, PDF layout, context menu (including `.mc-menu--sub`, `.mc-menu-item--submenu`, `.mc-menu-arrow` for nested submenu panels), toast, highlight.js token colors.                                                                                                                                                    |
| `esbuild.js` / `esbuild.web.js`  | The bundlers. `esbuild.web.js` emits `webview.js` (esm, code-split into `media/chunk-*.js`), `pdf.js` and `pdf.worker.js` (esm), and copies the KaTeX stylesheet and fonts into `media/katex/` (generated, gitignored).                                                                                                          |

## Rendering pipeline

1. The user opens the preview. `openPreview` creates a `WebviewPanel` (beside the editor, `retainContextWhenHidden: true`) and sets its HTML shell.
2. `update()` reads the document text, calls `md.render(source, { resolveImage })` (see [Local images](#local-images) below), and posts a `render` message carrying the HTML, the raw source, the active style profile, the theme (`markcopy.theme`), any `markcopy.mermaid` config, and the current `syncScroll` / `autoPreview` settings.
3. In the webview, `render()` sets `#content.innerHTML`, applies the style profile and theme to `body` (`dataset.style`, `dataset.mcTheme`), splits the source into `sourceLines` (used later for block "copy as Markdown"), (re)initializes Mermaid with the theme and any `markcopy.mermaid` config, then upgrades every Mermaid placeholder into an SVG and every math placeholder into a KaTeX render (see [Math (KaTeX)](#math-katex) below).
4. On each edit, `onDidChangeTextDocument` re-runs `update()`, so the preview is live.

### Source-line mapping

`render.ts` tags top-level block tokens with `data-source-line` (the token's starting line). This attribute powers two features:

- **Scroll sync:** the webview reports the first fully-visible block's line; the host reveals that line in the editor, and vice versa. A `programmaticScroll` flag breaks the feedback loop.
- **Block Markdown (the "Markdown" row under Copy as for a block):** for a clicked block, the webview finds its `data-source-line`, finds the next block's line, and slices `sourceLines` between them (verbatim source). The "Markdown" row under Copy as for a selection is different: it converts just the selected HTML to Markdown with Turndown (`turndown` + `turndown-plugin-gfm`), so partial and multi-block selections come through exactly.

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

| Type           | Payload                                                                                 | Effect                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `render`       | `html`, `source`, `styleProfile`, `theme`, `mermaidConfig`, `syncScroll`, `autoPreview` | Replace preview content, apply the theme, (re)initialize and render Mermaid, and refresh the settings menu's state. |
| `scrollToLine` | `line`                                                                                  | Scroll the preview to the element for that source line.                                                             |
| `copyAll`      | none                                                                                    | Copy the whole document as rich text.                                                                               |

Webview to host:

| Type            | Payload        | Effect                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revealLine`    | `line`         | Reveal that line at the top of the editor.                                                                                                                                                                                                                                                                                                              |
| `toast`         | `text`         | Show a status-bar message.                                                                                                                                                                                                                                                                                                                              |
| `ready`         | none           | Signals the webview script has loaded.                                                                                                                                                                                                                                                                                                                  |
| `updateSetting` | `key`, `value` | Persist a `markcopy.*` setting from the in-preview menu, written to the scope where the setting is already defined (a WorkspaceFolder or Workspace override if present, else Global User scope) so a workspace value isn't shadowed by a Global write (`applySetting` / `settingTarget` in `extension.ts`); the config-change listener then re-renders. |
| `openSettings`  | none           | Run `markcopy.openSettings`, opening the native Settings UI scoped to the extension.                                                                                                                                                                                                                                                                    |
| `pdfHtml`       | `bodyHtml`     | Serialized preview markup for [PDF export](#pdf-export); the host wraps it in a standalone HTML file and opens it.                                                                                                                                                                                                                                      |

The PDF preview uses its own message protocol: the webview posts `ready`, and the host replies with `load` (`data`: the file bytes as a base64 string, `workerSrc`: the pdf.js worker URI, `comments`: the parsed sidecar comments array). The bytes are base64-encoded because a `Uint8Array` does not survive `postMessage` serialization to the webview; `pdf.ts` decodes it back to a `Uint8Array` before handing it to pdf.js. Most copy actions run entirely in the webview with no further host round-trip. Two messages are the exception. Comments: the webview posts `saveComments` (`comments`: the full current array) back to the host whenever a pin is added, edited, or deleted, and `pdfEditor.ts` writes that array to the sidecar JSON file, deleting the file when the array is empty. The Preferences > Theme submenu: picking a theme posts `updateSetting` (`key`, `value`) so the host persists `markcopy.theme`, written the same scope-aware way as the Markdown preview (a WorkspaceFolder or Workspace override if present, else Global), so the setting is shared with the Markdown preview rather than being PDF-only.

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

The host (`exportPdf` in `src/extension.ts`) wraps the markup in a standalone HTML page carrying `preview.css` and the KaTeX stylesheet with its fonts inlined (via `buildPdfHtml`), forces the light palette for a clean printout, writes it to the extension's `globalStorageUri`, and opens it in the default browser, where the page auto-invokes the print dialog and the user picks "Save as PDF". Because `globalStorageUri` uses the `vscode-userdata:` scheme, which the OS shell has no handler for, the file is reopened as a plain `file:` URI (`vscode.Uri.file(fileUri.fsPath)`) before `openExternal`, or the browser hand-off fails.

## PDF preview

`.pdf` files are handled by `PdfEditorProvider`, a `CustomReadonlyEditorProvider` registered for the `markcopy.pdfPreview` view type (contributed with `priority: default`, since VS Code has no built-in PDF viewer). On open, the provider reads the file with `workspace.fs.readFile` and, once the webview posts `ready`, sends the bytes, the worker URI, and any saved comments (read from the sidecar JSON file) in a `load` message. Nothing is fetched over the network.

In the webview, `src/webview/pdf.ts` builds one placeholder `<div class="mc-page">` per page up front (sized from the page's scale-1 viewport) but does not rasterise anything yet; an `IntersectionObserver` (`rootMargin: '150% 0px'`) rasterises a page's canvas and text layer only once it nears the viewport, and tears both down again once it scrolls away, so memory use stays bounded regardless of how many pages the PDF has. Each page's canvas is rendered above display resolution (at least 2x, or the device pixel ratio if higher) so text stays sharp, clamped to a roughly 16.7-million-pixel budget (`MAX_CANVAS_PIXELS`) so the canvas itself never grows large enough to trigger the browser's own blur-inducing downscale. A pdf.js `TextLayer` of transparent, selectable spans is rendered over each canvas from the same `getTextContent()` call used for the copy actions, so highlighting text on a page is real text selection, not a canvas artifact.

Starting the pdf.js worker takes an extra step: the worker script can't be constructed directly from its `webview-resource:` URI, since that origin differs from the webview document's `vscode-webview://` origin and `new Worker(workerSrc)` throws a `SecurityError`. Instead, `pdf.ts` `fetch`es the worker script and wraps it in a same-origin `Blob`, then starts `new Worker(blobUrl, { type: 'module' })` from that. The PDF webview's CSP adds `worker-src ${cspSource} blob:` and `connect-src ${cspSource} blob: data:` to allow the fetch and the blob worker. Any load failure (bad bytes, worker error) is caught by `error` / `unhandledrejection` handlers and shown as a visible message in the panel instead of a silent blank page.

Zoom is stepped through fixed preset levels (50, 67, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400 percent) rather than continuous, so the label and re-raster targets stay predictable. A floating toolbar (bottom-right) has minus/plus buttons and a percentage that resets to 100 percent on click; Ctrl and plus / Ctrl and minus / Ctrl and 0, and Ctrl plus the mouse wheel do the same. Changing the zoom level immediately resizes every page's placeholder (so scroll position and layout stay correct) but debounces the actual re-raster by 120ms after the last step, so scrolling quickly through zoom levels doesn't rasterise every intermediate one.

The same toolbar carries a page indicator (`3 / 12`). The current page is whichever page sits under the vertical middle of the viewport, recomputed by `pageAtViewportCenter()` on scroll (throttled to one scan per animation frame, and the scan bails out at the first page that starts below the midline, since wrappers are in document order) and again when the zoom debounce settles, because a zoom step changes page heights under a fixed scroll position without firing a scroll event. A jump's own scroll skips the recompute once (`pageJumpScrollPending`), so a target page too short to reach the midline still reads as current instead of being overwritten by its neighbour. The indicator, like the zoom percentage, is a real button, so both are keyboard-reachable; activating it swaps it for a number input: Enter jumps to that page (clamped to range) via `scrollIntoView`, Escape or blur cancels, and keydown propagation is stopped so the viewer's own shortcuts don't fire while typing.

### PDF theming, tools, comments, and scrollbars

PDF page recolouring is applied to the rendered canvas bitmap at render time, not a CSS filter or a pdf.js rendering mode. After `page.render()` finishes, `pdf.ts` recolours the pixels in place based on the page's target appearance. For dark mode it sets `globalCompositeOperation = 'difference'` and fills the canvas with white, which is an exact colour inversion (no hue rotation) of the actual pixels. For the green theme it takes that white-on-black inversion one step further, multiplying it by a phosphor green (`#00ff00`, matching the green palette's `--mc-fg` and GNOME Terminal's "Green on black" profile) so the page reads as green-on-black phosphor; `multiply` leaves the black background black. An earlier version used a CSS filter (`filter: invert(1) hue-rotate(180deg)` on the canvas element, the same trick used by [Folio](https://github.com/owenpkent/folio)), but a CSS filter forces the browser to re-rasterise the layer at CSS resolution, which blurs pages on HiDPI displays; baking the recolour into the bitmap keeps the oversampled render crisp.

Which recolour a page gets is decided by `pageAppearance()` in `pdf.ts`, returning one of `normal` (true colours), `inverted` (dark), or `green` (the phosphor variant). It follows `markcopy.theme` like the Markdown preview: `green` yields the phosphor look, `dark` (or auto mode on a dark VS Code theme) yields the inversion, everything else stays `normal`. The PDF viewer carries the same **Theme** submenu as the Markdown preview (**Auto** / **Light** / **Dark** / **Green on black**), nested under its **Preferences** submenu; picking one posts `updateSetting` to persist the shared `markcopy.theme` (see [Message protocol](#message-protocol)) and re-tints the pages. Separately, a session-only **Dark Pages** / **Light Pages** quick toggle (`pageMode` in `pdf.ts`, one of `auto` / `normal` / `inverted`) does a one-off inversion that overrides the appearance without changing the saved theme. Either way, toggling clears every rendered page and re-rasterises the visible ones, since the recolour is baked into the bitmap rather than a live filter. **Copy Page as PNG** still copies the page in true colours for every appearance: for `inverted` it fast-inverts a throwaway copy of the canvas back, and for `green` (where the phosphor multiply is not exactly reversible) it re-rasterises the page clean. A `forced-color-adjust: none` rule on the page root keeps Windows High Contrast from recoloring page content.

Because pages now have a real text layer, `pdf.ts` no longer treats every drag as a pan. The **Preferences** submenu toggles between a **Hand Tool (Drag to Scroll)** and a **Pointer Tool (Select Text)** (`mode` in `pdf.ts`, `'hand'` or `'pointer'`, starting in hand mode). Hand mode drags anywhere on the page area to pan (pointer events, with pointer capture so a drag that leaves the webview still delivers `move`/`up`, and the cursor switching between `grab` and `grabbing` via the `mc-grabbing` body class); pointer mode leaves drags to the browser's native text selection instead.

Comments are pin notes: right-click a page and choose **Add Comment Here** to drop a pin at the click position (stored as a fraction of the page's width/height, `xPct`/`yPct`, so pins stay put across zoom) and open an editable note popover; clicking an existing pin reopens that popover to edit or delete it. Comments persist to a sidecar JSON file next to the PDF, `<filename>.pdf.mccomments.json`, written and deleted by `pdfEditor.ts`'s `writeComments` (an empty array deletes the file) so the PDF itself is never modified; the webview sends the full current array via a `saveComments` message on every add, edit, or delete, and receives the saved array back in the `load` message's `comments` field when the PDF is reopened.

The PDF view also gets always-visible, styled scrollbars, scoped to the PDF page's root element (`html.mc-pdf-root`) so the Markdown preview's scrollbars are unaffected.

## Theming

`media/preview.css` defines the palette as CSS custom properties (`--mc-fg`, `--mc-bg`, `--mc-border`, code/table/link colors, and the highlight.js tokens), with GitHub-light values as the default. A single selector block overrides them with GitHub-dark values, so the rest of the stylesheet references variables and never repeats a color.

The `markcopy.theme` setting (`auto` / `light` / `dark`) is passed to the webview in the `render` message and applied as a `data-mc-theme` attribute on `body`. The dark override fires when:

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

Two layers, matching the two runtimes:

- **Unit (`tests/`, vitest + jsdom).** Covers the pure, host-independent logic: markdown-it rendering and source-line mapping (`src/render.ts`), CSV/TSV serialization (`src/webview/table.ts`), HTML-to-Markdown conversion (`src/webview/markdownConvert.ts`), and image-src classification plus the auto-preview decision (`src/preview-utils.ts`, `tests/preview-utils.test.ts`). These were extracted from `main.ts` / `extension.ts` specifically so they import without a DOM or the VS Code API. Run with `npm test`.
- **Integration (`test-integration/`, Mocha + `@vscode/test-electron`).** Runs the built extension in a downloaded VS Code instance (`.vscode-test.mjs` config, compiled via `tsconfig.integration.json` to `out/`) and asserts activation, command registration (including `markcopy.openSettings`), configuration defaults (including the `autoPreview` default), that the preview panel opens, and that focusing an on-disk Markdown file auto-opens a preview for it. Run with `npm run test:integration`; on Linux and CI it needs a display (`xvfb-run`).

Webview-internal behavior (the actual clipboard writes, the context menu) is not asserted automatically, since it runs sandboxed inside the webview; exercise it by hand in the Extension Development Host (F5). Both layers run in CI (see [CONTRIBUTING](../.github/CONTRIBUTING.md#tests)).

## Future ideas

- **Shared `pdf-core` with Folio.** The PDF preview shares techniques with [Folio](https://github.com/owenpkent/folio) (a Tauri + React desktop PDF viewer), most visibly the dark-mode inversion technique (originally a CSS filter ported by hand, now a canvas-bitmap inversion for HiDPI crispness). If the overlap grows (text extraction, page-to-PNG, reading-mode filters, outline/nav), consider extracting a small **framework-agnostic** TypeScript core both projects import, keeping each UI separate. Deliberately not done yet: today the shared surface is thin and the runtimes differ (Tauri desktop vs. sandboxed VS Code webview), so copying the one technique beat taking on a shared dependency. Extract only once the duplication is actually felt.
- **PDF comments/annotations.** Basic pin comments already exist: right-click **Add Comment Here** drops a pin with an editable note, persisted to a sidecar JSON file (see [PDF theming, tools, comments, and scrollbars](#pdf-theming-tools-comments-and-scrollbars)). The open design question for anything beyond that is deeper persistence, and it drives everything else:
  - _Sidecar JSON_ (what's implemented today, `<filename>.pdf.mccomments.json` beside the file) keeps the PDF read-only and is git-friendly, but comments are only visible in MarkCopy.
  - _Embed into the PDF_ (real `/Annots` via a writer like `pdf-lib`) makes them portable to any viewer, but requires switching the read-only custom editor to a writable one with a save flow, plus a new dependency.
  - _In-memory only_ is fine for prototyping the interaction before committing to storage.

  Pages now have a pdf.js text layer, so word-level text selection works; region- or highlight-style annotations (as opposed to today's point pins) are still unimplemented.
