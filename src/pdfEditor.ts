import * as vscode from 'vscode';

// A read-only custom editor that renders PDF files with pdf.js in a webview,
// exposing MarkCopy's copy actions (page as PNG, page text, all text).
export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'markcopy.pdfPreview';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const asUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file));
    const scriptUri = asUri('pdf.js');
    const workerUri = asUri('pdf.worker.js');
    const styleUri = asUri('preview.css');
    const nonce = getNonce();
    const theme = vscode.workspace.getConfiguration('markcopy').get<string>('theme', 'auto');
    webview.html = this.html(webview, scriptUri, styleUri, nonce, theme);

    // Send the file bytes once the webview signals it is ready.
    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        webview.postMessage({ type: 'load', data: bytes, workerSrc: workerUri.toString() });
      }
    });
  }

  private html(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    styleUri: vscode.Uri,
    nonce: string,
    theme: string,
  ): string {
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>MarkCopy PDF Preview</title>
</head>
<body class="mc-pdf" data-mc-theme="${theme}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="pdf-root"></div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
