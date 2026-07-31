# Copy Matrix

Every action the preview's right-click menu can offer, the clipboard flavor it writes, and where it pastes cleanly. The menu is adaptive: only the rows relevant to what you clicked appear, plus the always-available document action.

The top level is short: it names whatever you clicked ("Copy Selection", "Copy Code", "Copy Table", "Copy Diagram", "Copy Equation", or "Copy Block") and copies it in its most useful format. Every other format for that element lives one level down, in the **Copy as** submenu. Precedence when more than one element could apply is Selection > Code > Table > Diagram > Equation > Block, so a selection inside a table still gets "Copy Selection" at the top, not "Copy Table".

## When you right-click a...

### Text selection (any highlighted text)

Top level:

| Action         | Clipboard flavor           | Pastes well into                         |
| -------------- | -------------------------- | ---------------------------------------- |
| Copy Selection | `text/html` + `text/plain` | Word, Outlook, Gmail, Google Docs, Slack |

Copy as:

| Format   | Clipboard flavor               | Pastes well into                     |
| -------- | ------------------------------ | ------------------------------------ |
| Markdown | `text/plain` (Markdown source) | Any editor, chat, another `.md` file |

This takes over from "Copy Table" / "Copy Block" below whenever there's an active selection. If the selection sits inside a table, the **Copy as** submenu splits into headed sections, one for the selection and one for the table it's in (for example `SELECTION > Markdown` and `TABLE > Rich Text, CSV, TSV, PNG`), so every format for both contexts stays reachable.

### Code block

| Action    | Clipboard flavor          | Pastes well into       |
| --------- | ------------------------- | ---------------------- |
| Copy Code | `text/plain` (no styling) | Any editor or terminal |

The plain-text code is copied verbatim, without the syntax-highlight markup, so it drops straight into an editor. Code has only the one format, so there's no **Copy as** submenu for it.

### Table

Top level:

| Action     | Clipboard flavor           | Pastes well into           |
| ---------- | -------------------------- | -------------------------- |
| Copy Table | `text/html` + `text/plain` | Word, Google Docs, Outlook |

Copy as:

| Format | Clipboard flavor                         | Pastes well into                       |
| ------ | ---------------------------------------- | -------------------------------------- |
| CSV    | `text/plain` (comma-separated, RFC 4180) | Excel, Google Sheets, any CSV importer |
| TSV    | `text/plain` (tab-separated)             | Excel, Google Sheets (as real cells)   |
| PNG    | `image/png`                              | Slides, chat, anywhere an image works  |

This applies to the CSV/TSV grid too: a previewed `.csv` renders as a real table, so it offers exactly the same actions. Its row-number gutter is viewer chrome (marked `data-mc-ignore`) and is left out of every format, rich text and PNG included, so what you copy is the data in the file. Grid cell text is copied verbatim, so leading and trailing spaces inside a field survive; a Markdown table's cell whitespace is incidental to rendering and is still trimmed.

A grid you have resized also gets one non-copy row, **Reset Column Widths**, which restores the automatic column sizing.

### Mermaid diagram

Top level:

| Action       | Clipboard flavor | Pastes well into   |
| ------------ | ---------------- | ------------------ |
| Copy Diagram | `image/png`      | Slides, docs, chat |

Copy as:

| Format | Clipboard flavor          | Pastes well into             |
| ------ | ------------------------- | ---------------------------- |
| SVG    | `text/plain` (SVG markup) | A file, vector editors, HTML |

### Equation (KaTeX)

Top level:

| Action        | Clipboard flavor | Pastes well into   |
| ------------- | ---------------- | ------------------ |
| Copy Equation | `image/png`      | Slides, docs, chat |

Copy as:

| Format | Clipboard flavor                | Pastes well into                               |
| ------ | ------------------------------- | ---------------------------------------------- |
| LaTeX  | `text/plain` (original `$...$`) | Any editor, chat, another `.md` or `.tex` file |

### Any other block (paragraph, heading, list, blockquote), with no text selected

Top level:

| Action     | Clipboard flavor           | Pastes well into                  |
| ---------- | -------------------------- | --------------------------------- |
| Copy Block | `text/html` + `text/plain` | Word, Outlook, Gmail, Google Docs |

Copy as:

| Format   | Clipboard flavor               | Pastes well into                     |
| -------- | ------------------------------ | ------------------------------------ |
| Markdown | `text/plain` (Markdown source) | Any editor, chat, another `.md` file |
| PNG      | `image/png`                    | Slides, chat, docs                   |

If text is selected, right-clicking gets you "Copy Selection" (and its **Copy as > Markdown**) instead (see above), not these.

### A page in the PDF preview

Opening a `.pdf` uses the MarkCopy PDF preview. Right-click a page for:

Top level:

| Action             | Clipboard flavor | Pastes well into                                    |
| ------------------ | ---------------- | --------------------------------------------------- |
| Copy Selection     | `text/plain`     | Any editor or document (only when text is selected) |
| Copy Page N as PNG | `image/png`      | Slides, chat, docs (only over a rendered page)      |

Copy as:

| Format      | Clipboard flavor         | Pastes well into       |
| ----------- | ------------------------ | ---------------------- |
| Page N Text | `text/plain`             | Any editor or document |
| All Text    | `text/plain` (all pages) | Any editor or document |

Each page has a real pdf.js text layer (transparent, selectable spans over the canvas), so **Copy Selection** copies whatever you highlight directly on the page; earlier builds had no selectable text on the canvas, so this action had nothing to select.

### Always available

| Action              | Output                     | Goes to                           |
| ------------------- | -------------------------- | --------------------------------- |
| Copy Whole Document | `text/html` + `text/plain` | Word, Outlook, Gmail, Google Docs |
| Save as PDF…        | A `.pdf` file              | Wherever you save it, then opens  |

Both are also available without the preview focused, via the Command Palette: **MarkCopy: Copy Whole Document as Rich Text** and **MarkCopy: Save as PDF**. Save as PDF assembles a standalone page (with the preview's CSS, KaTeX fonts, and local images inlined) and has a headless Chrome, Edge, or Chromium render it to the file you chose, so equations, diagrams, and highlighted code all carry over and the text stays selectable. There is no print dialog and no header or footer on the pages. With no such browser installed it falls back to opening the page in your default browser to print by hand (Ctrl/Cmd+P, then **Save as PDF**).

## Notes

- **Rich text always includes a plain-text fallback.** Every `text/html` write also sets `text/plain`, so a target that cannot take HTML still gets readable content.
- **Rich text is inline-styled.** Styles are baked into `style` attributes so formatting survives Gmail and Outlook, which discard `<style>` blocks and external CSS.
- **CSV and TSV both offered.** TSV pastes as individual cells in Excel and Google Sheets most reliably (nothing to confuse it, since cell text rarely contains tabs). CSV is there for importers and tools that expect commas; it follows RFC 4180, quoting any field that contains a comma, quote, or newline.
- **PNG copy needs clipboard image support.** It uses the async Clipboard API with a `ClipboardItem`. If the host blocks image writes you get a toast saying so, never a silent failure.
- **Selection vs block Markdown.** "Copy Selection > Markdown" converts exactly the selected HTML back to Markdown (Turndown), so partial paragraphs and multi-block selections come through faithfully, though delimiters may be normalized (for example `*` for emphasis). "Copy Block > Markdown" instead returns the verbatim source of the whole block.
- **Everything else (Preferences, Theme, sync scroll, and so on) lives under the "Preferences" submenu**, not in this matrix; see the [README](../README.md#features) and [Architecture](ARCHITECTURE.md#context-menu) for those.

## Spreadsheet sheets (.xlsx / .xlsm)

A sheet renders as the CSV grid's markup, so every row in the CSV grid section above applies to it unchanged: the same **Copy as** flavors, the same right-click targets, the same exclusion of the row-number gutter from what lands on the clipboard.

Three differences are worth stating explicitly.

- **The header row is chrome, not data.** A CSV grid's header is the file's own first row, so it copies. A sheet's header is the column letters A, B, C, which label the grid rather than being part of it, so the whole row is marked `data-mc-ignore` and drops out of every copy. What you copy is the cells, starting at the sheet's first row.
- **Cells copy as displayed, not as stored.** A date copies as `2023-03-15`, not as the serial `45000`, and a percentage as `15.3%`, not `0.153`. That is what the reader is looking at, and what a spreadsheet or document receiving the paste will interpret correctly.
- **Copy Whole Document and Save as PDF cover the active sheet only.** Both serialize what is on screen, and the preview shows one sheet at a time. Switch tabs and repeat for another sheet.

**Copy as Markdown** deserves a note of its own, because a sheet needs reshaping that a Markdown table does not. A GFM table cannot be headerless, and a sheet is one once its column letters are stripped: Turndown's table rule sees no header, declines the table, and returns the raw HTML. So `prepareTableForMarkdown` (`src/webview/table.ts`) promotes the first body row to the header and pads it out to the widest row, which matters when row 1 is a merged title spanning the sheet.

There is no cell editing, so no equivalent of the CSV grid's writeback: the document behind a sheet is a binary workbook, and MarkCopy never writes to it.
