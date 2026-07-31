# XLSX preview: design note

Research for adding `.xlsx` preview to MarkCopy. Written before implementation, on
`feat/xlsx-preview`. Nothing here is built yet.

## Verdict

Build it. Register a `CustomReadonlyEditorProvider` for `*.xlsx` / `*.xlsm` that points its
webview at the **existing** `media/webview.js` bundle and `htmlShell()`, parse host-side with a
small in-house OOXML reader, and emit **exactly the CSV grid markup** so a sheet inherits the
context menu, Copy as Rich Text / CSV / TSV / PNG, column resize, the four themes, and Save as
PDF with almost no new webview code.

Read-only, one sheet at a time behind a tab strip, with number formats and hidden rows correct
from day one. Roughly 8 to 10 focused days.

## The key constraint

`.xlsx` is binary, so it never becomes a `vscode.TextDocument`, and every load-bearing mechanism
in the preview pipeline is TextDocument-shaped:

| Mechanism       | Where                     | Why it does not reach                                                       |
| --------------- | ------------------------- | --------------------------------------------------------------------------- |
| `update()`      | `extension.ts:314-320`    | looks the doc up in `workspace.textDocuments`, renders from `doc.getText()` |
| live updates    | `onDidChangeTextDocument` | never fires for a binary file                                               |
| `previewKind()` | `preview-utils.ts`        | keys off `languageId`                                                       |
| cell writeback  | `csvEdit.ts`              | applies a `WorkspaceEdit` over byte offsets                                 |
| scroll sync     | `scrollSync.ts`           | pairs source lines to pixels, `revealLine` needs a visible text editor      |

`contributes.customEditors` plus `workspace.fs.readFile` is the only route. The PDF viewer
(`src/pdfEditor.ts`) is the existing precedent.

The second-order constraint decides the library: `dist/extension.js` is a single non-split cjs
`outfile` fully evaluated at activation (`esbuild.js:8-19`), and `await import()` does not help
because esbuild inlines it. A host-side parser is therefore a permanent activation tax on every
Markdown user. **The library choice and the parse location are one decision, not two.**

## Library decision

Measured on this machine, bundled with the repo's own esbuild (`--platform=node --minify`):

| Package                         | Version | License    | Minified    | Gzipped    |
| ------------------------------- | ------- | ---------- | ----------- | ---------- |
| fflate                          | 0.8.3   | MIT        | 33,299      |            |
| saxes                           | 6.0.0   | ISC        | 28,868      |            |
| numfmt                          | 3.2.6   | MIT        | 75,135      |            |
| **the three bundled together**  |         |            | **102,659** | **31,935** |
| fflate + saxes + ssf (fallback) | 0.11.2  | Apache-2.0 | 59,050      | 18,632     |

Against a production `dist/extension.js` of 1,529,237 bytes, the reader costs **+6.7%**. That is
affordable. SheetJS at 362 KB would not have been, and would have forced parsing into the
webview, breaking the `host renders HTML, webview stays document-agnostic` invariant
(`ARCHITECTURE.md:20-25`) and forfeiting exactly the copy/theme/PDF inheritance this feature
exists to get.

### Why not an off-the-shelf workbook library

- **`read-excel-file@9.3.5`** (MIT, 54 KB) exposes no hidden-row/hidden-sheet flag and no number
  format codes, so a percent cell renders `0.15` where Excel shows `15%`. Both are correctness
  bugs, not polish. Recovering formats needs the cell's `@s` style index, which the library never
  surfaces at any level, so the workaround means re-parsing every `<c>` element anyway. At that
  point the reader is written and the dependency is redundant weight.
- **SheetJS `xlsx`** is rejected on distribution and architecture, not on the CVEs. npm still
  serves 0.18.5 from 2022; current builds come from `cdn.sheetjs.com`, which means a vendored
  tarball committed to the repo and invisible to Dependabot. Its `sheet_to_html` also emits the
  rich-text `.h` field raw and builds `<a href>` with no scheme validation.
- **`exceljs@4.4.0`** is the only off-the-shelf full-fidelity option: 271 KB gzipped, 23 MB
  installed, no real release since 2023-10-19.
- **`node-xlsx`** is SheetJS behind a CDN URL.

### numfmt is verified, not assumed

`numfmt@3.2.6` exports `format`, `isDateFormat`, `isPercentFormat`, `getFormatInfo`,
`getFormatDateInfo`, `dateFromSerial`, `dateToSerial`, `tokenize`, and more, as **named** exports
(there is no default export). It was tested directly against the traps that previews classically
fail, and passed all of them:

| Case                       | Input                             | Result                      |
| -------------------------- | --------------------------------- | --------------------------- |
| 1900 phantom leap day      | `format('yyyy-mm-dd', 60)`        | `1900-02-29`                |
| neighbours intact          | serial 59 / 61                    | `1900-02-28` / `1900-03-01` |
| date-ness from the CODE    | `isDateFormat('[h]:mm:ss')`       | `true`                      |
| not a date                 | `isDateFormat('0.00%')`           | `false`                     |
| elapsed time               | `format('[h]:mm:ss', 1.5)`        | `36:00:00`                  |
| clock time                 | `format('h:mm:ss', 1.5)`          | `12:00:00`                  |
| fractional-second rounding | `format('h:mm:ss', 0.5416666666)` | `13:00:00`                  |
| percent                    | `format('0.00%', 0.15)`           | `15.00%`                    |
| negative section           | `format('#,##0;(#,##0)', -1234)`  | `(1,234)`                   |

`dateFromSerial(60)` returns the plain array `[1900, 2, 29, 0, 0, 0]`, which sidesteps the
local-timezone `Date` construction bug entirely: there is no `Date` object to shift.

Fallback if numfmt ever becomes a problem: `ssf@0.11.2` (Apache-2.0, stale, SheetJS-authored,
saves 44 KB). Second fallback: hand-roll the subset that matters (dates/times, percent, thousands
separators, currency affixes, the negative section, `@` passthrough) and fall back to the raw
value for everything else.

## Recommended design

**Registration.** `src/xlsxEditor.ts` exporting `XlsxEditorProvider` with
`static readonly viewType = 'markcopy.xlsxPreview'`, modeled on `src/pdfEditor.ts:6-85`,
registered beside `PdfEditorProvider` at `extension.ts:44-53` with
`retainContextWhenHidden: true`. A `contributes.customEditors` entry with selectors `*.xlsx` and
`*.xlsm`. **No `activationEvents` entry** (VS Code auto-generates `onCustomEditor:`, which is why
the PDF viewer has none) and **nothing in `contributes.languages`**, which is text-document-only.

**The bet:** the provider ships no webview bundle of its own. It sets
`webview.html = htmlShell(context, webview, 'markcopy.xlsxPreview')` and loads
`media/webview.js`. This is viable because `src/webview/main.ts:955` already posts
`{type:'ready'}` from module scope, and `htmlShell()` (`extension.ts:555-596`) carries
`script-src 'nonce-...' 'strict-dynamic'`, which is what the code-split `media/chunk-*.js`
siblings require. A PDF-style bare-nonce CSP would silently fail every chunk import.

So: no `src/webview/xlsx.ts`, no new `esbuild.web.js` entry. `src/webview/pdf.ts` is 1021 lines
precisely because this reuse was not attempted. Do not write the third copy of the copy menu.

**Parsing runs on the extension host**, in `vscode`-free modules under `src/xlsx/`. The whole
fidelity surface (serial-to-date math, format-code tokenizing, merge geometry, column-width
conversion) is pure arithmetic over strings, which is where the bugs will live and where vitest
can reach them with no jsdom and no bundle. The host already has the bytes, so we skip
`pdfEditor.ts`'s base64 push (roughly 3x peak memory, synchronous `atob`). Zip-bomb and
entry-count caps are enforceable before a byte crosses `postMessage`.

**Boundary shape: an HTML string on the existing `render` message.** Nothing else.

```
{ type:'render', kind:'xlsx', html, source:'', docKey: uri.toString(),
  docVersion:-1, syncScroll:false, theme, styleProfile, mermaidConfig:{}, math:false }
```

`syncScroll:false` is load-bearing: `main.ts:446` gates every outbound `revealLine` on
`currentSyncScroll`, so passing `false` cleanly disables preview-to-editor sync for a document
with no editor to reveal into, with zero code change. Do not emit `data-source-line` on sheet
rows. Webview to host, exactly one new message: `{type:'selectSheet', index}`.

**Markup contract: emit the CSV grid verbatim.** `div.mc-csv-wrap` > `table.mc-csv`, a
`<colgroup>` with the leading gutter `<col>` plus one per column, `th.mc-csv-gutter` with
`data-mc-ignore="1"` per row, and the truncation `p.mc-csv-note` outside the table. That is what
makes `tableToDelimited` copy verbatim (`table.ts:13`), `enhanceCsvTables` attach resize grips
(`csvTable.ts:19`), and `.mc-force-light table.mc-csv` restore zebra striping in copies
(`preview.css:502`). Getting the colgroup count wrong disables column resizing **silently, with
no error** (`csvTable.ts:44-57`). If a merge lands in the header row, omit the colgroup entirely
and lose resizing for that sheet rather than emit a mismatched one.

**Read-only must be structural, not a condition in `main.ts`.** `src/csv.ts` emits
`data-mc-editable="1"` on its table, and `src/webview/csvEdit.ts:28` narrows its selector from
`table.mc-csv` to `table.mc-csv[data-mc-editable="1"]`. Two lines, and the guarantee lives in the
markup where a future refactor cannot quietly delete it.

**Reused unchanged:** `menu.ts`, `table.ts`, `markdownConvert.ts`, `csvTable.ts`,
`settingsScope.ts`, `pdfExport.ts`, the whole `media/preview.css` grid block, DOMPurify, the
theme palettes.

## Implementation plan

### PR 1: plumbing, behavior-preserving, no xlsx code (about 1 day)

Land first, with `npm test`, the integration suite, and a manual F5 pass on `sample.md` and
`sample.csv` all green, before any parser exists.

1. `src/previewShell.ts` (new): move `htmlShell()` (`extension.ts:555-596`) and `getNonce()`
   (`extension.ts:797-804`) here, parameterizing the `data-vscode-context` `webviewId` at line 589. Delete the verbatim `getNonce` duplicate at `pdfEditor.ts:149-156`.
2. Decouple PDF export from `PreviewState`. `runExport` touches `state` only at
   `extension.ts:636` (basename) and `:645` (`defaultPdfUri`). Change to
   `exportPdf(context, docUri, bodyHtml)` and update the single call site at `extension.ts:254`.
   Add `xlsx|xlsm` to the filename-strip regex at `:636` or exports are named `book.xlsx.pdf`.
3. Fix an existing bug: `main.ts:794-798` clones `#content` for PDF export and strips
   `data-source-line` but not `[data-mc-ignore]`, so the CSV row-number gutter prints into every
   PDF today. Without this our sheet tab strip would print too.
4. `src/csv.ts` emits `data-mc-editable="1"`; `csvEdit.ts:28` selector narrows to match.
5. Widen `scroller()` at `main.ts:278-282` (hardcoded `=== 'csv'`) to accept `'xlsx'`, or
   `scrollTop` / `maxScroll` silently measure the window.

### PR 2: the v1 feature (about 7 to 9 days). This is the v1 cut line.

6. `src/xlsx/zip.ts`: fflate `unzipSync` with hard caps enforced **before** any XML is touched
   (max entries, max per-entry uncompressed, max total, plus a raw file-size refusal around
   25 MB with a readable message). Never write to disk. Refuse every `TargetMode="External"`
   relationship: `externalLinks`, DDE/OLE links, and remote images are SSRF and NTLM-leak
   vectors.
7. `src/xlsx/opc.ts` and `workbook.ts`: resolve `[Content_Types].xml` and `_rels/.rels` to the
   `officeDocument` relationship (never hardcode `xl/workbook.xml`). Read
   `<sheet name state r:id>` mapped through `xl/_rels/workbook.xml.rels` (`sheetId` identifies
   nothing), `workbookPr/@date1904`, and `sharedStrings.xml` concatenating `<t>` across `<r>`
   runs while **excluding `<rPh>` phonetic runs**, or Japanese cells duplicate.
8. `src/xlsx/styles.ts`: resolve cell `@s` (default 0) through **`cellXfs`** (not
   `cellStyleXfs`) to `@numFmtId`, then to a `<numFmts>` code or the builtin table. Decide
   date-ness from the **code**, via `numfmt.isDateFormat`, never from the id. The widespread
   "numFmtId 14-22 or 165-180 means date" heuristic is wrong in both directions: it misses
   builtins 45/46/47 and the 27-36 / 50-58 East Asian blocks, and 164+ means whatever the file
   says.
9. `src/xlsx/sheet.ts`: saxes pull-parse into a bounded row stream. `t` defaults to `n`;
   `t="s"` indexes the shared string table but **`t="str"` IS the string** (the classic bug);
   `<f>` with a sibling `<v>` displays the cached `<v>` and never evaluates; `<f>` with no `<v>`
   (openpyxl / xlsxwriter output) gets a visible affordance, not a silent blank. The same pass
   captures `<cols>` `@min`/`@max` (inclusive ranges), `row/@ht` and `@hidden`, `<mergeCells>`,
   and `pane/@state="frozen"`. Enforce `maxRows` / `maxColumns` during the parse plus a time
   budget, and return a partial sheet with a truncation flag rather than hanging.
10. `src/xlsx/render.ts`: mirror `src/csv.ts:339-413` exactly, plus a
    `<nav class="mc-xlsx-tabs" data-mc-ignore="1">` strip of `<button data-mc-sheet="N">` (both
    survive DOMPurify defaults). Merges become `colspan`/`rowspan` with covered cells omitted.
    Column widths inline on `<col>` as `px = round(width * 7) + 5`. Hyperlinks scheme-allowlisted
    to http/https/mailto. Escape everything.
11. `src/xlsxEditor.ts`: bytes via `workspace.fs.readFile`, parse, post `render`. Register
    `onDidReceiveMessage` **before** assigning `webview.html` (`pdfEditor.ts:39` gets away with
    the reverse only because both run in one synchronous turn). Handle `pdfHtml`,
    `updateSetting`, and `selectSheet`. Register a `FileSystemWatcher` and re-render on external
    change, closing the stale-forever hole the PDF viewer has. Push the message listener onto a
    disposable released on `panel.onDidDispose`.
12. `src/preview-utils.ts`: widen `PreviewKind` to `'markdown' | 'csv' | 'xlsx'` and nothing
    else. Do not touch `PREVIEW_LANGUAGES` or the extension regex in `previewKind()`: an `.xlsx`
    never becomes a TextDocument, so the entry would be dead code that puts a binary zip one
    missing switch arm away from `md.render()` via the `?? 'markdown'` default at
    `extension.ts:330`.
13. `media/preview.css`: widen the two `body[data-mc-kind='csv']` rules at `:184` and `:191` to
    also match `'xlsx'`. Add about 30 lines for the tab strip (`flex: 0 0 auto` above the
    viewport-tall scroller), hidden-row de-emphasis, and the not-calculated marker. Verify all
    four `markcopy.theme` values including green.
14. `package.json`: the `customEditors` entry; settings `markcopy.xlsx.maxRows` (5000),
    `markcopy.xlsx.maxColumns` (200), `markcopy.xlsx.showFormulas` (false). Deliberately no
    `markcopy.xlsx.headerRow`: the file says whether it has one. Update `displayName` and
    `description` (currently "Rich Markdown, CSV & PDF Preview"), categories, keywords. Add
    `fflate`, `saxes`, `numfmt` to `dependencies`.
15. Tests: vitest against `src/xlsx/*` with golden fixtures built by **real Excel**, not a writer
    library. Serials 1/59/60/61, a 1904 file, `[h]:mm:ss`, Japanese furigana, `t="str"` vs
    `t="s"`, `<f>` with no `<v>`, merges, hidden rows and a hidden sheet, plus a zip bomb and a
    billion-laughs file as negative tests that must fail cleanly. A jsdom test that builds
    `document.body.innerHTML` from the real `renderXlsxHtml()` and runs `enhanceCsvTables()`
    against it (pattern from `tests/csvTable.test.ts:10-45`), asserting colgroup count equals
    grip-row cell count, no `data-mc-editable`, and that a `javascript:` href does not survive.
16. Docs: `ARCHITECTURE.md` file-map rows plus a `## XLSX preview` section and `selectSheet` in
    the protocol table; `COPY-MATRIX.md` sheet section plus an explicit note that Copy Whole
    Document and Save as PDF cover the **active sheet only**; `TESTING.md` checklist and
    `sample.xlsx`; README title, lead, alternatives table, features, settings rows, and light and
    dark screenshots via `npm run screenshot`; `CHANGELOG.md` under `[Unreleased]`.

### Follow-ups, not v1

- Title-bar buttons: `activeWebviewPanelId` does not match custom editors, so this needs
  `|| activeCustomEditorId == markcopy.xlsxPreview` at `package.json:116/121` plus a module-global
  `activeXlsx` tracked via `onDidChangeViewState`. v1 uses the in-webview right-click menu,
  exactly as the PDF viewer does today.
- `styles.xml` fidelity: fonts, solid fills, borders, theme and tint colors, as deduplicated CSS
  classes.
- A `Markdown` entry in the table CopyGroup (`main.ts:515-525`), which fills the ecosystem gap
  nobody occupies and improves Markdown tables too.
- `colspan`/`rowspan` handling in `tableToDelimited` (`table.ts:14-23` has none, so a merge shears
  every column to its right in copied CSV).

## What v1 deliberately skips

- **Editing and any write path.** The CSV grid's "the document is the only state" model does not
  transfer to a binary zip, and `CustomEditorProvider` would need `onDidChangeCustomDocument`,
  save, saveAs, revert, and backup, none of which exists here to copy. Every editable competitor's
  loudest bugs are silent data loss on save. Refusing to write is a feature, and should be stated
  in the README.
- **Fonts, fills, borders, theme and tint colors.** The single largest cut, and what takes this
  from about 9 days to about 20.
- **Formula evaluation.** Cached `<v>` only, always.
- Charts, drawings, images, shapes, pivot tables, slicers, sparklines, data validation,
  conditional formatting, comments.
- Sort/filter UI and in-grid find. Autofilter results come free as `row @hidden`.
- Scroll sync in either direction, split (non-frozen) panes, print areas.
- `.xls` (BIFF8/OLE2 plus live XLM macro malware risk), `.xlsb`, `.ods`, encrypted workbooks,
  `vbaProject.bin` in any form.
- **Multiple sheets rendered at once.** `scroller()` takes the first `.mc-csv-wrap` and
  `csvEdit.ts:38` takes `tables[0]`, so one-at-a-time keeps both intact and matches every
  competitor's tab UX.

## Risks

- **Memory, not bundle size, is the failure mode.** A 10 MB xlsx inflates to 200-500 MB of XML.
  saxes plus caps enforced during the parse is the mitigation, and it must be in from step 9. The
  webview half stays unhandled: `#content.innerHTML` is replaced wholesale with no virtualization,
  and `retainContextWhenHidden` keeps it resident. `maxRows: 5000` is a cap, not a fix. Test a
  500k-row file before merging.
- **`.mc-force-light` will flatten workbook colors** whenever the v2 styling work happens.
  `preview.css:487-492` sets `color` and `background-color: transparent` with `!important` on
  `.mc-force-light *`, and that class is applied during rich-text copy (`main.ts:909`), PNG
  capture (`main.ts:767`), and PDF export (`pdfExport.ts:269`), which are precisely the three
  outputs styling exists to improve. The fix is to emit colors as custom properties on style
  classes, then add a rule that outranks `.mc-force-light *`. Not a v1 problem, but it must be
  designed in before styling starts.
- **Sheets written without `r="A1"` attributes** are legal OOXML and crash both
  `read-excel-file` and ExcelJS. Ours will too unless it tracks implicit position. Wrap the parse
  in try/catch and degrade to a readable error, never a blank panel.
- **openpyxl and xlsxwriter files carry `<f>` with no cached `<v>`.** Those cells render blank and
  will be reported as data loss within a week of release. They need a visible affordance and a
  README line.
- **Nothing in this repo has driven `media/webview.js` from a custom editor.** Two traps are known
  and handled (handshake ordering, the `syncScroll` gate), but there may be others. **Spike step
  11 first** with a hardcoded 2x2 table and confirm the grid, right-click menu, and Save as PDF
  all work before writing a line of parser.

## Open questions for the repo owner

1. **`priority: "default"` or `"option"`?** Default hijacks `.xlsx` for everyone who installed
   MarkCopy for Markdown. Leaning default (VS Code ships no competing handler, and MarkCopy
   already claims `.pdf` at default), but it is a product call.
2. **Formula injection on the copy-out path.** Fields beginning with `=`, `+`, `-`, `@`, TAB, or
   CR are emitted verbatim by `escapeField` (`table.ts:26-35`) **today**, for CSV, independent of
   this feature. Spreadsheets are full of formulas, so xlsx raises the stakes. Fix now as its own
   PR, or accept and document? A `markcopy.copy.neutralizeFormulas` setting is the middle path.
3. **Should hidden rows and hidden sheets ever be revealable?** Hiding them by default is clearly
   right. A toggle is cheap but needs a call on whether MarkCopy is a viewer or a forensic tool.
4. **Commit `sample.xlsx` as a binary, or generate it via a script?** Generating needs a writer
   devDependency and produces a file that does not exercise Excel's own quirks. Leaning commit,
   plus real-Excel golden fixtures under `tests/fixtures/xlsx/`.
5. **`.xlsm`**: claim it (one line, byte-identical SpreadsheetML) but the macros are invisible in
   the preview. Silent render, or a one-line banner?

## Market context

The incumbent, `GrapeCity.gc-excelviewer`, has 6.7M installs and its marketplace page now says it
is no longer actively maintained. Its designated successor has captured a small fraction of that
base. Separately, nothing in the ecosystem lets you open a spreadsheet and copy a range as a
Markdown table, which is MarkCopy's whole premise.
