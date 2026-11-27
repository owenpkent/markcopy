import * as vscode from 'vscode';
import { revealInOs, openInDefaultApp } from './revealInOs';
import { applyMarkcopySetting } from './settingsScope';
import { getNonce } from './previewShell';
import { openExternalLink } from './externalLink';
import { parsePdfMessage } from './messages/pdf';
import { MAX_PDF_BYTES, readDocument } from './documentFile';
import { MAX_COMMENTS_BYTES, parseComments, parseCommentsLenient } from './pdfComments';
import { missing, replaceSidecar } from './sidecarFile';

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
    const theme = vscode.workspace
      .getConfiguration('markcopy', document.uri)
      .get<string>('theme', 'auto');
    webview.html = this.html(webview, scriptUri, workerUri, styleUri, nonce, theme);

    // Comments persist to a sidecar JSON file next to the PDF, so the PDF itself
    // stays untouched (this is a read-only editor).
    const commentsUri = document.uri.with({ path: document.uri.path + '.mccomments.json' });
    let loading = false;

    webview.onDidReceiveMessage(async (raw) => {
      const msg = parsePdfMessage(raw);
      if (!msg) {
        return;
      }
      if (msg.type === 'ready') {
        if (loading) {
          return;
        }
        loading = true;
        try {
          const bytes = await readDocument(document.uri, MAX_PDF_BYTES);
          // Send as base64: webview.postMessage serialises a Uint8Array into a
          // plain {0:…,1:…} object (no length), which pdf.js rejects. A string
          // round-trips cleanly; the webview decodes it back to bytes.
          webview.postMessage({
            type: 'load',
            data: Buffer.from(bytes).toString('base64'),
            comments: await readComments(commentsUri),
          });
        } catch (err) {
          void webview.postMessage({ type: 'loadError', message: String(err) });
        } finally {
          loading = false;
        }
      } else if (msg.type === 'openExternal') {
        await openInDefaultApp(document.uri);
      } else if (msg.type === 'openLink') {
        // Validated by parsePdfMessage (http, https, mailto, length cap) and
        // checked again by openExternalLink before it reaches the OS.
        openExternalLink(msg.url);
      } else if (msg.type === 'revealInOS') {
        revealInOs(document.uri);
      } else if (msg.type === 'saveComments') {
        await writeComments(commentsUri, msg.comments);
      } else if (msg.type === 'saveCommentsRejected') {
        warnCommentsRejected();
      } else if (msg.type === 'updateSetting') {
        // Persist a setting changed from the PDF viewer's Theme menu, mirroring
        // the Markdown preview: write to the scope where the setting is defined
        // (folder/workspace override, else Global) so a workspace value isn't
        // shadowed by a Global write. The webview applied it optimistically, so
        // no reply is needed; the config listener below re-tints any other open
        // PDF viewers and an open Markdown preview picks it up via the
        // extension's onDidChangeConfiguration listener.
        await applyMarkcopySetting(msg.key, msg.value, document.uri);
      }
    });

    // Keep the pages in sync when markcopy.theme changes elsewhere (the Markdown
    // preview's Theme menu, or settings.json). Without this the tint only
    // updated when the PDF was reopened. The webview no-ops when the value it is
    // told to apply already matches, so echoing back our own change is harmless.
    const themeListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('markcopy.theme', document.uri)) {
        return;
      }
      const value = vscode.workspace
        .getConfiguration('markcopy', document.uri)
        .get<string>('theme', 'auto');
      void webview.postMessage({ type: 'setTheme', value });
    });
    panel.onDidDispose(() => themeListener.dispose());
  }

  private html(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    workerUri: vscode.Uri,
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
<body class="mc-pdf" data-mc-theme="${theme}" data-worker-src="${workerUri}" data-vscode-context='{"preventDefaultContextMenuItems":true}'>
  <div id="pdf-root"></div>
  <div id="mc-menu" class="mc-menu" role="menu" hidden></div>
  <div id="mc-toast" class="mc-toast" hidden></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Sidecars that exist but did not load completely. Saving would replace the file
// with what loaded and lose the rest, so writes to them are refused until the
// file loads cleanly again (or the editor host restarts).
const protectedSidecars = new Set<string>();

function protectSidecar(uri: vscode.Uri): void {
  if (protectedSidecars.has(uri.toString())) {
    return;
  }
  protectedSidecars.add(uri.toString());
  void vscode.window.showWarningMessage(
    'MarkCopy: the comments file for this document has entries MarkCopy cannot load. ' +
      'Comment saving is off for this document so nothing in that file is lost. ' +
      'Fix or remove the file to turn it back on.',
  );
}

/** Tell the user a comments save was refused by validation instead of dropping it. */
export function warnCommentsRejected(): void {
  void vscode.window.showWarningMessage(
    'MarkCopy: the comments could not be saved because they are over the size or count limits. ' +
      'Shorten or delete some notes.',
  );
}

// Read the sidecar comments file, returning [] when it is absent. A file that
// exists but is unreadable or only partly valid loads whatever is valid and
// protects the file from being overwritten (see protectSidecar).
// Exported so the LaTeX preview, which drives the same pdf.js webview, keeps its
// pins in one place rather than growing a second copy of this.
export async function readComments(uri: vscode.Uri): Promise<unknown[]> {
  const key = uri.toString();
  let bytes: Uint8Array;
  try {
    bytes = await readDocument(uri, MAX_COMMENTS_BYTES);
  } catch (err) {
    if (missing(err)) {
      protectedSidecars.delete(key);
    } else {
      protectSidecar(uri);
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    protectSidecar(uri);
    return [];
  }
  const { comments, complete } = parseCommentsLenient(parsed);
  if (complete) {
    protectedSidecars.delete(key);
  } else {
    protectSidecar(uri);
  }
  return comments;
}

// Write the sidecar comments file, or delete it when there are no comments left
// so we do not leave an empty artifact beside the PDF.
export async function writeComments(uri: vscode.Uri, comments: unknown): Promise<void> {
  if (protectedSidecars.has(uri.toString())) return;
  const valid = parseComments(comments);
  if (!valid) {
    warnCommentsRejected();
    return;
  }
  try {
    if (valid.length > 0) {
      const bytes = Buffer.from(JSON.stringify(valid, null, 2), 'utf8');
      if (bytes.length > MAX_COMMENTS_BYTES) {
        throw new Error('The comments file exceeds the 2 MB limit.');
      }
      await replaceSidecar(uri, bytes);
    } else {
      await replaceSidecar(uri);
    }
  } catch (err) {
    void vscode.window.showWarningMessage(`MarkCopy: could not save comments (${String(err)}).`);
  }
}
