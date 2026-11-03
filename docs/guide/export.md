# Export

Save the rendered preview as a PDF, Word document, or PowerPoint deck without leaving the editor.

## Save as PDF

**MarkCopy: Save as PDF** (or the PDF button in the preview's title bar, or **Save as PDF…** in the right-click menu) asks where to save, writes the file, and opens it. What comes out is the preview as you see it: equations, diagrams, highlighted code, and local images intact, and real text rather than a picture of text, so it stays selectable and searchable.

It renders with a headless Chrome, Edge, or Chromium already installed on your machine instead of handing you to a browser's print dialog, which is what keeps the output clean:

- **No header or footer.** A print dialog stamps the document title across the top of every page and the `file://` URL across the bottom by default. Nothing does that here.
- **No stray page breaks.** A code block or table longer than a page flows across pages instead of being pushed onto one of its own, a table's header row repeats on every page it spans, and long code lines wrap instead of being cut off at the margin.
- **Backgrounds survive.** Code blocks, table headers, and blockquotes keep their fill, which a browser print drops unless you remember to ask for it.

`markcopy.pdf.pageSize` sets the paper size (Letter, A4, or Legal). If your browser is installed somewhere unusual, point `markcopy.pdf.browserPath` at it. With no Chromium-family browser installed at all, MarkCopy falls back to opening the preview in your default browser for you to print by hand.

## Save as Word

**MarkCopy: Save as Word Document** (or **Save as Word…** in the preview's right-click menu) asks where to save, writes a `.docx`, and opens it.

This is the export to reach for when the document has to be **read aloud** (Read Aloud, Immersive Reader, or a screen reader), or edited after it lands. A PDF keeps the layout and the images and nothing else: it is a picture of a page, and a screen reader has to infer the reading order from where the ink fell. A `.docx` keeps the structure, and structure is what assistive software actually reads:

- **Headings are Word headings.** `#` through `######` become the built-in Heading 1-6 styles, which carry an outline level. That is what fills the Navigation Pane and what lets a screen reader jump from section to section instead of arrowing through the prose.
- **Tables declare their header row.** The header row is marked as one, so a reader hears "Revenue, 4.2m" rather than "4.2m", and Word repeats it across page breaks.
- **Images carry their alt text.** `![A chart of revenue by region](chart.png)` arrives with that sentence attached, which is what Read Aloud speaks and what the Accessibility Checker looks for, provided the source includes meaningful alt text.
- **Lists are lists**, numbered by Word rather than by a bullet character typed into the text, so each one is announced with its position and count. Separate numbered lists restart at 1, and `4.` starts at four.
- **Links keep their targets**, and a link to a heading in the same document lands on that heading.

Mermaid diagrams and equations have no Word equivalent, so they are rasterized. Their **alt text is the source they came from**: a flowchart reads aloud as its Mermaid source and an equation as its LaTeX, which is a good deal better than silence. Code blocks keep their syntax colors and become one paragraph per line, so a reader can step through them a line at a time.

**Alt text is the one thing MarkCopy cannot supply for you.** `![](chart.png)` with an empty alt is the norm in Markdown, and it is exactly what makes a document stop being audible. So the export counts them and tells you: _"exported report.docx, but 3 images without alt text (a screen reader will skip past them)."_ Fix them in the Markdown and export again.

Everything is written in memory and needs nothing installed: no Word, no Pandoc, no browser. The same export works from the CSV, TSV, Excel, and PowerPoint previews, where a sheet becomes a Word table with its header row marked and a deck becomes one section per slide.

## Save as PowerPoint

**MarkCopy: Save as PowerPoint** (or **Save as PowerPoint…** in the preview's right-click menu) asks where to save, writes a `.pptx`, and opens it.

Like [Save as Word](#save-as-word) and unlike Save as PDF, what lands is a real, editable deck rather than a picture of one:

- **Headings become slide titles, and slides split where they should.** A thematic break (`---`) or an `<h1>` / `<h2>` starts a new slide, and a heading right after either becomes that slide's title. Content before the first boundary is its own slide, a title slide when it is only a heading. A deck written for a tool like Marp splits the same way, since its headings already sit one to a section.
- **Lists are bulleted paragraphs at their real indent levels**, not a picture of bullets.
- **Tables become PowerPoint tables**, with a marked header row.
- **Images carry their alt text**, as the shape's own description.
- **Links stay clickable.**

Mermaid diagrams and equations have no PowerPoint equivalent any more than they have a Word one, so they are rasterized the same way. **Overflow is not repaginated**: a slide whose content runs past the bottom edge is left overflowing rather than silently split into two, since splitting one would scramble a deliberate build. The export counts what is worth knowing (images with no alt text, images it could not embed, slides that likely ran over) and reports it after saving, the same way Save as Word reports missing alt text.

Everything is written in memory and needs nothing installed: no PowerPoint, no Pandoc, no browser. The same export works from the Markdown, CSV, TSV, and Excel previews too, not just the PowerPoint preview. `markcopy.pptx.slideSize` sets the slide size (`16:9` default, or `4:3`); it has no effect on previewing an existing deck, which always shows at the size the file declares.

[Back to the user guide](README.md)
