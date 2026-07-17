# Contributing

Thanks for helping improve MarkCopy. This guide covers the local setup, the build, debugging, and the release flow.

## Prerequisites

- Node.js 18 or newer.
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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why there are separate bundles.

## Lint and format

```bash
npm run lint          # eslint (flat config, typescript-eslint)
npm run lint:fix      # eslint --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check . (what CI runs)
```

CI runs two jobs on every push and PR: a build job (`lint`, `format:check`, type-check, unit tests, build, package) and an integration-test job (VS Code under xvfb). Run `npm run format` before committing so `format:check` stays green.

Optional local secret scanning (matches folio): `pip install pre-commit && pre-commit install` wires gitleaks and Action SHA-pinning into your git hooks (see `.pre-commit-config.yaml`).

`npm run screenshot` regenerates the README hero image (`docs/media/context-menu.png`) by rendering the real preview with `media/preview.css` in headless Chrome or Edge (see `scripts/make-screenshot.js`).

## Tests

### Unit tests (vitest)

```bash
npm test          # vitest run (what CI runs)
npm run test:watch
```

Unit tests live in `tests/` and run under vitest + jsdom. They cover the pure, host-independent logic: markdown-it rendering and source-line mapping (`src/render.ts`), CSV/TSV table serialization (`src/webview/table.ts`, RFC 4180), and HTML-to-Markdown conversion (`src/webview/markdownConvert.ts`).

### Integration tests (VS Code)

```bash
npm run test:integration   # downloads VS Code and runs the extension inside it
```

Integration tests live in `test-integration/` and run under Mocha inside a real VS Code instance (via `@vscode/test-electron`). They verify activation, command registration, configuration defaults, and that the preview panel opens. On Linux and CI they need a display: `xvfb-run -a npm run test:integration`. The downloaded VS Code and compiled test output go to `.vscode-test/` and `out/` (both gitignored). Webview-internal behavior (clipboard writes, the context menu) is still best exercised by hand in the Extension Development Host (F5).

## Debug

1. Run `npm run watch` (or `npm run compile` once).
2. Press **F5** in VS Code. This launches the Extension Development Host with MarkCopy loaded (the `.vscode/launch.json` config runs `npm: compile` first).
3. In the new window, open `sample.md` and run **MarkCopy: Open Rich Preview to the Side**.
4. Right-click around the preview to exercise the copy paths.

To debug the webview itself, open **Developer: Open Webview Developer Tools** from the Command Palette in the Extension Development Host.

## Project layout

| Path                             | What lives here                                                     |
| -------------------------------- | ------------------------------------------------------------------- |
| `src/extension.ts`               | Host: activation, commands, panel lifecycle, scroll sync.           |
| `src/render.ts`                  | markdown-it setup and source-line mapping.                          |
| `src/webview/main.ts`            | Markdown webview: rendering, context menu, clipboard, PNG, Mermaid. |
| `src/pdfEditor.ts`               | Host: read-only custom editor for `.pdf` files.                     |
| `src/webview/pdf.ts`             | PDF webview: pdf.js rendering and page/text copy actions.           |
| `src/webview/table.ts`           | CSV/TSV table serialization (pure, unit-tested).                    |
| `src/webview/markdownConvert.ts` | HTML-to-Markdown via Turndown (pure, unit-tested).                  |
| `tests/`                         | Vitest unit tests.                                                  |
| `test-integration/`              | VS Code integration tests (Mocha + @vscode/test-electron).          |
| `media/preview.css`              | Style profiles (light/dark palette), PDF layout, menu, toast.       |
| `scripts/make-screenshot.js`     | Regenerates the README screenshots (`npm run screenshot`).          |
| `docs/`                          | Architecture and copy-matrix reference.                             |
| `esbuild.js`, `esbuild.web.js`   | The bundlers.                                                       |

## Coding conventions

- TypeScript, strict mode. Keep `tsc --noEmit` green.
- Match the surrounding style: the existing files favor small focused functions and section banners.
- No em dashes in any text or comment; use commas, colons, or parentheses.
- Do not bundle `vscode` (it is external and provided at runtime).
- When adding a copy action, write both `text/html` and `text/plain` where formatting matters, and add a row to [docs/COPY-MATRIX.md](docs/COPY-MATRIX.md).

## Adding a context-menu action

1. Add a `MenuItem` in `buildMenu()` in `src/webview/main.ts`, gated on the element type you detect with `target.closest(...)`.
2. Implement the copy in a helper (`copyText`, `copyRichText`, `copyPng`, or a new one) and call `toast()` on success.
3. Document it in the [Copy Matrix](docs/COPY-MATRIX.md).

## Releasing

Full steps (publisher setup, both registries, verified-publisher badge) are in [RELEASING.md](RELEASING.md). In short:

```bash
npm version patch                # bump version + tag
npm run vsix                     # build + package -> markcopy-<version>.vsix
npm run publish:vsce             # VS Code Marketplace (needs vsce login okstudio)
npm run publish:ovsx             # Open VSX (needs an Open VSX token)
```

Move the `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under the new version before releasing. Regenerate the icon or screenshots with `npm run icon` / `npm run screenshot` if visuals changed.

## Filing issues

Include your VS Code version, OS, a minimal `.md` that reproduces the problem, and which copy action and paste target were involved (for example, "Copy Table as Rich Text, pasting into Outlook").
