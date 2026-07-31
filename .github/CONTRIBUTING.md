# Contributing

Thanks for helping improve MarkCopy. This guide covers the local setup, the build, debugging, and the release flow.

## Prerequisites

- Node.js 20 or newer (matches the version CI builds and tests on).
- VS Code 1.90 or newer (matches `engines.vscode`).

## Setup

```bash
npm install
```

## Build

```bash
npm run compile     # type-check, then build all bundles
npm run watch       # rebuild the extension host and webviews on change
```

`compile` runs three steps:

1. `check-types` (`tsc --noEmit`) type-checks the whole tree without emitting.
2. `build:ext` (`esbuild.js`) bundles the Node extension to `dist/extension.js`.
3. `build:web` (`esbuild.web.js`) bundles the webview to `media/webview.js`, plus `media/pdf.js` and `media/pdf.worker.js` for the PDF preview.

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for why there are separate bundles.

## Lint and format

```bash
npm run lint          # eslint (flat config, typescript-eslint)
npm run lint:fix      # eslint --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check . (what CI runs)
```

CI runs two jobs on every push and PR: a build job (`lint`, `format:check`, type-check, unit tests, build, package) and an integration-test job (VS Code under xvfb). Run `npm run format` before committing so `format:check` stays green.

Optional local secret scanning (matches folio): `pip install pre-commit && pre-commit install` wires gitleaks and Action SHA-pinning into your git hooks (see `.pre-commit-config.yaml`).

`npm run screenshot` regenerates the README images into `docs/media/` (the context menu, the rendered Markdown/math/diagram shot, the green terminal palette, the CSV grid in light and dark, and the PDF viewer) by rendering the real preview bundles with `media/preview.css` in headless Chrome or Edge (see `scripts/make-screenshot.js`). Because it drives the real bundles, it doubles as a way to eyeball a layout change that unit tests cannot see.

## Tests

### Unit tests (vitest)

```bash
npm test          # vitest run (what CI runs)
npm run test:watch
```

Unit tests live in `tests/` and run under vitest + jsdom. They cover the pure, host-independent logic: markdown-it rendering and source-line mapping (`src/render.ts`), CSV/TSV parsing, delimiter sniffing, grid rendering and the field spans that drive cell editing (`src/csv.ts`), the grid's column resizing and cell editing (`src/webview/csvTable.ts`, `src/webview/csvEdit.ts`), clipboard table serialization (`src/webview/table.ts`, RFC 4180), HTML-to-Markdown conversion (`src/webview/markdownConvert.ts`), scroll-sync interpolation (`src/webview/scrollSync.ts`), and the PDF export's browser discovery, command line, and print stylesheet (`src/pdfExport.ts`).

Two kinds of logic are deliberately kept in files with no `vscode` import and no DOM dependency, so they can be tested like this: geometry and mapping arithmetic (`scrollSync.ts`), and anything describing a command line or generated document (`pdfExport.ts`). When you find yourself wanting to assert on a string the extension builds, that is the signal to move its construction into such a file.

jsdom has no layout engine, so anything size-dependent is stubbed (see `tests/csvTable.test.ts` for `getBoundingClientRect`). Tests can prove the _mechanism_ that keeps the grid's geometry correct but not the pixels; check those in the Extension Development Host.

### Integration tests (VS Code)

```bash
npm run test:integration   # downloads VS Code and runs the extension inside it
```

Integration tests live in `test-integration/` and run under Mocha inside a real VS Code instance (via `@vscode/test-electron`). They verify activation, command registration, configuration defaults, that the `csv` and `tsv` language ids the extension contributes are actually registered, and that the preview panel opens (for both Markdown and CSV). Spreadsheets are not covered there: they open through a custom editor rather than a text document, and the reader itself is exercised by `tests/xlsx/`. On Linux and CI they need a display: `xvfb-run -a npm run test:integration`. The downloaded VS Code and compiled test output go to `.vscode-test/` and `out/` (both gitignored). Webview-internal behavior (clipboard writes, the context menu) is still best exercised by hand in the Extension Development Host (F5).

### Manual testing

The manual test plan is [docs/TESTING.md](../docs/TESTING.md): checklists for the Markdown preview, the CSV/TSV grid, the PDF viewer, and the paste targets outside VS Code. It is the pre-release gate (see [RELEASING.md](../docs/RELEASING.md)), and the place to start when verifying a webview change by hand. Its fixtures are `sample.md` and `sample.csv` (both committed), plus `sample.pdf` from `node scripts/make-sample-pdf.js` (gitignored).

## Debug

1. Run `npm run watch` (or `npm run compile` once).
2. Press **F5** in VS Code. This launches the Extension Development Host with MarkCopy loaded (the `.vscode/launch.json` config runs `npm: compile` first, and opens this repo as the dev host's workspace so the fixtures are to hand).
3. In the new window, open `sample.md` or `sample.csv`; the preview opens beside it automatically, or run **MarkCopy: Open Rich Preview to the Side**.
4. Right-click around the preview to exercise the copy paths.

Changes to `package.json` contributions (languages, activation events, menus, settings) are only read when the dev host **process** starts, so close the window and press F5 again rather than reloading it.

To debug the webview itself, open **Developer: Open Webview Developer Tools** from the Command Palette in the Extension Development Host.

## Project layout

| Path                             | What lives here                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/extension.ts`               | Host: activation, commands, panel lifecycle, scroll sync, PDF export.                           |
| `src/render.ts`                  | markdown-it setup and source-line mapping.                                                      |
| `src/pdfExport.ts`               | Host: Save as PDF (browser discovery, `--print-to-pdf`, export page, print CSS).                |
| `src/webview/main.ts`            | Markdown webview: rendering, context-menu entry tree, clipboard, PNG, Mermaid.                  |
| `src/webview/menu.ts`            | Shared context-menu engine (`MenuEntry`, `MenuController`, `createMenu`) used by both webviews. |
| `src/webview/scrollSync.ts`      | Scroll-sync interpolation (pure, unit-tested).                                                  |
| `src/pdfEditor.ts`               | Host: read-only custom editor for `.pdf` files.                                                 |
| `src/webview/pdf.ts`             | PDF webview: pdf.js rendering, page/text copy actions, and its context-menu entry tree.         |
| `src/csv.ts`                     | Host: CSV/TSV parsing (RFC 4180), delimiter sniffing, grid HTML, and cell edits.                |
| `src/webview/csvTable.ts`        | CSV grid: drag-to-resize columns.                                                               |
| `src/webview/csvEdit.ts`         | CSV grid: cell selection, navigation, and inline editing.                                       |
| `src/webview/table.ts`           | CSV/TSV clipboard serialization and the Markdown-table reshaping (pure, unit-tested).           |
| `src/previewShell.ts`            | Host: the HTML shell served to every webview that hosts the shared preview bundle.              |
| `src/xlsxEditor.ts`              | Host: read-only custom editor for `.xlsx` / `.xlsm` files.                                      |
| `src/xlsx/`                      | Host: the OOXML reader (zip, XML, workbook, styles, sheet, grid HTML). Pure, unit-tested.       |
| `src/webview/markdownConvert.ts` | HTML-to-Markdown via Turndown (pure, unit-tested).                                              |
| `tests/`                         | Vitest unit tests.                                                                              |
| `test-integration/`              | VS Code integration tests (Mocha + @vscode/test-electron).                                      |
| `media/preview.css`              | Style profiles (light/dark palette), PDF layout, menu, toast.                                   |
| `scripts/make-screenshot.js`     | Regenerates the README screenshots (`npm run screenshot`).                                      |
| `scripts/make-sample-pdf.js`     | Generates `sample.pdf`, the manual-test fixture (docs/TESTING.md).                              |
| `docs/`                          | Architecture and copy-matrix reference.                                                         |
| `esbuild.js`, `esbuild.web.js`   | The bundlers.                                                                                   |

## Coding conventions

- TypeScript, strict mode. Keep `tsc --noEmit` green.
- Match the surrounding style: the existing files favor small focused functions and section banners.
- No em dashes in any text or comment; use commas, colons, or parentheses.
- Do not bundle `vscode` (it is external and provided at runtime).
- When adding a copy action, write both `text/html` and `text/plain` where formatting matters, and add a row to [docs/COPY-MATRIX.md](../docs/COPY-MATRIX.md).

## Adding a context-menu action

1. Add a `MenuEntry` (see `src/webview/menu.ts` for the kinds: `item`, `submenu`, `label`, `divider`, `radio`, `checkbox`) in `buildMenu()` in `src/webview/main.ts` (or the equivalent in `src/webview/pdf.ts`), gated on the element type you detect with `target.closest(...)`. A new format for an existing element usually just adds another `item` to its `Copy as` submenu rather than a new top-level row.
2. Implement the copy in a helper (`copyText`, `copyRichText`, `copyPng`, or a new one) and call `toast()` on success.
3. Document it in the [Copy Matrix](../docs/COPY-MATRIX.md).

## Releasing

Full steps (publisher setup, both registries, verified-publisher badge) are in [RELEASING.md](../docs/RELEASING.md). In short:

```bash
npm version patch                # bump version + tag
npm run vsix                     # build + package -> markcopy-<version>.vsix
npm run publish:vsce             # VS Code Marketplace (needs vsce login OwenPKent)
npm run publish:ovsx             # Open VSX (needs an Open VSX token)
```

Move the `[Unreleased]` entries in [CHANGELOG.md](../CHANGELOG.md) under the new version before releasing. Regenerate the icon or screenshots with `npm run icon` / `npm run screenshot` if visuals changed.

## Filing issues

Include your VS Code version, OS, a minimal `.md` that reproduces the problem, and which copy action and paste target were involved (for example, "Copy Table, pasting into Outlook").
