# Copy Matrix

Every action the preview's right-click menu can offer, the clipboard flavor it writes, and where it pastes cleanly. The menu is adaptive: only the rows relevant to what you clicked appear, plus the always-available document action.

## When you right-click a...

### Text selection (any highlighted text)

| Action | Clipboard flavor | Pastes well into |
| --- | --- | --- |
| Copy Selection as Rich Text | `text/html` + `text/plain` | Word, Outlook, Gmail, Google Docs, Slack |
| Copy Selection as Markdown | `text/plain` (Markdown source) | Any editor, chat, another `.md` file |

### Code block

| Action | Clipboard flavor | Pastes well into |
| --- | --- | --- |
| Copy Code | `text/plain` (no styling) | Any editor or terminal |

The plain-text code is copied verbatim, without the syntax-highlight markup, so it drops straight into an editor.

### Table

| Action | Clipboard flavor | Pastes well into |
| --- | --- | --- |
| Copy Table (Rich Text) | `text/html` + `text/plain` | Word, Google Docs, Outlook |
| Copy Table as TSV | `text/plain` (tab-separated) | Excel, Google Sheets (as real cells) |
| Copy Table as PNG | `image/png` | Slides, chat, anywhere an image works |

### Mermaid diagram

| Action | Clipboard flavor | Pastes well into |
| --- | --- | --- |
| Copy Diagram as PNG | `image/png` | Slides, docs, chat |
| Copy Diagram as SVG | `text/plain` (SVG markup) | A file, vector editors, HTML |

### Any other block (paragraph, heading, list, blockquote)

| Action | Clipboard flavor | Pastes well into |
| --- | --- | --- |
| Copy Block as Rich Text | `text/html` + `text/plain` | Word, Outlook, Gmail, Google Docs |
| Copy Block as Markdown | `text/plain` (Markdown source) | Any editor, chat, another `.md` file |
| Copy Block as PNG | `image/png` | Slides, chat, docs |

### Always available

| Action | Clipboard flavor | Pastes well into |
| --- | --- | --- |
| Copy Whole Document as Rich Text | `text/html` + `text/plain` | Word, Outlook, Gmail, Google Docs |

The same whole-document action is available without the preview focused, via the Command Palette: **MarkCopy: Copy Whole Document as Rich Text**.

## Notes

- **Rich text always includes a plain-text fallback.** Every `text/html` write also sets `text/plain`, so a target that cannot take HTML still gets readable content.
- **Rich text is inline-styled.** Styles are baked into `style` attributes so formatting survives Gmail and Outlook, which discard `<style>` blocks and external CSS.
- **TSV, not CSV, for tables.** Tab-separated values paste as individual cells in Excel and Google Sheets more reliably than comma-separated values, which get confused by commas inside cells.
- **PNG copy needs clipboard image support.** It uses the async Clipboard API with a `ClipboardItem`. If the host blocks image writes you get a toast saying so, never a silent failure.
