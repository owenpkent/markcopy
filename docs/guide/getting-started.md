# Getting started

Install MarkCopy, open a file, and right-click the preview.

## Install

**From the Marketplace** (published as [`OwenPKent.markcopy`](https://marketplace.visualstudio.com/items?itemName=OwenPKent.markcopy)):

- In VS Code: open the Extensions view, search **MarkCopy**, and click Install.
- Or from a terminal: `code --install-extension OwenPKent.markcopy`

It is also available on [Open VSX](https://open-vsx.org/extension/OwenPKent/markcopy) for Cursor, VSCodium, and Windsurf.

**From the packaged VSIX** (local build):

```bash
npm ci
npm run vsix                                   # produces markcopy-<version>.vsix
code --install-extension markcopy-<version>.vsix
```

See [RELEASING.md](../RELEASING.md) for how releases are cut and published.

## Getting started

1. Install the extension (see [Install](#install)).
2. Open any `.md`, `.csv`, `.tsv`, or `.tab` file. Its tab shows the rendered preview (`markcopy.autoPreview`), and **Show Source** in the title bar swaps back to the text. For the two-column layout instead, run **MarkCopy: Open Rich Preview to the Side** from the Command Palette or the right-click menu in the editor or Explorer. (`.pdf`, `.stl`, and video files open straight in their own viewers. A `.tex` file is different again: it is a file you also edit, and its preview is a compiled PDF, so the source stays in the text editor and the preview opens beside it rather than over it. See [LaTeX preview](documents.md#latex-preview).)
3. **Right-click inside the preview.** The menu options change based on whether you clicked a code block, table, diagram, plain block, or a text selection.

To grab everything at once, run **MarkCopy: Copy Whole Document as Rich Text**, or **MarkCopy: Save as PDF** to export the whole preview to a PDF file.

Local images in the document render automatically, and the right-click menu's **Preferences** submenu (or the gear icon in the preview's title bar) lets you change theme, sync scroll, math, and auto-preview without leaving the preview.

## Show Preview and Show Source

**The tab swaps between the two views; it never splits.** Two buttons share the leftmost slot in the editor title bar: **Show Preview** (`$(open-preview)`) turns a `.md`, `.csv` or `.tsv` tab into the rendered document, and **Show Source** (`$(go-to-file)`) turns it back. Only one of them shows at a time, so it reads as one toggle. Neither opens a second editor group, and neither leaves you with two tabs on one file. A tab you have pinned, or a source with unsaved changes, is left open rather than closed.

## Auto-preview

Auto-preview is on by default (`markcopy.autoPreview`). Opening or focusing a Markdown, CSV, TSV, or TAB file shows the rendered document in that file's own tab: one tab, one editor group, nothing split off to the side. **Show Source** in the title bar gets you back to the text, and keeps you there for that file. A tab you have pinned, or one with unsaved changes, stays in the text editor untouched. LaTeX is the exception, and opens beside its source rather than over it. Turn the setting off and the preview is still a click away on the **Show Preview** button, or a **MarkCopy: Open Rich Preview to the Side** away if you want the two-column layout.

## Side-by-side preview

For the two-column layout, run **MarkCopy: Open Rich Preview to the Side**: that command opens the preview beside the source and retargets it as you move between files.

It is the same preview either way, with the same right-click menu, the same **Save as PDF** and settings buttons, and the same editable CSV grid, and it keeps re-rendering as you edit the file in any other editor.

## Editor associations

MarkCopy does not change what VS Code's _file association_ opens; the swap above is the extension acting after the fact, and turning `markcopy.autoPreview` off stops it. To change the association itself, **Reopen Editor With...** > **Set Default for '\*.md'** in the editor title menu does it per glob, or `settings.json`:

```json
{
  "workbench.editorAssociations": { "*.md": "markcopy.markdownPreview" }
}
```

[Back to the user guide](README.md)
