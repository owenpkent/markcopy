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

CI runs `lint`, `format:check`, type-check, build, and package on every push and PR. Run `npm run format` before committing so `format:check` stays green.

Optional local secret scanning (matches folio): `pip install pre-commit && pre-commit install` wires gitleaks and Action SHA-pinning into your git hooks (see `.pre-commit-config.yaml`).

## Debug

1. Run `npm run watch` (or `npm run compile` once).
2. Press **F5** in VS Code. This launches the Extension Development Host with MarkCopy loaded (the `.vscode/launch.json` config runs `npm: compile` first).
3. In the new window, open `sample.md` and run **MarkCopy: Open Rich Preview to the Side**.
4. Right-click around the preview to exercise the copy paths.

To debug the webview itself, open **Developer: Open Webview Developer Tools** from the Command Palette in the Extension Development Host.

## Project layout

| Path                           | What lives here                                                     |
| ------------------------------ | ------------------------------------------------------------------- |
| `src/extension.ts`             | Host: activation, commands, panel lifecycle, scroll sync.           |
| `src/render.ts`                | markdown-it setup and source-line mapping.                          |
| `src/webview/main.ts`          | Markdown webview: rendering, context menu, clipboard, PNG, Mermaid. |
| `src/pdfEditor.ts`             | Host: read-only custom editor for `.pdf` files.                     |
| `src/webview/pdf.ts`           | PDF webview: pdf.js rendering and page/text copy actions.           |
| `media/preview.css`            | Style profiles, PDF layout, menu, toast.                            |
| `docs/`                        | Architecture and copy-matrix reference.                             |
| `esbuild.js`, `esbuild.web.js` | The bundlers.                                                       |

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

```bash
npm run package     # production build (minified, no source maps)
npm run vsix        # @vscode/vsce package -> markcopy-<version>.vsix
```

To publish to the Marketplace (once a publisher and token exist):

```bash
npx vsce login <publisher-id>
npx vsce publish            # or: npx vsce publish minor
```

Bump the version in `package.json` and add a section to [CHANGELOG.md](CHANGELOG.md) before releasing.

## Filing issues

Include your VS Code version, OS, a minimal `.md` that reproduces the problem, and which copy action and paste target were involved (for example, "Copy Table as Rich Text, pasting into Outlook").
