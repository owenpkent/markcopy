# MarkCopy: Rich Markdown & PDF Preview

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/OwenPKent.markcopy.svg?label=VS%20Code%20Marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=OwenPKent.markcopy)
[![Open VSX](https://img.shields.io/open-vsx/v/OwenPKent/markcopy?label=Open%20VSX&color=a60ee5)](https://open-vsx.org/extension/OwenPKent/markcopy)
[![CI](https://github.com/owenpkent/markcopy/actions/workflows/ci.yml/badge.svg)](https://github.com/owenpkent/markcopy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code ^1.90](https://img.shields.io/badge/VS%20Code-%5E1.90-007ACC.svg)](https://code.visualstudio.com/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Install:** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=OwenPKent.markcopy), from [Open VSX](https://open-vsx.org/extension/OwenPKent/markcopy) (Cursor, VSCodium, Windsurf), or run `code --install-extension OwenPKent.markcopy`.

> The preview built for getting content _out_. Right-click anywhere in the rendered preview and copy it in the format you actually need: rich text that pastes **with formatting** into Word, Outlook, Gmail and Google Docs, a per-element copy of a code block or table, the raw Markdown source, or a PNG image of a diagram. It opens PDFs too, so one extension previews both Markdown and PDF.

VS Code's built-in preview and the popular alternatives (Markdown Preview Enhanced, Markdown All-in-One, GitHub Styling) have no first-class "copy the rendered output as rich text." MarkCopy is designed around exactly that.

![Right-click a table in the MarkCopy preview to copy it as rich text, CSV, TSV, or PNG](docs/media/context-menu.png)

<!-- The images are generated from the real preview + media/preview.css via `npm run screenshot`. A screen-recorded GIF of pasting into Word or Gmail would be a welcome contribution. -->

MarkCopy follows your VS Code theme, with a polished GitHub-light or GitHub-dark palette:

![The MarkCopy preview and copy menu in a dark VS Code theme](docs/media/context-menu-dark.png)

## Why it exists

When you copy Markdown you only get `text/plain`, the raw `# heading *asterisks*`. Word, Outlook, Gmail and Google Docs are rich-text editors: they render formatting only when it arrives on the clipboard as `text/html`. MarkCopy renders your Markdown, then writes **both** `text/html` and `text/plain` to the clipboard so the receiving app keeps your headings, bold, lists, tables, links and code. Styles are inlined so the formatting even survives Gmail and Outlook, which strip `<style>` blocks and external CSS.

## Features

- **Copy as Rich Text**, for the whole document or just a selection. Pastes formatted into Word, Outlook, Gmail, Google Docs, Slack and OneNote.
- **Per-element right-click copy**, with the menu adapting to what you clicked:
  - Code block: **Copy Code** as plain text.
  - Table: **Rich Text**, **CSV**, **TSV** (both paste as real cells in Excel and Google Sheets), or **PNG**.
  - Mermaid diagram: **PNG** or **SVG**.
  - Equation (KaTeX): **Copy Equation as PNG** or **Copy Equation as LaTeX**.
  - Any block: **Rich Text**, **Markdown source**, or **PNG**.
- **Copy as raw Markdown**, for a selection or a single block.
- **Save as PDF.** Export the rendered preview to a self-contained HTML file that opens in your browser and prints to PDF, with equations, diagrams, highlighted code, and local images all intact and text still selectable. Run **MarkCopy: Save as PDF** (Command Palette), click the PDF button in the preview's title bar, or use **Save as PDF…** in the right-click menu.
- **Live preview** that updates as you type, with editor and preview scroll kept in sync.
- **Auto-open preview**, on by default (`markcopy.autoPreview`). Opening or focusing a Markdown file opens the preview beside it, or retargets an already-open preview to it, without moving your cursor or opening a new column. Close a preview and it stays closed for that file until you reopen it.
- **GitHub-accurate styling** for output that pastes cleanly into docs and email.
- **First-class light and dark.** The preview matches your theme with a GitHub-light or GitHub-dark palette, and copied rich text is always light-safe, so it stays readable when pasted into a white document even from a dark preview. A **green-on-black** terminal palette is available too (`markcopy.theme: green`, or **Green on black** in the Theme menu).
- **Mermaid diagrams** (flowchart, sequence, class, state, gantt, pie, and more) that follow the light/dark theme, plus syntax-highlighted code, out of the box. Configure Mermaid via `markcopy.mermaid`.
- **Math rendering with KaTeX.** Inline `$...$` and display `$$...$$` Markdown math render as equations. Right-click one to copy it as a PNG or restore its original LaTeX source; "Copy as Markdown" also restores the LaTeX rather than the rendered markup. Toggle with `markcopy.math` (on by default, turn it off for docs that use literal dollar signs).
- **Local images render in the preview.** Relative and absolute paths (`![](media/x.png)`, `![](./diagram.png)`) resolve to the right file; remote (`http(s):`), `data:`, and `blob:` images are unchanged.
- **PDF preview built in.** Open any `.pdf` and MarkCopy renders it with pdf.js, with a real selectable text layer, right-click **Copy Page as PNG**, **Copy Page Text**, **Copy All Text**, and **Copy Selected Text**. A floating toolbar shows the current page (click it to jump to any page) and zooms from 50 to 400 percent while keeping pages crisp, right-click toggles between a Hand tool (drag to pan) and a Pointer tool (select text), and right-click **Add Comment Here** drops a pin comment saved next to the PDF. The pages share the Markdown preview's right-click **Theme** menu (Auto, Light, Dark, or **Green on black** phosphor), plus a session-only **Dark Pages** / **Light Pages** quick toggle. One extension previews both Markdown and PDF.
- **Settings without leaving the preview.** Right-click for **Theme** and **Sync scroll** / **Auto-open preview** / **Math** toggles, or use the gear icon in the preview's title bar. Both write straight to your VS Code settings.

See the full breakdown in the [Copy Matrix](docs/COPY-MATRIX.md): every action, the clipboard flavor it writes, and where it pastes cleanly.

## Getting started

1. Install the extension (see [Install](#install)).
2. Open any `.md` file. The preview opens automatically beside it (`markcopy.autoPreview`), or run **MarkCopy: Open Rich Preview to the Side** from the Command Palette or the right-click menu in the editor or Explorer.
3. **Right-click inside the preview.** The menu options change based on whether you clicked a code block, table, diagram, plain block, or a text selection.

To grab everything at once, run **MarkCopy: Copy Whole Document as Rich Text**, or **MarkCopy: Save as PDF** to export the whole preview to a printable PDF via your browser.

Local images in the document render automatically, and the right-click menu's settings section (or the gear icon in the preview's title bar) lets you change theme, sync scroll, math, and auto-preview without leaving the preview.

## Commands

| Command                                    | ID                                | What it does                                                                                            |
| ------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| MarkCopy: Open Rich Preview to the Side    | `markcopy.openPreview`            | Opens (or focuses) the preview beside the editor.                                                       |
| MarkCopy: Copy Whole Document as Rich Text | `markcopy.copyDocumentAsRichText` | Copies the entire rendered document as rich text.                                                       |
| MarkCopy: Save as PDF                      | `markcopy.saveAsPdf`              | Exports the rendered preview to a self-contained HTML file and opens it in the browser to print to PDF. |
| MarkCopy: Settings                         | `markcopy.openSettings`           | Opens the MarkCopy settings.                                                                            |

## Settings

`markcopy.syncScroll`, `markcopy.autoPreview`, `markcopy.math`, and `markcopy.theme` can also be changed live from the preview's right-click settings section or the gear icon in its title bar, not just here.

| Setting                 | Type                                   | Default  | Description                                                                                                                                                            |
| ----------------------- | -------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markcopy.styleProfile` | `github`                               | `github` | Rendering style. `github` matches GitHub Markdown (best for pasting into docs and email).                                                                              |
| `markcopy.syncScroll`   | boolean                                | `true`   | Keep the preview scroll position in sync with the editor.                                                                                                              |
| `markcopy.autoPreview`  | boolean                                | `true`   | Automatically open the preview beside the editor when you focus a Markdown file, and keep it targeted on whichever file has focus. Turn off to open previews manually. |
| `markcopy.theme`        | `auto` \| `light` \| `dark` \| `green` | `auto`   | Preview palette. `auto` follows your VS Code theme; `light`, `dark`, and `green` (green-on-black terminal style) force it. Copies stay light-safe either way.          |
| `markcopy.mermaid`      | object                                 | `{}`     | Extra Mermaid config merged into `mermaid.initialize` (for example `fontFamily`, `flowchart`, or `themeVariables`). Diagrams follow the light/dark palette by default. |
| `markcopy.math`         | boolean                                | `true`   | Render `$...$` and `$$...$$` Markdown math as KaTeX equations. Turn off for documents that use literal dollar signs.                                                   |

## Install

**From the Marketplace** (published as [`OwenPKent.markcopy`](https://marketplace.visualstudio.com/items?itemName=OwenPKent.markcopy)):

- In VS Code: open the Extensions view, search **MarkCopy**, and click Install.
- Or from a terminal: `code --install-extension OwenPKent.markcopy`

It is also available on [Open VSX](https://open-vsx.org/extension/OwenPKent/markcopy) for Cursor, VSCodium, and Windsurf.

**From the packaged VSIX** (local build):

```bash
npm install
npm run vsix                                   # produces markcopy-<version>.vsix
code --install-extension markcopy-<version>.vsix
```

See [RELEASING.md](RELEASING.md) for how releases are cut and published.

## How the copy works

`vscode.env.clipboard` is text-only, so rich copy happens **inside the webview**. MarkCopy writes both `text/html` and `text/plain` through a synchronous `copy`-event handler, which is more reliable than the async Clipboard API (that one can be permission-blocked inside the webview iframe). PNG copy uses `html-to-image` plus a `ClipboardItem`. The full rationale, including the Gmail/Outlook inline-styling requirement, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#clipboard).

## PDF preview

MarkCopy registers as the editor for `.pdf` files, so opening a PDF renders it inline (VS Code has no built-in PDF viewer). Rendering uses Mozilla's pdf.js, the same engine behind [folio](https://github.com/owenpkent/folio). Each page has a real, selectable text layer over the canvas, so you can highlight text directly on the page. Right-click a page for:

- **Copy Page as PNG**: the rendered page as an image, for slides and chat.
- **Copy Page Text** / **Copy All Text**: the selectable text, extracted per page.
- **Copy Selected Text**: just the text you highlight.
- **Add Comment Here**: drop a pin with an editable note; click a pin to edit or delete it. Comments are saved to a `<filename>.pdf.mccomments.json` file next to the PDF (the PDF itself stays read-only) and reload when you reopen it.
- **Hand Tool (Drag to Scroll)** / **Pointer Tool (Select Text)**: right-click to toggle between panning by drag and selecting text.
- **Theme**: the same menu as the Markdown preview (Auto, Light, Dark, or Green on black). Picking one persists `markcopy.theme` (shared with the Markdown preview) and re-tints the pages; Green on black renders them as green-on-black phosphor.
- **Dark Pages** / **Light Pages**: a session-only override of the page palette that does not change the saved theme (it otherwise follows `markcopy.theme`, like the Markdown preview).

A floating toolbar in the bottom-right corner shows the current page (for example `3 / 12`) as you scroll; click it, type a page number, and press Enter to jump there. The same toolbar steps zoom through preset levels (50 to 400 percent) with minus/plus buttons, Ctrl and plus / Ctrl and minus / Ctrl and 0, or Ctrl plus the mouse wheel; clicking the percentage resets to 100 percent. Pages re-rasterise at each level, and only pages near the viewport stay rendered, so large PDFs stay sharp and memory-bounded. The view also has always-visible styled scrollbars.

The file is read by the extension host and handed to the webview as bytes, so nothing is fetched over the network. To open a PDF as raw bytes instead, use **Reopen Editor With...** from the editor title menu.

## Compared to the alternatives

|                                          | Built-in | Markdown Preview Enhanced | MarkCopy |
| ---------------------------------------- | :------: | :-----------------------: | :------: |
| Rich-text copy from the rendered preview |    No    |            No             | **Yes**  |
| Per-code-block copy                      |    No    |      Requested, open      | **Yes**  |
| Table as CSV / TSV / cells               |    No    |          Partial          | **Yes**  |
| Diagram as PNG to clipboard              |    No    |      Export to file       | **Yes**  |
| Copy block as Markdown source            |    No    |            No             | **Yes**  |
| Live preview + scroll sync               |   Yes    |            Yes            | **Yes**  |
| PDF preview built in                     |    No    |            No             | **Yes**  |

## Documentation

- [Copy Matrix](docs/COPY-MATRIX.md): every context-menu action and its clipboard output.
- [Architecture](docs/ARCHITECTURE.md): how rendering, the webview, and the clipboard fit together.
- [Contributing](CONTRIBUTING.md): build, debug, and release.
- [Code of Conduct](CODE_OF_CONDUCT.md).
- [Security](SECURITY.md): CSP, sandboxing, and reporting.
- [Changelog](CHANGELOG.md).

## Develop

```bash
npm install
npm run compile     # type-check + build the extension and webview bundles
npm run watch       # rebuild on change
npm test            # vitest unit tests
# press F5 in VS Code to launch the Extension Development Host, then open sample.md
```

Full details in [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- PlantUML support.
- An "email-safe" export profile (table-based layout, fully inlined).

## License

[MIT](LICENSE)
