# Changelog

All notable changes to MarkCopy are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **PDF preview**: MarkCopy now opens `.pdf` files in a built-in read-only viewer (pdf.js), with right-click **Copy Page as PNG**, **Copy Page Text**, **Copy All Text**, and **Copy Selected Text**. One extension previews both Markdown and PDF.
- **Copy Table as CSV** in the table right-click menu (RFC 4180 quoting), alongside the existing TSV option.
- Project tooling adopted from folio: ESLint 9 (flat config), Prettier, gitleaks/pinact pre-commit hooks, `.editorconfig`, and `npm run lint` / `format` scripts. CI now lints and checks formatting.

### Planned
- KaTeX / LaTeX math rendering, and copy-as-image for equations.
- PlantUML support.
- An email-safe export profile (table-based layout, fully inlined).
- Copy a selection spanning multiple blocks as clean Markdown.
- A marketplace icon.

## [0.0.1] - 2026-07-16

Initial release.

### Added
- Custom-webview Markdown preview, opened with **MarkCopy: Open Rich Preview to the Side** from the Command Palette, editor title bar, or the editor and Explorer right-click menus.
- Adaptive right-click context menu in the preview:
  - Selection: copy as rich text or as Markdown.
  - Code block: copy code as plain text.
  - Table: copy as rich text, as TSV, or as PNG.
  - Mermaid diagram: copy as PNG or as SVG.
  - Any block: copy as rich text, as Markdown source, or as PNG.
  - Whole document: copy as rich text (also available via **MarkCopy: Copy Whole Document as Rich Text**).
- Rich-text copy writes both `text/html` and `text/plain`, with styles inlined so formatting survives Gmail and Outlook.
- PNG copy of blocks, tables, and diagrams via html-to-image.
- Live preview that updates on edit, with editor and preview scroll sync.
- GitHub and VS Code style profiles (`markcopy.styleProfile`) and a scroll-sync toggle (`markcopy.syncScroll`).
- Mermaid diagrams and highlight.js syntax highlighting.

[Unreleased]: https://github.com/owenpkent/markcopy/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/owenpkent/markcopy/releases/tag/v0.0.1
