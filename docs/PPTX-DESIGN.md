# PowerPoint support

Two features that share a format and almost nothing else: a **preview** that reads
a `.pptx` into the existing preview surface, and a **Save as PowerPoint** export
that writes one out of the rendered Markdown. This file records the decisions, so
the two halves agree on the parts they do share.

## Shared container

`src/ooxml/` holds what every OOXML format needs and no format owns: `zip.ts`
(the guarded OPC unpacker), `xml.ts` (the saxes pull parser), `rels.ts`
(relationship parts). It was lifted out of `src/xlsx/` when the deck reader
arrived; `src/docx/parse.ts` had already been reaching across into it, which was
the signal it belonged somewhere neutral.

`OpcError` is the one refusal type. Each feature re-exports it under the noun its
own callers use (`WorkbookError`, `DeckError`), so `err instanceof` at the top of
a preview reads naturally. `openZip` takes that noun so its messages say
"presentation" where a deck is what failed.

## Preview: `src/pptx/read/`

| Module      | Responsibility                                                      |
| ----------- | ------------------------------------------------------------------- |
| `deck.ts`   | `presentation.xml`: slide size in EMU, the slide order, notes parts |
| `theme.ts`  | `theme1.xml`: the twelve-colour scheme and the major/minor fonts    |
| `layout.ts` | placeholder inheritance, slide -> layout -> master                  |
| `shape.ts`  | the `p:spTree` walk: `p:sp`, `p:pic`, `p:graphicFrame`, `p:grpSp`   |
| `text.ts`   | `p:txBody` -> paragraphs, runs, bullets                             |
| `render.ts` | the shape model -> HTML                                             |
| `index.ts`  | `renderDeckHtml(bytes, opts)`, the only entry point                 |

Free of the `vscode` module throughout, like `src/xlsx` and `src/csv.ts`, so the
whole fidelity surface unit-tests without a webview.

### Every slide at once, not one at a time

A workbook shows one sheet and a tab strip, because a sheet is a working surface
you point at. A deck is a document you read end to end, and the whole point of
this extension is getting content _out_: rendering the deck as one scrollable
column means Copy as Rich Text, Save as PDF and Save as Word all take the whole
deck in one go, rather than whichever slide happened to be on screen.
`markcopy.pptx.maxSlides` caps it.

### Two coordinate systems, no JavaScript

DrawingML positions shapes absolutely, in EMU (914400 per inch, 12700 per point),
against a slide of a size the presentation declares. The preview has to scale
that to whatever width the panel happens to be, and has to do it without script:
this HTML is also what `html-to-image` rasterizes for Copy as PNG and what
headless Chrome prints for Save as PDF, so a layout that needs a resize handler
to be correct is a layout that exports wrong.

So: positions and sizes are emitted as **percentages** of the slide box, which are
exact under any scale, and font sizes in **`cqw`** against a `container-type:
inline-size` slide, which makes text scale with the box. One multiplication per
value, no measurement, nothing to re-run on resize.

### DOM order is reading order

Shapes are emitted title first, then body placeholders, then everything else top
to bottom and left to right, regardless of where they sit on the slide. Absolute
positioning is what the eye follows; DOM order is what a copy, a screen reader,
and a Word export follow, and those must not get the z-order the file happened to
be saved in.

For the same reason the elements are **semantic** and only incidentally
positioned: a title placeholder is an `<h2>`, body text is `<p>` or `<ul>`, a
`a:tbl` is a real `<table>`, a picture is an `<img>` carrying its shape
description as alt text. Word paste and Save as Word drop the absolute
positioning and are left with a readable document, which is the whole bargain.

Each slide carries `data-source-line="<index>"`, which is what
`src/webview/main.ts` keys the per-block copy menu off. There is no TextDocument
behind a deck, so the panel reports `supportsSync: false` and the attribute only
ever feeds the menu.

### What it will not draw

Charts, SmartArt, OLE objects, embedded media, transitions and animations. Each
becomes a labelled placeholder box naming what it is, never a blank. A deck is
mostly text and pictures and those are drawn properly; pretending to render a
chart would be worse than admitting there is one.

## Export: `src/pptx/write/`

Mirrors `src/docx/`: the webview serializes the rendered preview to XHTML,
`src/ooxml/xhtml.ts` turns it into a node tree, and everything after that is
testable and `vscode`-free. `build.ts` produces slide XML, `package.ts` zips the
package with `zipSync`, and `src/pptxExport.ts` is the seam the command calls.

### What becomes a slide

A slide boundary is a thematic break (`---`) **or** an `<h1>`/`<h2>`, which
then becomes the slide's title. Content before the first boundary is its own
slide: a title slide when it is only a heading, an ordinary one otherwise.
Consecutive boundaries do not mint empty slides.

Both, rather than one falling back to the other. The first draft made `---`
take precedence and fell back to headings only when the document had none, on
the reasoning that an author who writes `---` means it. What that missed is that
the author is not the only one writing them: markdown-it-footnote emits an
`<hr class="footnotes-sep">` above the footnote list, so a single footnote
anywhere in a document turned a six-heading file into a two-slide deck. A rule
that a stray `<hr>` can silently collapse is the wrong rule, and taking both
boundaries costs almost nothing: a deck written for Marp splits identically
either way, because its headings already sit one to a section.

Overflow is not repaginated. A slide whose content does not fit is the author's
to fix, and silently splitting one into two would scramble a deliberate build.

## Settings

| Key                       | Default | Meaning                                   |
| ------------------------- | ------- | ----------------------------------------- |
| `markcopy.pptx.maxSlides` | 100     | How many slides to render before stopping |
| `markcopy.pptx.showNotes` | `true`  | Show speaker notes under each slide       |
| `markcopy.pptx.slideSize` | `16:9`  | Slide size for the export (`16:9`, `4:3`) |
