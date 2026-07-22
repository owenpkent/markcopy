# Testing MarkCopy

How MarkCopy gets verified, from the automated suites to the manual checklist that gates a release. The automated layers run on every push; the manual checklist below is what "tested" means before publishing (see the [pre-release checklist](../RELEASING.md#pre-release-checklist) in RELEASING.md).

## The three layers

| Layer                  | Runs                             | Covers                                                                                                                                     |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit tests (vitest)    | `npm test`, CI on every push     | Pure logic: markdown-it rendering and source-line mapping, CSV/TSV serialization (RFC 4180), HTML-to-Markdown conversion, preview helpers. |
| Integration (VS Code)  | `npm run test:integration`, CI   | Activation, command registration, configuration defaults, the preview panel opening, inside a real downloaded VS Code.                     |
| Manual (this document) | Before every release, by a human | Everything the webviews do: clipboard writes, the context menu, rendering fidelity, the PDF viewer, paste targets outside VS Code.         |

The manual layer exists because the interesting behavior lives inside webviews, where the automated harnesses cannot reach: `document.execCommand`/Clipboard API writes, canvas rasterisation, text-layer selection, and how the clipboard flavors actually paste into Word or Gmail.

## Setting up a manual pass

1. Build and launch: `npm run compile`, then **F5** in VS Code (the Extension Development Host). For a release candidate, test the packaged artifact instead: `npm run vsix`, then `code --install-extension markcopy-<version>.vsix` in a regular window.
2. Fixtures:
   - [sample.md](../sample.md) (repo root) exercises the Markdown surface: tables, code, Mermaid, math, images.
   - `sample.pdf` (repo root, gitignored): generate it once with `node scripts/make-sample-pdf.js`. Twelve pages, each labeled with its page number, so the page indicator and go-to-page are easy to eyeball.
3. To inspect a webview while testing, run **Developer: Open Webview Developer Tools** from the Command Palette.

Work through the checklists below. A **patch** release needs the sections touched by the change plus the smoke rows marked ★. A **minor or major** release needs the full pass.

## Markdown preview

### Rendering

- [ ] ★ Open `sample.md`; the preview auto-opens to the side (`markcopy.autoPreview`).
- [ ] Headings, lists, task lists, blockquotes, and links render GitHub-style.
- [ ] Fenced code blocks are syntax-highlighted.
- [ ] Mermaid diagrams render and re-theme when the VS Code theme changes.
- [ ] Inline `$...$` and display `$$...$$` math render with KaTeX; turning `markcopy.math` off shows literal dollar signs again.
- [ ] Relative and absolute local images render; remote images still load.

### Copy actions

Spot-check one row per clipboard flavor; the full table is the [Copy Matrix](COPY-MATRIX.md).

- [ ] ★ Right-click a table, **Copy Table (Rich Text)**, paste into Word or Google Docs: a real table arrives, not Markdown source.
- [ ] **Copy Table as CSV**, paste into Excel or Google Sheets: real cells.
- [ ] **Copy Block as PNG** on a paragraph, paste into a chat or slide: an image arrives.
- [ ] **Copy Diagram as PNG** on a Mermaid diagram.
- [ ] Select some text, right-click, **Copy Selection as Markdown**: the original Markdown source comes back.
- [ ] Right-click a rendered equation, **Copy Equation as LaTeX**: the original source comes back.
- [ ] ★ **Copy Whole Document as Rich Text** (menu or command palette), paste into an email draft: formatting intact.
- [ ] Every successful copy shows a toast.

### Settings, themes, and sync

- [ ] Right-click, **Theme**: Auto, Light, Dark, and Green on black all apply immediately and persist to `markcopy.theme`.
- [ ] Green on black is pure `#00ff00` on black (not a soft mint), and copied/exported output still forces light styling.
- [ ] **Sync scroll**, **Auto-open preview**, and **Math** toggles in the menu write through to settings; the gear icon opens the MarkCopy settings page.
- [ ] With sync scroll on, scrolling the editor scrolls the preview to match.
- [ ] **MarkCopy: Save as PDF** produces a PDF of the document.

## PDF viewer

Open `sample.pdf` (generate it first; see [Setting up](#setting-up-a-manual-pass)).

### Loading and navigation

- [ ] ★ The PDF opens in MarkCopy's viewer with a "Loaded 12 pages" toast, and the toolbar (bottom-right) reads `1 / 12`.
- [ ] Scrolling updates the page indicator; the current page is whichever sits under the vertical middle of the window.
- [ ] ★ Click `1 / 12`, type `7`, press Enter: the view jumps to page 7 and the label reads `7 / 12`.
- [ ] Out-of-range entries clamp: `99` lands on page 12, `0` on page 1.
- [ ] Escape (or clicking elsewhere) closes the go-to-page input without jumping.
- [ ] While the input is open, Escape closes only the input (not the context menu) and typing does not trigger viewer shortcuts.
- [ ] Tab reaches the page and zoom buttons; Enter activates them (both are real buttons).

### Zoom

- [ ] ★ Minus/plus buttons, Ctrl+plus / Ctrl+minus / Ctrl+0, and Ctrl+mouse-wheel all step the zoom (50 to 400 percent); pages re-rasterise crisp, not scaled-blurry.
- [ ] Clicking the percentage resets to 100 percent.
- [ ] After a zoom step, the page indicator settles on whatever page actually sits under the midline.

### Tools, selection, and copy

- [ ] Right-click toggles between **Hand** (drag pans) and **Pointer** (text selection) tools.
- [ ] Select text with the Pointer tool; right-click, **Copy Selected Text** pastes the selection.
- [ ] **Copy Page N Text** and **Copy All Text** paste the expected plain text.
- [ ] ★ **Copy Page N as PNG** yields a true-color page image even when the viewer shows dark or green pages.

### Comments

- [ ] Right-click, **Add Comment Here** drops a pin; the note saves to `<file>.pdf.mccomments.json` next to the PDF.
- [ ] Deleting the last comment removes the sidecar file.

### Theming

- [ ] ★ **Theme** menu: Auto, Light, Dark, and Green on black re-tint the pages; Green on black renders green-on-black phosphor in pure `#00ff00`.
- [ ] **Dark Pages** / **Light Pages** quick toggle changes the pages for this session only (the saved `markcopy.theme` is untouched).
- [ ] Changing the theme from a Markdown preview (or settings.json) re-tints an already-open PDF.
- [ ] Scrollbars are always visible and styled.

## Paste-target pass

For a minor or major release, take the ★ copy rows above to the real targets at least once: Word (or Outlook), Gmail or another web email, Google Docs, and Excel or Google Sheets. The [Copy Matrix](COPY-MATRIX.md) says what should paste well where; anything that pastes as raw Markdown, loses table structure, or arrives blank is a release blocker.

## When a check fails

A regression in shipped behavior blocks the release: fix it (or revert the offending change) and restart the checklist section it belongs to. For a pre-existing issue that a release does not make worse, file it and move on. Either way, capture what broke and where it was pasted (the [issue guidance](../CONTRIBUTING.md#filing-issues) asks for the copy action and paste target).
