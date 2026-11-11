# Markdown preview

A live, GitHub-accurate rendering of your Markdown, with light editing built in.

## Live preview and scroll sync

The preview updates as you type, with editor and preview scroll kept in sync.

## Auto-open

The preview opens automatically in the file's own tab by default (`markcopy.autoPreview`). See [Auto-preview](getting-started.md#auto-preview) for the details.

## GitHub-accurate styling

Styling is GitHub-accurate, for output that pastes cleanly into docs and email.

## Footnotes

`[^note]` references render as numbered links to their definitions, with return links back to the prose. A definition with no reference stays in place as plain text rather than disappearing. Toggle with `markcopy.footnotes` (on by default, turn it off for documents that use literal `[^...]` text).

## Light and dark themes

![The MarkCopy preview and copy menu in a dark VS Code theme](../media/context-menu-dark.png)

The preview follows your VS Code theme, with a polished GitHub-light or GitHub-dark palette, and copied rich text is always light-safe, so it stays readable when pasted into a white document even from a dark preview.

An optional **green-on-black** terminal palette is available too (`markcopy.theme: green`, or **Green on black** under **Preferences > Theme**):

![The green-on-black terminal theme rendering code, a table, and a blockquote](../media/terminal-green.png)

## Mermaid diagrams

Mermaid diagrams (flowchart, sequence, class, state, gantt, pie, and more) follow the light/dark theme, and syntax-highlighted code works out of the box. Configure Mermaid via `markcopy.mermaid`; diagrams keep the classic layout and look unless you set `"layout": "elk"` or `"look": "neo"`.

## Math rendering with KaTeX

Inline `$...$` and display `$$...$$` Markdown math render as equations. Right-click one to copy it as a PNG or restore its original LaTeX source; "Copy as Markdown" also restores the LaTeX rather than the rendered markup. Toggle with `markcopy.math` (on by default, turn it off for docs that use literal dollar signs).

![KaTeX equations and a Mermaid diagram rendered in the dark MarkCopy preview](../media/rendering-dark.png)

## Local images

Local images render in the preview. Relative and absolute paths (`![](media/x.png)`, `![](./diagram.png)`) resolve to the right file; remote (`http(s):`), `data:`, and `blob:` images are unchanged. The same goes for an image written as HTML, `<img src="docs/logo.png" width="200">`, which is how a README usually sizes one. An image that gives both a width and a height keeps its shape when a narrow pane shrinks it.

A display equation too long for the pane scrolls sideways inside its own box, like a wide table, instead of pushing the page out.

## Edit mode

Flip the lock/pencil pill in the top-right corner of a Markdown preview to edit the raw Markdown of a block in place: click a paragraph, heading, list, table, or quote, edit it in a box with light syntax dimming, and press Ctrl/Cmd+Enter or click away to write it back to the file (Escape cancels). It also works from the keyboard: Tab to a block, then Enter or F2 to edit it. It is an ordinary undoable editor change and the file is not saved for you.

![Edit mode in the MarkCopy preview: one paragraph open in the block editor, with the ** markers around bold text dimmed](../media/edit-mode.png)

![The same edit mode in a dark VS Code theme](../media/edit-mode-dark.png)

## Search Google for a selection

Select some text and right-click for **Search Google for "…"**, which opens the search in your browser.

[Back to the user guide](README.md)
