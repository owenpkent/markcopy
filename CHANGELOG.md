# Changelog

All notable changes to MarkCopy are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- KaTeX / LaTeX math rendering, and copy-as-image for equations.
- PlantUML support.
- An email-safe export profile (table-based layout, fully inlined).

## [0.2.2] - 2026-07-19

### Fixed
- **Links in the rendered preview now work.** They were inert: the webview had no click handler, and relative hrefs resolved against the `vscode-webview://` base, so clicking did nothing. Now in-page `[x](#heading)` anchors scroll the preview to the heading; cross-document `other.md` links retarget the preview and land at the top of the new document (or the linked heading if the link carried a `#fragment`), while live edits to the same document keep the reader's scroll position; external links open in the browser and other local files (images, `.pdf`) open via VS Code, so a linked `.pdf` lands in MarkCopy's own PDF preview. Link classification is a pure, unit-tested `classifyLink` helper, and `openExternal` is restricted to `http`/`https`/`mailto` schemes.

## [0.2.1] - 2026-07-19

### Security
- **Preview HTML is now sanitized before it's inserted into the webview.** The rendered Markdown (which allows raw HTML) is passed through DOMPurify, which strips `<script>`, inline event handlers, and `javascript:` URIs while keeping formatting, source-line mapping, and Mermaid placeholders intact. The webview CSP (`script-src 'nonce-...'`, no `unsafe-inline`) already blocked script execution, so this is defense in depth: an XSS is no longer one CSP change away from firing. Remote `https:` images still render as before.
- **Local publishing tokens can no longer leak into a packaged `.vsix`.** `.env` and `.env.*` are now listed in `.vscodeignore`, so a `vsce package` cannot bundle the `VSCE_PAT` / `OVSX_PAT` files (they were already gitignored).
- **CI GitHub Actions are pinned to commit SHAs** instead of floating major tags, closing the unpinned-action supply-chain vector.

## [0.2.0] - 2026-07-19

### Fixed
- **Auto-preview reliably opens now.** Added the `onLanguage:markdown` activation event (the extension previously had no activation events at all, so it could fail to activate in time); the auto-preview check also now runs once at activation for the already-active editor, since `onDidChangeActiveTextEditor` never fires for the file that triggered activation.
- **Retargeting the preview to a different Markdown file no longer opens a third editor column.** The preview now reveals in its existing column instead of "Beside", and if VS Code opened the newly-focused file into the preview's own column, it's moved back to the first column.
- **PDF preview no longer renders a blank page.** The pdf.js worker is now started from a same-origin blob URL (fetched and wrapped in a `Blob`) instead of its cross-origin `webview-resource:` URI, which threw a `SecurityError`; and the PDF bytes are now sent to the webview as base64 and decoded back to a `Uint8Array`, since a `Uint8Array` doesn't survive webview `postMessage`. Load failures now show a visible error in the panel instead of a silent blank.

### Changed
- **"Copy Block ..." vs "Copy Selection ..." no longer overlap.** The in-preview right-click menu now shows "Copy Block as Rich Text / Markdown / PNG" only when there's no text selection, and "Copy Selection as Rich Text / Markdown" only when there is one.
- Removed `markcopy.copyDocumentAsRichText` from the editor right-click menu (still available from the Command Palette and the in-preview right-click menu).
- Removed the `markcopy.openPreview` button from the Markdown editor's title bar (still available from the Command Palette and the Explorer right-click menu); its icon changed to `$(book)`.

### Added
- **PDF dark mode.** Pages follow `markcopy.theme` (auto/light/dark) like the Markdown preview, inverted by flipping the rendered canvas bitmap at render time (a `difference`-with-white composite: a plain colour inversion, no hue rotation) rather than a CSS filter, so pages stay crisp on HiDPI displays; a right-click **Dark Pages** / **Light Pages** item overrides it for the session, and **Copy Page as PNG** still copies the true, non-inverted page. A `forced-color-adjust: none` rule keeps Windows High Contrast from recoloring pages.
- **Selectable text layer in the PDF preview.** Each page now has a real pdf.js text layer (transparent, selectable spans) over the canvas, so you can select text directly on a page; **Copy Selected Text** now genuinely copies your highlight.
- **Hand / Pointer tool toggle in the PDF preview.** Right-click a page to switch between a **Hand Tool (Drag to Scroll)**, which drags anywhere to pan, and a **Pointer Tool (Select Text)**, which leaves text selection to the text layer above. Cursor switches between grab and grabbing in hand mode.
- **Zoom in the PDF preview.** A floating toolbar (bottom-right) with minus, a percentage, and plus, stepping through preset levels (50, 67, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400 percent). Also available via Ctrl and plus / Ctrl and minus / Ctrl and 0, and Ctrl plus the mouse wheel; clicking the percentage resets to 100 percent. Pages re-rasterise at each level so text stays sharp.
- **PDF comments.** Right-click a page and choose **Add Comment Here** to drop a pin with an editable note; click a pin to edit or delete it. Comments persist to a sidecar JSON file next to the PDF (`<filename>.pdf.mccomments.json`), so the PDF itself stays read-only, and reload when the PDF is reopened.
- **Crisp, virtualised PDF rendering.** Only pages near the viewport are rasterised (via an `IntersectionObserver`) and offscreen pages are torn down, so large PDFs don't exhaust memory. Each page renders above display resolution (at least 2x, or the device pixel ratio if higher) clamped to a canvas pixel budget, so text is sharp without oversized-canvas blur.
- **Always-visible, styled scrollbars** in the PDF preview, scoped so the Markdown preview is unaffected.

## [0.1.0] - 2026-07-18

### Added
- **Local images in the preview**: relative and absolute image paths (e.g. `![](media/x.png)`) now resolve correctly. Image `src` is rewritten to a webview-safe URI and the preview is granted read access to the document's workspace folder, fixing broken-image icons.
- **Auto-open preview** (`markcopy.autoPreview`, on by default): the preview opens to the side automatically when you focus a Markdown file, and retargets as you switch files, keeping your cursor in the editor. A preview you close stays closed for that file so it never springs back.
- **In-preview settings menu**: the right-click menu now has a settings section to switch **theme** (auto/light/dark) and **style** (GitHub/VS Code), toggle **sync scroll** and **auto-open preview**, and jump to the full MarkCopy settings. A **gear** button in the preview title bar opens the settings too.
- **PDF preview**: MarkCopy now opens `.pdf` files in a built-in read-only viewer (pdf.js), with right-click **Copy Page as PNG**, **Copy Page Text**, **Copy All Text**, and **Copy Selected Text**. One extension previews both Markdown and PDF.
- **Copy Table as CSV** in the table right-click menu (RFC 4180 quoting), alongside the existing TSV option.
- Project tooling adopted from folio: ESLint 9 (flat config), Prettier, gitleaks/pinact pre-commit hooks, `.editorconfig`, and `npm run lint` / `format` scripts. CI now lints and checks formatting.
- Unit tests (vitest + jsdom) covering markdown-it rendering and source-line mapping, CSV/TSV table serialization (RFC 4180), and HTML-to-Markdown conversion. Run with `npm test`; CI runs them on every push and PR.
- Integration tests (Mocha + `@vscode/test-electron`) that run the extension in a real VS Code instance: activation, command registration, configuration defaults, and preview-panel opening. Run with `npm run test:integration`; CI runs them on Linux under `xvfb`.

- **Dark mode**: the preview renders a polished GitHub-dark palette (text, code, tables, blockquotes, links, and syntax highlighting) in dark and high-contrast VS Code themes, for both style profiles. Rich-text copies force a light palette during serialization, so pasted content stays dark-on-light and readable in white documents even from a dark preview.
- **`markcopy.theme` setting** (`auto` / `light` / `dark`) to follow the VS Code theme or force a preview palette. The Markdown preview updates live when the setting changes; open PDFs pick it up when reopened.
- **Theme-aware Mermaid diagrams**: diagrams now render with Mermaid's dark theme in dark/high-contrast VS Code themes (and re-render when the color theme changes), instead of always using the light theme. New **`markcopy.mermaid`** setting merges custom Mermaid config into `mermaid.initialize`.

- **Marketplace polish**: an extension icon (`media/icon.png`, generated by `npm run icon`), a dark gallery banner, Open VSX publishing (`npm run publish:ovsx`), and a [RELEASING.md](RELEASING.md) guide covering publisher setup, both registries, and the verified-publisher badge.

### Changed
- **Copy Selection as Markdown** now copies exactly the selected content, including partial paragraphs and selections that span multiple blocks (the selected HTML is converted with Turndown), instead of the whole block the selection started in.

## [0.0.1] - 2026-07-16

Initial release.

### Added
- Custom-webview Markdown preview, opened with **MarkCopy: Open Rich Preview to the Side** from the Command Palette, editor title bar, or the editor and Explorer right-click menus.
- Adaptive right-click context menu in the preview:
  - Selection: copy as rich text or as Markdown.
  - Code block: copy code as plain text.
  - Table: copy as rich text, as TSV, or as PNG.
  - Mermaid diagram: copy as PNG or as SVG.
  - Any block: copy as rich text, as Markdown source, or as PNG.
  - Whole document: copy as rich text (also available via **MarkCopy: Copy Whole Document as Rich Text**).
- Rich-text copy writes both `text/html` and `text/plain`, with styles inlined so formatting survives Gmail and Outlook.
- PNG copy of blocks, tables, and diagrams via html-to-image.
- Live preview that updates on edit, with editor and preview scroll sync.
- GitHub and VS Code style profiles (`markcopy.styleProfile`) and a scroll-sync toggle (`markcopy.syncScroll`).
- Mermaid diagrams and highlight.js syntax highlighting.

[Unreleased]: https://github.com/owenpkent/markcopy/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/owenpkent/markcopy/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/owenpkent/markcopy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/owenpkent/markcopy/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/owenpkent/markcopy/releases/tag/v0.0.1
