# Testing MarkCopy

How MarkCopy gets verified, from the automated suites to the manual checklist that gates a release. The automated layers run for pull requests and pushes to `main` (and can be started manually); the manual checklist below is what "tested" means before publishing (see the [pre-release checklist](RELEASING.md#pre-release-checklist) in RELEASING.md).

## The four layers

| Layer                  | Runs                                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests (vitest)    | `npm test`, CI on pull requests and pushes to `main` | Pure logic: markdown-it rendering and source-line mapping, CSV/TSV serialization (RFC 4180), HTML-to-Markdown conversion, preview helpers, scroll-sync interpolation, PDF export command line and print CSS, the Word export's OOXML writer, LaTeX engine discovery and compile-log parsing, the OOXML reader (number formats, date serials, merges, hidden rows, malformed and hostile workbooks), STL sniffing and its pre-allocation guards, the video preview's duration, size, timecode, frame-filename and media-error formatting, the GIF header parser (frame delays, loop count, truncated and non-GIF input), and the spreadsheet preview's contract with the shared webview bundle. |
| Webview E2E (vitest)   | `npm test`, CI on pull requests and pushes to `main` | The preview bundle itself, booted in jsdom and driven through its own context menu: which rows the menu offers, what each copy action puts on the clipboard, the sheet grid and its tab strip, and scroll sync in both directions. See [the webview E2E layer](#the-webview-e2e-layer).                                                                                                                                                                                                                                                                                                                                                                                                        |
| Integration (VS Code)  | `npm run test:integration`, CI                       | Activation, command registration, configuration defaults, the preview panel opening, and which editor claims a `.xlsx`/`.xlsm`/`.pdf`/`.stl`/`.mov`/`.mp4`, inside a real downloaded VS Code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Manual (this document) | Before every release, by a human                     | What none of the above can see: rendering fidelity, theme legibility, the PDF viewer's canvas, the STL viewer's WebGL output and orbit feel, whether a video actually plays and yields a frame, and how the clipboard flavors actually paste into Word or Gmail.                                                                                                                                                                                                                                                                                                                                                                                                                               |

The manual layer is smaller than it was. What keeps a row in it is needing a real browser or a real human eye: canvas rasterisation (PNG copy, the PDF viewer), a real media pipeline (playback and the frame grab, which jsdom cannot reach at all), text-layer selection, whether a palette is legible rather than merely applied, and the paste targets outside VS Code. The automated webview coverage is limited to the menu, clipboard, sheet-grid, and scroll-sync surfaces listed above.

### Fuzzing

Parsers and converters that read data the user did not write are fuzzed with [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) (coverage-guided, in process): the zip container (`zip`), workbooks (`xlsx`), decks (`pptx`), Word documents (`docx`), XML (`xml`), CSV (`csv`), video notes files (`review`), Markdown (`markdown`), GIF structure (`gif`), image headers (`image`), STL headers (`stl`), ffprobe/ffmpeg output (`video-probe`), link handling (`links`), the paste and export converters (`paste-export`), sanitized Markdown output (`markdown-html`) and the webview-to-host message parsers (`messages`). The targets are `fuzz/targets/<name>.fuzz.ts`, seeded from `fuzz/corpus/<name>/`. The nightly [fuzz workflow](../.github/workflows/fuzz.yml) runs each for ten minutes, caches the evolved corpus, and on a crash uploads the input and opens (or comments on) a GitHub issue titled `Fuzz crash: <target>`, with the run link and the end of the fuzzer log. It is not part of `npm test`; before a release, check there is no open `Fuzz crash:` issue (see [RELEASING](RELEASING.md#pre-release-checklist)).

```bash
npm run fuzz -- xlsx 60    # target, then whole seconds (default 60, or set FUZZ_SECONDS); each input may take up to 10 s
```

Two targets check a property rather than only looking for crashes. `links` throws when a href a browser reads as `javascript:`, `data:`, `file:` or any scheme other than `http`, `https` and `mailto` is both followed by the host (`hostFollowsLink`) and classified as an external link (`classifyLink`). `markdown-html` renders the input, runs it through DOMPurify in jsdom with the defaults the webview uses (`DOMPurify.sanitize` in `src/webview/main.ts`), and throws if a `<script>`, an `on*` attribute or a `javascript:` / `vbscript:` URL survives. It covers that one sanitize call, not the later KaTeX or Mermaid upgrades, and jsdom is not a browser, so a mutation-XSS difference between the two would not show. `paste-export` is the one async target; `fuzz/run.js` leaves out `--sync` for it. A target whose harness leaks memory can declare `export const SESSION_SECONDS = <n>`; `fuzz/run.js` then spends the time budget in fresh processes of at most that length, which share the evolved corpus (`markdown-html` uses 90 s, because DOMPurify under jsdom keeps every document it parses).

The script transpiles `src/` and the targets to `out/fuzz/` with esbuild, then runs Jazzer.js with only that code instrumented. The evolved corpus is kept in `fuzz/.corpus/<name>/` and crashing inputs land in `fuzz/crashes/<name>/` as `crash-<hash>` (both untracked). A target catches only the errors the code raises on purpose (`OpcError`, saxes' positioned XML errors, `EditError`); anything else, a hang or an out-of-memory is a finding.

To turn a finding into a regression test, fix the bug, then copy the crash file into `tests/fixtures/` and add a Vitest case that feeds it to the same function and asserts it either returns or throws the documented error. Copy a small input into `fuzz/corpus/<name>/` too if it reaches code the seeds do not.

### The webview E2E layer

`tests/webview/harness.ts` boots the real bundle (`src/webview/main.ts`) in jsdom against the host's own renderers, and hands a test the same surface a reader has: right-click an element, walk the menu, read what landed on the clipboard. Nothing in it reassembles the bundle's steps, so a copy action that stops being wired to its menu row fails there and passes every unit test.

Two things it stands in for are copies of the host's own values, and both are pinned by `tests/e2e/harnessContract.e2e.test.ts` so they cannot drift: the shell HTML from `src/previewShell.ts`, and `SYNC_ECHO_MS` from the bundle.

Its blind spots are jsdom's: no layout (scroll sync runs against a synthetic one), no canvas (`Copy as PNG` is untested), and no `innerText` (the plain-text half of a rich-text copy is unreadable). Rows below that depend on those stay manual, and are marked.

## Setting up a manual pass

1. Build and launch: `npm run compile`, then **F5** in VS Code (the Extension Development Host). The launch config opens this repo as the dev host's workspace, so the fixtures below are already in its Explorer. For a release candidate, test the packaged artifact instead: `npm run vsix`, then `code --install-extension markcopy-<version>.vsix` in a regular window.

   Changing `package.json` contributions (languages, activation events, menus, settings) only takes effect when the dev host **process** starts. After editing the manifest, close the dev host window and press F5 again; a reload is not always enough.

2. Fixtures:
   - [sample.md](../sample.md) (repo root) exercises the Markdown surface: tables, code, footnotes, Mermaid, math, images.
   - [sample.csv](../sample.csv) (repo root) exercises the CSV grid: quoted commas, escaped quotes, a newline inside a cell, currency/percent/negative numbers, a ragged row, and non-ASCII text.
   - `sample.pdf` (repo root, gitignored): generate it once with `node scripts/make-sample-pdf.js`. Twelve pages, each labeled with its page number, so the page indicator and go-to-page are easy to eyeball.
   - [sample.stl](../sample.stl) (repo root) exercises the STL viewer: a 12-triangle binary unit cube, small enough that a wrong scale, a mis-fitted camera, or a grid drawn in the wrong plane is obvious at a glance.
   - [sample.mov](../sample.mov) (repo root) exercises the video player: two seconds of the ffmpeg test pattern with a 440 Hz tone, H.264/AAC in a QuickTime container at 320x240, 15fps. The moving pattern makes a wrong frame grab obvious. VS Code's Chromium has no AAC decoder, so the tone is silent in the original by design; with ffmpeg installed and `markcopy.video.transcode` at `auto`, it becomes audible once the sound copy swaps in, which is what it now tests (and what makes a muted-autoplay regression audible). Regenerate with `ffmpeg -f lavfi -i testsrc=size=320x240:rate=15:duration=2 -f lavfi -i sine=frequency=440:duration=2 -c:v libx264 -pix_fmt yuv420p -profile:v baseline -c:a aac -shortest sample.mov`.
3. To inspect a webview while testing, run **Developer: Open Webview Developer Tools** from the Command Palette.

Work through the checklists below. A **patch** release needs the sections touched by the change plus the smoke rows marked ★. A **minor or major** release needs the full pass.

Rows marked ☑ are covered by an automated layer and are worth a glance rather than a careful pass: a green CI run has already checked them. They stay on the list because an automated layer can only see what it was told to look at, and because a release is the moment to notice the thing nobody wrote a test for.

## Markdown preview

### Rendering

- [ ] ★ Open `sample.md`; its tab shows the rendered preview (`markcopy.autoPreview`), in one editor group, with no split and no text editor left beside it.
- [ ] Headings, lists, task lists, blockquotes, links, and footnotes render GitHub-style.
- [ ] Fenced code blocks are syntax-highlighted.
- [ ] Mermaid diagrams render and re-theme when the VS Code theme changes.
- [ ] With `"markcopy.mermaid": { "layout": "elk" }`, a flowchart still renders in the preview with no CSP errors in the webview developer tools (ELK loads as a separate chunk), and its edges are routed as orthogonal elbows rather than dagre's curves.
- [ ] A `mindmap` diagram still renders with its radial layout (branches fanning out from the center), not a left-to-right tree.
- [ ] Inline `$...$` and display `$$...$$` math render with KaTeX; turning `markcopy.math` off shows literal dollar signs again.
- [ ] `[^note]` footnote references and definitions render as a numbered footnotes section, with back-links to the prose; an unreferenced `[^orphan]:` definition stays visible as plain text instead of disappearing, and `^[...]` inline footnote shorthand stays literal. Turning `markcopy.footnotes` off shows literal `[^note]` text again.
- [ ] Relative and absolute local images render; remote images still load.

### Edit mode

- [ ] ★ A lock/pencil pill sits in the top-right of a Markdown preview, with the lock active. Hovering each button shows its label. It is absent in a CSV, Excel, or PowerPoint preview.
- [ ] Click the pencil: it turns the button blue, blocks get an outline and a text cursor on hover, and clicking a link does nothing (no navigation, no prompt).
- [ ] Click a paragraph: it becomes a rounded box with the raw Markdown, markers (`**`, `#`, `>`, bullets, link brackets and URL) dimmed, bold text slightly heavier, and no shift between the text you see and the caret. The caret is at the end.
- [ ] Type a change and press Ctrl/Cmd+Enter, then click away: the document in the text editor changes (unsaved), the preview re-renders, and Ctrl+Z in the editor reverts it.
- [ ] Press Escape mid-edit: the block returns unchanged and the document is untouched.
- [ ] Ctrl+Z / Ctrl+Y inside the open box undo and redo typing. Selecting text, double-click word select, and an IME composition (for example Japanese) behave normally and line up with the highlighted text.
- [ ] Edit a multi-line list, a table, a blockquote, and the last line of a file with no trailing newline; also a CRLF file (the line endings stay CRLF).
- [ ] Check the box in a light, a dark, and a high-contrast theme: text, dimmed markers, caret, selection, and the box border are all legible.
- [ ] With a box open, change the file from the text editor: the preview does not replace the box; after you commit or cancel, it updates. Committing a block whose lines changed shows "The document changed; edit not applied."
- [ ] Reload the window: the chosen mode is remembered. Switching back to the lock commits an open box.
- [ ] A fenced code block that is syntax-highlighted is not editable (known limitation).
- [ ] Keyboard only: with the pencil active, Tab reaches each block in turn (a focus ring shows); Enter or F2 opens the focused block, Escape returns focus to it unchanged, and Ctrl/Cmd+Enter commits and leaves focus on the block once the preview re-renders. Switching to the lock removes the tab stops.
- [ ] Edit a block so it gets shorter or longer, then immediately click the next block: its box opens on the right text (never a later block) once the preview updates, and committing it changes the right lines.
- [ ] With the preview open beside a second Markdown file, commit an edit and at once retarget the side preview to the other file: the other file is not modified.

### Where the preview opens

- [ ] ★ In `sample.md`'s editor title bar, the **Show Preview** button (`$(open-preview)`, leftmost) swaps that same tab to the preview, full width, titled `sample.md` (not `Preview sample.md`). No new editor group, and no second tab left open on the file. **Reopen Editor With...** > **MarkCopy Markdown Preview** gets to the same place.
- [ ] The tab's own title bar still has the **Save as PDF** and settings buttons, and right-clicking inside it gives the usual copy menu.
- [ ] With the tab open, edit `sample.md` in a second editor group: the tab re-renders as you type.
- [ ] Clicking a link to another Markdown file from the tab opens that file as a MarkCopy tab, landing at the linked heading.
- [ ] Clicking an `https://` link opens it in the browser once, with no "Do you want Code to open the external website?" prompt after it. A `vscode:extension/<id>` link still opens that extension's page in VS Code.
- [ ] Right-click to open the menu, then left-click a link: the link opens and the menu closes.
- [ ] Same check on [sample.csv](../sample.csv) with **MarkCopy CSV Preview**: the grid opens in the tab, a cell edit writes back, and **Ctrl+Z** in the tab takes it back.
- [ ] Closing a preview tab and reopening `sample.md` shows the preview again: closing the tab closed the file, which is not the same as asking for the text.
- [ ] ★ On the preview tab, that leftmost slot is now a **Show Source** button (`$(go-to-file)`): clicking it swaps back to the text, in the same group and the same tab. Click the two a few times: the tab count never grows and no group is ever added. The side panel does not spring open on the way to the source either.
- [ ] Pin the source tab (right-click the tab -> **Pin**), then click **Show Preview**: the pinned tab stays open and the preview opens beside it in the group. Same with unsaved changes in the source: the dirty tab is not closed. Pin the _preview_ tab and click **Show Source**: it too stays.
- [ ] `sample.csv`'s text editor has the **Show Preview** button too, and it opens the grid in place.
- [ ] ★ After **Show Source**, switch to another file and back: `sample.md` stays in the text editor rather than swapping to the preview again. Running **MarkCopy: Open Rich Preview to the Side** still opens the side panel (the dismissal it records is cleared by an explicit request), and so does **Show Preview**.
- [ ] ★ **MarkCopy: Open Rich Preview to the Side** still gives the two-column layout: source left, preview right, retargeting as you move between Markdown files. That is the only route to it now. While that panel is open, focusing another Markdown file retargets it and leaves that file's text editor alone: the tab swap is what auto-preview does when there is no panel, not instead of the panel.
- [ ] ★ Run **MarkCopy: Open Rich Preview to the Side** from the Command Palette while a MarkCopy preview tab has focus (not a text editor). It opens the panel for that document rather than answering "open a Markdown, CSV, or LaTeX file first".
- [ ] ★ Search for a word in `sample.md` with **Find in Files** and click a result on a line other than the first. You land on that line in the text editor and stay there: the tab does not swap the line out from under you. Same for `Ctrl+P` > `sample.md:12`.
- [ ] ★ Edit and save `sample.md` so git sees a change, then click it in the **Source Control** panel. The diff opens and stays open; no preview covers it or takes the focus.
- [ ] With `sample.md` unsaved (dirty) or its tab pinned, switching away and back leaves the text editor alone. **Show Preview** still swaps it.
- [ ] ★ With the cursor in a text editor and no preview tab focused, running **MarkCopy: Show Source** from the Command Palette says so rather than silently doing nothing and turning auto-preview off for the file.
- [ ] With `markcopy.autoPreview` off, opening `sample.md` leaves it in the text editor and nothing swaps; **Show Preview** still works.
- [ ] Double-clicking `sample.md` in the Explorer still opens the text editor (the entries are `option` priority, not `default`), and the same for `sample.csv`.
- [ ] With `"workbench.editorAssociations": { "*.md": "markcopy.markdownPreview" }` in settings, double-clicking `sample.md` opens the preview instead, and **Show Source** still gets back to the text.

### Copy actions

Spot-check one row per clipboard flavor; the full table is the [Copy Matrix](COPY-MATRIX.md).

- [ ] ★ Right-click a table, **Copy Table** (top-level), paste into Word or Google Docs: a real table arrives, not Markdown source.
- [ ] ☑ Right-click a table -> **Copy as** -> **CSV**, paste into Excel or Google Sheets: real cells.
- [ ] ☑ Right-click a table -> **Copy as** -> **Markdown**: a real Markdown table, with any literal `|` in a cell escaped rather than splitting the row.
- [ ] Right-click a paragraph -> **Copy as** -> **PNG**, paste into a chat or slide: an image arrives.
- [ ] Right-click a Mermaid diagram, **Copy Diagram** (top-level): an image arrives.
- [ ] Select some text, right-click -> **Copy as** -> **Markdown**: the original Markdown source comes back.
- [ ] Right-click a rendered equation -> **Copy as** -> **LaTeX**: the original source comes back.
- [ ] ☑ Right-click an email address in the prose, **Copy Email Address** (top-level): the bare address arrives, with no `mailto:` in front of it.
- [ ] ☑ Right-click a link, **Copy Link** (top-level): the target arrives, not the words that stand in for it. **Copy as** -> **Markdown** gives `[text](target)`.
- [ ] ★ **Copy Whole Document** (top-level menu, or the command palette's **Copy Whole Document as Rich Text**), paste into an email draft: formatting intact.
- [ ] Every successful copy shows a toast.
- [ ] Right-click something that matches more than one context (for example, select text inside a table): the top level shows **Copy Selection**, and **Copy as** splits into headed sections (`SELECTION`, `TABLE`) rather than one flat list.
- [ ] Select `AT&T C++` in the prose, right-click -> **Search Google for "AT&T C++"**: the browser opens a Google search for exactly `AT&T C++`, not for `AT`. Selecting a long passage shows only its first 30 characters in the row, and the search still opens.
- [ ] Select a sentence containing an inline equation, then search it: the query has the equation once, not its hidden MathML twin as well. In a CSV grid, a selection across rows searches the cell text without the row numbers.
- [ ] In an Excel sheet and a PowerPoint deck, **Search Google** opens the browser too. Selecting a slide title that wraps onto a second line with a manual line break searches its words with a space between the lines, not run together.

### Settings, themes, and sync

- [ ] Right-click -> **Preferences** -> **Theme**: Auto, Light, Dark, and Green on black all apply immediately and persist to `markcopy.theme`.
- [ ] Green on black is pure `#00ff00` on black (not a soft mint), and copied/exported output still forces light styling.
- [ ] **Sync scroll**, **Auto-open preview**, **Math**, and **Footnotes** toggles under **Preferences** write through to settings; **MarkCopy Settings...** (also under **Preferences**) and the gear icon both open the MarkCopy settings page.
- [ ] Every setting under **Preferences** still applies from the menu: **Theme** (all four), **Sync scroll**, **Auto-open preview**, **Math** and **Footnotes** each take effect and show in settings. The host accepts only these five keys from the page (`src/messages/settings.ts`), so a row that silently does nothing means the allow-list and the menu have drifted apart.
- [ ] Right-click to open the menu, then dismiss it each way: click on empty page, press Escape, click into the text editor beside the preview, and switch to another window. Each closes every panel, submenus included. Repeat on a CSV grid, a sheet, a deck and a Word document.
- [ ] Arrow keys navigate the menu: Down/Up move between rows, Right or Enter opens a submenu (**Copy as**, **Preferences**, **Theme**), Left or Escape steps back out, and Enter/Space activates the highlighted row.
- [ ] ☑ With sync scroll on, scrolling the editor scrolls the preview to match, and scrolling the preview scrolls the editor to match.
- [ ] ☑ Neither surface fights the other: drag the preview's scrollbar slowly and it keeps going where you put it instead of jumping back to a block boundary. Same for the editor.
- [ ] ☑ Sync scroll tracks part way through a long block (a big code block or table) rather than snapping between blocks, and reaches the very bottom of the preview when the editor is scrolled to the end.
- [ ] ☑ With **Sync scroll** off, neither direction follows: scrolling the editor leaves the preview alone, and scrolling the preview leaves the editor alone.
- [ ] **MarkCopy: Save as PDF** asks where to save, writes a `.pdf` there, and opens it. No browser window and no print dialog appear on the way.
- [ ] The exported pages carry **no filename header and no URL footer**.
- [ ] Nothing is clipped or shunted onto a page of its own: a code block longer than a page splits across pages, a very long code line wraps instead of being cut off at the right margin, a table taller than a page splits with its header row repeated on each page, and there is no blank page at the end.
- [ ] Code block, table header, and blockquote backgrounds are present in the PDF (not flattened to white), diagrams and equations are intact, and the text is selectable.
- [ ] Setting `markcopy.pdf.pageSize` to `A4` changes the exported page size.
- [ ] Setting `markcopy.pdf.browserPath` to a nonsense path still asks where to save, then fails with a readable error naming that path and offering **Print from Browser**; taking it opens the preview in your browser with the print dialog.
- [ ] Nothing is left behind in the temp directory after an export, successful or failed (`%TEMP%`/`$TMPDIR`, `markcopy-pdf-*`).
- [ ] Exporting over an existing PDF that then fails leaves the old file intact: point `markcopy.pdf.browserPath` at a nonsense path, export onto a PDF you already have, dismiss the error, and confirm the original still opens and is unchanged.
- [ ] Exporting a CSV grid wider than the page fits every column onto the paper rather than cutting off the right-hand ones, including after dragging a column divider to widen it in the preview first.

### Save as Word

Most of this is automated in `tests/docxExport.test.ts`, which asserts against the generated OOXML. What it cannot check is whether Word agrees, so open the file and look. A `.docx` that Word refuses is the failure mode to watch for: it presents as a repair prompt or a flat "cannot be opened", never as a partial render.

- [ ] **MarkCopy: Save as Word Document** asks where to save, writes a `.docx`, and opens it. Word opens it **without a repair prompt**.
- [ ] ★ Headings appear in Word's **Navigation Pane** (View > Navigation Pane), nested by level, and clicking one jumps to it.
- [ ] ★ **Read Aloud** (Review > Read Aloud) reads the document in order, announces headings, and speaks each image's alt text rather than skipping it.
- [ ] ★ Word's **Accessibility Checker** (Review > Check Accessibility) reports no missing alt text and no missing document title for a document whose images all have alt text.
- [ ] Exporting a document with an image whose alt text is empty finishes, but the notification says so and gives the count.
- [ ] A table arrives as a real Word table with its header row **bold and shaded**, and selecting the header row shows **Repeat Header Rows** turned on (Layout > Repeat Header Rows).
- [ ] Bulleted and numbered lists are real Word lists (the marker is not selectable as text), nested items are indented a level, and two separate numbered lists both start at 1.
- [ ] A Mermaid diagram and an equation both arrive as images; right-click each and check **View Alt Text** shows the Mermaid source and the LaTeX respectively.
- [ ] Code blocks are monospace and shaded, keep their syntax colors, and keep their indentation.
- [ ] Links are clickable and land on the right target; a link to a heading in the same document jumps to that heading rather than opening a browser.
- [ ] The exported file opens in **Google Docs** and **LibreOffice Writer** too, with headings, tables, lists and images intact.
- [ ] **Save as Word…** from the right-click menu of a CSV grid and of a sheet preview exports the grid as a Word table, with no row-number gutter and no tab strip.

## Spreadsheet preview (.xlsx)

Open [sample.xlsx](../sample.xlsx) (repo root). It has three sheets (one hidden), a merged title, dates, currency, a percentage, a formula with a stored result, and a formula without one.

- [ ] ☑ It opens as a grid, not as binary junk or an error, with sheet tabs along the top.
- [ ] ☑ The column headers are letters (A, B, C) and the row numbers are the sheet's own: the sample jumps from row 1 to row 3, and the gutter shows that rather than renumbering.
- [ ] ☑ Dates read as `2023-03-15`, currency as `1,234.50`, and the margin as `15.3%`. None of them appear as raw numbers like `45000` or `0.153`.
- [ ] ☑ The title in row 1 spans three columns (a merged cell).
- [ ] ☑ `SUM` shows its stored result, `11110.75`. `AVERAGE`, which has no stored result, shows a muted marker rather than an empty cell, and hovering it explains why.
- [ ] ☑ The tab strip shows **Summary** and **Notes** but not **Scratch**, which is hidden. Clicking **Notes** switches sheets and the tab strip follows. (Automated as far as the click asking the host to switch; that the host then re-reads the workbook is manual.)
- [ ] ☑ Right-click the grid -> **Copy as** -> **CSV**, paste into a spreadsheet: real cells, **no row-number column and no A/B/C header row**, and the first pasted row is the sheet's own first row.
- [ ] ☑ Right-click -> **Copy as** -> **Markdown**: a real Markdown table (pipes and a `| --- |` separator line), not raw `<table>` HTML. The merged title row is padded to the full width, and there is no A/B/C row and no row-number column.
- [ ] ☑ Cells cannot be edited: clicking one and typing does nothing, and there is no edit caret. (A workbook is read-only in MarkCopy by design.)
- [ ] All four `markcopy.theme` values render the grid and the tab strip legibly, green included.
- [ ] ☑ **Save as PDF** from the right-click menu exports the active sheet, with no tab strip and no row-number gutter on the page. (Automated as far as what the webview hands the host to print; the page itself is manual, because the export drives a real browser through a save dialog.)
- [ ] Editing the workbook in a spreadsheet application and saving re-renders the open preview.
- [ ] ☑ Renaming a `.txt` to `.xlsx` and opening it gives a readable message, not a blank panel.

## Word preview (.docx)

Open [sample.docx](../sample.docx) (repo root), then a real document of your own from Word that has headings, nested lists, tables with merged cells, images, tracked changes, and links.

- [ ] The document opens in the preview, not as binary or in a "cannot open" error. A `.docm` and an uppercase `.DOCX` do too.
- [ ] The sample shows a title and headings at distinct sizes, a nested bullet list, a numbered list with a lettered sub-item, and a footnote with a back arrow at the end.
- [ ] Tracked changes read as the final text: in the sample, "is approved" shows and "was drafted" does not. Turn tracking on in a real document, delete and insert some text, and check the same.
- [ ] A table with a vertically merged cell and a spanning cell draws the merge, and the header row is marked. In a real document, a nested table renders inside its cell.
- [ ] The picture has its alt text (hover it, or check **Copy as** > **Markdown**). A pasted-in EMF or WMF shows a labelled placeholder rather than a broken image.
- [ ] A web link and a mail link are clickable and open the browser or mail client. A bookmark link (a table of contents entry, or "numbers" in the sample) scrolls to its target. A `file:` link is plain text.
- [ ] Monospace text (Consolas, Courier New) shows as code, and consecutive code lines form one block.
- [ ] A document with equations (Insert > Equation in Word: a fraction, a root, a sum with limits, a matrix, an aligned equation) draws them as typeset math, display equations on their own line and inline ones in the sentence, legible in light, dark, and green themes. Right-click one: **Copy as** > **LaTeX** puts the LaTeX on the clipboard (paste it into a LaTeX editor or [katex.org](https://katex.org) and it renders the same equation) and **Copy Equation** pastes an image. With `markcopy.math` off, each equation shows its LaTeX as code instead.
- [ ] Right-click: **Copy Rich Text**, **Copy as** > **Markdown**, and a table's **Copy Table** / CSV work; **Search Google** works on a selection; **Save as PDF** and **Save as Word** export the whole document.
- [ ] Copy the whole document as rich text and paste into Word and Google Docs: headings, lists, tables and the image come across.
- [ ] Light, dark, and green themes are all legible; the image and table borders are visible in each.
- [ ] A header shows once at the top and a footer once at the bottom, muted, with no page number. **Copy Whole Document**: neither is in the paste.
- [ ] Text boxes and shapes with text show as bordered boxes under their paragraph, once each. A document with a comment shows the highlighted range with a small marker and a Comments list at the end (replies nested, resolved labelled); the marker link scrolls to the comment and the arrow goes back. Paste a whole-document copy into Word: the commented words are plain, with no highlight, marker, or comments.
- [ ] A text box that contains a picture shows the picture once, inside the box. Select text across a comment marker and the Comments list, **Copy Selection**, and paste into a plain-text editor: the comment markers and Comments text are absent, paragraphs are on separate lines, and table cells are tab-separated.
- [ ] A document that repeats one large image (or a chart) many times shows the first copies, then placeholders and a note at the end that some repeated images or charts are not shown.
- [ ] A chart shows as a table under a caption with its title and type. Right-click it: **Copy as** > CSV and TSV paste into a spreadsheet with a header row and one column per series.
- [ ] Replace the file on disk (re-save from Word): the preview redraws. Open a text file renamed to `.docx`: the panel says it is not a document rather than failing to open.

## CSV / TSV grid

Open [sample.csv](../sample.csv).

### Rendering

- [ ] ★ The tab swaps to the grid rather than raw text, in place, with no second editor group.
- [ ] The first row is a header; it stays pinned when you scroll down, and the row-number gutter stays pinned when you scroll right.
- [ ] Rows alternate background color, and hovering a row highlights the whole row including its number.
- [ ] `units`, `revenue`, `margin` are right-aligned; `product` and `notes` are left-aligned.
- [ ] Row 2's `product` is `Gadget, deluxe` in one cell (a quoted comma did not split it).
- [ ] Row 4's `notes` contains `Customer said "finally, one that fits"` with real quotes.
- [ ] Row 5's `notes` holds both of its lines in a single cell, and the row is still one line tall (clipped with an ellipsis).
- [ ] Row 9 is short one field; it is padded with empty cells rather than shifting the columns.
- [ ] Row 10 renders `Café Ünïcode` correctly.
- [ ] Editing the file in the editor updates the grid live.
- [ ] All four themes (Auto, Light, Dark, and Green on black) style the grid, including the stripes and the gutter.
- [ ] Set `markcopy.csv.maxRows` to `3`: only 3 rows render and a note says how many of the total are hidden.
- [ ] Set `markcopy.csv.maxColumns` to `2`: only the first 2 columns render, a note says how many columns are hidden, and editing a cell in column 2 still writes to the second field of the right row.
- [ ] Turn `markcopy.csv.headerRow` off: the first row becomes ordinary data and there is no pinned header.
- [ ] Open a `.tsv` (or set `markcopy.csv.delimiter` explicitly): the delimiter is picked up correctly.
- [ ] Save a `.tsv` whose fields contain commas (e.g. `name,full<TAB>city,town`): it renders as two columns, not three. The file extension wins over what scoring alone would pick.

### Columns

- [ ] ★ Drag a column divider: that column resizes, its neighbors do not, and the cursor stays a resize cursor for the whole drag.
- [ ] Drag a column very narrow: it stops at a usable minimum instead of collapsing.
- [ ] Double-click a divider: the column snaps to fit its widest value.
- [ ] Tab to a divider and use Left/Right (and Shift+Left/Right): the column resizes; Enter auto-fits it.
- [ ] After resizing, right-click the grid: **Reset Column Widths** appears and restores the original layout. It does not appear on a grid you have not resized.
- [ ] Double-click a **header** cell, press **Escape**, then drag that same column's divider: it still resizes. (Ending an edit must not take the divider with it; likewise after committing an unchanged value.)
- [ ] Tab to a divider and press **Enter**: the column auto-fits and no cell editor opens. Left/Right resize without also moving the cell selection.

### Editing

Keep the file open in the editor beside the grid so you can watch the text change.

- [ ] ★ Double-click a cell, type a new value, press **Enter**: the grid and the file both update, and focus lands on the cell below.
- [ ] ★ **Ctrl+Z** in the text editor undoes the edit, and the grid follows.
- [ ] Select a cell and just start typing: editing begins with the typed character replacing the old value.
- [ ] **Enter** on a selected cell opens the editor with the existing value intact (F2 too).
- [ ] **Tab** commits and moves right; **Escape** discards; **Delete** clears a cell.
- [ ] **Shift+Enter** inserts a newline inside the cell; committing wraps the value in quotes in the file, and the grid still shows the row one line tall.
- [ ] Edit a header cell: the first line of the file changes.
- [ ] Type a value containing a comma (`Gadget, deluxe`): the file gains quotes around it and the grid still shows one cell.
- [ ] Type a value containing a quote: the file doubles it (`""`) and the grid shows a single quote.
- [ ] Edit row 2 (whose `product` is already quoted) and check the **other** columns in that line are byte-for-byte unchanged: editing must not reformat the rest of the row.
- [ ] Edit a cell on row 9 (the short row) past its last field: the row is padded with delimiters rather than shifting other columns.
- [ ] Edit a cell, then immediately edit the one below: no focus is lost between commits.
- [ ] Edit two cells in quick succession, committing each with Enter: **both** land in the file. (The second must not be dropped for being one document version behind.)
- [ ] Start editing a cell, then click straight onto a different cell: the edit is kept and focus stays on the cell you clicked, rather than snapping back.
- [ ] ☑ Start editing a cell, then click somewhere that is **not** a cell (the padding around the grid, the row-number gutter, the empty space past the last row): the edit is kept, exactly as it is when you click another cell. (This is the class of gesture that fires no `blur` where the engine does not move focus for it.)
- [ ] ☑ Start editing a cell, then switch to another editor tab and come back: the edit was committed on the way out, not lost with the hidden panel.
- [ ] ☑ Start editing a header cell, then drag that column's divider: the editor stays open and the column resizes, so a header can be widened while its own name is being typed.
- [ ] Double-click a cell to start editing, then click inside the value: the caret lands where you clicked and the editor stays open. Drag across part of the value: it selects, and still nothing closes. (Deliberately not ☑: jsdom has neither hit-testing nor drag selection, so the tests can only check that the editor survives a synthetic press. Where the caret actually lands is exactly what nobody can automate here.)
- [ ] ☑ Double-click again inside an open editor: the whole value is selected, so typing replaces it.
- [ ] ☑ Right-click inside an open editor: the edit stays open with its selection visible, and the menu offers **Copy Selection** / **Copy Cell** / **Select All** above the usual document rows, rather than the table's copy rows. Dismiss the menu with **Escape**: the caret is back in the editor, so typing goes into the cell and a second **Escape** discards the edit.
- [ ] Paste what you copied from that menu somewhere: it is the text that was selected. **Ctrl+C**, **Ctrl+X**, **Ctrl+V** and **Ctrl+A** work in the editor too. (Not ☑: the clipboard round-trip and the browser's own editing shortcuts are outside what the harness drives.)
- [ ] Right-click an **empty** cell you are editing: no dead copy rows, and the document rows below are still there and still work.
- [ ] With an open editor, type in the text editor beside the grid so the preview re-renders: the edit is dropped rather than written back over the newer text.
- [ ] Type in the text editor while the grid is open: the grid keeps up, and nothing is corrupted.
- [ ] Arrow keys move the selection; Tab enters the grid once rather than stepping through every cell.

### Copy and export

- [ ] ★ ☑ Right-click the grid -> **Copy as** -> **CSV**, paste into Excel or Google Sheets: real cells, and **no row-number column**.
- [ ] The pasted data round-trips the tricky rows: the quoted comma, the escaped quotes, and the multi-line cell all come back intact.
- [ ] A field with deliberate leading/trailing spaces keeps them through a **Copy as** -> **CSV** round-trip.
- [ ] ☑ Right-click a cell holding an email address or a URL: the menu leads with **Copy Email Address** / **Copy Link**, and copies just that value out of whatever text surrounds it. On an ordinary cell the top row is still **Copy Table**, with the cell's own text under **Copy as** -> **Cell Text**.
- [ ] **Copy Table** (top level) pastes into Word or Google Docs as a formatted table, striping included, readable on white even from the dark theme, and with **no row-number column**.
- [ ] **Copy as** -> **PNG** puts an image of the grid on the clipboard, again with no row-number column.
- [ ] **Save as PDF** exports the grid; every row is there, it flows across pages rather than being clipped to one screen, the header row repeats on each page, wide cells wrap instead of being cut off at the margin, and the resize handles are absent.

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
- [ ] ★ Scroll deep into the document, then zoom in and out several steps: the page under the middle of the window stays there, and the page indicator does not drift.
- [ ] After a zoom step, the page indicator settles on whatever page actually sits under the midline.
- [ ] ★ The fit-width button (rightmost, a page with a double-headed arrow) sizes the page to the pane (a percentage between the presets is fine) and stays lit; dragging the pane's edge re-fits it. Its tooltip and screen-reader name both read "Fit page width", and the icon is centred in its button and follows the toolbar's foreground colour in every theme.
- [ ] Any manual zoom (buttons, keys, wheel, or clicking the percentage) unlights the fit-width button and stops the re-fitting.
- [ ] From a fitted percentage, plus/minus step to the neighbouring preset level rather than jumping back to where the zoom was before the fit.

### Tools, selection, and copy

- [ ] Right-click -> **Preferences** toggles between **Hand Tool (Drag to Scroll)** and **Pointer Tool (Select Text)**.
- [ ] Select text with the Pointer tool; right-click, top-level **Copy Selection** pastes the selection.
- [ ] Right-click -> **Copy as** -> **Page N Text** and **Copy as** -> **All Text** paste the expected plain text.
- [ ] ★ Right-click a page, top-level **Copy Page N as PNG** yields a true-color page image even when the viewer shows dark or green pages.

### Comments

- [ ] Right-click, **Add Comment Here** drops a pin; the note saves to `<file>.pdf.mccomments.json` next to the PDF.
- [ ] Deleting the last comment removes the sidecar file.

### Theming

- [ ] ★ Right-click -> **Preferences** -> **Theme**: Auto, Light, Dark, and Green on black re-tint the pages; Green on black renders green-on-black phosphor in pure `#00ff00`.
- [ ] Right-click -> **Preferences**, the **Dark Pages** / **Light Pages** quick toggle changes the pages for this session only (the saved `markcopy.theme` is untouched).
- [ ] Changing the theme from a Markdown preview (or settings.json) re-tints an already-open PDF.
- [ ] Open the menu and dismiss it by clicking on the page, by Escape, and by clicking into the editor beside it: each closes the menu. After **Theme** is picked, the saved `markcopy.theme` is the one chosen (the PDF viewer may write only that setting).
- [ ] Scrollbars are always visible and styled.

## STL viewer

Open [sample.stl](../sample.stl). It is a unit cube, so every check below has an obviously right answer.

### Loading and framing

- [ ] ★ The file opens in MarkCopy's 3D viewer, not as binary, and the cube is visible and centered without touching anything.
- [ ] ★ The stats overlay (bottom-left) reads `12 triangles` and `1.00 x 1.00 x 1.00`.
- [ ] The cube sits **on** the grid, not through it or floating above it. (The model is rested on the y = 0 plane; a regression here shows as the grid slicing the model in half.)
- [ ] An ASCII STL loads as well as a binary one. Both variants live in the [MeshView repo](https://github.com/owenpkent/meshview/tree/main/samples) if you need one.

### Controls

- [ ] ★ Left-drag orbits, right-drag pans, the scroll wheel zooms. All three work with the mouse alone, no modifier keys.
- [ ] Orbiting has a little inertia and settles rather than stopping dead (damping is on).
- [ ] Zoom in close, then click **Fit view**: the camera returns to framing the whole model.
- [ ] Resizing the panel (drag the editor split) keeps the model undistorted; the aspect ratio follows.

### Toolbar

- [ ] The wireframe button toggles the mesh to edges-only and highlights while active.
- [ ] The grid button hides and shows the grid and highlights while active.
- [ ] Both buttons are reachable by Tab and activate with Enter.

### Theming and settings

- [ ] ★ With `markcopy.theme` on Auto, switching the VS Code color theme between a light and a dark one changes the viewport background to match.
- [ ] Forcing `markcopy.theme` to `light`, `dark`, or `green` tints the viewport to white, `#0d1117`, and black respectively, and changing it from an open Markdown or PDF preview re-tints an already-open STL viewer without reopening it.
- [ ] Setting `markcopy.stl.meshColor` to something obvious (`#ff0000`) and reopening the file recolors the mesh; `markcopy.stl.showGrid: false` opens with the grid already off.

### Bad input

The guards here are what stop a crafted file hanging the window, so these are worth doing by hand at least once per minor release.

- [ ] Truncate a binary STL (copy `sample.stl` and delete the last 200 bytes): the panel shows a "more than the file can hold" message instead of loading or hanging.
- [ ] An 84-byte file of `0xFF` is refused the same way, promptly, with no memory spike. Build one with `node -e "require('fs').writeFileSync('bad.stl', Buffer.alloc(84, 0xff))"`.
- [ ] An empty `.stl` reports that it received no data, rather than blaming the file's format.
- [ ] Right-click the tab -> **Reopen Editor With...** -> a text or hex editor still opens the raw bytes.

## Video player

Open [sample.mov](../sample.mov). It is two seconds of moving test pattern with a tone, so a frozen frame, a silent track, and a wrong grab are all visible or audible at once.

### Loading and playback

- [ ] ★ The file opens in MarkCopy's player, not as binary and not in VS Code's built-in preview, and the first frame is on screen.
- [ ] ★ A `.mp4` copy of the same file also opens in MarkCopy's player, not the built-in one. (Both claim `.mp4`; MarkCopy's `"default"` priority is what wins, and only this check notices if that changes.)
- [ ] The readout under the video gives the file name, `320x240`, `0:02`, and a size in KB.
- [ ] Play, pause, seek, and volume all work from the control bar, and the tone is audible.
- [ ] Clicking the picture itself toggles play/pause; clicking the control bar does not do it twice.
- [ ] The video is letterboxed and fully visible at any pane width, and never pushes the controls off-screen. Try a very narrow split and a very short one.
- [ ] Switching to another tab and back keeps the playback position instead of restarting.

### Keyboard

- [ ] **Space** plays and pauses without first clicking a control.
- [ ] ★ **Space** still toggles exactly once right after clicking the picture, which is when the video element itself holds the focus and binds Space too. Two handlers firing here would cancel each other out and look like a dead key.
- [ ] **`,`** and **`.`** step backward and forward by about a frame while paused.
- [ ] **m** mutes and unmutes; **f** enters fullscreen and **Esc** leaves it.

### Frame grabs

- [ ] ★ Right-click -> **Copy Frame as PNG**, then paste into Paint or a document: you get the frame that was on screen, at 320x240, not a black rectangle and not the on-screen size.
- [ ] ★ Right-click -> **Save Frame as PNG…** offers a name like `sample-01.234s.png` in the video's own folder, and the saved file matches the frame.
- [ ] Grab two frames a step apart: the suggested names differ, so neither overwrites the other.
- [ ] **Copy as** -> **File Name** and **Full Path** put the expected text on the clipboard.
- [ ] On a host that does not serve webview resources with `Access-Control-Allow-Origin` (the retry path in `src/webview/video.ts`), the video still plays and both frame rows are greyed out under a **Frames unavailable for this file** heading, rather than failing into a toast on every attempt. Hard to stage deliberately: check it by flipping `frameCopyBlocked` to `true` in a dev build.

### Playback menu and settings

- [ ] Right-click -> **Playback** -> **Loop** starts looping, shows a checkmark next time the menu opens, and persists to `markcopy.video.loop` in settings.
- [ ] **Playback** -> a speed other than Normal changes the rate and shows the radio mark on reopening the menu.
- [ ] Setting `markcopy.video.autoplay` to `true` and reopening starts playback immediately.
- [ ] If autoplay started muted, a **Playing muted · click anywhere for sound** toast appears, and the first click or key press anywhere in the preview turns the sound on.
- [ ] With autoplay starting muted, clicking the player's own mute button does not get overridden: the sound stays as the button left it.
- [ ] Right-click -> **Playback** -> **Autoplay** toggles with a checkmark, shows an **Autoplay on** / **Autoplay off** toast, persists to `markcopy.video.autoplay`, and affects the next opened video without starting or stopping the current one.
- [ ] ★ Right-click -> **Preferences** -> **Theme** re-tints the surround, and changing the theme from a Markdown or PDF preview re-tints an already-open video without reopening it.
- [ ] Every video setting still applies from the menu: **Loop**, **Autoplay**, **Open Video Notes** (the `markcopy.video.review` setting) and **Theme** each take effect and persist, and none is refused.
- [ ] While the video plays, right-click to open the menu, then click on the picture to dismiss it: the menu closes and playback is **not** paused. Do the same while paused: it does not start. Escape and clicking into the editor close the menu too. A plain click on the picture with no menu open still toggles playback.

### Bad input and codecs

Make the fixtures once, with ffmpeg on `PATH`:

```
ffmpeg -f lavfi -i testsrc=size=320x240:rate=15:duration=2 -c:v prores_ks prores.mov
ffmpeg -f lavfi -i "color=c=red@0.5:s=320x240:d=2,format=rgba" -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le alpha.mov
ffmpeg -f lavfi -i "color=c=red@0.25:s=64x64:r=5:d=1,format=yuva420p" -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 alpha.webm
```

- [ ] ★ **With ffmpeg installed**, opening `prores.mov` shows "Building a playable copy… n%" with a progress bar, then plays. The status line ends with `ffmpeg preview copy`.
- [ ] `alpha.mov` plays over a grey **transparency checkerboard**, not flat black, and the status line says `alpha on checkerboard`. **Copy Frame as PNG** from it: the board is in the pasted image (it is baked into the proxy, which is what the status line is warning you about).
- [ ] `alpha.webm` (transparent VP9) gets the same checkerboard re-encode, not a `repackaged as MP4` copy: the status line says `alpha on checkerboard` and the red is tinted by the grey squares rather than flat.
- [ ] Press **Cancel** during a long file's encode: it stops, and the offer to build one comes back rather than an error.
- [ ] Close the tab after a proxy has played, then check `%TEMP%\markcopy-video` (`/tmp/markcopy-video`): the copy is gone. Nothing accumulates across a session of opening clips.
- [ ] The original file's timestamp and size are unchanged after all of the above.
- [ ] With `markcopy.video.transcode` set to `ask`, the same file offers a **Build Playable Copy** button naming the codec ("clip.mov is ProRes 4444, which VS Code cannot play") instead of starting on its own. Pressing it encodes and plays.
- [ ] With it set to `off`, the message names `markcopy.video.transcode` and does **not** suggest installing ffmpeg.
- [ ] With `markcopy.video.ffmpegPath` pointed at a file that is not ffmpeg, the failure names what went wrong rather than hanging or silently falling back.
- [ ] ★ **Without ffmpeg**: take it off `PATH` for the session and reload the window, leaving `markcopy.video.ffmpegPath` empty so the detection really runs and finds nothing. A ProRes or HEVC `.mov` shows the "cannot play" message naming ProRes and the default player, plus the note about installing ffmpeg. Not a black rectangle, and not an empty tab.
- [ ] **Open in Default App**, on every one of those messages and in the right-click menu, opens the file in the OS player.
- [ ] ★ An H.264/AAC file ([sample.mov](../sample.mov)) with ffmpeg installed and `markcopy.video.transcode` at `auto`: it starts playing silently, a slim "Adding sound… n%" notice appears above the status line without hiding the video, and the tone becomes audible at the same position and keeps playing (a paused video stays paused). The status line ends with `ffmpeg copy · sound re-encoded to MP3`.
- [ ] With `markcopy.video.transcode` at `ask`, the same file shows a notice ("has AAC audio, which VS Code cannot play, so it is silent here") with **Build Copy with Sound**, **Open in Default App**, and **Dismiss**, and the video stays visible and playing. **Dismiss** hides it and it does not come back until the tab is reopened. **Build Copy with Sound** shows progress, **Cancel** returns to the offer, and a finished build swaps in with sound.
- [ ] With `off`, or with ffmpeg off `PATH`, an AAC file plays as before with no notice at all.
- [ ] A ProRes or HEVC `.mov` with audio, played through the picture proxy, now has **sound** (the proxy audio is MP3, not AAC). A 5.1 source works too.
- [ ] ★ **Containers**: generate an H.264 `.mkv` and a VP8 `.webm` (`ffmpeg -f lavfi -i testsrc=size=320x240:rate=15:duration=2 -f lavfi -i sine=frequency=440:duration=2 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest sample.mkv`, and the same with `-c:v libvpx -c:a libvorbis` and `sample.webm`; `-c:v wmv2 sample.wmv` and `-c:v mpeg2video sample.mpg` for the others). Both open in the MarkCopy player, not as binary.
- [ ] The H.264 `.mkv` with ffmpeg installed and `markcopy.video.transcode` at `ask` says "VS Code's player cannot open .mkv files. MarkCopy can repackage sample.mkv as MP4 with ffmpeg in a few seconds, without re-encoding the picture or touching the original."; pressing **Build Playable Copy** finishes in seconds, plays with sound, and the status line ends with `ffmpeg copy · repackaged as MP4`.
- [ ] The VP8 `.webm`, the `.wmv`, and the `.mpg` get the full re-encode ("Building a playable copy… n%", status `ffmpeg preview copy`), not a repackage.
- [ ] ★ Without ffmpeg, the `.mkv` and `.webm` say "VS Code's player opens only MP4 and QuickTime files, so sample.mkv needs your default player" plus the install-ffmpeg sentence, and **Open in Default App** works.
- [ ] An `.mp4` VS Code _can_ play, with MP3 or no audio, opens instantly with no encode and no `ffmpeg` text in the status line.
- [ ] After the swap to a copy with sound, the speaker icon in the video controls is enabled (not greyed). A greyed speaker means the element has no decodable audio.
- [ ] A truncated or garbage `.mov` (`node -e "require('fs').writeFileSync('bad.mov', Buffer.alloc(2048, 0xff))"`) reports that it cannot be played rather than hanging or showing nothing.
- [ ] A video opened from outside the workspace (drag one in from Downloads) plays. This is the `localResourceRoots` case: inside the workspace it would work either way.
- [ ] Right-click the tab -> **Reopen Editor With...** still reaches VS Code's own preview (for `.mp4`) and a text or hex editor.

## Video review

Review mode. Make a clip whose frames are numbered so a step that lands on the wrong frame is visible: `ffmpeg -f lavfi -i "testsrc=size=320x240:rate=25:duration=10" -vf "drawtext=text='%{frame_num}':fontsize=64:fontcolor=white:x=10:y=10" -c:v libx264 -pix_fmt yuv420p frames.mp4` (needs an ffmpeg built with a font). Then write `frames.review.yaml` beside it, or copy the pair in `tests/fixtures/review/` and rename them to match the clip; include a few done and pending notes, a range note, and two notes 0.1 s apart. Automated tests cover the parsing, timecode, layout, Markdown, the edit validators and byte-identical edits against the kit's own output; none of the rest. Work on a copy of the pair, since these checks edit the notes file. The list runs top to bottom in one session: the steps from **Point note** onward change the notes file, and the last few delete it and start again.

- [ ] ★ Opening `frames.mp4` with the sidecar beside it shows the transport, a scrubber with markers, and the notes panel beside the video. Opening a video with no sidecar looks exactly as it did before.
- [ ] Right-click -> **Open Video Notes** on a plain video turns review mode on and shows an empty panel, and the item then reads **Close Video Notes**, which turns it off. `markcopy.video.review` follows, and with it `true` a video without a sidecar opens in review mode.
- [ ] ★ **Frame stepping**: the readout says `25 fps` (from the sidecar if it has one, otherwise from ffprobe), **Left** and **Right** move exactly one burned-in number, and `,` and `.` do the same. The timecode frame field changes by one per step and wraps at 25.
- [ ] Pressing a card, and pressing its marker, seeks to the note and shows the note's own frame number, not a neighbour. Both select the card.
- [ ] **J** slows, **K** pauses, **L** speeds up, **space**, **m** and **f** still play, mute and go fullscreen. Typing in any text field (the Quick Open box, say) triggers none of them. The speed button cycles 0.5x, 1x, 2x and the playing video follows it.
- [ ] ★ **Markers and bands**: the close pair draw as one marker with a count, the far note as its own, and a range note draws a translucent full-height band with bracket end caps, brighter when its card is selected. Pressing the cluster seeks to one of its notes, and each further press goes to the next one.
- [ ] Narrow the editor below 720 px: the panel moves below the video and nothing overflows horizontally. Controls and cards stay at least 44 px high.
- [ ] ★ **Sort**: the sort control switches Time and Newest, and Newest puts the latest `created` first. The scrubber still shows every note. Close the tab and reopen the video: the sort comes back. There is no filter control and no Done / Not done button on a card.
- [ ] A note with `done: true` (as Marker writes it) shows as done and read-only. Adding and deleting other notes leaves its lines in `frames.review.yaml` unchanged.
- [ ] **Frame rate source**: a sidecar with no usable `fps` on a clip with ffmpeg available reads the rate from the probe; with ffmpeg off `PATH` the readout says `30 fps (assumed)`. With `markcopy.video.transcode` at `off` and ffmpeg installed the rate still comes from the probe.
- [ ] ★ **Copy as Markdown** (the panel button; the right-click menu has no copy item): a toast says "Copied n notes, saved frames.review.md", the file appears beside the video, and its text matches the clipboard. Pasting into a chat or issue gives plain Markdown with `## n1  00:00:01:00  note` headings and no stray quote marks or markup.
- [ ] A second copy replaces the `.review.md` without leaving a `.tmp` file behind. A read-only folder shows an error toast and no half file.
- [ ] ★ **Point note**: pause on a frame, type text in the **Note text** field and press **Enter**. A card appears and is selected, a marker appears on the scrubber, the panel shows the right timecode, and `frames.review.yaml` gains a note with `at` equal to that time and no `out`. `frames.review.md` has the new heading.
- [ ] ★ **Range note**: press **[ In**, move on, press **Out ]**. A chip shows the range and a band shows on the scrubber (**[ In** alone shows only the In bracket). **Send** adds a note with `at` and `out`, and the chip and band clear. **Clear** drops a pending range without adding a note. Setting a later In at or past the Out drops the Out.
- [ ] **Refusals**: **Send** with an empty field toasts "Write the note first"; **Out ]** before any In toasts "Set In first"; Out at or before In toasts "Out must be after In". Nothing is written for any of them.
- [ ] ★ **Keys**: with focus off the field, **I** and **O** set In and Out; typed into the field they type the letters. **Enter** sends and **Escape** leaves the field.
- [ ] ★ **Resume after a note**: play the video, click the field (it pauses), type, press **Enter**. Playback resumes and **space** pauses it, which proves focus left the field. Started paused, it stays paused.
- [ ] ★ **Delete and restore**: select a card, press **Delete**. The note leaves the panel, the file and the markdown, and **Restore nN** appears at the top. Pressing it brings the note back in its old position under its old id, and `next_note_id` in the file is unchanged by the round trip. A second delete replaces the restore target (one level).
- [ ] ★ **Pin mode**: with **Pin** off (default) a press on the picture plays and pauses. Turn **Pin** on (chip or **P**, ignored while typing): the cursor is a crosshair and a press places a pin. Turning it off drops the pending pin; **Clear** and a sent note turn it off, a failed send restores it. The **×** at the panel's top right closes review mode like **Close Video Notes**.
- [ ] ★ **Place and move a pin**: with **Pin** on, press the picture. A ring with a plus appears, the video pauses, the field has focus and the chip reads "Pin" (or "00:00:01:00 + Pin" with an In set). Press elsewhere: the ring moves. **Clear** drops range and pin. **Send** adds the note, and `frames.review.yaml` has `point: [x, y]` with values 0 to 1 and at most 4 decimals; the markdown has "Pin: x% from left, y% from top".
- [ ] **Letterbox presses**: open a portrait clip and an ultrawide clip in a wide editor. A press in the black bars places no pin and neither plays nor pauses; a press on the picture's edge pixel places one at 0 or 1. Resize the editor and the ring stays on the same spot of the picture.
- [ ] **Resume with a pin**: play, press the picture (it pauses), type, press **Enter**. Playback resumes. Started paused, it stays paused.
- [ ] ★ **Pins show on their frame or range**: a point note with a pin shows a numbered stud on its frame only; a range note's stud shows across the range. Pins on keep and reject notes show too. Pressing a stud selects its note and scrolls to the card, which says "Pin". The stud is at least 44 px.
- [ ] ★ **Malformed sidecar**: break the YAML, then set `version: 2`, then add an unknown field (restoring the file between each). Each time the panel shows its notes (where they parse) under a "Read-only: ..." banner naming the reason, the file on disk is unchanged byte for byte, the composer and card actions are disabled, and a press on the picture plays and pauses as before. **Copy as Markdown** shows an error and writes no `.review.md`.
- [ ] **Bad input never reaches the file**: a note time past the clip's end is refused, and no `.tmp` file is left behind in the folder.
- [ ] ★ **Editing while Marker has the same video open**: add a note in MarkCopy while Marker is open on the video. Then change something in Marker and let it save. Reload shows "Notes were replaced by another program" in MarkCopy if the note was lost. This is Marker's whole-file save (owenpkent/Marker#14), not a MarkCopy fault; record what you saw. Do not expect both to agree afterwards.
- [ ] ★ **Re-open in Marker**: close the video in MarkCopy and open the same video in Marker after adding, deleting and pinning notes in MarkCopy. Marker lists exactly those notes with the right times and pins in the same place, and loads without an error; saving from Marker changes nothing else in the file.
- [ ] ★ **External edit**: reopen the video in MarkCopy and leave it open, then add a note to the sidecar in Marker (or a text editor, then save). The panel and markers update without reopening the tab. Delete the sidecar: the notes clear and **Copy as Markdown** greys out.
- [ ] ★ **First note, no notes file**: with the sidecar deleted, add a note. The file is created beside the video with `version: 1`, a 12-character `id`, the video's name as `source`, `next_note_id: 2` and the note. With ffmpeg available and a 25 fps clip it says `fps: 25.0`; without ffmpeg a line above the composer reads "Frame rate unknown: notes will be saved at 30 fps" and the file says `fps: 30.0`. **Send** is not accepted until a rate is known.
- [ ] **Scrubber alignment**: with review mode on, the grey scrubber bar spans only the playhead's travel, so no bar shows before the playhead at 0:00 or after it at the end. Seek to the start and to the end: the playhead line sits on the bar's end each time, and a marker at 0:00 sits on the bar, not outside it.
- [ ] ★ **Themes**: in Auto (both a light and a dark VS Code theme), Light, Dark and Green, the panel, cards, selected card, markers, range bands and caps, pin studs, banner and transport are all legible, including the focus ring on a button.

## GIF viewer

There is no committed GIF fixture. Use any animated GIF with at least a dozen frames and visibly uneven delays (a screen-recording GIF is ideal), plus a one-frame GIF and a copy of the animated one renamed `.GIF`. If ffmpeg is installed, it makes a counter whose frame number is drawn on each frame, a play-once copy, and a still:

```sh
ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=10 -loop 0 counter-loops.gif
ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=10 -loop -1 counter-plays-once.gif
ffmpeg -f lavfi -i testsrc=size=320x240:rate=10 -frames:v 1 -loop 0 still.gif
```

### Loading and playback

- [ ] ★ The animated GIF opens in MarkCopy's viewer, not in VS Code's built-in image preview, and it starts playing. The `.GIF` copy does the same.
- [ ] ★ Playback timing matches the file: compare against the same GIF in a browser tab side by side, and the two stay in step over a few loops. A GIF with 0 ms delays plays at a sane speed (100 ms per frame), not as a blur.
- [ ] A GIF with no loop block plays once and stops on its last frame; one that loops forever keeps going. Right-click -> **Playback** -> **Loop** on the first makes it repeat and shows a checkmark next time the menu opens.
- [ ] The status line gives the file name, size, dimensions, `frame i / n` advancing as it plays, the length of one pass, and the loop description.
- [ ] A very large pixel size and a very narrow split: the picture is scaled to fit and never pushes the status line off-screen.
- [ ] A one-frame GIF shows `frame 1 / 1` and the stepping keys do nothing harmful. Left open, it uses no CPU in Task Manager: a still is drawn once, not redrawn on a timer.
- [ ] ★ Right-click opens the menu as a popup at the pointer, styled like the video player's, not as a plain list at the top of the page.

### Frame controls

- [ ] ★ **Space** and a click on the picture each pause and resume exactly once (not twice), including right after clicking the picture.
- [ ] `,` and `.` pause and step one frame back and forward; Home and End jump to the first and last frame. The `frame i / n` readout follows.
- [ ] Right-click -> **Playback** -> each speed (0.25x to 2x) changes the pace at once, including while sitting on a long-delay frame.

### Copy and save

- [ ] ★ Step to a frame, right-click -> **Copy Frame as PNG**, and paste into Word and Paint: it is the frame that was on screen, at the GIF's native size, with any transparency intact.
- [ ] ★ **Save Frame as PNG…** offers a name like `anim-frame-012.png` in the GIF's own folder, and the saved file matches the frame.
- [ ] **Copy as** -> **File Name** and **Full Path** paste the right text.

### Theme, fallback and errors

- [ ] While a GIF plays, right-click to open the menu, then click on the picture to dismiss it: the menu closes and playback is **not** toggled. Escape and clicking into the editor close the menu as well; a plain click with no menu open still toggles playback.
- [ ] ★ Right-click -> **Preferences** -> **Theme** re-tints the surround and the status line stays legible in Light, Dark, Green on black, and a high-contrast VS Code theme. Changing the theme from a Markdown or PDF preview re-tints an open GIF viewer.
- [ ] The GIF viewer's **Theme** is the only setting its menu writes; each of the four values applies and persists.
- [ ] A text file renamed `.gif` shows "is not a GIF MarkCopy can read" rather than a blank pane.
- [ ] Automation cannot exercise `ImageDecoder` playback (jsdom has none); the fallback is covered by `tests/gifWebview.test.ts`. To see it for real, check the viewer in a VS Code build whose Chromium lacks WebCodecs image decoding, if one is available: the GIF still plays, and the frame rows are greyed under "Frames unavailable in this viewer".

## Image viewer

There is no committed image fixture. Use a PNG with transparency (a screenshot of a window with rounded corners will do), a photo saved as `.jpg`, a `.webp`, and an SVG with a `viewBox` and no width (an icon, for example). Make two extra files: a copy of the JPEG renamed `.png`, and a text file renamed `.png`. Keep the SVG in a workspace folder whose path contains a space (`my icons/logo.svg`) for the Markdown check. For the later checks also make: an SVG that contains a `<foreignObject>`, an SVG saved as UTF-16 (for example from PowerShell with `Out-File -Encoding unicode`), a JPEG with an EXIF orientation of 6 or 8 (a phone photo taken sideways), and a PNG truncated to its first few hundred bytes.

### Opening and status line

- [ ] ★ Each of `.png`, `.jpg`, `.webp`, `.bmp`, `.ico`, `.avif`, and `.svg` opens in MarkCopy's viewer, not VS Code's built-in image preview, and an upper-case extension (`PHOTO.PNG`) does the same. **Reopen Editor With...** reaches the built-in preview, and for the SVG it also offers the text editor.
- [ ] The status line reads like `photo.webp · 1.2 MB · 1920 x 1080 · WebP`. The SVG with no width shows `viewBox 0 0 24 24` in place of pixels and `SVG` as its format.
- [ ] ★ The JPEG renamed `.png` still displays, and the status line says JPEG, not PNG.
- [ ] The text file renamed `.png` shows "Not a recognised image" rather than a blank pane.
- [ ] A file above 64 MiB (pad one with `fsutil file createnew big.png 70000000` on Windows) shows a message naming its size and the 64 MiB limit instead of loading, and VS Code stays responsive.
- [ ] An SVG that contains a `<script>` element or an `onload` attribute shows its drawing and runs nothing.
- [ ] The UTF-16 SVG opens as a drawing, not an error, and **Copy SVG Source** pastes readable text (not NUL-separated characters).
- [ ] The EXIF-rotated JPEG shows upright and portrait, and the status line reports the portrait dimensions.
- [ ] The truncated PNG shows "Could not decode <name>"; right-click shows **Copy Image as PNG** and **Save as PNG…** greyed out, **HTML Image** pastes with no `width` or `height`, and the file's other copy rows still work.
- [ ] Edit the open picture on disk (save it from an image editor, or overwrite it with another file of the same name): the viewer reloads it within a moment. Delete the file: the pane says "<name> was deleted." Restore it: the picture comes back.

### View

- [ ] Ctrl+wheel, Ctrl+plus, and Ctrl+minus zoom in steps between 10% and 800%; Ctrl+0 and **F** fit the picture to the pane, and **1** shows it at 100%. Right-click -> **View** does the same.
- [ ] ★ The floating toolbar sits at the bottom right above the status line. Its zoom out (title "Zoom out (Ctrl -)"), percentage label (title "Fit (Ctrl 0)", click fits), zoom in ("Zoom in (Ctrl +)"), and **Fit to window** buttons work, the percentage tracks the zoom, and **Fit to window** is lit while fit is on and goes to 100% when clicked while lit.
- [ ] ★ With the picture zoomed larger than the pane, the **Hand Tool** ("Hand Tool (Drag to Pan)") is on by default, the cursor is a grab hand, and dragging pans the picture. Turn it off from the toolbar and from right-click -> **View** -> **Hand Tool** in turn: the checkbox and the toolbar button agree, and dragging no longer pans. It is on again after reopening the file.
- [ ] Zoomed past 200%, a small icon shows hard square pixels rather than a blur.
- [ ] ★ Right-click -> **Preferences** -> **Background** -> **Checkerboard**, **Light**, **Dark**, and **Theme** each repaint the area behind the transparent PNG, and the status line stays legible against each in the Light, Dark, Green on black, and a high-contrast VS Code theme. **Theme** follows the MarkCopy theme: set **Preferences** -> **Theme** to one that differs from VS Code's (Light in a dark VS Code, say) and the backdrop matches MarkCopy's theme, not the editor. The choice persists after closing and reopening the file, and it matches `markcopy.image.background` in Settings.
- [ ] **Preferences** -> **Theme** re-tints the surround in the four themes.

### Copy and save

- [ ] ★ Right-click -> **Copy Image as PNG** on the transparent PNG and paste into Word and Slack: the picture arrives at its own size with the transparency intact, not at the zoom it was viewed at. Do the same for the JPEG and the WebP.
- [ ] ★ On the SVG, set **Copy as** -> **SVG Scale** to 1x, 2x, and 4x in turn, copying and pasting into Paint each time: the pasted bitmap is the SVG's size times the scale, and the default is 2x. The scale resets when the file is reopened.
- [ ] ★ The `<foreignObject>` SVG exports: **Copy Image as PNG** pastes a bitmap rather than failing with "Could not read the image".
- [ ] **Save as PNG…** offers `<name>.png` in the picture's own folder, and the saved file matches what was copied. On the SVG it honours the scale.
- [ ] ★ **Copy as** -> **Markdown Image**, pasted into a Markdown file in the same workspace, gives `![logo](my%20icons/logo.svg)` (the path relative to the workspace folder, spaces encoded), and the MarkCopy preview of that file shows the picture. The same copy from a file opened outside any workspace gives just `![name](name.ext)`.
- [ ] **Copy as** -> **HTML Image** pastes `<img src="..." alt="..." width="..." height="...">` with the same path and the picture's pixel size.
- [ ] **Copy as** -> **Data URI** pastes a `data:image/...;base64,` string that opens the picture when put in a browser's address bar. On a picture above 4 MiB the row is greyed out and reads "Too large for a data URI".
- [ ] **Copy as** -> **File Name** and **Full Path** paste the right text. **Copy SVG Source** (SVG only; it is absent for a raster file) pastes the file's XML.
- [ ] **Open in Default App** and **Reveal** act on the file.
- [ ] Automation cannot exercise the PNG copy (jsdom decodes no images, so `tests/imageWebview.test.ts` stops at the menu and the text copies); the checks above are the only coverage of the pixels.

## LaTeX preview

Open [sample.tex](../sample.tex) (repo root). It cross-references a labelled equation, which resolves only on a second compile pass, so it is a reasonable stand-in for a real document. This section needs a real LaTeX engine installed; **Tectonic** is the cheapest way to get one, a single binary that fetches packages as the document needs them, against a multi-gigabyte TeX Live, MacTeX, or MiKTeX install.

### Opening and first compile

- [ ] ★ Double-click `sample.tex` in the Explorer: it opens in the text editor as usual (the entry is `option` priority, not `default`), and the LaTeX preview opens automatically beside it (`markcopy.autoPreview`, on by default), without stealing focus from the source. It compiles the document and shows the result through the same pdf.js viewer `.pdf` files use.
- [ ] Close the preview tab, then click back into `sample.tex`'s editor (or switch away to another file and back): the preview stays closed rather than reopening on its own. Running **MarkCopy: Open Rich Preview to the Side** (or **Reopen Editor With...** > **MarkCopy LaTeX Preview**) reopens it, and it resumes auto-opening on focus after that.
- [ ] With `markcopy.autoPreview` set to `false`, opening or focusing `sample.tex` leaves only the text editor open; the preview still opens via **Reopen Editor With...** or **MarkCopy: Open Rich Preview to the Side**.
- [ ] `sample.tex` also opens this way via **MarkCopy: Open Rich Preview to the Side** (Command Palette, or right-click in the editor or Explorer), beside the source rather than replacing it.
- [ ] While the first compile runs, the panel shows a spinner and "Compiling sample.tex…" rather than a blank viewer.
- [ ] Once it finishes, the cross-reference in Section 2 resolves to a real section and equation number rather than "??", which is only true once the engine has run a second pass.

### Recompiling

- [ ] ★ Edit and save `sample.tex` (change the title, say): the preview recompiles and the new text appears.
- [ ] Scroll partway down the PDF, then save the source again: after the recompile, the view holds its scroll position rather than snapping back to page 1.
- [ ] The floating toolbar's **Recompile** button, the editor title bar's refresh icon, and **MarkCopy: Recompile LaTeX** from the Command Palette all recompile without needing a save first.
- [ ] Right-click the PDF: **Recompile LaTeX** does the same, and appears only on a LaTeX preview, never on a plain `.pdf`'s right-click menu.
- [ ] Running **MarkCopy: Recompile LaTeX** with no LaTeX preview focused shows a message asking you to focus one, rather than doing nothing silently.
- [ ] Set `markcopy.tex.recompileOnSave` to `false` and save `sample.tex`: the previous PDF stays on screen, and the Recompile button and menu entry still work.

### Errors

- [ ] Break `sample.tex` on purpose (delete a closing brace, or add an undefined command like `\notarealcommand{x}`) and save: the preview shows a short, specific message (the offending file and line, and the error text) rather than a dump of the engine's raw log.
- [ ] With more than one error in the document, the message says how many more there are past the first.
- [ ] The **Recompile** action is offered on a failed compile; fixing the source and using it (or saving again) clears the error and shows the PDF.

### Root-file resolution

- [ ] Create a second file next to `sample.tex`, starting with `% !TEX root = sample.tex`, and open it as a MarkCopy LaTeX preview: it compiles `sample.tex`, not the chapter file itself.
- [ ] Set `markcopy.tex.rootFile` to a specific file and confirm it wins over a `% !TEX root` comment in the open document.
- [ ] With neither the setting nor the comment present, the document being edited is what compiles, which is what `sample.tex` exercises on its own.
- [ ] Saving the chapter file recompiles a preview open on it, so `markcopy.tex.recompileOnSave` is watching the chapter, not only the root.

### Settings

- [ ] `markcopy.tex.compile: ask` shows an offer to compile naming the file and the detected engine, instead of compiling on open; its button compiles.
- [ ] `markcopy.tex.compile: off` shows a message naming the setting and no button, and the engine never runs.
- [ ] `markcopy.tex.engine` set to a specific engine (`pdflatex`, `xelatex`, `lualatex`, `tectonic`, or `latexmk`) is used instead of the auto-detected one; picking one your machine does not have shows the missing-engine message.
- [ ] `markcopy.tex.enginePath` pointed at a real engine's executable is used even when it is not on PATH; pointed at something that is not a LaTeX engine, the compile fails naming that path rather than silently trying another engine.
- [ ] `markcopy.tex.rootFile` and `markcopy.tex.recompileOnSave` are covered above.

### No engine installed

- [ ] With no LaTeX engine reachable (take it off `PATH` for the session, leaving `markcopy.tex.enginePath` empty so detection genuinely fails), opening `sample.tex` as a preview shows a message naming the platform's install options, Tectonic included as the lighter-weight one, instead of an error or a blank panel.

### Copy actions and theming

- [ ] ☑ The right-click menu offers exactly what the PDF viewer's does (Copy Selection, Copy Page N as PNG, **Copy as** Page/All Text, Add Comment Here, the **Theme** submenu), plus the LaTeX-only **Recompile LaTeX** entry, since it is the same viewer; see the [Copy Matrix](COPY-MATRIX.md#a-page-in-the-latex-preview).
- [ ] **Preferences** -> **Theme** applies all four values on a LaTeX preview, and the menu dismisses on a click outside, Escape and a click into the source editor, as on a PDF.
- [ ] Comments added on the compiled PDF persist to `<filename>.tex.mccomments.json` beside the source and survive a recompile.

## Paste-target pass

For a minor or major release, take the ★ copy rows above to the real targets at least once: Word (or Outlook), Gmail or another web email, Google Docs, and Excel or Google Sheets. The [Copy Matrix](COPY-MATRIX.md) says what should paste well where; anything that pastes as raw Markdown, loses table structure, or arrives blank is a release blocker.

## When a check fails

A regression in shipped behavior blocks the release: fix it (or revert the offending change) and restart the checklist section it belongs to. For a pre-existing issue that a release does not make worse, file it and move on. Either way, capture what broke and where it was pasted (the [issue guidance](../.github/CONTRIBUTING.md#filing-issues) asks for the copy action and paste target).
