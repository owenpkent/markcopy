import * as vscode from 'vscode';
import { createMarkdownIt } from './render';
import { PdfEditorProvider } from './pdfEditor';

const VIEW_TYPE = 'markcopy.preview';

interface PreviewState {
  panel: vscode.WebviewPanel;
  docUri: vscode.Uri;
}

let current: PreviewState | undefined;
const md = createMarkdownIt();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // PDF files open in the MarkCopy PDF preview (a read-only custom editor).
    vscode.window.registerCustomEditorProvider(
      PdfEditorProvider.viewType,
      new PdfEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),

    vscode.commands.registerCommand('markcopy.openPreview', (uri?: vscode.Uri) => {
      const doc = pickDocument(uri);
      if (doc) {
        openPreview(context, doc);
      } else {
        vscode.window.showInformationMessage('MarkCopy: open a Markdown file first.');
      }
    }),

    vscode.commands.registerCommand('markcopy.copyDocumentAsRichText', () => {
      if (current) {
        current.panel.reveal(vscode.ViewColumn.Beside, true);
        current.panel.webview.postMessage({ type: 'copyAll' });
      } else {
        vscode.window.showInformationMessage(
          'MarkCopy: open the preview first (MarkCopy: Open Rich Preview).',
        );
      }
    }),

    // Live update the preview when the source document changes.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (current && e.document.uri.toString() === current.docUri.toString()) {
        update(current);
      }
    }),

    // Editor -> preview scroll sync.
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const cfg = vscode.workspace.getConfiguration('markcopy');
      if (!cfg.get<boolean>('syncScroll', true)) {
        return;
      }
      if (current && e.textEditor.document.uri.toString() === current.docUri.toString()) {
        const line = e.visibleRanges[0]?.start.line ?? 0;
        current.panel.webview.postMessage({ type: 'scrollToLine', line });
      }
    }),
  );
}

export function deactivate(): void {
  current?.panel.dispose();
}

function pickDocument(uri?: vscode.Uri): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor;
  if (uri && uri.scheme === 'file') {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  }
  if (active && active.document.languageId === 'markdown') {
    return active.document;
  }
  return active?.document;
}

function openPreview(context: vscode.ExtensionContext, doc: vscode.TextDocument): void {
  if (current) {
    current.docUri = doc.uri;
    current.panel.reveal(vscode.ViewColumn.Beside, true);
    update(current);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `Preview ${basename(doc.uri)}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    },
  );

  const state: PreviewState = { panel, docUri: doc.uri };
  current = state;

  panel.webview.html = htmlShell(context, panel.webview);

  panel.webview.onDidReceiveMessage(
    (msg) => {
      if (msg?.type === 'revealLine') {
        revealEditorLine(state.docUri, msg.line);
      } else if (msg?.type === 'toast') {
        vscode.window.setStatusBarMessage(`MarkCopy: ${msg.text}`, 2500);
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(
    () => {
      if (current === state) {
        current = undefined;
      }
    },
    undefined,
    context.subscriptions,
  );

  update(state);
}

function update(state: PreviewState): void {
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === state.docUri.toString(),
  );
  if (!doc) {
    return;
  }
  const source = doc.getText();
  const html = md.render(source);
  const cfg = vscode.workspace.getConfiguration('markcopy');
  state.panel.title = `Preview ${basename(state.docUri)}`;
  state.panel.webview.postMessage({
    type: 'render',
    html,
    source,
    styleProfile: cfg.get<string>('styleProfile', 'github'),
  });
}

function revealEditorLine(docUri: vscode.Uri, line: number): void {
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === docUri.toString(),
  );
  if (!editor) {
    return;
  }
  const range = new vscode.Range(line, 0, line, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
}

function htmlShell(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.css'),
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>MarkCopy Preview</title>
</head>
<body data-vscode-context='{"webviewId":"markcopy.preview","preventDefaultContextMenuItems":true}'>
  <div id="content" class="markdown-body"></div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function basename(uri: vscode.Uri): string {
  const p = uri.path;
  return p.substring(p.lastIndexOf('/') + 1);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
