# MarkCopy — Rich Markdown Preview

A next-level Markdown preview for VS Code built around **copying content out**. Right-click anywhere in the rendered preview to copy it in the format you actually need — rich text that pastes *with formatting* into Word, Outlook, Gmail and Google Docs, per-element copies, raw Markdown, or a PNG image.

The built-in preview and the big incumbents (Markdown Preview Enhanced, Markdown All-in-One) don't do first-class "copy the rendered output as rich text." MarkCopy does.

## Features

- **Copy as Rich Text** — whole document or selection. Styles are inlined so formatting survives Gmail/Outlook (which strip `<style>` and external CSS).
- **Per-element right-click copy**:
  - Code block → **Copy Code** (plain text)
  - Table → **Rich Text**, **TSV** (pastes as real cells in Excel/Sheets), or **PNG**
  - Mermaid diagram → **PNG** or **SVG**
  - Any block → **Rich Text**, **Markdown source**, or **PNG**
- **Copy as raw Markdown** for a selection or a single block.
- **Live preview** that updates as you type, with editor ⇄ preview scroll sync.
- **GitHub-accurate styling** (default) or a VS Code theme profile.
- Mermaid diagrams and syntax-highlighted code out of the box.

## Usage

- Open a `.md` file and run **MarkCopy: Open Rich Preview to the Side** (command palette, editor title bar icon, or right-click in the editor / explorer).
- **Right-click** inside the preview for the context menu; the options adapt to what you clicked (code, table, diagram, block, or selection).
- **MarkCopy: Copy Whole Document as Rich Text** copies everything in one shot.

## How copying works (the technical bit)

`vscode.env.clipboard` is text-only, so rich copy happens **inside the webview**. MarkCopy writes both `text/html` and `text/plain` clipboard flavors via a synchronous `copy`-event handler (more reliable than the async Clipboard API, which can be permission-blocked in the webview iframe). PNG copy uses `html-to-image` + `ClipboardItem`.

## Develop

```bash
npm install
npm run compile        # type-check + build extension and webview bundles
npm run watch          # rebuild on change
# then press F5 in VS Code to launch the Extension Development Host
npm run vsix           # produce markcopy-0.0.1.vsix
code --install-extension markcopy-0.0.1.vsix
```

## Roadmap

- KaTeX / LaTeX math (render + copy as image)
- PlantUML support
- "Email-safe" export profile (table-based layout, fully inlined)
- Copy selection spanning multiple blocks as clean Markdown

## License

MIT
