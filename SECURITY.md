# Security

## Threat model

MarkCopy renders untrusted Markdown (any file you open) into a webview and can render Mermaid diagrams from fenced code. The two areas that matter are script execution in the preview and diagram rendering.

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

## Mermaid

Mermaid is initialized with `securityLevel: 'strict'`, which sanitizes diagram-supplied HTML and blocks click bindings from diagram source. A diagram that fails to parse renders an inline error message rather than executing anything.

## HTML in Markdown

`markdown-it` is configured with `html: true`, so raw HTML in a document is passed through to the preview. The CSP prevents any inline script in that HTML from running, but be aware that raw HTML is rendered. If you open Markdown from an untrusted source, this is the surface to keep in mind. A future option may add an opt-in sanitizer for fully untrusted input.

## Clipboard

Copy actions only ever write to the clipboard, and only in response to a user action (a menu click or command). MarkCopy never reads the clipboard.

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than opening a public issue. Include the VS Code version, OS, a minimal reproducing `.md`, and the observed behavior. You will get an acknowledgement and a fix timeline.
