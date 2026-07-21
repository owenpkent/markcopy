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

    const nonce = getNonce();
    // Cache-bust the script/style so a rebuilt bundle always loads fresh: the
    // webview otherwise caches these by their (unchanged) resource URL.
    const asUri = (file: string, bust = false) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file));
      return bust ? uri.with({ query: `v=${nonce}` }) : uri;
    };
    const scriptUri = asUri('pdf.js', true);
    const workerUri = asUri('pdf.worker.js');
    const styleUri = asUri('preview.css', true);
    const theme = vscode.workspace.getConfiguration('markcopy').get<string>('theme', 'auto');
    webview.html = this.html(webview, scriptUri, styleUri, nonce, theme);

    // Comments persist to a sidecar JSON file next to the PDF, so the PDF itself
    // stays untouched (this is a read-only editor).
    const commentsUri = document.uri.with({ path: document.uri.path + '.mccomments.json' });

    webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        // Send as base64: webview.postMessage serialises a Uint8Array into a
        // plain {0:…,1:…} object (no length), which pdf.js rejects. A string
        // round-trips cleanly; the webview decodes it back to bytes.
        webview.postMessage({
          type: 'load',
          data: Buffer.from(bytes).toString('base64'),
          workerSrc: workerUri.toString(),
          comments: await readComments(commentsUri),
        });
      } else if (msg?.type === 'saveComments') {
        await writeComments(commentsUri, msg.comments);
      } else if (msg?.type === 'updateSetting' && typeof msg.key === 'string') {
        // Persist a setting changed from the PDF viewer's Theme menu, mirroring
        // the Markdown preview. Write to the scope where the setting is defined
        // (workspace/folder override, else Global) so a workspace value isn't
        // shadowed by a Global write. The webview applied it optimistically, so
        // no reply is needed; an open Markdown preview picks it up via the
        // extension's onDidChangeConfiguration listener.
        const config = vscode.workspace.getConfiguration('markcopy');
        const info = config.inspect(msg.key);
        const target =
          info?.workspaceFolderValue !== undefined
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : info?.workspaceValue !== undefined
              ? vscode.ConfigurationTarget.Workspace
              : vscode.ConfigurationTarget.Global;
        await config.update(msg.key, msg.value, target);
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
<html lang="en" class="mc-pdf-root">
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

// Read the sidecar comments file, returning [] when it is absent or unreadable.
async function readComments(uri: vscode.Uri): Promise<unknown[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Write the sidecar comments file, or delete it when there are no comments left
// so we do not leave an empty artifact beside the PDF.
async function writeComments(uri: vscode.Uri, comments: unknown): Promise<void> {
  try {
    if (Array.isArray(comments) && comments.length > 0) {
      const json = JSON.stringify(comments, null, 2);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
    } else {
      await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
    }
  } catch {
    /* best-effort persistence; a failed write should not crash the editor */
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
