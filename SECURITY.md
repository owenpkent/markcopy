# Security

## Threat model

MarkCopy renders untrusted content (any Markdown or PDF you open) into a webview. It can render Mermaid diagrams from fenced code and parses PDFs with pdf.js. The areas that matter are script execution in the preview, diagram rendering, and PDF parsing.

## Content Security Policy

The webview is served with a strict CSP and a fresh nonce per load:

```
default-src 'none';
img-src ${cspSource} https: data: blob:;
style-src ${cspSource} 'unsafe-inline';
font-src  ${cspSource} data:;
script-src 'nonce-${nonce}';
```

- Only the nonce-tagged bundle script can run. Inline scripts injected through Markdown `html: true` content cannot execute.
- `img-src` allows `https:`, `data:`, and `blob:` so remote images, embedded images, Mermaid SVGs, and html-to-image output display.
- All local assets (the script and stylesheet) are loaded through `webview.asWebviewUri`, and `localResourceRoots` is limited to the extension's `media` folder.

The PDF preview uses the same policy plus `worker-src ${cspSource} blob:` (for the pdf.js worker) and `connect-src ${cspSource} blob: data:`. It does not add `https:` to `img-src`, because a PDF is rendered to a canvas from bytes the extension supplies, not from remote resources.

## Mermaid

Mermaid is initialized with `securityLevel: 'strict'`, which sanitizes diagram-supplied HTML and blocks click bindings from diagram source. A diagram that fails to parse renders an inline error message rather than executing anything.

## PDF preview

PDFs open in a read-only custom editor. The extension host reads the file with `workspace.fs.readFile` and hands the bytes to the webview; pdf.js parses and rasterises them entirely locally, with no network fetch. pdf.js is a large parser and therefore the widest attack surface here, but it runs under the same strict CSP as the rest of the webview: with no `'unsafe-eval'`, pdf.js detects the restriction and disables its eval-based fast paths. Parsing and rasterising run off the main thread in a worker loaded from the bundled `media/pdf.worker.js`. The editor is read-only and never writes back to the PDF.

## HTML in Markdown

`markdown-it` is configured with `html: true`, so raw HTML in a document is passed through to the preview. The CSP prevents any inline script in that HTML from running, but be aware that raw HTML is rendered. If you open Markdown from an untrusted source, this is the surface to keep in mind. A future option may add an opt-in sanitizer for fully untrusted input.

## Clipboard

Copy actions only ever write to the clipboard, and only in response to a user action (a menu click or command). MarkCopy never reads the clipboard.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via the contact form at <https://www.owenpkent.com/> rather than opening a public issue. Include the VS Code version, OS, a minimal reproducing `.md` or `.pdf`, and the observed behavior. You will get an acknowledgement and a fix timeline.
