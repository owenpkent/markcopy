# Security

## Threat model

MarkCopy renders untrusted content (any Markdown, CSV/TSV, or PDF you open) into a webview. It can render Mermaid diagrams from fenced code and parses PDFs with pdf.js. The areas that matter are script execution in the preview, diagram rendering, PDF parsing, writing an edited CSV cell back to the file, and running a browser to render a PDF export.

## Content Security Policy

The webview is served with a strict CSP and a fresh nonce per load:

```
default-src 'none';
img-src ${cspSource} https: data: blob:;
style-src ${cspSource} 'unsafe-inline';
font-src  ${cspSource} data:;
connect-src ${cspSource};
script-src 'nonce-${nonce}';
```

- Only the nonce-tagged bundle script can run. Inline scripts injected through Markdown `html: true` content cannot execute.
- `img-src` allows `https:`, `data:`, and `blob:` so remote images, embedded images, Mermaid SVGs, and html-to-image output display.
- `connect-src ${cspSource}` is scoped to the webview's own origin only. It exists so `html-to-image` can fetch and embed KaTeX's web fonts when rasterizing a math equation to PNG (**Copy Equation as PNG**); Mermaid never needed this directive because it renders with system fonts. Being same-origin, it cannot be used to reach any external host.
- All local assets (the script and stylesheet) are loaded through `webview.asWebviewUri`, and `localResourceRoots` is limited to the extension's `media` folder.

The PDF preview uses the same policy plus `worker-src ${cspSource} blob:` (for the pdf.js worker) and `connect-src ${cspSource} blob: data:`. It does not add `https:` to `img-src`, because a PDF is rendered to a canvas from bytes the extension supplies, not from remote resources.

## Mermaid

Mermaid is initialized with `securityLevel: 'strict'`, which sanitizes diagram-supplied HTML and blocks click bindings from diagram source. A diagram that fails to parse renders an inline error message rather than executing anything.

## PDF preview

PDFs open in a read-only custom editor. The extension host reads the file with `workspace.fs.readFile` and hands the bytes to the webview; pdf.js parses and rasterises them entirely locally, with no network fetch. pdf.js is a large parser and therefore the widest attack surface here, but it runs under the same strict CSP as the rest of the webview: with no `'unsafe-eval'`, pdf.js detects the restriction and disables its eval-based fast paths. Parsing and rasterising run off the main thread in a worker loaded from the bundled `media/pdf.worker.js`. The editor is read-only and never writes back to the PDF.

## PDF export

**Save as PDF** is the one place MarkCopy starts another program: it writes the export page to a temporary directory and runs an installed Chrome, Edge, or Chromium over it with `--headless --print-to-pdf` (see [PDF export](../docs/ARCHITECTURE.md#pdf-export) for the full command line).

- **The executable is not taken from the document.** It is either the `markcopy.pdf.browserPath` setting or one of a fixed list of known install paths for the platform, and it is spawned with an argument array, never through a shell, so nothing in a document can influence the command.
- **The page carries no scripts.** The exported body is the preview's own DOM, which has already been through DOMPurify, so a `<script>` in the source Markdown is long gone before the export sees it. The one exception is the fallback route (no browser installed), whose page carries a `window.print()` MarkCopy wrote itself.
- **The browser runs on a throwaway profile** (`--user-data-dir` in a fresh `mkdtemp` directory, plus `--disable-extensions` and `--disable-sync`), so the render touches none of your browsing profile, cookies, or extensions. The directory, page included, is deleted however the render ends.
- **Remote images in a document are still fetched**, by the headless browser this time rather than the preview, because the export keeps `https:` image sources as they are. This is the same network access the preview already had, but it is worth knowing it happens outside the webview too.
- **One file is written, where you chose it.** The destination comes from a save dialog; the export never picks a path on your behalf.

## HTML in Markdown

`markdown-it` is configured with `html: true`, so raw HTML in a document is passed through to the preview. The CSP prevents any inline script in that HTML from running, but be aware that raw HTML is rendered. If you open Markdown from an untrusted source, this is the surface to keep in mind. A future option may add an opt-in sanitizer for fully untrusted input.

## CSV grid and cell editing

A CSV or TSV file is parsed in the extension host and emitted as an HTML table. Every cell value is HTML-escaped on the way out, and the result still passes through the same DOMPurify sanitize step and CSP as Markdown, so a cell containing `<img src=x onerror=...>` renders as that literal text.

Cell editing is the one place MarkCopy writes to a file rather than only reading one, so it is deliberately narrow:

- An edit only ever happens in response to a user action in the grid, and only against the document currently being previewed. The webview cannot name a different file: it sends a line, a column, and a value, and the host resolves those against the previewed document's URI.
- The host re-parses the document itself to locate the field, rather than trusting offsets from the webview, and rejects the message outright if the field, the line, or the value is not the expected shape.
- Edits are applied as a `WorkspaceEdit`, so they are ordinary undoable editor changes and respect read-only files rather than writing to disk directly.
- The render carries a document version that the grid echoes back; a mismatch drops the edit instead of applying it against stale line numbers.
- Only the edited field's own source span is replaced, so an edit cannot rewrite or reformat any other part of the file.

## Clipboard

Copy actions only ever write to the clipboard, and only in response to a user action (a menu click or command). MarkCopy never reads the clipboard.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via the contact form at <https://www.owenpkent.com/> rather than opening a public issue. Include the VS Code version, OS, a minimal reproducing `.md` or `.pdf`, and the observed behavior. You will get an acknowledgement and a fix timeline.
