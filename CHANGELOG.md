# Changelog

All notable changes to MarkCopy are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- PlantUML support.
- An email-safe export profile (table-based layout, fully inlined).

## [0.10.0] - 2026-09-06

### Added

- **LaTeX preview.** Open or focus a `.tex`, `.ltx`, or `.latex` file and MarkCopy opens the preview beside it automatically, governed by `markcopy.autoPreview` just like Markdown, CSV, and TSV (or reach it by hand via **Reopen Editor With...** or **MarkCopy: Open Rich Preview to the Side**). MarkCopy compiles it with an external LaTeX engine and shows the result through the same PDF viewer as `.pdf` files, right-click menu, comments, zoom, and Theme submenu included. It rebuilds on save, or from the floating **Recompile** button, the editor title bar's refresh icon, **MarkCopy: Recompile LaTeX**, or a right-click **Recompile LaTeX** entry. Contributed at `option` priority, like Markdown and CSV, so a `.tex` file still opens in the text editor by default: it is a file people spend most of the day editing, and stealing that would be worse than having no preview at all.
  - **Requires a LaTeX engine already on your machine.** MarkCopy does not bundle one. It looks for `latexmk` first, then `tectonic`, then the bare engines (`pdflatex`, `xelatex`, `lualatex`), since the first two rerun the document themselves until cross-references and the bibliography settle. With none found, the preview names what to install, Tectonic (a single small binary that fetches packages as needed) included as the option that skips a multi-gigabyte distribution.
  - **`-shell-escape` is never passed**, to any engine, under any circumstance: it would let a document's own source run arbitrary shell commands, and opening someone's repository has to stay safe.
  - For a project where the open file is a chapter rather than the document to compile, a `% !TEX root = ../main.tex` comment (or the new `markcopy.tex.rootFile` setting) tells MarkCopy what to actually build.
  - New settings: `markcopy.tex.compile` (`auto` by default, or `ask` / `off`), `markcopy.tex.engine`, `markcopy.tex.enginePath`, `markcopy.tex.rootFile`, and `markcopy.tex.recompileOnSave`.

- **The preview can be the tab, not only the panel beside it.** Markdown, CSV, and TSV files now appear in VS Code's editor picker (**Reopen Editor With...**, from the `...` menu in the editor title bar or the right-click menu in the Explorer) as **MarkCopy Markdown Preview** and **MarkCopy CSV Preview**, so a document can be read full width in its own tab instead of in half a window. **Set Default for '*.md'** in that same menu makes it what a double-click opens from then on.
  - It is the same preview, not a second one: the same right-click copy menu, the same themes, the same **Save as PDF** and settings buttons in the title bar, and the same editable CSV grid, writing back through the same undoable document edits.
  - What is behind the tab is still the file itself, so it re-renders as you type in any other editor open on that document, and links, images, and scroll sync work as they do in the side panel. A link to another Markdown file, followed from a preview tab, opens its target as a preview tab too, instead of reaching over to move the side panel.
  - Nothing changes unless you ask for it. Both entries are contributed at `option` priority, so opening a Markdown file still lands in the text editor with the preview beside it, exactly as before.

- **ProRes, DNxHD, and HEVC videos now play, if you have ffmpeg.** QuickTime is a container, not a codec: the `.mov` files that come out of a camera or an editor hold codecs VS Code's Chromium has never been able to decode, and until now the preview could only say so and point at your default player. It now looks for `ffmpeg` — on `PATH`, then the usual install locations, or wherever `markcopy.video.ffmpegPath` points — and encodes a throwaway H.264 copy to a temp folder, with a progress bar and a **Cancel** button while it runs. The copy is what plays; the original is never touched, and the copy is deleted when the tab closes. The status line says `ffmpeg preview copy` for as long as one is on screen.
  - **A clip with an alpha channel goes over a transparency checkerboard**, not flat black. A ProRes 4444 lower third is mostly transparent, and flattening it onto black produces a frame that looks exactly like a clip rendering nothing. The status line says `alpha on checkerboard`, which is also the warning that the board is baked into any frame you grab.
  - **`markcopy.video.transcode`** chooses between `auto` (the default), `ask` — say what the file is and offer a button, for anyone whose folder is long 4K masters — and `off`, which keeps the old message-and-default-player behaviour. With no ffmpeg installed you get that same message, plus a note that installing one would let MarkCopy play the file here.

- **Right-click a link or an email address to copy it.** Both were reachable only by dragging across the text and hoping the selection started and ended in the right place, which is exactly the kind of value a hand-drag gets wrong invisibly. The menu now leads with **Copy Email Address** or **Copy Link** whenever the pointer is on one, ahead of even a selection, since right-clicking a link names a single element where a selection names a range. That reorders the top row where both apply: with text selected, right-clicking a link inside that selection now leads with **Copy Link** where it used to lead with **Copy Selection**. The selection has not gone anywhere, it moves down into **Copy as** > **Selection**.
  - An address comes out bare: no `mailto:` in front of it, no `?subject=` behind it, and percent-escapes decoded. A link's target comes out as the document wrote it rather than as the webview resolved it, so a relative link is still `./notes.md` and not a `vscode-webview://` URL that means nothing outside the window.
  - **Copy as** carries the rest: the `mailto:` form of an address, the **Link Text** for a link whose words differ from its target, and a ready-made **Markdown** link.
  - **In a CSV or spreadsheet grid this works on cell text**, where there is no link to right-click at all: nothing linkifies a grid, so an address in a `.csv` was previously plain characters and a careful drag. A cell holding an address or a URL now leads with the same rows, taking just that value out of whatever text surrounds it, and every cell gets its own **Copy as** > **Cell Text**. An ordinary cell leaves **Copy Table** at the top of the menu, where it has always been.

### Fixed

- **Engine detection now checks that an engine actually runs, not just that its file is there.** On Windows this is the difference between working and not: MiKTeX ships `latexmk.exe` as a wrapper around the latexmk Perl script, Windows has no Perl and MiKTeX bundles none, and `access(path, X_OK)` on Windows only tells you a file exists. So a very ordinary MiKTeX install advertised a latexmk that exits immediately with "MiKTeX could not find the script engine 'perl'", writes no log at all, and left the preview failing on a machine whose pdflatex and Tectonic were both fine. Automatic detection now runs each candidate before choosing it and moves on if it cannot start. Naming an engine yourself, through `markcopy.tex.engine` or `markcopy.tex.enginePath`, still skips the check and still fails loudly, because that choice was deliberate.
- **A compile that dies before writing a log now says why.** The failure text took the last line the engine printed, which for MiKTeX is its standing "you have not checked for MiKTeX updates" nag, so the one line that actually explained the failure was pushed out by one that had nothing to do with it. The engine's own explanation is now picked out of its output ahead of the routine chatter, and the message no longer refers the reader to a log file that in this situation was never written.
- **Opening a folder containing a `.tex` file no longer takes the extension host down with it.** Auto-preview runs on every active-editor change, and restoring a folder full of editors churns that several times in a row with nothing awaited in between. Because `vscode.openWith` is asynchronous, every pass in the burst saw no preview open yet and started another one, so a single document ended up with a stack of pdf.js webviews, each with its own compile session. The preview is now claimed synchronously for the moment the open is in flight, so a burst collapses to one panel.
- **The PDF viewer now resets its page state when a new document loads into it.** This could not happen before, because a plain `.pdf` only ever loaded once. It matters now that the LaTeX preview reloads the same viewer on every recompile: without a reset, each reload appended to the existing page list while the DOM was rebuilt underneath it, leaving page navigation, comment pins, and Copy Page as PNG addressing detached elements left over from the previous compile.
  - **A reload also no longer leaves the previous pdf.js worker running.** Same root cause, one layer down: the viewer hands pdf.js a worker it started itself, and pdf.js only ever shuts down a worker it created, so tearing the document down left the thread behind. Loading a `.pdf` once, that cost nothing; recompiling a `.tex` fifty times in a sitting left fifty live workers, each holding the full pdf.js bundle in memory. The worker and the blob URL it was started from are now both released with the document.
- **A CSV cell edit is no longer lost when you click somewhere that is not a cell.** Committing hung entirely on the editor being blurred, which covers clicking another cell but not clicking the padding around the grid, the row-number gutter, or the empty space past the last row: nothing there takes the focus in every engine, so no `blur` arrived, nothing was committed, and the value went with the next render. Leaving the webview (another editor tab, another window) had the same hole, and closed it the same way. Every spreadsheet keeps that edit, so it is kept, while a right-click — which takes the focus on purpose, so the menu's copy rows can read the value — still leaves the edit open underneath the menu.

## [0.9.0] - 2026-08-30

### Added

- **Video preview for `.mov`, `.mp4`, and `.m4v`.** Opening one plays it inline with transport controls, a readout of dimensions, duration, and size, and the shared **Theme** submenu, instead of the wall of binary VS Code shows for a QuickTime file. Its built-in preview covers `.mp4` and `.webm` only, so `.mov` and `.m4v` had no viewer at all; where both apply, MarkCopy's takes precedence, and **Reopen Editor With...** still reaches the built-in one or the raw bytes.
  - **Copy Frame as PNG** and **Save Frame as PNG…** grab the frame on screen at the video's true resolution, not its on-screen size. The saved file defaults to the video's own folder and carries the timecode in its name (`clip-1m23.400s.png`), so grabbing several in a row never overwrites the first. `,` and `.` step roughly a frame at a time to line the shot up; **space**, **m**, and **f** play, mute, and go fullscreen.
  - **Playback** sets looping (persisted as `markcopy.video.loop`) and speed from 0.25x to 2x, and `markcopy.video.autoplay` starts a video on open. Autoplay always starts muted, because that is the only kind a browser engine will start without a click.
  - **The file is streamed, not read.** Unlike the PDF and STL viewers, which read the whole file and hand it to the webview, the player pulls ranges off disk as it plays, so a multi-gigabyte clip opens as fast as a small one and costs no more memory. Nothing is fetched over the network.
  - **A file VS Code cannot decode says so.** QuickTime is a container, not a codec: H.264/AAC plays, but the ProRes, DNxHD, and HEVC that come out of a professional camera or editor do not. Those now show what is wrong and an **Open in Default App** button, rather than a black rectangle.

- **Insert and delete rows and columns in the CSV grid.** Right-click a cell, a column header, or a row number: **Insert** offers Row Above, Row Below, Column Left, and Column Right, **Delete** offers Row and Column. Until now the grid could only change fields that already existed, so growing or shrinking a file meant leaving the preview and counting commas in the text editor.
  - A new row is blank and as wide as the row it lands next to, so a ragged file stays as ragged as it was. A new column opens down the whole file, including the rows past `markcopy.csv.maxRows` that the grid never drew, so a truncated view cannot shear a file in half.
  - Each one is written into the document as a single change, exactly like a cell edit: **Ctrl+Z** takes back a column that touched ten thousand rows in one go, and every field that did not move keeps its original bytes, quoting and line endings included.
  - The grid moves under the cursor the way a spreadsheet does. After **Insert Row Above** you are standing on the new blank row, and after a **Delete** you are on whatever has slid into its place.

### Changed

- **Mermaid updated to 11.17.2**, which brings new diagram syntax to the preview: the `folder`, `bucket`, `console`, `browser` and `person` flowchart shapes, collapsible flowchart subgraphs (`subgraphId@{ view: collapsed }`), subgraphs in ER diagrams, and legends for named series in an xy chart.
  - Class diagrams now render through Mermaid's unified renderer rather than the legacy one, so an existing `classDiagram` may lay out slightly differently. Setting `"markcopy.mermaid": { "class": { "defaultRenderer": "dagre-d3" } }` restores the old one.

## [0.8.2] - 2026-08-27

### Security

- **A fenced block of C or C++ can no longer hang the preview.** Syntax highlighting matched the run of type tokens in front of a function name with a regex that could backtrack exponentially, so an unusual (or deliberately hostile) block of C in a document you only opened to read could lock the preview up. Bounded upstream in highlight.js 11.12.0.
- **The preview's HTML sanitizer was updated** to DOMPurify 3.4.14, which corrects a few edge cases involving mixed document contexts. MarkCopy sanitizes with the stock configuration and never allow-lists risky tags, so the allow-list bypass also fixed upstream did not apply here.

## [0.8.1] - 2026-08-19

### Fixed

- **A CSV cell you are editing now behaves like the text box it is.** Once the editor was open, every click inside it landed on the cell underneath and ended the edit, so the caret could not be moved, no part of a value could be selected by dragging, and right-clicking closed the editor before its menu appeared. Clicks inside an open editor now belong to the editor.
  - Double-clicking again inside an open editor selects the whole value, so it can be replaced or copied in one gesture.
  - Right-clicking inside one keeps the edit and its selection on screen, and offers **Copy Selection**, **Copy Cell** and **Select All** in place of the copy-the-whole-table rows, which could never see a selection inside a text box in the first place. The usual **Ctrl+C** / **Ctrl+X** / **Ctrl+V** / **Ctrl+A** work there as well. Those rows replace only the copy rows: **Reset Column Widths**, **Copy Whole Document**, **Save as PDF…** and **Preferences** stay where they always are, because none of them has anything to do with the cell being typed into and the menu is the only way to reach most of them.
  - An empty cell offers none of the three, rather than three rows that would copy and select nothing.
  - **Dismissing that menu puts the caret back in the cell.** Closing it with **Escape**, or by picking a row, used to leave the editor on screen with nothing focused: typing went nowhere and Escape could no longer discard the edit, so the next click anywhere wrote the half-typed value to the file.
  - **An edit left open while the preview re-renders is dropped rather than written back.** Typing in the text editor beside the grid redraws it, taking the open cell editor with it. What was in that editor described the document as it stood before those keystrokes, and it could still be committed afterwards, silently overwriting the newer text in that field.

### Changed

- **Closing a context menu returns the keyboard to wherever it came from**, in both the Markdown and PDF previews, instead of dropping it on the page. This is what lets an open CSV cell editor survive its own right-click, and it also means arrowing through a menu and pressing Escape leaves you where you started.

## [0.8.0] - 2026-08-18

### Added

- **A fit-width button in the PDF toolbar**, carrying the same page-with-a-double-headed-arrow icon as [folio](https://github.com/owenpkent/folio). It sizes the page to the width of the editor pane, landing on whatever percentage that takes rather than the nearest preset. It stays on once clicked, so dragging the pane wider or narrower re-fits the pages instead of leaving them the wrong size; clicking it again turns it off, leaving the pages at the size they have and simply stopping them chasing the pane. Any manual zoom (the buttons, `Ctrl`/`Cmd` + `+`/`-`/`0`, `Ctrl`/`Cmd` + scroll, or clicking the percentage) also turns it off. From a fitted percentage the plus and minus buttons step to the neighbouring preset level. In a PDF whose pages are not all the same size, the fit follows the page you are reading and re-fits as you scroll between a portrait page and a landscape one.

### Changed

- **Bare text that merely looks like a domain is no longer turned into a link.** Upgrading the Markdown engine to markdown-it 15 (and with it linkify-it 6) drops "fuzzy" autolinking, and MarkCopy keeps that new default rather than restoring the old behavior. Previously any word ending in something that happens to be a real top-level domain was linkified, so a plain mention of `RELEASING.md`, `README.md`, or `src/render.ts` became a link to `http://RELEASING.md`, which, when clicked, handed a nonexistent domain to your browser. Since a preview of developer documentation mentions filenames constantly, this misfired far more often than it helped, and the bad link was carried along by **Copy as → Rich Text** into whatever you pasted it into.
  - What still autolinks: any URL written with a scheme (`https://example.com`) and any email address.
  - What no longer does: schemeless text such as `github.com` or `www.example.com`. To link one, give it a scheme: `<http://www.example.com>` or `[www.example.com](http://www.example.com)`. Note that a bare `<www.example.com>` is not a Markdown autolink and never was; it renders as literal text.

- **The Markdown engine is now markdown-it 15**, up from 14.3, alongside KaTeX 0.18.4 and DOMPurify 3.4.13. Beyond the autolinking change above and the alt-text fix below, the upgrade is internal: rendering this repo's own Markdown under both versions turned up no other visible difference. markdown-it 15 also bundles its own TypeScript types, so the separate `@types/markdown-it` dependency is gone.

### Fixed

- **Zooming a PDF no longer moves you to a different page.** Every zoom step resized the pages while leaving the scroll offset at its old pixel value, so the pages above the viewport grew or shrank underneath it and the view slid away from what you were reading, further the deeper into the document you were. Zoom now anchors on the point at the centre of the viewport and holds it there, so the page (and your place on it) stays put whether you use the toolbar buttons, `Ctrl`/`Cmd` + `+`/`-`, `Ctrl`/`Cmd` + `0`, or `Ctrl`/`Cmd` + scroll.

- **Inline code inside image alt text is no longer dropped.** ``![the `render.ts` file](x.png)`` produced `alt="the "`, losing everything from the backtick on; it now produces `alt="the render.ts file"`. Fixed upstream in markdown-it 15.
- **A couple of LaTeX edge cases**, via KaTeX 0.18.4: delimiter-sizing commands accept braced arguments (`\big{(}`), and an unrecognized environment now reports a clear `No such environment` parse error.

## [0.7.0] - 2026-08-01

### Added

- **STL 3D preview.** Open an `.stl` file and it renders in a Three.js viewer instead of opening as binary. Mouse-only controls (left-drag to orbit, right-drag to pan, scroll to zoom), the camera fitted to the model on load, a toolbar for **Fit view** / wireframe / grid, and an overlay reporting the triangle count and bounding-box dimensions. Binary and ASCII STL are both read, and the viewport background follows `markcopy.theme` like the other previews.
  - Ported from [MeshView](https://github.com/owenpkent/meshview), which this supersedes. If you have both installed they will compete for `.stl`; uninstall MeshView.
  - The viewer has no copy actions, deliberately: a triangle soup has nothing meaningful to put on a clipboard.
  - A binary STL whose header claims more triangles than the file can hold, any model above ~5.4 million triangles, or any file above 256 MiB is refused with a message rather than hanging the viewer on a multi-gigabyte allocation. The size is checked in the extension host before the file is read.
  - New settings: `markcopy.stl.showGrid` (`true`) and `markcopy.stl.meshColor` (`#8ab4f8`).
  - Three.js is bundled as its own `media/stl.js` entry point (~547 KB minified), so it is only loaded when an `.stl` file is opened and costs the Markdown, CSV, and PDF previews nothing.

- **Spreadsheet preview.** Open an `.xlsx` or `.xlsm` workbook and it renders as a grid, with sheet tabs, the column letters and row numbers a spreadsheet shows, and the same right-click **Copy as** menu the CSV grid has: rich text, Markdown, CSV, TSV, or PNG. Numbers, dates, percentages, and currency are shown the way the workbook formats them rather than as raw serial numbers, merged cells stay merged, and rows, columns, and sheets the author hid stay hidden.
  - The preview is read-only, deliberately: MarkCopy will not write to your workbook, so it cannot damage one.
  - New settings: `markcopy.xlsx.maxRows` (5000) and `markcopy.xlsx.maxColumns` (200).
  - A formula the file stores without a calculated result (which openpyxl and xlsxwriter both produce) is marked rather than shown as an empty cell.

- **Copy any table as Markdown.** Right-click a table, a CSV grid, or a spreadsheet sheet and **Copy as** now offers **Markdown**, so a range of cells lands in a document as a real Markdown table. The viewer's own chrome (the row-number gutter, and a sheet's A/B/C column letters) is left out, and a sheet's first row becomes the table header.

- **Automated tests for the preview itself.** The context menu and the clipboard used to be checked only by hand, on the grounds that nothing automated could reach inside a webview. A new suite (`tests/e2e/`) boots the real preview bundle and drives it the way a reader does: right-click, walk the menu, read what came out. It covers the copy flavors on all three table surfaces, the spreadsheet grid and its tab strip, and sync scroll in both directions. The VS Code integration suite now also checks that a `.xlsx`, `.xlsm`, or `.pdf` opens in its own editor rather than as text. What still needs a human is what needs a real browser: PNG copy, the PDF viewer, and how a flavor pastes into Word.

### Changed

- **Save as PDF now writes a PDF.** It used to open the preview in your browser and leave you to work the print dialog, which stamped the filename across the top of every page and the `file://` URL across the bottom. Now it asks where to save, renders the file with a headless Chrome, Edge, or Chromium found on your machine, and opens the result: no browser window, no print dialog, no header or footer. Text stays selectable, and equations, diagrams, highlighted code, and local images carry over as before.
  - New settings: `markcopy.pdf.pageSize` (`Letter`, `A4`, or `Legal`) and `markcopy.pdf.browserPath` for a browser installed somewhere unusual.
  - With no Chromium-family browser installed, or if a render fails, the old open-in-your-browser route is still there as a fallback.

### Fixed

- **A corrupt or hostile STL is refused before it is read, not after.** The guards against a binary header over-claiming its triangle count ran in the webview, which meant the file had already been read whole, base64-encoded, and sent across before anything asked whether it should have been opened. The size is now checked in the extension host first, and the triangle-count limit is derived from what the transport can actually carry, so a file cannot pass every check and then fail while being encoded.
- **Stray page breaks in the PDF export.** The print stylesheet asked the browser not to break inside a `pre`, `table`, or `blockquote`. That is impossible to honour for a block taller than a page, and a browser that cannot honour it pushes the block onto a fresh page anyway, leaving the rest of the previous page blank. Tall blocks may now split, a table's header row repeats on every page it spans, and the preview's scroll-past-the-end padding no longer prints as a blank final page. On a test document this went from 13 pages with 3 near-empty ones to 11 full pages.
- **Content silently cut off in the PDF export.** A wide code block or table scrolls sideways on screen, but in print `overflow: auto` just clips whatever does not fit the page, with nothing to say it had. A 400-character code line came out as 86 characters. Long lines and wide cells now wrap instead.
- **Code block, table header, and blockquote backgrounds missing from the PDF export.** Chromium drops background colours from a print unless the page opts in; the export now does (`print-color-adjust: exact`).
- **Sync scroll fought whichever surface you were using.** Editor and preview each drive the other, and neither ignored the echo of its own move, so scrolling the preview revealed a line in the editor, the editor reported its new position, and the preview was yanked to that line's block mid-gesture. Both sides now ignore the echo of a scroll they caused themselves.
- **Sync scroll snapped between blocks instead of tracking.** The preview reported the first block *below* the top of the viewport, which ran systematically ahead of where the reader actually was, and a long code block or table gave the sync nothing to say until it had scrolled past entirely. Both directions now interpolate between the blocks either side of the current position, and the end of the document maps to the end of the scroll rather than to the last block's top edge.
- **Sync scroll did nothing in the CSV grid.** The grid scrolls inside its own container rather than scrolling the page, which the sync did not account for; its rows now drive the sync directly.
- **`markcopy.syncScroll` only turned off half of it.** Turning the setting off stopped the preview following the editor, but the editor still jumped around as you scrolled the preview. It now gates both directions.
- **A failed PDF export could overwrite a good file, or report success without writing one.** The browser rendered straight to the path you picked, and the only check was that a file existed there afterwards, which cannot tell a fresh render from the export that was already sitting there. A browser that exited without writing left the previous PDF in place and called it a success, and a render that failed had already replaced it. The render now goes to a scratch file and is moved into place only once it is known good, so a failure changes nothing on disk.
- **A timed-out export left its browser profile behind.** The temporary directory was deleted the instant the browser was killed, while it still held files open underneath, which fails on Windows and stranded about 2 MB per timed-out export. The export now waits for the process to exit and retries the delete.
- **Sync scroll stalled if you scrolled during the moment after a synced move.** A gesture landing inside the 250ms echo-suppression window was dropped and never resent, so the editor sat on the old line until you scrolled again.
- **The end of a long document mapped to the wrong place.** The synthetic end-of-document anchor was almost never added, because the preview's scroll-past-the-end padding put the closing block beyond the end of the scroll range, so the last screenful stopped tracking. In a CSV grid truncated by `markcopy.csv.maxRows` it also aimed at the file's last line rather than the last row actually rendered, which flung the editor to the end of the file.
- **A wide CSV grid was clipped at the page margin in the PDF export**, and a column whose width you had dragged kept that width in the export. Grids now fit the paper.
- **`sample.csv` shipped inside the extension.** The other test fixtures were excluded from the package; that one was not, so every install carried a file only the repo needs.

## [0.6.0] - 2026-07-27

### Added
- **CSV and TSV preview.** Opening a `.csv` or `.tsv` file now renders it as a spreadsheet-style grid instead of leaving you to read raw delimiters. The extension contributes the `csv` and `tsv` language ids and activates on them, so the preview auto-opens beside the file exactly like Markdown does (`markcopy.autoPreview`), and **MarkCopy: Open Rich Preview to the Side** works from the editor and Explorer context menus.
  - **The grid.** A header row and a row-number gutter that stay pinned while you scroll both axes, alternating row colors, row hover highlighting, numeric cells (including `$1,234`, `38.2%`, and accounting-style `(1,234.50)`) aligned right with tabular figures, and columns sized to their contents. Long values are clipped with an ellipsis so every row stays one line tall. All three palettes (light, dark, and green-on-black) are supported.
  - **Resizable columns.** Drag any column divider to resize it. Double-click a divider (or focus it and press Enter) to fit the column to its widest cell; the arrow keys nudge a focused divider, with Shift for coarse steps. Right-click a grid you have resized for **Reset Column Widths**. The dividers are `role="separator"` and keyboard-reachable.
  - **Parsing.** Fields follow RFC 4180, so commas, quotes (`""`), and newlines inside a quoted cell all survive, and CRLF/LF/CR line endings and a UTF-8 BOM are handled. The delimiter is detected from the file's contents (comma, tab, semicolon, or pipe) by whichever splits it into the most consistent columns, except that a `.tsv` or `.tab` file is taken at its word and read as tab-separated: a TSV whose fields contain commas would otherwise score the comma higher and be split into the wrong columns. Ragged rows are padded out to the widest row.
  - **Copying works as it does everywhere else.** The grid is a real `<table>`, so the existing right-click menu applies unchanged: **Copy Table** as rich text, or **Copy as** CSV, TSV, or PNG. The row-number gutter is marked `data-mc-ignore` and is left out of every one of them, so what you copy is the data in the file, not the viewer's chrome. Cell text is copied verbatim, so leading and trailing spaces inside a field survive the round-trip. **Save as PDF** works too.
  - **Editable cells.** Click a cell to select it, then edit it: double-click, Enter, F2, or just start typing (which replaces the value, as in a spreadsheet). Enter commits and moves down, Tab commits and moves right, Shift+Enter puts a newline *inside* the cell, Escape discards, and Delete clears. Arrow keys move between cells, and the grid takes a single Tab stop rather than one per cell. Headers are editable too.
    - Edits are written straight to the file, so `Ctrl+Z` in the editor undoes them like any other change, and the grid and the text always agree.
    - Only the edited field is rewritten. The rest of the row keeps its exact original bytes, including quoting MarkCopy would not have chosen itself and the file's existing line endings, so editing one cell never churns the whole file. Quotes are added or dropped only as the new value requires, and a value containing a comma, a quote, or a newline round-trips intact.
    - A row shorter than the grid is wide is padded out in place when you edit past its end.
  - **Large files.** Rendering stops at `markcopy.csv.maxRows` (default 5000) and the grid reports exactly how many rows it is hiding, rather than freezing the preview on a huge file.
  - New settings: `markcopy.csv.delimiter` (`auto` by default), `markcopy.csv.headerRow`, and `markcopy.csv.maxRows`.

### Fixed
- The Extension Development Host (F5) started with no folder open, so none of the manual-test fixtures were reachable without opening one by hand. `.vscode/launch.json` now opens the repo as the dev host's workspace.

### Changed
- Cells marked `data-mc-ignore` are now dropped from every copy path: the CSV/TSV serializer skips them, rich-text copy removes them from its clone, and a PNG capture hides them. No Markdown table emits that attribute, so Markdown copies are unaffected.
- Preview re-renders triggered by typing are coalesced over an 80 ms window. A Markdown document was cheap to re-render on every keystroke; a CSV costs a delimiter sniff, a full parse, and a grid of up to `markcopy.csv.maxRows` rows.
- The extension also activates on `onLanguage:mdx`, which `previewKind` already claimed by file extension but could never be reached for.

## [0.5.0] - 2026-07-25

### Changed
- **Markdown preview menu, restructured into a short top level plus submenus.** The in-preview right-click menu used to be a long flat list, up to 19 rows (16 even on a plain paragraph, since an 11-row settings block was appended unconditionally). It's now at most 6 rows: a top-level `Copy <Noun>` item that names whatever you clicked (Selection, Code, Table, Diagram, Equation, or Block, in that precedence) and copies it in its primary format, a `Copy as` submenu holding every remaining format for that element (split into headed sections, like `SELECTION` and `TABLE`, when more than one context applies), `Copy Whole Document`, `Save as PDF…`, and a `Preferences` submenu for Theme, Sync scroll, Auto-open preview, Math, and MarkCopy Settings. No action was removed; every one of them just moved one level down. Both webviews now share a single menu engine (`src/webview/menu.ts`) with keyboard navigation, replacing the near-duplicate `showMenu` implementations that used to live in `main.ts` and `pdf.ts`. Opening the menu focuses its first row, so the arrow keys drive it immediately: up/down to move, right or Enter to open a submenu, left or Escape to back out one level, Enter/Space to activate. An open submenu also survives the pointer clipping the row below it on the way in, and a stray click on a divider, a group heading, or a panel's padding no longer closes the menu.
- **PDF viewer menu, restructured to match.** The PDF viewer's right-click menu was up to 13 rows and is now at most 5: top-level `Copy Selection` (when text is selected) and `Copy Page N as PNG` (over a rendered page), a `Copy as` submenu (`Page N Text`, `All Text`), `Add Comment Here`, and a `Preferences` submenu for the Hand/Pointer tool toggle, the Dark/Light Pages toggle, and a nested `Theme` submenu. It uses the same shared menu engine as the Markdown preview, so it gets the same keyboard navigation for free.

## [0.4.0] - 2026-07-22

### Added
- **Page indicator in the PDF viewer.** The floating toolbar now shows the current page as you scroll (e.g. `3 / 12`), tracked by whichever page sits under the middle of the viewport. Click it to type a page number and jump straight there (Enter jumps, Escape cancels). The page and zoom labels are real buttons, so the whole toolbar is keyboard-accessible.

### Changed
- **Truer terminal green.** The green-on-black theme's green is now pure `#00ff00` (the same green as GNOME Terminal's "Green on black" profile) instead of the previous softer mint, in both the Markdown preview palette and the PDF viewer's phosphor page tint; the palette's derived greens (borders, links, quotes, code tokens) moved to the same hue.

## [0.3.0] - 2026-07-21

### Added
- **Save as PDF.** A new **MarkCopy: Save as PDF** command (also a button in the preview's title bar, an entry in the Markdown editor's right-click menu, and a **Save as PDF…** item in the in-preview right-click menu) exports the rendered preview. The webview serializes its already-rendered content (KaTeX equations, Mermaid SVGs, highlighted code) and the extension host wraps it in a self-contained HTML file carrying the preview's own CSS, with KaTeX fonts and local images inlined so it stands alone, then opens it in your default browser where it prints to PDF. Text stays selectable and the export forces the light palette for a clean printout; Mermaid diagrams are re-rendered in the light theme for the export so a dark-preview diagram stays readable on the page. No new dependencies.
- **Green-on-black ("terminal") theme.** A new `green` value for `markcopy.theme` (and a **Green on black** option in the in-preview Theme menu) renders green text on a black background. Like `light` and `dark` it's a forced palette that ignores the VS Code theme; copied and PDF-exported output still comes out light-safe. The PDF _viewer_ follows the setting too: with `markcopy.theme` set to `green`, pages render as a green-on-black phosphor (an inverted, green-tinted bitmap, matching how Dark Pages inverts). **Copy Page as PNG** still yields the page in its true colours.
- **KaTeX / LaTeX math rendering.** Inline `$...$` and display `$$...$$` now render as equations. Like Mermaid, the extension host emits an inert placeholder and the webview upgrades it with KaTeX after DOMPurify runs, so no math markup passes through the sanitizer. Right-click an equation to **Copy Equation as PNG** (fonts are embedded so it pastes cleanly into docs and email) or **Copy Equation as LaTeX**; "Copy as Markdown" also restores the original `$...$` source. Toggle with the `markcopy.math` setting (on by default; turn off for documents that use literal dollar signs).

- **Theme menu in the PDF viewer.** The PDF viewer's right-click menu now has the same **Theme** section as the Markdown preview (Auto / Light / Dark / Green on black). Picking one persists `markcopy.theme` at the scope where it's defined (a workspace or folder override, else Global) and re-tints the open pages immediately. The setting is shared with the Markdown preview and any other open PDF viewers, so changing the theme from any surface (or directly in `settings.json`) re-tints an already-open PDF without reopening it. The session-only **Dark Pages / Light Pages** quick toggle remains for a one-off inversion that doesn't change the saved theme.

### Changed
- **Faster preview load.** The Markdown preview bundle no longer ships Mermaid, KaTeX, html-to-image, and Turndown up front. It's now an ES-module code-split build that loads each of those on demand (Mermaid/KaTeX only when a document has a diagram/math, html-to-image on **Copy as PNG**, Turndown on **Copy Selection as Markdown**), so the initial script dropped from ~8.5 MB to ~19 KB. DOMPurify still loads eagerly since it runs on every render.

### Removed
- The **VS Code style profile** (the `vscode` value of `markcopy.styleProfile`) and its **Style** menu section. It followed the editor theme's colors but rendered unreliably; the preview now always uses the GitHub-accurate styling, which is what pastes cleanly into docs and email. `markcopy.styleProfile` remains (now `github`-only) for compatibility.

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

- **Marketplace polish**: an extension icon (`media/icon.png`, generated by `npm run icon`), a dark gallery banner, Open VSX publishing (`npm run publish:ovsx`), and a [RELEASING.md](docs/RELEASING.md) guide covering publisher setup, both registries, and the verified-publisher badge.

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

[Unreleased]: https://github.com/owenpkent/markcopy/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/owenpkent/markcopy/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/owenpkent/markcopy/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/owenpkent/markcopy/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/owenpkent/markcopy/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/owenpkent/markcopy/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/owenpkent/markcopy/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/owenpkent/markcopy/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/owenpkent/markcopy/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/owenpkent/markcopy/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/owenpkent/markcopy/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/owenpkent/markcopy/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/owenpkent/markcopy/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/owenpkent/markcopy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/owenpkent/markcopy/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/owenpkent/markcopy/releases/tag/v0.0.1
