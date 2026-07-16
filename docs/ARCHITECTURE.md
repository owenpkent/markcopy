# Architecture

MarkCopy is a custom-webview VS Code extension. Rendering happens in the Node extension host; all interaction (context menu, clipboard, Mermaid, PNG capture) happens in the webview. This split is deliberate: the webview is a browser context, and the clipboard operations we need (writing `text/html`, capturing PNGs) only exist there.

## Big picture

```
 ┌──────────────────────────┐        postMessage        ┌───────────────────────────┐
 │  Extension host (Node)    │  ───────────────────────► │  Webview (browser/iframe) │
 │  src/extension.ts         │   render / scrollToLine / │  src/webview/main.ts      │
 │  src/render.ts            │   copyAll                 │  media/preview.css        │
 │                           │  ◄─────────────────────── │                           │
 │  markdown-it, highlight.js│   revealLine / toast /    │  Mermaid, html-to-image,  │
 │  source-line mapping      │   ready                   │  context menu, clipboard  │
 └──────────────────────────┘                           └───────────────────────────┘
        dist/extension.js                                        media/webview.js
        (esbuild.js, node)                                   (esbuild.web.js, browser)
```

Two esbuild bundles are produced from one TypeScript source tree:

- `esbuild.js` bundles `src/extension.ts` to `dist/extension.js` for Node (`vscode` left external).
- `esbuild.web.js` bundles `src/webview/main.ts` to `media/webview.js` for the browser, pulling in Mermaid and html-to-image.

`tsc --noEmit` type-checks the whole tree; esbuild does the actual transpiling and bundling. `tsconfig.json` uses `module: ESNext` and `moduleResolution: Bundler` so the ESM-only dependencies (Mermaid, markdown-it-anchor) type-check cleanly.

## File map

| File                            | Role                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`              | Activation, command registration, webview panel lifecycle, editor-to-preview scroll sync, host side of the message protocol.                       |
| `src/render.ts`                 | The shared `markdown-it` instance: GFM options, highlight.js, anchors, Mermaid fence placeholders, and source-line mapping.                        |
| `src/webview/main.ts`           | Everything in the preview: rendering the HTML, Mermaid, the adaptive context menu, all clipboard writes, PNG capture, inline styling, scroll sync. |
| `src/pdfEditor.ts`              | The read-only custom editor for `.pdf`: builds the webview, reads file bytes, hands them to the PDF webview.                                       |
| `src/webview/pdf.ts`            | The PDF preview: pdf.js rendering to canvases, per-page text extraction, and the copy actions (page PNG, page text, all text).                     |
| `media/preview.css`             | GitHub and VS Code style profiles, PDF layout, context menu, toast, highlight.js token colors.                                                     |
| `esbuild.js` / `esbuild.web.js` | The bundlers. `esbuild.web.js` emits three files: `webview.js` (iife), `pdf.js` and `pdf.worker.js` (esm).                                         |

## Rendering pipeline

1. The user opens the preview. `openPreview` creates a `WebviewPanel` (beside the editor, `retainContextWhenHidden: true`) and sets its HTML shell.
2. `update()` reads the document text, calls `md.render(source)`, and posts a `render` message carrying the HTML, the raw source, and the active style profile.
3. In the webview, `render()` sets `#content.innerHTML`, splits the source into `sourceLines` (used later for "copy as Markdown"), then upgrades every Mermaid placeholder into an SVG.
4. On each edit, `onDidChangeTextDocument` re-runs `update()`, so the preview is live.

### Source-line mapping

`render.ts` tags top-level block tokens with `data-source-line` (the token's starting line). This attribute powers two features:

- **Scroll sync:** the webview reports the first fully-visible block's line; the host reveals that line in the editor, and vice versa. A `programmaticScroll` flag breaks the feedback loop.
- **Copy as Markdown:** for a clicked block, the webview finds its `data-source-line`, finds the next block's line, and slices `sourceLines` between them.

## Message protocol

Host to webview:

| Type           | Payload                          | Effect                                                  |
| -------------- | -------------------------------- | ------------------------------------------------------- |
| `render`       | `html`, `source`, `styleProfile` | Replace preview content and re-render Mermaid.          |
| `scrollToLine` | `line`                           | Scroll the preview to the element for that source line. |
| `copyAll`      | none                             | Copy the whole document as rich text.                   |

Webview to host:

| Type         | Payload | Effect                                     |
| ------------ | ------- | ------------------------------------------ |
| `revealLine` | `line`  | Reveal that line at the top of the editor. |
| `toast`      | `text`  | Show a status-bar message.                 |
| `ready`      | none    | Signals the webview script has loaded.     |

## Clipboard

This is the core of MarkCopy, and the reason for the host/webview split.

### Why writing happens in the webview

`vscode.env.clipboard.writeText` is text-only; there is no rich-HTML API on the extension host. Rich copy therefore has to run in the webview, which is a browser context with a full Clipboard API.

### Why the `copy`-event trick, not `navigator.clipboard.write`

The async Clipboard API (`navigator.clipboard.write` with a `ClipboardItem`) can be blocked inside the VS Code webview iframe by its Permissions-Policy on some versions and platforms. The reliable path is a synchronous `copy`-event handler plus `document.execCommand('copy')`:

```js
function writeClipboard(html, plain) {
  const onCopy = (e) => {
    if (html) e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', plain);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  if (!ok) navigator.clipboard?.writeText(plain); // last-ditch fallback
}
```

Every rich or text copy writes `text/plain` as well, so targets that cannot take HTML still receive content.

### Why styles are inlined

Gmail and Outlook strip `<style>` blocks and external CSS, honoring only inline `style` attributes. `inlineStyledHtml()` clones the target node, walks every element, and copies a whitelist of computed properties (font, color, background, borders, padding, margin, alignment, list style, white-space) onto inline styles. That is what makes a pasted table or heading keep its look in an email.

### PNG copy

`copyPng()` uses `html-to-image`'s `toBlob()` at 2x pixel ratio, then writes an `image/png` `ClipboardItem`. This is the one place the async Clipboard API is used, because image writes are not expressible through the `copy`-event path. If the environment blocks it, the user sees a toast rather than a silent failure.

## PDF preview

`.pdf` files are handled by `PdfEditorProvider`, a `CustomReadonlyEditorProvider` registered for the `markcopy.pdfPreview` view type (contributed with `priority: default`, since VS Code has no built-in PDF viewer). On open, the provider reads the file with `workspace.fs.readFile` and, once the webview posts `ready`, sends the bytes plus the worker URI in a `load` message. Nothing is fetched over the network.

In the webview, `src/webview/pdf.ts` points pdf.js at a module worker created from the bundled `media/pdf.worker.js` (via `GlobalWorkerOptions.workerPort`), renders each page to a canvas, and extracts per-page text with `getTextContent` for the copy actions. The PDF webview's CSP adds `worker-src ${cspSource} blob:` for the pdf.js worker.

## Content Security Policy

The webview HTML declares a strict CSP with a per-load nonce:

```
default-src 'none';
img-src ${cspSource} https: data: blob:;
style-src ${cspSource} 'unsafe-inline';
font-src  ${cspSource} data:;
script-src 'nonce-${nonce}';
```

Only the nonce-tagged bundle can execute. `blob:` and `data:` image sources are allowed so Mermaid SVGs and html-to-image output render. All local assets are referenced through `webview.asWebviewUri`.

See [SECURITY.md](../SECURITY.md) for the threat model.
