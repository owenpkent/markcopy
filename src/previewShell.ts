// The HTML document served to every webview that hosts the shared preview bundle
// (media/webview.js).
//
// Extracted from extension.ts once a second surface, the XLSX custom editor,
// needed exactly the same page: the same stylesheet, the same CSP, and the same
// #content / #mc-menu / #mc-toast nodes the bundle expects to find. The alternative
// was a third hand-written shell, which is how src/webview/pdf.ts ended up
// re-implementing the copy menu.
//
// Only `webviewId` varies. VS Code reads it out of data-vscode-context to decide
// which `webview/context` menu contributions apply to a right-click.
import * as vscode from 'vscode';

export function htmlShell(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  webviewId = 'markcopy.preview',
): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.css'),
  );
  const katexStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'katex', 'katex.min.css'),
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    // Same-origin only: lets html-to-image fetch and embed KaTeX fonts when
    // copying an equation as an image (see .github/SECURITY.md).
    `connect-src ${webview.cspSource}`,
    // 'strict-dynamic' lets the nonce'd entry module import its code-split
    // sibling chunks (media/chunk-*.js) without each needing its own nonce. A
    // bare-nonce CSP (what src/pdfEditor.ts uses, because its bundle is not split)
    // would let the entry module load and then silently fail every chunk import.
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<link href="${katexStyleUri}" rel="stylesheet" />
<title>MarkCopy Preview</title>
</head>
<body data-vscode-context='{"webviewId":"${webviewId}","preventDefaultContextMenuItems":true}'>
  <div id="content" class="markdown-body"></div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
