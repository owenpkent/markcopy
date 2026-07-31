# Testing MarkCopy

How MarkCopy gets verified, from the automated suites to the manual checklist that gates a release. The automated layers run on every push; the manual checklist below is what "tested" means before publishing (see the [pre-release checklist](RELEASING.md#pre-release-checklist) in RELEASING.md).

## The three layers

| Layer                  | Runs                             | Covers                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit tests (vitest)    | `npm test`, CI on every push     | Pure logic: markdown-it rendering and source-line mapping, CSV/TSV serialization (RFC 4180), HTML-to-Markdown conversion, preview helpers, scroll-sync interpolation, PDF export command line and print CSS, the OOXML reader (number formats, date serials, merges, hidden rows, malformed and hostile workbooks), and the spreadsheet preview's contract with the shared webview bundle. |
| Integration (VS Code)  | `npm run test:integration`, CI   | Activation, command registration, configuration defaults, the preview panel opening, inside a real downloaded VS Code.                                                                                                                                                                                                                                                                     |
| Manual (this document) | Before every release, by a human | Everything the webviews do: clipboard writes, the context menu, rendering fidelity, the PDF viewer, paste targets outside VS Code.                                                                                                                                                                                                                                                         |

The manual layer exists because the interesting behavior lives inside webviews, where the automated harnesses cannot reach: `document.execCommand`/Clipboard API writes, canvas rasterisation, text-layer selection, and how the clipboard flavors actually paste into Word or Gmail.

## Setting up a manual pass

1. Build and launch: `npm run compile`, then **F5** in VS Code (the Extension Development Host). The launch config opens this repo as the dev host's workspace, so the fixtures below are already in its Explorer. For a release candidate, test the packaged artifact instead: `npm run vsix`, then `code --install-extension markcopy-<version>.vsix` in a regular window.

   Changing `package.json` contributions (languages, activation events, menus, settings) only takes effect when the dev host **process** starts. After editing the manifest, close the dev host window and press F5 again; a reload is not always enough.

2. Fixtures:
   - [sample.md](../sample.md) (repo root) exercises the Markdown surface: tables, code, Mermaid, math, images.
   - [sample.csv](../sample.csv) (repo root) exercises the CSV grid: quoted commas, escaped quotes, a newline inside a cell, currency/percent/negative numbers, a ragged row, and non-ASCII text.
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

- [ ] ★ Right-click a table, **Copy Table** (top-level), paste into Word or Google Docs: a real table arrives, not Markdown source.
- [ ] Right-click a table -> **Copy as** -> **CSV**, paste into Excel or Google Sheets: real cells.
- [ ] Right-click a paragraph -> **Copy as** -> **PNG**, paste into a chat or slide: an image arrives.
- [ ] Right-click a Mermaid diagram, **Copy Diagram** (top-level): an image arrives.
- [ ] Select some text, right-click -> **Copy as** -> **Markdown**: the original Markdown source comes back.
- [ ] Right-click a rendered equation -> **Copy as** -> **LaTeX**: the original source comes back.
- [ ] ★ **Copy Whole Document** (top-level menu, or the command palette's **Copy Whole Document as Rich Text**), paste into an email draft: formatting intact.
- [ ] Every successful copy shows a toast.
- [ ] Right-click something that matches more than one context (for example, select text inside a table): the top level shows **Copy Selection**, and **Copy as** splits into headed sections (`SELECTION`, `TABLE`) rather than one flat list.

### Settings, themes, and sync

- [ ] Right-click -> **Preferences** -> **Theme**: Auto, Light, Dark, and Green on black all apply immediately and persist to `markcopy.theme`.
- [ ] Green on black is pure `#00ff00` on black (not a soft mint), and copied/exported output still forces light styling.
- [ ] **Sync scroll**, **Auto-open preview**, and **Math** toggles under **Preferences** write through to settings; **MarkCopy Settings...** (also under **Preferences**) and the gear icon both open the MarkCopy settings page.
- [ ] Arrow keys navigate the menu: Down/Up move between rows, Right or Enter opens a submenu (**Copy as**, **Preferences**, **Theme**), Left or Escape steps back out, and Enter/Space activates the highlighted row.
- [ ] With sync scroll on, scrolling the editor scrolls the preview to match, and scrolling the preview scrolls the editor to match.
- [ ] Neither surface fights the other: drag the preview's scrollbar slowly and it keeps going where you put it instead of jumping back to a block boundary. Same for the editor.
- [ ] Sync scroll tracks part way through a long block (a big code block or table) rather than snapping between blocks, and reaches the very bottom of the preview when the editor is scrolled to the end.
- [ ] With **Sync scroll** off, neither direction follows: scrolling the editor leaves the preview alone, and scrolling the preview leaves the editor alone.
- [ ] **MarkCopy: Save as PDF** asks where to save, writes a `.pdf` there, and opens it. No browser window and no print dialog appear on the way.
- [ ] The exported pages carry **no filename header and no URL footer**.
- [ ] Nothing is clipped or shunted onto a page of its own: a code block longer than a page splits across pages, a very long code line wraps instead of being cut off at the right margin, a table taller than a page splits with its header row repeated on each page, and there is no blank page at the end.
- [ ] Code block, table header, and blockquote backgrounds are present in the PDF (not flattened to white), diagrams and equations are intact, and the text is selectable.
- [ ] Setting `markcopy.pdf.pageSize` to `A4` changes the exported page size.
- [ ] Setting `markcopy.pdf.browserPath` to a nonsense path still asks where to save, then fails with a readable error naming that path and offering **Print from Browser**; taking it opens the preview in your browser with the print dialog.
- [ ] Nothing is left behind in the temp directory after an export, successful or failed (`%TEMP%`/`$TMPDIR`, `markcopy-pdf-*`).
- [ ] Exporting over an existing PDF that then fails leaves the old file intact: point `markcopy.pdf.browserPath` at a nonsense path, export onto a PDF you already have, dismiss the error, and confirm the original still opens and is unchanged.
- [ ] Exporting a CSV grid wider than the page fits every column onto the paper rather than cutting off the right-hand ones, including after dragging a column divider to widen it in the preview first.

## Spreadsheet preview (.xlsx)

Open [sample.xlsx](../sample.xlsx) (repo root). It has three sheets (one hidden), a merged title, dates, currency, a percentage, a formula with a stored result, and a formula without one.

- [ ] It opens as a grid, not as binary junk or an error, with sheet tabs along the top.
- [ ] The column headers are letters (A, B, C) and the row numbers are the sheet's own: the sample jumps from row 1 to row 3, and the gutter shows that rather than renumbering.
- [ ] Dates read as `2023-03-15`, currency as `1,234.50`, and the margin as `15.3%`. None of them appear as raw numbers like `45000` or `0.153`.
- [ ] The title in row 1 spans three columns (a merged cell).
- [ ] `SUM` shows its stored result, `11110.75`. `AVERAGE`, which has no stored result, shows a muted marker rather than an empty cell, and hovering it explains why.
- [ ] The tab strip shows **Summary** and **Notes** but not **Scratch**, which is hidden. Clicking **Notes** switches sheets and the tab strip follows.
- [ ] Right-click the grid -> **Copy as** -> **CSV**, paste into a spreadsheet: real cells, **no row-number column and no A/B/C header row**, and the first pasted row is the sheet's own first row.
- [ ] Right-click -> **Copy as** -> **Markdown**: a real Markdown table (pipes and a `| --- |` separator line), not raw `<table>` HTML. The merged title row is padded to the full width, and there is no A/B/C row and no row-number column.
- [ ] Cells cannot be edited: clicking one and typing does nothing, and there is no edit caret. (A workbook is read-only in MarkCopy by design.)
- [ ] All four `markcopy.theme` values render the grid and the tab strip legibly, green included.
- [ ] **Save as PDF** from the right-click menu exports the active sheet, with no tab strip and no row-number gutter on the page.
- [ ] Editing the workbook in a spreadsheet application and saving re-renders the open preview.
- [ ] Renaming a `.txt` to `.xlsx` and opening it gives a readable message, not a blank panel.

## CSV / TSV grid

Open [sample.csv](../sample.csv).

### Rendering

- [ ] ★ The preview auto-opens to the side and shows a grid, not raw text.
- [ ] The first row is a header; it stays pinned when you scroll down, and the row-number gutter stays pinned when you scroll right.
- [ ] Rows alternate background color, and hovering a row highlights the whole row including its number.
- [ ] `units`, `revenue`, `margin` are right-aligned; `product` and `notes` are left-aligned.
- [ ] Row 2's `product` is `Gadget, deluxe` in one cell (a quoted comma did not split it).
- [ ] Row 4's `notes` contains `Customer said "finally, one that fits"` with real quotes.
- [ ] Row 5's `notes` holds both of its lines in a single cell, and the row is still one line tall (clipped with an ellipsis).
- [ ] Row 9 is short one field; it is padded with empty cells rather than shifting the columns.
- [ ] Row 10 renders `Café Ünïcode` correctly.
- [ ] Editing the file in the editor updates the grid live.
- [ ] All three themes (Auto/Light/Dark, and Green on black) style the grid, including the stripes and the gutter.
- [ ] Set `markcopy.csv.maxRows` to `3`: only 3 rows render and a note says how many of the total are hidden.
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
- [ ] Type in the text editor while the grid is open: the grid keeps up, and nothing is corrupted.
- [ ] Arrow keys move the selection; Tab enters the grid once rather than stepping through every cell.

### Copy and export

- [ ] ★ Right-click the grid -> **Copy as** -> **CSV**, paste into Excel or Google Sheets: real cells, and **no row-number column**.
- [ ] The pasted data round-trips the tricky rows: the quoted comma, the escaped quotes, and the multi-line cell all come back intact.
- [ ] A field with deliberate leading/trailing spaces keeps them through a **Copy as** -> **CSV** round-trip.
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
- [ ] After a zoom step, the page indicator settles on whatever page actually sits under the midline.

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
- [ ] Scrollbars are always visible and styled.

## Paste-target pass

For a minor or major release, take the ★ copy rows above to the real targets at least once: Word (or Outlook), Gmail or another web email, Google Docs, and Excel or Google Sheets. The [Copy Matrix](COPY-MATRIX.md) says what should paste well where; anything that pastes as raw Markdown, loses table structure, or arrives blank is a release blocker.

## When a check fails

A regression in shipped behavior blocks the release: fix it (or revert the offending change) and restart the checklist section it belongs to. For a pre-existing issue that a release does not make worse, file it and move on. Either way, capture what broke and where it was pasted (the [issue guidance](../.github/CONTRIBUTING.md#filing-issues) asks for the copy action and paste target).
