# Copy Matrix

Every action the preview's right-click menu can offer, the clipboard flavor it writes, and where it pastes cleanly. The menu is adaptive: only the rows relevant to what you clicked appear, plus the always-available document action. "Copy Selection ..." and "Copy Block ..." are mutually exclusive: Selection appears only when you have text highlighted, Block appears only when you don't.

## When you right-click a...

### Text selection (any highlighted text)

| Action                      | Clipboard flavor               | Pastes well into                         |
| --------------------------- | ------------------------------ | ---------------------------------------- |
| Copy Selection as Rich Text | `text/html` + `text/plain`     | Word, Outlook, Gmail, Google Docs, Slack |
| Copy Selection as Markdown  | `text/plain` (Markdown source) | Any editor, chat, another `.md` file     |

These replace the "Copy Block ..." actions below whenever there's an active selection.

### Code block

| Action    | Clipboard flavor          | Pastes well into       |
| --------- | ------------------------- | ---------------------- |
| Copy Code | `text/plain` (no styling) | Any editor or terminal |

The plain-text code is copied verbatim, without the syntax-highlight markup, so it drops straight into an editor.

### Table

| Action                 | Clipboard flavor                         | Pastes well into                       |
| ---------------------- | ---------------------------------------- | -------------------------------------- |
| Copy Table (Rich Text) | `text/html` + `text/plain`               | Word, Google Docs, Outlook             |
| Copy Table as CSV      | `text/plain` (comma-separated, RFC 4180) | Excel, Google Sheets, any CSV importer |
| Copy Table as TSV      | `text/plain` (tab-separated)             | Excel, Google Sheets (as real cells)   |
| Copy Table as PNG      | `image/png`                              | Slides, chat, anywhere an image works  |

### Mermaid diagram

| Action              | Clipboard flavor          | Pastes well into             |
| ------------------- | ------------------------- | ---------------------------- |
| Copy Diagram as PNG | `image/png`               | Slides, docs, chat           |
| Copy Diagram as SVG | `text/plain` (SVG markup) | A file, vector editors, HTML |

### Any other block (paragraph, heading, list, blockquote), with no text selected

| Action                  | Clipboard flavor               | Pastes well into                     |
| ----------------------- | ------------------------------ | ------------------------------------ |
| Copy Block as Rich Text | `text/html` + `text/plain`     | Word, Outlook, Gmail, Google Docs    |
| Copy Block as Markdown  | `text/plain` (Markdown source) | Any editor, chat, another `.md` file |
| Copy Block as PNG       | `image/png`                    | Slides, chat, docs                   |

If text is selected, right-clicking gets you "Copy Selection as Rich Text" / "Copy Selection as Markdown" instead (see above), not these.

### A page in the PDF preview

Opening a `.pdf` uses the MarkCopy PDF preview. Right-click a page for:

| Action             | Clipboard flavor         | Pastes well into       |
| ------------------ | ------------------------ | ---------------------- |
| Copy Page N as PNG | `image/png`              | Slides, chat, docs     |
| Copy Page N Text   | `text/plain`             | Any editor or document |
| Copy All Text      | `text/plain` (all pages) | Any editor or document |
| Copy Selected Text | `text/plain`             | Any editor or document |

Each page now has a real pdf.js text layer (transparent, selectable spans over the canvas), so **Copy Selected Text** copies whatever you highlight directly on the page; earlier builds had no selectable text on the canvas, so this action had nothing to select.

### Always available

| Action                           | Clipboard flavor           | Pastes well into                  |
| -------------------------------- | -------------------------- | --------------------------------- |
| Copy Whole Document as Rich Text | `text/html` + `text/plain` | Word, Outlook, Gmail, Google Docs |

The same whole-document action is available without the preview focused, via the Command Palette: **MarkCopy: Copy Whole Document as Rich Text**.

## Notes

- **Rich text always includes a plain-text fallback.** Every `text/html` write also sets `text/plain`, so a target that cannot take HTML still gets readable content.
- **Rich text is inline-styled.** Styles are baked into `style` attributes so formatting survives Gmail and Outlook, which discard `<style>` blocks and external CSS.
- **CSV and TSV both offered.** TSV pastes as individual cells in Excel and Google Sheets most reliably (nothing to confuse it, since cell text rarely contains tabs). CSV is there for importers and tools that expect commas; it follows RFC 4180, quoting any field that contains a comma, quote, or newline.
- **PNG copy needs clipboard image support.** It uses the async Clipboard API with a `ClipboardItem`. If the host blocks image writes you get a toast saying so, never a silent failure.
- **Selection vs block Markdown.** "Copy Selection as Markdown" converts exactly the selected HTML back to Markdown (Turndown), so partial paragraphs and multi-block selections come through faithfully, though delimiters may be normalized (for example `*` for emphasis). "Copy Block as Markdown" instead returns the verbatim source of the whole block.
